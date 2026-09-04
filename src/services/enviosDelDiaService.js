/*
 * La jornada del depósito: qué sale hoy y qué hay que ir a buscar.
 *
 * Un pedido online entra por la cola y APARTA la mercadería (ver
 * colaVentasOnlineService y el bloque de reservas de stockService). La prenda
 * sigue en el estante, comprometida, hasta que alguien la pickea y la despacha.
 * Este servicio es esa segunda mitad: convierte la reserva en salida.
 *
 * ── Por qué una consolidación y no una lista de pedidos ───────────
 *
 * Quien arma los paquetes no camina el depósito una vez por pedido. Con veinte
 * pedidos que comparten la misma remera negra talle M, recorrer el pasillo
 * veinte veces es la diferencia entre despachar a las 14 y despachar a las 18 —
 * y con Flex, que tiene corte horario, esa diferencia se paga en reputación.
 *
 * Por eso salen dos vistas de los mismos datos:
 *
 *   · El CONSOLIDADO: cuántas unidades de cada SKU hay que bajar del estante,
 *     ordenado por local, para hacer un solo recorrido.
 *   · Los PAQUETES: qué lleva cada pedido, para armarlos con lo que se bajó.
 *
 * ── Qué NO hace ──────────────────────────────────────────────────
 *
 * No cancela nada en la plataforma. Cuando el pickeador no encuentra una
 * prenda, el pedido queda marcado y el stock no se toca: el egreso nunca
 * ocurrió, así que el estante sigue diciendo la verdad y la diferencia se
 * resuelve con un recuento. Cancelar una venta tiene costo de reputación y lo
 * decide una persona, no un sistema.
 */

const { Op } = require('sequelize');
const db = require('../config/database');
const {
  PedidoPlataforma, PedidoPlataformaItem, ProductVariant, Product, BusinessLocation,
} = require('../models');
const stockService = require('./stockService');
const packService = require('./packService');
const { log } = require('../utils/logger');

const error = (mensaje, status = 400, extra = {}) =>
  Object.assign(new Error(mensaje), { status, ...extra });

/*
 * Los estados del paquete dentro de la jornada.
 *
 * `pendiente` es el implícito: un pedido aceptado que todavía no se despachó.
 * Se guarda en null y se interpreta acá, para no tener que escribirle un estado
 * a cada pedido que entra sólo para decir que no pasó nada todavía.
 */
const ESTADOS = ['pendiente', 'despachado', 'con_faltante'];

/*
 * Qué pedidos entran en la jornada.
 *
 * Los aceptados y los parciales: un parcial tiene líneas que sí se apartaron y
 * hay que despachar igual — dejarlo afuera sería no mandar lo que sí está.
 * Los rechazados no, porque no apartaron nada.
 */
const DESPACHABLES = ['aceptado', 'parcial'];

/** El día en horario local, de 00:00 a 23:59:59.999. */
function limitesDelDia(fecha) {
  const base = fecha ? new Date(fecha) : new Date();
  if (Number.isNaN(base.getTime())) throw error('La fecha no es válida.', 400);
  const desde = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0, 0);
  const hasta = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 23, 59, 59, 999);
  return { desde, hasta };
}

/*
 * ── Los estados que se ven, y de dónde salen ──────────────────────
 *
 * Son dos preguntas distintas y hacen falta las dos:
 *
 *   · `estadoEnvio` es lo que hizo el DEPÓSITO: si el paquete se armó y salió.
 *     Lo escribimos nosotros y es lo único que mueve stock.
 *   · `estadoEnvioMl` es lo que pasó DESPUÉS: si el transportista lo levantó,
 *     si llegó, si el comprador lo canceló. Lo informa Mercado Libre.
 *
 * Con uno solo no se puede contestar "¿qué me falta despachar?" y "¿qué está en
 * camino?" al mismo tiempo, que son las dos preguntas de la jornada.
 *
 * Los filtros de esta lista mezclan los dos a propósito, porque quien mira la
 * pantalla no piensa en dos campos: piensa en "para enviar", "en camino",
 * "entregado", "cancelado".
 */
