const { Op } = require('sequelize');
const { Invoice, Sale } = require('../models');
const sequelize = require('../config/database');

/*
 * Numeración de comprobantes: YYYY-MM-XXXXXX, correlativo por negocio y mes.
 *
 * El siguiente número sale del MÁXIMO ya emitido en el mes, no del último
 * registro por id. La diferencia parece cosmética y no lo es: convertir una
 * cotización en venta reescribe el `numero` de la fila que ya existía, así que
 * un número recién emitido puede vivir sobre un id viejo. Leyendo por id se
 * saltea justamente esa fila, se devuelve un número que ya está usado, y el
 * índice único rebota la venta. Y como el cálculo es determinista, rebota
 * TODAS las ventas siguientes: la caja queda trabada hasta que alguien mire la
 * base. Es el bug que sacó de servicio el punto de venta.
 *
 * El máximo es correcto sin importar en qué orden se hayan escrito las filas,
 * que es la única propiedad de la que depende esto.
 *
 * (El correlativo va con padding fijo a 6 dígitos, así que el orden alfabético
 * coincide con el numérico. Rompería recién en el número 1.000.000 del mes.)
 */

const mesActual = () => {
  const hoy = new Date();
  return `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-`;
};

/*
 * El correlativo más alto emitido bajo ese prefijo.
 *
 * Se filtra sólo por prefijo, sin mirar `tipo`: el índice único es
 * (businessId, numero) y no sabe de tipos, así que el generador tiene que
 * mirar exactamente lo mismo que el índice protege. Los prefijos ya separan
 * las ventas (V-) de las cotizaciones (COT-).
 */
async function ultimoCorrelativo(Modelo, businessId, prefijo, transaction = null, columnas = ['numero']) {
  let mayor = 0;
  /*
   * Se mira una columna por vez y se toma el mayor, en vez de un GREATEST en
   * SQL: SQL Server no lo tiene hasta 2022 y esto corre en los dos motores.
   * Son dos agregados sobre el mismo índice, no una lectura de tabla.
   */
  for (const col of columnas) {
    const max = await Modelo.max(col, {
      where: { businessId, [col]: { [Op.like]: `${prefijo}%` } },
      transaction,
    });
    if (!max) continue;
    const n = parseInt(String(max).split('-').pop(), 10);
    if (Number.isFinite(n) && n > mayor) mayor = n;
  }
  return mayor;
}

const armar = (prefijo, seq) => `${prefijo}${String(seq).padStart(6, '0')}`;

/**
 * @param {number} saltar  cuántos números correr hacia adelante. Lo usa el
 *   reintento cuando el número calculado ya se lo ganó otra caja.
 */
async function nextInvoiceNumber(businessId, saltar = 0) {
  const prefijo = mesActual();
  const ultimo = await ultimoCorrelativo(Invoice, businessId, prefijo);
  return armar(prefijo, ultimo + 1 + saltar);
}

/*
 * El próximo número de venta mira DOS columnas: las ventas emitidas
 * (`numero`) y los números que las cotizaciones tienen reservados
 * (`numeroVenta`).
 *
 * Sin la segunda, una venta nueva tomaría el número que una cotización ya
 * tiene apartado, y al convertirla esa cotización chocaría contra el índice
 * único sin forma de destrabarse. Que es exactamente el problema que la
 * reserva viene a evitar.
 *
 * Para las cotizaciones alcanza con `numero`: su serie es la COT-, y ninguna
 * reserva empieza con ese prefijo.
 */
async function nextSaleNumber(businessId, tipo, saltar = 0, transaction = null) {
  const esCotizacion = tipo === 'cotizacion';
  const prefijo = (esCotizacion ? 'COT-' : 'V-') + mesActual();
  const columnas = esCotizacion ? ['numero'] : ['numero', 'numeroVenta'];
  const ultimo = await ultimoCorrelativo(Sale, businessId, prefijo, transaction, columnas);
  return armar(prefijo, ultimo + 1 + saltar);
}

