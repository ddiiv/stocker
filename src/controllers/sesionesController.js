const bcrypt = require('bcryptjs');
const { Business, Employee, SesionCuenta } = require('../models');
const sesiones = require('../services/sesionesService');
const { log } = require('../utils/logger');

/*
 * Las sesiones de la cuenta, para la pantalla de Configuración.
 *
 * A diferencia del resto de /account, acá entran también los empleados: cada
 * uno ve y cierra SUS sesiones (el teléfono que se olvidó en el colectivo es
 * suyo, no del dueño). El dueño ve y cierra las de todo el negocio.
 *
 * El negocio, el empleado y la sesión actual salen SIEMPRE del token. El id
 * de la URL sólo elige una fila dentro de lo que ese token ya puede ver.
 */

/*
 * La contraseña de quien está pidiendo esto, sea dueño o empleado.
 *
 * Cerrar sesiones la pide igual que el botón de "cerrar todas" que ya existía:
 * sin eso, alguien con una sesión robada —o con la PC del mostrador que quedó
 * abierta— podría echar al dueño legítimo de su propia cuenta una y otra vez,
 * y es justo la situación en la que el dueño necesita poder quedarse adentro.
 */
async function contrasenaCorrecta(auth, password) {
  const clave = String(password || '');
  if (!clave) return false;
  const quien = auth.type === 'business'
    ? await Business.findByPk(auth.businessId, { attributes: ['id', 'passwordHash'] })
    : await Employee.findOne({
      where: { id: auth.employeeId, businessId: auth.businessId },
      attributes: ['id', 'passwordHash'],
    });
  if (!quien?.passwordHash) return false;
  return bcrypt.compare(clave, quien.passwordHash);
}

// GET /api/account/sesiones
const listar = async (req, res, next) => {
  try {
    res.json(await sesiones.listar(req.auth));
  } catch (error) { next(error); }
};

// POST /api/account/sesiones/:id/cerrar   { passwordActual }
const cerrarUna = async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'Sesión inválida.' });
    }
    if (!(await contrasenaCorrecta(req.auth, req.body?.passwordActual))) {
      return res.status(400).json({ message: 'La contraseña actual no es correcta.' });
    }

    /*
     * La fila se busca DENTRO de lo que este token puede ver: su negocio, y si
     * es un empleado, sus propias sesiones. Una fila de otro negocio —o la del
     * dueño, pedida por un empleado— da 404 igual que una que no existe, para
     * no confirmar que existe.
     */
    const where = { id, businessId: req.auth.businessId };
    if (req.auth.type !== 'business') {
      where.tipo = 'employee';
      where.employeeId = req.auth.employeeId;
    }
    const fila = await SesionCuenta.findOne({ where, attributes: ['id', 'sid', 'cerradaEn'] });
    if (!fila) return res.status(404).json({ message: 'No encontramos esa sesión.' });

    // La de este dispositivo se cierra con "Salir", que además borra la
    // cookie. Cerrarla por acá dejaría la pantalla abierta con una sesión
    // muerta, y el próximo clic lo sacaría sin explicación.
    if (fila.sid === req.auth.sid) {
      return res.status(400).json({ message: 'Ésta es la sesión que estás usando. Para cerrarla, usá «Salir».' });
    }
    if (fila.cerradaEn) {
      return res.json({ message: 'Esa sesión ya estaba cerrada.', cerrada: true });
    }

    await sesiones.cerrar({ businessId: req.auth.businessId, id: fila.id, motivo: 'remota' });
    log.info('sesiones', 'se cerró una sesión desde la lista de la cuenta', { negocio: req.auth.businessId });
    res.json({ message: 'Listo. Esa sesión se cerró: en su próximo pedido le va a pedir que vuelva a entrar.', cerrada: true });
  } catch (error) { next(error); }
};

/*
 * POST /api/account/sesiones/cerrar   { passwordActual }
 *
 * "Cerrar todas menos ésta".
 *
 *   · El dueño: el botón de pánico que ya existía —todas las sesiones del
 *     negocio, suyas y de los empleados— y que vive en accountController.
 *   · Un empleado: sólo las suyas. No puede sacar a sus compañeros ni al
 *     dueño. No mueve su `sesionesDesde`: eso lo echaría también de acá, y
 *     cerrar las filas alcanza para que las otras no entren más.
 */
const cerrarOtras = async (req, res, next) => {
  if (req.auth.type === 'business') {
    return require('./accountController').cerrarTodasLasSesiones(req, res, next);
  }
  try {
    if (!(await contrasenaCorrecta(req.auth, req.body?.passwordActual))) {
      return res.status(400).json({ message: 'La contraseña actual no es correcta.' });
    }
    const cerradas = await sesiones.cerrar({
      businessId: req.auth.businessId, tipo: 'employee', employeeId: req.auth.employeeId,
      excepto: req.auth.sid, motivo: 'cerrar-todo',
    });
    res.json({
      message: 'Listo. Se cerraron tus otras sesiones, menos la de este dispositivo.',
      sesionesCerradas: cerradas,
    });
  } catch (error) { next(error); }
};

module.exports = { listar, cerrarUna, cerrarOtras };
