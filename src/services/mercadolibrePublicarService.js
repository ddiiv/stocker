/*
 * Publicar en Mercado Libre desde Stocker, en tanda.
 *
 * El dueño elige productos y Stocker crea las publicaciones. Todo lo que no es
 * del producto —categoría, tipo de publicación, ficha técnica, envío, garantía
 * y guía de talles— se COPIA de una publicación suya que él elige de modelo: así
 * no hay que adivinar qué pide cada categoría.
 *
 * La cuenta publica con el modelo User Products: un ítem por variante (color ×
 * talle) con `family_name`, SIN `title` ni `variations`. Ver
 * entregas/ml-api-publicar.md: lo que ahí figura como INFERIDO se manda igual
 * pero el error de ML se muestra tal cual, sin traducirlo.
 *
 * El SKU viaja en SELLER_SKU: es lo que la sincronización de stock
 * (mercadolibreService: skuDe / mapearPorSku) usa para enganchar. Por eso un SKU
 * que ya está publicado se saltea: dos ítems con el mismo SKU y la sincronización
 * escribiría stock a uno solo.
 *
 * Costo de Stocker, fotos de la tienda, stock publicable el mismo que usa la
 * sincronización. No se usa publicidad de ML: no se suma nada por campañas.
 */

const axios = require('axios');
const { MercadoLibreAccount, MercadoLibreLink, Product, ProductVariant } = require('../models');
const stockService = require('./stockService');
const ml = require('./mercadolibreService');
const { ejesDe } = require('./tiendaService');
const { cantidadesPublicables } = require('./stockPublicableService');
const { NO_ES_FERIA } = require('../utils/feria');

const ML_API = 'https://api.mercadolibre.com';
const TAG_3_CUOTAS = '3x_campaign';
// La campaña de cuotas también figura como condición de venta, pero esa la pone ML: mandarla da "Not allowed to modify sale term".
const TERMINO_CUOTAS = 'INSTALLMENTS_CAMPAIGN';
const tiene3Cuotas = (item) => (item?.tags || []).includes(TAG_3_CUOTAS) || (item?.sale_terms || []).some((t) => t.id === TERMINO_CUOTAS);
// De las condiciones de venta sólo se copia la garantía: el resto (cuotas, facturación) lo decide ML.
const TERMINOS_COPIABLES = new Set(['WARRANTY_TYPE', 'WARRANTY_TIME']);
// Atributos que ML calcula solo: mandarlos no rompe, pero llena el resultado de avisos "ignored because it is not modifiable".
const ATRIBUTO_DE_ML = /^(FILTRABLE_|PACKAGE_|IS_\w+_BRAND$|SYI_PYMES_ID$|VERTICAL_TAGS$|WITH_VIRTUAL_TRY_ON$|AGE_GROUP$)/;
// Lo que cabe en family_name en moda (max_title_length del dominio de remeras).
const TOPE_FAMILY_NAME = 60;
const TOPE_FOTOS_DEFECTO = 10;

// ── Parámetros del negocio ────────────────────────────────────────

/*
 * Porcentajes en "por ciento" (15.5 es 15,5 %), como los escribe el dueño.
 * `tiendaUrl` es la API de la tienda minorista de donde se lee el catálogo y,
 * si `fotosUrl` está vacío, también las fotos ({tiendaUrl}/fotos): la de Isuwaya
 * las sirve ahí y en .jpg (verificado en producción con el catálogo de
 * WhatsApp). `fotosUrl` es para una tienda que las tenga en otro dominio.
 */
const PARAMETROS_POR_DEFECTO = {
  multiplicador: 2,
  packing: 1500,
  comisionPct: 15.5,
  cuotasPct: 8.5,
  envioGratis: 7000,
  impuestos: 2000,
  umbral: 33000,
  extraPct: 5,
  tiendaUrl: 'https://apiisu.up.railway.app',
  fotosUrl: '',
};

const error400 = (mensaje) => Object.assign(new Error(mensaje), { status: 400 });

function parametrosDe(cuenta) {
  let guardados = {};
  try { guardados = JSON.parse(cuenta?.publicarConfig || '{}') || {}; } catch { /* JSON roto: valen los de fábrica */ }
  const salida = { ...PARAMETROS_POR_DEFECTO };
  for (const k of Object.keys(PARAMETROS_POR_DEFECTO)) if (guardados[k] != null) salida[k] = guardados[k];
  return salida;
}

/** Valida y completa: un parámetro mal puesto da precios absurdos (o divisiones por cero) en toda la tanda. */
function validarParametros(entrada) {
  const p = { ...PARAMETROS_POR_DEFECTO, ...entrada };
  const num = (k, min, max, nombre) => {
    const n = typeof p[k] === 'string' && p[k].trim() === '' ? NaN : Number(p[k]);
    if (!Number.isFinite(n) || n < min || n > max) throw error400(`${nombre} tiene que ser un número entre ${min} y ${max}.`);
    p[k] = n;
  };
  num('multiplicador', 0.01, 100, 'El multiplicador');
  num('packing', 0, 1e7, 'El packing');
  num('comisionPct', 0, 90, 'La comisión de Mercado Libre');
  num('cuotasPct', 0, 90, 'El costo de las cuotas');
  num('envioGratis', 0, 1e7, 'El costo del envío gratis');
  num('impuestos', 0, 1e7, 'Los impuestos');
  num('umbral', 1, 1e9, 'El umbral de envío gratis');
  num('extraPct', 0, 90, 'El extra para descuentos');
  if (p.comisionPct + p.cuotasPct >= 100) throw error400('La comisión más las cuotas tienen que sumar menos de 100 %.');
  try {
    const u = new URL(String(p.tiendaUrl || ''));
    if (u.protocol !== 'https:') throw new Error('x');
    p.tiendaUrl = u.origin;
  } catch { throw error400('La dirección de la tienda tiene que ser una URL https, como https://apiisu.up.railway.app.'); }
  p.fotosUrl = String(p.fotosUrl || '').trim();
  if (p.fotosUrl) {
    try {
      const u = new URL(p.fotosUrl);
      if (u.protocol !== 'https:') throw new Error('x');
      p.fotosUrl = `${u.origin}${u.pathname}`.replace(/\/+$/, '');
    } catch { throw error400('La dirección de las fotos tiene que ser una URL https, como https://fotos.isuwaya.com.'); }
  }
  return p;
}

