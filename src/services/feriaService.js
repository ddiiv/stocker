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
 * Los DOS precios con los que nace un producto de feria.
 *
 * Minorista y mayorista se calculan por separado, cada uno con su propia
 * regla, porque en la feria no guardan la relación que tienen en el local. El
 * caso que lo motivó: el mayorista de feria es el mayorista del local tal cual,
 * y el minorista de feria es ese mismo mayorista más un fijo.
 *
 * Cada regla tiene:
 *   base   sobre qué precio del producto original se calcula (minorista o mayorista)
 *   modo   igual (la base tal cual), porcentaje, o fijo (un monto que se suma)
 *   valor  el porcentaje o el monto, según el modo
 *
 * El fijo admite negativo: restar $500 es tan legítimo como sumarlos, y
 * prohibirlo obligaría a expresarlo como un porcentaje que no da redondo.
 */

const MODOS_PRECIO = ['igual', 'porcentaje', 'fijo'];
const BASES_PRECIO = ['minorista', 'mayorista'];

/*
 * Acepta la forma nueva —una regla por precio— y también la vieja, que traía
 * una sola y la usaba para los dos. La vieja sigue viva en llamadas ya escritas
 * y en las pruebas; romperla no aportaría nada.
 */
function normalizarReglaPrecio(precio) {
  const unaRegla = (r, porDefecto) => {
    const modo = MODOS_PRECIO.includes(r?.modo) ? r.modo : porDefecto.modo;
    const base = BASES_PRECIO.includes(r?.base) ? r.base : porDefecto.base;
    const valor = Number(r?.valor ?? r?.porcentaje ?? r?.monto ?? 0) || 0;
    return { modo, base, valor };
  };

  if (precio?.minorista || precio?.mayorista) {
    return {
      minorista: unaRegla(precio.minorista, { modo: 'igual', base: 'minorista' }),
      mayorista: unaRegla(precio.mayorista, { modo: 'igual', base: 'mayorista' }),
    };
  }

  // Forma vieja: una sola regla para los dos precios.
  const unica = unaRegla(precio, { modo: 'igual', base: 'minorista' });
  return { minorista: unica, mayorista: unica };
}

function validarReglaPrecio(regla) {
  for (const [cual, r] of Object.entries(regla)) {
    if (r.modo === 'porcentaje' && (r.valor < -100 || r.valor > 1000)) {
      return `El porcentaje del precio ${cual} tiene que estar entre -100 y 1000.`;
    }
    if (r.modo === 'fijo' && Math.abs(r.valor) > 9999999999) {
      return `El monto fijo del precio ${cual} es desmedido.`;
    }
  }
  return null;
}

function aplicarUna(original, r) {
  const base = r.base === 'mayorista'
    ? Number(original.precioMayorista) || Number(original.precioMinorista) || 0
    : Number(original.precioMinorista) || 0;

  if (r.modo === 'porcentaje') return redondear(base * (1 + r.valor / 100));
  if (r.modo === 'fijo') return redondear(base + r.valor);
  return redondear(base);
}

/*
 * Nunca por debajo de cero.
 *
 * Un porcentaje de -120 o un fijo que descuenta más de lo que vale dejarían un
 * precio negativo, y una venta a precio negativo devuelve plata en cada línea.
 */
function preciosDe(original, regla) {
  return {
    minorista: Math.max(0, aplicarUna(original, regla.minorista)),
    mayorista: Math.max(0, aplicarUna(original, regla.mayorista)),
  };
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
  if (!ids.length) throw error('Elegí al menos un producto para generar su versión de evento.');
  if (ids.length > 200) throw error('Máximo 200 productos por lote.');

  const pre = normalizarPrefijo(prefijo);
  const reglaPrecio = normalizarReglaPrecio(precio);
  const errPrecio = validarReglaPrecio(reglaPrecio);
  if (errPrecio) throw error(errPrecio);

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
      omitidos.push({ productId: orig.id, titulo: orig.titulo, motivo: 'ya tenía su versión de evento', sku: hechoPor.get(orig.id).sku });
      continue;
    }

    const sku = skuDeFeria(orig.sku, pre);
    const chocado = await Product.findOne({ where: { businessId, sku }, transaction: t });
    if (chocado) {
      omitidos.push({ productId: orig.id, titulo: orig.titulo, motivo: `el SKU ${sku} ya está usado`, sku });
      continue;
    }

    const { minorista: precioMinorista, mayorista: precioMayoristaFeria } = preciosDe(orig, reglaPrecio);
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
      precioMayorista: precioMayoristaFeria,
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
      titulo: producto.titulo,
      precio: precioMinorista, precioMayorista: precioMayoristaFeria,
      origen: orig.sku,
    });
  }

  /*
   * Avisar, no impedir.
   *
   * Un mayorista más caro que el minorista casi siempre es un error de carga
   * —las dos reglas se escriben seguidas y es fácil cruzarlas— pero puede ser
   * deliberado, así que no se bloquea. Lo que no puede pasar es que se genere
   * en silencio y aparezca cobrando de más recién en el mostrador.
   */
  const alReves = creados.filter((c) => c.precioMayorista > c.precio);
  const avisos = alReves.length
    ? [`En ${alReves.length} producto(s) el precio mayorista quedó más caro que el minorista. `
       + 'Revisá las reglas si no fue a propósito.']
    : [];

  return { prefijo: pre, creados, omitidos, avisos };
}

