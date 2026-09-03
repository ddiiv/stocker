const { Op, fn, col } = require('sequelize');
const sequelize = require('../config/database');
const { Product, ProductVariant, StockMovement, Employee, BusinessLocation, VariantStock } = require('../models');
const { NO_ES_FERIA } = require('../utils/feria');
const { ilikeOperator } = require('../utils/sqlHelpers');
const { exportProductsXlsx, importProductsXlsx } = require('../services/productExcelService');
const { exigirCupo } = require('../services/planService');
const skuService = require('../services/skuService');
const { generarEtiquetas } = require('../services/labelService');
const stockService = require('../services/stockService');
const precioService = require('../services/precioService');

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
  'variante2Nombre', 'variante2Valor', 'stock', 'stockMinimo', 'activo',
  // Precios propios: null vuelve a heredar el del producto.
  'precioMinorista', 'precioMayorista', 'costo'];


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

/*
 * Tope de las columnas de dinero.
 *
 * Todas son DECIMAL(12,2): diez dígitos enteros y dos decimales. Un número
 * más grande no da un error de validación, da un desborde en la base — un 500
 * con "Error interno del servidor" en la cara del que estaba cargando un
 * producto. Se corta acá, con el número dicho.
 */
const MAX_MONEDA = 9999999999.99;

const PRECIOS = {
  costo: 'El costo',
  precioMinorista: 'El precio minorista',
  precioMayorista: 'El precio mayorista',
  costoVariante: 'El costo de la variante',
  precioMinoristaVariante: 'El precio minorista de la variante',
  precioMayoristaVariante: 'El precio mayorista de la variante',
  precio: 'El precio',
};

/**
 * Revisa los importes que vengan en el cuerpo.
 *
 * Sólo mira los que están presentes: un campo ausente es "no lo toques", que
 * es distinto de "ponelo en cero". Que el precio de venta exista o no lo
 * decide `faltantesDeProducto`, que sólo corre en el alta.
 */
function validarPrecios(cuerpo) {
  for (const [campo, nombre] of Object.entries(PRECIOS)) {
    const crudo = cuerpo?.[campo];
    if (crudo === undefined || crudo === null || crudo === '') continue;

    const n = Number(crudo);
    if (!Number.isFinite(n)) return `${nombre} tiene que ser un número.`;
    if (n < 0) return `${nombre} no puede ser negativo.`;
    if (n > MAX_MONEDA) {
      return `${nombre} no puede pasar de ${MAX_MONEDA.toLocaleString('es-AR')}. `
        + 'Si el número es correcto, revisá que no se haya colado un cero de más.';
    }
  }

  return null;
}

/*
 * Lo que un producto necesita sí o sí, en un solo mensaje.
 *
 * Van juntos a propósito: con el cuerpo vacío, contestar sólo "falta el
 * precio" manda a alguien a cargar el precio para que después le falte el
 * título, y el título para que le falte el SKU. Se dice todo de una.
 *
 * El precio está en la lista porque un producto sin precio se puede vender
 * en $ 0 sin que nada avise.
 */
function faltantesDeProducto(cuerpo) {
  const falta = [];
  if (!String(cuerpo?.titulo || '').trim()) falta.push('el título');
  if (!String(cuerpo?.sku || '').trim()) falta.push('el SKU padre');
  if (!String(cuerpo?.skuAgrupador || '').trim()) falta.push('el SKU agrupador');

  const p = Number(cuerpo?.precioMinorista);
  if (!Number.isFinite(p) || p <= 0) falta.push('el precio minorista');

  if (!falta.length) return null;
  const lista = falta.length === 1 ? falta[0] : `${falta.slice(0, -1).join(', ')} y ${falta[falta.length - 1]}`;
  return `${falta.length === 1 ? 'Falta' : 'Faltan'} ${lista}.`
    + (falta.includes('el precio minorista') ? ' Sin precio el producto se puede vender en $ 0.' : '');
}

