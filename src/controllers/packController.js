/*
 * Packs (combos) por HTTP.
 *
 *   GET    /api/packs                 → los packs del negocio, con su composición
 *   GET    /api/packs/:variantId      → un pack: componentes y cuántos se arman
 *   PUT    /api/packs/:variantId      → define o cambia la composición
 *   DELETE /api/packs/:variantId      → deja de ser pack, vuelve a variante común
 *   GET    /api/packs/usan/:variantId → qué packs dependen de esta variante
 *
 * El negocio sale de la sesión, nunca del body: el packVariantId llega del
 * cliente y sin el filtro por negocio cualquiera podría rearmar el pack de
 * otro —o peor, meterle como componente una variante ajena y descontarle el
 * stock a un tercero en cada venta.
 */

const sequelize = require('../config/database');
const packs = require('../services/packService');
const precioService = require('../services/precioService');
const skuService = require('../services/skuService');
const { exigirCupo } = require('../services/planService');
const {
  ProductVariant, Product, PackComponente, BusinessLocation, VariantStock,
} = require('../models');

/*
 * Cuántos packs se pueden armar HOY.
 *
 * No es un dato guardado sino el mínimo de lo que dan los componentes, así que
 * se calcula al leer. Se suma sobre los locales que abastecen porque un pack se
 * arma en UN local: si las remeras están repartidas entre dos sucursales, no
 * hay pack aunque la suma alcance.
 */
async function armablesPorLocal(packVariantIds, businessId) {
  if (!packVariantIds.length) return new Map();
  const locales = await BusinessLocation.findAll({
    where: { businessId, activo: true }, attributes: ['id', 'nombre'],
  });
  const salida = new Map(packVariantIds.map((id) => [Number(id), { total: 0, porLocal: [] }]));
  for (const local of locales) {
    const mapa = await packs.disponibleDePacksEnLocales(packVariantIds, [local.id], businessId);
    for (const id of packVariantIds) {
      const cuantos = mapa.get(Number(id)) || 0;
      if (cuantos <= 0) continue;
      const fila = salida.get(Number(id));
      fila.total += cuantos;
      fila.porLocal.push({ locationId: local.id, local: local.nombre, armables: cuantos });
    }
  }
  return salida;
}

/*
 * Le pone nombre a los componentes.
 *
 * `componentesDe` devuelve ids y cantidades porque lo usan la venta y la
 * sincronización, donde el nombre no sirve para nada y traerlo sería una
 * consulta más por pack. Acá sí hace falta: la pantalla muestra "3 × Baby Tee
 * / M", no "3 × 8471". Se resuelve en UNA consulta para todos los packs.
 */
async function conNombres(mapa, businessId) {
  const ids = [...new Set([...mapa.values()].flat().map((c) => c.componenteVariantId))];
  if (!ids.length) return mapa;
  const variantes = await ProductVariant.findAll({
    where: { id: ids, businessId },
    attributes: ['id', 'sku', 'variante1Valor', 'variante2Valor', 'activo'],
    include: [{ model: Product, as: 'producto', attributes: ['titulo'] }],
  });
  const porId = new Map(variantes.map((v) => [v.id, v]));

  /*
   * Cuánto hay de cada componente, por local.
   *
   * Va con la composición porque sin esto la pantalla pide un acto de fe: dice
   * "se arman 5" y no hay forma de comprobarlo sin ir a Stock a contar. Con el
   * stock al lado, la cuenta se ve —15 disponibles, 3 por pack, 5 packs— y si
   * alguna vez el número estuviera mal, se nota en el momento.
   *
   * Se mira lo DISPONIBLE, no lo que hay en el estante: una unidad apartada
   * para otro pedido no se puede usar para armar un pack.
   */
  const filasStock = await VariantStock.findAll({
    where: { businessId, productVariantId: ids },
    attributes: ['productVariantId', 'locationId', 'stock', 'reservado'],
  });
  const disponiblePorComponente = new Map();
  for (const f of filasStock) {
    const libre = Math.max(0, (Number(f.stock) || 0) - (Number(f.reservado) || 0));
    if (libre <= 0) continue;
    if (!disponiblePorComponente.has(f.productVariantId)) {
      disponiblePorComponente.set(f.productVariantId, { total: 0, porLocal: new Map() });
    }
    const acc = disponiblePorComponente.get(f.productVariantId);
    acc.total += libre;
    acc.porLocal.set(f.locationId, (acc.porLocal.get(f.locationId) || 0) + libre);
  }

  const salida = new Map();
  for (const [packId, lista] of mapa) {
    salida.set(packId, lista.map((c) => {
      const v = porId.get(c.componenteVariantId);
      const hay = disponiblePorComponente.get(c.componenteVariantId);
      return {
        ...c,
        sku: v?.sku || null,
        titulo: v?.producto?.titulo || '',
        etiqueta: [v?.variante1Valor, v?.variante2Valor].filter(Boolean).join(' / '),
        // Lo disponible del componente, para que la división se pueda ver.
        disponible: hay?.total || 0,
        disponiblePorLocal: hay
          ? [...hay.porLocal.entries()].map(([locationId, unidades]) => ({ locationId, unidades }))
          : [],
        /*
         * Si el componente está desactivado el pack no se puede armar y no hay
         * ningún otro lugar donde se vea: la publicación queda en cero y desde
         * la pantalla del pack parece que faltara stock.
         */
        activo: v ? v.activo : false,
      };
    }));
  }
  return salida;
}

/*
 * GET /api/packs
 *
 * Agrupado por producto de pack, no una fila por variante.
 *
 * Un "Pack x3 Baby Tee" sobre un producto de nueve combinaciones son nueve
 * variantes de pack. Listadas sueltas, la pantalla es una pared de nueve
 * tarjetas casi idénticas donde no se ve lo único que importa: que es UN pack,
 * de x3, sobre UN producto. Se agrupa igual que se agrupa un producto con sus
 * talles.
 */