async function cuentaDe(businessId) {
  const cuenta = await MercadoLibreAccount.findOne({ where: { businessId } });
  if (!cuenta) throw Object.assign(new Error('No hay una cuenta de MercadoLibre conectada.'), { status: 400 });
  return cuenta;
}

async function parametros(businessId) {
  return parametrosDe(await cuentaDe(businessId));
}

/** Guarda los que vienen; los que faltan quedan como estaban. */
async function guardarParametros(businessId, cambios) {
  const cuenta = await cuentaDe(businessId);
  const nuevos = validarParametros({ ...parametrosDe(cuenta), ...(cambios || {}) });
  await cuenta.update({ publicarConfig: JSON.stringify(nuevos) });
  return nuevos;
}

// ── Precio "al revés" ─────────────────────────────────────────────

const redondear2 = (n) => Math.round(n * 100) / 100;

/*
 * El precio que hay que publicar para que, después de lo que cobra ML y con el
 * descuento ya aplicado, al dueño le quede el neto que quiere.
 *
 *   neto = costo × multiplicador + packing
 *   Bajo el umbral: el precio sólo cubre la comisión.
 *   Sobre el umbral: ML obliga envío gratis y se ofrecen cuotas, así que el
 *   precio también tiene que pagar envío, impuestos y el costo de las cuotas.
 *
 * El umbral se mira con el precio YA inflado por el extra (publicadoSinEnvio):
 * es el que ve ML. Si se mirara antes, un producto justo bajo el umbral cruzaría
 * al publicarlo y saldría con envío gratis sin haberlo contado.
 *
 * `p.extraPct` es el extra de ese producto (el de los parámetros, o el que se
 * eligió para él). El publicado se redondea para arriba a pesos enteros: nunca
 * queda de menos.
 */
function precioMl(costo, p = PARAMETROS_POR_DEFECTO) {
  const c = Number(costo) || 0;
  const com = p.comisionPct / 100;
  const cuo = p.cuotasPct / 100;
  const ext = p.extraPct / 100;
  const neto = c * p.multiplicador + p.packing;
  const sinEnvio = neto / (1 - com);
  // toFixed: 1000.0000000001 por redondeo de coma flotante no debe subir un peso.
  const aPesos = (n) => Math.ceil(Number(n.toFixed(6)));
  const publicadoSinEnvio = aPesos(sinEnvio / (1 - ext));
  // ">=": ML obliga el envío gratis "desde" el umbral, y se mira el precio ya redondeado, que es el que ve.
  const llevaEnvio = publicadoSinEnvio >= p.umbral;
  const publicado = llevaEnvio ? aPesos((neto + p.envioGratis + p.impuestos) / (1 - com - cuo) / (1 - ext)) : publicadoSinEnvio;
  const conDescuento = publicado * (1 - ext);
  const cobraMl = conDescuento * (com + (llevaEnvio ? cuo : 0));
  const fijos = llevaEnvio ? p.envioGratis + p.impuestos : 0;
  return {
    costo: c,
    neto: redondear2(neto),
    llevaEnvio,
    llevaCuotas: llevaEnvio,
    publicado,
    conDescuento: redondear2(conDescuento),
    cobraMl: redondear2(cobraMl),
    envio: llevaEnvio ? p.envioGratis : 0,
    impuestos: llevaEnvio ? p.impuestos : 0,
    leQueda: redondear2(conDescuento - cobraMl - fijos),
  };
}

// ── Caché en memoria ──────────────────────────────────────────────

const cache = new Map();

/** Guarda la promesa, no el valor: dos vistas previas a la vez no leen dos veces. Un error no se guarda. */
function conCache(clave, ttlMs, fn) {
  const e = cache.get(clave);
  if (e && e.hasta > Date.now()) return e.valor;
  const valor = fn();
  cache.set(clave, { hasta: Date.now() + ttlMs, valor });
  valor.catch(() => { if (cache.get(clave)?.valor === valor) cache.delete(clave); });
  return valor;
}

// ── Fotos de la tienda ────────────────────────────────────────────

const TTL_FOTOS_MS = 15 * 60 * 1000;
const PEDIDOS_TIENDA = 8;
const TIMEOUT_TIENDA_MS = 10000;

/*
 * SKU de variante → fotos de SU color.
 *
 * Las propias del color; si no tiene, las generales (la exhibición sin color).
 * Nunca las de otro color: una remera negra publicada con la foto de la blanca
 * es una venta que vuelve. Sin ninguna, queda vacío y esa variante no se publica
 * (ML exige foto).
 */