const FILTROS = {
  // Lo que todavía hay que armar y sacar. Es la vista por defecto.
  para_enviar: (p) => p.estadoEnvio !== 'despachado' && !esCancelado(p) && p.estadoEnvio !== 'con_faltante',
  // Salió de acá y todavía no llegó.
  en_camino:   (p) => p.estadoEnvio === 'despachado' && !esEntregado(p) && !esCancelado(p),
  entregado:   (p) => esEntregado(p),
  cancelado:   (p) => esCancelado(p),
  // Lo que el depósito no encontró: no mueve stock y hay que resolverlo.
  con_faltante: (p) => p.estadoEnvio === 'con_faltante',
  todos: () => true,
};

/*
 * Los estados de ML se agrupan en los tres que le importan a quien mira.
 *
 * ML tiene una decena —`pending`, `handling`, `ready_to_ship`, `shipped`,
 * `delivered`, `not_delivered`, `cancelled`…— y mostrarlos crudos obliga a
 * traducir mentalmente cada vez. Acá se contesta lo único que se pregunta:
 * ¿llegó?, ¿se canceló?
 */
const esEntregado = (p) => p.estadoEnvioMl === 'delivered';
const esCancelado = (p) => ['cancelled', 'not_delivered'].includes(p.estadoEnvioMl);

/** Cuántos días hacia adelante mira la vista. 0 = sólo hoy. */
function limitesDelRango(fecha, diasAdelante) {
  const { desde } = limitesDelDia(fecha);
  const dias = Math.max(0, Math.min(Number(diasAdelante) || 0, 30));
  const hasta = new Date(desde);
  hasta.setDate(hasta.getDate() + dias);
  hasta.setHours(23, 59, 59, 999);
  return { desde, hasta, dias };
}

/**
 * Los envíos de la jornada, con su consolidado de picking.
 *
 * @param {number} businessId
 * @param {object} opts
 * @param {string} [opts.fecha]       qué día. Por defecto hoy.
 * @param {number} [opts.locationId]  sólo lo que sale de este local.
 * @param {string} [opts.envioTipo]   'flex' para ver sólo los que tienen reloj.
 * @param {boolean} [opts.incluirDespachados] para ver la jornada completa al cierre.
 */
