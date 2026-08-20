const { Op, fn, col } = require('sequelize');
const sequelize = require('../config/database');
const { Product, ProductVariant, StockMovement, Employee, BusinessLocation } = require('../models');
const { ilikeOperator } = require('../utils/sqlHelpers');
const { exportProductsXlsx, importProductsXlsx } = require('../services/productExcelService');
const { exigirCupo } = require('../services/planService');
const skuService = require('../services/skuService');
const { generarEtiquetas } = require('../services/labelService');
const stockService = require('../services/stockService');

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

          /*
           * Nacen en cero y sin fila de stock por local: la fila se crea sola
           * en el primer movimiento. Crear 3 locales × 40 variantes de entrada
           * son 120 filas en cero que no dicen nada.
           */
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
  } catch (error) { await t.rollback().catch(() => {}); next(error); }
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
    // El dueño escanea sin local asignado: va al principal.
    if (!locationId) locationId = await stockService.localPorDefecto(req.auth.businessId, t);

    const variant = await buscarPorCodigo(codigo, req.auth.businessId, t);
    if (!variant) {
      await t.rollback();
      return res.status(404).json({ message: `Ningún producto coincide con el código "${codigo}".` });
    }

    // El stock del LOCAL donde se está escaneando, no el total del negocio.
    const stockAnterior = await stockService.stockEn(variant.id, locationId, t);
    let stockNuevo;
    if (modo === 'agregar') {
      stockNuevo = stockAnterior + cant;
    } else if (modo === 'quitar') {
      // Mismo criterio que el ajuste manual: no se saca más de lo que hay.
      // Escaneando en el depósito el error es todavía más fácil de cometer,
      // porque se sostiene el lector y se repite la lectura sin mirar.
      if (cant > stockAnterior) {
        const total = Number(variant.stock) || 0;
        await t.rollback();
        return res.status(409).json({
          message: (stockAnterior === 0
            ? `${variant.producto.titulo} (${variant.sku}) ya está en cero en este local.`
            : `Sólo hay ${stockAnterior} de ${variant.producto.titulo} (${variant.sku}) en este local y estás quitando ${cant}.`)
            + (total > stockAnterior ? ` Hay ${total} en total entre todos los locales.` : ''),
          sku: variant.sku,
          disponible: stockAnterior,
          solicitado: cant,
        });
      }
      stockNuevo = stockAnterior - cant;
    } else {
      stockNuevo = cant;
    }

    const r = await stockService.mover({
      variantId: variant.id,
      businessId: req.auth.businessId,
      locationId,
      // Igual que en el ajuste manual: el modo "fijar" registra el stock final;
      // agregar y quitar registran lo que se movió.
      ...(modo === 'fijar' ? { fijar: cant } : { delta: stockNuevo - stockAnterior }),
      tipo: modo === 'agregar' ? 'ingreso' : modo === 'quitar' ? 'egreso' : 'ajuste',
      motivo: motivo || `Escaneo masivo (${modo})`,
      employeeId: req.auth.employeeId || null,
      transaction: t,
    });

    await t.commit();
    res.json({
      sku: variant.sku,
      titulo: variant.producto.titulo,
      variante: [variant.variante1Valor, variant.variante2Valor].filter(Boolean).join(' · ') || null,
      stockAnterior, stockNuevo,
      delta: stockNuevo - stockAnterior,
      locationId,
      total: r.total,
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

    const variant = await ProductVariant.create({
      productId: product.id, businessId: req.auth.businessId, sku: limpio,
      codigoBarras: codigoBarras || null,
      variante1Nombre, variante1Valor, variante2Nombre, variante2Valor,
      // El stock lo carga stockService abajo, para que quede asignado a un
      // local. Nace en cero y el movimiento inicial lo sube.
      stock: 0, stockMinimo,
    });

    /*
     * El stock con el que nace la variante también es un movimiento.
     *
     * Si no se anota, el libro muestra un producto con 40 unidades y ninguna
     * entrada que las explique: quien audita ve mercadería aparecida de la nada
     * y no puede distinguirla de un faltante mal cargado.
     */
    if (Number(stock) > 0) {
      await stockService.mover({
        variantId: variant.id,
        businessId: req.auth.businessId,
        // Sin local explícito va al principal: es donde se recibe la mercadería.
        locationId: req.body.locationId || null,
        delta: Number(stock),
        tipo: 'ingreso',
        motivo: 'Stock inicial de la variante',
        employeeId: req.auth.employeeId || null,
      });
      await variant.reload();
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

    /*
     * El ajuste es sobre un local concreto.
     *
     * Del cuerpo si lo aclara; si no, del local del empleado que lo hace; y si
     * es el dueño —que no tiene local asignado—, el principal. Antes esto no
     * hacía falta porque el stock era uno solo.
     */
    const local = locationId
      || (req.auth.employeeId
        ? (await Employee.findByPk(req.auth.employeeId, { attributes: ['locationId'], transaction: t }))?.locationId
        : null)
      || await stockService.localPorDefecto(req.auth.businessId, t);

    const stockAnterior = await stockService.stockEn(variant.id, local, t);
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
        const total = Number(variant.stock) || 0;
        await t.rollback();
        return res.status(409).json({
          // La salida siempre nombra el camino correcto. Decir sólo "no hay
          // stock" deja a quien está corrigiendo un conteo sin saber qué hacer.
          // Y ahora aclara que el faltante es de ESTE local: puede haber de
          // sobra en otro, y entonces lo que corresponde es transferir.
          message: (stockAnterior === 0
            ? `No queda stock de ${nombre} (${variant.sku}) en este local, así que no hay nada que sacar. `
            : `Sólo hay ${stockAnterior} de ${nombre} (${variant.sku}) en este local y estás sacando ${cantidad}. `) +
            (total > stockAnterior ? `Hay ${total} en total entre todos los locales: podés transferirlo. ` : '') +
            `Si el número que figura está mal, usá un ajuste de inventario.`,
          disponible: stockAnterior,
          totalOtrosLocales: total - stockAnterior,
          solicitado: cantidad,
        });
      }
      stockNuevo = stockAnterior - cantidad;
    } else {
      stockNuevo = cantidad; // ajuste directo: fija el stock contado
    }

    /*
     * Ingreso, egreso y devolución van por `delta`; el ajuste, por `fijar`.
     *
     * No es indistinto aunque el stock final sea el mismo: el movimiento
     * registra `cantidad`, y con `fijar` esa cantidad es el stock resultante.
     * Un ingreso de 5 sobre 20 quedaría anotado como "ingreso de 25" y el libro
     * de movimientos pasaría a decir cualquier cosa. Con `fijar` la cantidad
     * absoluta sí es lo correcto: un ajuste de inventario es "quedó en N".
     */
    const r = await stockService.mover({
      variantId: variant.id,
      businessId: req.auth.businessId,
      locationId: local,
      ...(tipo === 'ajuste' ? { fijar: stockNuevo } : { delta: stockNuevo - stockAnterior }),
      tipo,
      motivo: motivo || '',
      employeeId: req.auth.employeeId || null,
      transaction: t,
    });

    await t.commit();
    // `stockAnterior`/`stockNuevo` son del local; `total` es de la variante.
    res.json({ variant, stockAnterior, stockNuevo, tipo, locationId: local, total: r.total });
  } catch (error) { await t.rollback().catch(() => {}); next(error); }
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