function fotosPorColor(detalle, fotosUrl) {
  // .jpg: ML sólo acepta JPG y PNG, y la API de la tienda convierte la .webp al pedirla así.
  // shortcut: un CDN que sólo tenga .webp no sirve acá; ahí hay que subir también las .jpg.
  const url = (f) => `${fotosUrl}/${f.clave}-1200.jpg`;
  const exhibicion = detalle.exhibicion || [];
  const generales = exhibicion.filter((f) => !f.color).map(url);
  const salida = [];
  for (const v of detalle.variantes || []) {
    const propias = v.color ? [
      ...exhibicion.filter((f) => f.color === v.color).map(url),
      ...((detalle.colores || []).find((c) => c.clave === v.color)?.fotos || []).map(url),
    ] : [];
    salida.push([v.sku, [...new Set(propias.length ? propias : generales)]]);
  }
  return salida;
}

/** Lee todo el catálogo de la tienda (pública, sin clave) y arma el índice por SKU. */
function indiceDeFotos(tienda, fotosUrl, { http = axios, esperar = dormir } = {}) {
  const clave = `fotos:${tienda}:${fotosUrl}`;
  return conCache(clave, TTL_FOTOS_MS, async () => {
    // La API de la tienda limita los pedidos por IP (300 por minuto): ante un 429 se espera lo que ella pide.
    const get = (ruta) => con429(() => http.get(`${tienda}${ruta}`, { timeout: TIMEOUT_TIENDA_MS }), { intentos: 6, esperar }).then((r) => r.data);
    let lista;
    try {
      lista = await get('/v1/productos-slugs');
    } catch (e) {
      throw Object.assign(new Error(`No se pudo leer la tienda (${tienda}): ${e.message}`), { status: 502 });
    }
    const porSku = new Map();
    let fallidos = 0;
    await ml.enParalelo(Array.isArray(lista) ? lista : [], PEDIDOS_TIENDA, async (p) => {
      try {
        const detalle = await get(`/v1/productos/${encodeURIComponent(p.slug)}`);
        for (const [sku, fotos] of fotosPorColor(detalle, fotosUrl)) porSku.set(sku, fotos);
      } catch { fallidos += 1; }
    });
    // Un índice con huecos no se guarda: esos productos saldrían "sin fotos" durante 15 minutos aunque las tengan.
    if (fallidos) cache.delete(clave);
    return { porSku, productos: Array.isArray(lista) ? lista.length : 0, fallidos };
  });
}

// ── La publicación modelo ─────────────────────────────────────────

// Lo propio de cada variante: se arma aparte, nunca se copia del modelo.
const ATRIBUTOS_PROPIOS = new Set(['COLOR', 'MAIN_COLOR', 'SIZE', 'SELLER_SKU', 'GTIN', 'SIZE_GRID_ROW_ID', 'SIZE_GRID_ID']);

