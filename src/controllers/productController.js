const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { Product, ProductVariant, StockMovement } = require('../models');
const { ilikeOperator } = require('../utils/sqlHelpers');
const { exportProductsXlsx, importProductsXlsx } = require('../services/productExcelService');
const { exigirCupo } = require('../services/planService');

/*
 * Toma del body sólo los campos permitidos.
 *
 * Los `update(req.body)` y los spreads `{ ...req.body }` dejan que el cliente
 * escriba cualquier columna del modelo, incluida businessId. Con eso, alguien
 * con permiso de edición puede mover un registro a otro negocio o pisar el
 * businessId que el servidor acababa de fijar. Ver informe QA F-02.
 */
function soloCampos(body, permitidos) {
  const patch = {};
  for (const campo of permitidos) {
    if (body?.[campo] !== undefined) patch[campo] = body[campo];
  }
  return patch;
}

// productId nunca: movería la variante a otro producto, incluso de otro negocio.
const CAMPOS_PRODUCTO = ['sku', 'skuAgrupador', 'titulo', 'descripcion', 'precioMinorista',
  'precioMayorista', 'costo', 'variantes', 'modelo', 'categoria', 'genero', 'activo'];
const CAMPOS_VARIANTE = ['sku', 'codigoBarras', 'variante1Nombre', 'variante1Valor',
  'variante2Nombre', 'variante2Valor', 'stock', 'stockMinimo', 'activo'];


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
    if (search) {
      const like = ilikeOperator();
      where[Op.or] = [
        { titulo: { [like]: `%${search}%` } },
        { sku:    { [like]: `%${search}%` } },
        { skuAgrupador: { [like]: `%${search}%` } },
      ];
    }

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

    /*
     * Tope de SKUs del plan.
     *
     * Se cuenta antes de crear y por el total que va a generar este producto:
     * una matriz de 6 talles × 4 colores son 24 SKUs de una sola vez. Validando
     * de uno en uno el negocio terminaría por encima del tope.
     *
     * Un producto sin combinaciones igual ocupa uno: es la fila padre y el
     * escáner lo puede resolver por su propio SKU.
     */
    const claves = Object.keys(variantes);
    const aCrear = claves.length
      ? (variantes[claves[0]]?.length || 0) * (claves[1] ? (variantes[claves[1]]?.length || 1) : 1)
      : 0;
    await exigirCupo(req.auth.businessId, 'skus', Math.max(1, aCrear));

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

    await product.update({
      ...soloCampos(req.body, CAMPOS_PRODUCTO),
      fechaActualizacion: new Date(),
    });
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

// ── Escaneo con lector de barras ─────────────────────────────────
// Busca una variante por el código que devuelve el lector. Probamos primero
// el código de barras y después el SKU, así funciona tanto con etiquetas del
// proveedor (EAN) como con etiquetas propias impresas con el SKU.
async function buscarPorCodigo(codigo, businessId, transaction = null) {
  const limpio = String(codigo || '').trim();
  if (!limpio) return null;
  const opciones = {
    include: [{ model: Product, as: 'producto', where: { businessId } }],
    transaction,
  };
  return (
    await ProductVariant.findOne({ ...opciones, where: { codigoBarras: limpio } })
    || await ProductVariant.findOne({ ...opciones, where: { sku: limpio } })
  );
}

// ── GET /api/products/scan/:codigo ───────────────────────────────
// Identifica un producto a partir del código escaneado. Lo usa el punto de
// venta para ir sumando ítems al carrito.
const scanLookup = async (req, res, next) => {
  try {
    const variant = await buscarPorCodigo(req.params.codigo, req.auth.businessId);
    if (!variant) {
      return res.status(404).json({ message: `Ningún producto coincide con el código "${req.params.codigo}".` });
    }
    res.json({
      id: variant.id,
      sku: variant.sku,
      codigoBarras: variant.codigoBarras,
      titulo: variant.producto.titulo,
      skuAgrupador: variant.producto.skuAgrupador,
      variante1Nombre: variant.variante1Nombre,
      variante1Valor:  variant.variante1Valor,
      variante2Nombre: variant.variante2Nombre,
      variante2Valor:  variant.variante2Valor,
      stock: variant.stock,
      precioMinorista: Number(variant.producto.precioMinorista) || 0,
      precioMayorista: Number(variant.producto.precioMayorista) || 0,
    });
  } catch (error) { next(error); }
};

