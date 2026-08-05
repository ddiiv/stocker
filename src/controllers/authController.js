const bcrypt   = require('bcryptjs');
const { Op }   = require('sequelize');
const { Business, Employee, Role, EmployeeSession, BusinessCuit, PasswordResetCode } = require('../models');
const { signToken } = require('../utils/jwt');
const { sendPasswordResetCode, sendPasswordResetAlert } = require('../services/emailService');

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

    const passwordHash = await bcrypt.hash(password, 10);
    const business = await Business.create({
      nombreNegocio, ownerNombre, ownerApellido, cuit,
      telefono, ownerTelefono, email, passwordHash,
    });

    // CUIT principal (para facturación multi-CUIT)
    await BusinessCuit.create({
      businessId: business.id, nombre: business.nombreNegocio, cuit: business.cuit, esPrincipal: true,
    });

    // Roles por defecto
    await Role.bulkCreate([
      { businessId: business.id, nombre: 'Administrador', permisos: { stock:'editar', ventas:'editar', facturacion:'editar', empleados:'editar', dashboard:'editar', cotizaciones:'editar' } },
      { businessId: business.id, nombre: 'Vendedor', permisos: { stock:'ver', ventas:'editar', facturacion:'ver', empleados:'ninguno', dashboard:'ver', cotizaciones:'editar' } },
      { businessId: business.id, nombre: 'Depósito', permisos: { stock:'editar', ventas:'ninguno', facturacion:'ninguno', empleados:'ninguno', dashboard:'ver', cotizaciones:'ninguno' } },
      { businessId: business.id, nombre: 'Cajero', permisos: { stock:'ver', ventas:'editar', facturacion:'editar', empleados:'ninguno', dashboard:'ver', cotizaciones:'ver' } },
    ]);

    const token = signToken({ type: 'business', businessId: business.id });
    res.status(201).json({ token, business: sanitizeBusiness(business) });
  } catch (error) { next(error); }
};

// POST /api/auth/login
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const business = await Business.findOne({ where: { email } });
    if (!business || !(await bcrypt.compare(password, business.passwordHash)))
      return res.status(401).json({ message: 'Email o contraseña incorrectos.' });

    const token = signToken({ type: 'business', businessId: business.id });
    res.json({ token, business: sanitizeBusiness(business) });
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
    const token = signToken({
      type: 'employee', businessId: employee.businessId,
      employeeId: employee.id, roleId: employee.roleId, permisos,
    });
    // Registrar sesión (login)
    EmployeeSession.create({
      employeeId: employee.id, ip: clientIp(req), userAgent: userAgent(req),
      loginAt: new Date(), lastSeenAt: new Date(),
    }).catch(() => {});
    await employee.update({ ultimaConexion: new Date() }).catch(() => {});
    res.json({ token, employee: sanitizeEmployee(employee) });
  } catch (error) { next(error); }
};

// GET /api/auth/me
const me = async (req, res, next) => {
  try {
    if (req.auth.type === 'business') {
      const b = await Business.findByPk(req.auth.businessId);
      if (!b) return res.status(404).json({ message: 'Negocio no encontrado.' });
      return res.json({ type: 'business', data: sanitizeBusiness(b) });
    }
    const e = await Employee.findByPk(req.auth.employeeId, { include: [{ association: 'cargo' }, { association: 'local' }] });
    if (!e) return res.status(404).json({ message: 'Empleado no encontrado.' });
    res.json({ type: 'employee', data: sanitizeEmployee(e) });
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

function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 dígitos
}

const forgotPassword = async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const cuit  = String(req.body?.cuit  || '').replace(/[^0-9]/g, '');
    if (!email || !cuit) {
      return res.status(400).json({ message: 'Email y CUIT son obligatorios.' });
    }

    const business = await Business.findOne({ where: { email } });
    // Sólo procesamos si el business existe Y el CUIT coincide.
    if (!business || String(business.cuit).replace(/[^0-9]/g, '') !== cuit) {
      // Devolvemos 200 igualmente — no revelar si el email existe.
      return res.json({ ok: true, message: 'Si los datos son correctos, te enviamos un mail con instrucciones.' });
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

    sendPasswordResetCode({
      to: business.email,
      ownerName: business.ownerNombre,
      code,
      businessName: business.nombreNegocio,
      expiresInMinutes: CODE_EXPIRATION_MIN,
    }).catch((err) => console.error('[email reset code]', err.message));

    res.json({ ok: true, message: 'Si los datos son correctos, te enviamos un mail con instrucciones.' });
  } catch (error) { next(error); }
};

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

module.exports = { register, login, employeeLogin, me, forgotPassword, verifyResetCode, resetPassword };
