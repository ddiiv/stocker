const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const sequelize = require('../config/database');
const {
  PlatformAdmin, PlatformSetting, Plan, Subscription, SubscriptionPayment,
  Business, Employee, BusinessCuit, Sale, BusinessArcaConfig,
} = require('../models');
const { CATALOGO_FEATURES } = require('../config/planes');
const planService = require('../services/planService');
const totp = require('../utils/totp');
const mp = require('../services/mercadopagoService');
const bloqueo = require('../services/bloqueoService');
const { crearSesion } = require('../utils/session');
const { setAuthCookie, clearAuthCookie } = require('../utils/authCookie');
const { log, mask } = require('../utils/logger');

/*
 * Backoffice de Stocker.
 *
 * Acá se administra la plataforma, no un negocio: cuentas de clientes, planes,
 * precios, descuentos y los datos que muestra la página pública.
 *
 * Todo lo de este archivo corre bajo una sesión de tipo `platform`, que es
 * distinta de la de un dueño o un empleado. Nunca se mezclan: una sesión de
 * negocio no puede alcanzar estas rutas ni al revés.
 *
 * Segundo factor obligatorio. Es la única cuenta del sistema que ve los datos
 * de todos los negocios; si la contraseña se filtra sin un segundo factor, se
 * filtra la plataforma entera.
 */

const NIVEL = { soporte: 1, owner: 2, superuser: 3 };
const puede = (admin, minimo) => (NIVEL[admin?.rol] || 0) >= NIVEL[minimo];

const sanitize = (a) => ({
  id: a.id, nombre: a.nombre, email: a.email, rol: a.rol,
  activo: a.activo, totpActivo: Boolean(a.totpActivadoEn),
  ultimaConexion: a.ultimaConexion,
});

function ip(req) {
  const xff = req.headers['x-forwarded-for'];
  return xff ? String(xff).split(',')[0].trim() : (req.ip || null);
}

/*
 * POST /api/backoffice/login  { email, password, codigo }
 *
 * Pide los tres datos juntos y responde igual ante cualquier combinación
 * inválida: si el código se pidiera en un segundo paso, ese paso confirmaría
 * que la contraseña era correcta y regalaría la mitad del trabajo.
 */
const login = async (req, res, next) => {
  try {
    const { email, password, codigo } = req.body || {};
    const generico = { message: 'Credenciales inválidas.' };

    const admin = await PlatformAdmin.findOne({
      where: { email: String(email || '').trim().toLowerCase() },
    });

    // Se hashea igual cuando el usuario no existe, para que el tiempo de
    // respuesta no distinga "no existe" de "contraseña incorrecta".
    const hash = admin?.passwordHash || '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
    const okPass = await bcrypt.compare(String(password || ''), hash);

    if (!admin || !admin.activo || !okPass) {
      await bloqueo.registrar({ req, tipo: 'platform', identificador: email, exito: false });
      log.warn('backoffice', 'intento de acceso fallido', { email: mask.email(email), ip: mask.ip(ip(req)) });
      return res.status(401).json(generico);
    }

    // Sin segundo factor configurado no se entra: se activa una sola vez, con
    // el token de alta que entrega el script de creación.
    if (!admin.totpSecret || !admin.totpActivadoEn) {
      return res.status(409).json({
        motivo: 'totp_pendiente',
        message: 'Falta activar el segundo factor de esta cuenta.',
      });
    }
    if (!totp.validar(admin.totpSecret, codigo)) {
      // Un código errado con la contraseña correcta cuenta como fallo igual: es
      // exactamente lo que se ve cuando alguien ya tiene la contraseña y le
      // falta el segundo factor.
      await bloqueo.registrar({ req, tipo: 'platform', identificador: email, exito: false });
      log.warn('backoffice', 'código de segundo factor inválido', { email: mask.email(email), ip: mask.ip(ip(req)) });
      return res.status(401).json(generico);
    }

    await bloqueo.registrar({ req, tipo: 'platform', identificador: email, exito: true });
    await bloqueo.limpiar({ req, identificador: email });

    await admin.update({ ultimaConexion: new Date(), ultimaIp: ip(req) });
    const token = crearSesion({ type: 'platform', platformAdminId: admin.id, rol: admin.rol });
    setAuthCookie(res, token);

    log.info('backoffice', 'acceso concedido', { admin: admin.id, rol: admin.rol, ip: mask.ip(ip(req)) });
    res.json({ admin: sanitize(admin) });
  } catch (e) { next(e); }
};

const logout = async (_req, res) => { clearAuthCookie(res); res.json({ ok: true }); };

const yo = async (req, res, next) => {
  try {
    const admin = await PlatformAdmin.findByPk(req.auth.platformAdminId);
    if (!admin) return res.status(401).json({ message: 'Sesión inválida.' });
    res.json({ admin: sanitize(admin) });
  } catch (e) { next(e); }
};

/*
 * POST /api/backoffice/totp/activar  { token, codigo }
 *
 * Activación del segundo factor, una sola vez por cuenta. Se autoriza con el
 * token de alta que imprime scripts/crear-superuser.js, no con la sesión:
 * antes de activarlo no hay sesión posible.
 */
