const { Op } = require('sequelize');
const { Business, Employee, PlatformAdmin } = require('../models');

/*
 * Registro de emails.
 *
 * Un email identifica a una persona dentro de Stocker y no puede estar en dos
 * lugares a la vez. Son tres tablas distintas con login propio —dueños,
 * empleados y operadores de la plataforma— y hasta ahora cada una miraba sólo
 * la suya. El agujero: el mismo email podía ser dueño de un negocio y empleado
 * de otro, y el login no tenía forma de saber a cuál de los dos entrar.
 *
 * Es también lo que sostiene el cobro por cuenta. Junto con el CUIT único (ver
 * cuitRegistry) evita el reparto del mismo negocio en varias cuentas gratuitas
 * para no pagar el plan que le corresponde.
 *
 * Todo lo que dé de alta o cambie un email tiene que pasar por acá.
 */

const normalizar = (v) => String(v || '').trim().toLowerCase();

/**
 * Busca quién tiene ese email.
 *
 * @param {string} email
 * @param {object} excluir { businessId, employeeId, platformAdminId } para
 *                         ignorar al propio titular cuando está editándose
 * @returns {Promise<null|{ motivo: 'cuenta'|'empleado'|'plataforma' }>}
 */
async function quienUsa(email, excluir = {}) {
  const limpio = normalizar(email);
  if (!limpio) return null;

  const where = (extra) => ({ email: limpio, ...extra });

  const cuenta = await Business.findOne({
    where: where(excluir.businessId ? { id: { [Op.ne]: excluir.businessId } } : {}),
    attributes: ['id'],
  });
  if (cuenta) return { motivo: 'cuenta', id: cuenta.id };

  // Incluye los inactivos a propósito: un empleado dado de baja puede volver, y
  // mientras tanto su email no debe quedar libre para otra persona.
  const empleado = await Employee.findOne({
    where: where(excluir.employeeId ? { id: { [Op.ne]: excluir.employeeId } } : {}),
    attributes: ['id'],
  });
  if (empleado) return { motivo: 'empleado', id: empleado.id };

  const admin = await PlatformAdmin.findOne({
    where: where(excluir.platformAdminId ? { id: { [Op.ne]: excluir.platformAdminId } } : {}),
    attributes: ['id'],
  });
  if (admin) return { motivo: 'plataforma', id: admin.id };

  return null;
}

/**
 * Lanza si el email ya está tomado.
 *
 * El mensaje no dice en qué negocio está usado: decirle a quien se registra
 * "ese email es empleado de Tienda X" le filtra datos de un tercero. Alcanza
 * con que sepa que está ocupado y cómo seguir.
 */
async function exigirLibre(email, excluir = {}) {
  const uso = await quienUsa(email, excluir);
  if (!uso) return;

  const mensaje = uso.motivo === 'empleado'
    ? 'Ese email ya está registrado como empleado de una cuenta de Stocker. Usá otro, o pedile al dueño que lo libere.'
    : 'Ese email ya está en uso en Stocker. Si es tuyo, iniciá sesión o recuperá la contraseña.';

  throw Object.assign(new Error(mensaje), { status: 409 });
}

module.exports = { quienUsa, exigirLibre, normalizar };
