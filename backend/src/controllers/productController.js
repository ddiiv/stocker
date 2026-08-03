const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { Product, ProductVariant, StockMovement } = require('../models');
const { exportProductsXlsx, importProductsXlsx } = require('../services/productExcelService');

// ── Helpers ────────────────────────────────────────────────────────
function validateVariantes(variantes) {
  if (!variantes || typeof variantes !== 'object') return null;
  const keys = Object.keys(variantes);
  if (keys.length > 2) return 'Máximo 2 dimensiones de variante.';
  for (const k of keys) {
    if (!Array.isArray(variantes[k])) return `La dimensión "${k}" debe ser un array.`;
    if (variantes[k].length > 20) return `La dimensión "${k}" puede tener máximo 20 valores.`;
  }
  return null;
}

// ── GET /api/products ──────────────────────────────────────────────
const getProducts = async (req, res, next) => {
  try {
    const { search, categoria, genero, page = 1, limit = 20 } = req.query;
    const where = { businessId: req.auth.businessId, activo: true };
    if (categoria) where.categoria = categoria;
    if (genero)    where.genero    = genero;
    if (search)    where[Op.or] = [
      { titulo: { [Op.like]: `%${search}%` } },
      { sku:    { [Op.like]: `%${search}%` } },
      { skuAgrupador: { [Op.like]: `%${search}%` } },
    ];

    const offset = (Math.max(1, Number(page)) - 1) * Math.min(Number(limit), 100);
    const { count, rows } = await Product.findAndCountAll({
      where, offset, limit: Math.min(Number(limit), 100),
      include: [{ model: ProductVariant, as: 'productVariants', where: { activo: true }, required: false }],
      order: [['titulo', 'ASC']],
      distinct: true,
    });

    res.json({ total: count, page: Number(page), totalPages: Math.ceil(count / limit), data: rows });
  } catch (error) { next(error); }
};

// ── GET /api/products/:id ──────────────────────────────────────────
const getProduct = async (req, res, next) => {
  try {
    const product = await Product.findOne({
      where: { id: req.params.id, businessId: req.auth.businessId },
      include: [{ model: ProductVariant, as: 'productVariants' }],
    });
    if (!product) return res.status(404).json({ message: 'Producto no encontrado.' });
    res.json(product);
  } catch (error) { next(error); }
};

// ── POST /api/products ─────────────────────────────────────────────
const createProduct = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const { sku, skuAgrupador, titulo, descripcion, precioMinorista, precioMayorista, costo, variantes = {}, modelo, categoria, genero } = req.body;

    const err = validateVariantes(variantes);
    if (err) { await t.rollback(); return res.status(400).json({ message: err }); }

    const product = await Product.create({
      businessId: req.auth.businessId,
      sku, skuAgrupador, titulo, descripcion,
      precioMinorista, precioMayorista, costo,
      variantes, modelo, categoria, genero,
      fechaActualizacion: new Date(),
    }, { transaction: t });

    // Auto-crear variantes si se pasaron combinaciones
    const keys = Object.keys(variantes);
    if (keys.length > 0) {
      const dim1 = variantes[keys[0]] || [];
      const dim2 = keys[1] ? variantes[keys[1]] : [null];

      for (const v1 of dim1) {
        for (const v2 of dim2) {
          const suffix = [v1, v2].filter(Boolean).join('').replace(/\s/g, '').toUpperCase().slice(0, 10);
          await ProductVariant.create({
            productId: product.id,
            sku: `${sku}-${suffix}`,
            variante1Nombre: keys[0], variante1Valor: v1,
            variante2Nombre: keys[1] || null, variante2Valor: v2 || null,
            stock: 0, stockMinimo: 5,
          }, { transaction: t });
        }
      }
    }

    await t.commit();
    const full = await Product.findByPk(product.id, { include: [{ model: ProductVariant, as: 'productVariants' }] });
    res.status(201).json(full);
  } catch (error) { await t.rollback(); next(error); }
};

// ── PUT /api/products/:id ──────────────────────────────────────────
const updateProduct = async (req, res, next) => {
  try {
    const product = await Product.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!product) return res.status(404).json({ message: 'Producto no encontrado.' });

    const { variantes } = req.body;
    if (variantes) {
      const err = validateVariantes(variantes);
      if (err) return res.status(400).json({ message: err });
    }

    await product.update({ ...req.body, fechaActualizacion: new Date() });
    const full = await Product.findByPk(product.id, { include: [{ model: ProductVariant, as: 'productVariants' }] });
    res.json(full);
  } catch (error) { next(error); }
};