const activarTotp = async (req, res, next) => {
  try {
    const { token, codigo } = req.body || {};
    const esperado = process.env.BACKOFFICE_SETUP_TOKEN;
    if (!esperado || String(token || '') !== esperado) {
      return res.status(401).json({ message: 'Token de activación inválido.' });
    }

    const admin = await PlatformAdmin.findOne({
      where: { email: String(req.body?.email || '').trim().toLowerCase() },
    });
    if (!admin) return res.status(404).json({ message: 'No existe esa cuenta.' });
    if (admin.totpActivadoEn) {
      return res.status(409).json({ message: 'El segundo factor ya está activo en esta cuenta.' });
    }
    if (!admin.totpSecret) return res.status(409).json({ message: 'La cuenta no tiene secreto cargado.' });

    // Se exige un código válido antes de dar por activado: si el secreto quedó
    // mal cargado en el teléfono, activarlo dejaría la cuenta sin acceso.
    if (!totp.validar(admin.totpSecret, codigo)) {
      return res.status(400).json({ message: 'El código no coincide. Revisá la hora del teléfono y probá con el siguiente.' });
    }

    await admin.update({ totpActivadoEn: new Date() });
    res.json({ message: 'Segundo factor activado. Ya podés entrar al backoffice.' });
  } catch (e) { next(e); }
};

// ── Cuentas de clientes ──────────────────────────────────────────

// GET /api/backoffice/cuentas?buscar=&estado=
const listarCuentas = async (req, res, next) => {
  try {
    const where = {};
    const buscar = String(req.query.buscar || '').trim();
    if (buscar) {
      where[Op.or] = [
        { nombreNegocio: { [Op.like]: `%${buscar}%` } },
        { email:         { [Op.like]: `%${buscar}%` } },
        { cuit:          { [Op.like]: `%${buscar}%` } },
      ];
    }

    const negocios = await Business.findAll({
      where,
      attributes: ['id', 'nombreNegocio', 'email', 'cuit', 'ownerNombre', 'ownerApellido', 'createdAt'],
      order: [['createdAt', 'DESC']],
      limit: Math.min(Number(req.query.limit) || 100, 300),
    });

    const cuentas = [];
    for (const n of negocios) {
      const estado = await planService.estadoDe(n.id);
      if (req.query.estado && estado.estado !== req.query.estado) continue;
      cuentas.push({
        ...n.toJSON(),
        plan: estado.plan?.codigo || null,
        planNombre: estado.plan?.nombre || null,
        estado: estado.estado,
        vence: estado.vence,
        diasRestantes: estado.diasRestantes,
        precio: estado.precio,
        descuentoPct: estado.descuentoPct,
        renovacionAutomatica: estado.renovacionAutomatica,
        bajaSolicitadaEn: estado.bajaSolicitadaEn,
      });
    }

    res.json({ total: cuentas.length, cuentas });
  } catch (e) { next(e); }
};

// GET /api/backoffice/cuentas/:id — ficha completa
const verCuenta = async (req, res, next) => {
  try {
    const negocio = await Business.findByPk(req.params.id, { attributes: { exclude: ['passwordHash'] } });
    if (!negocio) return res.status(404).json({ message: 'No existe esa cuenta.' });

    const [estado, uso, pagos, cuits, empleados, ventas] = await Promise.all([
      planService.estadoDe(negocio.id),
      planService.usoDe(negocio.id),
      // Con el plan de cada pago: quien acredita tiene que ver qué plan se va a
      // aplicar, no sólo el importe.
      SubscriptionPayment.findAll({
        where: { businessId: negocio.id },
        include: [{ model: Plan, as: 'plan', attributes: ['codigo', 'nombre', 'orden'] }],
        order: [['fecha', 'DESC']], limit: 30,
      }),
      BusinessCuit.count({ where: { businessId: negocio.id } }),
      Employee.count({ where: { businessId: negocio.id, activo: true } }),
      Sale.count({ where: { businessId: negocio.id } }),
    ]);

    /*
     * Lo que corresponde HOY a cada cobro pendiente, para que quien acredita
     * una transferencia vea al lado del importe cuánto tendría que haber
     * entrado (el plan entero, o la diferencia por los días que quedan) y no
     * descubra la diferencia recién al tocar "Acreditar".
     */
    const planes = new Map((await Plan.findAll()).map((p) => [p.id, p]));
    const pagosVista = pagos.map((p) => {
      const j = p.toJSON();
      if (j.estado === 'pendiente') Object.assign(j, { corresponde: cotizacionDeFila(estado, planes, j) });
      return j;
    });

    res.json({
      negocio,
      suscripcion: {
        estado: estado.estado, plan: estado.plan?.codigo, planNombre: estado.plan?.nombre,
        planOrden: estado.plan?.orden ?? null,
        planPendiente: estado.planPendiente?.codigo || null,
        planPendienteNombre: estado.planPendiente?.nombre || null,
        planPendienteDesde: estado.planPendienteDesde,
        vence: estado.vence, diasRestantes: estado.diasRestantes,
        precio: estado.precio, precioLista: estado.precioLista,
        descuentoPct: estado.descuentoPct, descuentoNota: estado.suscripcion.descuentoNota,
        precioAcordado: estado.suscripcion.precioAcordado,
        renovacionAutomatica: estado.renovacionAutomatica,
        metodoPago: estado.suscripcion.metodoPago,
        bajaSolicitadaEn: estado.bajaSolicitadaEn,
        bajaMotivo: estado.suscripcion.bajaMotivo,
        notas: estado.suscripcion.notas,
        // El débito automático y si Mercado Pago tiene el monto que corresponde.
        debito: planService.debitoActivo(estado.suscripcion)
          ? {
              activo: true,
              monto: estado.suscripcion.debitoMonto != null ? Number(estado.suscripcion.debitoMonto) : null,
              pendienteDesde: estado.suscripcion.debitoPendienteDesde,
            }
          : { activo: false },
      },
      uso, pagos: pagosVista,
      actividad: { cuits, empleados, ventas },
    });
  } catch (e) { next(e); }
};