/*
 * ── GET /api/stock/por-local ──────────────────────────────────────
 *
 * El stock de cada variante desglosado por local, más el total.
 *
 * Responde las tres preguntas juntas: cuánto hay en cada local, dónde está cada
 * cosa, y cuánto hay en total. Separarlas en tres pantallas obligaría a sumar a
 * mano para saber si conviene transferir o reponer.
 */
const getStockPorLocal = async (req, res, next) => {
  try {
    const { q, locationId, soloConStock, soloBajoMinimo } = req.query;
    const page  = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    const like = ilikeOperator();
    const whereVariante = { businessId: req.auth.businessId };
    if (q) {
      const texto = `%${String(q).trim()}%`;
      whereVariante[Op.or] = [
        { sku: { [like]: texto } },
        { codigoBarras: { [like]: texto } },
        { '$producto.titulo$': { [like]: texto } },
      ];
    }

    /*
     * Las variantes se paginan solas y el desglose se trae después, aparte.
     *
     * Traer `porLocal` como include junto con `limit` no funciona: Sequelize
     * aplica el límite a las filas del JOIN, no a las variantes, así que una
     * variante con stock en tres locales consume tres lugares de la página y
     * pierde los que no entran. Se veía como stock desaparecido — una
     * transferencia a Belgrano que la base tenía bien y la pantalla mostraba en
     * cero.
     */
    const { count, rows } = await ProductVariant.findAndCountAll({
      where: whereVariante,
      include: [
        { model: Product, as: 'producto', attributes: ['id', 'titulo', 'skuAgrupador', 'categoria'], required: true },
      ],
      order: [[{ model: Product, as: 'producto' }, 'titulo', 'ASC'], ['sku', 'ASC']],
      offset: (page - 1) * limit,
      limit,
      distinct: true,
      subQuery: false,
    });

    // Una sola consulta para el desglose de toda la página.
    const stockPorVariante = await stockService.desglosePorVariante(rows.map((v) => v.id), req.auth.businessId);

    const locales = await BusinessLocation.findAll({
      where: { businessId: req.auth.businessId },
      attributes: ['id', 'nombre', 'activo'],
      order: [['id', 'ASC']],
    });

    /*
     * Cada variante trae una entrada por local, incluso donde no tiene fila.
     *
     * Un local sin fila tiene cero, no "sin dato": mostrar la grilla completa
     * es lo que permite ver de un vistazo dónde falta. Con huecos habría que
     * cruzar mentalmente qué locales existen contra cuáles aparecen.
     */
    const data = rows.map((v) => {
      const porId = new Map((stockPorVariante.get(v.id) || []).map((p) => [p.locationId, p.stock]));
      const desglose = locales.map((l) => ({
        locationId: l.id, local: l.nombre, activo: l.activo,
        stock: porId.get(l.id) || 0,
      }));
      return {
        variantId: v.id,
        sku: v.sku,
        titulo: v.producto.titulo,
        skuAgrupador: v.producto.skuAgrupador,
        categoria: v.producto.categoria,
        variante1Valor: v.variante1Valor,
        variante2Valor: v.variante2Valor,
        stockMinimo: v.stockMinimo,
        total: Number(v.stock) || 0,
        porLocal: desglose,
      };
    });

    // Los filtros de "sólo con stock" y "bajo el mínimo" se aplican sobre el
    // resultado ya desglosado: dependen del local elegido, y expresar eso en
    // SQL con el include opcional daría una consulta difícil de sostener.
    let filtrados = data;
    if (locationId) {
      const id = Number(locationId);
      filtrados = filtrados.map((d) => ({ ...d, enLocal: d.porLocal.find((p) => p.locationId === id)?.stock ?? 0 }));
      if (soloConStock === 'true')   filtrados = filtrados.filter((d) => d.enLocal > 0);
      if (soloBajoMinimo === 'true') filtrados = filtrados.filter((d) => d.enLocal <= (d.stockMinimo ?? 0));
    } else {
      if (soloConStock === 'true')   filtrados = filtrados.filter((d) => d.total > 0);
      if (soloBajoMinimo === 'true') filtrados = filtrados.filter((d) => d.total <= (d.stockMinimo ?? 0));
    }

    res.json({
      data: filtrados,
      locales: locales.map((l) => ({ id: l.id, nombre: l.nombre, activo: l.activo })),
      total: count, page, limit,
    });
  } catch (error) { next(error); }
};