async function delDia(businessId, {
  fecha = null, locationId = null, envioTipo = null,
  incluirDespachados = false, diasAdelante = 0, filtro = null,
} = {}) {
  const { desde, hasta, dias } = limitesDelRango(fecha, diasAdelante);

  /*
   * El corte es por `despacharAntesDe` cuando la plataforma lo dijo, y por
   * cuándo llegó el pedido cuando no.
   *
   * Sin ese respaldo, un pedido de una plataforma que no manda fecha límite no
   * aparecería en ninguna jornada y se quedaría sin despachar sin que nadie lo
   * note. Es preferible que aparezca el día que entró: como mucho se adelanta
   * un día, y eso se ve.
   */
  const delDiaOEntradoHoy = {
    [Op.or]: [
      { despacharAntesDe: { [Op.between]: [desde, hasta] } },
      {
        [Op.and]: [
          { despacharAntesDe: null },
          { recibidoEn: { [Op.between]: [desde, hasta] } },
        ],
      },
    ],
  };

  const where = {
    businessId,
    estado: { [Op.in]: DESPACHABLES },
    [Op.and]: [delDiaOEntradoHoy],
  };
  if (envioTipo) where.envioTipo = String(envioTipo);

  /*
   * El filtro por estado se aplica en memoria y no en el `where`.
   *
   * Mezcla dos campos —el nuestro y el de ML— con reglas que no son un simple
   * igual: "en camino" es despachado por nosotros Y todavía no entregado por
   * ML. Escribirlo en SQL serían condiciones anidadas repetidas en cada
   * consulta, y el conjunto ya viene acotado a un rango de días y a un negocio:
   * son decenas de filas, no miles.
   *
   * `incluirDespachados` se mantiene por compatibilidad: es el mismo pedido que
   * `filtro: 'todos'` y así una pantalla vieja sigue andando.
   */
  const cual = filtro && FILTROS[filtro] ? filtro : (incluirDespachados ? 'todos' : 'para_enviar');

  const pedidos = await PedidoPlataforma.findAll({
    where,
    /*
     * Primero lo que vence antes, no lo que llegó antes.
     *
     * Con Flex el orden de llegada no sirve: un pedido de las 9 con corte a las
     * 18 puede esperar, y uno de las 11 con corte a las 13 no. Ordenar por
     * llegada hace que el que apura quede sepultado en el medio de la lista.
     */
    order: [['despacharAntesDe', 'ASC'], ['recibidoEn', 'ASC']],
    limit: 500,
  });

  if (!pedidos.length) {
    return { fecha: desde, hasta, dias, filtro: cual, pedidos: [], paquetes: [], consolidado: [], resumen: vacio() };
  }

  /*
   * Los ítems, las variantes y los locales en tres consultas, no en tres por
   * pedido. Con ochenta paquetes eso son doscientas cuarenta idas a la base
   * para dibujar una pantalla que se mira cada diez minutos.
   */
  const items = await PedidoPlataformaItem.findAll({
    where: { pedidoId: pedidos.map((p) => p.id) },
    order: [['id', 'ASC']],
  });

  const idsVariante = [...new Set(items.map((i) => i.productVariantId).filter(Boolean))];
  const variantes = idsVariante.length
    ? await ProductVariant.findAll({
      where: { id: idsVariante },
      attributes: ['id', 'sku', 'codigoBarras', 'esPack', 'variante1Nombre', 'variante1Valor',
        'variante2Nombre', 'variante2Valor'],
      include: [{
        model: Product, as: 'producto',
        attributes: ['id', 'titulo', 'skuAgrupador', 'modelo'],
      }],
    })
    : [];
  const porVariante = new Map(variantes.map((v) => [v.id, v]));

  /*
   * ── Un pack se pide como uno y se busca como tres ───────────────
   *
   * El comprador pidió "1 pack de 3 remeras". Quien va al estante no busca un
   * pack: busca tres remeras negras talle M. Mostrar la línea del pack y nada
   * más deja al pickeador dando vueltas por un artículo que no existe en
   * ninguna percha.
   *
   * Por eso cada línea de pack viene con lo que lleva adentro, y las cantidades
   * ya multiplicadas: 2 packs de 3 remeras son 6 remeras, no "2 × 3".
   *
   * Las dos consultas se hacen para todos los packs de la jornada a la vez.
   */
  const idsPacks = variantes.filter((v) => v.esPack).map((v) => v.id);
  const composiciones = idsPacks.length ? await packService.componentesDe(idsPacks) : new Map();
  const idsComponentes = [...new Set([...composiciones.values()].flat()
    .map((c) => c.componenteVariantId))];
  const variantesComponente = idsComponentes.length
    ? await ProductVariant.findAll({
      where: { id: idsComponentes },
      attributes: ['id', 'sku', 'codigoBarras', 'variante1Nombre', 'variante1Valor',
        'variante2Nombre', 'variante2Valor'],
      include: [{ model: Product, as: 'producto', attributes: ['titulo', 'modelo'] }],
    })
    : [];
  const porComponente = new Map(variantesComponente.map((v) => [v.id, v]));

  const idsLocal = [...new Set(items.map((i) => i.locationId).filter(Boolean))];
  const locales = idsLocal.length
    ? await BusinessLocation.findAll({ where: { id: idsLocal }, attributes: ['id', 'nombre'] })
    : [];
  const nombreLocal = new Map(locales.map((l) => [l.id, l.nombre]));

  const itemsPorPedido = new Map();
  for (const i of items) {
    if (!itemsPorPedido.has(i.pedidoId)) itemsPorPedido.set(i.pedidoId, []);
    itemsPorPedido.get(i.pedidoId).push(i);
  }

  const describir = (v) => [v?.variante1Valor, v?.variante2Valor].filter(Boolean).join(' · ');

  /*
   * Los atributos con su nombre: "Color: Negro · Talle: M".
   *
   * Sólo los valores —"Negro · M"— alcanzan cuando quien arma conoce el
   * producto de memoria, y no alcanzan cuando no. "38" puede ser un talle o un
   * color de una carta de colores numerada, y con dos ejes iguales —"S / M"
   * sobre un producto de Talle y Largo— no hay forma de saber cuál es cuál.
   * Quien está en el depósito con la caja abierta necesita las dos cosas.
   */
  const atributos = (v) => ({
    variante1Nombre: v?.variante1Nombre || null,
    variante1Valor: v?.variante1Valor || null,
    variante2Nombre: v?.variante2Nombre || null,
    variante2Valor: v?.variante2Valor || null,
  });

  /*
   * Filtrar por local se hace acá y no en el `where` de arriba: el local vive
   * en el ítem, no en el pedido, y un pedido puede salir de dos locales. Se
   * muestra el pedido entero y se marca qué línea sale de dónde — mandar medio
   * paquete porque la otra mitad está en la otra sucursal es peor que verlo.
   */
  /*
   * Se cuentan TODOS antes de filtrar.
   *
   * Las pestañas tienen que decir cuántos hay en cada estado aunque se esté
   * mirando otro: una pestaña "Cancelados" sin número al lado obliga a entrar
   * para descubrir que está vacía.
   */
  const porEstado = { para_enviar: 0, en_camino: 0, entregado: 0, cancelado: 0, con_faltante: 0, todos: 0 };
  for (const p of pedidos) {
    porEstado.todos += 1;
    for (const clave of ['para_enviar', 'en_camino', 'entregado', 'cancelado', 'con_faltante']) {
      if (FILTROS[clave](p)) porEstado[clave] += 1;
    }
  }

  const armados = [];
  for (const p of pedidos) {
    if (!FILTROS[cual](p)) continue;
    const suyos = itemsPorPedido.get(p.id) || [];
    if (locationId && !suyos.some((i) => i.locationId === Number(locationId))) continue;

    armados.push({
      /*
       * La clave con la que se agrupa: el número de ENVÍO.
       *
       * Mercado Libre junta varias ventas del mismo comprador en un solo
       * paquete. Agrupando por venta, el depósito prepararía tres bultos donde
       * en realidad va uno: tres etiquetas, tres cajas y un comprador que
       * recibe su compra partida en pedazos.
       *
       * Sin número de envío —una plataforma que no lo manda, o una venta cuyo
       * envío todavía no llegó— cada venta es su propio paquete. Es lo correcto
       * mientras no se sepa lo contrario, y se corrige solo cuando llega la
       * notificación del envío.
       */
      claveEnvio: p.envioId ? `envio:${p.envioId}` : `pedido:${p.id}`,
      id: p.id,
      plataforma: p.plataforma,
      pedidoExterno: p.pedidoExterno,
      envioId: p.envioId,
      envioTipo: p.envioTipo,
      despacharAntesDe: p.despacharAntesDe,
      estadoEnvio: p.estadoEnvio || 'pendiente',
      // El estado que informa ML, y la lectura en una palabra: la pantalla no
      // tiene por qué saber que `not_delivered` también es una cancelación.
      estadoEnvioMl: p.estadoEnvioMl || null,
      situacion: esCancelado(p) ? 'cancelado'
        : esEntregado(p) ? 'entregado'
          : p.estadoEnvio === 'despachado' ? 'en_camino'
            : p.estadoEnvio === 'con_faltante' ? 'con_faltante' : 'para_enviar',
      estado: p.estado,
      motivo: p.motivo,
      comprador: p.compradorNombre,
      recibidoEn: p.recibidoEn,
      items: suyos.map((i) => {
        const v = porVariante.get(i.productVariantId);
        /*
         * Lo que hay que juntar por esta línea. Para una variante suelta es
         * ella misma; para un pack, lo que lleva adentro con las cantidades ya
         * multiplicadas.
         */
        const componentes = v?.esPack
          ? (composiciones.get(v.id) || []).map((c) => {
            const cv = porComponente.get(c.componenteVariantId);
            return {
              sku: cv?.sku || `#${c.componenteVariantId}`,
              titulo: cv?.producto?.titulo || null,
              modelo: cv?.producto?.modelo || null,
              variante: describir(cv),
              ...atributos(cv),
              codigoBarras: cv?.codigoBarras || null,
              cantidad: c.cantidad * i.cantidad,
              porPack: c.cantidad,
            };
          })
          : null;

        return {
          sku: i.sku,
          cantidad: i.cantidad,
          titulo: v?.producto?.titulo || null,
          modelo: v?.producto?.modelo || null,
          variante: describir(v),
          ...atributos(v),
          codigoBarras: v?.codigoBarras || null,
          esPack: Boolean(v?.esPack),
          /*
           * Cuántas unidades lleva cada pack, para poder decirlo sin que la
           * pantalla tenga que sumar los componentes: "PACK · 3 unidades".
           */
          unidadesPorPack: componentes
            ? componentes.reduce((n, c) => n + (c.porPack || 0), 0)
            : null,
          componentes,
          locationId: i.locationId,
          local: nombreLocal.get(i.locationId) || null,
          /*
           * Una línea sin variante resuelta es un SKU que no existe en Stocker.
           * Se muestra igual y marcada: el pickeador tiene que saber que ese
           * renglón no lo va a encontrar en el sistema, y alguien tiene que
           * darlo de alta o cancelarlo.
           */
          sinResolver: !i.productVariantId,
        };
      }),
    });
  }

  /*
   * ── Un paquete por envío, no por venta ──────────────────────────
   *
   * Lo que el depósito arma es una caja, y en esa caja puede ir más de una
   * venta. La lista tiene que mostrar lo que va adentro de cada caja, todo
   * junto: si sale partido por venta, quien arma no tiene forma de saber que
   * esas tres líneas van al mismo bulto.
   */
  const paquetes = [];
  const porClave = new Map();
  for (const p of armados) {
    if (!porClave.has(p.claveEnvio)) {
      const nuevo = {
        claveEnvio: p.claveEnvio,
        envioId: p.envioId,
        envioTipo: p.envioTipo,
        despacharAntesDe: p.despacharAntesDe,
        plataforma: p.plataforma,
        estadoEnvio: p.estadoEnvio,
        estadoEnvioMl: p.estadoEnvioMl,
        situacion: p.situacion,
        comprador: p.comprador,
        recibidoEn: p.recibidoEn,
        // Las ventas que van en esta caja. Casi siempre una; cuando son varias,
        // hay que verlo: es lo que explica por qué el bulto lleva de todo.
        ventas: [],
        // Sobre cuál se acciona. Despachar una despacha la caja entera: ver
        // `despachar`.
        id: p.id,
        items: [],
        motivo: null,
      };
      porClave.set(p.claveEnvio, nuevo);
      paquetes.push(nuevo);
    }
    const caja = porClave.get(p.claveEnvio);
    caja.ventas.push({ id: p.id, pedidoExterno: p.pedidoExterno, estado: p.estado });
    caja.items.push(...p.items);
    if (p.motivo) caja.motivo = [caja.motivo, p.motivo].filter(Boolean).join(' ');
    /*
     * El estado de la caja es el del peor de sus ventas: si una tiene faltante,
     * la caja no se puede despachar entera y eso es lo que hay que ver.
     */
    if (p.situacion === 'con_faltante') caja.situacion = 'con_faltante';
  }

  /*
   * ── El consolidado ───────────────────────────────────────────
   *
   * La misma mercadería agrupada por SKU y local: un recorrido, no uno por
   * pedido. Es la lista con la que se camina el depósito.
   */
  const clave = (locId, sku) => `${locId || 0}::${sku}`;
  const acumulado = new Map();

  /*
   * El recorrido se hace sobre MERCADERÍA, no sobre líneas de pedido.
   *
   * Un pack se pide como uno y se busca como tres: si el consolidado dijera
   * "1 pack", el pickeador saldría a buscar un artículo que no está en ninguna
   * percha. Por eso cada pack se abre en lo que lleva adentro, y sus unidades
   * se suman con las de las remeras sueltas del mismo SKU que pidieron otros
   * pedidos — que es justamente el punto de consolidar: se baja todo junto una
   * sola vez.
   */
  const sumar = (linea, unidades) => {
    const k = clave(linea.locationId, linea.sku);
    if (!acumulado.has(k)) {
      acumulado.set(k, {
        sku: linea.sku,
        titulo: linea.titulo,
        modelo: linea.modelo || null,
        variante: linea.variante,
        // Los atributos con su nombre: ver `atributos` más arriba.
        variante1Nombre: linea.variante1Nombre || null,
        variante1Valor: linea.variante1Valor || null,
        variante2Nombre: linea.variante2Nombre || null,
        variante2Valor: linea.variante2Valor || null,
        codigoBarras: linea.codigoBarras,
        locationId: linea.locationId,
        local: linea.local,
        unidades: 0,
        // En cuántos paquetes distintos aparece: dice si conviene contar de
        // una y repartir, o buscarlo de a uno.
        enPaquetes: 0,
        sinResolver: linea.sinResolver,
        // De qué packs viene, para que el que baja 9 remeras entienda por qué
        // son nueve cuando ningún pedido pidió nueve.
        deLosPacks: linea.deLosPacks || null,
      });
    }
    const acc = acumulado.get(k);
    acc.unidades += unidades;
    acc.enPaquetes += 1;
    if (linea.deLosPacks) {
      acc.deLosPacks = [...new Set([...(acc.deLosPacks || []), ...linea.deLosPacks])];
    }
  };

  for (const p of paquetes) {
    if (p.estadoEnvio === 'despachado') continue;   // ya salió: no hay que buscarlo
    for (const i of p.items) {
      if (locationId && i.locationId !== Number(locationId)) continue;

      if (i.esPack && i.componentes?.length) {
        for (const c of i.componentes) {
          sumar({
            sku: c.sku, titulo: c.titulo, modelo: c.modelo, variante: c.variante,
            variante1Nombre: c.variante1Nombre, variante1Valor: c.variante1Valor,
            variante2Nombre: c.variante2Nombre, variante2Valor: c.variante2Valor,
            codigoBarras: c.codigoBarras, locationId: i.locationId, local: i.local,
            sinResolver: false, deLosPacks: [i.sku],
          }, c.cantidad);
        }
        continue;
      }

      sumar(i, i.cantidad);
    }
  }

  const consolidado = [...acumulado.values()].sort((a, b) => (
    (a.local || '').localeCompare(b.local || '')
    || (a.titulo || a.sku).localeCompare(b.titulo || b.sku)
    || (a.variante || '').localeCompare(b.variante || '')
  ));

  return {
    fecha: desde,
    hasta,
    dias,
    filtro: cual,
    // Cuántos hay en cada estado, para poder numerar las pestañas.
    porEstado,
    // `pedidos` sigue nombrando la lista principal por compatibilidad, pero cada
    // entrada es un PAQUETE: puede llevar más de una venta adentro.
    pedidos: paquetes,
    paquetes,
    consolidado,
    resumen: {
      paquetes: paquetes.length,
      // Cuántas ventas hay en total: con envíos que juntan varias, no es lo
      // mismo que la cantidad de cajas, y las dos cosas se miran.
      ventas: paquetes.reduce((n, p) => n + p.ventas.length, 0),
      pendientes: paquetes.filter((p) => p.estadoEnvio === 'pendiente').length,
      despachados: paquetes.filter((p) => p.estadoEnvio === 'despachado').length,
      conFaltante: paquetes.filter((p) => p.situacion === 'con_faltante').length,
      unidades: consolidado.reduce((s, l) => s + l.unidades, 0),
      referencias: consolidado.length,
      flex: paquetes.filter((p) => p.envioTipo === 'flex').length,
    },
  };
}

