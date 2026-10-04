/*
 * Lo que la tienda minorista le pregunta a Stocker.
 *
 * La tienda es un canal online más, como Mercado Libre y Jumpseller: no
 * calcula stock ni precios, los pregunta. Lo único que guarda de su lado es lo
 * suyo —slug, categoría, SEO, fotos—, y por eso acá se devuelve el catálogo
 * completo con la cantidad publicable, que es exactamente el mismo número que
 * se le manda a los otros dos canales.
 *
 * ── Por qué el mismo número y no uno propio ──────────────────────
 *
 * `stockPublicableService` ya decide qué se publica: lo disponible en los
 * locales que abastecen online, menos el margen de seguridad, y en un pack
 * cuántos se pueden armar. Si la tienda hiciera su propia cuenta, el día que
 * esa regla cambie —un local nuevo, otra forma de contar los packs— dos
 * canales publicarían números distintos del mismo estante.
 */

const { Op } = require('sequelize');
const { Product, ProductVariant } = require('../models');
const { variantesPublicables, cantidadesPublicables } = require('./stockPublicableService');
const { localesQueAbastecenOnline } = require('./stockService');
const { precioMinorista, precioMayorista } = require('./precioService');

/*
 * Un catálogo de indumentaria entra holgado; el tope existe para que una
 * consulta no se lleve puesto el proceso si alguien cargó de más.
 */
const TOPE_VARIANTES = Number(process.env.TIENDA_TOPE_VARIANTES) || 20_000;
const TOPE_SKUS_CONSULTA = 500;

/**
 * El catálogo entero: productos padre, sus variantes y cuánto publicar.
 *
 * Se devuelve el padre con sus variantes adentro porque así lo consume la
 * tienda —un producto con su selector de color y talle— y porque el SKU
 * agrupador es la clave con la que guarda lo suyo.
 */
async function catalogo({ businessId }) {
  const [locales, variantes] = await Promise.all([
    localesQueAbastecenOnline(businessId),
    variantesPublicables(businessId, { soloActivas: true }),
  ]);
  const cantidades = locales.length
    ? await cantidadesPublicables(businessId, locales, variantes)
    : new Map();

  const truncado = variantes.length > TOPE_VARIANTES;
  const usadas = truncado ? variantes.slice(0, TOPE_VARIANTES) : variantes;

  /*
   * Se agrupa por SKU agrupador, que es por donde la tienda junta las
   * variantes en un producto. Cuando no hay agrupador se cae al SKU del
   * producto: un producto sin agrupador es uno solo, no un grupo vacío.
   */
  const porPadre = new Map();
  for (const v of usadas) {
    const p = v.producto;
    if (!p) continue;
    const clave = p.skuAgrupador || p.sku;
    if (!clave) continue;

    if (!porPadre.has(clave)) {
      porPadre.set(clave, {
        /*
         * El id del producto, además del SKU.
         *
         * Es la clave con la que la tienda engancha sus propias filas, y existe
         * porque un SKU se corrige: alguien le arregla un typo y, si la tienda
         * guardó el SKU como identidad, pierde el enganche con sus fotos, su
         * texto y su categoría. El id no cambia nunca.
         *
         * Va el del producto padre que agrupa, que es el que la tienda muestra
         * como una ficha.
         */
        id: p.id,
        skuAgrupador: clave,
        titulo: p.titulo,
        /*
         * El precio del producto, además del de cada variante.
         *
         * Es el que una ficha muestra antes de que el cliente elija talle. Las
         * variantes pueden tener el suyo —nulo significa "usa el del producto"—,
         * así que sin este número una ficha cuyas variantes no lo pisan no tiene
         * precio que mostrar.
         */
        precioMinorista: precioMinorista(null, p),
        precioMayorista: precioMayorista(null, p),
        descripcion: p.descripcion || null,
        categoria: p.categoria || null,
        modelo: p.modelo || null,
        genero: p.genero || null,
        variantes: [],
      });
    }
    porPadre.get(clave).variantes.push({
      // El id de la variante, por lo mismo que el del producto. Y además es lo
      // que viaja en el aviso `stock_cambio` (<negocio>:<variante>), así que sin
      // esto la tienda no puede traducir el aviso a un SKU suyo.
      id: v.id,
      sku: v.sku,
      color: v.color || null,
      talle: v.talle || null,
      /*
       * Los dos precios, con nombre completo y sin un `precio` a secas.
       *
       * La otra integración —el portal mayorista— devuelve `precio` y ahí
       * significa el mayorista. Dos rutas con el mismo campo queriendo decir
       * cosas distintas es la clase de detalle que se descubre cobrando mal.
       */
      precioMinorista: precioMinorista(v, p),
      precioMayorista: precioMayorista(v, p),
      /* El mismo número que se le manda a Mercado Libre y a Jumpseller. */
      /*
       * `cantidadesPublicables` devuelve { disponible, margen, cantidad } por
       * variante, no un número. Pasar el objeto por Number() da NaN, y NaN
       * serializado a JSON sale `null`: la tienda recibía null en cada SKU que
       * SÍ existe, que es peor que un cero porque no está en `desconocidos` y no
       * hay forma de distinguirlo de un dato faltante. Mercado Libre y Jumpseller
       * leen `.cantidad` desde siempre; esto no lo hacía.
       */
      publicable: Number(cantidades.get(v.id)?.cantidad || 0),
      activo: v.activo !== false,
    });
  }

  return {
    /*
     * De qué negocio es este catálogo.
     *
     * La credencial ya lo determina del lado de Stocker, pero la tienda lo
     * necesita del suyo: guarda los productos contra un negocio, y si algún día
     * una credencial se reemplaza por la de otro negocio sin que nadie lo note,
     * el dato en la respuesta es lo único que lo delata antes de mezclar dos
     * catálogos en la misma base.
     */
    negocio: businessId,
    productos: [...porPadre.values()],
    truncado,
    /*
     * Sin locales que abastezcan online todo da cero, y eso no se distingue de
     * "no hay stock" mirando los números. Se dice.
     */
    sinLocalesOnline: locales.length === 0,
    generadoEn: new Date(),
  };
}

