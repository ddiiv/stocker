const errorHandler = (err, req, res, next) => {
  console.error('[ERROR]', err.message || err);

  if (err.name === 'SequelizeValidationError' || err.name === 'SequelizeUniqueConstraintError') {
    return res.status(400).json({
      message: 'Error de validación',
      errors: err.errors?.map((e) => e.message),
    });
  }

  res.status(err.status || 500).json({ message: err.message || 'Error interno del servidor' });
};

const notFound = (req, res) => {
  res.status(404).json({ message: `Ruta no encontrada: ${req.method} ${req.originalUrl}` });
};

module.exports = { errorHandler, notFound };
