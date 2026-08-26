/*
 * Integración con MercadoLibre — sincronización de stock por SKU.
 *
 * Alcance deliberadamente acotado: NO crea ni edita publicaciones, no toca
 * precios ni descripciones. Solo empuja la cantidad disponible de Stocker
 * hacia las publicaciones de ML que matcheen por SKU.
 *
 * El matcheo usa, en orden:
 *   1. El vínculo manual guardado en mercadolibre_links (si el usuario lo fijó).
 *   2. El campo `seller_custom_field` de la publicación (el "SKU" que ML
 *      muestra en el panel del vendedor).
 *   3. El atributo SELLER_SKU de la publicación o de cada variación.
 *
 * OAuth: el access_token dura 6h. El refresh_token dura 6 meses PERO se rota
 * en cada refresh — hay que guardar el nuevo o perdés el acceso.
 *
 * Variables de entorno necesarias:
 *   ML_CLIENT_ID       — App ID de tu aplicación en developers.mercadolibre.com.ar
 *   ML_CLIENT_SECRET   — Secret de la app
 *   ML_REDIRECT_URI    — Redirect URI registrada (ej. https://tu-back.railway.app/api/mercadolibre/callback)
 */

const axios = require('axios');
const { MercadoLibreAccount, MercadoLibreLink, ProductVariant, Product, BusinessLocation } = require('../models');
const stockService = require('./stockService');
const { signToken, verifyToken } = require('../utils/jwt');
const { log } = require('../utils/logger');

const ML_AUTH = 'https://auth.mercadolibre.com.ar';
const ML_API  = 'https://api.mercadolibre.com';

// El callback tiene que caer en el FRONT, que es el único servicio con dominio
// público: desde ahí el proxy lo reenvía al backend por la red privada. Si no
// se define ML_REDIRECT_URI, se arma con el dominio compartido del proyecto.
//
// Ojo: MercadoLibre compara esta URL carácter por carácter contra la que
// tengas registrada en developers.mercadolibre.com.ar. Si no coinciden
// exactamente, rechaza la autorización.
function redirectUri() {
  if (process.env.ML_REDIRECT_URI) return process.env.ML_REDIRECT_URI;
  const dominio = process.env.FRONTEND_DOMAIN || process.env.FRONTEND_URL;
  if (!dominio) return null;
  const base = /^https?:\/\//i.test(dominio) ? dominio : `https://${dominio}`;
  return `${base.replace(/\/+$/, '')}/api/mercadolibre/callback`;
}

function config() {
  return {
    clientId:     process.env.ML_CLIENT_ID,
    clientSecret: process.env.ML_CLIENT_SECRET,
    redirectUri:  redirectUri(),
  };
}

function estaConfigurado() {
  const c = config();
  return Boolean(c.clientId && c.clientSecret && c.redirectUri);
}

// ── OAuth ─────────────────────────────────────────────────────────

/** URL a la que mandamos al usuario para que autorice la app. */
// `state` viaja de ida y vuelta para saber de qué negocio es el callback.
//
// Va firmado y no en crudo: con el businessId a la vista (un entero chico),
// cualquiera podía pedirle a ML un `code` de su propia cuenta y después armar
// a mano .../callback?code=<suyo>&state=<id de la víctima>, dejando su cuenta
// de MercadoLibre enganchada al negocio de otro. Al firmarlo, un state que no
// haya salido de acá no valida. Los 10 minutos acotan la ventana de reuso.
function firmarState(businessId) {
  return signToken({ tipo: 'ml_oauth', businessId }, { expiresIn: '10m' });
}

function leerState(state) {
  try {
    const payload = verifyToken(String(state || ''));
    if (payload?.tipo !== 'ml_oauth') return null;
    return Number(payload.businessId) || null;
  } catch {
    return null; // firma inválida, vencido o manipulado
  }
}