/*
 * Lo que corresponde cobrar HOY por una fila de pago, con la misma cuenta que
 * ve el cliente antes de pagar (planService.clasificarCambio). `esperado` null
 * = no se puede aplicar como cambio de plan (ya hay otra bajada programada).
 *
 * Una fila sin plan (de antes de que los pagos lo llevaran) renueva el plan con
 * el que la cuenta sigue.
 */
function cotizar({ sub, actual, pendiente, pendienteDesde, nuevo, ahora = new Date() }) {
  if (!nuevo) {
    const continua = pendiente || actual;
    return { esperado: planService.precioPara(sub, continua), concepto: 'periodo', tipo: 'renovacion', plan: continua };
  }
  const c = planService.clasificarCambio({ sub, actual, pendiente, pendienteDesde, nuevo, ahora });
  if (c.tipo === 'cambio_pendiente') return { esperado: null, concepto: 'periodo', tipo: c.tipo, plan: nuevo, pendiente };
  const dias = c.tramos.reduce((a, t) => a + t.dias, 0);
  return { esperado: planService.montoDe(c), concepto: c.concepto, tipo: c.tipo, plan: nuevo, dias };
}

/** Para la ficha: a partir del estado ya resuelto y los planes en memoria. */
function cotizacionDeFila(estado, planes, fila) {
  const r = cotizar({
    sub: estado.suscripcion, actual: estado.plan, pendiente: estado.planPendiente,
    pendienteDesde: estado.planPendienteDesde, nuevo: fila.planId ? planes.get(fila.planId) : null,
  });
  return { esperado: r.esperado, concepto: r.concepto, tipo: r.tipo, dias: r.dias ?? null };
}

/** Al acreditar: sobre la suscripción TRABADA, con lo que ya tenía que regir aplicado. */
async function cotizacionDelPago(sub, pago, t, ahora = new Date()) {
  let vigenteId = sub.planId;
  let pendienteId = sub.planPendienteId || null;
  let pendienteDesde = pendienteId ? sub.planPendienteDesde : null;
  if (pendienteId && pendienteDesde && new Date(pendienteDesde) <= ahora) {
    vigenteId = pendienteId; pendienteId = null; pendienteDesde = null;
  }
  const [actual, pendiente, nuevo] = await Promise.all([
    Plan.findByPk(vigenteId, { transaction: t }),
    pendienteId ? Plan.findByPk(pendienteId, { transaction: t }) : null,
    pago.planId ? Plan.findByPk(pago.planId, { transaction: t }) : null,
  ]);
  return cotizar({ sub, actual, pendiente, pendienteDesde, nuevo, ahora });
}

const pesos = (n) => `$${Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 2 })}`;

/*
 * PUT /api/backoffice/cuentas/:id/suscripcion
 *
 * Cambio de plan, descuento, precio cerrado y extensión de período. Es la
 * herramienta comercial: cotizar un Enterprise, dar tres meses bonificados,
 * destrabar una cuenta cuya transferencia todavía no se acreditó.
 */
const editarSuscripcion = async (req, res, next) => {
  if (!puede(req.admin, 'owner')) {
    return res.status(403).json({ message: 'Sólo un responsable comercial puede cambiar planes y precios.' });
  }

  /*
   * En una transacción con la suscripción trabada, como los pagos: extender
   * días mientras se acredita un pago leía el mismo vencimiento que el pago y
   * uno de los dos se perdía.
   */
  const t = await sequelize.transaction();
  try {
    const { suscripcion } = await planService.estadoDe(req.params.id);
    await planService.trabarSuscripcion(suscripcion.id, t);
    const patch = {};
    let planManual = null;

    if (req.body?.plan) {
      const plan = await Plan.findOne({ where: { codigo: req.body.plan }, transaction: t });
      if (!plan) { await t.rollback(); return res.status(400).json({ message: 'Ese plan no existe.' }); }
      planManual = plan;
      patch.planId = plan.id;
      // El plan que pone una persona manda: una bajada que el cliente había
      // dejado programada no puede pisarlo semanas después.
      patch.planPendienteId = null;
      patch.planPendienteDesde = null;
    }
    if (req.body?.descuentoPct !== undefined) {
      const pct = Number(req.body.descuentoPct);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        await t.rollback();
        return res.status(400).json({ message: 'El descuento tiene que estar entre 0 y 100.' });
      }
      patch.descuentoPct = Math.round(pct * 100) / 100;
      patch.descuentoNota = req.body?.descuentoNota || null;
    }
    if (req.body?.precioAcordado !== undefined) {
      patch.precioAcordado = req.body.precioAcordado === null ? null : Number(req.body.precioAcordado);
    }
    if (req.body?.estado) patch.estado = req.body.estado;
    if (req.body?.notas !== undefined) patch.notas = req.body.notas || null;

    // Extender el período sin cobrar: sirve para una cortesía o para cubrir
    // los días que tardó en acreditarse una transferencia. Sin plan: una
    // cortesía extiende, no cambia de plan.
    if (req.body?.extenderDias) {
      const dias = Number(req.body.extenderDias);
      if (!Number.isFinite(dias) || dias <= 0 || dias > 365) {
        await t.rollback();
        return res.status(400).json({ message: 'Los días a extender tienen que ir de 1 a 365.' });
      }
      await planService.acreditarPago({ subscription: suscripcion, dias }, t);
    }

    if (patch.planPendienteId === null) patch.planPendienteSuspender = null;
    if (Object.keys(patch).length) {
      await Subscription.update(patch, { where: { id: suscripcion.id }, transaction: t });
    }
    /*
     * Un plan puesto a mano rige en el acto: los empleados se acomodan a su
     * tope ya. Si es más chico, nadie eligió quiénes siguen (lo hizo un
     * operador), así que quedan los de actividad más reciente: ver
     * planService.ajustarEmpleados. Si es más grande, vuelven los suspendidos.
     */
    if (planManual) {
      await planService.ajustarEmpleados(suscripcion.businessId, planManual, { transaction: t });
    }
    await t.commit();
    log.info('backoffice', 'suscripción editada', { negocio: req.params.id, admin: req.admin.id });

    // Cambió lo que se cobra todos los meses: el débito automático se pone en
    // el precio nuevo (decisión 20). Corre después del commit y no tira.
    if ((planManual || patch.descuentoPct !== undefined || patch.precioAcordado !== undefined) &&
        planService.debitoActivo(suscripcion)) {
      await planService.programarSincronizacion(suscripcion.id);
    }

    const actualizado = await planService.estadoDe(req.params.id);
    res.json({ estado: actualizado.estado, plan: actualizado.plan?.codigo, precio: actualizado.precio, vence: actualizado.vence });
  } catch (e) { await t.rollback().catch(() => {}); next(e); }
};

