const sequelize = require('../config/database');
const feriaService = require('../services/feriaService');
const { Product, ProductVariant } = require('../models');

/*
 * Catálogo de feria: generación y consulta.
 *
 * La venta en sí no pasa por acá — un producto de feria se vende con el punto
 * de venta de siempre, escaneando su código. Lo que vive en este controlador es
 * el trabajo de preparar ese catálogo una vez.
 */

// GET /api/feria/candidatos?prefijo=FER
const getCandidatos = async (req, res, next) => {
  try {
    const data = await feriaService.candidatos(req.auth.businessId, req.query?.prefijo);
    data.hayPuestos = await feriaService.tienePuestos(req.auth.businessId);
    res.json(data);
  } catch (error) { next(error); }
};

// POST /api/feria/generar
const postGenerar = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const { productIds, prefijo, precio } = req.body || {};
    const r = await feriaService.generar({
      businessId: req.auth.businessId, productIds, prefijo, precio, transaction: t,
    });
    await t.commit();

    const partes = [];
    if (r.creados.length) partes.push(`${r.creados.length} producto(s) de feria generado(s)`);
    if (r.omitidos.length) partes.push(`${r.omitidos.length} sin generar`);
    res.status(201).json({ ...r, mensaje: partes.join(' · ') || 'No había nada para generar.' });
  } catch (error) {
    await t.rollback().catch(() => {});
    next(error);
  }
};

// GET /api/feria/productos
const getProductos = async (req, res, next) => {
  try {
    const productos = await Product.findAll({
      where: { businessId: req.auth.businessId, esFeria: true },
      include: [{ model: ProductVariant, as: 'productVariants', attributes: ['id', 'sku', 'activo'] }],
      order: [['titulo', 'ASC']],
    });
    res.json(productos.map((p) => ({
      id: p.id,
      sku: p.sku,
      titulo: p.titulo,
      categoria: p.categoria,
      precio: Number(p.precioMinorista) || 0,
      precioMayorista: Number(p.precioMayorista) || 0,
      costo: Number(p.costo) || 0,
      activo: p.activo,
      origenProductId: p.origenProductId,
      variantId: p.productVariants?.[0]?.id || null,
    })));
  } catch (error) { next(error); }
};

// POST /api/feria/precios  → recalcula los precios de productos ya generados
const postPrecios = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const { productIds, precio } = req.body || {};
    const r = await feriaService.reaplicarPrecios({
      businessId: req.auth.businessId, productIds, precio, transaction: t,
    });
    await t.commit();
    res.json({
      ...r,
      mensaje: r.actualizados.length
        ? `${r.actualizados.length} producto(s) con precios actualizados.`
        : 'No se actualizó ninguno.',
    });
  } catch (error) {
    await t.rollback().catch(() => {});
    next(error);
  }
};

module.exports = { getCandidatos, postGenerar, getProductos, postPrecios };
