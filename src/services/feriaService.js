const { Op } = require('sequelize');
const { Product, ProductVariant, BusinessLocation } = require('../models');
const { NO_ES_FERIA } = require('../utils/feria');
const { exigirCupo } = require('./planService');

/*
 * Productos de feria.
 *
 * Hay negocios con puestos de feria donde no se lleva inventario: interesa
 * registrar QUÉ se vendió, no cuánto queda. Para esos puestos se genera, a
 * partir del catálogo normal, un producto por padre con estas tres diferencias:
 *
 *   · Una sola variante, sin color ni talle. El padre ES la variante, así que
 *     escanear el código da el precio y listo, sin preguntar nada. En un puesto
 *     con gente esperando, elegir talle en una pantalla es tiempo perdido.
 *
 *   · SKU propio, con tres caracteres adelante. Así el mismo escáner distingue
 *     de un vistazo un artículo de feria de uno de local, y los dos códigos
 *     pueden convivir sin pisarse.
 *
 *   · Precio propio. En la feria se vende a otro precio, y ese es el motivo por
 *     el que el producto es una fila aparte y no una bandera sobre el original.
 *
 * El costo SÍ se copia del original. Sin costo, el margen de la feria daría
 * 100% y ensuciaría el análisis del negocio entero.
 */

const PREFIJO_POR_DEFECTO = 'FER';

/** Tres caracteres, sin espacios ni acentos, en mayúscula. */
function normalizarPrefijo(valor) {
  const limpio = String(valor || PREFIJO_POR_DEFECTO)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
  return (limpio || PREFIJO_POR_DEFECTO).slice(0, 3);
}

const error = (mensaje, status = 400, extra = {}) =>
  Object.assign(new Error(mensaje), { status, ...extra });

const redondear = (n) => Math.round(Number(n || 0) * 100) / 100;

/*
 * El precio con el que nace el producto de feria.
 *
 * Se decide una vez para todo el lote porque cargar cincuenta precios a mano
 * antes de la primera venta no es una opción. Después cada uno se edita como
 * cualquier producto.
 */
function precioDe(original, regla) {
  const base = regla?.base === 'mayorista'
    ? Number(original.precioMayorista) || Number(original.precioMinorista) || 0
    : Number(original.precioMinorista) || 0;

  if (regla?.modo === 'porcentaje') {
    const pct = Number(regla.porcentaje);
    if (!Number.isFinite(pct) || pct < -100 || pct > 1000) {
      throw error('El porcentaje tiene que estar entre -100 y 1000.');
    }
    return redondear(base * (1 + pct / 100));
  }
  return redondear(base);
}

/** El SKU de feria de un producto, sin comprobar si ya existe. */
const skuDeFeria = (skuOriginal, prefijo) => `${prefijo}${String(skuOriginal || '').trim()}`;

/*
 * Genera los productos de feria de un lote de padres.
 *
 * Es idempotente por producto: si un padre ya tiene su versión de feria, se
 * informa y no se toca. Así se puede correr de nuevo después de agregar
 * productos nuevos al catálogo sin duplicar nada ni pisar precios ya editados.
 */