/*
 * ── GET /api/stock/por-local/productos ────────────────────────────
 *
 * Los productos padre de un local, con su stock ahí y su total.
 *
 * Es el primer nivel de la vista por local: se elige el local y se ven los
 * productos, no las variantes. Un catálogo de veinte productos con veinte
 * variantes cada uno son cuatrocientas filas — imposible de recorrer para
 * responder "¿qué tengo en Belgrano?".
 *
 * El detalle por variante se pide aparte, cuando se abre uno.
 */
const getProductosPorLocal = async (req, res, next) => {
  try {
    const locationId = Number(req.query.locationId) || null;
    const { q } = req.query;

    const locales = await BusinessLocation.findAll({
      where: { businessId: req.auth.businessId },
      attributes: ['id', 'nombre', 'activo'],
      order: [['id', 'ASC']],
    });
    if (locationId && !locales.some((l) => l.id === locationId)) {
      return res.status(404).json({ message: 'El local no pertenece a este negocio.' });
    }

    const like = ilikeOperator();
    const whereProducto = { businessId: req.auth.businessId, activo: true };
    if (q) {
      const texto = `%${String(q).trim()}%`;
      whereProducto[Op.or] = [
        { titulo: { [like]: texto } },
        { sku: { [like]: texto } },
        { skuAgrupador: { [like]: texto } },
        { categoria: { [like]: texto } },
      ];
    }

    const productos = await Product.findAll({
      where: whereProducto,
      attributes: ['id', 'titulo', 'sku', 'skuAgrupador', 'categoria', 'genero'],
      include: [{
        model: ProductVariant, as: 'productVariants',
        attributes: ['id', 'stock', 'stockMinimo'],
        required: false,
      }],
      order: [['titulo', 'ASC']],
    });

    // El desglose de todas las variantes de la página, en una consulta.
    const idsVariantes = productos.flatMap((p) => p.productVariants.map((v) => v.id));
    const desglose = await stockService.desglosePorVariante(idsVariantes, req.auth.businessId);

    const data = productos.map((p) => {
      let enLocal = 0;
      let total = 0;
      let variantesConStockAca = 0;
      for (const v of p.productVariants) {
        total += Number(v.stock) || 0;
        const filas = desglose.get(v.id) || [];
        const aca = locationId ? (filas.find((f) => f.locationId === locationId)?.stock || 0) : null;
        if (locationId) {
          enLocal += aca;
          if (aca > 0) variantesConStockAca++;
        }
      }
      return {
        productId: p.id,
        skuAgrupador: p.skuAgrupador,
        titulo: p.titulo,
        categoria: p.categoria,
        genero: p.genero,
        variantes: p.productVariants.length,
        // Cuánto hay en el local elegido y cuánto en todos los locales juntos:
        // las dos cifras juntas son las que dicen si conviene transferir.
        enLocal: locationId ? enLocal : null,
        total,
        variantesConStock: locationId ? variantesConStockAca : null,
      };
    });

    res.json({ data, locales: locales.map((l) => ({ id: l.id, nombre: l.nombre, activo: l.activo })) });
  } catch (error) { next(error); }
};

