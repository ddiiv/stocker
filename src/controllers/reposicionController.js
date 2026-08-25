/*
 * Pedidos de reposición.
 *
 * Tres pantallas distintas pegan a estos endpoints —el local que pide, oficina
 * que autoriza y reposición que prepara—, así que el controller resuelve sobre
 * todo desde dónde mira cada uno: un empleado de local ve lo suyo, el resto ve
 * el negocio entero.
 */

const sequelize = require('../config/database');
const { Employee, BusinessLocation, PedidoReposicion, PedidoReposicionItem } = require('../models');
const reposicion = require('../services/reposicionService');
const deposito = require('../services/depositoService');
const { esAdministradorTotal } = require('../middleware/auth');

/*
 * Desde qué local mira quien pregunta.
 *
 * El empleado asignado a un local ve sus pedidos y nada más: mostrarle los de
 * las otras sucursales no le sirve para trabajar y le deja ver el movimiento
 * de un negocio que no es el suyo. El dueño y quien trabaja en depósito u
 * oficina ven todo, porque su trabajo es justamente comparar entre locales.
 */
async function localDelEmpleado(req) {
  if (esAdministradorTotal(req.auth) || !req.auth.employeeId) return null;
  const emp = await Employee.findByPk(req.auth.employeeId, { attributes: ['locationId'] });
  if (!emp?.locationId) return null;
  const local = await BusinessLocation.findByPk(emp.locationId);
  // Quien está en un depósito no es "de un local": ve todos los pedidos que
  // tiene que preparar.
  if (!local || local.tipo === 'deposito') return null;
  return local.id;
}

// GET /api/reposicion/pedidos
const listar = async (req, res, next) => {
  try {
    const { estado, locationId, depositoId, desde, hasta, page, limit } = req.query;
    const propio = await localDelEmpleado(req);
    res.json(await reposicion.listar({
      businessId: req.auth.businessId,
      estado: estado ? String(estado).split(',') : undefined,
      // El filtro del empleado de local no es negociable: si pide otro, se
      // ignora y se le devuelve el suyo.
      locationId: propio || (locationId ? Number(locationId) : undefined),
      depositoId: depositoId ? Number(depositoId) : undefined,
      desde, hasta, page, limit,
    }));
  } catch (e) { next(e); }
};

// GET /api/reposicion/pedidos/:id
const detalle = async (req, res, next) => {
  try {
    const { pedido, items } = await reposicion.traer(req.params.id, req.auth.businessId);
    const propio = await localDelEmpleado(req);
    if (propio && pedido.locationId !== propio) {
      return res.status(403).json({ message: 'Este pedido es de otro local.' });
    }
    res.json({ ...pedido.toJSON(), items });
  } catch (e) { next(e); }
};

// POST /api/reposicion/pedidos
const crear = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const { items = [], notas, depositoId = null } = req.body;
    /*
     * El local sale de la sesión del empleado, no del cuerpo del pedido.
     *
     * Quien pide reposición pide para donde trabaja. Dejarlo elegir abriría la
     * puerta a que un local se mande mercadería a otro sin que nadie lo mire.
     */
    const propio = await localDelEmpleado(req);
    const locationId = propio || Number(req.body.locationId);
    if (!locationId) {
      return res.status(400).json({
        message: esAdministradorTotal(req.auth)
          ? 'Elegí para qué local es el pedido.'
          : 'Tu usuario no tiene un local asignado. Pedile al dueño que te asigne uno desde Empleados.',
      });
    }

    const pedido = await reposicion.crearPedido({
      businessId: req.auth.businessId,
      locationId, depositoId,
      employeeId: req.auth.employeeId || null,
      items, notas,
      transaction: t,
    });
    await t.commit();

    const { pedido: full, items: lineas } = await reposicion.traer(pedido.id, req.auth.businessId);
    res.status(201).json({ ...full.toJSON(), items: lineas });
  } catch (e) { await t.rollback().catch(() => {}); next(e); }
};

/*
 * GET /api/reposicion/pedidos/:id/disponibilidad
 *
 * Qué hay realmente en el depósito de lo que este pedido pide, línea por línea.
 *
 * La miran los dos lados: oficina para decidir si aprueba, y el depósito para
 * saber qué puede armar. Es el mismo número para los dos, que es justamente lo
 * que evita el malentendido de "yo aprobé diez" contra "acá había tres".
 */
const disponibilidad = async (req, res, next) => {
  try {
    const propio = await localDelEmpleado(req);
    const r = await reposicion.disponibilidad(req.params.id, req.auth.businessId);
    if (propio && r.pedido.locationId !== propio) {
      return res.status(403).json({ message: 'Este pedido es de otro local.' });
    }
    res.json({ pedido: r.pedido, lineas: r.lineas, resumen: r.resumen });
  } catch (e) { next(e); }
};

