const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const sequelize = require('../config/database');
const {
  PlatformAdmin, PlatformSetting, Plan, Subscription, SubscriptionPayment,
  Business, Employee, BusinessCuit, Sale,
} = require('../models');
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
      log.warn('backoffice', 'intento de acceso fallido', { email: mask.email(email), ip: ip(req) });
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
      log.warn('backoffice', 'código de segundo factor inválido', { email: mask.email(email), ip: ip(req) });
      return res.status(401).json(generico);
    }

    await bloqueo.registrar({ req, tipo: 'platform', identificador: email, exito: true });
    await bloqueo.limpiar({ req, identificador: email });

    await admin.update({ ultimaConexion: new Date(), ultimaIp: ip(req) });
    const token = crearSesion({ type: 'platform', platformAdminId: admin.id, rol: admin.rol });
    setAuthCookie(res, token);

    log.info('backoffice', 'acceso concedido', { admin: admin.id, rol: admin.rol, ip: ip(req) });
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
      SubscriptionPayment.findAll({ where: { businessId: negocio.id }, order: [['fecha', 'DESC']], limit: 30 }),
      BusinessCuit.count({ where: { businessId: negocio.id } }),
      Employee.count({ where: { businessId: negocio.id, activo: true } }),
      Sale.count({ where: { businessId: negocio.id } }),
    ]);

    res.json({
      negocio,
      suscripcion: {
        estado: estado.estado, plan: estado.plan?.codigo, planNombre: estado.plan?.nombre,
        vence: estado.vence, diasRestantes: estado.diasRestantes,
        precio: estado.precio, precioLista: estado.precioLista,
        descuentoPct: estado.descuentoPct, descuentoNota: estado.suscripcion.descuentoNota,
        precioAcordado: estado.suscripcion.precioAcordado,
        renovacionAutomatica: estado.renovacionAutomatica,
        metodoPago: estado.suscripcion.metodoPago,
        bajaSolicitadaEn: estado.bajaSolicitadaEn,
        bajaMotivo: estado.suscripcion.bajaMotivo,
        notas: estado.suscripcion.notas,
      },
      uso, pagos,
      actividad: { cuits, empleados, ventas },
    });
  } catch (e) { next(e); }
};

/*
 * PUT /api/backoffice/cuentas/:id/suscripcion
 *
 * Cambio de plan, descuento, precio cerrado y extensión de período. Es la
 * herramienta comercial: cotizar un Enterprise, dar tres meses bonificados,
 * destrabar una cuenta cuya transferencia todavía no se acreditó.
 */
const editarSuscripcion = async (req, res, next) => {
  try {
    if (!puede(req.admin, 'owner')) {
      return res.status(403).json({ message: 'Sólo un responsable comercial puede cambiar planes y precios.' });
    }

    const { suscripcion } = await planService.estadoDe(req.params.id);
    const patch = {};

    if (req.body?.plan) {
      const plan = await Plan.findOne({ where: { codigo: req.body.plan } });
      if (!plan) return res.status(400).json({ message: 'Ese plan no existe.' });
      patch.planId = plan.id;
    }
    if (req.body?.descuentoPct !== undefined) {
      const pct = Number(req.body.descuentoPct);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
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
    // los días que tardó en acreditarse una transferencia.
    if (req.body?.extenderDias) {
      const dias = Number(req.body.extenderDias);
      if (!Number.isFinite(dias) || dias <= 0 || dias > 365) {
        return res.status(400).json({ message: 'Los días a extender tienen que ir de 1 a 365.' });
      }
      const { hasta } = await planService.acreditarPago({ subscription: suscripcion, dias });
      patch.periodoFin = hasta;
    }

    await suscripcion.update(patch);
    log.info('backoffice', 'suscripción editada', { negocio: req.params.id, admin: req.admin.id });

    const actualizado = await planService.estadoDe(req.params.id);
    res.json({ estado: actualizado.estado, plan: actualizado.plan?.codigo, precio: actualizado.precio, vence: actualizado.vence });
  } catch (e) { next(e); }
};

/*
 * POST /api/backoffice/pagos/:id/aprobar
 *
 * Acredita una transferencia después de verla en el extracto. Es el paso que
 * a propósito no es automático: el sistema no puede saber si la plata llegó.
 */
const aprobarPago = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    if (!puede(req.admin, 'owner')) {
      await t.rollback();
      return res.status(403).json({ message: 'Sólo un responsable comercial puede acreditar pagos.' });
    }

    const pago = await SubscriptionPayment.findByPk(req.params.id, { transaction: t });
    if (!pago) { await t.rollback(); return res.status(404).json({ message: 'No existe ese pago.' }); }
    if (pago.estado === 'aprobado') {
      await t.rollback();
      return res.status(409).json({ message: 'Ese pago ya estaba acreditado.' });
    }

    const sub = await Subscription.findByPk(pago.subscriptionId, { transaction: t });
    const { desde, hasta } = await planService.acreditarPago({ subscription: sub }, t);
    await pago.update({
      estado: 'aprobado',
      periodoDesde: desde, periodoHasta: hasta,
      verificadoPor: req.admin.email, verificadoEn: new Date(),
    }, { transaction: t });

    await t.commit();
    log.info('backoffice', 'pago acreditado a mano', { pago: pago.id, admin: req.admin.id });
    res.json({ pago, periodo: { desde, hasta } });
  } catch (e) { await t.rollback(); next(e); }
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
    for (const tope of ['maxCuits', 'maxEmpleados', 'maxLocales']) {
      if (req.body?.[tope] !== undefined) {
        patch[tope] = req.body[tope] === null ? null : Math.max(0, Number(req.body[tope]) || 0);
      }
    }
    if (req.body?.features !== undefined) patch.features = req.body.features;
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

module.exports = {
  login, logout, yo, activarTotp,
  listarCuentas, verCuenta, editarSuscripcion,
  aprobarPago, rechazarPago,
  listarPlanes, editarPlan,
  getAjustes, editarAjustes, resumen, estadoMercadoPago, estadoSeguridad,
  CLAVES_PUBLICAS,
};