// ── POST /api/products/scan/stock ────────────────────────────────
// Modifica el stock de un producto escaneado. Pensado para uso continuo:
// el front manda un request por cada lectura del scanner.
//   modo "agregar" → suma      (recepción de mercadería)
//   modo "quitar"  → resta     (bajas, roturas)
//   modo "fijar"   → reemplaza (conteo de inventario)
const scanAdjustStock = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const { codigo, modo = 'agregar', cantidad = 1, motivo } = req.body;
    if (!['agregar', 'quitar', 'fijar'].includes(modo)) {
      await t.rollback();
      return res.status(400).json({ message: 'Modo inválido. Usá agregar, quitar o fijar.' });
    }
    const cant = Number(cantidad);
    if (!Number.isFinite(cant) || cant < 0 || (modo !== 'fijar' && cant <= 0)) {
      await t.rollback();
      return res.status(400).json({ message: 'Cantidad inválida.' });
    }

    const variant = await buscarPorCodigo(codigo, req.auth.businessId, t);
    if (!variant) {
      await t.rollback();
      return res.status(404).json({ message: `Ningún producto coincide con el código "${codigo}".` });
    }

    const stockAnterior = Number(variant.stock) || 0;
    let stockNuevo;
    if (modo === 'agregar') {
      stockNuevo = stockAnterior + cant;
    } else if (modo === 'quitar') {
      // Mismo criterio que el ajuste manual: no se saca más de lo que hay.
      // Escaneando en el depósito el error es todavía más fácil de cometer,
      // porque se sostiene el lector y se repite la lectura sin mirar.
      if (cant > stockAnterior) {
        await t.rollback();
        return res.status(409).json({
          message: stockAnterior === 0
            ? `${variant.producto.titulo} (${variant.sku}) ya está en cero.`
            : `Sólo hay ${stockAnterior} de ${variant.producto.titulo} (${variant.sku}) y estás quitando ${cant}.`,
          sku: variant.sku,
          disponible: stockAnterior,
          solicitado: cant,
        });
      }
      stockNuevo = stockAnterior - cant;
    } else {
      stockNuevo = cant;
    }

    await variant.update({ stock: stockNuevo }, { transaction: t });
    await StockMovement.create({
      productVariantId: variant.id,
      employeeId: req.auth.employeeId || null,
      tipo: modo === 'agregar' ? 'ingreso' : modo === 'quitar' ? 'egreso' : 'ajuste',
      cantidad: cant,
      stockAnterior,
      stockNuevo,
      motivo: motivo || `Escaneo masivo (${modo})`,
    }, { transaction: t });

    await t.commit();
    res.json({
      sku: variant.sku,
      titulo: variant.producto.titulo,
      variante: [variant.variante1Valor, variant.variante2Valor].filter(Boolean).join(' · ') || null,
      stockAnterior, stockNuevo,
      delta: stockNuevo - stockAnterior,
    });
  } catch (error) {
    await t.rollback().catch(() => {});
    next(error);
  }
};

// ── DELETE /api/products/variants/:variantId ─────────────────────
const deleteVariant = async (req, res, next) => {
  try {
    const variant = await ProductVariant.findByPk(req.params.variantId, { include: [{ model: Product, as: 'producto' }] });
    if (!variant || variant.producto.businessId !== req.auth.businessId)
      return res.status(404).json({ message: 'Variante no encontrada.' });
    await variant.destroy();
    res.status(204).send();
  } catch (error) { next(error); }
};

