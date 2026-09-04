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
const { exigirCupo } = require('../services/planService');
const { ProductVariant, Product, BusinessLocation } = require('../models');

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
  const salida = new Map();
  for (const [packId, lista] of mapa) {
    salida.set(packId, lista.map((c) => {
      const v = porId.get(c.componenteVariantId);
      return {
        ...c,
        sku: v?.sku || null,
        titulo: v?.producto?.titulo || '',
        etiqueta: [v?.variante1Valor, v?.variante2Valor].filter(Boolean).join(' / '),
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

// GET /api/packs
const listar = async (req, res, next) => {
  try {
    const { businessId } = req.auth;
    const variantes = await ProductVariant.findAll({
      where: { businessId, esPack: true },
      attributes: ['id', 'sku', 'variante1Nombre', 'variante1Valor', 'activo',
        'precioMinorista', 'precioMayorista', 'costo'],
      include: [{
        model: Product, as: 'producto',
        attributes: ['id', 'titulo', 'precioMinorista', 'precioMayorista', 'costo'],
      }],
      order: [['id', 'DESC']],
    });

    const ids = variantes.map((v) => v.id);
    const [crudos, armables] = await Promise.all([
      packs.componentesDe(ids),
      armablesPorLocal(ids, businessId),
    ]);
    const composicion = await conNombres(crudos, businessId);

    res.json(variantes.map((v) => {
      const arm = armables.get(v.id) || { total: 0, porLocal: [] };
      /*
       * El precio sale del mismo lugar que en toda la app: propio de la
       * variante si lo tiene, heredado del producto si no. Leerlo derecho del
       * producto haría que un pack con precio propio se muestre acá con un
       * número y se venda en el POS con otro.
       */
      const precios = precioService.resumenDe(v, v.producto);
      return {
        variantId: v.id,
        sku: v.sku,
        titulo: v.producto?.titulo || '',
        etiqueta: [v.variante1Nombre, v.variante1Valor].filter(Boolean).join(': '),
        activo: v.activo,
        precioMinorista: precios.precioMinorista,
        precioMayorista: precios.precioMayorista,
        componentes: composicion.get(v.id) || [],
        armables: arm.total,
        porLocal: arm.porLocal,
      };
    }));
  } catch (e) { next(e); }
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
 * POST /api/packs
 *
 * Body: { sku, titulo, precioMinorista, precioMayorista?, costo?, componentes: [...] }
 *
 * Crea el producto, su única variante y la composición de una sola vez.
 *
 * Podría hacerse desde la pantalla con tres llamadas —crear producto, crear
 * variante, armar el pack— pero si la tercera falla queda un producto vacío
 * colgado en el listado de stock, sin variantes y sin forma obvia de darse
 * cuenta de que era un pack a medio nacer. Acá o sale todo o no sale nada.
 *
 * Y el producto es propio del pack, no compartido: un pack tiene que estar
 * solo en su producto —el servicio lo exige— porque las variantes de un
 * producto comparten dimensiones (color, talle) y un pack no las tiene.
 */
const crear = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const { businessId } = req.auth;
    const sku = String(req.body?.sku || '').trim();
    const titulo = String(req.body?.titulo || '').trim();
    const componentes = Array.isArray(req.body?.componentes) ? req.body.componentes : [];

    if (!sku || !titulo) {
      await t.rollback();
      return res.status(400).json({ message: 'El pack necesita un SKU y un nombre.' });
    }
    const precioMinorista = Number(req.body?.precioMinorista);
    if (!Number.isFinite(precioMinorista) || precioMinorista <= 0) {
      await t.rollback();
      return res.status(400).json({
        message: 'El pack necesita un precio de venta mayor a cero.',
      });
    }

    // El pack ocupa un SKU del plan como cualquier otro artículo.
    await exigirCupo(businessId, 'skus', 1);

    const yaEsta = await ProductVariant.count({ where: { businessId, sku }, transaction: t });
    if (yaEsta) {
      await t.rollback();
      return res.status(409).json({
        message: `Ya hay un artículo con el SKU ${sku}. Elegí otro.`,
      });
    }

    const producto = await Product.create({
      businessId,
      sku,
      skuAgrupador: sku,
      titulo,
      precioMinorista,
      precioMayorista: Number.isFinite(Number(req.body?.precioMayorista))
        ? Number(req.body.precioMayorista) : precioMinorista,
      costo: Number.isFinite(Number(req.body?.costo)) ? Number(req.body.costo) : 0,
      activo: true,
      fechaActualizacion: new Date(),
    }, { transaction: t });

    /*
     * La dimensión dice "Pack / N unidades" y no un talle: es lo que se ve en
     * el POS, en la etiqueta y en el remito, y ahí tiene que quedar claro que
     * lo que sale es un combo.
     */
    const unidades = componentes.reduce((n, c) => n + (Number(c.cantidad) || 0), 0);
    const variante = await ProductVariant.create({
      productId: producto.id,
      businessId,
      sku,
      variante1Nombre: 'Pack',
      variante1Valor: `${unidades} unidad${unidades === 1 ? '' : 'es'}`,
      stock: 0,
      stockMinimo: 0,
    }, { transaction: t });

    const filas = await packs.definirComponentes(variante.id, businessId, componentes, t);
    await t.commit();

    return res.status(201).json({
      ok: true,
      variantId: variante.id,
      productId: producto.id,
      sku,
      componentes: filas.map((f) => ({
        componenteVariantId: f.componenteVariantId,
        cantidad: Number(f.cantidad),
        sku: f.componente?.sku || null,
      })),
      mensaje: 'Pack creado. No tiene stock propio: se arma con lo que haya de sus componentes.',
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

// DELETE /api/packs/:variantId
const desarmar = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const v = await packs.desarmar(Number(req.params.variantId), req.auth.businessId, t);
    await t.commit();
    res.json({
      ok: true,
      variantId: v.id,
      /*
       * Se avisa lo de Mercado Libre porque el efecto no se ve acá: la
       * publicación sigue viva y su stock deja de calcularse desde los
       * componentes, así que queda con el número que tenía hasta la próxima
       * sincronización.
       */
      mensaje: 'Dejó de ser pack. Si estaba publicado en Mercado Libre, '
        + 'revisá esa publicación: su stock ya no se calcula desde los componentes.',
    });
  } catch (e) {
    await t.rollback();
    next(e);
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

module.exports = { listar, detalle, crear, definir, desarmar, usan };