const normalizarTalle = (t) => String(t ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

/** El error de ML tal cual: mensaje + cada causa. El detalle crudo va aparte para quien quiera verlo. */
function textoDeError(err) {
  const d = err.response?.data;
  if (!d) return err.message;
  const causas = (d.cause || []).map((c) => (c?.message || c?.code || JSON.stringify(c)));
  const cabeza = d.message || d.error || err.message;
  return `ML ${err.response.status}: ${[cabeza, ...causas].filter(Boolean).join(' | ')}`;
}

async function leerGuia(gridId, headers, http) {
  const { data } = await http.get(`${ML_API}/catalog/charts/${gridId}`, { headers });
  const filas = {};
  const nombres = {}; // el talle como lo escribe la guía: SIZE tiene que ser idéntico (si no, ML da el warning 2615 y pausa)
  for (const f of data.rows || []) {
    const talle = (f.attributes || []).find((a) => a.id === 'SIZE');
    const nombre = talle?.values?.[0]?.name ?? talle?.value_name;
    if (nombre != null && f.id) {
      filas[normalizarTalle(nombre)] = String(f.id);
      nombres[normalizarTalle(nombre)] = String(nombre);
    }
  }
  return { id: String(gridId), nombre: data.names?.MLA || data.name || null, filas, nombres };
}

/*
 * Lo que se copia de la publicación del vendedor que sirve de modelo.
 * Los atributos sin valor se dejan: mandar uno vacío es un error de ML.
 */
async function leerModelo(itemId, { headers, http = ml.httpML, mlUserId = null }) {
  let item;
  try {
    ({ data: item } = await http.get(`${ML_API}/items/${itemId}`, { headers }));
  } catch (e) {
    throw Object.assign(new Error(`No se pudo leer la publicación modelo ${itemId}. ${textoDeError(e)}`), { status: 400 });
  }
  if (mlUserId && item.seller_id && String(item.seller_id) !== String(mlUserId)) {
    throw error400('La publicación modelo no es de la cuenta de Mercado Libre conectada.');
  }
  const atributos = [];
  let sizeGridId = null;
  for (const a of item.attributes || []) {
    const valor = a.value_name ?? a.values?.[0]?.name;
    if (a.id === 'SIZE_GRID_ID') { sizeGridId = valor || a.value_id || null; continue; }
    if (ATRIBUTOS_PROPIOS.has(a.id) || ATRIBUTO_DE_ML.test(a.id) || valor == null || valor === '') continue;
    atributos.push(a.value_id && a.value_id !== '-1'
      ? { id: a.id, value_id: String(a.value_id), value_name: String(valor) }
      : { id: a.id, value_name: String(valor) });
  }
  const guia = sizeGridId ? await leerGuia(sizeGridId, headers, http) : null;
  let maxFotos = TOPE_FOTOS_DEFECTO;
  try {
    const { data: cat } = await http.get(`${ML_API}/categories/${item.category_id}`, { headers });
    maxFotos = Number(cat.max_pictures_per_item_var || cat.max_pictures_per_item) || TOPE_FOTOS_DEFECTO;
  } catch { /* se queda en el tope por defecto */ }
  const envio = item.shipping || {};
  return {
    itemId: String(item.id || itemId),
    titulo: item.title || item.family_name || null,
    // Para sumar variantes a esta misma publicación: en User Products se agrupan por family_name.
    familyName: item.family_name || null,
    precio: item.price ?? null,
    link: item.permalink || null,
    categoriaId: item.category_id,
    tipo: item.listing_type_id,
    tresCuotas: tiene3Cuotas(item),
    genero: atributos.find((a) => a.id === 'GENDER')?.value_name || null,
    atributos,
    guia,
    envio: { mode: envio.mode || 'me2', logistic_type: envio.logistic_type || null, local_pick_up: envio.local_pick_up ?? null },
    saleTerms: (item.sale_terms || [])
      .filter((t) => TERMINOS_COPIABLES.has(t.id) && (t.value_name != null || t.value_id != null))
      .map((t) => (t.value_id ? { id: t.id, value_id: String(t.value_id), value_name: t.value_name } : { id: t.id, value_name: t.value_name })),
    maxFotos,
  };
}

// ── Qué se publica ────────────────────────────────────────────────

const problema = (codigo, mensaje) => ({ codigo, mensaje });

/*
 * El público de un género, igual para Stocker ("Hombre", "Niños", "Unisex") y
 * para el GENDER de ML ("Hombre", "Niñas", "Sin género infantil"…). El género y
 * la guía de talles se copian del modelo: con uno de otro público ML rechaza
 * ("the words in the title match the gender") o deja una guía que no corresponde.
 */
function publicoDe(genero) {
  const g = String(genero || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  if (!g) return null;
  if (/nin|bebe|infantil|kid/.test(g)) return 'niños';
  if (/unisex|sin genero/.test(g)) return 'unisex';
  if (/mujer|dama|femenin/.test(g)) return 'mujer';
  if (/hombre|caballero|masculin/.test(g)) return 'hombre';
  return null;
}

function textoPlano(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').trim().slice(0, 50000);
}

function recortarFamilyName(nombre) {
  const n = String(nombre || '').trim().replace(/\s+/g, ' ');
  if (n.length <= TOPE_FAMILY_NAME) return n;
  const corte = n.slice(0, TOPE_FAMILY_NAME);
  return corte.slice(0, Math.max(corte.lastIndexOf(' '), 1)).trim();
}

/*
 * La vista previa, sin tocar nada de afuera: recibe todo ya leído.
 *
 *   productos   lo que eligió el usuario [{ skuAgrupador, familyName?, descripcion?, extra? }]
 *   datos       lo de Stocker por skuAgrupador: { titulo, descripcion, costo, variantes:[{ sku, color, talle, stock, costo, esPack }] }
 *   fotos       Map SKU → [url]
 *   publicados  Map SKU → { mlItemId, permalink } (lo que ya está en ML)
 *
 * Cada variante sale con `problemas` y `publicable`. Todo problema bloquea esa
 * variante (no el resto del producto): publicarla igual sería un error de ML
 * (talle fuera de la guía, sin foto) o una pérdida (sin costo).
 */
/*
 * `propios`: skuAgrupador → la publicación que ese producto YA tiene en ML
 * (leída como modelo), o { error } si no se pudo leer. Un producto con alguna
 * variante publicada no abre otra familia: las que faltan se suman a la suya,
 * con SU family_name, categoría, ficha y guía de talles, que es lo que hace que
 * ML las agrupe en la misma publicación. El modelo elegido es para los nuevos.
 */
function armarVista({ productos, datos, parametros: params, modelo: elegido, propios = new Map(), fotos, publicados }) {
  return productos.map((pedido) => {
    const d = datos.get(pedido.skuAgrupador);
    const propio = propios.get(pedido.skuAgrupador) || null;
    const modelo = propio && !propio.error ? propio : elegido;
    if (!d) {
      return {
        skuAgrupador: pedido.skuAgrupador, familyName: null, variantes: [], publicables: 0, avisos: [],
        problemas: [problema('PRODUCTO_NO_ENCONTRADO', 'No hay un producto activo con ese SKU en Stocker.')],
      };
    }
    const extraPct = pedido.extra != null ? Number(pedido.extra) : params.extraPct;
    const p = { ...params, extraPct };
    const avisos = [];
    const existente = propio && !propio.error && propio.familyName ? propio : null;
    // Con publicación propia el título no se elige: tiene que ser el de ella, o ML arma otra familia.
    const titulo = existente ? existente.familyName : (pedido.familyName || d.titulo);
    const familyName = existente ? existente.familyName : recortarFamilyName(titulo);
    if (existente) {
      avisos.push(`Este producto ya tiene publicación en Mercado Libre ("${existente.familyName}"): las variantes que faltan se suman a esa, con su categoría, ficha y guía de talles.`);
    } else if (familyName !== String(titulo).trim().replace(/\s+/g, ' ')) {
      avisos.push(`El título pasaba de ${TOPE_FAMILY_NAME} caracteres: se publica como "${familyName}".`);
    }
    // No se pudo leer la publicación que ya tiene, o es del formato viejo (con variaciones adentro): abrir otra la duplicaría.
    const sinPropia = propio && !existente
      ? problema('PUBLICACION_EXISTENTE', propio.error
        ? `Este producto ya tiene publicación en Mercado Libre pero no se pudo leer (${propio.error}): probá de nuevo en un rato.`
        : 'Este producto ya tiene una publicación del formato viejo (con las variantes adentro): las que faltan se agregan a mano en Mercado Libre.')
      : null;
    const costoProducto = Number(d.costo) || 0;
    const [suPublico, elDelModelo] = [publicoDe(d.genero), publicoDe(modelo.genero)];
    // Un producto unisex puede ir con cualquier modelo (se avisa); uno de hombre, mujer o niños, sólo con uno de su público.
    const otroPublico = suPublico && elDelModelo && suPublico !== elDelModelo;
    // Si se suma a su propia publicación, el género ya es el de ella y ML ya lo aceptó: no se frena.
    const generoDistinto = !existente && otroPublico && suPublico !== 'unisex';
    if (!existente && otroPublico && !generoDistinto) avisos.push(`El producto es unisex y la publicación modelo es de ${modelo.genero}: se publica con ese género y su guía de talles.`);
    const variantes = d.variantes.map((v) => {
      const costo = Number(v.costo) > 0 ? Number(v.costo) : costoProducto;
      const precio = costo > 0 ? precioMl(costo, p) : null;
      const urls = fotos.get(v.sku) || [];
      const fila = modelo.guia ? (modelo.guia.filas[normalizarTalle(v.talle)] || null) : null;
      const talleGuia = fila ? modelo.guia.nombres[normalizarTalle(v.talle)] : null;
      const ya = publicados.get(v.sku);
      const problemas = [];
      if (v.esPack) problemas.push(problema('ES_PACK', 'Es un pack: se publica a mano.'));
      if (!precio) problemas.push(problema('SIN_COSTO', 'No tiene costo cargado en Stocker (ni la variante ni el producto).'));
      if (!urls.length) problemas.push(problema('SIN_FOTOS', 'La tienda no tiene fotos de este color ni generales para este SKU.'));
      if (modelo.guia && !fila) problemas.push(problema('TALLE_FUERA_DE_GUIA', `El talle "${v.talle ?? ''}" no está en la guía de talles del modelo.`));
      // El precio sobre el umbral cuenta 3 cuotas a 8,5 %: sólo valen si el modelo es Premium con el tag. Si no, ML cobraría otra cosa.
      if (precio?.llevaCuotas && !(modelo.tipo === 'gold_pro' && modelo.tresCuotas)) {
        problemas.push(problema('MODELO_SIN_3_CUOTAS', 'Este precio cuenta 3 cuotas sin interés, pero la publicación modelo no es Premium con el tag de 3 cuotas: elegí un modelo que lo sea.'));
      }
      return {
        sku: v.sku, color: v.color, talle: v.talle, stock: v.stock, costo,
        precio, fotos: urls.slice(0, modelo.maxFotos), filaGuia: fila, talleGuia,
        yaPublicada: ya ? { itemId: ya.mlItemId, link: ya.permalink || ml.enlaceDe(ya.mlItemId) } : null,
        problemas,
        publicable: !ya && !problemas.length && !generoDistinto && !sinPropia,
      };
    });
    if (modelo.tipo === 'gold_pro' && variantes.some((v) => v.precio && !v.precio.llevaCuotas)) {
      avisos.push('Bajo el umbral de envío gratis se publica como Clásica (sin cuotas), porque el precio no las cubre.');
    }
    return {
      skuAgrupador: pedido.skuAgrupador,
      familyName,
      descripcion: pedido.descripcion != null ? textoPlano(pedido.descripcion) : textoPlano(d.descripcion),
      extraPct,
      costo: costoProducto,
      precio: costoProducto > 0 ? precioMl(costoProducto, p) : null,
      avisos,
      existente: existente ? { itemId: existente.itemId, link: existente.link || ml.enlaceDe(existente.itemId), familyName: existente.familyName, precio: existente.precio } : null,
      problemas: [
        ...(variantes.length ? [] : [problema('SIN_VARIANTES', 'No tiene variantes activas.')]),
        ...(sinPropia ? [sinPropia] : []),
        ...(generoDistinto ? [problema('GENERO_DISTINTO', `Este producto es de ${d.genero} y la publicación modelo es de ${modelo.genero}: elegí un modelo de ${d.genero} (el género y la guía de talles se copian del modelo).`)] : []),
      ],
      publicables: variantes.filter((v) => v.publicable).length,
      variantes,
    };
  });
}

/*
 * El cuerpo de POST /items de una variante (modelo User Products).
 *
 * Sin `title` ni `variations`: con la cuenta en el modelo nuevo, ML da 400 si
 * van. Las fotos del color van en cada ítem. SIZE_GRID_ROW_ID es de la fila del
 * talle en la guía del modelo. El tag de 3 cuotas va cuando el precio las
 * cubre (la vista bloquea la variante si el modelo no es Premium con el tag);
 * sin cuotas, el tipo Premium (que trae 6 por defecto) baja a Clásica para que
 * el precio calculado sea el que se cobra.
 */
function armarItem({ modelo, producto, variante }) {
  const llevaCuotas = variante.precio.llevaCuotas;
  const tipo = !llevaCuotas && modelo.tipo === 'gold_pro' ? 'gold_special' : modelo.tipo;
  const atributos = [...modelo.atributos];
  if (variante.color) atributos.push({ id: 'COLOR', value_name: String(variante.color) });
  if (variante.talle) atributos.push({ id: 'SIZE', value_name: String(variante.talleGuia || variante.talle) });
  if (modelo.guia) {
    atributos.push({ id: 'SIZE_GRID_ID', value_name: modelo.guia.id });
    atributos.push({ id: 'SIZE_GRID_ROW_ID', value_name: variante.filaGuia });
  }
  atributos.push({ id: 'SELLER_SKU', value_name: variante.sku });

  const envio = { mode: modelo.envio.mode };
  // El tipo de logística (logistic_type) no se manda: lo asigna ML, y copiarlo da "Client not allowed to update item null logistic_type".
  if (modelo.envio.local_pick_up != null) envio.local_pick_up = modelo.envio.local_pick_up;
  if (modelo.envio.mode === 'me2') envio.free_shipping = variante.precio.llevaEnvio;

  const item = {
    family_name: producto.familyName,
    category_id: modelo.categoriaId,
    price: variante.precio.publicado,
    currency_id: 'ARS',
    // Sin stock va con una unidad fantasma: ML no crea un ítem en 0. publicarItems la saca enseguida y queda pausada.
    available_quantity: Math.max(1, variante.stock),
    buying_mode: 'buy_it_now',
    condition: 'new',
    listing_type_id: tipo,
    shipping: envio,
    pictures: variante.fotos.map((source) => ({ source })),
    attributes: atributos,
  };
  if (modelo.saleTerms.length) item.sale_terms = modelo.saleTerms;
  if (producto.descripcion) item.description = { plain_text: producto.descripcion };
  if (modelo.tresCuotas && llevaCuotas) item.tags = [TAG_3_CUOTAS];
  return item;
}

// ── Hablar con ML ─────────────────────────────────────────────────

const dormir = (ms) => new Promise((listo) => setTimeout(listo, ms));

/*
 * Reintenta ante 429 (demasiados pedidos) con espera creciente; respeta
 * Retry-After si viene. Los demás errores suben tal cual: reintentar un POST
 * que falló por otra causa puede duplicar la publicación.
 */
async function con429(fn, { intentos = 4, baseMs = 1000, esperar = dormir } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err.response?.status !== 429 || i >= intentos) throw err;
      const pedido = Number(err.response.headers?.['retry-after']) * 1000;
      await esperar(Math.min(pedido > 0 ? pedido : baseMs * 2 ** (i - 1) * (1 + Math.random() * 0.25), 30000));
    }
  }
}