const listar = async (req, res, next) => {
  try {
    const { businessId } = req.auth;
    const variantes = await ProductVariant.findAll({
      // Los dados de baja no se listan: para quien mira, ya no existen.
      where: { businessId, esPack: true, activo: true },
      attributes: ['id', 'productId', 'sku', 'variante1Nombre', 'variante1Valor',
        'variante2Nombre', 'variante2Valor', 'activo',
        'precioMinorista', 'precioMayorista', 'costo', 'margenMl'],
      include: [{
        model: Product, as: 'producto',
        attributes: ['id', 'sku', 'titulo', 'precioMinorista', 'precioMayorista', 'costo', 'definicionCombo'],
      }],
      order: [['productId', 'DESC'], ['id', 'ASC']],
    });
    if (!variantes.length) return res.json([]);

    const ids = variantes.map((v) => v.id);
    const [crudos, armables] = await Promise.all([
      packs.componentesDe(ids),
      armablesPorLocal(ids, businessId),
    ]);
    const composicion = await conNombres(crudos, businessId);

    // El producto padre de cada componente, para poder nombrarlo una sola vez.
    const componenteIds = [...new Set([...crudos.values()].flat().map((c) => c.componenteVariantId))];
    const padres = componenteIds.length
      ? await ProductVariant.findAll({
        where: { id: componenteIds, businessId },
        attributes: ['id', 'productId'],
        include: [{ model: Product, as: 'producto', attributes: ['id', 'sku', 'titulo'] }],
      })
      : [];
    const padrePorComponente = new Map(padres.map((v) => [v.id, v.producto]));

    const porProducto = new Map();
    for (const v of variantes) {
      if (!porProducto.has(v.productId)) {
        porProducto.set(v.productId, {
          productId: v.productId,
          sku: v.producto?.sku || '',
          titulo: v.producto?.titulo || '',
          unidades: null,
          padre: null,
          // Un combo junta productos distintos: no tiene UN padre ni UNA cantidad.
          tipo: v.producto?.definicionCombo ? 'combo' : 'pack',
          definicionCombo: v.producto?.definicionCombo || null,
          piezas: [],
          armables: 0,
          variantes: [],
        });
      }
      const grupo = porProducto.get(v.productId);
      const comps = composicion.get(v.id) || [];
      const arm = armables.get(v.id) || { total: 0, porLocal: [] };
      const precios = precioService.resumenDe(v, v.producto);

      /*
       * Las unidades se leen de la composición, no de un campo aparte.
       *
       * Todas las variantes de un pack llevan la misma cantidad —se generan
       * juntas— pero el dato que manda es el de la tabla de composición, que es
       * el que usa la venta. Un número guardado al lado se desincronizaría la
       * primera vez que alguien edite una sola variante.
       */
      if (grupo.tipo === 'pack' && grupo.unidades === null && comps.length) grupo.unidades = comps[0].cantidad;
      /*
       * Un combo nombra TODAS sus prendas, no la primera. Tratado como pack,
       * "sale de" mostraba sólo la remera de un conjunto remera + pantalón, y
       * las variantes faltantes se contaban contra la remera sola.
       */
      if (grupo.tipo === 'combo') {
        for (const c of comps) {
          const p = padrePorComponente.get(c.componenteVariantId);
          if (p && !grupo.piezas.some((x) => x.productId === p.id)) {
            grupo.piezas.push({ productId: p.id, sku: p.sku, titulo: p.titulo, cantidad: c.cantidad });
          }
        }
      }
      if (grupo.tipo === 'pack' && !grupo.padre && comps.length) {
        const p = padrePorComponente.get(comps[0].componenteVariantId);
        if (p) grupo.padre = { productId: p.id, sku: p.sku, titulo: p.titulo };
      }
      grupo.precioMinorista = precios.precioMinorista;
      grupo.precioMayorista = precios.precioMayorista;
      grupo.armables += arm.total;
      grupo.variantes.push({
        variantId: v.id,
        sku: v.sku,
        etiqueta: [v.variante1Valor, v.variante2Valor].filter(Boolean).join(' / '),
        activo: v.activo,
        margenMl: Number(v.margenMl) || 0,
        componentes: comps,
        armables: arm.total,
        porLocal: arm.porLocal,
      });
    }

    /*
     * Cuántas variantes del padre todavía no tienen su pack.
     *
     * Pasa solo: se agrega un color al producto y el pack se queda sin él. No
     * hay ningún error, simplemente ese color no se puede vender de a tres y
     * nadie se entera hasta que un cliente lo pide. Mostrar el número es lo que
     * convierte eso en algo que se ve.
     */
    const salida = [];
    for (const grupo of porProducto.values()) {
      if (grupo.tipo === 'combo') {
        /*
         * Las combinaciones elegidas que las prendas ya permiten y todavía no
         * tienen combo. Pasa cuando una prenda suma la variante que faltaba:
         * sin avisarlo, esa combinación simplemente no se vende.
         */
        grupo.faltanVariantes = 0;
        try {
          const def = packs.leerDefinicionCombo(grupo.definicionCombo);
          if (def) {
            grupo.legado = def.legado;
            const proy = await packs.proyectarCombo({
              businessId, piezas: def.piezas, ejes: def.ejes, legado: def.legado,
              colores: def.colores, talles: def.talles, excluidas: def.excluidas, agrupador: grupo.sku,
            });
            const hechas = await clavesExistentes(grupo.productId, businessId, def.ejes);
            grupo.faltanVariantes = proy.filas.filter((f) => !f.excluida && !hechas.has(f.clave)).length;
          }
        } catch {
          // Una definición ilegible no tira la lista: el combo se ve igual.
          grupo.faltanVariantes = 0;
        }
      } else if (grupo.padre) {
        const cubiertas = new Set(
          grupo.variantes.flatMap((v) => v.componentes.map((c) => c.componenteVariantId)),
        );
        const total = await ProductVariant.count({
          where: { productId: grupo.padre.productId, businessId, activo: true, esPack: false },
        });
        grupo.faltanVariantes = Math.max(0, total - cubiertas.size);
      } else {
        grupo.faltanVariantes = 0;
      }
      delete grupo.definicionCombo;
      salida.push(grupo);
    }
    return res.json(salida);
  } catch (e) { return next(e); }
};

// GET /api/packs/:variantId
const detalle = async (req, res, next) => {
  try {
    const { businessId } = req.auth;
    const variantId = Number(req.params.variantId);
    const v = await ProductVariant.findOne({
      where: { id: variantId, businessId },
      attributes: ['id', 'sku', 'variante1Nombre', 'variante1Valor', 'activo', 'esPack',
        'precioMinorista', 'precioMayorista', 'costo'],
      include: [{
        model: Product, as: 'producto',
        attributes: ['id', 'titulo', 'precioMinorista', 'precioMayorista', 'costo'],
      }],
    });
    if (!v) return res.status(404).json({ error: 'Esa variante no existe en este negocio.' });

    const composicion = await conNombres(await packs.componentesDe([variantId]), businessId);
    const armables = await armablesPorLocal([variantId], businessId);
    const arm = armables.get(variantId) || { total: 0, porLocal: [] };

    return res.json({
      variantId: v.id,
      sku: v.sku,
      titulo: v.producto?.titulo || '',
      etiqueta: [v.variante1Nombre, v.variante1Valor].filter(Boolean).join(': '),
      activo: v.activo,
      esPack: v.esPack,
      ...precioService.resumenDe(v, v.producto),
      componentes: composicion.get(variantId) || [],
      armables: arm.total,
      porLocal: arm.porLocal,
    });
  } catch (e) { next(e); }
};

/*
 * De qué producto padre cuelga un pack.
 *
 * No se guarda: se deduce de los componentes. Un pack armado desde un producto
 * lleva variantes de ese producto y de ninguno más, así que el padre es el
 * producto de cualquiera de sus componentes. Guardarlo aparte sería un dato
 * repetido que se puede desincronizar del que manda de verdad, que es la
 * composición.
 */
async function padreDe(packProductId, businessId) {
  const variantes = await ProductVariant.findAll({
    where: { productId: packProductId, businessId, esPack: true }, attributes: ['id'],
  });
  if (!variantes.length) return null;
  const filas = await PackComponente.findAll({
    where: { businessId, packVariantId: variantes.map((v) => v.id) },
    attributes: ['componenteVariantId', 'cantidad'],
  });
  if (!filas.length) return null;
  const componente = await ProductVariant.findByPk(filas[0].componenteVariantId, {
    attributes: ['productId'],
  });
  if (!componente) return null;
  return {
    productId: componente.productId,
    unidades: Number(filas[0].cantidad) || 1,
    yaCubiertas: new Set(filas.map((f) => f.componenteVariantId)),
  };
}

/*
 * Los SKU que va a tener el pack, sin crearlos todavía.
 *
 * Se generan con la MISMA regla del negocio que usan los productos normales
 * —las mismas tres letras por valor, el mismo separador— sobre el SKU que
 * escribió la persona. Inventar una regla aparte para packs haría que el
 * catálogo tuviera dos criterios y que el de packs se quedara viejo la próxima
 * vez que alguien cambie el de productos.
 *
 * Devuelve también los choques: un SKU puede estar libre dentro de este pack y
 * tomado por otro artículo, y eso se ve mejor antes de apretar el botón que
 * después en un error.
 */
