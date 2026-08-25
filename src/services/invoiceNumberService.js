const { Op } = require('sequelize');
const { Invoice, Sale } = require('../models');
const sequelize = require('../config/database');

// Formato: YYYY-MM-XXXXXX (ej: 2026-07-000001)
// El correlativo reinicia cada mes por businessId.
async function nextInvoiceNumber(businessId) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `${yyyy}-${mm}-`;

  const last = await Invoice.findOne({
    where: {
      businessId,
      numero: { [Op.like]: `${prefix}%` },
    },
    order: [['id', 'DESC']],
  });

  let seq = 1;
  if (last) {
    const lastSeq = parseInt(last.numero.split('-')[2], 10);
    seq = lastSeq + 1;
  }

  return `${prefix}${String(seq).padStart(6, '0')}`;
}

// Mismo formato para ventas/cotizaciones
async function nextSaleNumber(businessId, tipo) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = tipo === 'cotizacion' ? `COT-${yyyy}-${mm}-` : `V-${yyyy}-${mm}-`;

  const last = await Sale.findOne({
    where: {
      businessId,
      tipo,
      numero: { [Op.like]: `${prefix}%` },
    },
    order: [['id', 'DESC']],
  });

  let seq = 1;
  if (last) {
    const parts = last.numero.split('-');
    seq = parseInt(parts[parts.length - 1], 10) + 1;
  }

  return `${prefix}${String(seq).padStart(6, '0')}`;
}

module.exports = { nextInvoiceNumber, nextSaleNumber };

/*
 * Crea un registro numerado, reintentando si el número se lo ganó otro.
 *
 * `nextSaleNumber` lee el último y suma uno, sin candado. Dos cajas cobrando al
 * mismo tiempo leen el mismo último, calculan el mismo siguiente, y la segunda
 * inserción muere contra el índice único con un error de base en crudo
 * ("uq_sales_biz_numero must be unique") que el cajero no puede interpretar y
 * que le hace perder la venta.
 *
 * Serializar con un candado sería más elegante, pero no hay fila que trabar
 * cuando es la primera venta del mes, y cada motor lo escribe distinto. El
 * reintento cubre el caso real —dos o tres cajas, no doscientas— y deja el
 * índice único como la garantía de que no hay dos comprobantes con el mismo
 * número.
 *
 * @param {Function} generarNumero  async () => string
 * @param {Function} crear          async (numero) => registro
 */
async function crearConNumero(generarNumero, crear, { transaction = null, intentos = 5 } = {}) {
  const esChoque = (e) => e?.name === 'SequelizeUniqueConstraintError'
    || /must be unique|duplicate key|UNIQUE KEY/i.test(e?.parent?.message || e?.message || '');

  let ultimoError;
  for (let i = 0; i < intentos; i++) {
    const numero = await generarNumero();
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
  throw ultimoError;
}

module.exports.crearConNumero = crearConNumero;
