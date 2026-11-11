/*
 * Historial de cambios de precio.
 *
 * Cada camino que escribe precio o costo llama a `agregar` DENTRO de la misma
 * transacción del cambio, con las filas que de verdad cambiaron: si el cambio
 * se deshace, el historial también. Ver los modelos PrecioCambio y
 * PrecioCambioDetalle para por qué son dos tablas.
 */
const sequelize = require('../config/database');
const { Business, Employee, PrecioCambio, PrecioCambioDetalle } = require('../models');

const CAMPOS = ['precioMinorista', 'precioMayorista', 'costo'];
const ORIGENES = ['masivo', 'manual', 'excel', 'variantes', 'feria'];
const TANDA = 1000;

// A centavos y con null aparte: la base devuelve "1000.00" y el cuerpo trae 1000.
const redondeo = (v) => (v === null || v === undefined || v === '' ? null : Math.round(Number(v) * 100) / 100);
const cambia = (antes, despues) => redondeo(antes) !== redondeo(despues);

/*
 * Un "lote" es lo que agrupa las filas en UNA cabecera: un aplicar masivo, una
 * edición, una importación. `compartido` es para el Excel, que escribe en
 * muchas transacciones chicas: ahí la cabecera se confirma aparte (si no, la
 * segunda transacción no la vería) y `cerrar` la borra si no cambió nada.
 */
const nuevoLote = ({ businessId, auth, origen, resumen = {}, compartido = false }) => ({
  businessId, auth, origen, resumen, compartido,
  cabeceraId: null, productos: new Set(), variantes: new Set(),
});

// Quién lo hizo: el empleado, o el dueño de la cuenta (employeeId null).
async function quien(auth, transaction) {
  if (auth?.type === 'employee') {
    const e = await Employee.findByPk(auth.employeeId, { attributes: ['nombre', 'apellido'], transaction });
    return { employeeId: auth.employeeId, usuarioNombre: e ? `${e.nombre} ${e.apellido}`.trim().slice(0, 150) : null };
  }
  const b = await Business.findByPk(auth.businessId, { attributes: ['ownerNombre', 'ownerApellido', 'nombreNegocio'], transaction });
  return { employeeId: null, usuarioNombre: b ? (`${b.ownerNombre} ${b.ownerApellido}`.trim() || b.nombreNegocio).slice(0, 150) : null };
}

const resumenDe = (lote) => ({ ...lote.resumen, productos: lote.productos.size, variantes: lote.variantes.size });

/*
 * Las filas de historial de lo que `valores` le cambiaría a `instancia`
 * (producto o variante), comparando con lo que tiene ahora. Un valor igual no
 * genera fila. `variantId` null = es el precio del producto.
 */
function diferencias(instancia, valores, productId, variantId = null) {
  return CAMPOS
    .filter((campo) => campo in valores && cambia(instancia[campo], valores[campo]))
    .map((campo) => ({ productId, variantId, campo, antes: redondeo(instancia[campo]), despues: redondeo(valores[campo]) }));
}

// Guarda las filas en la transacción `t`. Sin filas no escribe nada.
async function agregar(lote, filas, t) {
  if (!filas.length) return;
  for (const f of filas) (f.variantId ? lote.variantes.add(f.variantId) : lote.productos.add(f.productId));
  if (!lote.cabeceraId) {
    const c = await PrecioCambio.create({
      businessId: lote.businessId, origen: lote.origen, resumen: resumenDe(lote), filas: 0, ...(await quien(lote.auth, t)),
    }, { transaction: lote.compartido ? null : t });
    lote.cabeceraId = c.id;
  }
  for (let i = 0; i < filas.length; i += TANDA) {
    await PrecioCambioDetalle.bulkCreate(
      filas.slice(i, i + TANDA).map((f) => ({ ...f, precioCambioId: lote.cabeceraId })),
      { transaction: t },
    );
  }
  await PrecioCambio.increment('filas', { by: filas.length, where: { id: lote.cabeceraId }, transaction: t });
}

/*
 * `instancia.update(valores)` + su historial en una transacción propia. Para los
 * caminos que no tenían transacción (edición manual, Excel). Sin cambio de
 * precio es el update de siempre.
 */
async function actualizar({ instancia, valores, productId, variantId = null, lote }) {
  const filas = diferencias(instancia, valores, productId, variantId);
  if (!filas.length) return instancia.update(valores);
  const t = await sequelize.transaction();
  try {
    await instancia.update(valores, { transaction: t });
    await agregar(lote, filas, t);
    await t.commit();
  } catch (e) {
    await t.rollback().catch(() => {});
    throw e;
  }
  return instancia;
}

// Fin de un lote compartido: deja los conteos reales, o borra la cabecera vacía.
async function cerrar(lote) {
  if (!lote.cabeceraId) return;
  const c = await PrecioCambio.findByPk(lote.cabeceraId);
  if (!c) return;
  if (!c.filas) await c.destroy();
  else await c.update({ resumen: resumenDe(lote) });
}

module.exports = { CAMPOS, ORIGENES, redondeo, nuevoLote, diferencias, agregar, actualizar, cerrar };