async function proyectar({ padre, agrupador, unidades, businessId, soloVariantIds = null }) {
  const regla = await skuService.reglaDe(businessId);

  const donde = { productId: padre.id, businessId, activo: true, esPack: false };
  if (soloVariantIds?.length) donde.id = soloVariantIds;
  const variantes = await ProductVariant.findAll({
    where: donde,
    attributes: ['id', 'sku', 'variante1Nombre', 'variante1Valor',
      'variante2Nombre', 'variante2Valor', 'precioMinorista'],
    order: [['id', 'ASC']],
  });

  const vistos = new Set();
  return variantes.map((v) => {
    const sku = skuService.componer({
      agrupador,
      valores: [
        { eje: v.variante1Nombre, valor: v.variante1Valor },
        { eje: v.variante2Nombre, valor: v.variante2Valor },
      ],
      regla,
    });
    const repetido = vistos.has(sku);
    vistos.add(sku);
    return {
      componenteVariantId: v.id,
      skuPadre: v.sku,
      etiqueta: [v.variante1Valor, v.variante2Valor].filter(Boolean).join(' / '),
      variante1Nombre: v.variante1Nombre, variante1Valor: v.variante1Valor,
      variante2Nombre: v.variante2Nombre, variante2Valor: v.variante2Valor,
      sku,
      // Choca con otro artículo del negocio, o con otra fila de esta misma lista.
      repetido,
      precioPropio: v.precioMinorista === null || v.precioMinorista === undefined
        ? null : Number(v.precioMinorista),
      unidades,
    };
  });
}

/*
 * GET /api/packs/sugerencia?productId=&unidades=&sku=
 *
 * Lo que la pantalla muestra ANTES de crear: qué SKU va a tener cada pack, qué
 * precio se sugiere y qué choca. Existe porque un alta que genera veinte SKU de
 * una vez no se puede revisar después: o se ve antes, o se revisa borrando.
 */
const sugerencia = async (req, res, next) => {
  try {
    const { businessId } = req.auth;
    const unidades = Math.trunc(Number(req.query.unidades));
    if (!Number.isFinite(unidades) || unidades < 1 || unidades > 1000) {
      return res.status(400).json({ message: 'Decí cuántas unidades lleva el pack (entre 1 y 1000).' });
    }

    const padre = await Product.findOne({
      where: { id: Number(req.query.productId), businessId },
      attributes: ['id', 'sku', 'skuAgrupador', 'titulo', 'esFeria',
        'precioMinorista', 'precioMayorista', 'costo'],
    });
    if (!padre) return res.status(404).json({ message: 'Ese producto no existe en este negocio.' });
    /*
     * Un producto de evento no lleva stock, así que un pack de eso no tendría
     * de dónde descontar. Se corta acá y no al guardar: la pantalla no debería
     * dejar elegirlo, pero si lo deja, el aviso llega antes de cargar todo.
     */
    if (padre.esFeria) {
      return res.status(400).json({
        message: 'Los productos de evento no llevan stock, así que no se puede armar un pack con ellos.',
      });
    }

    const agrupador = String(req.query.sku || '').trim() || `PACK${unidades}${padre.skuAgrupador || padre.sku}`;
    const filas = await proyectar({ padre, agrupador, unidades, businessId });

    // Los que ya están tomados por otro artículo del negocio.
    const tomados = new Set();
    for (const f of filas) {
      if (!await skuService.estaLibre(businessId, f.sku)) tomados.add(f.sku);
    }

    /*
     * El precio sugerido: lo que cuesta el producto por las unidades que lleva.
     *
     * Es una sugerencia y no una regla. La mayoría de los packs se venden con
     * descuento —es el motivo por el que existen— así que el número sale
     * calculado para no tener que hacer la cuenta a mano, y se puede pisar.
     */
    const base = precioService.resumenDe(null, padre);
    const porUnidad = Number(base.precioMinorista) || 0;

    const propios = [...new Set(filas.map((f) => f.precioPropio).filter((p) => p !== null))];
    const avisos = [];
    if (propios.length && propios.some((p) => p !== porUnidad)) {
      avisos.push('Algunas variantes de este producto tienen precio propio distinto al del '
        + 'producto. El pack va a llevar un solo precio para todas: revisalo antes de guardar.');
    }
    for (const f of filas) if (tomados.has(f.sku)) f.repetido = true;
    if (filas.some((f) => f.repetido)) {
      avisos.push('Hay SKU repetidos. Al guardar se les agrega un sufijo (-2, -3) para que '
        + 'no choquen, o podés cambiar el SKU del pack.');
    }
    if (!filas.length) {
      avisos.push('Este producto no tiene variantes activas, así que no hay de qué armar el pack.');
    }

    return res.json({
      padre: {
        id: padre.id, sku: padre.sku, titulo: padre.titulo,
        precioMinorista: porUnidad,
      },
      unidades,
      sku: agrupador,
      titulo: `Pack x${unidades} ${padre.titulo}`,
      precioMinorista: porUnidad * unidades,
      precioMayorista: (Number(base.precioMayorista) || 0) * unidades,
      costo: (Number(base.costo) || 0) * unidades,
      variantes: filas,
      avisos,
    });
  } catch (e) { return next(e); }
};

/*
 * POST /api/packs
 *
 * Body: { productId, sku, unidades, titulo?, precioMinorista?,
 *         precioMayorista?, costo?, variantIds? }
 *
 * Un pack no es un artículo suelto: es el mismo producto vendido de a N. Por
 * eso se arma desde el producto padre y se genera UNA variante de pack por cada
 * variante del padre, con sus mismos atributos —el pack x3 de la remera negra M
 * es distinto del pack x3 de la beige L, igual que lo son las remeras—.
 *
 * El producto que se crea toma como sku y skuAgrupador el que escribió la
 * persona, y de ahí cuelgan los SKU de cada combinación con la regla del
 * negocio. Es exactamente lo que pasa al dar de alta un producto normal: un
 * pack es un producto, no una excepción.
 *
 * Todo va en una transacción. Partido en pasos, un fallo a mitad de camino
 * dejaría un producto con la mitad de los packs y la otra mitad sin crear, y
 * desde el listado no habría forma de saber cuáles faltan.
 */