/*
 * ── GET /api/stock/por-local/producto/:id ─────────────────────────
 *
 * Las variantes de un producto con su stock en cada local.
 *
 * Segundo nivel: ya se sabe qué producto interesa y ahora se quiere ver dónde
 * está cada talle. Trae todos los locales, no sólo el elegido, porque la
 * pregunta que sigue a "no tengo el talle M acá" es "¿en qué local está?".
 */
const getVariantesPorLocal = async (req, res, next) => {
  try {
    const producto = await Product.findOne({
      where: { id: req.params.id, businessId: req.auth.businessId },
      attributes: ['id', 'titulo', 'sku', 'skuAgrupador', 'categoria'],
    });
    if (!producto) return res.status(404).json({ message: 'Producto no encontrado.' });

    const variantes = await ProductVariant.findAll({
      where: { productId: producto.id },
      attributes: ['id', 'sku', 'codigoBarras', 'variante1Nombre', 'variante1Valor', 'variante2Nombre', 'variante2Valor', 'stock', 'stockMinimo'],
      order: [['sku', 'ASC']],
    });

    const locales = await BusinessLocation.findAll({
      where: { businessId: req.auth.businessId },
      attributes: ['id', 'nombre', 'activo'],
      order: [['id', 'ASC']],
    });
    const desglose = await stockService.desglosePorVariante(variantes.map((v) => v.id), req.auth.businessId);

    res.json({
      producto: {
        id: producto.id, titulo: producto.titulo,
        skuAgrupador: producto.skuAgrupador, categoria: producto.categoria,
        total: variantes.reduce((s, v) => s + (Number(v.stock) || 0), 0),
      },
      locales: locales.map((l) => ({ id: l.id, nombre: l.nombre, activo: l.activo })),
      variantes: variantes.map((v) => {
        const filas = desglose.get(v.id) || [];
        const porId = new Map(filas.map((f) => [f.locationId, f.stock]));
        return {
          variantId: v.id, sku: v.sku,
          variante1Valor: v.variante1Valor, variante2Valor: v.variante2Valor,
          stockMinimo: v.stockMinimo,
          total: Number(v.stock) || 0,
          // Un local sin fila tiene cero, no "sin dato": la grilla se muestra
          // completa para poder ver de un vistazo dónde falta.
          porLocal: locales.map((l) => ({ locationId: l.id, local: l.nombre, stock: porId.get(l.id) || 0 })),
        };
      }),
    });
  } catch (error) { next(error); }
};

