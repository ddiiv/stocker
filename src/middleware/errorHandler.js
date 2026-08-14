const { log } = require('../utils/logger');

/*
 * Manejo central de errores.
 *
 * Dos cuidados acá:
 *
 * 1. Al log no puede ir el mensaje crudo de Sequelize: en un error de base
 *    viene el SQL con los valores adentro (emails, CUITs, hashes), y termina
 *    guardado en los logs de Railway.
 *
 * 2. Al cliente tampoco. Antes se devolvía `err.message` tal cual, así que
 *    provocando errores a propósito se podía ir mapeando el esquema de la
 *    base. Los mensajes pensados para el usuario son los que el código marca
 *    con `err.status`; el resto es un fallo inesperado y se responde genérico.
 */

// Errores de base traen el SQL en el mensaje. Nos quedamos con el nombre del
// error, que dice qué pasó sin decir con qué datos.
function mensajeSeguro(err) {
  if (err?.name?.startsWith('Sequelize')) {
    return `${err.name}${err.original?.code ? ` (${err.original.code})` : ''}`;
  }
  return err?.message || 'error desconocido';
}

const errorHandler = (err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 500;

  // La ruta ubica el problema en el proyecto; los params/body nunca se loguean.
  const contexto = { ruta: `${req.method} ${req.route?.path || req.path}`, status };
  if (status >= 500) log.error('http', mensajeSeguro(err), contexto);
  else log.warn('http', mensajeSeguro(err), contexto);

  if (err.name === 'SequelizeValidationError' || err.name === 'SequelizeUniqueConstraintError') {
    // Los mensajes de validación de Sequelize son de campo ("email debe ser
    // único"), no traen el valor: se pueden mostrar.
    return res.status(400).json({
      message: 'Error de validación',
      errors: err.errors?.map((e) => e.message),
    });
  }

  // Sólo se devuelve el texto original cuando el código lo eligió a propósito.
  const paraElUsuario = err.status
    ? (err.message || 'Error en la operación')
    : 'Error interno del servidor';

  // `detalles` deja que un error deliberado acompañe datos que la pantalla
  // necesita para ofrecer una salida — por ejemplo, el turno de caja que quedó
  // abierto, para poder cerrarlo desde el mismo aviso. Sólo viaja en errores
  // con status explícito: nunca en un fallo inesperado.
  const cuerpo = { message: paraElUsuario };
  if (err.status && err.detalles && typeof err.detalles === 'object') {
    Object.assign(cuerpo, err.detalles);
  }

  res.status(status).json(cuerpo);
};

const notFound = (req, res) => {
  res.status(404).json({ message: `Ruta no encontrada: ${req.method} ${req.path}` });
};

module.exports = { errorHandler, notFound };
