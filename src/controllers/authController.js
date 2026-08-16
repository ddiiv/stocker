const bcrypt   = require('bcryptjs');
const crypto   = require('node:crypto');
const { Op }   = require('sequelize');
const { Business, Employee, Role, EmployeeSession, BusinessCuit, PasswordResetCode, PaymentMethod } = require('../models');
const { PRESETS } = require('../config/permisos');
const { exigirLibre, normalizar } = require('../services/cuitRegistry');
const { crearSesion, IDLE_MIN } = require('../utils/session');
const { setAuthCookie, clearAuthCookie } = require('../utils/authCookie');
const { sendPasswordResetCode, sendPasswordResetAlert } = require('../services/emailService');
const { log, mask } = require('../utils/logger');

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}
function userAgent(req) { return String(req.headers['user-agent'] || '').slice(0, 500); }

const sanitizeBusiness = (b) => {
  const { passwordHash, ...safe } = b.toJSON();
  return safe;
};
const sanitizeEmployee = (e) => {
  const { passwordHash, ...safe } = e.toJSON();
  return safe;
};

// POST /api/auth/register  (crea negocio + dueño)
const register = async (req, res, next) => {
  try {
    const { nombreNegocio, ownerNombre, ownerApellido, cuit, telefono, ownerTelefono, email, password } = req.body;
    if (!nombreNegocio || !ownerNombre || !ownerApellido || !cuit || !email || !password)
      return res.status(400).json({ message: 'Faltan campos obligatorios.' });

    if (await Business.findOne({ where: { email } }))
      return res.status(409).json({ message: 'Ya existe una cuenta con ese email.' });

    // El CUIT no puede estar en uso en ninguna otra cuenta, ni como cuenta ni
    // como CUIT de facturación: dos negocios facturando con el mismo CUIT se
    // pisarían la numeración de comprobantes ante AFIP.
    const cuitLimpio = normalizar(cuit);
    if (cuitLimpio.length !== 11) {
      return res.status(400).json({ message: 'El CUIT debe tener 11 dígitos.' });
    }
    await exigirLibre(cuitLimpio);

    const passwordHash = await bcrypt.hash(password, 10);
    const business = await Business.create({
      nombreNegocio, ownerNombre, ownerApellido, cuit: cuitLimpio,
      telefono, ownerTelefono, email, passwordHash,
    });

    // CUIT principal (para facturación multi-CUIT)
    await BusinessCuit.create({
      businessId: business.id, nombre: business.nombreNegocio, cuit: business.cuit, esPrincipal: true,
    });

    // Roles por defecto. Los permisos salen de config/permisos.js para que
    // agregar un módulo nuevo no deje a los cargos preexistentes incompletos.
    await Role.bulkCreate(
      Object.entries(PRESETS).map(([nombre, permisos]) => ({ businessId: business.id, nombre, permisos }))
    );

    // Medios de pago iniciales, sin ajuste. El negocio los edita después.
    await PaymentMethod.bulkCreate(
      ['Efectivo', 'Débito', 'Crédito', 'Transferencia', 'QR / Billetera'].map((nombre, i) => ({
        businessId: business.id, nombre, ajustePct: 0, activo: true, orden: i,
      }))
    );

    const token = crearSesion({ type: 'business', businessId: business.id });
    setAuthCookie(res, token);
    res.status(201).json({ business: sanitizeBusiness(business) });
  } catch (error) { next(error); }
};

// POST /api/auth/login
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const business = await Business.findOne({ where: { email } });
    if (!business || !(await bcrypt.compare(password, business.passwordHash)))
      return res.status(401).json({ message: 'Email o contraseña incorrectos.' });

    const token = crearSesion({ type: 'business', businessId: business.id });
    setAuthCookie(res, token);
    res.json({ business: sanitizeBusiness(business) });
  } catch (error) { next(error); }
};