/*
 * POST /api/backoffice/pagos/:id/aprobar  { montoRecibido?, aceptarDiferencia? }
 *
 * Acredita una transferencia después de verla en el extracto. Es el paso que
 * a propósito no es automático: el sistema no puede saber si la plata llegó.
 *
 * Y antes de aplicar el plan se compara lo que entró (`montoRecibido`, lo que
 * el operador ve en el banco; si no lo manda, el importe de la fila) con lo que
 * corresponde HOY a ese plan para esta cuenta: el plan entero o, al subir con un
 * período pago corriendo, la diferencia por los días que quedan —la misma cuenta
 * que vio el cliente al pagar—. Si entró menos, no se acredita nada: vuelve un
 * 409 con los dos números y el operador decide si lo acredita igual
 * (`aceptarDiferencia: true`, queda anotado quién) o lo rechaza. Antes el plan
 * del pago se aplicaba sin mirar el importe: una transferencia del Superior por
 * el precio del Inicial dejaba la cuenta en el Superior.
 */
const aprobarPago = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    if (!puede(req.admin, 'owner')) {
      await t.rollback();
      return res.status(403).json({ message: 'Sólo un responsable comercial puede acreditar pagos.' });
    }

    const visto = await SubscriptionPayment.findByPk(req.params.id, { transaction: t });
    if (!visto) { await t.rollback(); return res.status(404).json({ message: 'No existe ese pago.' }); }

    /*
     * Primero la suscripción y después el pago, trabados, y el estado del pago
     * se mira DESPUÉS de trabar. Dos clics seguidos en "Acreditar" (o dos
     * operadores a la vez) veían los dos "pendiente" y sumaban dos meses por
     * una transferencia. El orden es el mismo que usa Mercado Pago —primero
     * la suscripción— para que dos acreditaciones no se esperen en cruz.
     */
    const sub = await planService.trabarSuscripcion(visto.subscriptionId, t);
    const pago = await SubscriptionPayment.findByPk(visto.id, planService.trabada(t));
    if (pago.estado === 'aprobado') {
      await t.rollback();
      return res.status(409).json({ message: 'Ese pago ya estaba acreditado.' });
    }

    const bruto = req.body?.montoRecibido;
    const recibido = bruto != null && bruto !== '' ? Number(bruto) : Number(pago.monto);
    if (!Number.isFinite(recibido) || recibido < 0) {
      await t.rollback();
      return res.status(400).json({ message: 'El importe recibido no es válido.' });
    }
    const aceptar = req.body?.aceptarDiferencia === true;

    const cot = await cotizacionDelPago(sub, pago, t);
    const falta = cot.esperado == null || recibido + planService.TOLERANCIA < cot.esperado;
    if (falta && !aceptar) {
      await t.rollback();
      return res.status(409).json({
        motivo: 'monto_no_coincide',
        esperado: cot.esperado, recibido, concepto: cot.concepto, tipo: cot.tipo,
        plan: cot.plan && { codigo: cot.plan.codigo, nombre: cot.plan.nombre },
        message: cot.esperado == null
          ? `La cuenta ya tiene programado el paso al ${cot.pendiente?.nombre}: este pago del ` +
            `${cot.plan?.nombre} no se puede aplicar como cambio de plan. Si lo acreditás igual, se ` +
            'convierte en días del plan con el que sigue.'
          : `Entraron ${pesos(recibido)} y para el ${cot.plan?.nombre || 'plan'} corresponde ` +
            `${pesos(cot.esperado)} (${cot.concepto === 'diferencia'
              ? `la diferencia por ${cot.dias} día${cot.dias === 1 ? '' : 's'}`
              : 'el plan entero'}). Si igual querés acreditarlo, confirmalo; si no, rechazalo.`,
      });
    }

    // El plan es el que figura en el pago: el que eligió el cliente al pagar.
    const periodo = await planService.acreditarPago({
      subscription: sub,
      planId: pago.planId,
      concepto: cot.concepto,
      // Siempre lo que entró: si el pago no puede cambiar el plan y se vuelve
      // días, son los días de esa plata (ver acreditarPago).
      monto: recibido,
      aceptado: aceptar,
      empleadosSuspender: planService.leerLista(pago.empleadosSuspender) ?? undefined,
    }, t);
    const { desde, hasta } = periodo;
    const revisar = falta
      ? `Acreditado con ${pesos(recibido)} contra ${cot.esperado == null ? 'un cambio que no se podía aplicar' : pesos(cot.esperado)}: lo aceptó ${req.admin.email}.`
      : periodo.revisar;
    await pago.update({
      estado: 'aprobado',
      monto: recibido,
      montoCotizado: pago.montoCotizado ?? pago.monto,
      aRevisar: revisar ? revisar.slice(0, 300) : null,
      periodoDesde: desde, periodoHasta: hasta,
      verificadoPor: req.admin.email, verificadoEn: new Date(),
    }, { transaction: t });

    await t.commit();
    log.info('backoffice', 'pago acreditado a mano', { pago: pago.id, admin: req.admin.id, conDiferencia: falta });

    // Para que quien acreditó vea qué pasó con el plan, no sólo hasta cuándo.
    const [vigente, pendiente] = await Promise.all([
      Plan.findByPk(periodo.planId, { attributes: ['codigo', 'nombre'] }),
      periodo.planPendienteId ? Plan.findByPk(periodo.planPendienteId, { attributes: ['codigo', 'nombre'] }) : null,
    ]);
    res.json({
      pago,
      periodo: { desde, hasta },
      esperado: cot.esperado,
      recibido,
      revisar,
      plan: {
        cambio: periodo.cambio,
        vigente: vigente && { codigo: vigente.codigo, nombre: vigente.nombre },
        pendiente: pendiente && { codigo: pendiente.codigo, nombre: pendiente.nombre, desde: periodo.planPendienteDesde },
      },
    });
  } catch (e) { await t.rollback().catch(() => {}); next(e); }
};

