const bcrypt   = require('bcryptjs');
const { Business, Employee, Role, EmployeeSession, BusinessCuit } = require('../models');
const { signToken } = require('../utils/jwt');

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

module.exports = { register, login, employeeLogin, me };