// POST /api/auth/employee-login
const employeeLogin = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const employee = await Employee.findOne({ where: { email, activo: true }, include: [{ association: 'cargo' }] });
    if (!employee || !employee.passwordHash)
      return res.status(401).json({ message: 'Email o contraseña incorrectos.' });
    if (!(await bcrypt.compare(password, employee.passwordHash)))
      return res.status(401).json({ message: 'Email o contraseña incorrectos.' });

    const permisos = employee.cargo?.permisos || {};
    const token = crearSesion({
      type: 'employee', businessId: employee.businessId,
      employeeId: employee.id, roleId: employee.roleId, permisos,
    });
    // Registrar sesión (login)
    EmployeeSession.create({
      employeeId: employee.id, ip: clientIp(req), userAgent: userAgent(req),
      loginAt: new Date(), lastSeenAt: new Date(),
    }).catch(() => {});
    await employee.update({ ultimaConexion: new Date() }).catch(() => {});
    setAuthCookie(res, token);
    res.json({ employee: sanitizeEmployee(employee) });
  } catch (error) { next(error); }
};

// POST /api/auth/logout
// La cookie es httpOnly, así que sólo el servidor puede borrarla.
const logout = async (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
};

// GET /api/auth/me
const me = async (req, res, next) => {
  try {
    // El front usa esto para cerrar la pantalla por inactividad antes de que
    // el servidor rechace el pedido. Una sola fuente de verdad para el valor.
    const sesion = { inactividadMin: IDLE_MIN };

    if (req.auth.type === 'business') {
      const b = await Business.findByPk(req.auth.businessId);
      if (!b) return res.status(404).json({ message: 'Negocio no encontrado.' });
      const emisorDueno = await BusinessCuit.findOne({
        where: { businessId: b.id, esPrincipal: true },
        attributes: ['id', 'nombre', 'cuit', 'condicionIva', 'domicilio'],
      });
      // Misma forma que para el empleado, así el front lee `negocio` sin
      // preguntar de qué tipo de sesión se trata.
      return res.json({
        type: 'business',
        data: sanitizeBusiness(b),
        negocio: {
          id: b.id, nombreNegocio: b.nombreNegocio, cuit: b.cuit, telefono: b.telefono,
          emisor: emisorDueno?.toJSON() || null,
        },
        sesion,
      });
    }
    const e = await Employee.findByPk(req.auth.employeeId, { include: [{ association: 'cargo' }, { association: 'local' }] });
    if (!e) return res.status(404).json({ message: 'Empleado no encontrado.' });

    // El empleado necesita saber en qué negocio está: el nombre aparece en la
    // barra superior, y el CUIT y el nombre fiscal en tickets y comprobantes.
    // Se manda sólo eso — email del dueño, teléfono personal y hash de
    // contraseña no tienen por qué salir del lado del dueño.
    const negocio = await Business.findByPk(req.auth.businessId, {
      attributes: ['id', 'nombreNegocio', 'cuit', 'telefono'],
    });
    const emisor = await BusinessCuit.findOne({
      where: { businessId: req.auth.businessId, esPrincipal: true },
      attributes: ['id', 'nombre', 'cuit', 'condicionIva', 'domicilio'],
    });

    res.json({
      type: 'employee',
      data: sanitizeEmployee(e),
      negocio: negocio ? { ...negocio.toJSON(), emisor: emisor?.toJSON() || null } : null,
      sesion,
    });
  } catch (error) { next(error); }
};

// ── Recuperación de contraseña (dueño) ───────────────────────────
// Flujo:
//   1) POST /auth/forgot-password  { email, cuit }
//        - valida que ambos matcheen a un business.
//        - genera código de 6 dígitos, lo guarda con expiración 15min y 4 intentos.
//        - manda mail con el código.
//        - devuelve 200 SIEMPRE (no revelamos si el email existe o no).
//   2) POST /auth/verify-reset-code  { email, code }
//        - valida contra el código vigente más reciente.
//        - descuenta 1 intento en cada fallo.
//        - si intentos = 0, invalida y manda alerta al mail del dueño.
//   3) POST /auth/reset-password  { email, code, newPassword }
//        - valida (mismo criterio que verify), y si OK actualiza el passwordHash.
//        - la validación de fortaleza de newPassword se hace en el middleware.