/*
 * ── POST /api/stock/transferir ────────────────────────────────────
 *
 * Mueve unidades de un local a otro. Queda como dos movimientos —una salida y
 * una entrada— porque es lo que se mira cuando la mercadería no aparece en el
 * destino.
 */
const transferirStock = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const { variantId, desde, hacia, cantidad, motivo } = req.body || {};

    const variant = await ProductVariant.findOne({
      where: { id: variantId, businessId: req.auth.businessId },
      include: [{ model: Product, as: 'producto', attributes: ['titulo'] }],
      transaction: t,
    });
    if (!variant) { await t.rollback(); return res.status(404).json({ message: 'Variante no encontrada.' }); }

    if (Number(desde) === Number(hacia)) {
      // Se comprueba antes que la existencia: con origen y destino iguales la
      // consulta devuelve un solo local y el error diría que no existe, que es
      // una pista falsa.
      await t.rollback();
      return res.status(400).json({ message: 'Elegí un local de origen y otro de destino distintos.' });
    }

    // Los dos locales tienen que ser de este negocio: sin esto se podría mandar
    // mercadería al local de otro cliente de Stocker.
    const locales = await BusinessLocation.findAll({
      where: { id: [Number(desde), Number(hacia)], businessId: req.auth.businessId },
      transaction: t,
    });
    if (locales.length !== 2) {
      await t.rollback();
      return res.status(404).json({ message: 'Alguno de los locales no existe en este negocio.' });
    }

    const r = await stockService.transferir({
      variantId: variant.id,
      businessId: req.auth.businessId,
      desde: Number(desde), hacia: Number(hacia),
      cantidad: Number(cantidad),
      employeeId: req.auth.employeeId || null,
      motivo,
      transaction: t,
    });

    await t.commit();
    res.json({ ok: true, sku: variant.sku, titulo: variant.producto.titulo, ...r });
  } catch (error) {
    await t.rollback().catch(() => {});
    if (error.status) return res.status(error.status).json({ message: error.message });
    next(error);
  }
};