const crear = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const { businessId } = req.auth;
    const sku = String(req.body?.sku || '').trim();
    const unidades = Math.trunc(Number(req.body?.unidades));

    if (!sku) {
      await t.rollback();
      return res.status(400).json({ message: 'El pack necesita un SKU.' });
    }
    if (!Number.isFinite(unidades) || unidades < 1 || unidades > 1000) {
      await t.rollback();
      return res.status(400).json({ message: 'Decí cuántas unidades lleva el pack (entre 1 y 1000).' });
    }

    const padre = await Product.findOne({
      where: { id: Number(req.body?.productId), businessId },
      attributes: ['id', 'sku', 'skuAgrupador', 'titulo', 'esFeria',
        'precioMinorista', 'precioMayorista', 'costo'],
      transaction: t,
    });
    if (!padre) {
      await t.rollback();
      return res.status(404).json({ message: 'Ese producto no existe en este negocio.' });
    }
    if (padre.esFeria) {
      await t.rollback();
      return res.status(400).json({
        message: 'Los productos de evento no llevan stock, así que no se puede armar un pack con ellos.',
      });
    }

    const soloVariantIds = Array.isArray(req.body?.variantIds) && req.body.variantIds.length
      ? req.body.variantIds.map(Number).filter(Number.isFinite)
      : null;
    const filas = await proyectar({ padre, agrupador: sku, unidades, businessId, soloVariantIds });
    if (!filas.length) {
      await t.rollback();
      return res.status(400).json({
        message: 'Ese producto no tiene variantes activas, así que no hay de qué armar el pack.',
      });
    }

    // Cada pack generado ocupa un SKU del plan, igual que cualquier artículo.
    await exigirCupo(businessId, 'skus', filas.length);

    /*
     * El SKU del pack tiene que estar libre en las DOS tablas.
     *
     * `estaLibre` mira variantes, que es donde chocan los SKU que se escanean.
     * Pero acá se crea también un producto, y products tiene su propio índice
     * único por negocio: sin esta segunda comprobación el alta pasaba el
     * control, llegaba al insert y moría con un error de índice que hablaba de
     * una restricción de base de datos en vez de decir que el SKU está tomado.
     */
    const libreEnVariantes = await skuService.estaLibre(businessId, sku, null, t);
    const productoTomado = await Product.count({ where: { businessId, sku }, transaction: t });
    if (!libreEnVariantes || productoTomado) {
      await t.rollback();
      return res.status(409).json({ message: `Ya hay un artículo con el SKU ${sku}. Elegí otro.` });
    }

    const base = precioService.resumenDe(null, padre);
    const pedido = (valor, porDefecto) => (
      Number.isFinite(Number(valor)) && Number(valor) > 0 ? Number(valor) : porDefecto
    );
    const precioMinorista = pedido(req.body?.precioMinorista,
      (Number(base.precioMinorista) || 0) * unidades);
    if (!(precioMinorista > 0)) {
      await t.rollback();
      return res.status(400).json({
        message: 'El pack necesita un precio de venta mayor a cero. '
          + 'El producto que elegiste no tiene precio cargado, así que hay que escribirlo.',
      });
    }

    const producto = await Product.create({
      businessId,
      sku,
      skuAgrupador: sku,
      titulo: String(req.body?.titulo || '').trim() || `Pack x${unidades} ${padre.titulo}`,
      precioMinorista,
      precioMayorista: pedido(req.body?.precioMayorista,
        (Number(base.precioMayorista) || 0) * unidades) || precioMinorista,
      costo: pedido(req.body?.costo, (Number(base.costo) || 0) * unidades) || 0,
      activo: true,
      fechaActualizacion: new Date(),
    }, { transaction: t });

    const creadas = [];

    // Los SKU ya repartidos en este lote.

    const usados = new Set();
    for (const f of filas) {
      /*
       * `liberar` resuelve el choque agregando -2, -3.
       *
       * Dos valores distintos pueden dar el mismo código de tres letras —"Azul
       * Marino" y "Azul Claro" son los dos AZU— y ahí el alta entera se caía
       * con un error de índice único que nombraba una restricción de base de
       * datos. Es la misma salida que usa el alta de productos.
       */
      const libre = await skuService.liberar(businessId, f.sku, null, t, usados);
      if (libre) usados.add(libre);
      if (!libre) {
        await t.rollback();
        return res.status(409).json({
          message: `No se pudo generar un SKU libre para ${f.etiqueta || f.skuPadre}. `
            + 'Probá con otro SKU de pack.',
        });
      }
      const variante = await ProductVariant.create({
        productId: producto.id,
        businessId,
        sku: libre,
        variante1Nombre: f.variante1Nombre, variante1Valor: f.variante1Valor,
        variante2Nombre: f.variante2Nombre, variante2Valor: f.variante2Valor,
        esPack: true,
        stock: 0,
        stockMinimo: 0,
      }, { transaction: t });

      await packs.definirComponentes(variante.id, businessId, [
        { componenteVariantId: f.componenteVariantId, cantidad: unidades },
      ], t);

      creadas.push({
        variantId: variante.id, sku: libre, etiqueta: f.etiqueta, skuPadre: f.skuPadre,
      });
    }

    await t.commit();
    return res.status(201).json({
      ok: true,
      productId: producto.id,
      sku,
      unidades,
      variantes: creadas,
      mensaje: `Se crearon ${creadas.length} pack${creadas.length === 1 ? '' : 's'}. `
        + 'No llevan stock propio: cada uno saca del estante las unidades de su variante.',
    });
  } catch (e) {
    await t.rollback();
    return next(e);
  }
};

/*
 * POST /api/packs/:productId/completar
 *
 * Genera los packs de las variantes que el producto padre ganó después.
 *
 * Se agrega un color a la remera y el pack se queda sin él: no hay ningún
 * error, simplemente ese color no se puede vender de a tres. Rehacer el pack
 * entero para eso obligaría a borrar los que ya están publicados en Mercado
 * Libre —perdiendo su historial— así que se agregan sólo los que faltan.
 */
/*
 * ══ Combos: productos distintos en un mismo pack ═══════════════════
 *
 * Un pack vende de a N unidades de UN producto. Un combo junta prendas
 * distintas —remera + pantalón— y cada variante es una combinación de color y
 * talle: "Negro / M" lleva la remera negra M y el pantalón negro M. Quien lo
 * arma elige qué colores y qué talles, entre los que existen en todas las
 * prendas, y puede combinar colores distintos en una misma variante
 * ("Blanco + Negro / M"). El talle es el mismo para todas.
 *
 * Por debajo es un pack como cualquier otro: sin stock propio, con sus
 * componentes en `PackComponente`. Por eso lo que se arma, la publicación en
 * Mercado Libre, la venta, el despacho y la cancelación ya funcionan sin tocar
 * nada. `Product.definicionCombo` guarda lo elegido, que es lo que permite
 * completarlo y ampliarlo después.
 */
const EJES_COMBO = { color: 'Color', talle: 'Talle' };
// `variante1Valor` es STRING(80): una mezcla de muchos colores largos no entra.
const LARGO_VALOR_VARIANTE = 80;
// Más combinaciones que esto no es un combo: es un error de elección, y armar
// la previa costaría miles de filas.
const MAX_COMBINACIONES = 400;
// `Product.sku` es corto, y a cada variante se le suman color y talle.
const LARGO_SKU_COMBO = 60;

/** Los SKU de la lista que ya usa el negocio, en consultas por tandas. */
async function skusTomados(businessId, skus, t = null) {
  const unicos = [...new Set(skus.map((x) => String(x).trim()))];
  const tomados = new Set();
  for (let i = 0; i < unicos.length; i += 500) {
    const filas = await ProductVariant.findAll({
      where: { businessId, sku: unicos.slice(i, i + 500) }, attributes: ['sku'], transaction: t,
    });
    for (const v of filas) tomados.add(String(v.sku).trim());
  }
  return tomados;
}

const demasiadas = (proy) => proy.filas.length + proy.imposibles.length > MAX_COMBINACIONES;
const MENSAJE_DEMASIADAS = `Son demasiadas combinaciones para un combo (más de ${MAX_COMBINACIONES}). Elegí menos colores o talles.`;
const DEFINICION_DANADA = 'La definición de este combo está dañada: no se puede saber qué prendas lleva.';

