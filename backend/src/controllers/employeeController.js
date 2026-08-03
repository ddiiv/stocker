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
    const e = await Employee.create({ businessId: req.auth.businessId, nombre, apellido, email, telefono, dni, roleId, locationId, passwordHash });
    const full = await Employee.findByPk(e.id, { include: [{ association: 'cargo' }, { association: 'local' }] });
    res.status(201).json(sanitize(full));
  } catch (error) { next(error); }
};

// PUT /api/employees/:id
const updateEmployee = async (req, res, next) => {
  try {
    const e = await Employee.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!e) return res.status(404).json({ message: 'Empleado no encontrado.' });
    const { password, ...rest } = req.body;
    if (password) rest.passwordHash = await bcrypt.hash(password, 10);
    await e.update(rest);
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