/*
 * Si ML rechaza el tag de 3 cuotas el error sale tal cual y esa variante no se
 * publica: sin el tag, un Premium trae 6 cuotas sin interés por defecto, que le
 * cuestan a ML más que el 8,5 % del precio y se llevarían la ganancia.
 */
const mandar = (url, payload, { http, headers, esperar }) => con429(() => http.post(url, payload, { headers }), { esperar });

/*
 * Publica los ítems de a uno (en serie: ML limita los pedidos por app y un 429
 * a mitad de tanda es peor que ir de a uno).
 *
 *   items       [{ sku, payload }]
 *   publicados  Map/Set de SKU ya en ML: se saltean, así reintentar una tanda
 *               que quedó a medias no duplica nada. Lo que se va creando se suma.
 *
 * `alCrear` guarda cada ítem creado (en Stocker, como vínculo SKU ↔ ítem).
 *
 * Un ítem con `fantasma` (la variante no tiene stock) se crea con una unidad y
 * en el mismo momento se pasa a 0: ML lo deja pausado y la sincronización lo
 * activa sola cuando entre mercadería. Entre un paso y otro hay un instante en
 * que se puede vender esa unidad: por eso va pegado a la creación y, si falla,
 * queda avisado bien claro para pausarlo a mano.
 *
 * Devuelve { porSku }, con por SKU: 'publicada' (itemId, link, pausada),
 * 'salteada' o 'error' (el texto de ML y el detalle crudo).
 */
