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

const { NO_ES_FERIA } = require('../utils/feria');
const crypto = require('crypto');
const https = require('https');
const axios = require('axios');
const { MercadoLibreAccount, MercadoLibreLink, ProductVariant, Product, VariantStock } = require('../models');
const stockService = require('./stockService');
const packService = require('./packService');
const { signToken, verifyToken } = require('../utils/jwt');
const { log } = require('../utils/logger');

const ML_AUTH = 'https://auth.mercadolibre.com.ar';
const ML_API  = 'https://api.mercadolibre.com';

/*
 * ── El cliente HTTP hacia Mercado Libre ───────────────────────────
 *
 * Agente propio y no el global, por tres razones que se pagan con un catálogo
 * de doscientas publicaciones:
 *
 *   · TIMEOUT. Sin él, una petición que queda colgada frena la sincronización
 *     entera hasta que el sistema operativo la corte, que pueden ser minutos.
 *     Con doscientas publicaciones, una sola alcanza para que el usuario vea un
 *     spinner eterno y recargue, disparando una segunda sincronización encima.
 *
 *   · CONCURRENCIA ACOTADA. Se mandan varias a la vez, pero pocas: ML tiene
 *     límite de peticiones y pasarse devuelve 429 para todas. `maxSockets` es
 *     el techo real, no una sugerencia.
 *
 *   · LISTENERS. Node avisa cuando un emisor pasa de diez listeners del mismo
 *     tipo, y un socket keep-alive que atiende cientos de peticiones seguidas
 *     los acumula de a poco. Ese aviso —"MaxListenersExceededWarning: 11
 *     timeout listeners"— apareció sincronizando 204 publicaciones. No rompe
 *     nada: es un aviso, y la sincronización termina igual.
 *
 *     Se sube el techo SOBRE NUESTRO AGENTE y no globalmente, que sería tapar
 *     el aviso para todo el proceso. Acá sabemos cuántos esperamos: como mucho
 *     unos pocos por socket concurrente. Si algún día se acumulan de verdad,
 *     el aviso vuelve a aparecer y esa es la señal que se quiere conservar.
 *
 * Lo que de verdad achica el problema no es esto: es mandar menos peticiones.
 * Ver `sincronizarStock`, que sólo escribe lo que cambió, y la selección por
 * SKU, que deja elegir qué sincronizar en vez de barrer el catálogo entero.
 */
const CONCURRENCIA = Number(process.env.ML_CONCURRENCIA) || 4;
const TIMEOUT_MS = Number(process.env.ML_TIMEOUT_MS) || 20000;

const agenteML = new https.Agent({
  keepAlive: true,
  maxSockets: CONCURRENCIA,
  // Un socket ocioso más de 30s lo cierra ML igual: soltarlo antes evita
  // reusar uno muerto y comerse un ECONNRESET en la primera petición.
  keepAliveMsecs: 15000,
  timeout: TIMEOUT_MS,
});
agenteML.setMaxListeners(CONCURRENCIA * 8);

const httpML = axios.create({ timeout: TIMEOUT_MS, httpsAgent: agenteML });

/*
 * Corre `fn` sobre cada elemento, de a `limite` a la vez.
 *
 * Doscientas peticiones de a una son doscientas idas y vueltas en serie: a
 * 300ms cada una, un minuto entero con el usuario esperando. De a cuatro es el
 * mismo trabajo en un cuarto del tiempo, y cuatro es un número que ML tolera
 * sin devolver 429.
 *
 * No usa `Promise.all` sobre todo el arreglo: eso largaría doscientas a la vez,
 * que es exactamente cómo se llega al límite de peticiones y a que ML rechace
 * la mitad.
 */
