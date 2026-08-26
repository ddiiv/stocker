/*
 * Ingreso de mercadería nueva al depósito.
 *
 * La mercadería cruda entra por un depósito y de ahí se transfiere a los
 * locales. Este servicio cubre las dos formas en que se cuenta lo que baja del
 * camión, que son distintas porque el trabajo físico es distinto:
 *
 *   PLAN A — con etiquetas (origen 'etiquetas')
 *     El chico cuenta una vez, y ese mismo conteo genera las etiquetas. El
 *     stock sube en el acto: la etiqueta impresa ES la prueba de la cuenta, y
 *     hacerlo contar de nuevo para "confirmar" es exactamente el doble trabajo
 *     que este circuito viene a eliminar. Si después aparece mal, se anula.
 *
 *   PLAN B — sin etiquetas (origen 'conteo')
 *     Se cuenta a mano y se manda. Queda pendiente hasta que oficina lo acepta.
 *     Antes esto era "me lo pasan y yo lo subo": el mismo trabajo, pero fuera
 *     del sistema y sin registro de quién contó qué.
 *
 * Nada se borra. Rechazar y anular son estados con su motivo obligatorio,
 * porque el momento en que alguien va a leer esto es justo cuando las
 * cantidades no cierran y hay que reconstruir qué pasó.
 */

const { Op } = require('sequelize');
const {
  StockIngreso, StockIngresoItem, ProductVariant, Product,
  BusinessLocation, Employee,
} = require('../models');
const stockService = require('./stockService');
const { ultimoCorrelativo } = require('./invoiceNumberService');

const ESTADOS = ['pendiente', 'aplicado', 'rechazado', 'anulado'];

const error = (mensaje, status = 400, extra = {}) =>
  Object.assign(new Error(mensaje), { status, ...extra });

/** Los depósitos activos del negocio. */
async function depositos(businessId, t = null) {
  return BusinessLocation.findAll({
    where: { businessId, activo: true, tipo: 'deposito' },
    order: [['nombre', 'ASC']],
    transaction: t,
  });
}

/*
 * Los lugares donde se vende: locales y el de ventas web.
 *
 * Todo lo que no sea depósito. El de tipo `online` entra acá porque vende
 * igual que una sucursal —descuenta al despachar un pedido web— y también
 * pide reposición; lo único que lo distingue es que su stock es el que se
 * publica en MercadoLibre.
 */
async function locales(businessId, t = null) {
  return BusinessLocation.findAll({
    where: { businessId, activo: true, tipo: { [Op.ne]: 'deposito' } },
    order: [['nombre', 'ASC']],
    transaction: t,
  });
}

/*
 * Comprueba que un local sea un depósito del negocio.
 *
 * Se valida acá y no en la pantalla: un ingreso de mercadería cruda dirigido a
 * un local de venta desordena el circuito entero, porque de ahí no sale ninguna
 * transferencia y nadie lo va a estar buscando.
 */
async function exigirDeposito(locationId, businessId, t = null) {
  const local = await BusinessLocation.findOne({
    where: { id: locationId, businessId, activo: true }, transaction: t,
  });
  if (!local) throw error('El depósito indicado no pertenece a este negocio o está inactivo.', 400);
  if (local.tipo !== 'deposito') {
    throw error(
      `"${local.nombre}" es un local de venta, no un depósito. La mercadería nueva entra por un depósito y de ahí se transfiere.`,
      400,
    );
  }
  return local;
}

/** Correlativo por mes, con el mismo formato que el resto de los documentos. */
async function siguienteNumero(businessId, t = null) {
  const now = new Date();
  const prefijo = `ING-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-`;
  // El máximo emitido, no la última fila: el orden de los ids no garantiza el
  // orden de los números en cuanto algo reescribe un `numero` ya guardado.
  const seq = await ultimoCorrelativo(StockIngreso, businessId, prefijo, t) + 1;
  return `${prefijo}${String(seq).padStart(5, '0')}`;
}

/*
 * Normaliza y valida las líneas contra el catálogo del negocio.
 *
 * Se resuelven las variantes de una sola consulta y se guarda copia del SKU y
 * la descripción: el remito tiene que poder leerse dentro de un año aunque la
 * variante se haya renombrado.
 */
