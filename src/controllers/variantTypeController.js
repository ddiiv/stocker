const { Op } = require('sequelize');
const { VariantType } = require('../models');
const { ilikeOperator } = require('../utils/sqlHelpers');

/*
 * Limpia una lista de valores.
 *
 * El duplicado se detecta sin distinguir mayúsculas ni acentos: "Rojo", "rojo"
 * y "ROJO" son el mismo color, y dejarlos convivir arruina justamente lo que
 * depende de esta lista — la confección de SKU les daría el mismo código y
 * después chocarían al crear el producto. Se conserva la primera forma escrita,
 * que es la que el usuario eligió.
 */
function limpiarValores(valores) {
  const vistos = new Map();
  for (const v of valores) {
    const texto = String(v).trim();
    if (!texto) continue;
    const clave = texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (!vistos.has(clave)) vistos.set(clave, texto);
  }
  return [...vistos.values()].slice(0, 200);
}

/*
 * ¿Ya hay un tipo de variante con este nombre?
 *
 * Dos "Color" en la lista no se distinguen en ningún desplegable, y las
 * abreviaturas de SKU se guardan por nombre de eje: con el nombre repetido, la
 * excepción cargada para uno se aplicaría también al otro.
 */
async function nombreRepetido(businessId, nombre, exceptoId = null) {
  const where = { businessId, nombre: { [ilikeOperator()]: nombre.trim() } };
  if (exceptoId) where.id = { [Op.ne]: exceptoId };
  return await VariantType.count({ where }) > 0;
}

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
    if (nombre.trim().length > 80) return res.status(400).json({ message: 'El nombre no puede pasar de 80 caracteres.' });
    if (await nombreRepetido(req.auth.businessId, nombre)) {
      return res.status(409).json({ message: `Ya tenés una variante llamada "${nombre.trim()}".` });
    }
    const clean = limpiarValores(valores);
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
    if (nombre !== undefined) {
      const limpio = String(nombre).trim();
      if (!limpio) return res.status(400).json({ message: 'El nombre es obligatorio.' });
      if (limpio.length > 80) return res.status(400).json({ message: 'El nombre no puede pasar de 80 caracteres.' });
      if (await nombreRepetido(req.auth.businessId, limpio, vt.id)) {
        return res.status(409).json({ message: `Ya tenés otra variante llamada "${limpio}".` });
      }
      patch.nombre = limpio;
    }
    if (valores !== undefined) {
      if (!Array.isArray(valores)) return res.status(400).json({ message: 'Los valores deben ser un array.' });
      patch.valores = limpiarValores(valores);
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