// ── GET /api/products ──────────────────────────────────────────────
const getProducts = async (req, res, next) => {
  try {
    const { search, categoria, genero, page = 1, limit = 20, feria } = req.query;
    const where = { businessId: req.auth.businessId, activo: true };
    /*
     * Los de feria no se mezclan con el catálogo normal.
     *
     * Tienen su propia pantalla porque son otra cosa: sin variantes, sin stock
     * y con otro precio. Metidos acá duplicarían la lista —un "Loan Pantalón"
     * normal y otro de feria— y las columnas de stock quedarían en cero sin que
     * eso signifique nada.
     */
    /*
     * Las condiciones se acumulan y se juntan con AND al final.
     *
     * No es una preferencia de estilo: excluir los de evento y buscar por texto
     * son las DOS un `Op.or`, y las dos se escribían en `where[Op.or]`. La
     * segunda pisaba a la primera, así que apenas alguien escribía algo en el
     * buscador del catálogo normal, el filtro de "no es de evento" desaparecía
     * y aparecían mezclados. Sin buscar andaba bien, que es lo que hacía que
     * costara verlo.
     *
     * En la solapa de evento no pasaba porque ésa usa `esFeria`, una clave
     * suelta que la búsqueda no toca.
     */
    const condiciones = [];

    if (feria === '1' || feria === 'true') where.esFeria = true;
    else condiciones.push(NO_ES_FERIA);
    if (categoria) where.categoria = categoria;
    if (genero)    where.genero    = genero;
    if (search) {
      const like = ilikeOperator();
      const texto = `%${String(search).trim()}%`;

      /*
       * También se busca por el SKU y el código de barras de las variantes.
       *
       * Es como se busca en la práctica: lo que está impreso en la etiqueta de
       * la prenda es el SKU de la variante, no el del producto padre. Buscando
       * "BA-010-BEIGEM" —que es lo que uno tiene en la mano— la lista no
       * devolvía nada, y había que adivinar el nombre del producto.
       *
       * Va como subconsulta y no como filtro sobre el include: con `limit`, un
       * include de tipo hasMany hace que Sequelize aplique el límite a las
       * filas del JOIN, y un producto de veinte variantes se comería la página
       * entera.
       */
      const conVariante = await ProductVariant.findAll({
        where: {
          businessId: req.auth.businessId,
          [Op.or]: [{ sku: { [like]: texto } }, { codigoBarras: { [like]: texto } }],
        },
        attributes: ['productId'],
        group: ['productId'],
      });
      const idsPorVariante = conVariante.map((v) => v.productId);

      condiciones.push({
        [Op.or]: [
          { titulo: { [like]: texto } },
          { sku:    { [like]: texto } },
          { skuAgrupador: { [like]: texto } },
          ...(idsPorVariante.length ? [{ id: { [Op.in]: idsPorVariante } }] : []),
        ],
      });
    }

    if (condiciones.length) where[Op.and] = condiciones;

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

/*
 * ── GET /api/products/buscar-variantes ────────────────────────────
 *
 * Busca VARIANTES para agregar a una venta o cotización.
 *
 * Devuelve variantes y no productos, que es la diferencia que importa: el
 * buscador anterior encontraba el producto y desplegaba sus nueve variantes,
 * así que escribir el SKU exacto de la que se tenía en la mano igual obligaba a
 * buscarla entre las otras ocho.
 *
 * La consulta se parte en palabras y todas tienen que aparecer en algún lado
 * —título, categoría, color, talle, SKU o código de barras—. Eso es lo que hace
 * que "buzo beige m" encuentre justo esa combinación, que es como se busca
 * cuando el cliente la tiene puesta y no hay etiqueta a mano.
 */
const buscarVariantes = async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ data: [] });

    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 25));
    const locationId = Number(req.query.locationId) || null;
    const like = ilikeOperator();

    /*
     * Cada palabra por separado, y todas tienen que estar.
     *
     * Buscando la frase entera, "buzo beige m" no encuentra nada: no hay ningún
     * campo que contenga esas tres palabras juntas y en ese orden. Partiéndola,
     * cada una matchea donde corresponde y la intersección deja la variante
     * exacta.
     */
    const palabras = q.split(/\s+/).filter(Boolean).slice(0, 6);
    const condicionesPorPalabra = palabras.map((palabra) => {
      const texto = `%${palabra}%`;
      return {
        [Op.or]: [
          { sku: { [like]: texto } },
          { codigoBarras: { [like]: texto } },
          { variante1Valor: { [like]: texto } },
          { variante2Valor: { [like]: texto } },
          { '$producto.titulo$': { [like]: texto } },
          { '$producto.categoria$': { [like]: texto } },
          { '$producto.skuAgrupador$': { [like]: texto } },
        ],
      };
    });

    /*
     * Depósito y reposición no quieren ver los productos de evento.
     *
     * Un producto de evento no lleva stock por diseño: no se puede ingresar al
     * depósito ni pedir para reponer. Que aparezca en esos buscadores es una
     * invitación a cargar algo que después no se va a poder mover, y el error
     * se descubre recién al confirmar.
     *
     * Va como parámetro y no como filtro fijo porque el mismo endpoint lo usa
     * el punto de venta, que SÍ necesita encontrarlos: en un local de evento se
     * venden justamente esos.
     *
     * El filtro se mete bajo `Op.and` y no suelto. `NO_ES_FERIA` es un `Op.or`,
     * y el `where` del producto podría tener el suyo: volcarlo con spread haría
     * que uno pise al otro en silencio. Ya pasó en el listado de productos.
     */
    const sinEvento = req.query.sinEvento === '1' || req.query.sinEvento === 'true';
    const dondeProducto = sinEvento
      ? { activo: true, [Op.and]: [NO_ES_FERIA] }
      : { activo: true };

    const variantes = await ProductVariant.findAll({
      where: { businessId: req.auth.businessId, activo: true, [Op.and]: condicionesPorPalabra },
      include: [{
        model: Product, as: 'producto', required: true,
        where: dondeProducto,
        attributes: ['id', 'titulo', 'skuAgrupador', 'categoria', 'precioMinorista', 'precioMayorista', 'costo', 'esFeria'],
      }],
      limit,
      subQuery: false,
    });

    // El stock en el local de la venta: es lo que decide si se puede vender.
    const desglose = locationId
      ? await stockService.desglosePorVariante(variantes.map((v) => v.id), req.auth.businessId)
      : new Map();

    const data = variantes.map((v) => {
      const enLocal = locationId
        ? ((desglose.get(v.id) || []).find((f) => f.locationId === locationId)?.stock ?? 0)
        : null;
      return {
        id: v.id,
        sku: v.sku,
        codigoBarras: v.codigoBarras,
        titulo: v.producto.titulo,
        skuAgrupador: v.producto.skuAgrupador,
        categoria: v.producto.categoria,
        productId: v.producto.id,
        // El punto de venta lo necesita para avisar antes de intentar la venta:
        // un artículo de feria sólo se vende en un puesto de feria.
        esFeria: Boolean(v.producto.esFeria),
        variante1Nombre: v.variante1Nombre, variante1Valor: v.variante1Valor,
        variante2Nombre: v.variante2Nombre, variante2Valor: v.variante2Valor,
        stock: Number(v.stock) || 0,
        enLocal,
        // Los precios de la variante si los tiene; si no, los del producto.
        ...precioService.resumenDe(v, v.producto),
      };
    });

    /*
     * Orden: primero lo que coincide exactamente, después por título.
     *
     * Quien tipea un SKU completo espera esa fila arriba, no en el medio de una
     * lista alfabética.
     */
    const exacto = q.toLowerCase();
    data.sort((a, b) => {
      const pa = a.sku.toLowerCase() === exacto || a.codigoBarras === q ? 0 : 1;
      const pb = b.sku.toLowerCase() === exacto || b.codigoBarras === q ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return `${a.titulo}${a.sku}`.localeCompare(`${b.titulo}${b.sku}`, 'es');
    });

    res.json({ data });
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

