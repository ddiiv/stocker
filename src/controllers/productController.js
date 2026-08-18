const { Op, fn, col } = require('sequelize');
const sequelize = require('../config/database');
const { Product, ProductVariant, StockMovement, Employee } = require('../models');
const { ilikeOperator } = require('../utils/sqlHelpers');
const { exportProductsXlsx, importProductsXlsx } = require('../services/productExcelService');
const { exigirCupo } = require('../services/planService');
const skuService = require('../services/skuService');

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

      /*
       * Los SKU salen de la regla del negocio, y cada uno se comprueba libre
       * antes de insertarlo.
       *
       * Antes se armaban pegando los valores y cortando a 10 caracteres. Ese
       * corte hacía chocar combinaciones perfectamente legítimas —"Azul
       * Marino"/XL y "Azul Marino"/XXL daban las dos AZULMARINO— y como el SKU
       * tiene índice único, el alta entera se caía con un error que nombraba el
       * índice de la base. El usuario veía "Error de validación" al crear un
       * producto normal y no tenía forma de saber qué cambiar.
       *
       * `liberar` numera el repetido en vez de reventar. No es la solución de
       * fondo —para eso está la pantalla de confección, que muestra los choques
       * y deja corregir la abreviatura— pero evita que un choque impida cargar
       * la mercadería.
       */
      const regla = await skuService.reglaDe(req.auth.businessId);
      const usados = new Set();

      for (const v1 of dim1) {
        for (const v2 of dim2) {
          const valores = [
            { eje: keys[0], valor: v1 },
            ...(keys[1] && v2 ? [{ eje: keys[1], valor: v2 }] : []),
          ];
          const base = skuService.componer({ agrupador: sku, valores, regla });

          // `usados` cubre los choques dentro de esta misma alta: las filas
          // anteriores todavía no están confirmadas y la consulta no las ve.
          let libre = base;
          if (usados.has(libre)) {
            for (let i = 2; i <= 50 && usados.has(libre); i++) libre = `${base}-${i}`;
          }
          libre = await skuService.liberar(req.auth.businessId, libre);
          if (!libre) {
            await t.rollback();
            return res.status(409).json({
              message: `No se pudo generar un SKU único para ${[v1, v2].filter(Boolean).join(' · ')}. `
                + `Revisá las abreviaturas en Stock → Confección de SKU.`,
            });
          }
          usados.add(libre);

          await ProductVariant.create({
            productId: product.id,
            businessId: req.auth.businessId,
            sku: libre,
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

    /*
     * De qué local es el movimiento.
     *
     * El escaneo se hace caminando el local con el celular, así que el lugar es
     * el del empleado que escanea. Antes esto quedaba en null y el registro no
     * podía responder "a dónde" justo en el flujo donde más se pregunta.
     * El dueño no tiene local asignado; ahí sigue en null, que es lo honesto.
     */
    let locationId = req.body.locationId || null;
    if (!locationId && req.auth.employeeId) {
      const emp = await Employee.findByPk(req.auth.employeeId, { attributes: ['locationId'], transaction: t });
      locationId = emp?.locationId || null;
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
      locationId,
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

    const limpio = String(sku || '').trim();
    if (!limpio) return res.status(400).json({ message: 'El SKU es obligatorio.' });
    if (!await skuService.estaLibre(req.auth.businessId, limpio)) {
      return res.status(409).json({ message: `El SKU ${limpio} ya lo usa otra variante de este negocio.` });
    }

    const variant = await ProductVariant.create({ productId: product.id, businessId: req.auth.businessId, sku: limpio, codigoBarras: codigoBarras || null, variante1Nombre, variante1Valor, variante2Nombre, variante2Valor, stock, stockMinimo });

    /*
     * El stock con el que nace la variante también es un movimiento.
     *
     * Si no se anota, el libro muestra un producto con 40 unidades y ninguna
     * entrada que las explique: quien audita ve mercadería aparecida de la nada
     * y no puede distinguirla de un faltante mal cargado.
     */
    if (Number(stock) > 0) {
      await StockMovement.create({
        productVariantId: variant.id,
        employeeId: req.auth.employeeId || null,
        tipo: 'ingreso',
        cantidad: Number(stock),
        stockAnterior: 0,
        stockNuevo: Number(stock),
        motivo: 'Stock inicial de la variante',
        fechaMovimiento: new Date(),
      });
    }

    res.status(201).json(variant);
  } catch (error) { next(error); }
};

// ── PUT /api/products/variants/:variantId ─────────────────────────
const updateVariant = async (req, res, next) => {
  try {
    const variant = await ProductVariant.findByPk(req.params.variantId, { include: [{ model: Product, as: 'producto' }] });
    if (!variant || variant.producto.businessId !== req.auth.businessId)
      return res.status(404).json({ message: 'Variante no encontrada.' });

    /*
     * El SKU se puede editar a mano, pero tiene que quedar libre en el negocio.
     *
     * La restricción existe en la base y sola alcanzaría para no corromper
     * nada; el problema es lo que se ve al chocar: "uq_variants_business_sku
     * must be unique". Comprobarlo acá permite decir cuál es el SKU repetido y
     * en qué producto está, que es lo que hace falta para resolverlo.
     */
    const nuevoSku = req.body?.sku !== undefined ? String(req.body.sku).trim() : null;
    if (nuevoSku !== null && nuevoSku !== variant.sku) {
      if (!nuevoSku) return res.status(400).json({ message: 'El SKU no puede quedar vacío.' });

      const ocupada = await ProductVariant.findOne({
        where: { businessId: req.auth.businessId, sku: nuevoSku, id: { [Op.ne]: variant.id } },
        include: [{ model: Product, as: 'producto', attributes: ['titulo'] }],
      });
      if (ocupada) {
        return res.status(409).json({
          message: `El SKU ${nuevoSku} ya lo usa ${ocupada.producto?.titulo || 'otro producto'}`
            + `${[ocupada.variante1Valor, ocupada.variante2Valor].filter(Boolean).length
              ? ` (${[ocupada.variante1Valor, ocupada.variante2Valor].filter(Boolean).join(' · ')})` : ''}.`,
        });
      }
    }

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

/*
 * ── GET /api/stock/movimientos ────────────────────────────────────
 *
 * El libro de movimientos del negocio: quién tocó el stock, de qué producto,
 * cuánto, en qué local y cuándo.
 *
 * A diferencia del historial por variante, que responde "qué pasó con este
 * producto", éste responde "qué pasó en el depósito". Es la consulta que se
 * hace cuando falta mercadería y hay que reconstruir el día.
 *
 * StockMovement no tiene businessId: cuelga de la variante, que cuelga del
 * producto. Por eso el include del producto va con `required: true` y el filtro
 * de negocio adentro — es lo único que separa un negocio de otro acá, así que
 * no puede quedar en un `where` de afuera que un include mal armado ignore.
 */
const getStockMovements = async (req, res, next) => {
  try {
    const { desde, hasta, tipo, employeeId, locationId, q } = req.query;
    const page  = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    const where = {};
    if (tipo && ['ingreso', 'egreso', 'ajuste', 'devolucion'].includes(tipo)) where.tipo = tipo;

    /*
     * El rango llega como fechas sueltas ("2026-08-31") y acá se compara contra
     * un timestamp, no contra un DATEONLY como en ventas.
     *
     * Tomado literal, "hasta 2026-08-31" es la medianoche de ese día y se
     * pierde el día entero: un movimiento de las 22:16 del 31 no entra en "este
     * mes". Por eso el extremo se estira al final del día.
     *
     * Se arma con los componentes locales del servidor y no con `new Date(str)`
     * a secas, porque una fecha sin hora se interpreta como UTC: en Argentina
     * eso corre el corte tres horas y se cuela el día siguiente.
     */
    const limite = (valor, finDelDia) => {
      const soloFecha = /^\d{4}-\d{2}-\d{2}$/.test(valor);
      if (!soloFecha) return new Date(valor);
      const [a, m, d] = valor.split('-').map(Number);
      return finDelDia
        ? new Date(a, m - 1, d, 23, 59, 59, 999)
        : new Date(a, m - 1, d, 0, 0, 0, 0);
    };

    if (desde || hasta) {
      where.fechaMovimiento = {};
      if (desde) where.fechaMovimiento[Op.gte] = limite(desde, false);
      if (hasta) where.fechaMovimiento[Op.lte] = limite(hasta, true);
    }

    // 'dueno' es su propia opción: el dueño no es un empleado y sus movimientos
    // quedan con employeeId en null. Sin esto no habría forma de aislarlos.
    if (employeeId === 'dueno') where.employeeId = null;
    else if (employeeId) where.employeeId = Number(employeeId);

    if (locationId === 'sin') where.locationId = null;
    else if (locationId) where.locationId = Number(locationId);

    const like = ilikeOperator();
    if (q) {
      const texto = `%${q.trim()}%`;
      where[Op.or] = [
        { motivo: { [like]: texto } },
        { '$variante.sku$': { [like]: texto } },
        { '$variante.codigoBarras$': { [like]: texto } },
        { '$variante.producto.titulo$': { [like]: texto } },
      ];
    }

    const include = [
      {
        association: 'variante',
        attributes: ['id', 'sku', 'codigoBarras', 'variante1Nombre', 'variante1Valor', 'variante2Nombre', 'variante2Valor'],
        required: true,
        include: [{
          association: 'producto',
          attributes: ['id', 'titulo', 'skuAgrupador'],
          required: true,
          where: { businessId: req.auth.businessId },
        }],
      },
      { association: 'empleado', attributes: ['id', 'nombre', 'apellido'], required: false },
      { association: 'local',    attributes: ['id', 'nombre'],             required: false },
    ];

    const { count, rows } = await StockMovement.findAndCountAll({
      where, include,
      order: [['fechaMovimiento', 'DESC'], ['id', 'DESC']],
      offset: (page - 1) * limit,
      limit,
      // Con includes anidados y limit, Sequelize agrupa mal el conteo si no se
      // le dice que las filas son distintas.
      distinct: true,
      subQuery: false,
    });

    /*
     * Los totales son de todo el filtro, no de la página.
     *
     * Sumar las cincuenta filas visibles daría el movimiento de una página y no
     * el del mes, que es lo que se está preguntando.
     *
     * Va en una sola consulta agrupada por tipo. Con `sum()` por tipo harían
     * falta tres, y además Sequelize le agrega al agregado las columnas del
     * join —que SQL Server rechaza por no estar en el GROUP BY—, así que
     * tampoco era una opción.
     *
     * Los includes van con `attributes: []` a propósito: se necesita el join
     * para filtrar por negocio, no sus columnas.
     */
    const porTipo = await StockMovement.findAll({
      where,
      include: include.map((i) => (i.association === 'variante'
        ? { ...i, attributes: [], include: [{ ...i.include[0], attributes: [] }] }
        : { ...i, attributes: [] })),
      attributes: ['tipo', [fn('SUM', col('cantidad')), 'unidades']],
      group: ['StockMovement.tipo'],
      raw: true,
    });
    const unidades = (t) => Number(porTipo.find((r) => r.tipo === t)?.unidades) || 0;
    const ingresos = unidades('ingreso') + unidades('devolucion');
    const egresos  = unidades('egreso');

    res.json({
      data: rows,
      total: count, page, limit,
      resumen: {
        movimientos: count,
        unidadesIngreso: ingresos,
        unidadesEgreso: egresos,
        neto: ingresos - egresos,
        // El ajuste fija el stock en lugar de sumarlo o restarlo, así que su
        // cantidad no es comparable con las otras y no entra en el neto. Se
        // informa aparte para que el número no desaparezca sin explicación.
        ajustes: porTipo.find((r) => r.tipo === 'ajuste') ? unidades('ajuste') : 0,
      },
    });
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

module.exports = { getProducts, getProduct, createProduct, updateProduct, deleteProduct, addVariant, updateVariant, deleteVariant, adjustStock, getVariantMovements, getStockMovements, exportProducts, importProducts, scanLookup, scanAdjustStock };