const CODE_EXPIRATION_MIN = 15;
const MAX_ATTEMPTS = 4;

/*
 * Math.random no es criptográficamente seguro: su secuencia es predecible a
 * partir de suficientes salidas, y esto es un secreto temporal que da acceso a
 * cambiar una contraseña. randomInt usa el generador del sistema.
 */
function genCode() {
  return String(crypto.randomInt(100000, 1000000)); // 6 dígitos
}

const forgotPassword = async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const cuit  = String(req.body?.cuit  || '').replace(/[^0-9]/g, '');
    if (!email || !cuit) {
      return res.status(400).json({ message: 'Email y CUIT son obligatorios.' });
    }
    if (cuit.length !== 11) {
      return res.status(400).json({ message: 'El CUIT debe tener 11 dígitos.' });
    }

    /*
     * Respuesta neutra, siempre la misma.
     *
     * Antes se devolvía 404 cuando el par email/CUIT no coincidía. Era más
     * cómodo para el dueño que se equivoca, pero convertía este endpoint en un
     * oráculo: probando pares se puede averiguar qué cuentas existen y con qué
     * CUIT operan. Los CUIT de empresas son públicos, así que la lista de
     * clientes de Stocker quedaba enumerable desde afuera.
     *
     * Ahora la respuesta no distingue los casos. Si los datos son correctos se
     * manda el código; si no, no se manda nada, y el mensaje es idéntico.
     */
    const RESPUESTA_NEUTRA = {
      ok: true,
      message: 'Si los datos coinciden con una cuenta, te enviamos un código al email registrado. Revisá tu casilla y la carpeta de spam.',
    };

    const business = await Business.findOne({ where: { email } });
    if (!business || String(business.cuit).replace(/[^0-9]/g, '') !== cuit) {
      // Se registra del lado del servidor para poder detectar barridos, con el
      // email enmascarado.
      log.warn('auth', 'pedido de recuperación con datos que no coinciden', { email: mask.email(email) });
      return res.json(RESPUESTA_NEUTRA);
    }

    // Invalidar códigos previos no usados del mismo business
    await PasswordResetCode.update(
      { usedAt: new Date() },
      { where: { businessId: business.id, usedAt: null } }
    );

    const code    = genCode();
    const expires = new Date(Date.now() + CODE_EXPIRATION_MIN * 60_000);
    await PasswordResetCode.create({
      businessId: business.id,
      code, attemptsLeft: MAX_ATTEMPTS, expiresAt: expires,
    });

    // Disparamos el envío y esperamos hasta 15s. Si tarda más, respondemos igual
    // (el envío sigue en background). Railway → Gmail SMTP a veces tiene latencia
    // alta en cold-start; no queremos que el usuario piense que falló.
    const sendPromise = sendPasswordResetCode({
      to: business.email,
      ownerName: business.ownerNombre,
      code,
      businessName: business.nombreNegocio,
      expiresInMinutes: CODE_EXPIRATION_MIN,
    }).catch((err) => {
      console.error('[email reset code]', err.message);
      return { _error: err.message };
    });

    // Race sólo para el TIEMPO de la respuesta HTTP; el send sigue en background.
    const timeoutSentinel = Symbol('timeout');
    const raced = await Promise.race([
      sendPromise,
      new Promise((r) => setTimeout(() => r(timeoutSentinel), 15000)),
    ]);
    const timedOut = raced === timeoutSentinel;
    const mailError = raced && raced._error;

    /*
     * Misma respuesta que cuando los datos no coinciden, sin excepción.
     *
     * Antes se devolvía el email completo y un mensaje distinto según si el
     * envío salió, tardó o falló. Cualquiera de esas diferencias alcanza para
     * distinguir un par válido de uno inválido, que es justo lo que la
     * respuesta neutra evita. El problema de envío se registra del lado del
     * servidor, donde sirve para diagnosticar sin filtrar nada.
     */
    if (mailError) log.error('auth', 'falló el envío del código de recuperación', { detalle: mailError });
    else if (timedOut) log.warn('auth', 'el envío del código superó los 15s; sigue en segundo plano');

    res.json(RESPUESTA_NEUTRA);
  } catch (error) { next(error); }
};