const vacio = () => ({
  paquetes: 0, ventas: 0, pendientes: 0, despachados: 0, conFaltante: 0,
  unidades: 0, referencias: 0, flex: 0,
});

/**
 * El paquete salió: la reserva se convierte en egreso.
 *
 * Es el único lugar donde la mercadería de un pedido online baja del estante.
 * Todo en una transacción: o sale entero o no sale, porque medio paquete
 * despachado deja al depósito descuadrado y al comprador esperando algo que
 * nadie sabe si salió.
 */
async function despachar({ pedidoId, businessId, employeeId = null }) {
  const t = await db.transaction();
  try {
    const pedido = await PedidoPlataforma.findOne({
      where: { id: pedidoId, businessId }, transaction: t, lock: t.LOCK.UPDATE,
    });
    if (!pedido) { await t.rollback(); throw error('Ese envío no existe.', 404); }
    if (!DESPACHABLES.includes(pedido.estado)) {
      await t.rollback();
      throw error(`Este pedido está ${pedido.estado} y no hay nada que despachar.`, 409);
    }
    if (pedido.estadoEnvio === 'despachado') {
      /*
       * Idempotente a propósito. El botón se toca dos veces, la conexión del
       * depósito se corta y se reintenta: descontar de nuevo sería sacar del
       * estante mercadería que ya salió.
       */
      await t.rollback();
      return { pedido, repetido: true, movidas: 0 };
    }

    /*
     * ── Se despacha la CAJA, no la venta ────────────────────────
     *
     * Mercado Libre junta varias ventas del mismo comprador en un solo envío.
     * La caja sale una vez: despachar sólo una de sus ventas dejaría a las
     * otras con la mercadería apartada para siempre, esperando un despacho que
     * ya ocurrió y que nadie va a repetir.
     *
     * Por eso se buscan todas las ventas del mismo número de envío y salen
     * juntas, en la misma transacción. Sin número de envío, la venta es su
     * propia caja y esto se reduce al caso de siempre.
     */
    const delMismoEnvio = pedido.envioId
      ? await PedidoPlataforma.findAll({
        where: {
          businessId,
          plataforma: pedido.plataforma,
          envioId: pedido.envioId,
          estado: { [Op.in]: DESPACHABLES },
        },
        transaction: t, lock: t.LOCK.UPDATE,
      })
      : [pedido];

    const aDespachar = delMismoEnvio.filter((p) => p.estadoEnvio !== 'despachado');

    const items = await PedidoPlataformaItem.findAll({
      where: { pedidoId: aDespachar.map((p) => p.id) }, transaction: t,
    });

    // Cuáles de estas líneas son packs, en una consulta y no una por línea.
    const variantes = await ProductVariant.findAll({
      where: { id: items.map((i) => i.productVariantId).filter(Boolean) },
      attributes: ['id', 'esPack'],
      transaction: t,
    });
    const paquetesQueSonPack = new Set(variantes.filter((v) => v.esPack).map((v) => v.id));
    // La composición de todos los packs de esta caja, para poder contar prendas.
    const componentesPorPack = paquetesQueSonPack.size
      ? await packService.componentesDe([...paquetesQueSonPack], t)
      : new Map();

    let movidas = 0;
    for (const i of items) {
      // Las líneas sin variante nunca apartaron nada: no hay reserva que
      // consumir ni stock que mover.
      if (!i.productVariantId || !i.locationId) continue;

      /*
       * Una sola llamada baja el stock, suelta la reserva y deja el renglón en
       * el libro. Separarlo en dos —descontar acá y registrar allá— es lo que
       * permite que un `return` temprano mueva mercadería sin rastro.
       */
      /*
       * Un pack no baja del estante: bajan las prendas que lleva adentro. El
       * movimiento queda por componente y no por pack, porque el libro tiene
       * que hablar de mercadería que se puede contar: "salieron 3 remeras
       * negras M" se cuenta en el estante, "salió 1 pack" no se cuenta en
       * ningún lado.
       */
      const esPack = paquetesQueSonPack.has(i.productVariantId);
      const motivo = `Despacho ${pedido.plataforma} ${pedido.pedidoExterno}`
        + (esPack ? ` (pack ${i.sku})` : '');

      const pudo = esPack
        ? await packService.consumirPack(
          i.productVariantId, i.locationId, businessId, i.cantidad, t,
          { motivo, employeeId },
        )
        : await stockService.consumirReserva(
          i.productVariantId, i.locationId, businessId, i.cantidad, t,
          { motivo, employeeId },
        );
      if (!pudo) {
        await t.rollback();
        throw error(
          `No se pudo despachar ${i.sku}: la reserva ya no está. `
          + 'Puede que el pedido se haya cancelado o que alguien ajustara el stock.',
          409,
          /*
           * Plano y adentro de `detalles`: el manejador de errores arma el
           * cuerpo de la respuesta desde `detalles` —es lo que llega a la
           * pantalla—, pero varios lugares del servidor leen `error.codigo`
           * directo. Mandando uno solo, la pantalla recibe un 409 sin saber
           * cuál es y muestra el cartel genérico.
           */
          {
            codigo: 'RESERVA_PERDIDA',
            sku: i.sku,
            detalles: { codigo: 'RESERVA_PERDIDA', sku: i.sku },
          },
        );
      }

      /*
       * Se cuenta lo que salió del estante, no las líneas del pedido. Dos packs
       * de tres remeras son seis prendas: decir "salieron 2 unidades" al que
       * acaba de bajar seis es contarle otra cosa de la que hizo.
       */
      movidas += esPack
        ? (componentesPorPack.get(i.productVariantId) || [])
          .reduce((n, c) => n + c.cantidad * i.cantidad, 0)
        : i.cantidad;
    }

    for (const p of aDespachar) {
      await p.update({
        estadoEnvio: 'despachado',
        despachadoEn: new Date(),
        despachadoPorEmployeeId: employeeId,
      }, { transaction: t });
    }

    await t.commit();
    log.info('envios', 'paquete despachado', {
      pedido: pedido.id, plataforma: pedido.plataforma,
      ventas: aDespachar.length, unidades: movidas,
    });
    return { pedido, repetido: false, movidas, ventas: aDespachar.length };
  } catch (e) {
    await t.rollback().catch(() => {});
    throw e;
  }
}