// POST /api/backoffice/pagos/:id/rechazar
const rechazarPago = async (req, res, next) => {
  try {
    if (!puede(req.admin, 'owner')) return res.status(403).json({ message: 'No autorizado.' });
    const pago = await SubscriptionPayment.findByPk(req.params.id);
    if (!pago) return res.status(404).json({ message: 'No existe ese pago.' });
    await pago.update({
      estado: 'rechazado',
      detalle: req.body?.motivo || pago.detalle,
      verificadoPor: req.admin.email, verificadoEn: new Date(),
    });
    res.json(pago);
  } catch (e) { next(e); }
};

// ── Planes ───────────────────────────────────────────────────────

const listarPlanes = async (_req, res, next) => {
  try {
    res.json(await Plan.findAll({ order: [['orden', 'ASC']] }));
  } catch (e) { next(e); }
};

/*
 * GET /api/backoffice/planes/catalogo
 *
 * Qué funciones existen. El backoffice lo pide para armar las casillas en vez
 * de tenerlas escritas: la lista de acá se quedó en nueve cuando ya eran doce,
 * y un operador no podía ver ni tocar las tres que faltaban.
 */
const catalogoDeFeatures = async (_req, res, next) => {
  try { res.json(CATALOGO_FEATURES); } catch (e) { next(e); }
};

/*
 * PUT /api/backoffice/planes/:codigo
 *
 * Editar un plan lo marca como tocado a mano: a partir de ahí la semilla de
 * config/planes.js deja de sincronizarlo, para que un deploy no revierta un
 * precio que alguien cambió a propósito.
 */
const editarPlan = async (req, res, next) => {
  try {
    if (!puede(req.admin, 'owner')) return res.status(403).json({ message: 'No autorizado.' });

    const plan = await Plan.findOne({ where: { codigo: req.params.codigo } });
    if (!plan) return res.status(404).json({ message: 'Ese plan no existe.' });

    const patch = {};
    for (const campo of ['nombre', 'descripcion', 'soporte']) {
      if (req.body?.[campo] !== undefined) patch[campo] = req.body[campo];
    }
    if (req.body?.precioMensual !== undefined) {
      patch.precioMensual = req.body.precioMensual === null ? null : Number(req.body.precioMensual);
      if (patch.precioMensual !== null && (!Number.isFinite(patch.precioMensual) || patch.precioMensual < 0)) {
        return res.status(400).json({ message: 'El precio no puede ser negativo.' });
      }
    }
    /*
     * Los CINCO topes, no tres.
     *
     * Faltaban maxSkus y maxComprobantes: se mostraban en la pantalla del
     * cliente y en la del backoffice, pero no había forma de cambiarlos sin
     * entrar a la base. Cotizarle un tope distinto a un cliente es
     * exactamente para lo que existe esta pantalla.
     */
    for (const tope of ['maxCuits', 'maxEmpleados', 'maxLocales', 'maxSkus', 'maxComprobantes']) {
      if (req.body?.[tope] !== undefined) {
        patch[tope] = req.body[tope] === null ? null : Math.max(0, Number(req.body[tope]) || 0);
      }
    }
    /*
     * Las sesiones del dueño, aparte: acá cero no es un tope posible.
     *
     * Con los otros topes, cero quiere decir "ninguno" y se puede querer. Con
     * las sesiones, cero haría que cada ingreso cierre todas las demás —el
     * dueño echándose a sí mismo de su otra computadora en cada login—, y un
     * campo vacío que se guardara como cero haría eso sin que nadie lo
     * decidiera. Entero desde 1, o null para sin tope.
     */
    if (req.body?.maxSesiones !== undefined) {
      const valor = req.body.maxSesiones;
      if (valor === null || valor === '') {
        patch.maxSesiones = null;
      } else {
        const n = Number(valor);
        if (!Number.isInteger(n) || n < 1) {
          return res.status(400).json({ message: 'Las sesiones del dueño van de 1 en adelante, o vacío para sin tope.' });
        }
        patch.maxSesiones = n;
      }
    }

    /*
     * Las funciones se validan contra el catálogo, y se mezclan.
     *
     * Antes esto era `patch.features = req.body.features` sin mirar nada.
     * Dos problemas reales: una clave mal escrita entraba y quedaba ahí para
     * siempre sin que ninguna ruta la mirara —un plan que dice tener algo que
     * no existe—, y un cuerpo parcial borraba en silencio todo lo que no
     * nombrara. Justamente lo que iba a pasar con Eventos, Depósito y
     * Reposición el día que alguien guardara desde la pantalla vieja.
     *
     * Se mezcla sobre lo que el plan ya tiene: así un pedido que nombra una
     * sola función cambia esa y nada más.
     */
    if (req.body?.features !== undefined) {
      const entrada = req.body.features;
      if (typeof entrada !== 'object' || entrada === null || Array.isArray(entrada)) {
        return res.status(400).json({ message: 'Las funciones tienen que venir como un objeto.' });
      }
      const validas = new Set(CATALOGO_FEATURES.map((f) => f.clave));
      const desconocidas = Object.keys(entrada).filter((k) => !validas.has(k));
      if (desconocidas.length) {
        return res.status(400).json({
          message: `Estas funciones no existen: ${desconocidas.join(', ')}.`,
          desconocidas,
        });
      }
      const actuales = typeof plan.features === 'string'
        ? JSON.parse(plan.features || '{}')
        : (plan.features || {});
      const merge = { ...actuales };
      for (const [clave, valor] of Object.entries(entrada)) merge[clave] = Boolean(valor);
      patch.features = merge;
    }
    if (req.body?.activo !== undefined) patch.activo = Boolean(req.body.activo);
    if (req.body?.orden !== undefined) patch.orden = Number(req.body.orden) || 0;

    patch.editadoEn = new Date();
    await plan.update(patch);
    log.info('backoffice', 'plan editado', { plan: plan.codigo, admin: req.admin.id });
    res.json(plan);
  } catch (e) { next(e); }
};