// ── DELETE /api/products/:id (soft delete) ─────────────────────────
const deleteProduct = async (req, res, next) => {
  try {
    const product = await Product.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!product) return res.status(404).json({ message: 'Producto no encontrado.' });
    await product.update({ activo: false });
    res.status(204).send();
  } catch (error) { next(error); }
};

// ── POST /api/products/:id/variants ───────────────────────────────
const addVariant = async (req, res, next) => {
  try {
    const product = await Product.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!product) return res.status(404).json({ message: 'Producto no encontrado.' });

    const { sku, variante1Nombre, variante1Valor, variante2Nombre, variante2Valor, stock = 0, stockMinimo = 5 } = req.body;
    const variant = await ProductVariant.create({ productId: product.id, sku, variante1Nombre, variante1Valor, variante2Nombre, variante2Valor, stock, stockMinimo });
    res.status(201).json(variant);
  } catch (error) { next(error); }
};

// ── PUT /api/products/variants/:variantId ─────────────────────────
const updateVariant = async (req, res, next) => {
  try {
    const variant = await ProductVariant.findByPk(req.params.variantId, { include: [{ model: Product, as: 'producto' }] });
    if (!variant || variant.producto.businessId !== req.auth.businessId)
      return res.status(404).json({ message: 'Variante no encontrada.' });
    await variant.update(req.body);
    res.json(variant);
  } catch (error) { next(error); }
};

// ── PATCH /api/products/variants/:variantId/stock ─────────────────
// Ajuste manual de stock (ingreso, egreso, ajuste)
const adjustStock = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const { tipo, cantidad, motivo, locationId } = req.body;
    if (!['ingreso', 'egreso', 'ajuste', 'devolucion'].includes(tipo))
      return res.status(400).json({ message: 'Tipo de movimiento inválido.' });
    if (!cantidad || cantidad <= 0)
      return res.status(400).json({ message: 'La cantidad debe ser mayor a 0.' });

    const variant = await ProductVariant.findByPk(req.params.variantId, {
      include: [{ model: Product, as: 'producto' }],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!variant || variant.producto.businessId !== req.auth.businessId) {
      await t.rollback();
      return res.status(404).json({ message: 'Variante no encontrada.' });
    }

    const stockAnterior = variant.stock;
    let stockNuevo;
    if (tipo === 'ingreso' || tipo === 'devolucion') stockNuevo = stockAnterior + cantidad;
    else if (tipo === 'egreso')  stockNuevo = Math.max(0, stockAnterior - cantidad);
    else stockNuevo = cantidad; // ajuste directo

    await variant.update({ stock: stockNuevo }, { transaction: t });
    await StockMovement.create({
      productVariantId: variant.id,
      locationId: locationId || null,
      employeeId: req.auth.employeeId || null,
      tipo, cantidad, stockAnterior, stockNuevo,
      motivo: motivo || '',
      fechaMovimiento: new Date(),
    }, { transaction: t });

    await t.commit();
    res.json({ variant, stockAnterior, stockNuevo, tipo });
  } catch (error) { await t.rollback(); next(error); }
};

// ── GET /api/products/variants/:variantId/movements ───────────────
const getVariantMovements = async (req, res, next) => {
  try {
    const variant = await ProductVariant.findByPk(req.params.variantId, { include: [{ model: Product, as: 'producto' }] });
    if (!variant || variant.producto.businessId !== req.auth.businessId)
      return res.status(404).json({ message: 'Variante no encontrada.' });

    const movements = await StockMovement.findAll({
      where: { productVariantId: variant.id },
      include: [{ association: 'empleado', attributes: ['id', 'nombre', 'apellido'] }, { association: 'local', attributes: ['id', 'nombre'] }],
      order: [['fechaMovimiento', 'DESC']],
      limit: 100,
    });
    res.json(movements);
  } catch (error) { next(error); }
};

// ── GET /api/products/export ────────────────────────────────────────
const exportProducts = async (req, res, next) => {
  try {
    const buffer = await exportProductsXlsx(req.auth.businessId);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="productos.xlsx"',
    });
    res.send(Buffer.from(buffer));
  } catch (error) { next(error); }
};

// ── POST /api/products/import ───────────────────────────────────────
const importProducts = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Falta el archivo .xlsx a importar.' });
    const summary = await importProductsXlsx(req.auth.businessId, req.file.buffer);
    res.json(summary);
  } catch (error) { next(error); }
};

module.exports = { getProducts, getProduct, createProduct, updateProduct, deleteProduct, addVariant, updateVariant, adjustStock, getVariantMovements, exportProducts, importProducts };