// ── GET /api/products/sku/:skuV ─────────────────────────────────────
const getProductPadreBySkuVariante = async (req, res, next) => {
  try {
    const product = await Product.findOne({
        where :{ sku: req.params.skuV, businessId: req.auth.businessId },
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

    const err = faltantesDeProducto(req.body) || validateVariantes(variantes) || validarPrecios(req.body);
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
    const err = (variantes ? validateVariantes(variantes) : null) || validarPrecios(req.body);
    if (err) return res.status(400).json({ message: err });

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
  /*
   * Sólo lo que sigue en el catálogo.
   *
   * Dar de baja un producto lo apaga a él y no a sus variantes, así que sin
   * este filtro el lector seguía encontrándolas: la prenda desaparecía de todas
   * las pantallas y aun así se podía escanear y vender en el mostrador, con el
   * stock saliendo de un producto que el negocio dio por discontinuado.
   */
  const opciones = {
    include: [{ model: Product, as: 'producto', where: { businessId, activo: true }, required: true }],
    where: { activo: true },
    transaction,
  };
  return (
    await ProductVariant.findOne({ ...opciones, where: { ...opciones.where, codigoBarras: limpio } })
    || await ProductVariant.findOne({ ...opciones, where: { ...opciones.where, sku: limpio } })
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
    /*
     * Stock en el local que pregunta, además del total.
     *
     * En el punto de venta la mercadería sale de un local concreto: mostrar el
     * total hace creer que hay unidades cuando están en la otra sucursal.
     */
    const locationId = Number(req.query.locationId) || null;

    /*
     * Un artículo de feria no tiene stock que consultar.
     *
     * Preguntarlo devolvería cero y el punto de venta mostraría "sin stock"
     * sobre algo que se vende igual. Se responde null, que es lo honesto: no es
     * que no haya, es que no se lleva la cuenta.
     */
    const esFeria = Boolean(variant.producto.esFeria);
    const enLocal = locationId && !esFeria
      ? await stockService.stockEn(variant.id, locationId)
      : null;
    res.json({
      id: variant.id,
      sku: variant.sku,
      codigoBarras: variant.codigoBarras,
      titulo: variant.producto.titulo,
      skuAgrupador: variant.producto.skuAgrupador,
      // Lo mira el punto de venta para mostrar el cartel de feria y para no
      // pedir talle ni color, que estos productos no tienen.
      esFeria,
      variante1Nombre: variant.variante1Nombre,
      variante1Valor:  variant.variante1Valor,
      variante2Nombre: variant.variante2Nombre,
      variante2Valor:  variant.variante2Valor,
      stock: variant.stock,
      enLocal,
      // Los de la variante si los tiene; si no, los del producto.
      ...precioService.resumenDe(variant),
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
     * el del empleado que escanea. El dueño no tiene local asignado y cae en el
     * principal, que es donde el resolvedor termina cuando no hay nada mejor.
     */
    const locationId = await stockService.resolverLocal({
      locationId: req.body.locationId, businessId: req.auth.businessId,
      employeeId: req.auth.employeeId, transaction: t,
    });

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
/*
 * POST /api/products/:id/variants/masivo
 *
 * Alta de variantes tomando los valores de la tabla maestra del negocio.
 *
 * Cargar talle por talle a mano es lo que más tiempo lleva de todo el alta de
 * un producto, y es donde aparecen los SKU escritos distinto. Acá se eligen los
 * valores y el servidor arma la combinatoria.
 *
 * Dos reglas, que son las que hacen que esto se pueda usar sin miedo:
 *
 *   - No borra nada. Destildar un valor que ya tiene variante no la elimina:
 *     sólo deja de proponerla. Sacar mercadería del catálogo es una decisión
 *     que se toma variante por variante, no de rebote.
 *   - No duplica. Toda combinación que ya exista en el producto se omite, se
 *     compare como se compare — "Beige" y "beige" son el mismo color.
 *
 * Siempre devuelve el plan (`aCrear` y `omitidas`). Con `confirmar: true`
 * además lo ejecuta, así lo que se muestra en pantalla es exactamente lo que se
 * va a grabar y no dos cálculos parecidos.
 */
const clave = (v) => String(v ?? '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const agregarVariantesMasivo = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const product = await Product.findOne({
      where: { id: req.params.id, businessId: req.auth.businessId },
      transaction: t,
    });
    if (!product) { await t.rollback(); return res.status(404).json({ message: 'Producto no encontrado.' }); }

    const { ejes = [], stock = 0, stockMinimo = 5, confirmar = false, manuales = [] } = req.body;
    if (!Array.isArray(ejes) || ejes.length === 0) {
      await t.rollback();
      return res.status(400).json({ message: 'Elegí al menos un valor para generar variantes.' });
    }
    if (ejes.length > 2) {
      await t.rollback();
      return res.status(400).json({ message: 'Un producto se organiza con hasta dos atributos.' });
    }

    const limpios = ejes.map((e) => ({
      nombre: String(e.nombre || '').trim(),
      valores: [...new Set((e.valores || []).map((v) => String(v).trim()).filter(Boolean))],
    }));
    if (limpios.some((e) => !e.nombre || e.valores.length === 0)) {
      await t.rollback();
      return res.status(400).json({ message: 'Cada atributo necesita un nombre y al menos un valor elegido.' });
    }

    /*
     * Los ejes tienen que ser los del producto.
     *
     * Un producto que se diferencia por Color y Talle no puede recibir una
     * variante por Sabor: la fila quedaría con un atributo que ninguna otra
     * tiene y las pantallas que agrupan por eje la mostrarían suelta.
     */
    const existentes = await ProductVariant.findAll({
      where: { productId: product.id }, transaction: t,
    });
    const referencia = existentes[0];
    if (referencia) {
      const propios = [referencia.variante1Nombre, referencia.variante2Nombre].filter(Boolean).map(clave);
      const intrusos = limpios.map((e) => e.nombre).filter((n) => !propios.includes(clave(n)));
      if (intrusos.length) {
        await t.rollback();
        return res.status(400).json({
          message: `Este producto se organiza por ${propios.length === 2 ? `${referencia.variante1Nombre} y ${referencia.variante2Nombre}` : referencia.variante1Nombre}. `
            + `No se le pueden agregar variantes por ${intrusos.join(', ')}.`,
        });
      }
      // En el orden del producto, no en el que llegó: el eje 1 del producto
      // tiene que seguir siendo el eje 1 de las variantes nuevas.
      limpios.sort((a, b) => propios.indexOf(clave(a.nombre)) - propios.indexOf(clave(b.nombre)));
    }

    // Combinatoria. Con un solo eje, una fila por valor.
    const [eje1, eje2] = limpios;
    const combos = [];
    for (const v1 of eje1.valores) {
      if (eje2) { for (const v2 of eje2.valores) combos.push([{ eje: eje1.nombre, valor: v1 }, { eje: eje2.nombre, valor: v2 }]); }
      else combos.push([{ eje: eje1.nombre, valor: v1 }]);
    }

    // Lo que ya está, por combinación de valores.
    const yaEstan = new Map();
    for (const v of existentes) {
      yaEstan.set([clave(v.variante1Valor), clave(v.variante2Valor)].join('|'), v);
    }

    const regla = await skuService.reglaDe(req.auth.businessId);

    /*
     * Los SKU se resuelven contra TODO el negocio y contra el propio lote.
     *
     * Son únicos por negocio —hay un índice que lo impone—, así que no alcanza
     * con que no se repitan dentro de este producto: el mismo código puede
     * estar en otro. Y `estaLibre` consulta la base, que todavía no ve lo que
     * se está por crear acá, así que el lote se lleva aparte: "Verde" y "Verde
     * Agua" dan las dos VER y sin esto la segunda inserción moriría contra el
     * índice.
     *
     * Se resuelve también cuando sólo se pide la vista previa. Si no, la
     * pantalla mostraba un SKU y se grababa otro numerado.
     */
    const delLote = new Set();
    const resolverSku = async (base) => {
      const raiz = String(base).trim().slice(0, 90);
      for (const intento of [raiz, ...Array.from({ length: 49 }, (_, i) => `${raiz}-${i + 2}`)]) {
        if (delLote.has(intento)) continue;
        if (await skuService.estaLibre(req.auth.businessId, intento)) { delLote.add(intento); return intento; }
      }
      return null;
    };

    /*
     * SKU escritos a mano, por combinación.
     *
     * Cuando la regla choca, numerar es una salida de apuro: BA-010-VERS-2 no
     * le dice nada a quien lo lee en la etiqueta. La otra salida es escribirlo
     * —VAGS, el que el negocio hubiera elegido—, y tiene que poder hacerse acá
     * mismo, sin salir a configurar la regla y volver.
     *
     * Se validan igual que los automáticos: contra todo el negocio y contra el
     * propio lote. Un SKU a mano no es una excepción a la unicidad; es sólo
     * otra forma de elegirlo.
     */
    const aMano = new Map();
    // Cada valor puede venir como { eje, valor } o como texto suelto: la clave
    // se arma con el valor, nunca con el objeto.
    const valorDe = (v) => (v && typeof v === 'object' ? v.valor : v);
    for (const m of Array.isArray(manuales) ? manuales : []) {
      const vals = Array.isArray(m?.valores) ? m.valores : [];
      const texto = String(m?.sku ?? '').trim();
      if (!texto) continue;
      aMano.set([clave(valorDe(vals[0])), clave(valorDe(vals[1]))].join('|'), texto);
    }

    const aCrear = [];
    const omitidas = [];
    for (const combo of combos) {
      const k = [clave(combo[0]?.valor), clave(combo[1]?.valor)].join('|');
      const previa = yaEstan.get(k);
      const etiqueta = combo.map((c) => c.valor).join(' · ');
      if (previa) { omitidas.push({ etiqueta, sku: previa.sku, motivo: 'ya existe' }); continue; }

      const base = skuService.componer({ agrupador: product.skuAgrupador || product.sku, valores: combo, regla });
      const escrito = aMano.get(k);

      if (escrito) {
        /*
         * El motivo del rechazo se distingue, porque se arreglan distinto: uno
         * es cambiar el texto, el otro es cambiar el que está más arriba en la
         * misma tabla.
         */
        let motivo = null;
        if (escrito.length > 100) motivo = 'Más de 100 caracteres.';
        else if (delLote.has(escrito)) motivo = 'Repetido con otra fila de esta misma tabla.';
        else if (!await skuService.estaLibre(req.auth.businessId, escrito)) motivo = 'Ya lo usa otra variante del negocio.';

        if (!motivo) delLote.add(escrito);
        aCrear.push({
          etiqueta, valores: combo, sku: escrito, skuBase: base,
          manual: true, choca: false,
          libre: !motivo, motivo,
        });
        continue;
      }

      const sku = await resolverSku(base);
      aCrear.push({
        etiqueta,
        valores: combo,
        sku,
        /*
         * `choca` avisa que la regla produjo un código ya tomado y hubo que
         * numerarlo. Es la señal para escribirlo a mano o cargar una
         * abreviatura, en vez de quedarse con el número.
         */
        choca: Boolean(sku) && sku !== base,
        skuBase: base,
        manual: false,
        libre: Boolean(sku),
        motivo: sku ? null : 'La regla no encontró ningún código libre.',
      });
    }

    if (!confirmar) {
      await t.rollback();
      return res.json({ aCrear, omitidas });
    }
    if (!aCrear.length) {
      await t.rollback();
      return res.status(409).json({ message: 'Todas las combinaciones elegidas ya existen en este producto.', aCrear, omitidas });
    }

    await exigirCupo(req.auth.businessId, 'skus', aCrear.length);

    /*
     * Con stock inicial hay que saber a qué local entra, y se resuelve antes de
     * crear nada: rechazarlo después dejaría medio lote cargado.
     */
    let destino = req.body.locationId || null;
    if (Number(stock) > 0) {
      const activos = await BusinessLocation.findAll({
        where: { businessId: req.auth.businessId, activo: true }, order: [['id', 'ASC']], transaction: t,
      });
      if (destino) {
        if (!activos.some((l) => String(l.id) === String(destino))) {
          await t.rollback();
          return res.status(400).json({ message: 'El local indicado no pertenece a este negocio o está inactivo.' });
        }
      } else if (activos.length === 1) destino = activos[0].id;
      else if (activos.length > 1) {
        await t.rollback();
        return res.status(400).json({ message: 'Elegí a qué local entra el stock inicial.' });
      }
    }

    /*
     * Nada se graba si algún SKU no sirve.
     *
     * Ni el escrito a mano que choca ni el automático que se quedó sin
     * variantes libres. Crear la mitad del lote dejaría al usuario con un
     * producto a medio armar y sin saber cuáles entraron.
     */
    const invalida = aCrear.find((f) => !f.sku || f.libre === false);
    if (invalida) {
      await t.rollback();
      return res.status(409).json({
        message: `El SKU de ${invalida.etiqueta} no se puede usar: ${invalida.motivo || 'no hay ninguno libre.'}`,
        etiqueta: invalida.etiqueta,
        sku: invalida.sku,
      });
    }

    const creadas = [];
    for (const fila of aCrear) {
      const v = await ProductVariant.create({
        productId: product.id, businessId: req.auth.businessId, sku: fila.sku,
        codigoBarras: null,
        variante1Nombre: fila.valores[0]?.eje || null, variante1Valor: fila.valores[0]?.valor || null,
        variante2Nombre: fila.valores[1]?.eje || null, variante2Valor: fila.valores[1]?.valor || null,
        stock: 0, stockMinimo,
      }, { transaction: t });
      creadas.push({ id: v.id, sku: v.sku, etiqueta: fila.etiqueta });
    }

    await t.commit();

    /*
     * El stock inicial va después del commit, y cada uno como movimiento.
     *
     * Sin la entrada anotada, el libro muestra unidades aparecidas de la nada y
     * quien audita no puede distinguirlas de un faltante mal cargado.
     */
    if (Number(stock) > 0) {
      for (const c of creadas) {
        await stockService.mover({
          variantId: c.id, businessId: req.auth.businessId, locationId: destino,
          delta: Number(stock), tipo: 'ingreso',
          motivo: 'Stock inicial de la variante',
          employeeId: req.auth.employeeId || null,
        });
      }
    }

    res.status(201).json({ creadas, omitidas });
  } catch (error) {
    await t.rollback().catch(() => {});
    next(error);
  }
};

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

    /*
     * Con stock inicial hay que decir a qué local entra, y se resuelve ANTES de
     * crear la variante.
     *
     * Validándolo después, un rechazo dejaba la variante ya creada en cero: el
     * usuario ve un error, vuelve a intentar y se encuentra con que el SKU "ya
     * existe" — el que acaba de crear él mismo sin querer.
     *
     * Con un solo local no hay ambigüedad. Con varios, mandarlo al principal
     * por descarte carga la mercadería en una sucursal donde no está, y eso
     * después se busca a mano contra la góndola.
     */
    let destino = req.body.locationId || null;
    if (Number(stock) > 0) {
      if (destino) {
        const local = await BusinessLocation.findOne({
          where: { id: destino, businessId: req.auth.businessId, activo: true },
        });
        if (!local) return res.status(400).json({ message: 'El local indicado no pertenece a este negocio o está inactivo.' });
      } else {
        const activos = await BusinessLocation.findAll({
          where: { businessId: req.auth.businessId, activo: true }, order: [['id', 'ASC']],
        });
        if (activos.length === 1) destino = activos[0].id;
        else if (activos.length > 1) {
          return res.status(400).json({ message: 'Elegí a qué local entra el stock inicial de la variante.' });
        }
      }
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
        locationId: destino,
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

    const errPrecio = validarPrecios(req.body);
    if (errPrecio) return res.status(400).json({ message: errPrecio });

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
    /*
     * El cero sólo vale para el ajuste, y ahí es un dato.
     *
     * "Conté y no quedó ninguna" es un resultado de inventario legítimo, y
     * hasta ahora era imposible de cargar: el guard rechazaba el 0 para todos
     * los tipos por igual. Para un ingreso o un egreso sigue sin tener sentido
     * —no mueve nada— y se rechaza.
     */
    const cant = Number(cantidad);
    if (!Number.isInteger(cant) || cant < 0)
      return res.status(400).json({ message: 'La cantidad tiene que ser un número entero de 0 o más.' });
    if (cant === 0 && tipo !== 'ajuste')
      return res.status(400).json({ message: 'Un ingreso o egreso de 0 no mueve nada. Si querés corregir el número, usá un ajuste de inventario.' });

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
    const local = await stockService.resolverLocal({
      locationId, businessId: req.auth.businessId, employeeId: req.auth.employeeId, transaction: t,
    });

    const stockAnterior = await stockService.stockEn(variant.id, local, t);
    let stockNuevo;
    if (tipo === 'ingreso' || tipo === 'devolucion') {
      stockNuevo = stockAnterior + cant;
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
      if (cant > stockAnterior) {
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
            : `Sólo hay ${stockAnterior} de ${nombre} (${variant.sku}) en este local y estás sacando ${cant}. `) +
            (total > stockAnterior ? `Hay ${total} en total entre todos los locales: podés transferirlo. ` : '') +
            `Si el número que figura está mal, usá un ajuste de inventario.`,
          disponible: stockAnterior,
          totalOtrosLocales: total - stockAnterior,
          solicitado: cant,
        });
      }
      stockNuevo = stockAnterior - cant;
    } else {
      stockNuevo = cant; // ajuste directo: fija el stock contado
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
      // Mismo criterio que el listado de productos: el SKU que se tiene en la
      // mano es el de la variante.
      const conVariante = await ProductVariant.findAll({
        where: {
          businessId: req.auth.businessId,
          [Op.or]: [{ sku: { [like]: texto } }, { codigoBarras: { [like]: texto } }],
        },
        attributes: ['productId'],
        group: ['productId'],
      });
      const idsPorVariante = conVariante.map((v) => v.productId);

      whereProducto[Op.or] = [
        { titulo: { [like]: texto } },
        { sku: { [like]: texto } },
        { skuAgrupador: { [like]: texto } },
        { categoria: { [like]: texto } },
        ...(idsPorVariante.length ? [{ id: { [Op.in]: idsPorVariante } }] : []),
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
 * ── POST /api/products/precios-masivo ─────────────────────────────
 *
 * Pone precio propio a varias variantes de una vez.
 *
 * El caso que lo justifica: "de XL para arriba, $2.000 más". Hacerlo variante
 * por variante en un producto de cuarenta combinaciones son cuarenta ediciones,
 * y basta olvidarse de una para que un talle se venda al precio equivocado
 * hasta que alguien lo note en la caja.
 *
 * Cuerpo: { items: [{ variantId, precioMinorista?, precioMayorista?, costo? }] }
 * Un campo en `null` devuelve esa variante a heredar el precio del producto.
 */
const preciosMasivo = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const lineas = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!lineas.length) { await t.rollback(); return res.status(400).json({ message: 'No se mandó ninguna línea.' }); }
    if (lineas.length > 500) { await t.rollback(); return res.status(400).json({ message: 'Máximo 500 variantes por vez.' }); }

    const ids = [...new Set(lineas.map((l) => Number(l.variantId)).filter(Boolean))];
    const variantes = await ProductVariant.findAll({
      where: { id: ids, businessId: req.auth.businessId },
      transaction: t,
    });
    const porId = new Map(variantes.map((v) => [v.id, v]));
    if (ids.length !== porId.size) {
      await t.rollback();
      return res.status(404).json({ message: 'Alguna de las variantes no pertenece a este negocio.' });
    }

    const CAMPOS = ['precioMinorista', 'precioMayorista', 'costo'];
    let aplicadas = 0;

    for (const linea of lineas) {
      const v = porId.get(Number(linea.variantId));
      if (!v) continue;
      const patch = {};

      for (const campo of CAMPOS) {
        if (!(campo in linea)) continue;   // no vino: no se toca
        const bruto = linea[campo];
        /*
         * `null` y cadena vacía significan "volvé a heredar". Es la única
         * forma de deshacer un precio propio sin tener que acordarse del
         * precio del producto y volver a escribirlo.
         */
        if (bruto === null || bruto === '') { patch[campo] = null; continue; }
        const n = Number(bruto);
        if (!Number.isFinite(n) || n < 0) {
          await t.rollback();
          return res.status(400).json({ message: `Precio inválido para ${v.sku}: ${bruto}` });
        }
        // El tope de la columna. Sin esto una lista de precios con un cero de
        // más aborta la actualización entera con un error de base.
        if (n > MAX_MONEDA) {
          await t.rollback();
          return res.status(400).json({
            message: `El precio de ${v.sku} (${bruto}) pasa el máximo de ${MAX_MONEDA.toLocaleString('es-AR')}.`,
          });
        }
        patch[campo] = n;
      }

      if (Object.keys(patch).length) { await v.update(patch, { transaction: t }); aplicadas++; }
    }

    await t.commit();
    res.json({ ok: true, aplicadas });
  } catch (error) {
    await t.rollback().catch(() => {});
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

/*
 * GET /api/stock/a-regularizar
 *
 * Lo que se vendió sin tenerlo cargado: stock en negativo, por local.
 *
 * Es la contracara de dejar vender sin stock. Permitirlo sin esta lista sería
 * convertir el inventario en ficción; con ella, el negativo deja de ser un
 * número raro y pasa a ser una tarea concreta —contar eso y cargarlo—.
 */
const stockARegularizar = async (req, res, next) => {
  try {
    const filas = await VariantStock.findAll({
      where: { businessId: req.auth.businessId, stock: { [Op.lt]: 0 } },
      include: [
        {
          model: ProductVariant, as: 'variante', required: true,
          include: [{ model: Product, as: 'producto', attributes: ['titulo', 'skuAgrupador'] }],
        },
        { model: BusinessLocation, as: 'local', attributes: ['id', 'nombre', 'tipo'] },
      ],
      order: [['stock', 'ASC']],
      limit: 200,
    });

    const data = filas.map((f) => ({
      productVariantId: f.productVariantId,
      sku: f.variante?.sku,
      titulo: f.variante?.producto?.titulo,
      variante: [f.variante?.variante1Valor, f.variante?.variante2Valor].filter(Boolean).join(' · '),
      locationId: f.locationId,
      local: f.local?.nombre,
      stock: f.stock,
      // Lo que hay que cargar para volver a cero.
      faltan: Math.abs(f.stock),
    }));

    res.json({ data, total: data.length, unidades: data.reduce((s, x) => s + x.faltan, 0) });
  } catch (error) { next(error); }
};

module.exports = { getProducts, buscarVariantes, stockARegularizar, agregarVariantesMasivo, getProductPadreBySkuVariante, getProduct, createProduct, updateProduct, deleteProduct, addVariant, updateVariant, deleteVariant, adjustStock, getVariantMovements, getStockMovements, getStockPorLocal, getProductosPorLocal, getVariantesPorLocal, transferirStock, getIngresosDelDia, ajusteMasivo, preciosMasivo, generarEtiquetasPdf, exportProducts, importProducts, scanLookup, scanAdjustStock };