/*
 * POST /api/reposicion/pedidos/:id/registrar-faltante
 *
 * Carga al depósito mercadería que estaba físicamente pero sin registrar, para
 * poder completar un pedido.
 *
 * Es el caso que hace falta cubrir de verdad: el pedido pide diez, el sistema
 * dice que hay tres, y en el estante hay diez porque nunca se cargaron. Se
 * cuentan, se generan las etiquetas y ese mismo acto sube el stock —el mismo
 * circuito del ingreso normal, con su documento y su movimiento— y el ingreso
 * queda atado a este pedido para que después se entienda por qué apareció.
 *
 * El empleado elige QUÉ tiene y CUÁNTO: no se asume que está todo lo que falta,
 * porque asumirlo es inventar inventario.
 */
const registrarFaltante = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const { pedido } = await reposicion.traer(req.params.id, req.auth.businessId, t);
    if (!['aprobado', 'pendiente'].includes(pedido.estado)) {
      await t.rollback();
      return res.status(409).json({
        message: `Este pedido está ${pedido.estado}: la mercadería se carga mientras está por prepararse.`,
      });
    }

    const { ingreso } = await deposito.registrarIngreso({
      businessId: req.auth.businessId,
      locationId: pedido.depositoId,
      employeeId: req.auth.employeeId || null,
      // Con etiquetas: se contó una vez y de esa cuenta salen el stock y las
      // etiquetas que se pegan en cada prenda.
      origen: 'etiquetas',
      items: req.body?.items,
      notas: `Stock encontrado sin registrar para el pedido ${pedido.numero}`,
      pedidoId: pedido.id,
      transaction: t,
    });
    await t.commit();

    const r = await reposicion.disponibilidad(pedido.id, req.auth.businessId);
    res.status(201).json({
      ok: true,
      ingresoId: ingreso.id,
      numero: ingreso.numero,
      mensaje: `Cargado como ${ingreso.numero}. Generá las etiquetas y pegalas antes de armar el pedido.`,
      disponibilidad: { lineas: r.lineas, resumen: r.resumen },
    });
  } catch (e) { await t.rollback().catch(() => {}); next(e); }
};

// POST /api/reposicion/pedidos/:id/aprobar
const aprobar = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const pedido = await reposicion.aprobar({
      pedidoId: req.params.id, businessId: req.auth.businessId,
      employeeId: req.auth.employeeId || null,
      // Aprobar sabiendo que falta es una decisión, y se toma explícitamente.
      aceptarParcial: req.body?.aceptarParcial === true,
      transaction: t,
    });
    await t.commit();
    res.json({ ok: true, pedido, mensaje: `Pedido ${pedido.numero} aprobado: ya lo ve el equipo de reposición.` });
  } catch (e) { await t.rollback().catch(() => {}); next(e); }
};

// POST /api/reposicion/pedidos/:id/rechazar
const rechazar = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const pedido = await reposicion.rechazar({
      pedidoId: req.params.id, businessId: req.auth.businessId,
      employeeId: req.auth.employeeId || null, motivo: req.body?.motivo, transaction: t,
    });
    await t.commit();
    res.json({ ok: true, pedido, mensaje: `Pedido ${pedido.numero} rechazado.` });
  } catch (e) { await t.rollback().catch(() => {}); next(e); }
};

// POST /api/reposicion/pedidos/:id/despachar
const despachar = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const pedido = await reposicion.despachar({
      pedidoId: req.params.id, businessId: req.auth.businessId,
      employeeId: req.auth.employeeId || null, envios: req.body?.envios, transaction: t,
    });
    await t.commit();
    res.json({
      ok: true, pedido,
      mensaje: `Pedido ${pedido.numero} despachado. La mercadería queda en tránsito hasta que el local confirme.`,
    });
  } catch (e) { await t.rollback().catch(() => {}); next(e); }
};

// POST /api/reposicion/pedidos/:id/recibir
const recibir = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const { pedido: cabecera } = await reposicion.traer(req.params.id, req.auth.businessId, t);
    const propio = await localDelEmpleado(req);
    if (propio && cabecera.locationId !== propio) {
      await t.rollback();
      return res.status(403).json({ message: 'Este pedido es de otro local: la recepción la confirma quien lo recibe.' });
    }

    const { pedido, faltan } = await reposicion.recibir({
      pedidoId: req.params.id, businessId: req.auth.businessId,
      employeeId: req.auth.employeeId || null,
      recepciones: req.body?.recepciones, nota: req.body?.nota, transaction: t,
    });
    await t.commit();
    res.json({
      ok: true, pedido, faltan,
      mensaje: faltan
        ? `Pedido ${pedido.numero} recibido con faltantes. La diferencia quedó anotada para oficina.`
        : `Pedido ${pedido.numero} recibido completo: el stock ya está en el local.`,
    });
  } catch (e) { await t.rollback().catch(() => {}); next(e); }
};