async function enParalelo(items, limite, fn) {
  const resultados = new Array(items.length);
  let siguiente = 0;

  const obrero = async () => {
    for (;;) {
      const i = siguiente++;
      if (i >= items.length) return;
      resultados[i] = await fn(items[i], i);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limite, items.length) }, obrero),
  );
  return resultados;
}

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
/*
 * ── PKCE ──────────────────────────────────────────────────────────
 *
 * Se manda un `code_challenge` en la ida y el `code_verifier` en la vuelta.
 * MercadoLibre los cruza y así el `code` que viaja por la barra del navegador
 * no le sirve a nadie más: sin el verifier no se canjea por un token.
 *
 * Va apagado salvo que se pida con ML_PKCE=1, y tiene que coincidir con el
 * tilde "Requiere PKCE" del panel de la aplicación. Los dos lados van juntos:
 * con el tilde puesto y sin mandar el challenge, la autorización falla para
 * todas las cuentas por igual; al revés, mandarlo cuando la app no lo espera
 * es meter un campo que MercadoLibre no pidió en el único momento del flujo
 * que no se puede probar sin una cuenta real.
 *
 * O sea: primero el tilde en el panel, después la variable. Nunca al revés.
 *
 * El verifier viaja adentro del `state`, que va firmado y dura diez minutos.
 * Es un compromiso conocido: quien pueda leer el state lee el verifier. Se
 * acepta porque acá el PKCE es una defensa de más y no la única —el canje
 * pide igual el client_secret, que no sale del servidor—, y porque la
 * alternativa, guardarlo del lado del servidor, se rompe con dos instancias o
 * con un deploy en el medio de la autorización. Un usuario que quedó a mitad
 * de camino porque justo se reinició el proceso es peor que esto.
 */
function usaPkce() {
  return process.env.ML_PKCE === '1';
}

function generarPkce() {
  const verifier = crypto.randomBytes(32).toString('base64url'); // 43 caracteres
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function firmarState(businessId, verifier = null) {
  const payload = { tipo: 'ml_oauth', businessId };
  if (verifier) payload.v = verifier;
  return signToken(payload, { expiresIn: '10m' });
}

function leerState(state) {
  try {
    const payload = verifyToken(String(state || ''));
    if (payload?.tipo !== 'ml_oauth') return null;
    const businessId = Number(payload.businessId) || null;
    if (!businessId) return null;
    // El verifier puede no estar: un state emitido antes de que existiera PKCE
    // y usado dentro de sus diez minutos. Se deja pasar sin él.
    return { businessId, verifier: payload.v || null };
  } catch {
    return null; // firma inválida, vencido o manipulado
  }
}

function urlAutorizacion(businessId) {
  const c = config();
  const pkce = usaPkce() ? generarPkce() : null;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     c.clientId,
    redirect_uri:  c.redirectUri,
    state:         firmarState(businessId, pkce?.verifier || null),
  });
  if (pkce) {
    params.set('code_challenge', pkce.challenge);
    params.set('code_challenge_method', 'S256');
  }
  return `${ML_AUTH}/authorization?${params}`;
}