/** Valida lo que manda la pantalla. Devuelve `{ error }` o la elección normalizada. */
function leerEleccionCombo(cuerpo, { exigirPiezas = true } = {}) {
  let piezas = null;
  if (exigirPiezas) {
    const crudas = Array.isArray(cuerpo?.piezas) ? cuerpo.piezas : [];
    if (crudas.length < 2) {
      return { error: 'Un combo lleva al menos dos productos distintos. Para vender de a N del mismo producto, creá un pack.' };
    }
    if (crudas.length > 10) return { error: 'Un combo no puede llevar más de 10 productos.' };
    piezas = [];
    const vistos = new Set();
    for (const p of crudas) {
      const productId = Math.trunc(Number(p?.productId));
      const cantidad = Math.trunc(Number(p?.cantidad ?? 1));
      if (!Number.isFinite(productId) || productId <= 0) {
        return { error: 'Cada prenda del combo tiene que indicar qué producto es.' };
      }
      if (vistos.has(productId)) {
        return { error: 'Un producto aparece dos veces: poné la cantidad total en una sola prenda.' };
      }
      vistos.add(productId);
      if (!Number.isFinite(cantidad) || cantidad < 1 || cantidad > 1000) {
        return { error: 'La cantidad de cada prenda tiene que ser un entero entre 1 y 1000.' };
      }
      piezas.push({ productId, cantidad });
    }
  }

  const esTexto = (v) => typeof v === 'string' || typeof v === 'number';
  const colores = cuerpo?.colores ?? null;
  const talles = cuerpo?.talles ?? null;
  const excluidas = cuerpo?.excluidas ?? null;
  if (colores !== null) {
    const valida = Array.isArray(colores) && colores.length <= 100 && colores.every((op) => {
      const valores = Array.isArray(op) ? op : (esTexto(op) ? [op] : op?.valores);
      return Array.isArray(valores) && valores.length <= 10
        && valores.every((v) => v === null || (esTexto(v) && String(v).length <= 60));
    });
    if (!valida) return { error: 'La lista de colores del combo no es válida.' };
  }
  if (talles !== null
    && !(Array.isArray(talles) && talles.length <= 100 && talles.every((x) => esTexto(x) && String(x).length <= 40))) {
    return { error: 'La lista de talles del combo no es válida.' };
  }
  if (excluidas !== null
    && !(Array.isArray(excluidas) && excluidas.length <= 2000
      && excluidas.every((x) => typeof x === 'string' && x.length <= 300))) {
    return { error: 'La lista de combinaciones excluidas no es válida.' };
  }
  return {
    piezas,
    colores,
    talles: talles === null ? null : talles.map(String),
    excluidas: excluidas || [],
  };
}

/** Une listas de opciones de color sin repetir (sin distinguir mayúsculas). */
function unirOpciones(...listas) {
  const vistas = new Set();
  const salida = [];
  for (const lista of listas) {
    for (const op of lista || []) {
      const valores = Array.isArray(op) ? op : op?.valores;
      if (!Array.isArray(valores)) continue;
      const clave = valores.map((v) => String(v ?? '').trim().toUpperCase()).join('|');
      if (!vistas.has(clave)) { vistas.add(clave); salida.push(valores); }
    }
  }
  return salida;
}

function unirTalles(...listas) {
  const vistos = new Set();
  const salida = [];
  for (const lista of listas) {
    for (const tl of lista || []) {
      const clave = String(tl).trim().toUpperCase();
      if (!vistos.has(clave)) { vistos.add(clave); salida.push(String(tl).trim()); }
    }
  }
  return salida;
}

function definicionDeCombo({ piezas, ejes = EJES_COMBO, opciones, talles, excluidas }) {
  return JSON.stringify({
    version: 2,
    ejes,
    piezas: piezas.map((p) => ({ productId: p.productId, cantidad: p.cantidad })),
    colores: opciones,
    talles,
    excluidas,
  });
}

/** Precio sugerido: la suma de las prendas por su cantidad. */
function sumaDePrecios(piezas, porId) {
  const total = { precioMinorista: 0, precioMayorista: 0, costo: 0 };
  for (const p of piezas) {
    const producto = porId.get(p.productId);
    if (!producto) continue;
    const r = precioService.resumenDe(null, producto);
    total.precioMinorista += (Number(r.precioMinorista) || 0) * p.cantidad;
    total.precioMayorista += (Number(r.precioMayorista) || 0) * p.cantidad;
    total.costo += (Number(r.costo) || 0) * p.cantidad;
  }
  return total;
}

/*
 * Las claves de las variantes que el combo ya tiene, activas o no. Una dada de
 * baja cuenta como existente: si alguien la sacó, no se vuelve a crear sola.
 */
async function clavesExistentes(productId, businessId, ejes, t = null) {
  const variantes = await ProductVariant.findAll({
    where: { productId, businessId, esPack: true },
    attributes: ['id', 'variante1Nombre', 'variante1Valor', 'variante2Nombre', 'variante2Valor'],
    transaction: t,
  });
  return new Set(variantes.map((v) => packs.claveDeVariante(v, ejes)));
}

/** Crea una variante de combo por combinación, con sus componentes. */
async function crearVariantesCombo({ producto, ejes = EJES_COMBO, filas, businessId, t }) {
  const lista = [];
  // Los SKU ya repartidos en este lote.
  const usados = new Set();
  for (const f of filas) {
    const libre = await skuService.liberar(businessId, f.sku, null, t, usados);
    if (libre) usados.add(libre);
    if (!libre) {
      return { error: `No se pudo generar un SKU libre para ${f.etiqueta || 'el combo'}. Probá con otro SKU de combo.` };
    }
    const pares = [];
    if (f.color) pares.push([ejes.color, f.color]);
    if (f.talle) pares.push([ejes.talle, f.talle]);
    const variante = await ProductVariant.create({
      productId: producto.id,
      businessId,
      sku: libre,
      variante1Nombre: pares[0]?.[0] ?? null, variante1Valor: pares[0]?.[1] ?? null,
      variante2Nombre: pares[1]?.[0] ?? null, variante2Valor: pares[1]?.[1] ?? null,
      esPack: true,
      stock: 0,
      stockMinimo: 0,
    }, { transaction: t });
    await packs.definirComponentes(variante.id, businessId, f.componentes.map((c) => ({
      componenteVariantId: c.componenteVariantId, cantidad: c.cantidad,
    })), t);
    lista.push({ variantId: variante.id, sku: libre, etiqueta: f.etiqueta });
  }
  return { lista };
}

const nombreLargo = (filas) => filas.find((f) => (f.color || '').length > LARGO_VALOR_VARIANTE);

/*
 * POST /api/packs/combo/sugerencia
 *   { piezas, colores?, talles?, excluidas?, sku? }  → un combo nuevo
 *   { productId, colores?, talles? }                 → un combo existente
 *
 * Con `productId`, las prendas y lo ya elegido salen de la definición guardada
 * y cada fila dice si ya `existe`.
 */