// POST /api/reposicion/pedidos/:id/cancelar
const cancelar = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const { pedido: cabecera } = await reposicion.traer(req.params.id, req.auth.businessId, t);
    const propio = await localDelEmpleado(req);
    if (propio && cabecera.locationId !== propio) {
      await t.rollback();
      return res.status(403).json({ message: 'Este pedido es de otro local.' });
    }
    const pedido = await reposicion.cancelar({
      pedidoId: req.params.id, businessId: req.auth.businessId,
      employeeId: req.auth.employeeId || null, motivo: req.body?.motivo, transaction: t,
    });
    await t.commit();
    res.json({ ok: true, pedido, mensaje: `Pedido ${pedido.numero} cancelado.` });
  } catch (e) { await t.rollback().catch(() => {}); next(e); }
};

/*
 * GET /api/reposicion/saldos
 *
 * Los pedidos que cerraron con mercadería sin salir del depósito.
 *
 * Es la bandeja prioritaria: cada saldo sin resolver es algo que el local
 * sigue necesitando y que nadie está preparando. Se muestra primero para que
 * la decisión —mandarlo o darlo de baja— no dependa de que alguien se acuerde.
 */
const saldos = async (req, res, next) => {
  try {
    const propio = await localDelEmpleado(req);
    res.json({ data: await reposicion.saldosPendientes(req.auth.businessId, { locationId: propio }) });
  } catch (e) { next(e); }
};

// POST /api/reposicion/pedidos/:id/saldo  { aceptar, motivo }
const resolverSaldo = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const aceptar = req.body?.aceptar === true;
    const { pedido, nuevo } = await reposicion.resolverSaldo({
      pedidoId: req.params.id, businessId: req.auth.businessId,
      employeeId: req.auth.employeeId || null,
      aceptar, motivo: req.body?.motivo, transaction: t,
    });
    await t.commit();
    res.json({
      ok: true, pedido, nuevo,
      mensaje: aceptar
        ? `El saldo de ${pedido.numero} se rearmó como ${nuevo.numero}. Queda esperando la aprobación de oficina.`
        : `El saldo de ${pedido.numero} se dio de baja.`,
    });
  } catch (e) { await t.rollback().catch(() => {}); next(e); }
};

// GET /api/reposicion/en-transito
const transito = async (req, res, next) => {
  try {
    const propio = await localDelEmpleado(req);
    const locationId = propio || (req.query.locationId ? Number(req.query.locationId) : null);
    res.json({ data: await reposicion.enTransito(req.auth.businessId, { locationId }) });
  } catch (e) { next(e); }
};

/*
 * GET /api/reposicion/pendientes
 *
 * El contador de las tres bandejas. Es lo que hace que el circuito se mueva:
 * sin un número visible, un pedido aprobado espera en el depósito hasta que
 * alguien del local llama por teléfono a preguntar.
 */
const pendientes = async (req, res, next) => {
  try {
    const businessId = req.auth.businessId;
    const propio = await localDelEmpleado(req);
    const base = { businessId, ...(propio ? { locationId: propio } : {}) };
    const { StockIngreso } = require('../models');

    const [porAprobar, porPreparar, porRecibir, ingresosPendientes, saldosSinResolver] = await Promise.all([
      PedidoReposicion.count({ where: { ...base, estado: 'pendiente' } }),
      PedidoReposicion.count({ where: { ...base, estado: 'aprobado' } }),
      PedidoReposicion.count({ where: { ...base, estado: 'enviado' } }),
      StockIngreso.count({ where: { businessId, estado: 'pendiente' } }),
      // Lo que quedó sin salir del depósito y espera decisión.
      PedidoReposicion.count({ where: { ...base, saldoEstado: 'pendiente' } }),
    ]);
    res.json({ porAprobar, porPreparar, porRecibir, ingresosPendientes, saldosSinResolver });
  } catch (e) { next(e); }
};

module.exports = {
  listar, detalle, disponibilidad, registrarFaltante,
  crear, aprobar, rechazar, despachar, recibir, cancelar,
  transito, pendientes, saldos, resolverSaldo,
};