/** Canjea el `code` del callback por tokens y guarda la cuenta. */
async function conectarConCodigo({ businessId, code, verifier = null }) {
  const c = config();
  const cuerpo = {
    grant_type:    'authorization_code',
    client_id:     c.clientId,
    client_secret: c.clientSecret,
    code,
    redirect_uri:  c.redirectUri,
  };
  // El verifier sólo si la ida llevó challenge. Mandarlo vacío es peor que no
  // mandarlo: MercadoLibre lo compara igual y no coincide con nada.
  if (verifier) cuerpo.code_verifier = verifier;

  const { data } = await httpML.post(`${ML_API}/oauth/token`, new URLSearchParams(cuerpo),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

  const perfil = await httpML.get(`${ML_API}/users/me`, {
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
    // El nickname y el id de ML identifican al vendedor: queda el hecho de que
    // cambió, que es lo que explica los vínculos SKU↔publicación rotos.
    log.warn('mercadolibre', 'el negocio cambió de cuenta conectada', { negocio: businessId });
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
    const { data } = await httpML.post(`${ML_API}/oauth/token`, new URLSearchParams({
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
    const { data } = await httpML.get(`${ML_API}/users/${cuenta.mlUserId}/items/search`, {
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
    const { data } = await httpML.get(`${ML_API}/items`, {
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
    await httpML.put(`${ML_API}/items/${mlItemId}`, {
      variations: [{ id: Number(mlVariationId), available_quantity: cantidad }],
    }, { headers });
  } else {
    await httpML.put(`${ML_API}/items/${mlItemId}`, { available_quantity: cantidad }, { headers });
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

  /*
   * Se publica la suma de los locales que abastecen las ventas online.
   *
   * Antes se publicaba el stock de UN local designado, y eso obligaba a tener
   * mercadería apartada ahí para poder vender por internet. En un negocio con
   * varias sucursales que despachan de donde haya, esa cuenta siempre estaba
   * mal: o se publicaba de menos y se perdían ventas, o se apartaba stock que
   * al mostrador le hacía falta.
   *
   * Ahora la tienda online no guarda nada: administra. El stock vendible por
   * internet es el que está en los locales de venta, y el descuento sale de
   * ahí. Cuál local abastece se marca por local, así una sucursal que no
   * despacha envíos puede quedar afuera sin dejar de vender por mostrador.
   */
  const locales = await stockService.localesQueAbastecenOnline(businessId);
  if (!locales.length) {
    throw Object.assign(
      new Error(
        'Ningún local está marcado para abastecer las ventas online. Marcá al menos uno desde '
        + 'Empleados → Locales: ese es el stock que se va a publicar y del que se van a descontar '
        + 'las ventas por internet.',
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
    /*
     * Los de feria quedan afuera: no llevan stock, así que publicar el suyo
     * sería anunciar cero unidades de algo que se vende igual, o peor, pisar la
     * publicación de su equivalente del catálogo normal.
     */
    include: [{
      model: Product, as: 'producto', required: true,
      where: { businessId, activo: true, ...NO_ES_FERIA },
    }],
  });

  /*
   * El stock de todas las variantes en una sola consulta.
   *
   * Preguntarlo de a una eran tantas idas a la base como artículos publicados:
   * con dos mil variantes, dos mil consultas por sincronización. Se trae todo
   * junto y se suma en memoria, que es una lectura chica y acotada al negocio.
   */
  const filasStock = await VariantStock.findAll({
    where: { businessId, locationId: locales.map((l) => l.id) },
    attributes: ['productVariantId', 'stock', 'reservado'],
  });
  const stockPorVariante = new Map();
  for (const f of filasStock) {
    /*
     * Lo DISPONIBLE, no lo que hay en el estante.
     *
     * Una unidad apartada para un pedido online sigue en el estante hasta que
     * alguien la despacha, pero no se puede volver a vender: publicarla sería
     * ofrecer dos veces la misma prenda, que es justo lo que la reserva vino a
     * evitar. Esta consulta arma su propio mapa por rendimiento y por eso hay
     * que restar acá también: `stockOnline` no pasa por este camino.
     */
    const libre = Math.max(0, (Number(f.stock) || 0) - (Number(f.reservado) || 0));
    stockPorVariante.set(
      f.productVariantId,
      (stockPorVariante.get(f.productVariantId) || 0) + libre,
    );
  }

  /*
   * Los packs no tienen fila en `variant_stocks`: lo que hay de un pack es lo
   * que alcance para armarlo con lo que lleva adentro.
   *
   * Sin esto, cada pack publicado en Mercado Libre saldría con stock cero —
   * dejaría de venderse de un día para el otro y sin explicación visible—.
   *
   * La cuenta se hace en bloque para todos los packs a la vez: de a uno serían
   * dos consultas por pack, y en un catálogo con cincuenta packs eso es cien
   * idas a la base por sincronización.
   */
  const idsPacks = variantes.filter((v) => v.esPack).map((v) => v.id);
  if (idsPacks.length) {
    const armables = await packService.disponibleDePacksEnLocales(
      idsPacks, locales.map((l) => l.id), businessId,
    );
    for (const [packId, cuantos] of armables) stockPorVariante.set(packId, cuantos);
  }

  const sincronizados = [];
  const sinPublicacion = [];

  /*
   * ── Primero se decide, después se manda ─────────────────────────
   *
   * Antes esto era un solo bucle que calculaba y mandaba en el mismo paso, de a
   * una publicación por vez. Con doscientas eso son doscientas idas y vueltas
   * en serie: a 300ms cada una, un minuto largo con el usuario mirando un
   * spinner, y cualquier corte en el medio deja media sincronización hecha sin
   * forma de saber cuál.
   *
   * Separarlo permite dos cosas. La cuenta se hace entera y rápido, sin red de
   * por medio; y lo que hay que mandar se manda de a varios a la vez.
   */
  const resultados = [];
  const aMandar = [];

  for (const v of variantes) {
    if (skus && !skus.includes(v.sku)) continue;
    const destino = porSku.get(v.sku);
    if (!destino) { sinPublicacion.push(v.id); continue; } // el SKU no está publicado en ML

    /*
     * El stock que abastece online, no el total.
     *
     * El negativo se publica como cero: un artículo que quedó en -3 por
     * venderse sin cargar no tiene nada para despachar, y mandar el negativo
     * a ML sería pedirle que ofrezca deuda.
     */
    const cantidad = Math.max(0, stockPorVariante.get(v.id) || 0);
    const fila = {
      sku: v.sku, titulo: v.producto.titulo,
      mlItemId: destino.mlItemId, mlVariationId: destino.mlVariationId,
      stockStocker: cantidad, stockMl: destino.stockActual ?? null,
      lugar: locales.map((l) => l.nombre).join(', '),
      manual: Boolean(destino.manual),
    };

    /*
     * Lo que ya coincide no se toca. Es el ahorro más grande de todos: en una
     * sincronización de rutina, casi nada cambió, y mandar doscientas
     * peticiones para escribir el mismo número es gastar el límite de la API
     * en no hacer nada.
     */
    if (destino.stockActual === cantidad) {
      sincronizados.push(v.id);
      resultados.push({ ...fila, estado: 'sin-cambios' });
      continue;
    }

    if (simular) {
      resultados.push({ ...fila, estado: 'pendiente' });
      continue;
    }

    aMandar.push({ v, destino, cantidad, fila });
  }

  // De a cuatro y no de a doscientas: ver `enParalelo`. El orden del resultado
  // se conserva, así que la pantalla muestra lo mismo que antes.
  const enviados = await enParalelo(aMandar, CONCURRENCIA, async ({ v, destino, cantidad, fila }) => {
    try {
      await actualizarStock(token, { ...destino, cantidad });
      await MercadoLibreLink.update(
        { ultimoStockEnviado: cantidad, ultimaSync: new Date(), ultimoError: null },
        { where: { businessId, sku: v.sku } },
      );
      return { variantId: v.id, fila: { ...fila, estado: 'actualizado' } };
    } catch (err) {
      const detalle = err.response?.data?.message || err.message;
      await MercadoLibreLink.update(
        { ultimoError: detalle }, { where: { businessId, sku: v.sku } },
      );
      return { variantId: null, fila: { ...fila, estado: 'error', error: detalle } };
    }
  });

  for (const e of enviados) {
    if (e.variantId) sincronizados.push(e.variantId);
    resultados.push(e.fila);
  }

  // SKUs publicados en ML que no existen en Stocker: los reportamos para que
  // el usuario sepa qué quedó sin vincular.
  const skusStocker = new Set(variantes.map((v) => v.sku));
  const huerfanosMl = [...porSku.entries()]
    .filter(([sku]) => !skusStocker.has(sku))
    .map(([sku, d]) => ({ sku, mlItemId: d.mlItemId, titulo: d.titulo }));

  if (!simular) {
    await cuenta.update({ ultimaSync: new Date(), ultimoError: null });

    /*
     * Queda anotado en la variante si está sincronizada o no.
     *
     * Es lo que después se ve en Stock, al lado del artículo. Sin esto la única
     * forma de saber si algo está publicado era abrir la sincronización y leer
     * el listado entero.
     *
     * Se escribe de a dos consultas y no de a una por variante: son las mismas
     * dos sin importar si el catálogo tiene diez artículos o dos mil.
     *
     * Hoy guarda una plataforma sola porque hay una sola. Cuando entre
     * Jumpseller hay que juntar las dos acá, no pisar una con la otra.
     */
    if (sincronizados.length) {
      await ProductVariant.update(
        { sincronizadoCon: 'mercadolibre', sincronizadoEn: new Date() },
        { where: { id: sincronizados } },
      );
    }
    // El que dejó de estar publicado deja de figurar como sincronizado: si no,
    // una publicación borrada en ML seguiría mostrándose como al día para siempre.
    if (sinPublicacion.length) {
      await ProductVariant.update(
        { sincronizadoCon: null, sincronizadoEn: null },
        { where: { id: sinPublicacion, sincronizadoCon: 'mercadolibre' } },
      );
    }
  }

  return {
    simulado: simular,
    lugares: locales.map((l) => ({ id: l.id, nombre: l.nombre, tipo: l.tipo })),
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
  marcarParaSync,
  urlAutorizacion,
  leerState,
  conectarConCodigo,
  tokenValido,
  listarPublicaciones,
  mapearPorSku,
  sincronizarStock,
};