async function publicarItems({ items, publicados, http = ml.httpML, headers, esperar = dormir, onProgreso = () => {}, alCrear = async () => {} }) {
  const porSku = {};
  const vistos = new Set(publicados instanceof Map ? publicados.keys() : publicados);
  onProgreso({ total: items.length, hechos: 0, porSku });
  let hechos = 0;
  for (const { sku, payload, fantasma } of items) {
    if (vistos.has(sku)) {
      porSku[sku] = { estado: 'salteada', motivo: 'Ese SKU ya está publicado en Mercado Libre.' };
    } else {
      try {
        const { data } = await mandar(`${ML_API}/items`, payload, { http, headers, esperar });
        vistos.add(sku);
        porSku[sku] = { estado: 'publicada', itemId: data.id, link: data.permalink || ml.enlaceDe(data.id) };
        // La campaña de 3 cuotas se pide con el tag, pero la decide ML: si no quedó, que se sepa (una Premium sin ella ofrece 6 cuotas, que cuestan más).
        if ((payload.tags || []).includes(TAG_3_CUOTAS) && !tiene3Cuotas(data)) {
          porSku[sku].avisos = ['Se publicó, pero Mercado Libre no le puso las 3 cuotas sin interés: revisala en ML (una Premium sin esa campaña ofrece 6 cuotas, que te cuestan más).'];
        }
        if (fantasma) {
          try {
            await con429(() => http.put(`${ML_API}/items/${data.id}`, { available_quantity: 0 }, { headers }), { esperar });
            porSku[sku].pausada = true;
          } catch (e) {
            porSku[sku].avisos = [...(porSku[sku].avisos || []), `OJO: se publicó con 1 unidad que no existe y no se pudo pasar a 0 (${textoDeError(e)}). Pausala a mano en Mercado Libre.`];
          }
        }
        // Sin esto, la búsqueda de ML tarda en mostrar lo recién creado y reintentar la tanda lo duplicaría.
        try { await alCrear({ sku, itemId: data.id, titulo: payload.family_name }); } catch (e) {
          porSku[sku].avisos = [...(porSku[sku].avisos || []), `Se publicó, pero no se pudo guardar el vínculo con el SKU (${e.message}): vinculalo a mano para que se sincronice el stock.`];
        }
      } catch (err) {
        porSku[sku] = { estado: 'error', error: textoDeError(err), detalle: err.response?.data ?? null };
      }
    }
    hechos += 1;
    onProgreso({ total: items.length, hechos, porSku });
  }
  return { porSku };
}