async function generar({ businessId, productIds, prefijo, precio, transaction: t }) {
  const ids = [...new Set((Array.isArray(productIds) ? productIds : []).map(Number).filter(Boolean))];
  if (!ids.length) throw error('Elegí al menos un producto para generar su versión de feria.');
  if (ids.length > 200) throw error('Máximo 200 productos por lote.');

  const pre = normalizarPrefijo(prefijo);

  const originales = await Product.findAll({
    where: { id: ids, businessId, ...NO_ES_FERIA },
    transaction: t,
  });
  if (!originales.length) {
    throw error('Ninguno de los productos elegidos es del catálogo normal de este negocio.', 404);
  }

  // Los que ya tienen su versión de feria no se vuelven a generar.
  const yaHechos = await Product.findAll({
    where: { businessId, esFeria: true, origenProductId: originales.map((p) => p.id) },
    attributes: ['id', 'origenProductId', 'sku'],
    transaction: t,
  });
  const hechoPor = new Map(yaHechos.map((p) => [p.origenProductId, p]));

  const aCrear = originales.filter((p) => !hechoPor.has(p.id));

  /*
   * El tope de SKUs del plan se cuenta antes de crear nada: cada producto de
   * feria ocupa uno, igual que cualquier otro.
   */
  if (aCrear.length) await exigirCupo(businessId, 'skus', aCrear.length);

  const creados = [];
  const omitidos = [];

  for (const orig of originales) {
    if (hechoPor.has(orig.id)) {
      omitidos.push({ productId: orig.id, titulo: orig.titulo, motivo: 'ya tenía su versión de feria', sku: hechoPor.get(orig.id).sku });
      continue;
    }

    const sku = skuDeFeria(orig.sku, pre);
    const chocado = await Product.findOne({ where: { businessId, sku }, transaction: t });
    if (chocado) {
      omitidos.push({ productId: orig.id, titulo: orig.titulo, motivo: `el SKU ${sku} ya está usado`, sku });
      continue;
    }

    const precioMinorista = precioDe(orig, precio);
    const producto = await Product.create({
      businessId,
      sku,
      skuAgrupador: sku,
      titulo: orig.titulo,
      descripcion: orig.descripcion,
      categoria: orig.categoria,
      genero: orig.genero,
      modelo: orig.modelo,
      precioMinorista,
      // En la feria no hay precio por cantidad: se vende de a uno y al mismo
      // precio. Dejarlo igual al minorista evita que el descuento mayorista
      // —que se activa solo a partir de 3 unidades— cambie el precio sin que
      // nadie lo haya decidido.
      precioMayorista: precioMinorista,
      costo: orig.costo,
      variantes: {},
      esFeria: true,
      origenProductId: orig.id,
      fechaActualizacion: new Date(),
    }, { transaction: t });

    /*
     * Una sola variante, con el MISMO SKU que el padre.
     *
     * Es lo que hace que escanear el código de feria resuelva directo sin
     * preguntar color ni talle: hay una sola cosa que puede ser.
     */
    const variante = await ProductVariant.create({
      productId: producto.id,
      businessId,
      sku,
      variante1Nombre: null, variante1Valor: null,
      variante2Nombre: null, variante2Valor: null,
      // El stock queda en cero y no se toca nunca: estos productos no lo llevan.
      stock: 0,
      stockMinimo: 0,
      activo: true,
    }, { transaction: t });

    creados.push({
      productId: producto.id, variantId: variante.id, sku,
      titulo: producto.titulo, precio: precioMinorista, origen: orig.sku,
    });
  }

  return { prefijo: pre, creados, omitidos };
}

/*
 * Los padres del catálogo normal, marcando cuáles ya tienen versión de feria.
 *
 * Alimenta la pantalla de generación: sin saber cuáles ya están, elegir entre
 * cincuenta productos es adivinar.
 */
async function candidatos(businessId, prefijo) {
  const pre = normalizarPrefijo(prefijo);

  const normales = await Product.findAll({
    where: { businessId, activo: true, ...NO_ES_FERIA },
    attributes: ['id', 'sku', 'titulo', 'categoria', 'precioMinorista', 'precioMayorista', 'costo'],
    order: [['titulo', 'ASC']],
  });

  const feria = await Product.findAll({
    where: { businessId, esFeria: true },
    attributes: ['id', 'sku', 'origenProductId', 'precioMinorista'],
  });
  const porOrigen = new Map(feria.map((p) => [p.origenProductId, p]));

  return {
    prefijo: pre,
    productos: normales.map((p) => {
      const yaEsta = porOrigen.get(p.id) || null;
      return {
        id: p.id, sku: p.sku, titulo: p.titulo, categoria: p.categoria,
        precioMinorista: Number(p.precioMinorista) || 0,
        precioMayorista: Number(p.precioMayorista) || 0,
        skuFeria: yaEsta ? yaEsta.sku : skuDeFeria(p.sku, pre),
        generado: Boolean(yaEsta),
        precioFeria: yaEsta ? Number(yaEsta.precioMinorista) || 0 : null,
      };
    }),
  };
}

/** Si el negocio tiene al menos un puesto de feria activo. */
async function tienePuestos(businessId) {
  const n = await BusinessLocation.count({ where: { businessId, tipo: 'feria', activo: true } });
  return n > 0;
}

module.exports = { generar, candidatos, tienePuestos, normalizarPrefijo, skuDeFeria, PREFIJO_POR_DEFECTO };