// Enmascara email para mostrar sólo primera letra + dominio: d***n45@gmail.com
function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!user || !domain) return email;
  if (user.length <= 2) return `${user[0]}*@${domain}`;
  return `${user[0]}${'*'.repeat(Math.min(user.length - 2, 4))}${user.slice(-1)}@${domain}`;
}

// Busca el reset code vigente y valida. Devuelve el business + la row.
async function findVigentReset({ email, code }) {
  const business = await Business.findOne({ where: { email: String(email || '').trim().toLowerCase() } });
  if (!business) return { error: 'notfound' };
  const reset = await PasswordResetCode.findOne({
    where: {
      businessId: business.id,
      usedAt: null,
      expiresAt: { [Op.gt]: new Date() },
    },
    order: [['createdAt', 'DESC']],
  });
  if (!reset) return { error: 'expired', business };
  if (reset.attemptsLeft <= 0) return { error: 'noattempts', business, reset };
  if (String(reset.code) !== String(code || '').trim()) return { error: 'wrong', business, reset };
  return { business, reset };
}

const verifyResetCode = async (req, res, next) => {
  try {
    const { email, code } = req.body || {};
    if (!email || !code) return res.status(400).json({ message: 'Email y código son obligatorios.' });

    const result = await findVigentReset({ email, code });

    if (result.error === 'notfound' || result.error === 'expired') {
      return res.status(400).json({ message: 'No hay un código vigente. Volvé a pedir un nuevo código.' });
    }
    if (result.error === 'noattempts') {
      return res.status(400).json({ message: 'Superaste el número de intentos. Volvé a pedir un nuevo código.' });
    }
    if (result.error === 'wrong') {
      const nextAttempts = result.reset.attemptsLeft - 1;
      await result.reset.update({ attemptsLeft: nextAttempts });

      // Si se agotaron, mandar alerta al dueño (si aún no la mandamos por este código)
      if (nextAttempts <= 0 && !result.reset.alertSentAt) {
        const ip = req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.ip;
        sendPasswordResetAlert({
          to: result.business.email,
          ownerName: result.business.ownerNombre,
          businessName: result.business.nombreNegocio,
          attemptedAt: new Date(),
          ip,
        }).catch((err) => console.error('[email alert]', err.message));
        await result.reset.update({ alertSentAt: new Date() });
      }

      return res.status(400).json({
        message: 'Código incorrecto.',
        attemptsLeft: Math.max(0, nextAttempts),
      });
    }

    // OK
    res.json({ ok: true, message: 'Código válido. Podés cambiar la contraseña.' });
  } catch (error) { next(error); }
};

const resetPassword = async (req, res, next) => {
  try {
    const { email, code, newPassword } = req.body || {};
    if (!email || !code || !newPassword) {
      return res.status(400).json({ message: 'Email, código y nueva contraseña son obligatorios.' });
    }
    const result = await findVigentReset({ email, code });
    if (result.error) {
      return res.status(400).json({ message: 'El código no es válido o expiró. Reintentá el proceso.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await result.business.update({ passwordHash });
    await result.reset.update({ usedAt: new Date() });

    res.json({ ok: true, message: 'Contraseña actualizada. Ya podés iniciar sesión.' });
  } catch (error) { next(error); }
};

module.exports = { register, login, employeeLogin, logout, me, forgotPassword, verifyResetCode, resetPassword };