/*
 * ── POST /api/stock/ajuste-masivo ─────────────────────────────────
 *
 * Ajusta el stock de varias variantes de una vez, en un solo pedido.
 *
 * Cargar mercadería variante por variante son veinte pedidos y veinte esperas
 * para descargar un remito: se tipea un número, se espera, la pantalla se
 * recarga y se pierde dónde estaba uno. Acá se cargan todas las cantidades y se
 * mandan juntas.
 *
 * Todo en una transacción: o entra el remito completo o no entra nada. Con
 * quince líneas aplicadas y una fallando, nadie sabría cuáles quedaron.
 */
const ajusteMasivo = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const { locationId, motivo, items } = req.body || {};
    const lineas = Array.isArray(items) ? items : [];
    if (!lineas.length) { await t.rollback(); return res.status(400).json({ message: 'No se mandó ninguna línea.' }); }
    if (lineas.length > 500) { await t.rollback(); return res.status(400).json({ message: 'Máximo 500 líneas por ajuste.' }); }

    const local = locationId
      ? Number(locationId)
      : (req.auth.employeeId
        ? (await Employee.findByPk(req.auth.employeeId, { attributes: ['locationId'], transaction: t }))?.locationId
        : null) || await stockService.localPorDefecto(req.auth.businessId, t);

    if (local) {
      const existe = await BusinessLocation.findOne({
        where: { id: local, businessId: req.auth.businessId }, transaction: t,
      });
      if (!existe) { await t.rollback(); return res.status(404).json({ message: 'El local no pertenece a este negocio.' }); }
    }

    // Todas las variantes de una, y filtradas por negocio: sin esto se podría
    // ajustar el stock de otro cliente de Stocker mandando sus ids.
    const ids = [...new Set(lineas.map((l) => Number(l.variantId)).filter(Boolean))];
    const variantes = await ProductVariant.findAll({
      where: { id: ids, businessId: req.auth.businessId },
      include: [{ model: Product, as: 'producto', attributes: ['titulo'] }],
      transaction: t,
    });
    const porId = new Map(variantes.map((v) => [v.id, v]));
    const faltan = ids.filter((id) => !porId.has(id));
    if (faltan.length) {
      await t.rollback();
      return res.status(404).json({ message: `No se encontraron ${faltan.length} de las variantes indicadas.` });
    }

    const resultados = [];
    for (const linea of lineas) {
      const v = porId.get(Number(linea.variantId));
      if (!v) continue;

      /*
       * Dos formas de cargar, según cómo piense el que la usa:
       *   · `delta`  — "entraron 6": lo natural al recibir un remito.
       *   · `fijar`  — "quedaron 24": lo natural al contar el inventario.
       *
       * Se registran con el tipo que corresponde, para que el libro de
       * movimientos distinga un ingreso de un recuento.
       */
      const tieneFijar = linea.fijar !== undefined && linea.fijar !== null && linea.fijar !== '';
      const delta = Number(linea.delta) || 0;
      if (!tieneFijar && delta === 0) continue;   // línea sin cambios: se saltea

      const actual = await stockService.stockEn(v.id, local, t);
      const destino = tieneFijar ? Number(linea.fijar) : actual + delta;

      if (destino < 0) {
        await t.rollback();
        return res.status(409).json({
          message: `${v.producto.titulo} (${v.sku}): hay ${actual} en el local y estás sacando ${Math.abs(delta)}. Ninguna línea se aplicó.`,
          sku: v.sku, disponible: actual,
        });
      }

      const r = await stockService.mover({
        variantId: v.id,
        businessId: req.auth.businessId,
        locationId: local,
        ...(tieneFijar ? { fijar: destino } : { delta }),
        tipo: tieneFijar ? 'ajuste' : (delta > 0 ? 'ingreso' : 'egreso'),
        motivo: motivo || 'Ajuste masivo',
        employeeId: req.auth.employeeId || null,
        transaction: t,
      });

      resultados.push({
        variantId: v.id, sku: v.sku,
        stockAnterior: r.stockAnterior, stockNuevo: r.stockNuevo, total: r.total,
      });
    }

    await t.commit();
    res.json({ ok: true, locationId: local, aplicadas: resultados.length, resultados });
  } catch (error) {
    await t.rollback().catch(() => {});
    if (error.status) return res.status(error.status).json({ message: error.message });
    next(error);
  }
};