/*
 * POST /items/validate de cada ítem: lo que ML diría sin crear nada. Que
 * `/items/validate` replique las reglas de moda y de User Products no está
 * confirmado (ver el informe), así que "ok" acá no garantiza que publicar vaya
 * a andar.
 */
async function validarItems({ items, http = ml.httpML, headers, esperar = dormir }) {
  const porSku = {};
  for (const { sku, payload } of items) {
    try {
      await mandar(`${ML_API}/items/validate`, payload, { http, headers, esperar });
      porSku[sku] = { ok: true, errores: [], avisos: [] };
    } catch (err) {
      const causas = err.response?.data?.cause || [];
      const errores = causas.filter((c) => c?.type !== 'warning');
      if (err.response?.status === 400 && causas.length && !errores.length) {
        porSku[sku] = { ok: true, errores: [], avisos: causas.map((c) => c.message || c.code) };
      } else {
        porSku[sku] = { ok: false, errores: [textoDeError(err)], detalle: err.response?.data ?? null };
      }
    }
  }
  return { porSku };
}

// ── Las tres entradas con base de datos ───────────────────────────

const TTL_MODELO_MS = 5 * 60 * 1000;
const TTL_PUBLICADOS_MS = 60 * 1000;
const TOPE_PRODUCTOS = 50;

/** Valida lo que manda la pantalla: nada de lo de acá abajo debe recibir basura. */
function validarPedido({ productos, modeloItemId }) {
  if (!/^MLA\d+$/i.test(String(modeloItemId || '').trim())) throw error400('Elegí una publicación modelo (un id como MLA123456789).');
  if (!Array.isArray(productos) || !productos.length) throw error400('Elegí al menos un producto.');
  if (productos.length > TOPE_PRODUCTOS) throw error400(`Se pueden publicar hasta ${TOPE_PRODUCTOS} productos por tanda.`);
  const vistos = new Set();
  const limpios = productos.map((p) => {
    const sku = String(p?.skuAgrupador || '').trim();
    if (!sku) throw error400('Falta el SKU de un producto.');
    if (vistos.has(sku)) throw error400(`El producto ${sku} está repetido.`);
    vistos.add(sku);
    if (p.extra != null && !(Number(p.extra) >= 0 && Number(p.extra) <= 90)) throw error400(`El extra de ${sku} tiene que estar entre 0 y 90.`);
    return {
      skuAgrupador: sku,
      familyName: p.familyName ? String(p.familyName) : undefined,
      descripcion: p.descripcion != null ? String(p.descripcion) : undefined,
      extra: p.extra != null ? Number(p.extra) : undefined,
    };
  });
  return { productos: limpios, modeloItemId: String(modeloItemId).trim().toUpperCase() };
}

async function datosDeStocker(businessId, skus) {
  const locales = await stockService.localesQueAbastecenOnline(businessId);
  if (!locales.length) {
    throw Object.assign(
      new Error('Ningún local está marcado para abastecer las ventas online. Marcá al menos uno desde Empleados → Locales.'),
      { status: 409, detalles: { codigo: 'SIN_LUGAR_ONLINE' } },
    );
  }
  const variantes = await ProductVariant.findAll({
    where: { activo: true },
    include: [{
      model: Product, as: 'producto', required: true,
      where: { businessId, activo: true, skuAgrupador: skus, ...NO_ES_FERIA },
    }],
    order: [['id', 'ASC']],
  });
  // El mismo número que publica la sincronización: disponible en los locales online menos el margen.
  const cantidades = await cantidadesPublicables(businessId, locales, variantes);
  const datos = new Map();
  for (const v of variantes) {
    const prod = v.producto;
    if (!datos.has(prod.skuAgrupador)) {
      datos.set(prod.skuAgrupador, { titulo: prod.titulo, descripcion: prod.descripcion, costo: prod.costo, genero: prod.genero, variantes: [] });
    }
    const { color, talle } = ejesDe(v);
    datos.get(prod.skuAgrupador).variantes.push({
      sku: v.sku, color, talle, esPack: Boolean(v.esPack),
      stock: cantidades.get(v.id)?.cantidad || 0, costo: v.costo,
    });
  }
  return datos;
}

