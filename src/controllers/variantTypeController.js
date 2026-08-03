const { VariantType } = require('../models');

// GET /api/variant-types
const list = async (req, res, next) => {
  try {
    const rows = await VariantType.findAll({
      where: { businessId: req.auth.businessId },
      order: [['nombre', 'ASC']],
    });
    res.json(rows);
  } catch (e) { next(e); }
};

// POST /api/variant-types  { nombre, valores: [] }
const create = async (req, res, next) => {
  try {
    const { nombre, valores = [] } = req.body;
    if (!nombre?.trim()) return res.status(400).json({ message: 'El nombre es obligatorio.' });
    if (!Array.isArray(valores)) return res.status(400).json({ message: 'Los valores deben ser un array.' });
    const clean = [...new Set(valores.map((v) => String(v).trim()).filter(Boolean))].slice(0, 200);
    const vt = await VariantType.create({ businessId: req.auth.businessId, nombre: nombre.trim(), valores: clean });
    res.status(201).json(vt);
  } catch (e) { next(e); }
};

// PUT /api/variant-types/:id
const update = async (req, res, next) => {
  try {
    const vt = await VariantType.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!vt) return res.status(404).json({ message: 'Variante no encontrada.' });
    const { nombre, valores } = req.body;
    const patch = {};
    if (nombre !== undefined) patch.nombre = String(nombre).trim();
    if (valores !== undefined) {
      if (!Array.isArray(valores)) return res.status(400).json({ message: 'Los valores deben ser un array.' });
      patch.valores = [...new Set(valores.map((v) => String(v).trim()).filter(Boolean))].slice(0, 200);
    }
    await vt.update(patch);
    res.json(vt);
  } catch (e) { next(e); }
};

// DELETE /api/variant-types/:id
const remove = async (req, res, next) => {
  try {
    const vt = await VariantType.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!vt) return res.status(404).json({ message: 'Variante no encontrada.' });
    await vt.destroy();
    res.status(204).send();
  } catch (e) { next(e); }
};

module.exports = { list, create, update, remove };