async function armarItems(items, businessId, t = null) {
  const limpios = [];
  for (const it of Array.isArray(items) ? items : []) {
    const variantId = Number(it?.productVariantId || it?.variantId);
    const cantidad = Number(it?.cantidad);
    if (!variantId) continue;
    if (!Number.isInteger(cantidad) || cantidad <= 0) {
      throw error('Cada línea necesita una cantidad entera mayor a cero.', 400);
    }
    limpios.push({ productVariantId: variantId, cantidad });
  }
  if (!limpios.length) throw error('El ingreso no tiene ninguna línea con cantidad.', 400);

  /*
   * Dos líneas de la misma variante se suman en vez de rechazarse.
   *
   * Contando bultos es normal encontrar el mismo modelo en dos cajas, y
   * obligar a sumarlo mentalmente antes de cargarlo es pedir el error.
   */
  const porVariante = new Map();
  for (const l of limpios) {
    porVariante.set(l.productVariantId, (porVariante.get(l.productVariantId) || 0) + l.cantidad);
  }

  const ids = [...porVariante.keys()];
  const variantes = await ProductVariant.findAll({
    where: { id: { [Op.in]: ids }, businessId },
    include: [{ model: Product, as: 'producto', attributes: ['titulo'] }],
    transaction: t,
  });
  if (variantes.length !== ids.length) {
    const hallados = new Set(variantes.map((v) => v.id));
    const faltan = ids.filter((id) => !hallados.has(id));
    throw error(`Hay ${faltan.length} artículo(s) que no pertenecen a este negocio.`, 400);
  }

  return variantes.map((v) => ({
    productVariantId: v.id,
    cantidad: porVariante.get(v.id),
    sku: v.sku,
    descripcion: [v.producto?.titulo, v.variante1Valor, v.variante2Valor].filter(Boolean).join(' · ').slice(0, 255),
  }));
}

/** Sube al depósito todas las líneas de un ingreso, cada una con su movimiento. */
async function aplicarStock(ingreso, items, employeeId, t) {
  for (const item of items) {
    await stockService.mover({
      variantId: item.productVariantId,
      businessId: ingreso.businessId,
      locationId: ingreso.locationId,
      delta: item.cantidad,
      tipo: 'ingreso',
      motivo: `Ingreso a depósito ${ingreso.numero}`,
      employeeId,
      transaction: t,
    });
  }
}

/*
 * Registra un ingreso de mercadería.
 *
 * Con `origen: 'etiquetas'` el stock sube ya; con 'conteo' queda pendiente de
 * aprobación. Devuelve el documento con sus items.
 */
async function registrarIngreso({
  businessId, locationId, employeeId = null, origen = 'etiquetas',
  items = [], notas = null, pedidoId = null, transaction: t,
}) {
  if (!['etiquetas', 'conteo'].includes(origen)) {
    throw error('El origen del ingreso tiene que ser "etiquetas" o "conteo".', 400);
  }
  await exigirDeposito(locationId, businessId, t);
  const lineas = await armarItems(items, businessId, t);

  const estado = origen === 'etiquetas' ? 'aplicado' : 'pendiente';
  const ingreso = await StockIngreso.create({
    businessId, locationId, employeeId, pedidoId,
    numero: await siguienteNumero(businessId, t),
    origen, estado,
    notas: notas ? String(notas).slice(0, 500) : null,
    // El Plan A no pasa por nadie: se resuelve solo en el momento de cargarlo.
    resueltoPorEmployeeId: estado === 'aplicado' ? employeeId : null,
    resueltoEn: estado === 'aplicado' ? new Date() : null,
  }, { transaction: t });

  await StockIngresoItem.bulkCreate(
    lineas.map((l) => ({ ...l, ingresoId: ingreso.id })),
    { transaction: t },
  );

  if (estado === 'aplicado') await aplicarStock(ingreso, lineas, employeeId, t);

  return { ingreso, items: lineas };
}

/** Oficina acepta un conteo del Plan B: recién ahí sube el stock. */
async function aceptarIngreso({ ingresoId, businessId, employeeId = null, transaction: t }) {
  const ingreso = await StockIngreso.findOne({
    where: { id: ingresoId, businessId },
    include: [{ model: StockIngresoItem, as: 'items' }],
    transaction: t,
  });
  if (!ingreso) throw error('Ingreso no encontrado.', 404);
  if (ingreso.estado !== 'pendiente') {
    throw error(`Este ingreso ya está ${ingreso.estado}, no se puede aceptar de nuevo.`, 409);
  }

  await aplicarStock(ingreso, ingreso.items, ingreso.employeeId, t);
  await ingreso.update({
    estado: 'aplicado',
    resueltoPorEmployeeId: employeeId,
    resueltoEn: new Date(),
  }, { transaction: t });
  return ingreso;
}

/** Oficina rechaza un conteo. No sube nada y queda el porqué. */
async function rechazarIngreso({ ingresoId, businessId, employeeId = null, motivo, transaction: t }) {
  const limpio = String(motivo || '').trim();
  if (!limpio) throw error('Poné el motivo del rechazo: quien contó necesita saber qué corregir.', 400);

  const ingreso = await StockIngreso.findOne({ where: { id: ingresoId, businessId }, transaction: t });
  if (!ingreso) throw error('Ingreso no encontrado.', 404);
  if (ingreso.estado !== 'pendiente') {
    throw error(`Este ingreso ya está ${ingreso.estado}. Si el stock ya subió, lo que corresponde es anularlo.`, 409);
  }

  await ingreso.update({
    estado: 'rechazado',
    motivo: limpio.slice(0, 500),
    resueltoPorEmployeeId: employeeId,
    resueltoEn: new Date(),
  }, { transaction: t });
  return ingreso;
}