// ── POST /api/products/:id/variants ───────────────────────────────
const addVariant = async (req, res, next) => {
  try {
    const product = await Product.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!product) return res.status(404).json({ message: 'Producto no encontrado.' });

    await exigirCupo(req.auth.businessId, 'skus');

    const { sku, codigoBarras, variante1Nombre, variante1Valor, variante2Nombre, variante2Valor, stock = 0, stockMinimo = 5 } = req.body;
    const variant = await ProductVariant.create({ productId: product.id, sku, codigoBarras: codigoBarras || null, variante1Nombre, variante1Valor, variante2Nombre, variante2Valor, stock, stockMinimo });
    res.status(201).json(variant);
  } catch (error) { next(error); }
};

// ── PUT /api/products/variants/:variantId ─────────────────────────
const updateVariant = async (req, res, next) => {
  try {
    const variant = await ProductVariant.findByPk(req.params.variantId, { include: [{ model: Product, as: 'producto' }] });
    if (!variant || variant.producto.businessId !== req.auth.businessId)
      return res.status(404).json({ message: 'Variante no encontrada.' });
    await variant.update(soloCampos(req.body, CAMPOS_VARIANTE));
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

    // Postgres no soporta `FOR UPDATE` sobre LEFT OUTER JOIN. Lockeamos sólo
    // la tabla principal con { of: ProductVariant }; el include se resuelve
    // sin lock (Product no se modifica en esta operación de todos modos).
    const variant = await ProductVariant.findByPk(req.params.variantId, {
      include: [{ model: Product, as: 'producto' }],
      transaction: t,
      lock: { level: t.LOCK.UPDATE, of: ProductVariant },
    });
    if (!variant || variant.producto.businessId !== req.auth.businessId) {
      await t.rollback();
      return res.status(404).json({ message: 'Variante no encontrada.' });
    }

    const stockAnterior = Number(variant.stock) || 0;
    let stockNuevo;
    if (tipo === 'ingreso' || tipo === 'devolucion') {
      stockNuevo = stockAnterior + cantidad;
    } else if (tipo === 'egreso') {
      /*
       * No se puede sacar más de lo que hay.
       *
       * Antes esto era Math.max(0, stockAnterior - cantidad): recortaba a cero
       * en silencio. Pedir un egreso de 10 teniendo 3 dejaba el stock en 0 y el
       * movimiento anotando 10, así que el inventario y su propio historial
       * quedaban contradiciéndose y la diferencia sólo aparecía al contar a
       * mano. Si lo que se quiere es corregir el número, para eso está el
       * ajuste, que fija el stock y queda registrado como tal.
       */
      if (cantidad > stockAnterior) {
        const nombre = [variant.producto.titulo, variant.variante1Valor, variant.variante2Valor]
          .filter(Boolean).join(' · ');
        await t.rollback();
        return res.status(409).json({
          // La salida siempre nombra el camino correcto. Decir sólo "no hay
          // stock" deja a quien está corrigiendo un conteo sin saber qué hacer.
          message: (stockAnterior === 0
            ? `No queda stock de ${nombre} (${variant.sku}), así que no hay nada que sacar. `
            : `Sólo hay ${stockAnterior} de ${nombre} (${variant.sku}) y estás sacando ${cantidad}. `) +
            `Si el número que figura está mal, usá un ajuste de inventario.`,
          disponible: stockAnterior,
          solicitado: cantidad,
        });
      }
      stockNuevo = stockAnterior - cantidad;
    } else {
      stockNuevo = cantidad; // ajuste directo: fija el stock contado
    }

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
    /*
     * La planilla puede traer miles de filas. Acá sólo se comprueba que quede
     * al menos un lugar libre: cuántos SKUs nuevos trae el archivo se sabe
     * recién al parsearlo, y el servicio de importación es el que corta cuando
     * se llena. Sin este chequeo previo, una cuenta con el cupo agotado subiría
     * un archivo de 5 MB para que después se rechace fila por fila.
     */
    await exigirCupo(req.auth.businessId, 'skus');
    const summary = await importProductsXlsx(req.auth.businessId, req.file.buffer);
    res.json(summary);
  } catch (error) { next(error); }
};

module.exports = { getProducts, getProduct, createProduct, updateProduct, deleteProduct, addVariant, updateVariant, deleteVariant, adjustStock, getVariantMovements, exportProducts, importProducts, scanLookup, scanAdjustStock };