const sugerenciaCombo = async (req, res, next) => {
  try {
    const { businessId } = req.auth;
    let combo = null;
    let def = null;
    if (req.body?.productId !== undefined && req.body?.productId !== null) {
      combo = await Product.findOne({
        where: { id: Number(req.body.productId) || 0, businessId },
        attributes: ['id', 'sku', 'skuAgrupador', 'titulo', 'definicionCombo'],
      });
      if (!combo?.definicionCombo) return res.status(404).json({ message: 'Ese combo no existe en este negocio.' });
      def = packs.leerDefinicionCombo(combo.definicionCombo);
      if (!def) return res.status(400).json({ message: DEFINICION_DANADA });
    }
    const eleccion = leerEleccionCombo(req.body, { exigirPiezas: !def });
    if (eleccion.error) return res.status(400).json({ message: eleccion.error });
    const piezas = def ? def.piezas : eleccion.piezas;

    const productos = await Product.findAll({
      where: { id: piezas.map((p) => p.productId), businessId },
      attributes: ['id', 'sku', 'skuAgrupador', 'titulo', 'precioMinorista', 'precioMayorista', 'costo'],
    });
    const porId = new Map(productos.map((p) => [p.id, p]));

    const agrupadorDefecto = `COMBO-${piezas
      .map((p) => porId.get(p.productId)?.skuAgrupador || porId.get(p.productId)?.sku || p.productId)
      .join('-')}`.slice(0, 60);
    const agrupador = combo
      ? (combo.skuAgrupador || combo.sku)
      : (String(req.body?.sku || '').trim() || agrupadorDefecto);

    const proy = await packs.proyectarCombo({
      businessId,
      piezas,
      ejes: def?.ejes,
      legado: Boolean(def?.legado),
      colores: def?.legado ? def.colores : (eleccion.colores ?? def?.colores ?? null),
      talles: eleccion.talles ?? def?.talles ?? null,
      excluidas: req.body?.excluidas !== undefined ? eleccion.excluidas : (def?.excluidas || []),
      agrupador,
    });

    if (demasiadas(proy)) return res.status(400).json({ message: MENSAJE_DEMASIADAS });
    const hechas = combo ? await clavesExistentes(combo.id, businessId, def.ejes) : new Set();
    for (const f of proy.filas) f.existe = hechas.has(f.clave);
    // Una sola consulta para todos los SKU, no una por fila.
    const tomados = await skusTomados(businessId, proy.filas.filter((f) => !f.existe).map((f) => f.sku));
    for (const f of proy.filas) {
      if (!f.existe && tomados.has(String(f.sku).trim())) f.repetido = true;
    }
    const avisos = [...proy.avisos];
    if (proy.filas.some((f) => f.repetido && !f.existe)) {
      avisos.push('Hay SKU repetidos. Al guardar se les agrega un sufijo (-2, -3) para que '
        + 'no choquen, o podés cambiar el SKU del combo.');
    }
    if (nombreLargo(proy.filas)) {
      avisos.push(`Hay combinaciones de colores con un nombre de más de ${LARGO_VALOR_VARIANTE} letras: `
        + 'no se pueden guardar. Combiná menos prendas o colores con nombres más cortos.');
    }

    return res.json({
      productId: combo?.id || null,
      legado: Boolean(def?.legado),
      sku: agrupador,
      titulo: combo?.titulo
        || `Conjunto ${proy.piezas.map((p) => p.titulo).filter(Boolean).join(' + ')}`.slice(0, 120),
      ...sumaDePrecios(piezas, porId),
      piezas: proy.piezas,
      coloresComunes: proy.coloresComunes,
      tallesComunes: proy.tallesComunes,
      opciones: proy.opciones,
      talles: proy.talles,
      variantes: proy.filas,
      imposibles: proy.imposibles,
      invalidas: proy.invalidas,
      avisos,
    });
  } catch (e) { return next(e); }
};

// POST /api/packs/combo  { sku, titulo, precioMinorista, piezas, colores?, talles?, excluidas? }
const crearCombo = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const { businessId } = req.auth;
    const sku = String(req.body?.sku || '').trim();
    if (!sku) {
      await t.rollback();
      return res.status(400).json({ message: 'El combo necesita un SKU.' });
    }
    if (sku.length > LARGO_SKU_COMBO) {
      await t.rollback();
      return res.status(400).json({
        message: `El SKU del combo puede tener hasta ${LARGO_SKU_COMBO} caracteres: a cada variante se le suman el color y el talle.`,
      });
    }
    const eleccion = leerEleccionCombo(req.body);
    if (eleccion.error) {
      await t.rollback();
      return res.status(400).json({ message: eleccion.error });
    }

    const proy = await packs.proyectarCombo({
      businessId, piezas: eleccion.piezas, colores: eleccion.colores, talles: eleccion.talles,
      excluidas: eleccion.excluidas, agrupador: sku, t,
    });
    const falla = proy.piezas.find((p) => p.problema)?.problema || proy.invalidas[0];
    if (falla) {
      await t.rollback();
      return res.status(400).json({ message: falla });
    }

    if (demasiadas(proy)) {
      await t.rollback();
      return res.status(400).json({ message: MENSAJE_DEMASIADAS });
    }
    const filas = proy.filas.filter((f) => !f.excluida);
    if (!filas.length) {
      await t.rollback();
      return res.status(400).json({
        message: proy.avisos[0]
          || (proy.imposibles.length
            ? 'Ninguna de las combinaciones elegidas existe en todas las prendas, así que no hay combos para crear.'
            : 'No hay ninguna combinación de color y talle para crear.'),
        avisos: proy.avisos,
      });
    }
    const larga = nombreLargo(filas);
    if (larga) {
      await t.rollback();
      return res.status(400).json({
        message: `"${larga.color}" tiene más de ${LARGO_VALOR_VARIANTE} letras y no entra como color de la variante. `
          + 'Combiná menos prendas o colores con nombres más cortos.',
      });
    }

    await exigirCupo(businessId, 'skus', filas.length);

    const libreEnVariantes = await skuService.estaLibre(businessId, sku, null, t);
    const productoTomado = await Product.count({ where: { businessId, sku }, transaction: t });
    if (!libreEnVariantes || productoTomado) {
      await t.rollback();
      return res.status(409).json({ message: `Ya hay un artículo con el SKU ${sku}. Elegí otro.` });
    }

    const productos = await Product.findAll({
      where: { id: eleccion.piezas.map((p) => p.productId), businessId },
      attributes: ['id', 'titulo', 'precioMinorista', 'precioMayorista', 'costo'],
      transaction: t,
    });
    const porId = new Map(productos.map((p) => [p.id, p]));
    const sugerido = sumaDePrecios(eleccion.piezas, porId);
    const pedido = (valor, porDefecto) => (
      Number.isFinite(Number(valor)) && Number(valor) > 0 ? Number(valor) : porDefecto
    );
    const precioMinorista = pedido(req.body?.precioMinorista, sugerido.precioMinorista);
    if (!(precioMinorista > 0)) {
      await t.rollback();
      return res.status(400).json({
        message: 'El combo necesita un precio de venta mayor a cero. '
          + 'Las prendas no tienen precio cargado, así que hay que escribirlo.',
      });
    }

    const producto = await Product.create({
      businessId,
      sku,
      skuAgrupador: sku,
      titulo: (String(req.body?.titulo || '').trim()
        || `Conjunto ${proy.piezas.map((p) => p.titulo).filter(Boolean).join(' + ')}`).slice(0, 120),
      precioMinorista,
      precioMayorista: pedido(req.body?.precioMayorista, sugerido.precioMayorista) || precioMinorista,
      costo: pedido(req.body?.costo, sugerido.costo) || 0,
      activo: true,
      fechaActualizacion: new Date(),
      definicionCombo: definicionDeCombo({
        piezas: eleccion.piezas,
        opciones: proy.opciones,
        talles: proy.talles,
        excluidas: proy.filas.filter((f) => f.excluida).map((f) => f.clave),
      }),
    }, { transaction: t });

    const r = await crearVariantesCombo({ producto, filas, businessId, t });
    if (r.error) {
      await t.rollback();
      return res.status(409).json({ message: r.error });
    }

    await t.commit();
    return res.status(201).json({
      ok: true,
      productId: producto.id,
      sku,
      variantes: r.lista,
      mensaje: `Se crearon ${r.lista.length} combo${r.lista.length === 1 ? '' : 's'}, uno por color y talle. `
        + 'No llevan stock propio: cada uno saca del estante las prendas que lleva.',
    });
  } catch (e) {
    await t.rollback().catch(() => {});
    return next(e);
  }
};

/*
 * POST /api/packs/combo/:productId/ampliar  { colores?, talles?, excluidas? }
 *
 * Suma colores, talles o combinaciones de colores a un combo que ya existe.
 * Lo elegido antes queda: se une con lo nuevo y se crean sólo las variantes que
 * faltan. `excluidas` es la lista completa de lo que la persona dejó
 * destildado en la pantalla; sin ella, se mantiene lo excluido antes.
 */