/*
 * Vuelve a calcular los precios de productos de feria YA generados.
 *
 * Existe porque generar es idempotente —de lo contrario un segundo lote
 * duplicaría el catálogo— y sin esto, cambiar de lista de precios obligaba a
 * borrar todo y regenerar, perdiendo los precios que se hubieran ajustado a
 * mano. La base sigue siendo el producto original, así que la regla se aplica
 * sobre los mismos números que la primera vez.
 */
async function reaplicarPrecios({ businessId, productIds, precio, transaction: t }) {
  const ids = [...new Set((Array.isArray(productIds) ? productIds : []).map(Number).filter(Boolean))];
  if (!ids.length) throw error('Elegí al menos un producto de evento.');

  const reglaPrecio = normalizarReglaPrecio(precio);
  const errPrecio = validarReglaPrecio(reglaPrecio);
  if (errPrecio) throw error(errPrecio);

  const deFeria = await Product.findAll({
    where: { id: ids, businessId, esFeria: true },
    transaction: t,
  });
  if (!deFeria.length) throw error('Ninguno de los productos elegidos es de evento.', 404);

  const origenes = await Product.findAll({
    where: { id: deFeria.map((p) => p.origenProductId).filter(Boolean), businessId },
    transaction: t,
  });
  const porId = new Map(origenes.map((p) => [p.id, p]));

  const actualizados = [];
  const sinOrigen = [];

  for (const p of deFeria) {
    const orig = porId.get(p.origenProductId);
    /*
     * Sin el original no hay sobre qué calcular. Puede pasar si el producto del
     * catálogo normal se borró: se informa en vez de dejarlo con el precio
     * viejo y sin explicación.
     */
    if (!orig) { sinOrigen.push({ id: p.id, sku: p.sku, titulo: p.titulo }); continue; }

    const { minorista, mayorista } = preciosDe(orig, reglaPrecio);
    await p.update({ precioMinorista: minorista, precioMayorista: mayorista, fechaActualizacion: new Date() }, { transaction: t });
    actualizados.push({
      id: p.id, sku: p.sku, titulo: p.titulo,
      precio: minorista, precioMayorista: mayorista,
    });
  }

  const alReves = actualizados.filter((c) => c.precioMayorista > c.precio);
  return {
    actualizados, sinOrigen,
    avisos: alReves.length
      ? [`En ${alReves.length} producto(s) el precio mayorista quedó más caro que el minorista.`]
      : [],
  };
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
    attributes: ['id', 'sku', 'origenProductId', 'precioMinorista', 'precioMayorista'],
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
        precioFeriaMayorista: yaEsta ? Number(yaEsta.precioMayorista) || 0 : null,
        feriaProductId: yaEsta ? yaEsta.id : null,
      };
    }),
  };
}

/** Si el negocio tiene al menos un puesto de feria activo. */
async function tienePuestos(businessId) {
  const n = await BusinessLocation.count({ where: { businessId, tipo: 'feria', activo: true } });
  return n > 0;
}

module.exports = {
  generar, reaplicarPrecios, candidatos, tienePuestos,
  normalizarPrefijo, skuDeFeria, normalizarReglaPrecio, preciosDe,
  PREFIJO_POR_DEFECTO, MODOS_PRECIO, BASES_PRECIO,
};
