const bcrypt = require('bcryptjs');
const { Employee, BusinessLocation, Role, EmployeeSession } = require('../models');

const sanitize = (e) => { const { passwordHash, ...s } = e.toJSON(); return s; };

// GET /api/employees
const getEmployees = async (req, res, next) => {
  try {
    const employees = await Employee.findAll({
      where: { businessId: req.auth.businessId },
      include: [{ association: 'cargo' }, { association: 'local', attributes: ['id', 'nombre'] }],
      order: [['nombre', 'ASC']],
    });
    res.json(employees.map(sanitize));
  } catch (error) { next(error); }
};

// GET /api/employees/:id
const getEmployee = async (req, res, next) => {
  try {
    const e = await Employee.findOne({
      where: { id: req.params.id, businessId: req.auth.businessId },
      include: [{ association: 'cargo' }, { association: 'local' }],
    });
    if (!e) return res.status(404).json({ message: 'Empleado no encontrado.' });
    res.json(sanitize(e));
  } catch (error) { next(error); }
};

// POST /api/employees
const createEmployee = async (req, res, next) => {
  try {
    const { nombre, apellido, email, telefono, dni, roleId, locationId, password } = req.body;
    if (!nombre || !apellido || !email || !dni)
      return res.status(400).json({ message: 'Nombre, apellido, email y DNI son obligatorios.' });
    const passwordHash = password ? await bcrypt.hash(password, 10) : null;
    // Mismo control que en la edición: el cargo y el local tienen que ser de
    // este negocio. Acá el riesgo es heredar los permisos de un cargo ajeno.
    const relaciones = await resolverRelaciones({ roleId, locationId }, req.auth.businessId);
    const e = await Employee.create({
      businessId: req.auth.businessId, nombre, apellido, email, telefono, dni, passwordHash,
      ...relaciones,
    });
    const full = await Employee.findByPk(e.id, { include: [{ association: 'cargo' }, { association: 'local' }] });
    res.status(201).json(sanitize(full));
  } catch (error) { next(error); }
};

// PUT /api/employees/:id
/*
 * Campos que el cliente puede tocar de un empleado.
 *
 * Deliberadamente NO están businessId, id, passwordHash, createdAt ni
 * updatedAt. Antes se hacía `e.update(rest)` con todo el body salvo password,
 * así que mandando businessId desde el navegador un empleado con permiso de
 * "empleados: editar" se movía a otro negocio; al volver a iniciar sesión,
 * employeeLogin firmaba la sesión con ese businessId y quedaba adentro de la
 * cuenta ajena. Ver informe QA F-01.
 */
const CAMPOS_EDITABLES = ['nombre', 'apellido', 'email', 'telefono', 'dni', 'activo'];

/*
 * roleId y locationId apuntan a otras tablas: si no se valida a quién
 * pertenecen, se puede asignar el cargo de otro negocio (y con él sus
 * permisos) o un local ajeno. Se resuelven contra el negocio de la sesión.
 */
async function resolverRelaciones(body, businessId) {
  const patch = {};

  if (body.roleId !== undefined) {
    if (body.roleId === null || body.roleId === '') {
      patch.roleId = null;
    } else {
      const rol = await Role.findOne({ where: { id: body.roleId, businessId } });
      if (!rol) throw Object.assign(new Error('El cargo indicado no pertenece a este negocio.'), { status: 400 });
      patch.roleId = rol.id;
    }
  }

  if (body.locationId !== undefined) {
    if (body.locationId === null || body.locationId === '') {
      patch.locationId = null;
    } else {
      const local = await BusinessLocation.findOne({ where: { id: body.locationId, businessId } });
      if (!local) throw Object.assign(new Error('El local indicado no pertenece a este negocio.'), { status: 400 });
      patch.locationId = local.id;
    }
  }

  return patch;
}

const updateEmployee = async (req, res, next) => {
  try {
    const e = await Employee.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!e) return res.status(404).json({ message: 'Empleado no encontrado.' });

    const patch = {};
    for (const campo of CAMPOS_EDITABLES) {
      if (req.body?.[campo] !== undefined) patch[campo] = req.body[campo];
    }
    Object.assign(patch, await resolverRelaciones(req.body || {}, req.auth.businessId));

    if (req.body?.password) patch.passwordHash = await bcrypt.hash(req.body.password, 10);

    await e.update(patch);
    const full = await Employee.findByPk(e.id, { include: [{ association: 'cargo' }, { association: 'local' }] });
    res.json(sanitize(full));
  } catch (error) { next(error); }
};

// PATCH /api/employees/:id/toggle
const toggleActive = async (req, res, next) => {
  try {
    const e = await Employee.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!e) return res.status(404).json({ message: 'Empleado no encontrado.' });
    await e.update({ activo: !e.activo });
    res.json(sanitize(e));
  } catch (error) { next(error); }
};

// DELETE /api/employees/:id
const deleteEmployee = async (req, res, next) => {
  try {
    const e = await Employee.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!e) return res.status(404).json({ message: 'Empleado no encontrado.' });
    await e.destroy();
    res.status(204).send();
  } catch (error) { next(error); }
};

// GET /api/employees/:id/sessions
const getSessions = async (req, res, next) => {
  try {
    const emp = await Employee.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!emp) return res.status(404).json({ message: 'Empleado no encontrado.' });
    const sessions = await EmployeeSession.findAll({
      where: { employeeId: emp.id },
      order: [['lastSeenAt', 'DESC']],
      limit: 50,
    });
    res.json(sessions);
  } catch (error) { next(error); }
};

module.exports = { getEmployees, getEmployee, createEmployee, updateEmployee, toggleActive, deleteEmployee, getSessions };
