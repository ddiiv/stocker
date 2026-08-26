const bcrypt = require('bcryptjs');
const { Employee, BusinessLocation, Role, EmployeeSession } = require('../models');
const identidad = require('../services/identityRegistry');
const { exigirCupo } = require('../services/planService');
const bloqueo = require('../services/bloqueoService');
const { emailValido, soloDigitos } = require('../utils/identificadores');

const sanitize = (e) => { const { passwordHash, ...s } = e.toJSON(); return s; };

// GET /api/employees
const getEmployees = async (req, res, next) => {
  try {
    const employees = await Employee.findAll({
      where: { businessId: req.auth.businessId },
      include: [{ association: 'cargo' }, { association: 'local', attributes: ['id', 'nombre'] }],
      order: [['nombre', 'ASC']],
    });

    /*
     * Quién está trabado por intentos fallidos.
     *
     * Viaja con la lista y no en un pedido aparte: el dueño se entera del
     * bloqueo porque la empleada se lo dice desde el mostrador, y tiene que
     * poder verlo y levantarlo en la misma pantalla donde ya está.
     */
    const estados = await bloqueo.estadoDeCuentas(employees.map((e) => e.email));

    res.json(employees.map((e) => ({
      ...sanitize(e),
      bloqueo: estados.get(String(e.email || '').trim().toLowerCase()) || { bloqueado: false, fallos: 0 },
    })));
  } catch (error) { next(error); }
};

/*
 * POST /api/employees/:id/desbloquear
 *
 * Levanta el bloqueo por intentos fallidos de un empleado del negocio.
 *
 * El bloqueo existe para frenar a quien prueba contraseñas, no para castigar a
 * quien se equivocó tres veces con clientes esperando. El dueño sabe cuál de
 * los dos casos es y puede decidirlo; el sistema, no.
 *
 * Sólo alcanza a los empleados de su propio negocio, y sólo limpia el conteo
 * por cuenta: el de la IP sigue en pie, así esto no sirve para tapar un ataque.
 */
const desbloquear = async (req, res, next) => {
  try {
    const employee = await Employee.findOne({
      where: { id: req.params.id, businessId: req.auth.businessId },
    });
    if (!employee) return res.status(404).json({ message: 'Empleado no encontrado.' });
    if (!employee.email) return res.status(400).json({ message: 'Este empleado no tiene email, así que no puede estar bloqueado.' });

    await bloqueo.desbloquearCuenta(employee.email);

    /*
     * Se vuelve a mirar el estado después de limpiar.
     *
     * Si los intentos vinieron todos de la misma red, el bloqueo por IP sigue
     * activo y la persona va a seguir sin poder entrar. Decirlo acá evita que
     * el dueño apriete el botón, vea "listo" y se entere por su empleada de que
     * no cambió nada.
     */
    const sigue = await bloqueo.revisar({ req, identificador: employee.email });
    res.json({
      ok: true,
      mensaje: sigue
        ? `Se limpiaron los intentos de ${employee.nombre}, pero sigue bloqueado por la cantidad de intentos desde esa red: faltan ${sigue.minutos} minuto${sigue.minutos === 1 ? '' : 's'}.`
        : `${employee.nombre} ya puede volver a entrar.`,
      sigueBloqueado: Boolean(sigue),
    });
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

/*
 * Email y DNI, comprobados también acá.
 *
 * El formulario los frena con `type="email"` y un placeholder, pero la API es
 * la que guarda: sin esto entra "no-es-email" y un DNI "abc" con un POST
 * directo, y el error recién aparece cuando hay que mandarle el recibo de
 * sueldo o cargar el alta en AFIP.
 *
 * El DNI se guarda como venga —con puntos o sin ellos— pero se cuenta en
 * dígitos: los documentos argentinos tienen 7 u 8.
 */
function validarIdentidad({ email, dni }) {
  if (email !== undefined && !emailValido(email)) {
    return 'El email no tiene un formato válido.';
  }
  if (dni !== undefined) {
    const d = soloDigitos(dni);
    if (!d) return 'El DNI tiene que ser un número.';
    if (d.length < 7 || d.length > 8) return 'El DNI tiene que tener 7 u 8 dígitos.';
  }
  return null;
}

// POST /api/employees
const createEmployee = async (req, res, next) => {
  try {
    const { nombre, apellido, email, telefono, dni, roleId, locationId, password } = req.body;
    if (!nombre || !apellido || !email || !dni)
      return res.status(400).json({ message: 'Nombre, apellido, email y DNI son obligatorios.' });

    const errIdent = validarIdentidad({ email, dni });
    if (errIdent) return res.status(400).json({ message: errIdent });

    // El tope de usuarios es lo que se vende en cada plan, así que se controla
    // antes de crear nada. Se cuentan los activos: dar de baja libera el lugar.
    await exigirCupo(req.auth.businessId, 'empleados');
    // Un email pertenece a una sola persona en todo Stocker, sea dueño,
    // empleado de otro negocio u operador de la plataforma.
    await identidad.exigirLibre(email);

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

    // Mismo control que en el alta: editar no puede ser la puerta de atrás
    // para dejar un email o un DNI que el alta habría rechazado.
    const errIdent = validarIdentidad(req.body || {});
    if (errIdent) return res.status(400).json({ message: errIdent });

    const patch = {};
    for (const campo of CAMPOS_EDITABLES) {
      if (req.body?.[campo] !== undefined) patch[campo] = req.body[campo];
    }
    Object.assign(patch, await resolverRelaciones(req.body || {}, req.auth.businessId));

    if (req.body?.password) patch.passwordHash = await bcrypt.hash(req.body.password, 10);
    // Cambiar el email también tiene que respetar la unicidad global; sin esto
    // se podía esquivar la validación del alta editando después.
    if (patch.email && patch.email !== e.email) {
      await identidad.exigirLibre(patch.email, { employeeId: e.id });
    }

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
    // Reactivar ocupa un lugar igual que dar de alta: si no, bastaría con
    // desactivar y reactivar para pasarse del tope del plan.
    if (!e.activo) await exigirCupo(req.auth.businessId, 'empleados');
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

module.exports = { getEmployees, desbloquear, getEmployee, createEmployee, updateEmployee, toggleActive, deleteEmployee, getSessions };