const ampliarCombo = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const { businessId } = req.auth;
    const producto = await Product.findOne({
      where: { id: Number(req.params.productId) || 0, businessId },
      attributes: ['id', 'sku', 'skuAgrupador', 'titulo', 'definicionCombo'],
      transaction: t,
    });
    if (!producto?.definicionCombo) {
      await t.rollback();
      return res.status(404).json({ message: 'Ese combo no existe en este negocio.' });
    }
    const def = packs.leerDefinicionCombo(producto.definicionCombo);
    if (!def) {
      await t.rollback();
      return res.status(400).json({ message: DEFINICION_DANADA });
    }
    const eleccion = leerEleccionCombo(req.body, { exigirPiezas: false });
    if (eleccion.error) {
      await t.rollback();
      return res.status(400).json({ message: eleccion.error });
    }
    /*
     * Un combo de la versión anterior no se amplía: sus variantes no dicen el
     * color, así que sumarle colores duplicaría todo, y su definición no guarda
     * exclusiones. Los talles nuevos se agregan con "Generar las que faltan".
     */
    if (def.legado) {
      await t.rollback();
      return res.status(400).json({
        message: 'Este combo se creó con la versión anterior, con un color fijo por prenda: no se le pueden '
          + 'sumar colores ni talles a mano. Los talles nuevos se agregan con "Generar las que faltan"; '
          + 'para otros colores, creá un combo nuevo.',
      });
    }
    const agrupador = producto.skuAgrupador || producto.sku;

    // Lo pedido se valida solo: una opción vieja que hoy no existe no lo frena.
    let nuevasOpciones = [];
    let nuevosTalles = [];
    if (eleccion.colores || eleccion.talles) {
      const pedido = await packs.proyectarCombo({
        businessId, piezas: def.piezas, ejes: def.ejes,
        colores: eleccion.colores ?? [], talles: eleccion.talles ?? [], agrupador, t,
      });
      const falla = pedido.piezas.find((p) => p.problema)?.problema || pedido.invalidas[0];
      if (falla) {
        await t.rollback();
        return res.status(400).json({ message: falla });
      }
      nuevasOpciones = eleccion.colores ? pedido.opciones : [];
      nuevosTalles = eleccion.talles ? pedido.talles : [];
    }

    const colores = unirOpciones(def.colores, nuevasOpciones);
    const talles = def.talles === null ? null : unirTalles(def.talles, nuevosTalles);
    const proy = await packs.proyectarCombo({
      businessId, piezas: def.piezas, ejes: def.ejes, colores, talles, agrupador, t,
    });
    const problema = proy.piezas.find((p) => p.problema)?.problema;
    if (problema) {
      await t.rollback();
      return res.status(400).json({ message: problema });
    }
    if (demasiadas(proy)) {
      await t.rollback();
      return res.status(400).json({ message: MENSAJE_DEMASIADAS });
    }

    const visibles = new Set(proy.filas.map((f) => f.clave));
    const excluidasAntes = def.excluidas.map(packs.normalizarClave);
    const excluidas = req.body?.excluidas === undefined
      ? excluidasAntes
      : [...new Set([
        ...excluidasAntes.filter((c) => !visibles.has(c)),
        ...eleccion.excluidas.map(packs.normalizarClave).filter((c) => visibles.has(c)),
      ])];
    const fuera = new Set(excluidas);
    const hechas = await clavesExistentes(producto.id, businessId, def.ejes, t);
    const aCrear = proy.filas.filter((f) => !hechas.has(f.clave) && !fuera.has(f.clave));

    const larga = nombreLargo(aCrear);
    if (larga) {
      await t.rollback();
      return res.status(400).json({
        message: `"${larga.color}" tiene más de ${LARGO_VALOR_VARIANTE} letras y no entra como color de la variante.`,
      });
    }

    let creadas = [];
    if (aCrear.length) {
      await exigirCupo(businessId, 'skus', aCrear.length);
      const r = await crearVariantesCombo({ producto, ejes: def.ejes, filas: aCrear, businessId, t });
      if (r.error) {
        await t.rollback();
        return res.status(409).json({ message: r.error });
      }
      creadas = r.lista;
    }
    await producto.update({
      definicionCombo: definicionDeCombo({ piezas: def.piezas, ejes: def.ejes, opciones: colores, talles, excluidas }),
    }, { transaction: t });
    await t.commit();
    return res.json({
      ok: true,
      creadas,
      mensaje: creadas.length
        ? `Se agregaron ${creadas.length} combinaci${creadas.length === 1 ? 'ón' : 'ones'} al combo.`
        : 'No había combinaciones nuevas para crear. La elección quedó guardada.',
    });
  } catch (e) {
    await t.rollback().catch(() => {});
    return next(e);
  }
};

const completar = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const { businessId } = req.auth;
    const productId = Number(req.params.productId);

    const producto = await Product.findOne({
      where: { id: productId, businessId },
      attributes: ['id', 'sku', 'skuAgrupador', 'titulo', 'definicionCombo'],
      transaction: t,
    });
    if (!producto) {
      await t.rollback();
      return res.status(404).json({ message: 'Ese pack no existe en este negocio.' });
    }

    /*
     * Un combo se completa desde lo que se eligió al crearlo: agrega las
     * combinaciones de color y talle elegidas que las prendas ya permiten y
     * todavía no existen. Una que ya existe —aunque esté dada de baja— no se
     * vuelve a crear: si alguien la sacó, la sacó a propósito. Lo excluido a
     * mano tampoco.
     */
    if (producto.definicionCombo) {
      const def = packs.leerDefinicionCombo(producto.definicionCombo);
      if (!def) {
        await t.rollback();
        return res.status(400).json({ message: DEFINICION_DANADA });
      }
      const proy = await packs.proyectarCombo({
        businessId, piezas: def.piezas, ejes: def.ejes, legado: def.legado,
        colores: def.colores, talles: def.talles, excluidas: def.excluidas,
        agrupador: producto.skuAgrupador || producto.sku, t,
      });
      const hechas = await clavesExistentes(producto.id, businessId, def.ejes, t);
      const faltan = proy.filas.filter((f) => !f.excluida && !hechas.has(f.clave));
      if (!faltan.length) {
        await t.rollback();
        return res.json({
          ok: true, creadas: [],
          mensaje: 'El combo ya tiene todas las combinaciones elegidas que sus prendas permiten.',
        });
      }
      const larga = nombreLargo(faltan);
      if (larga) {
        await t.rollback();
        return res.status(400).json({
          message: `"${larga.color}" tiene más de ${LARGO_VALOR_VARIANTE} letras y no entra como color de la variante.`,
        });
      }
      await exigirCupo(businessId, 'skus', faltan.length);
      const r = await crearVariantesCombo({ producto, ejes: def.ejes, filas: faltan, businessId, t });
      if (r.error) {
        await t.rollback();
        return res.status(409).json({ message: r.error });
      }
      await t.commit();
      return res.json({
        ok: true,
        creadas: r.lista,
        mensaje: `Se agregaron ${r.lista.length} combinaci${r.lista.length === 1 ? 'ón' : 'ones'} al combo.`,
      });
    }

    const info = await padreDe(productId, businessId);
    if (!info) {
      await t.rollback();
      return res.status(400).json({
        message: 'No se puede saber de qué producto sale este pack: no tiene componentes cargados.',
      });
    }

    const padre = await Product.findOne({
      where: { id: info.productId, businessId },
      attributes: ['id', 'sku', 'skuAgrupador', 'titulo', 'esFeria',
        'precioMinorista', 'precioMayorista', 'costo'],
      transaction: t,
    });
    if (!padre) {
      await t.rollback();
      return res.status(400).json({ message: 'El producto del que sale este pack ya no existe.' });
    }

    const agrupador = producto.skuAgrupador || producto.sku;
    const todas = await proyectar({ padre, agrupador, unidades: info.unidades, businessId });
    const faltan = todas.filter((f) => !info.yaCubiertas.has(f.componenteVariantId));

    if (!faltan.length) {
      await t.rollback();
      return res.json({
        ok: true, creadas: [],
        mensaje: 'El pack ya cubre todas las variantes del producto.',
      });
    }

    await exigirCupo(businessId, 'skus', faltan.length);

    const creadas = [];

    // Los SKU ya repartidos en este lote.

    const usados = new Set();
    for (const f of faltan) {
      const libre = await skuService.liberar(businessId, f.sku, null, t, usados);
      if (libre) usados.add(libre);
      if (!libre) {
        await t.rollback();
        return res.status(409).json({
          message: `No se pudo generar un SKU libre para ${f.etiqueta || f.skuPadre}.`,
        });
      }
      const variante = await ProductVariant.create({
        productId: producto.id,
        businessId,
        sku: libre,
        variante1Nombre: f.variante1Nombre, variante1Valor: f.variante1Valor,
        variante2Nombre: f.variante2Nombre, variante2Valor: f.variante2Valor,
        esPack: true,
        stock: 0,
        stockMinimo: 0,
      }, { transaction: t });
      await packs.definirComponentes(variante.id, businessId, [
        { componenteVariantId: f.componenteVariantId, cantidad: info.unidades },
      ], t);
      creadas.push({ variantId: variante.id, sku: libre, etiqueta: f.etiqueta });
    }

    await t.commit();
    return res.json({
      ok: true,
      creadas,
      mensaje: `Se agregaron ${creadas.length} pack${creadas.length === 1 ? '' : 's'} `
        + 'para las variantes que faltaban.',
    });
  } catch (e) {
    await t.rollback();
    return next(e);
  }
};