/** Todo lo que hace falta para armar la vista; `fresco` vuelve a leer lo ya publicado (al publicar de verdad). */
async function prepararVista(businessId, pedido, { fresco = false, http } = {}) {
  const { productos, modeloItemId } = validarPedido(pedido);
  const cuenta = await cuentaDe(businessId);
  const params = parametrosDe(cuenta);
  const headers = { Authorization: `Bearer ${await ml.tokenValido(cuenta)}` };
  const clavePublicados = `publicados:${businessId}`;
  if (fresco) cache.delete(clavePublicados);
  const [modelo, indice, publicados, datos] = await Promise.all([
    conCache(`modelo:${businessId}:${modeloItemId}`, TTL_MODELO_MS, () => leerModelo(modeloItemId, { headers, mlUserId: cuenta.mlUserId })),
    indiceDeFotos(params.tiendaUrl, params.fotosUrl || `${params.tiendaUrl}/fotos`, { http }),
    // Lo mismo que ve la sincronización, con los vínculos manuales: si no, un SKU vinculado a mano se publicaría de nuevo.
    conCache(clavePublicados, TTL_PUBLICADOS_MS, async () => (await ml.destinosDeLaCuenta(cuenta, businessId)).porSku),
    datosDeStocker(businessId, productos.map((p) => p.skuAgrupador)),
  ]);
  const propios = new Map();
  for (const { skuAgrupador } of productos) {
    const ya = (datos.get(skuAgrupador)?.variantes || []).map((v) => publicados.get(v.sku)).find(Boolean);
    if (!ya) continue;
    try {
      propios.set(skuAgrupador, await conCache(`modelo:${businessId}:${ya.mlItemId}`, TTL_MODELO_MS, () => leerModelo(ya.mlItemId, { headers, mlUserId: cuenta.mlUserId })));
    } catch (e) {
      propios.set(skuAgrupador, { error: e.message });
    }
  }
  const vista = armarVista({ productos, datos, parametros: params, modelo, propios, fotos: indice.porSku, publicados });
  // El modelo de cada producto: su propia publicación si ya tiene una, o el elegido.
  const modeloDe = (prod) => { const m = propios.get(prod.skuAgrupador); return m && !m.error ? m : modelo; };
  return { vista, modelo, modeloDe, params, headers, publicados, tienda: { url: params.tiendaUrl, fotosUrl: params.fotosUrl, productos: indice.productos, fallidos: indice.fallidos } };
}

const resumenDeModelo = (m) => ({
  itemId: m.itemId, titulo: m.titulo, categoriaId: m.categoriaId, tipo: m.tipo, tresCuotas: m.tresCuotas, genero: m.genero,
  envio: m.envio, garantia: m.saleTerms, maxFotos: m.maxFotos,
  atributos: m.atributos.map((a) => ({ id: a.id, valor: a.value_name })),
  guia: m.guia ? { id: m.guia.id, nombre: m.guia.nombre, talles: Object.keys(m.guia.filas) } : null,
});

async function vistaPrevia(businessId, pedido) {
  const { vista, modelo, params, tienda } = await prepararVista(businessId, pedido);
  return { modelo: resumenDeModelo(modelo), parametros: params, tienda, productos: vista };
}

/** Los ítems a mandar: las variantes publicables, de los productos elegidos (y de `skus`, si se pide un subconjunto). */
function itemsDe(vista, modeloDe, skus) {
  const items = [];
  for (const prod of vista) {
    for (const v of prod.variantes) {
      if (!v.publicable || (skus && !skus.includes(v.sku))) continue;
      items.push({ sku: v.sku, payload: armarItem({ modelo: modeloDe(prod), producto: prod, variante: v }), fantasma: !(v.stock > 0) });
    }
  }
  return items;
}

async function validar(businessId, pedido) {
  const { vista, modeloDe, headers } = await prepararVista(businessId, pedido);
  const skus = Array.isArray(pedido.skus) && pedido.skus.length ? pedido.skus.map(String) : null;
  return validarItems({ items: itemsDe(vista, modeloDe, skus), headers });
}

/*
 * La tanda. Corre como trabajo en segundo plano (ver el controlador): cien
 * variantes en serie son minutos. Devuelve cómo terminó cada SKU: publicada,
 * salteada (ya estaba), omitida (con sus problemas) o con el error de ML.
 */
async function publicar(businessId, pedido, { onProgreso = () => {}, http } = {}) {
  const { vista, modeloDe, headers, publicados } = await prepararVista(businessId, pedido, { fresco: true, http });
  const skus = Array.isArray(pedido.skus) && pedido.skus.length ? pedido.skus.map(String) : null;
  const items = itemsDe(vista, modeloDe, skus);
  const alCrear = ({ sku, itemId, titulo }) => MercadoLibreLink.findOrCreate({
    where: { businessId, sku }, defaults: { businessId, sku, mlItemId: String(itemId), mlVariationId: null, titulo: titulo || null },
  });
  const { porSku } = await publicarItems({ items, publicados, headers, onProgreso, alCrear });
  cache.delete(`publicados:${businessId}`);
  for (const prod of vista) {
    for (const v of prod.variantes) {
      if (porSku[v.sku] || (skus && !skus.includes(v.sku))) continue;
      porSku[v.sku] = v.yaPublicada
        ? { estado: 'salteada', itemId: v.yaPublicada.itemId, link: v.yaPublicada.link, motivo: 'Ese SKU ya está publicado en Mercado Libre.' }
        : { estado: 'omitida', problemas: v.problemas };
    }
    if (prod.problemas.length) porSku[prod.skuAgrupador] = { estado: 'omitida', problemas: prod.problemas };
  }
  const cuenta = (estado) => Object.values(porSku).filter((r) => r.estado === estado).length;
  return {
    publicadas: cuenta('publicada'), salteadas: cuenta('salteada'), omitidas: cuenta('omitida'), conError: cuenta('error'),
    porSku,
  };
}

module.exports = {
  PARAMETROS_POR_DEFECTO,
  parametros, guardarParametros, validarParametros,
  precioMl, fotosPorColor, indiceDeFotos, leerModelo, armarVista, armarItem,
  publicarItems, validarItems, con429,
  vistaPrevia, validar, publicar, validarPedido,
  __limpiarCache: () => cache.clear(),
};
