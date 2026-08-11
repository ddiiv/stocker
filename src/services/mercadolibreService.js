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
const { MercadoLibreAccount, MercadoLibreLink, ProductVariant, Product } = require('../models');
const { signToken, verifyToken } = require('../utils/jwt');

const ML_AUTH = 'https://auth.mercadolibre.com.ar';
const ML_API  = 'https://api.mercadolibre.com';

function config() {
  return {
    clientId:     process.env.ML_CLIENT_ID,
    clientSecret: process.env.ML_CLIENT_SECRET,
    redirectUri:  process.env.ML_REDIRECT_URI,
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
async function sincronizarStock(businessId, { simular = false, skus = null } = {}) {
  const cuenta = await MercadoLibreAccount.findOne({ where: { businessId } });
  if (!cuenta) throw Object.assign(new Error('No hay una cuenta de MercadoLibre conectada.'), { status: 400 });

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

    const cantidad = Math.max(0, Number(v.stock) || 0);
    const fila = {
      sku: v.sku, titulo: v.producto.titulo,
      mlItemId: destino.mlItemId, mlVariationId: destino.mlVariationId,
      stockStocker: cantidad, stockMl: destino.stockActual ?? null,
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

module.exports = {
  estaConfigurado,
  urlAutorizacion,
  leerState,
  conectarConCodigo,
  tokenValido,
  listarPublicaciones,
  mapearPorSku,
  sincronizarStock,
};