// ── Página pública ───────────────────────────────────────────────

/*
 * Parámetros que la página pública lee al cargar. Se guardan en la base para
 * que cambiar un teléfono o el dólar no sea un deploy.
 */
const CLAVES_PUBLICAS = {
  contactoEmail:    'Email de contacto de la página',
  contactoWhatsapp: 'WhatsApp de contacto, sólo dígitos con código de país',
  contactoTelefono: 'Teléfono de contacto, como se muestra',
  cotizacionUsd:    'Pesos por dólar, para mostrar los precios en USD',
  urlSistema:       'A dónde lleva el botón «Entrar» de la página pública',
};

/** URL pública de la landing, para poder abrirla desde el panel. */
function urlPaginaPublica() {
  const bruto = (process.env.LANDING_DOMAIN || '').trim().replace(/\/+$/, '');
  if (!bruto) return null;
  return /^https?:\/\//i.test(bruto) ? bruto : `https://${bruto}`;
}

const getAjustes = async (_req, res, next) => {
  try {
    const filas = await PlatformSetting.findAll();
    const valores = Object.fromEntries(filas.map((f) => [f.clave, f.valor]));
    res.json({
      claves: Object.entries(CLAVES_PUBLICAS).map(([clave, descripcion]) => ({
        clave, descripcion, valor: valores[clave] ?? null,
      })),
      // Sale de LANDING_DOMAIN y no del código: el dominio cambia y el panel no
      // tiene por qué tener uno escrito a mano que después quede viejo.
      paginaPublica: urlPaginaPublica(),
    });
  } catch (e) { next(e); }
};

const editarAjustes = async (req, res, next) => {
  try {
    if (!puede(req.admin, 'owner')) return res.status(403).json({ message: 'No autorizado.' });

    const cambios = req.body || {};
    for (const [clave, valor] of Object.entries(cambios)) {
      // Lista blanca: cualquier clave suelta terminaría en la página pública.
      if (!(clave in CLAVES_PUBLICAS)) continue;
      await PlatformSetting.upsert({
        clave,
        valor: valor === null || valor === '' ? null : String(valor).slice(0, 500),
        descripcion: CLAVES_PUBLICAS[clave],
        actualizadoPor: req.admin.email,
      });
    }
    log.info('backoffice', 'ajustes de la página pública actualizados', { admin: req.admin.id });
    res.json({ ok: true });
  } catch (e) { next(e); }
};

/*
 * GET /api/backoffice/mercadopago
 *
 * Estado de la pasarela de cobro. No devuelve el token ni el secreto: sólo si
 * están, si Mercado Pago los acepta, y qué falta. Es lo que convierte "no me
 * anda el pago" en un dato concreto.
 */
const estadoMercadoPago = async (req, res, next) => {
  try {
    if (!puede(req.admin, 'owner')) return res.status(403).json({ message: 'No autorizado.' });
    res.json(await mp.diagnostico());
  } catch (e) { next(e); }
};

/*
 * GET /api/backoffice/seguridad
 *
 * Estado de las defensas de borde y los intentos fallidos recientes.
 *
 * No devuelve las IPs de la lista blanca: aunque el panel sea interno, la IP del
 * operador no necesita salir de la variable de entorno para que se vea si la
 * restricción está puesta. Sí devuelve las de los intentos FALLIDOS, que es
 * justamente lo que hay que poder mirar.
 */