/*
 * Anula un ingreso que ya subió stock y devuelve el depósito a como estaba.
 *
 * Es la salida para el Plan A cuando el conteo salió mal: el stock sube solo,
 * así que tiene que haber forma de deshacerlo.
 *
 * No se permite si la mercadería ya se movió. Si de las 20 unidades que entraron
 * quedan 8 porque el resto ya viajó a un local, revertir las 20 dejaría el
 * depósito en -12: un número que no existe en ninguna góndola y que después hay
 * que perseguir. Se dice cuánto falta y se corrige a mano, que es lo honesto.
 */
async function anularIngreso({ ingresoId, businessId, employeeId = null, motivo, transaction: t }) {
  const limpio = String(motivo || '').trim();
  if (!limpio) throw error('Poné el motivo de la anulación: es lo que explica el movimiento en el historial.', 400);

  const ingreso = await StockIngreso.findOne({
    where: { id: ingresoId, businessId },
    include: [{ model: StockIngresoItem, as: 'items' }],
    transaction: t,
  });
  if (!ingreso) throw error('Ingreso no encontrado.', 404);
  if (ingreso.estado !== 'aplicado') {
    throw error(`Sólo se puede anular un ingreso aplicado. Este está ${ingreso.estado}.`, 409);
  }

  // Primero se comprueba TODO y recién después se toca algo: revertir la mitad
  // y frenar dejaría el ingreso a medio anular y sin forma de retomarlo.
  const sinStock = [];
  for (const item of ingreso.items) {
    const hay = await stockService.stockEn(item.productVariantId, ingreso.locationId, t);
    if (hay < item.cantidad) {
      sinStock.push({ sku: item.sku, descripcion: item.descripcion, necesita: item.cantidad, hay });
    }
  }
  if (sinStock.length) {
    const detalle = sinStock
      .map((s) => `${s.descripcion || s.sku}: entraron ${s.necesita} y quedan ${s.hay}`)
      .join('; ');
    throw error(
      `No se puede anular: parte de esta mercadería ya salió del depósito. ${detalle}. `
      + 'Ajustá el stock a mano desde Stock por local y dejá anotado el motivo.',
      409,
      { faltantes: sinStock },
    );
  }

  for (const item of ingreso.items) {
    await stockService.mover({
      variantId: item.productVariantId,
      businessId: ingreso.businessId,
      locationId: ingreso.locationId,
      delta: -item.cantidad,
      tipo: 'ajuste',
      motivo: `Anulación del ingreso ${ingreso.numero}: ${limpio}`.slice(0, 255),
      employeeId,
      transaction: t,
    });
  }

  await ingreso.update({
    estado: 'anulado',
    motivo: limpio.slice(0, 500),
    resueltoPorEmployeeId: employeeId,
    resueltoEn: new Date(),
  }, { transaction: t });
  return ingreso;
}

/** Listado con filtros, para la pantalla de depósito y la de aprobaciones. */
async function listarIngresos({ businessId, estado, locationId, desde, hasta, limit = 50, page = 1 }) {
  const where = { businessId };
  if (estado) where.estado = estado;
  if (locationId) where.locationId = locationId;
  if (desde || hasta) {
    where.createdAt = {};
    if (desde) where.createdAt[Op.gte] = new Date(`${desde}T00:00:00`);
    if (hasta) where.createdAt[Op.lte] = new Date(`${hasta}T23:59:59.999`);
  }

  const { rows, count } = await StockIngreso.findAndCountAll({
    where,
    include: [
      { model: BusinessLocation, as: 'deposito', attributes: ['id', 'nombre', 'tipo'] },
      { model: Employee, as: 'empleado', attributes: ['id', 'nombre', 'apellido'] },
      { model: Employee, as: 'resueltoPor', attributes: ['id', 'nombre', 'apellido'] },
    ],
    order: [['id', 'DESC']],
    limit: Math.min(200, Number(limit) || 50),
    offset: (Math.max(1, Number(page) || 1) - 1) * (Math.min(200, Number(limit) || 50)),
    /*
     * Los items van en consulta aparte a propósito: con `limit` y un hasMany
     * en el mismo SELECT, el motor corta las filas del JOIN y devuelve
     * documentos con la mitad de las líneas.
     */
    distinct: true,
  });

  const items = rows.length
    ? await StockIngresoItem.findAll({ where: { ingresoId: { [Op.in]: rows.map((r) => r.id) } } })
    : [];
  const porIngreso = new Map();
  for (const it of items) {
    if (!porIngreso.has(it.ingresoId)) porIngreso.set(it.ingresoId, []);
    porIngreso.get(it.ingresoId).push(it);
  }

  return {
    total: count,
    data: rows.map((r) => ({ ...r.toJSON(), items: porIngreso.get(r.id) || [] })),
  };
}

module.exports = {
  ESTADOS,
  depositos, locales, exigirDeposito, siguienteNumero, armarItems,
  registrarIngreso, aceptarIngreso, rechazarIngreso, anularIngreso, listarIngresos,
};