/*
 * ── GET /api/stock/ingresos ───────────────────────────────────────
 *
 * Lo que entró en un día, por variante.
 *
 * Es para etiquetar mercadería recién recibida: al descargar un remito uno
 * quiere una etiqueta por unidad que ENTRÓ, no por unidad que hay. Si en el
 * local ya había 20 y entraron 6, imprimir por stock son 26 etiquetas y 20
 * prendas que hay que despegar.
 *
 * Qué entra en la cuenta:
 *
 *   · Ingresos y devoluciones suman.
 *   · Los egresos que NO vienen de una venta restan: son correcciones sobre la
 *     misma carga. Cargar 15 y después −1 porque una vino fallada es haber
 *     recibido 14, y hay que imprimir 14 etiquetas. Sumando sólo los ingresos
 *     el sistema pedía 15 y sobraba una.
 *   · Los egresos de ventas NO restan. Recibir 15 y vender una en el día sigue
 *     siendo haber recibido 15: la vendida también se etiquetó.
 *   · Los ajustes quedan afuera: un ajuste de inventario deja el stock en un
 *     número, no dice cuántas unidades llegaron.
 *
 * Lo que separa una venta de una corrección es `saleItemId`, que sólo llevan
 * los movimientos que nacieron de una venta.
 */
const getIngresosDelDia = async (req, res, next) => {
  try {
    const { fecha, locationId } = req.query;
    const dia = /^\d{4}-\d{2}-\d{2}$/.test(fecha || '') ? fecha : new Date().toISOString().slice(0, 10);
    const [a, m, d] = dia.split('-').map(Number);
    const desde = new Date(a, m - 1, d, 0, 0, 0, 0);
    const hasta = new Date(a, m - 1, d, 23, 59, 59, 999);

    const where = {
      fechaMovimiento: { [Op.gte]: desde, [Op.lte]: hasta },
      [Op.or]: [
        { tipo: { [Op.in]: ['ingreso', 'devolucion'] } },
        // Egresos que no son ventas: correcciones de la propia carga.
        { tipo: 'egreso', saleItemId: null },
      ],
    };
    if (locationId) where.locationId = Number(locationId);

    const movimientos = await StockMovement.findAll({
      where,
      include: [{
        association: 'variante',
        attributes: ['id', 'sku', 'codigoBarras', 'variante1Valor', 'variante2Valor'],
        required: true,
        // El filtro de negocio va en el include porque los movimientos no
        // tienen businessId: cuelgan de la variante.
        where: { businessId: req.auth.businessId },
        include: [{ association: 'producto', attributes: ['id', 'titulo', 'skuAgrupador'], required: true }],
      }, { association: 'local', attributes: ['id', 'nombre'], required: false }],
      order: [['fechaMovimiento', 'ASC']],
    });

    /*
     * Se agrupa por variante: si la misma prenda entró en dos remitos del mismo
     * día, lo que se quiere imprimir es la suma, no dos lotes separados.
     */
    const porVariante = new Map();
    for (const mv of movimientos) {
      const v = mv.variante;
      if (!porVariante.has(v.id)) {
        porVariante.set(v.id, {
          variantId: v.id, sku: v.sku,
          titulo: v.producto.titulo, skuAgrupador: v.producto.skuAgrupador,
          variante1Valor: v.variante1Valor, variante2Valor: v.variante2Valor,
          unidades: 0, movimientos: 0, locales: new Set(),
        });
      }
      const acum = porVariante.get(v.id);
      // El egreso resta: es una corrección sobre lo que se acaba de cargar.
      const signo = mv.tipo === 'egreso' ? -1 : 1;
      acum.unidades += signo * (Number(mv.cantidad) || 0);
      acum.movimientos += 1;
      if (mv.local?.nombre) acum.locales.add(mv.local.nombre);
    }

    /*
     * Una variante que quedó en cero o en negativo no se lista.
     *
     * Pasa cuando lo que entró se corrigió entero, o cuando el día tuvo sólo
     * bajas manuales. En los dos casos no hay nada que etiquetar, y ofrecer
     * cero etiquetas es ruido.
     */
    const data = [...porVariante.values()]
      .filter((x) => x.unidades > 0)
      .map((x) => ({ ...x, locales: [...x.locales] }));
    res.json({
      fecha: dia,
      data,
      totalUnidades: data.reduce((s, x) => s + x.unidades, 0),
    });
  } catch (error) { next(error); }
};