/**
 * El pickeador no encontró la mercadería.
 *
 * NO toca el stock, y es deliberado: el egreso nunca ocurrió, así que el
 * estante sigue diciendo la verdad. Lo que hay es una diferencia entre lo que
 * el sistema cree que hay y lo que se encontró, y eso se resuelve con un
 * recuento, no desde la pantalla de picking.
 *
 * La reserva tampoco se suelta. Soltarla dejaría la unidad disponible para
 * venderse otra vez, cuando lo que se sabe es justamente que no está.
 */
async function marcarFaltante({ pedidoId, businessId, nota = null, employeeId = null }) {
  const pedido = await PedidoPlataforma.findOne({ where: { id: pedidoId, businessId } });
  if (!pedido) throw error('Ese envío no existe.', 404);
  if (pedido.estadoEnvio === 'despachado') {
    throw error('Este paquete ya se despachó: no se puede marcar como faltante.', 409);
  }

  const texto = String(nota || '').trim().slice(0, 400);
  await pedido.update({
    estadoEnvio: 'con_faltante',
    motivo: [pedido.motivo, texto ? `Faltante en depósito: ${texto}` : 'Faltante en depósito.']
      .filter(Boolean).join(' ').slice(0, 500),
  });

  log.warn('envios', 'faltante marcado en el depósito', {
    pedido: pedido.id, plataforma: pedido.plataforma, empleado: employeeId,
  });
  return pedido;
}

module.exports = { delDia, despachar, marcarFaltante, ESTADOS, DESPACHABLES, limitesDelDia };