const estadoSeguridad = async (req, res, next) => {
  try {
    if (!puede(req.admin, 'owner')) return res.status(403).json({ message: 'No autorizado.' });

    const { estado: estadoIps, VARIABLE } = require('../middleware/ipAllowlist');
    const { AuthAttempt } = require('../models');
    const bloqueo = require('../services/bloqueoService');

    const desde = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const fallos = await AuthAttempt.findAll({
      where: { exito: false, fecha: { [Op.gte]: desde } },
      order: [['fecha', 'DESC']],
      limit: 200,
    });

    /*
     * Agrupado por IP. Una lista de intentos suelta no dice nada: lo que
     * importa es quién insiste, contra cuántas cuentas y desde cuándo.
     */
    const porIp = new Map();
    for (const f of fallos) {
      const clave = f.ip || 'sin ip';
      if (!porIp.has(clave)) {
        porIp.set(clave, { ip: clave, intentos: 0, ultimo: f.fecha, cuentas: new Set(), tipos: new Set() });
      }
      const fila = porIp.get(clave);
      fila.intentos++;
      if (f.identificador) fila.cuentas.add(f.identificador);
      fila.tipos.add(f.tipo);
    }

    res.json({
      backofficePorIp: { ...estadoIps(), variable: VARIABLE },
      bloqueo: {
        ventanaMin: bloqueo.VENTANA_MIN,
        topePorIp: bloqueo.TOPE_POR_IP,
        topePorCuenta: bloqueo.TOPE_POR_CUENTA,
      },
      fallosUltimasHoras: fallos.length,
      sospechosos: [...porIp.values()]
        .map((x) => ({
          ip: x.ip, intentos: x.intentos, ultimo: x.ultimo,
          cuentas: x.cuentas.size, tipos: [...x.tipos],
          // Ya pasó el tope: está bloqueada ahora mismo o lo estuvo hace poco.
          bloqueada: x.intentos >= bloqueo.TOPE_POR_IP,
        }))
        .sort((a, b) => b.intentos - a.intentos)
        .slice(0, 20),
    });
  } catch (e) { next(e); }
};

// ── Resumen ──────────────────────────────────────────────────────

const resumen = async (_req, res, next) => {
  try {
    const negocios = await Business.count();
    const subs = await Subscription.findAll({ include: [{ model: Plan, as: 'plan' }] });

    const porEstado = {};
    const porPlan = {};
    let facturacionMensual = 0;

    for (const s of subs) {
      const estado = await planService.estadoDe(s.businessId);
      porEstado[estado.estado] = (porEstado[estado.estado] || 0) + 1;
      const codigo = estado.plan?.codigo || 'sin-plan';
      porPlan[codigo] = (porPlan[codigo] || 0) + 1;
      // Sólo lo que se cobra de verdad: una prueba no es ingreso.
      if (estado.estado === 'activa' && estado.precio) facturacionMensual += estado.precio;
    }

    const pendientes = await SubscriptionPayment.count({ where: { estado: 'pendiente', metodo: 'transferencia' } });
    const bajas = await Subscription.count({ where: { bajaSolicitadaEn: { [Op.ne]: null } } });

    res.json({
      negocios, porEstado, porPlan,
      facturacionMensual: Math.round(facturacionMensual * 100) / 100,
      transferenciasPorAprobar: pendientes,
      bajasPendientes: bajas,
    });
  } catch (e) { next(e); }
};

/*
 * GET /api/backoffice/arca/delegaciones
 *
 * Los CUIT de clientes esperando que alguien de Stocker haga el trámite en
 * AFIP. Es la otra mitad del aviso por mail: el mail avisa cuando aparece uno,
 * esta lista dice cuáles siguen abiertos.
 *
 * Hace falta que sea una lista y no sólo el mail. Un mail se lee una vez, se
 * pospone y se pierde entre los otros; el trámite queda sin hacer y el cliente
 * queda sin poder facturar sin que nadie lo sepa. Acá se ve cuántos hay y hace
 * cuánto esperan, que es lo que convierte "me llegó un mail" en una cola.
 */
/*
 * POST /api/backoffice/arca/delegaciones/sincronizar
 *
 * Para el operador: después de aceptar las designaciones en AFIP y asignarles
 * el certificado, esto vuelve a leer qué reconoce AFIP y activa las cuentas
 * que quedaron listas. Sin esto habría que esperar al barrido o pedirle al
 * cliente que apriete "Verificar".
 */
/*
 * ══ Credenciales de integración ══════════════════════════════════
 *
 * Las emite Stocker, no el cliente: el que conecta el portal mayorista de un
 * negocio es el equipo de acá, en el mismo momento en que lo da de alta. El
 * dueño tiene la suya en su panel, pero hasta que el puente funciona no hay
 * nada que él pueda hacer solo.
 *
 * El token se muestra UNA vez, al emitirlo, y después ya no existe en ningún
 * lado que se pueda leer: lo que queda son los últimos seis caracteres, para
 * poder decir "es el que termina en 9f2c" sin poder reconstruirlo.
 */
const listarIntegraciones = async (req, res, next) => {
  try {
    const { IntegracionExterna, SolicitudMayorista } = require('../models');
    const filas = await IntegracionExterna.findAll({
      attributes: ['id', 'businessId', 'origen', 'nombre', 'pista', 'activa', 'ultimoUsoEn', 'createdAt'],
      order: [['activa', 'DESC'], ['id', 'DESC']],
      limit: Math.min(Number(req.query.limit) || 200, 500),
    });

    const negocios = await Business.findAll({
      where: { id: [...new Set(filas.map((f) => f.businessId))] },
      attributes: ['id', 'nombreNegocio', 'email'],
    });
    const porNegocio = new Map(negocios.map((n) => [n.id, n]));

    /*
     * Cuántos pedidos están esperando revisión de cada negocio.
     *
     * Es el dato que dice si el puente sirve de algo: una credencial que se usa
     * todos los días y veinte solicitudes sin mirar es un problema del cliente,
     * no de la conexión, y desde acá se puede levantar el teléfono.
     */
    const pendientes = await SolicitudMayorista.findAll({
      where: { estado: 'pendiente' },
      attributes: ['businessId'],
    });
    const porNegocioPendientes = new Map();
    for (const p of pendientes) {
      porNegocioPendientes.set(p.businessId, (porNegocioPendientes.get(p.businessId) || 0) + 1);
    }

    res.json({
      integraciones: filas.map((f) => ({
        ...f.toJSON(),
        negocio: porNegocio.get(f.businessId)
          ? {
            id: f.businessId,
            nombre: porNegocio.get(f.businessId).nombreNegocio,
            email: porNegocio.get(f.businessId).email,
          }
          : { id: f.businessId, nombre: '(negocio borrado)', email: null },
        pedidosPorRevisar: porNegocioPendientes.get(f.businessId) || 0,
      })),
    });
  } catch (e) { next(e); }
};

