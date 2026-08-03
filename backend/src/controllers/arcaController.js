const arcaLookup = require('../services/arcaLookupService');

const lookupCuit = async (req, res, next) => {
  try {
    const data = await arcaLookup.lookupCuit(req.params.cuit);
    if (!data.valido) return res.status(400).json({ message: 'CUIT inválido.', ...data });
    res.json(data);
  } catch (error) { next(error); }
};

module.exports = { lookupCuit };