function urlAutorizacion(businessId) {
  const c = config();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     c.clientId,
    redirect_uri:  c.redirectUri,
    state:         firmarState(businessId),
  });
  return `${ML_AUTH}/authorization?${params}`;
}

/** Canjea el `code` del callback por tokens y guarda la cuenta. */
async function conectarConCodigo({ businessId, code }) {
  const c = config();
  const { data } = await axios.post(`${ML_API}/oauth/token`, new URLSearchParams({
    grant_type:    'authorization_code',
    client_id:     c.clientId,
    client_secret: c.clientSecret,
    code,
    redirect_uri:  c.redirectUri,
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

  const perfil = await axios.get(`${ML_API}/users/me`, {
    headers: { Authorization: `Bearer ${data.access_token}` },
  }).then((r) => r.data).catch(() => ({}));

  const valores = {
    businessId,
    mlUserId:      String(data.user_id || perfil.id || ''),
    nickname:      perfil.nickname || null,
    accessToken:   data.access_token,
    refreshToken:  data.refresh_token,
    tokenExpiraEn: new Date(Date.now() + (data.expires_in || 21600) * 1000),
    ultimoError:   null,
  };

  // Un negocio = una sola cuenta de ML (la tabla tiene businessId único).
  // Si ya había una conectada, reconectar la reemplaza; dejamos registro en el
  // log porque cambiar de cuenta invalida los vínculos SKU↔publicación viejos.
  const existente = await MercadoLibreAccount.findOne({ where: { businessId } });
  if (existente && existente.mlUserId && existente.mlUserId !== valores.mlUserId) {
    console.warn(
      `[ML] El negocio ${businessId} cambió de cuenta: ${existente.nickname || existente.mlUserId} → ${valores.nickname || valores.mlUserId}.`,
    );
  }
  if (existente) {
    await existente.update(valores);
    return existente;
  }
  return MercadoLibreAccount.create(valores);
}

/**
 * Devuelve un access_token válido, renovándolo si está por vencer.
 * OJO: ML rota el refresh_token en cada renovación, por eso lo persistimos.
 */
async function tokenValido(cuenta) {
  const margenMs = 5 * 60 * 1000; // renovamos 5 min antes de que expire
  if (cuenta.accessToken && cuenta.tokenExpiraEn && new Date(cuenta.tokenExpiraEn).getTime() - margenMs > Date.now()) {
    return cuenta.accessToken;
  }
  if (!cuenta.refreshToken) throw new Error('La cuenta de MercadoLibre no está conectada. Volvé a autorizar la app.');

  const c = config();
  try {
    const { data } = await axios.post(`${ML_API}/oauth/token`, new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     c.clientId,
      client_secret: c.clientSecret,
      refresh_token: cuenta.refreshToken,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    await cuenta.update({
      accessToken:   data.access_token,
      refreshToken:  data.refresh_token || cuenta.refreshToken,
      tokenExpiraEn: new Date(Date.now() + (data.expires_in || 21600) * 1000),
      ultimoError:   null,
    });
    return data.access_token;
  } catch (err) {
    const detalle = err.response?.data?.message || err.message;
    await cuenta.update({ ultimoError: `Renovación de token falló: ${detalle}` });
    throw new Error(`No se pudo renovar el acceso a MercadoLibre: ${detalle}. Reconectá la cuenta.`);
  }
}

// ── Publicaciones ─────────────────────────────────────────────────

/** Trae todas las publicaciones activas del vendedor, con su SKU. */
async function listarPublicaciones(cuenta) {
  const token = await tokenValido(cuenta);
  const headers = { Authorization: `Bearer ${token}` };

  // El search de items pagina de a 50 y tiene tope de 1000 con offset.
  // Para catálogos grandes ML recomienda scan, pero para el volumen típico
  // de un negocio chico el offset alcanza.
  const ids = [];
  let offset = 0;
  for (;;) {
    const { data } = await axios.get(`${ML_API}/users/${cuenta.mlUserId}/items/search`, {
      headers, params: { status: 'active', limit: 50, offset },
    });
    ids.push(...(data.results || []));
    offset += 50;
    if (ids.length >= (data.paging?.total || 0) || offset >= 1000 || !data.results?.length) break;
  }
  if (!ids.length) return [];

  // El endpoint multiget acepta hasta 20 ids por llamada.
  const publicaciones = [];
  for (let i = 0; i < ids.length; i += 20) {
    const lote = ids.slice(i, i + 20);
    const { data } = await axios.get(`${ML_API}/items`, {
      headers,
      params: { ids: lote.join(','), attributes: 'id,title,available_quantity,seller_custom_field,variations,attributes,permalink,status' },
    });
    for (const entrada of data) {
      if (entrada.code !== 200 || !entrada.body) continue;
      publicaciones.push(entrada.body);
    }
  }
  return publicaciones;
}

/** Extrae el SKU de una publicación o de una de sus variaciones. */
function skuDe(objeto) {
  if (!objeto) return null;
  if (objeto.seller_custom_field) return String(objeto.seller_custom_field).trim();
  const attr = (objeto.attributes || []).find((a) => a.id === 'SELLER_SKU');
  if (attr?.value_name) return String(attr.value_name).trim();
  return null;
}

/**
 * Arma el mapa SKU → destino en ML a partir de las publicaciones.
 * Una publicación con variaciones expone un SKU por variación.
 */
function mapearPorSku(publicaciones) {
  const mapa = new Map();
  for (const item of publicaciones) {
    if (item.variations?.length) {
      for (const v of item.variations) {
        const sku = skuDe(v);
        if (sku) mapa.set(sku, { mlItemId: item.id, mlVariationId: String(v.id), titulo: item.title, stockActual: v.available_quantity });
      }
      // Una publicación con variaciones puede además tener SKU a nivel item;
      // no lo usamos porque el stock se maneja por variación.
      continue;
    }
    const sku = skuDe(item);
    if (sku) mapa.set(sku, { mlItemId: item.id, mlVariationId: null, titulo: item.title, stockActual: item.available_quantity });
  }
  return mapa;
}

// ── Sincronización de stock ───────────────────────────────────────

/** Envía la cantidad disponible a una publicación (o variación). */
async function actualizarStock(token, { mlItemId, mlVariationId, cantidad }) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (mlVariationId) {
    await axios.put(`${ML_API}/items/${mlItemId}`, {
      variations: [{ id: Number(mlVariationId), available_quantity: cantidad }],
    }, { headers });
  } else {
    await axios.put(`${ML_API}/items/${mlItemId}`, { available_quantity: cantidad }, { headers });
  }
}

/**
 * Sincroniza el stock de Stocker hacia ML.
 * @param {number} businessId
 * @param {object} opts
 * @param {boolean} opts.simular  Si es true, calcula los cambios pero no los envía.
 * @param {string[]} opts.skus    Si viene, sincroniza solo esos SKUs.
 */
/*
 * De qué lugar sale el stock que se publica.
 *
 * El elegido en la cuenta; si no hay, el primero de tipo `online`. Nunca el
 * total de la variante: desde que el stock es por local, ese total incluye el
 * depósito, donde la mercadería rota todo el tiempo y puede salir para una
 * sucursal en cualquier momento. Publicarlo es ofrecer online algo que quizá
 * ya no esté para despachar.
 *
 * Sin ningún lugar designado devuelve null y la sincronización se frena con un
 * mensaje, en vez de caer al total en silencio y volver al problema de antes.
 */
async function lugarDePublicacion(businessId, cuenta = null) {
  const acc = cuenta || await MercadoLibreAccount.findOne({ where: { businessId } });

  if (acc?.locationId) {
    const elegido = await BusinessLocation.findOne({
      where: { id: acc.locationId, businessId, activo: true },
    });
    if (elegido) return elegido;
  }

  return BusinessLocation.findOne({
    where: { businessId, activo: true, tipo: 'online' },
    order: [['id', 'ASC']],
  });
}

async function sincronizarStock(businessId, { simular = false, skus = null } = {}) {
  const cuenta = await MercadoLibreAccount.findOne({ where: { businessId } });
  if (!cuenta) throw Object.assign(new Error('No hay una cuenta de MercadoLibre conectada.'), { status: 400 });

  const lugar = await lugarDePublicacion(businessId, cuenta);
  if (!lugar) {
    throw Object.assign(
      new Error(
        'No hay un lugar designado para publicar en MercadoLibre. Marcá uno de tus locales como "Online / Envíos" '
        + 'desde Empleados → Locales: es el stock que se va a publicar.',
      ),
      { status: 409, detalles: { codigo: 'SIN_LUGAR_ONLINE' } },
    );
  }

  const token = await tokenValido(cuenta);
  const publicaciones = await listarPublicaciones(cuenta);
  const porSku = mapearPorSku(publicaciones);

  // Vínculos manuales: pisan lo que se detecte automáticamente.
  const manuales = await MercadoLibreLink.findAll({ where: { businessId } });
  for (const l of manuales) {
    porSku.set(l.sku, { mlItemId: l.mlItemId, mlVariationId: l.mlVariationId, titulo: l.titulo, manual: true });
  }

  // Stock actual en Stocker
  const variantes = await ProductVariant.findAll({
    include: [{ model: Product, as: 'producto', where: { businessId, activo: true } }],
  });

  const resultados = [];
  for (const v of variantes) {
    if (skus && !skus.includes(v.sku)) continue;
    const destino = porSku.get(v.sku);
    if (!destino) continue; // el SKU no está publicado en ML

    /*
     * El stock DEL LUGAR de publicación, no el total.
     *
     * El negativo se publica como cero: un artículo que quedó en -3 por
     * venderse sin cargar no tiene nada para despachar, y mandar el negativo
     * a ML sería pedirle que ofrezca deuda.
     */
    const enLugar = await stockService.stockEn(v.id, lugar.id);
    const cantidad = Math.max(0, Number(enLugar) || 0);
    const fila = {
      sku: v.sku, titulo: v.producto.titulo,
      mlItemId: destino.mlItemId, mlVariationId: destino.mlVariationId,
      stockStocker: cantidad, stockMl: destino.stockActual ?? null,
      lugar: lugar.nombre,
      manual: Boolean(destino.manual),
    };

    if (destino.stockActual === cantidad) {
      resultados.push({ ...fila, estado: 'sin-cambios' });
      continue;
    }

    if (simular) {
      resultados.push({ ...fila, estado: 'pendiente' });
      continue;
    }

    try {
      await actualizarStock(token, { ...destino, cantidad });
      resultados.push({ ...fila, estado: 'actualizado' });
      await MercadoLibreLink.update(
        { ultimoStockEnviado: cantidad, ultimaSync: new Date(), ultimoError: null },
        { where: { businessId, sku: v.sku } },
      );
    } catch (err) {
      const detalle = err.response?.data?.message || err.message;
      resultados.push({ ...fila, estado: 'error', error: detalle });
      await MercadoLibreLink.update(
        { ultimoError: detalle }, { where: { businessId, sku: v.sku } },
      );
    }
  }

  // SKUs publicados en ML que no existen en Stocker: los reportamos para que
  // el usuario sepa qué quedó sin vincular.
  const skusStocker = new Set(variantes.map((v) => v.sku));
  const huerfanosMl = [...porSku.entries()]
    .filter(([sku]) => !skusStocker.has(sku))
    .map(([sku, d]) => ({ sku, mlItemId: d.mlItemId, titulo: d.titulo }));

  if (!simular) {
    await cuenta.update({ ultimaSync: new Date(), ultimoError: null });
  }

  return {
    simulado: simular,
    lugar: { id: lugar.id, nombre: lugar.nombre, tipo: lugar.tipo },
    publicacionesEncontradas: publicaciones.length,
    skusEnMl: porSku.size,
    resultados,
    huerfanosMl,
    resumen: {
      actualizados: resultados.filter((r) => r.estado === 'actualizado').length,
      pendientes:   resultados.filter((r) => r.estado === 'pendiente').length,
      sinCambios:   resultados.filter((r) => r.estado === 'sin-cambios').length,
      errores:      resultados.filter((r) => r.estado === 'error').length,
    },
  };
}

/* ── Sincronización automática ─────────────────────────────────────
 *
 * Cada movimiento que toca el lugar de publicación deja ese SKU marcado, y
 * unos segundos después se manda a MercadoLibre.
 *
 * Tres decisiones que valen la pena explicar:
 *
 * 1. NUNCA rompe la operación que la disparó. Se llama sin await y todo error
 *    queda adentro: si ML no responde, la venta se hace igual. Un inventario
 *    desactualizado en la publicación se arregla con la próxima pasada; una
 *    venta que no se pudo cobrar porque ML estaba caído, no.
 *
 * 2. Se agrupa con una demora corta. Una venta de cinco artículos son cinco
 *    movimientos en el mismo segundo: sin agrupar serían cinco pedidos a ML
 *    con el mismo token, y la API tiene límites.
 *
 * 3. Sólo mira los SKU marcados. Sincronizar el catálogo entero después de
 *    cada venta sería pedirle a ML cientos de publicaciones para actualizar
 *    una.
 */
const DEMORA_SYNC_MS = Number(process.env.ML_SYNC_DEMORA_MS) || 6000;

// businessId → { skus: Set, timer }
const pendientesSync = new Map();

async function correrSyncPendiente(businessId) {
  const entrada = pendientesSync.get(businessId);
  if (!entrada) return;
  pendientesSync.delete(businessId);

  const skus = [...entrada.skus];
  if (!skus.length) return;

  try {
    const r = await sincronizarStock(businessId, { skus });
    if (r.resumen.actualizados || r.resumen.errores) {
      log.info('mercadolibre', 'sincronización automática', {
        businessId, skus: skus.length,
        actualizados: r.resumen.actualizados, errores: r.resumen.errores,
      });
    }
  } catch (e) {
    /*
     * Se avisa y se sigue. Los casos comunes —cuenta desconectada, sin lugar
     * online, token vencido— no son errores de la venta que lo disparó, y el
     * botón de sincronizar manual sigue estando para cuando se resuelvan.
     */
    log.warn('mercadolibre', 'no se pudo sincronizar automáticamente', {
      businessId, motivo: e.message?.slice(0, 200),
    });
  }
}

/*
 * Marca un SKU para sincronizar. La llama stockService en cada movimiento.
 *
 * Devuelve enseguida: lo único que hace es anotar y programar. Comprobar si el
 * negocio tiene ML conectado se deja para el momento del envío, porque hacerlo
 * acá sería una consulta a la base por cada línea de cada venta.
 */
function marcarParaSync(businessId, sku) {
  if (!businessId || !sku || !estaConfigurado()) return;

  let entrada = pendientesSync.get(businessId);
  if (!entrada) {
    entrada = { skus: new Set(), timer: null };
    pendientesSync.set(businessId, entrada);
  }
  entrada.skus.add(sku);

  clearTimeout(entrada.timer);
  entrada.timer = setTimeout(() => { correrSyncPendiente(businessId); }, DEMORA_SYNC_MS);
  // Que un envío pendiente no impida cerrar el proceso en un deploy.
  entrada.timer.unref?.();
}

module.exports = {
  estaConfigurado,
  lugarDePublicacion,
  marcarParaSync,
  urlAutorizacion,
  leerState,
  conectarConCodigo,
  tokenValido,
  listarPublicaciones,
  mapearPorSku,
  sincronizarStock,
};