/**
 * Las cantidades publicables de unos SKU puntuales.
 *
 * Es la consulta del carrito y del checkout: se pregunta por lo que el cliente
 * tiene en la mano, no por el catálogo entero.
 */
async function stockDeSkus({ businessId, skus }) {
  const pedidos = [...new Set((skus || []).map((s) => String(s || '').trim()).filter(Boolean))];
  if (!pedidos.length) return { stock: {}, desconocidos: [] };
  if (pedidos.length > TOPE_SKUS_CONSULTA) {
    throw Object.assign(
      new Error(`Se pueden consultar hasta ${TOPE_SKUS_CONSULTA} SKU por vez y llegaron ${pedidos.length}.`),
      { status: 400 },
    );
  }

  const variantes = await ProductVariant.findAll({
    where: { sku: { [Op.in]: pedidos } },
    include: [{ model: Product, as: 'producto', required: true, where: { businessId } }],
  });

  const locales = await localesQueAbastecenOnline(businessId);
  const cantidades = locales.length
    ? await cantidadesPublicables(businessId, locales, variantes)
    : new Map();

  const stock = {};
  // `.cantidad`, no el objeto: ver el comentario en `catalogo`.
  for (const v of variantes) stock[v.sku] = Number(cantidades.get(v.id)?.cantidad || 0);

  /*
   * Lo que no se encontró se devuelve aparte y NO como cero.
   *
   * Cero significa "no queda"; que el SKU no exista significa que la tienda
   * está publicando algo que acá no está, y esas dos cosas se arreglan en
   * lugares distintos. Devolver cero para las dos esconde la segunda.
   */
  const desconocidos = pedidos.filter((s) => !(s in stock));
  return { stock, desconocidos, generadoEn: new Date() };
}

module.exports = { catalogo, stockDeSkus, TOPE_SKUS_CONSULTA };