/*
 * Emite una credencial para un negocio. Devuelve el token una sola vez.
 *
 * Emitir apaga la anterior del mismo origen, así que el aviso va en la
 * respuesta: quien lo hizo tiene que saber que el portal dejó de poder mandar
 * pedidos hasta que cargue la nueva.
 */
const emitirIntegracion = async (req, res, next) => {
  try {
    const integraciones = require('../services/integracionesService');
    const businessId = Number(req.body?.businessId);
    if (!businessId) throw Object.assign(new Error('Elegí para qué negocio es.'), { status: 400 });

    const negocio = await Business.findByPk(businessId, { attributes: ['id', 'nombreNegocio'] });
    if (!negocio) throw Object.assign(new Error('Ese negocio no existe.'), { status: 404 });

    const origen = String(req.body?.origen || 'isuwaya').toLowerCase();
    const habia = await require('../models').IntegracionExterna.findOne({
      where: { businessId, origen, activa: true },
    });

    const { token, integracion } = await integraciones.emitir({
      businessId, origen, nombre: req.body?.nombre || null,
    });

    res.status(201).json({
      token,
      reemplaza: habia ? { pista: habia.pista, ultimoUsoEn: habia.ultimoUsoEn } : null,
      integracion: {
        id: integracion.id, origen: integracion.origen, nombre: integracion.nombre,
        pista: integracion.pista, activa: integracion.activa,
        negocio: { id: negocio.id, nombre: negocio.nombreNegocio },
      },
    });
  } catch (e) { next(e); }
};

/** Corta el puente. La fila queda: sirve para saber qué hubo. */
const revocarIntegracion = async (req, res, next) => {
  try {
    const { IntegracionExterna } = require('../models');
    const fila = await IntegracionExterna.findByPk(Number(req.params.id));
    if (!fila) throw Object.assign(new Error('Esa credencial no existe.'), { status: 404 });
    await fila.update({ activa: false });
    res.json({ ok: true });
  } catch (e) { next(e); }
};

const sincronizarDelegacionesArca = async (req, res, next) => {
  try {
    const arca = require('../services/arcaService');
    res.json({ ok: true, resultado: await arca.sincronizarTodasLasDelegaciones() });
  } catch (e) { next(e); }
};

const delegacionesArca = async (req, res, next) => {
  try {
    const configs = await BusinessArcaConfig.findAll({
      where: { delegacionVerificada: false },
      order: [['ultimaVerificacion', 'DESC']],
      limit: Math.min(Number(req.query.limit) || 100, 300),
    });
    if (!configs.length) return res.json({ pendientes: [] });

    /*
     * Los negocios y los CUIT en dos consultas y no una por fila: son pocas
     * filas hoy, pero esta pantalla se mira entera cada vez y no hay razón
     * para que crezca de a una consulta por cliente.
     */
    const [cuits, negocios] = await Promise.all([
      BusinessCuit.findAll({
        where: { id: configs.map((c) => c.businessCuitId) },
        attributes: ['id', 'cuit', 'nombre', 'condicionIva'],
      }),
      Business.findAll({
        where: { id: configs.map((c) => c.businessId) },
        attributes: ['id', 'nombreNegocio', 'email', 'cuit'],
      }),
    ]);
    const porCuit = new Map(cuits.map((c) => [c.id, c]));
    const porNegocio = new Map(negocios.map((n) => [n.id, n]));

    const dias = (f) => (f ? Math.floor((Date.now() - new Date(f).getTime()) / 86400000) : null);

    res.json({
      pendientes: configs.map((c) => {
        const cu = porCuit.get(c.businessCuitId);
        const ne = porNegocio.get(c.businessId);
        return {
          configId: c.id,
          negocio: ne ? { id: ne.id, nombre: ne.nombreNegocio, email: ne.email } : null,
          cuit: cu?.cuit || null,
          nombreFiscal: cu?.nombre || null,
          ambiente: c.ambiente,
          ultimaVerificacion: c.ultimaVerificacion,
          ultimoError: c.ultimoError,
          avisadoEn: c.delegacionAvisadaEn,
          // Hace cuánto que el cliente lo intenta. Es lo que ordena la cola por
          // urgencia real y no por orden de llegada del mail.
          diasEsperando: dias(c.ultimaVerificacion),
        };
      }),
    });
  } catch (e) { next(e); }
};

module.exports = {
  login, logout, yo, activarTotp,
  delegacionesArca,
  listarCuentas, verCuenta, editarSuscripcion,
  aprobarPago, rechazarPago,
  listarPlanes, catalogoDeFeatures, editarPlan,
  getAjustes, editarAjustes, resumen, estadoMercadoPago, estadoSeguridad,
  CLAVES_PUBLICAS, sincronizarDelegacionesArca,
  listarIntegraciones, emitirIntegracion, revocarIntegracion };
