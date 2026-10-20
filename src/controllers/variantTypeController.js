const { Op } = require('sequelize');
const { VariantType, Business, Product } = require('../models');
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

/*
 * ── Categorías y géneros ────────────────────────────────────────
 *
 * Las listas de donde se eligen al cargar un producto, para no escribirlas a
 * mano cada vez (y no terminar con "Remeras", "remera" y "Remera " como tres
 * categorías). Viven en el negocio, con la misma limpieza que los valores de
 * una variante. Los productos guardan el texto, como siempre: la planilla y la
 * tienda pueden seguir mandando uno que no esté en la lista.
 */
const LISTAS = { categorias: { campo: 'categoria', max: 80 }, generos: { campo: 'genero', max: 40 } };

// GET /api/catalogo/listas → { categorias: [], generos: [] }
const listas = async (req, res, next) => {
  try {
    const negocio = await Business.findByPk(req.auth.businessId, { attributes: ['categorias', 'generos'] });
    const salida = {};
    for (const [lista, { campo }] of Object.entries(LISTAS)) {
      let valores = null;
      try { valores = JSON.parse(negocio?.[lista] || 'null'); } catch { /* se arma de nuevo abajo */ }
      if (!Array.isArray(valores)) {
        // Nunca se cargó: arranca con las que ya usan los productos del negocio.
        const filas = await Product.findAll({
          where: { businessId: req.auth.businessId }, attributes: [campo], group: [campo], raw: true,
        });
        valores = limpiarValores(filas.map((f) => f[campo]).filter(Boolean)).sort((a, b) => a.localeCompare(b, 'es'));
      }
      salida[lista] = valores;
    }
    res.json(salida);
  } catch (e) { next(e); }
};

// PUT /api/catalogo/listas  { categorias?: [], generos?: [] }
const guardarListas = async (req, res, next) => {
  try {
    const patch = {};
    for (const [lista, { max }] of Object.entries(LISTAS)) {
      const valores = req.body?.[lista];
      if (valores === undefined) continue;
      if (!Array.isArray(valores)) return res.status(400).json({ message: `"${lista}" tiene que ser una lista.` });
      const limpios = limpiarValores(valores);
      const largo = limpios.find((v) => v.length > max);
      if (largo) return res.status(400).json({ message: `"${largo}" pasa de ${max} caracteres.` });
      patch[lista] = JSON.stringify(limpios);
    }
    await Business.update(patch, { where: { id: req.auth.businessId } });
    return listas(req, res, next);
  } catch (e) { next(e); }
};

module.exports = { list, create, update, remove, listas, guardarListas };