/*
 * ── POST /api/products/etiquetas ──────────────────────────────────
 *
 * Devuelve el PDF de etiquetas para las variantes pedidas.
 *
 * Es POST y no GET porque el cuerpo lleva una cantidad por variante: el uso
 * normal es "una etiqueta por unidad en stock", pero al recibir mercadería se
 * imprime por lo que entró, que no es lo que hay. Fijar la cantidad del lado
 * del cliente evita tener que inventar reglas acá.
 *
 * Cuerpo: { items: [{ variantId, cantidad }] }
 */
const generarEtiquetasPdf = async (req, res, next) => {
  try {
    const pedidos = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!pedidos.length) return res.status(400).json({ message: 'No se pidió ninguna etiqueta.' });

    const ids = [...new Set(pedidos.map((i) => Number(i.variantId)).filter(Boolean))];
    if (!ids.length) return res.status(400).json({ message: 'Las variantes son inválidas.' });

    /*
     * Las variantes se traen filtrando por negocio.
     *
     * No alcanza con que el pedido traiga ids: sin este filtro, mandar un id
     * ajeno imprimiría la etiqueta —con su SKU y su código de barras— de un
     * producto de otro cliente de Stocker.
     */
    const variantes = await ProductVariant.findAll({
      where: { id: ids, businessId: req.auth.businessId },
      include: [{ model: Product, as: 'producto', required: true, where: { businessId: req.auth.businessId } }],
    });

    const porId = new Map(variantes.map((v) => [v.id, v]));
    const faltan = ids.filter((id) => !porId.has(id));
    if (faltan.length) {
      return res.status(404).json({ message: `No se encontraron ${faltan.length} de las variantes pedidas.` });
    }

    // Se respeta el orden en que vinieron: el cliente los manda agrupados por
    // producto y ordenados por talle, y así sale el rollo.
    const items = pedidos
      .map((p) => ({
        variante: porId.get(Number(p.variantId)),
        cantidad: Number(p.cantidad) || 0,
      }))
      .filter((x) => x.variante && x.cantidad > 0)
      .map((x) => ({ producto: x.variante.producto, variante: x.variante, cantidad: x.cantidad }));

    const { doc, total } = generarEtiquetas(items);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="etiquetas-${total}.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    next(error);
  }
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
    // El local de destino puede venir en el formulario; si no, el principal.
    const summary = await importProductsXlsx(req.auth.businessId, req.file.buffer, {
      locationId: req.body?.locationId ? Number(req.body.locationId) : null,
    });
    res.json(summary);
  } catch (error) { next(error); }
};

module.exports = { getProducts, getProduct, createProduct, updateProduct, deleteProduct, addVariant, updateVariant, deleteVariant, adjustStock, getVariantMovements, getStockMovements, getStockPorLocal, getProductosPorLocal, getVariantesPorLocal, transferirStock, getIngresosDelDia, ajusteMasivo, generarEtiquetasPdf, exportProducts, importProducts, scanLookup, scanAdjustStock };