/*
 * Crea un registro numerado, reintentando si el número se lo ganó otro.
 *
 * Leer el máximo y sumar uno no es atómico: dos cajas cobrando en el mismo
 * instante leen lo mismo y calculan lo mismo, y la segunda muere contra el
 * índice único con un error de base en crudo que el cajero no puede
 * interpretar y que le hace perder la venta.
 *
 * Serializar con un candado sería más elegante, pero no hay fila que trabar
 * cuando es la primera venta del mes, y cada motor lo escribe distinto. El
 * reintento cubre el caso real —dos o tres cajas, no doscientas— y deja el
 * índice único como la garantía de que no hay dos comprobantes con el mismo
 * número.
 *
 * @param {Function} generarNumero  async (saltar) => string
 * @param {Function} crear          async (numero, transaction) => registro
 */
async function crearConNumero(generarNumero, crear, { transaction = null, intentos = 5 } = {}) {
  const esChoque = (e) => e?.name === 'SequelizeUniqueConstraintError'
    || /must be unique|duplicate key|UNIQUE KEY/i.test(e?.parent?.message || e?.message || '');

  /*
   * Los números ya probados en esta llamada.
   *
   * El reintento vuelve a leer el máximo, que normalmente ya incluye la fila
   * del que ganó y devuelve el siguiente sin dejar huecos. Pero si por lo que
   * sea devuelve otra vez el mismo número —una réplica atrasada, una lectura
   * que no ve el commit— reintentar sería pegarle a la misma pared cinco
   * veces. Ahí se corre uno hacia adelante, que es lo único que garantiza
   * avanzar.
   */
  const probados = new Set();
  let saltar = 0;
  let ultimoError;

  for (let i = 0; i < intentos; i++) {
    let numero = await generarNumero(saltar);
    while (probados.has(numero) && saltar < intentos * 2) {
      saltar += 1;
      numero = await generarNumero(saltar);
    }
    probados.add(numero);

    try {
      if (!transaction) return await crear(numero, null);

      /*
       * Cada intento va dentro de un SAVEPOINT.
       *
       * En Postgres —que es producción— cualquier error deja la transacción
       * abortada: el reintento fallaría con "current transaction is aborted"
       * y encima se llevaría puesta la venta entera. Un savepoint acota el
       * daño: se deshace sólo el INSERT que chocó y la transacción sigue viva
       * para el intento siguiente.
       */
      const sp = await sequelize.transaction({ transaction });
      try {
        const creado = await crear(numero, sp);
        await sp.commit();
        return creado;
      } catch (e) {
        await sp.rollback().catch(() => {});
        throw e;
      }
    } catch (e) {
      if (!esChoque(e)) throw e;
      ultimoError = e;
      // Una espera mínima y creciente: sin esto los reintentos vuelven a
      // chocar entre ellos en el mismo milisegundo.
      await new Promise((r) => setTimeout(r, 15 * (i + 1)));
    }
  }
  /*
   * Agotados los intentos, el cajero no puede ver "uq_sales_biz_numero must be
   * unique". Ese texto es el nombre de un índice: no le dice qué hacer, no le
   * dice si la venta se guardó, y lo único que puede hacer con él es sacarle
   * una foto. Se cambia por una instrucción, y el error original queda en
   * `cause` para el log.
   */
  const error = new Error(
    'No se pudo asignar número al comprobante: hay otra caja emitiendo en este momento. '
    + 'Volvé a intentar. La venta no se guardó.',
  );
  error.status = 409;
  error.codigo = 'NUMERO_OCUPADO';
  error.cause = ultimoError;
  throw error;
}

/*
 * `ultimoCorrelativo` se exporta para los comprobantes internos —ingresos de
 * depósito, pedidos de reposición—, que arman el número con su propio formato
 * pero necesitan la misma lectura: el máximo emitido, no la última fila.
 */
module.exports = { nextInvoiceNumber, nextSaleNumber, crearConNumero, ultimoCorrelativo };