/*
 * PUT /api/packs/:variantId
 *
 * Body: { componentes: [{ componenteVariantId, cantidad }] }
 *
 * Es un reemplazo completo y no un agregado: la composición de un pack se
 * piensa entera —"tres remeras"—, y un endpoint que sume de a uno obliga a la
 * pantalla a borrar y volver a poner para corregir una cantidad, con una
 * ventana en el medio donde el pack existe mal armado y Mercado Libre puede
 * vender contra esa composición equivocada.
 */
const definir = async (req, res, next) => {
  const t = await sequelize.transaction();
  const variantId = Number(req.params.variantId);
  try {
    /*
     * Devuelve las filas ya con el nombre y el SKU de cada componente: la
     * pantalla acaba de guardar y tiene que redibujar la lista, y sin esto
     * tendría que volver a pedir el pack entero para mostrar "Baby Tee / M".
     */
    const filas = await packs.definirComponentes(
      variantId,
      req.auth.businessId,
      Array.isArray(req.body?.componentes) ? req.body.componentes : [],
      t,
    );
    await t.commit();
    res.json({
      ok: true,
      variantId,
      componentes: filas.map((f) => ({
        componenteVariantId: f.componenteVariantId,
        cantidad: Number(f.cantidad),
        sku: f.componente?.sku || null,
        titulo: f.componente?.producto?.titulo || '',
        etiqueta: [f.componente?.variante1Valor, f.componente?.variante2Valor]
          .filter(Boolean).join(' / '),
      })),
      mensaje: 'Pack armado. El stock se descuenta de cada componente al vender.',
    });
  } catch (e) {
    await t.rollback();
    next(e);
  }
};

/*
 * DELETE /api/packs/producto/:productId
 *
 * Da de baja el pack entero: todas sus variantes y su producto.
 *
 * Se DESACTIVA, no se borra. Un pack que ya se vendió está referenciado por las
 * líneas de esas ventas, y borrarlo dejaría el historial sin poder decir qué se
 * vendió. Es la misma razón por la que no se borra un producto normal.
 *
 * Y sigue marcado como pack aunque quede inactivo. Sacarle la marca lo
 * convertiría en un artículo común con stock cero, que es exactamente lo que un
 * pack no es: reaparecería en el catálogo, en el inventario y en las cuentas de
 * stock, con un número que no significa nada.
 */
const eliminar = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const { businessId } = req.auth;
    const productId = Number(req.params.productId);

    const producto = await Product.findOne({
      where: { id: productId, businessId }, attributes: ['id', 'sku'], transaction: t,
    });
    const variantes = await ProductVariant.findAll({
      where: { productId, businessId, esPack: true }, attributes: ['id'], transaction: t,
    });
    if (!producto || !variantes.length) {
      await t.rollback();
      return res.status(404).json({ message: 'Ese pack no existe en este negocio.' });
    }

    const ids = variantes.map((v) => v.id);
    await PackComponente.destroy({ where: { packVariantId: ids }, transaction: t });
    await ProductVariant.update({ activo: false }, { where: { id: ids }, transaction: t });
    await Product.update({ activo: false }, { where: { id: productId }, transaction: t });

    await t.commit();
    return res.json({
      ok: true,
      variantes: ids.length,
      /*
       * Se avisa lo de Mercado Libre porque el efecto no se ve acá: la
       * publicación sigue viva y su stock deja de calcularse desde los
       * componentes, así que queda con el número que tenía hasta que alguien
       * la pause.
       */
      mensaje: `Se dieron de baja ${ids.length} pack${ids.length === 1 ? '' : 's'}. `
        + 'Si estaban publicados en Mercado Libre, pausá esas publicaciones: su stock '
        + 'ya no se calcula desde los componentes.',
    });
  } catch (e) {
    await t.rollback();
    return next(e);
  }
};

/*
 * DELETE /api/packs/:variantId
 *
 * Da de baja una sola combinación —por ejemplo, se deja de vender el pack del
 * talle S—. El resto del pack sigue en pie.
 */
const desarmar = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const variantId = Number(req.params.variantId);
    const v = await ProductVariant.findOne({
      where: { id: variantId, businessId: req.auth.businessId, esPack: true },
      transaction: t,
    });
    if (!v) {
      await t.rollback();
      return res.status(404).json({ message: 'Ese pack no existe en este negocio.' });
    }
    await PackComponente.destroy({ where: { packVariantId: variantId }, transaction: t });
    // Sigue marcado como pack: ver el comentario de `eliminar`.
    await v.update({ activo: false }, { transaction: t });
    await t.commit();
    return res.json({
      ok: true,
      variantId,
      mensaje: 'Ese pack quedó dado de baja. Si estaba publicado en Mercado Libre, '
        + 'pausá esa publicación.',
    });
  } catch (e) {
    await t.rollback();
    return next(e);
  }
};

/*
 * GET /api/packs/usan/:variantId
 *
 * Antes de desactivar o borrar una variante conviene saber qué packs se quedan
 * sin poder armarse. Sin este aviso, un pack publicado pasa a stock cero de un
 * día para el otro y desde la pantalla del pack no hay forma de saber por qué.
 */
const usan = async (req, res, next) => {
  try {
    res.json(await packs.packsQueUsan(Number(req.params.variantId), req.auth.businessId));
  } catch (e) { next(e); }
};

module.exports = {
  listar, detalle, sugerencia, crear, completar, definir, desarmar, eliminar, usan, padreDe, sugerenciaCombo, crearCombo, ampliarCombo };
