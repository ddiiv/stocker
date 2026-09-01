const sequelize = require('../config/database');
const feriaService = require('../services/feriaService');
const { Product, ProductVariant } = require('../models');
const listaPrecios = require('../services/listaPreciosService');

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
    if (r.creados.length) partes.push(`${r.creados.length} producto(s) de evento generado(s)`);
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

/*
 * POST /api/feria/productos
 *
 * Un producto de evento cargado a mano, sin pasar por el catálogo normal.
 *
 * Es para la mercadería que SÓLO se vende en eventos: un saldo comprado para
 * el fin de semana, una promoción armada para el puesto. Antes había que
 * inventarle un producto al catálogo, generarle su versión de evento y
 * acordarse de dar de baja el original.
 */
const postManual = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const creado = await feriaService.crearManual({
      businessId: req.auth.businessId,
      ...req.body,
      transaction: t,
    });
    await t.commit();
    res.status(201).json({ ...creado, mensaje: `${creado.titulo} agregado al catálogo de evento con el código ${creado.sku}.` });
  } catch (error) {
    await t.rollback().catch(() => {});
    next(error);
  }
};

/*
 * GET /api/feria/lista-precios  →  PDF
 *
 * El papel que se apoya en la mesa del puesto: precio, qué colores y qué talles
 * hay de cada modelo, y el código para escanear sin buscar la prenda.
 *
 * Va como GET y no como POST porque no cambia nada: es un informe. Eso además
 * permite abrirlo en una pestaña y mandarlo a imprimir sin más vueltas.
 */
const getListaPrecios = async (req, res, next) => {
  try {
    const { Business } = require('../models');
    const negocio = await Business.findByPk(req.auth.businessId, {
      attributes: ['id', 'nombreNegocio'],
    });
    const { buffer, filas, avisos } = await listaPrecios.generarListaPrecios(req.auth.businessId, negocio);

    /*
     * Los avisos viajan en una cabecera y no en el cuerpo: el cuerpo es el PDF.
     * Si algún código quedó con barras demasiado finas, la pantalla lo muestra
     * DESPUÉS de descargarlo — enterarse en el puesto sería tarde.
     */
    if (avisos.length) res.set('X-Aviso', encodeURIComponent(avisos.join(' ')));
    res.set('X-Filas', String(filas));
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="lista-precios-evento.pdf"`);
    res.send(buffer);
  } catch (error) { next(error); }
};

module.exports = { getCandidatos, postGenerar, postManual, getProductos, postPrecios, getListaPrecios };
