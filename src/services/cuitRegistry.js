const { Op } = require('sequelize');
const { Business, BusinessCuit } = require('../models');

/*
 * Registro de CUITs.
 *
 * Un CUIT identifica a un contribuyente ante ARCA y sólo puede estar operando
 * dentro de un negocio. Si el mismo CUIT quedara cargado en dos cuentas, las
 * dos podrían emitir comprobantes contra la misma numeración de AFIP: los
 * números se pisarían y el CAE de uno invalidaría la secuencia del otro.
 *
 * "Ocupado" abarca las dos formas en que un CUIT puede estar en el sistema:
 *   · como CUIT de una cuenta (businesses.cuit)
 *   · como CUIT de facturación de un negocio (business_cuits.cuit), sea
 *     principal o secundario
 *
 * Todo lo que dé de alta un CUIT tiene que pasar por acá: el registro de
 * cuentas y el alta de CUITs de facturación.
 */

const normalizar = (v) => String(v || '').replace(/\D/g, '');

/**
 * Busca quién está usando ese CUIT.
 *
 * @param {string} cuit
 * @param {object} excluir  { businessId } para ignorar al negocio actual,
 *                          { businessCuitId } para ignorar la fila que se edita
 * @returns {Promise<null|{ motivo, businessId, nombreNegocio }>}
 */
async function quienUsa(cuit, excluir = {}) {
  const limpio = normalizar(cuit);
  if (limpio.length !== 11) return null;

  // 1) ¿Es el CUIT de alguna cuenta?
  const whereCuenta = { cuit: limpio };
  if (excluir.businessId) whereCuenta.id = { [Op.ne]: excluir.businessId };
  const cuenta = await Business.findOne({
    where: whereCuenta,
    attributes: ['id', 'nombreNegocio'],
  });
  if (cuenta) {
    return { motivo: 'cuenta', businessId: cuenta.id, nombreNegocio: cuenta.nombreNegocio };
  }

  // 2) ¿Está cargado como CUIT de facturación en algún negocio?
  const whereFacturacion = { cuit: limpio };
  if (excluir.businessId) whereFacturacion.businessId = { [Op.ne]: excluir.businessId };
  if (excluir.businessCuitId) whereFacturacion.id = { [Op.ne]: excluir.businessCuitId };
  const facturacion = await BusinessCuit.findOne({
    where: whereFacturacion,
    include: [{ model: Business, attributes: ['id', 'nombreNegocio'] }],
  });
  if (facturacion) {
    return {
      motivo: facturacion.esPrincipal ? 'principal' : 'secundario',
      businessId: facturacion.businessId,
      nombreNegocio: facturacion.Business?.nombreNegocio || null,
    };
  }

  return null;
}

/**
 * Lanza si el CUIT ya está tomado. El mensaje no dice de qué negocio se trata:
 * revelar el nombre de otra cuenta a quien está registrándose filtraría datos
 * de un tercero.
 */
async function exigirLibre(cuit, excluir = {}) {
  const uso = await quienUsa(cuit, excluir);
  if (!uso) return;

  const mensaje = uso.motivo === 'cuenta'
    ? 'Ese CUIT ya tiene una cuenta en Stocker. Si es tuyo, iniciá sesión o recuperá la contraseña.'
    : 'Ese CUIT ya está cargado en otra cuenta de Stocker. Un CUIT sólo puede facturar desde un negocio.';

  throw Object.assign(new Error(mensaje), { status: 409 });
}

module.exports = { quienUsa, exigirLibre, normalizar };
