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

const MARGEN_RENOVACION_MS = 5 * 60 * 1000; // renovamos 5 min antes de que expire

/*
 * Renovaciones en curso, por cuenta.
 *
 * El refresh_token de ML es de UN SOLO USO: al canjearlo, el anterior queda
 * muerto. Y las renovaciones llegan de a montones, no de a una: el token dura
 * seis horas, y cuando vence, lo que despierta al sistema suele ser una ráfaga
 * de notificaciones —ML manda hasta ocho por venta— que entran en paralelo
 * como pedidos HTTP distintos. Las ocho leen el mismo refresh_token vencido y
 * las ocho lo canjean: gana una y las otras siete reciben `invalid_grant`,
 * escriben "Reconectá la cuenta" en la pantalla del cliente y lo mandan a
 * rehacer una autorización que no hacía falta.
 *
 * Con esto, la primera que llega hace el canje y las demás esperan SU
 * resultado en vez de pedir otro. Es por proceso, no por base: alcanza para el
 * caso real —un servicio, muchas peticiones—, y el `catch` de abajo cubre lo
 * que esto no puede cubrir.
 */
const renovaciones = new Map();

function estaVigente(cuenta) {
  return Boolean(cuenta.accessToken)
    && Boolean(cuenta.tokenExpiraEn)
    && new Date(cuenta.tokenExpiraEn).getTime() - MARGEN_RENOVACION_MS > Date.now();
}

/**
 * Devuelve un access_token válido, renovándolo si está por vencer.
 * OJO: ML rota el refresh_token en cada renovación, por eso lo persistimos.
 */
async function tokenValido(cuenta) {
  if (estaVigente(cuenta)) return cuenta.accessToken;
  if (!cuenta.refreshToken) throw new Error('La cuenta de MercadoLibre no está conectada. Volvé a autorizar la app.');

  const enCurso = renovaciones.get(cuenta.id);
  if (enCurso) return enCurso;

  const promesa = renovarToken(cuenta).finally(() => renovaciones.delete(cuenta.id));
  renovaciones.set(cuenta.id, promesa);
  return promesa;
}

async function renovarToken(cuenta) {
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
    /*
     * Antes de dar la cuenta por caída, mirar si otro ya la renovó.
     *
     * El candado de arriba es por proceso: con dos instancias del backend, o
     * con el barrido y un webhook cayendo en instancias distintas, las dos
     * pueden canjear el mismo refresh_token y una va a fallar aunque la cuenta
     * haya quedado perfectamente conectada. Releer la fila lo distingue: si
     * hay un access_token vigente, esto no fue una desconexión sino una
     * carrera, y la respuesta correcta es usar el token que ya está.
     */
    try {
      await cuenta.reload();
      if (estaVigente(cuenta)) {
        log.warn('mercadolibre', 'renovación en carrera: ya había un token vigente', { cuenta: cuenta.id });
        return cuenta.accessToken;
      }
    } catch { /* si ni releer se puede, sigue el error original */ }

    const detalle = err.response?.data?.message || err.message;
    await cuenta.update({ ultimoError: `Renovación de token falló: ${detalle}` });
    throw new Error(`No se pudo renovar el acceso a MercadoLibre: ${detalle}. Reconectá la cuenta.`);
  }
}

// ── Publicaciones ─────────────────────────────────────────────────

/*
 * Qué publicaciones se traen: activas Y pausadas.
 *
 * Una publicación que se quedó sin stock no desaparece: Mercado Libre la pausa
 * con el sub estado out_of_stock, y cuando se le vuelve a mandar stock la
 * reactiva sola. Buscando sólo las activas, justo las que había que reponer
 * nunca entraban en la sincronización: quedaban pausadas para siempre aunque
 * en el local hubiera mercadería. Las finalizadas no se traen: no aceptan
 * cambios.
 */
const ESTADOS_A_TRAER = ['active', 'paused'];
/*
 * El checklist mira además las finalizadas. No aceptan cambios de stock —eso
 * lo decide ML, que sólo deja republicarlas—, pero son justo las que hay que
 * ver: una publicación vieja que quedó cerrada es stock que no se está
 * ofreciendo y que, sin esta lista, no aparece en ningún lado.
 */
const ESTADOS_CON_FINALIZADAS = [...ESTADOS_A_TRAER, 'closed'];
const TAM_PAGINA_SCAN = 100;
const ESPERA_CONFLICTO_MS = Number(process.env.ML_ESPERA_CONFLICTO_MS) || 1500;

/*
 * Todos los ids del vendedor en un estado.
 *
 * Con offset, ML corta en 1000: un catálogo más grande quedaba a medias sin
 * ningún aviso. El modo scan no tiene tope; su scroll_id vence a los 5
 * minutos, así que primero se juntan los ids y recién después se piden los
 * detalles. Si la cuenta no acepta scan, se vuelve al offset de antes.
 */
async function idsDelVendedor(cuenta, headers, status) {
  const url = `${ML_API}/users/${cuenta.mlUserId}/items/search`;
  const ids = [];
  try {
    let scrollId = null;
    for (let vuelta = 0; vuelta < 5000; vuelta++) {
      const params = { search_type: 'scan', limit: TAM_PAGINA_SCAN, status };
      if (scrollId) params.scroll_id = scrollId;
      const { data } = await httpML.get(url, { headers, params });
      const lote = Array.isArray(data?.results) ? data.results : [];
      if (!lote.length) break;
      ids.push(...lote);
      if (!data.scroll_id) break;
      scrollId = data.scroll_id;
    }
    return ids;
  } catch (err) {
    const st = err.response?.status;
    if (ids.length || !st || st === 429 || st >= 500) throw err;
  }
  for (let offset = 0; offset < 1000; offset += 50) {
    const { data } = await httpML.get(url, { headers, params: { status, limit: 50, offset } });
    const lote = Array.isArray(data?.results) ? data.results : [];
    ids.push(...lote);
    if (!lote.length || ids.length >= (data.paging?.total || 0)) break;
  }
  return ids;
}

/*
 * El detalle de las publicaciones, de a 20.
 *
 * `include_attributes=all` es lo que trae los atributos de cada variación, y
 * ahí está su SKU (SELLER_SKU). Sin él las variaciones llegaban sin SKU y esas
 * publicaciones nunca se sincronizaban.
 *
 * ML reemplaza /items?ids= por /items/bulk (hay que migrar antes del
 * 25/10/2026). Se usa bulk y, si la cuenta todavía no lo tiene o responde algo
 * que no se entiende, el multiget de siempre: las dos respuestas se leen igual.
 */
async function traerItems(ids, headers) {
  const items = [];
  let usarBulk = true;
  const leer = (data) => (Array.isArray(data) ? data : [])
    .filter((e) => Number(e?.status_code ?? e?.code) === 200 && e.body)
    .map((e) => e.body);
  for (let i = 0; i < ids.length; i += 20) {
    const params = { ids: ids.slice(i, i + 20).join(','), include_attributes: 'all' };
    let leidos = null;
    if (usarBulk) {
      try {
        const { data } = await httpML.get(`${ML_API}/items/bulk`, { headers, params });
        leidos = leer(data);
        if (!leidos.length) { leidos = null; usarBulk = false; }
      } catch (err) {
        const st = err.response?.status;
        if (!st || st === 429 || st >= 500) throw err;
        usarBulk = false;
      }
    }
    if (!leidos) {
      const { data } = await httpML.get(`${ML_API}/items`, { headers, params });
      leidos = leer(data);
    }
    items.push(...leidos);
  }

  // Si igual faltan los atributos de las variaciones, se piden de a una.
  const incompletas = items.filter((it) => it.variations?.length
    && it.variations.every((v) => !Array.isArray(v.attributes)));
  const completas = await enParalelo(incompletas, CONCURRENCIA, async (it) => {
    try {
      const { data } = await httpML.get(`${ML_API}/items/${it.id}`, { headers, params: { include_attributes: 'all' } });
      return data;
    } catch { return null; }
  });
  incompletas.forEach((it, k) => {
    if (Array.isArray(completas[k]?.variations)) it.variations = completas[k].variations;
  });
  return items;
}

/** Trae las publicaciones del vendedor con su SKU: activas, pausadas y, si se pide, finalizadas. */
async function listarPublicaciones(cuenta, { incluirFinalizadas = false } = {}) {
  const token = await tokenValido(cuenta);
  const headers = { Authorization: `Bearer ${token}` };
  const ids = new Set();
  for (const status of (incluirFinalizadas ? ESTADOS_CON_FINALIZADAS : ESTADOS_A_TRAER)) {
    for (const id of await idsDelVendedor(cuenta, headers, status)) ids.add(String(id));
  }
  if (!ids.size) return [];
  return traerItems([...ids], headers);
}

/**
 * El SKU de una publicación o de una variación.
 *
 * Primero SELLER_SKU: ML lo define como el SKU y deja seller_custom_field "para
 * uso interno del vendedor", sin relación entre los dos. Leído al revés, un
 * dato interno pisaba el SKU real.
 */
function skuDe(objeto) {
  if (!objeto) return null;
  const attr = (objeto.attributes || []).find((a) => a?.id === 'SELLER_SKU');
  const valor = attr?.value_name ?? attr?.values?.[0]?.name;
  if (valor && String(valor).trim()) return String(valor).trim();
  if (objeto.seller_custom_field && String(objeto.seller_custom_field).trim()) {
    return String(objeto.seller_custom_field).trim();
  }
  return null;
}

/*
 * El link público. Se usa el permalink de ML, que ya viene armado —en las
 * publicaciones nuevas lleva a la página del producto—. Sólo si falta se arma,
 * con guión (MLA-123): articulo.mercadolibre.com.ar/MLA123 no abre nada.
 */
function enlaceDe(id) {
  return `https://articulo.mercadolibre.com.ar/${String(id || '').replace(/^([A-Z]{3})(\d+)$/, '$1-$2')}`;
}

// Exposición por tipo de publicación en MLA: Premium ≥ Clásica ("highest") > el resto.
const EXPOSICION_TIPO = { gold_pro: 0, gold_special: 1, gold_premium: 2, gold: 3, silver: 4, bronze: 5, free: 6 };
const NOMBRE_TIPO = {
  gold_pro: 'Premium', gold_special: 'Clásica', gold_premium: 'Oro Premium',
  gold: 'Oro', silver: 'Plata', bronze: 'Bronce', free: 'Gratuita',
};
const ESTADOS_NO_EDITABLES = {
  closed: 'finalizada', under_review: 'en revisión', inactive: 'inactiva',
  pending: 'inactiva por una deuda o una infracción', payment_required: 'esperando un pago',
};
const MOTIVO_MULTIORIGEN = 'Tu cuenta de Mercado Libre usa varios depósitos (multi-origen): ese stock se '
  + 'maneja por depósito y Stocker todavía no lo escribe. Actualizalo desde Mercado Libre.';

const listaDe = (x) => (Array.isArray(x) ? x : (x ? [x] : []));

/** Cómo se escribe el stock de una publicación, o por qué no se puede. */
function modoDeStock(item, userProductId) {
  const nombreEstado = ESTADOS_NO_EDITABLES[item.status];
  if (nombreEstado) {
    return { editable: false, motivo: `La publicación está ${nombreEstado} en Mercado Libre: no acepta cambios de stock.` };
  }
  if (item.shipping?.logistic_type !== 'fulfillment') return { editable: true, via: 'items' };
  const flex = [...listaDe(item.tags), ...listaDe(item.shipping?.tags)].includes('self_service_in');
  if (flex && userProductId) return { editable: true, full: true, via: 'selling_address' };
  return {
    editable: false, full: true,
    motivo: 'Está en Full: el stock lo maneja Mercado Libre con lo que hay en sus depósitos.',
  };
}

/** Una candidata por variación (o una por publicación sin variaciones), con su SKU si lo tiene. */
function candidatasDeItem(item) {
  const subEstados = listaDe(item.sub_status);
  const base = {
    mlItemId: String(item.id),
    titulo: item.title,
    permalink: item.permalink || enlaceDe(item.id),
    status: item.status || null,
    subEstados,
    pausadaPorVendedor: item.status === 'paused' && subEstados.includes('paused_by_seller'),
    tipo: item.listing_type_id || null,
    catalogo: Boolean(item.catalog_listing),
    relacionados: listaDe(item.item_relations).map((r) => String(r?.id)),
  };
  const armar = (extra, userProductId) => {
    const modo = modoDeStock(item, userProductId);
    return {
      ...base, ...extra, userProductId: userProductId || null,
      editable: modo.editable, via: modo.via || null, full: Boolean(modo.full),
      motivoNoEditable: modo.motivo || null,
    };
  };
  if (item.variations?.length) {
    const idsVariaciones = item.variations.map((v) => String(v.id));
    return item.variations.map((v) => armar({
      sku: skuDe(v), mlVariationId: String(v.id), idsVariaciones,
      stockActual: v.available_quantity, vendidas: v.sold_quantity ?? 0,
    }, v.user_product_id || item.user_product_id));
  }
  return [armar({
    sku: skuDe(item), mlVariationId: null, idsVariaciones: [],
    stockActual: item.available_quantity, vendidas: item.sold_quantity ?? 0,
  }, item.user_product_id)];
}

/*
 * El orden entre publicaciones con el mismo SKU, la mejor primero:
 *
 * 1. Que se pueda escribir (Full o finalizada, al final).
 * 2. Que no la haya pausado el vendedor: si la pausó a mano no la quiere
 *    vendiendo, y mandarle stock no la reactiva.
 * 3. La exposición del tipo de publicación: Premium, Clásica, el resto.
 * 4. Activa antes que pausada por falta de stock.
 * 5. La que más vendió.
 * Y el id, para que el resultado no cambie de una corrida a otra.
 */
function compararCandidatas(a, b) {
  const clave = (c) => [
    c.editable ? 0 : 1,
    c.pausadaPorVendedor ? 1 : 0,
    EXPOSICION_TIPO[c.tipo] ?? 9,
    c.status === 'active' ? 0 : 1,
    -(Number(c.vendidas) || 0),
  ];
  const ka = clave(a);
  const kb = clave(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return `${a.mlItemId}:${a.mlVariationId || ''}`.localeCompare(`${b.mlItemId}:${b.mlVariationId || ''}`);
}

/** SKU → todas las publicaciones con ese SKU, la mejor primero. */
function candidatasPorSku(publicaciones) {
  const mapa = new Map();
  for (const item of publicaciones) {
    for (const c of candidatasDeItem(item)) {
      if (!c.sku) continue;
      if (!mapa.has(c.sku)) mapa.set(c.sku, []);
      mapa.get(c.sku).push(c);
    }
  }
  for (const lista of mapa.values()) lista.sort(compararCandidatas);
  return mapa;
}

/**
 * SKU → la publicación asignada: UNA por SKU, la de mejor exposición. Las
 * demás van en `otras`, para mostrarlas; a ellas no se les escribe stock.
 */
function mapearPorSku(publicaciones) {
  const mapa = new Map();
  for (const [sku, lista] of candidatasPorSku(publicaciones)) {
    mapa.set(sku, { ...lista[0], otras: lista.slice(1) });
  }
  return mapa;
}

/*
 * Dos publicaciones comparten stock cuando ML las sincroniza sola: son del
 * mismo user product, o son el par catálogo/tradicional. Importa al poner en
 * cero las duplicadas: un cero en una de ellas vaciaría también la asignada.
 */
function comparteStockCon(o, elegida) {
  return Boolean(o.userProductId && o.userProductId === elegida.userProductId)
    || (o.relacionados || []).includes(elegida.mlItemId)
    || (elegida.relacionados || []).includes(o.mlItemId);
}

/** Cómo se muestra una publicación con el mismo SKU que no es la elegida. */
function resumenDeOtra(o, elegida) {
  const comparteStock = comparteStockCon(o, elegida);
  return {
    mlItemId: o.mlItemId, mlVariationId: o.mlVariationId, titulo: o.titulo,
    permalink: o.permalink, estadoMl: o.status, subEstadosMl: o.subEstados,
    tipoNombre: NOMBRE_TIPO[o.tipo] || null, catalogo: o.catalogo, full: o.full,
    stockMl: o.stockActual ?? null, comparteStock,
  };
}

/** Lo que conviene saber del estado de la publicación al mandarle stock. */
function avisoDeEstado(d, cantidad) {
  const subs = d.subEstados || [];
  if (d.status === 'paused' && subs.includes('paused_by_seller')) {
    return 'Pausada por vos en Mercado Libre: se actualiza el stock, pero no se reactiva sola.';
  }
  if (d.status === 'paused' && subs.includes('out_of_stock')) {
    return cantidad > 0
      ? 'Pausada por falta de stock: al mandarle stock, Mercado Libre la reactiva.'
      : 'Pausada por falta de stock: sigue así hasta que haya.';
  }
  if (d.status === 'active' && cantidad === 0) {
    return 'Con stock cero, Mercado Libre la pausa hasta que vuelva a haber.';
  }
  return null;
}

/** Las etiquetas de la cuenta de ML: `warehouse_management` es multi-origen. */
async function etiquetasDelVendedor(cuenta, headers) {
  try {
    const { data } = await httpML.get(`${ML_API}/users/${cuenta.mlUserId}`, { headers });
    return Array.isArray(data?.tags) ? data.tags : [];
  } catch {
    return [];
  }
}

// ── Sincronización de stock ───────────────────────────────────────

/*
 * Un 409 de ML ("optimistic locking") es un cambio anterior que todavía no
 * terminó de aplicarse: se espera un poco y se reintenta. Cualquier otro error
 * sube tal cual.
 */
async function conReintento(fn, intentos = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err.response?.status !== 409 || i >= intentos) throw err;
      await new Promise((listo) => setTimeout(listo, ESPERA_CONFLICTO_MS * i));
    }
  }
}

function detalleDeError(err) {
  const d = err.response?.data;
  return d?.message || d?.cause?.[0]?.message || d?.error || err.message;
}

/*
 * Lo que se manda junto.
 *
 * Todas las variaciones de una misma publicación van en UN PUT: mandadas por
 * separado, la segunda choca con la primera (409) mientras ML aplica el
 * cambio. Una publicación Full + Flex se escribe por su user product.
 */
function agruparEnvios(aMandar) {
  const grupos = new Map();
  for (const e of aMandar) {
    const d = e.destino;
    const clave = d.via === 'selling_address' ? `up:${d.userProductId}` : `item:${d.mlItemId}`;
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(e);
  }
  return [...grupos.values()];
}

/** Envía un grupo a ML. Devuelve `{ sinCambios }`. */
async function enviarGrupo(token, grupo) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const d = grupo[0].destino;

  /*
   * Full + Flex: el stock de Flex vive en el user product, en la ubicación
   * selling_address, y se escribe con la versión que devuelve la lectura. Por
   * /items se pisaría el total, que incluye lo que está en Full.
   */
  if (d.via === 'selling_address') {
    return conReintento(async () => {
      const lectura = await httpML.get(`${ML_API}/user-products/${d.userProductId}/stock`, { headers });
      const version = lectura.headers?.['x-version'];
      const actual = (lectura.data?.locations || []).find((l) => l.type === 'selling_address');
      const cantidad = grupo[0].cantidad;
      if (actual && Number(actual.quantity) === cantidad) return { sinCambios: true };
      await httpML.put(
        `${ML_API}/user-products/${d.userProductId}/stock/type/selling_address`,
        { quantity: cantidad },
        { headers: { ...headers, 'x-version': version } },
      );
      return { sinCambios: false };
    });
  }

  if (d.mlVariationId) {
    /*
     * Cada variación va con su id: una sin id, ML la borra y crea otra, y se
     * pierden sus ventas. Las que no cambian van sólo con el id.
     */
    const cambios = new Map(grupo.map((e) => [String(e.destino.mlVariationId), e.cantidad]));
    const ids = [...new Set([...(d.idsVariaciones || []), ...cambios.keys()])];
    const variations = ids.map((id) => (cambios.has(id)
      ? { id: Number(id), available_quantity: cambios.get(id) }
      : { id: Number(id) }));
    await conReintento(() => httpML.put(`${ML_API}/items/${d.mlItemId}`, { variations }, { headers }));
    return { sinCambios: false };
  }

  await conReintento(() => httpML.put(
    `${ML_API}/items/${d.mlItemId}`, { available_quantity: grupo[0].cantidad }, { headers },
  ));
  return { sinCambios: false };
}

/*
 * Qué publicación le toca a cada SKU en esta cuenta.
 *
 * Lo usan la sincronización y el checklist: si cada uno armara su propio mapa,
 * la pantalla podría decir que un SKU está publicado y la sincronización elegir
 * otra publicación, que es la clase de diferencia que nadie entiende después.
 */
async function destinosDeLaCuenta(cuenta, businessId, { incluirFinalizadas = false } = {}) {
  const token = await tokenValido(cuenta);
  const headersMl = { Authorization: `Bearer ${token}` };
  const publicaciones = await listarPublicaciones(cuenta, { incluirFinalizadas });

  /*
   * Vínculos manuales: pisan lo que se detecte automáticamente. Si apuntan a
   * una publicación que la búsqueda no trajo (por ejemplo, finalizada), se la
   * pide aparte para saber su estado y su link.
   */
  const manuales = await MercadoLibreLink.findAll({ where: { businessId } });
  const traidas = new Set(publicaciones.map((p) => String(p.id)));
  const faltantes = [...new Set(manuales.map((l) => String(l.mlItemId)).filter((id) => !traidas.has(id)))];
  if (faltantes.length) publicaciones.push(...await traerItems(faltantes, headersMl));

  const candidatas = candidatasPorSku(publicaciones);
  const porSku = mapearPorSku(publicaciones);
  const todasLasCandidatas = publicaciones.flatMap(candidatasDeItem);
  for (const l of manuales) {
    const encontrada = todasLasCandidatas.find((c) => c.mlItemId === String(l.mlItemId)
      && String(c.mlVariationId || '') === String(l.mlVariationId || ''));
    const otras = (candidatas.get(l.sku) || []).filter((c) => !encontrada
      || c.mlItemId !== encontrada.mlItemId || c.mlVariationId !== encontrada.mlVariationId);
    porSku.set(l.sku, encontrada
      ? { ...encontrada, manual: true, otras }
      : {
        mlItemId: String(l.mlItemId), mlVariationId: l.mlVariationId ? String(l.mlVariationId) : null,
        titulo: l.titulo, permalink: enlaceDe(l.mlItemId), editable: true, via: 'items',
        idsVariaciones: [], subEstados: [], relacionados: [], manual: true, otras,
      });
  }
  const multiOrigen = (await etiquetasDelVendedor(cuenta, headersMl)).includes('warehouse_management');
  return { token, headersMl, publicaciones, porSku, multiOrigen };
}

/*
 * Las variantes que se pueden publicar.
 *
 * Los de feria quedan afuera: no llevan stock, así que publicar el suyo sería
 * anunciar cero unidades de algo que se vende igual, o peor, pisar la
 * publicación de su equivalente del catálogo normal.
 */
function variantesPublicables(businessId, { soloActivas = false } = {}) {
  const where = soloActivas ? { activo: true } : {};
  return ProductVariant.findAll({
    where,
    include: [{
      model: Product, as: 'producto', required: true,
      where: { businessId, activo: true, ...NO_ES_FERIA },
    }],
  });
}

/*
 * Cuánto le toca publicar a cada variante: lo disponible en los locales que
 * abastecen online, menos su margen de seguridad.
 *
 * El stock de todas las variantes sale en una sola consulta: preguntarlo de a
 * una eran tantas idas a la base como artículos publicados.
 */
async function cantidadesPublicables(businessId, locales, variantes) {
  const filasStock = await VariantStock.findAll({
    where: { businessId, locationId: locales.map((l) => l.id) },
    attributes: ['productVariantId', 'stock', 'reservado'],
  });
  const disponible = new Map();
  for (const f of filasStock) {
    /*
     * Lo DISPONIBLE, no lo que hay en el estante.
     *
     * Una unidad apartada para un pedido online sigue en el estante hasta que
     * alguien la despacha, pero no se puede volver a vender: publicarla sería
     * ofrecer dos veces la misma prenda, que es justo lo que la reserva vino a
     * evitar.
     */
    const libre = Math.max(0, (Number(f.stock) || 0) - (Number(f.reservado) || 0));
    disponible.set(f.productVariantId, (disponible.get(f.productVariantId) || 0) + libre);
  }

  /*
   * Los packs no tienen fila en `variant_stocks`: lo que hay de un pack es lo
   * que alcance para armarlo con lo que lleva adentro. Sin esto, cada pack
   * publicado saldría con stock cero y dejaría de venderse sin explicación.
   */
  const idsPacks = variantes.filter((v) => v.esPack).map((v) => v.id);
  if (idsPacks.length) {
    const armables = await packService.disponibleDePacksEnLocales(
      idsPacks, locales.map((l) => l.id), businessId,
    );
    for (const [packId, cuantos] of armables) disponible.set(packId, cuantos);
  }

  const salida = new Map();
  for (const v of variantes) {
    const margen = Math.max(0, Math.trunc(Number(v.margenMl) || 0));
    // El negativo se publica como cero: lo que quedó en -3 no tiene nada para
    // despachar, y mandarlo a ML sería pedirle que ofrezca deuda.
    const hay = Math.max(0, disponible.get(v.id) || 0);
    salida.set(v.id, { disponible: hay, margen, cantidad: Math.max(0, hay - margen) });
  }
  return salida;
}

/**
 * Republica una publicación finalizada, con el stock que hay hoy en Stocker.
 *
 * Una finalizada no acepta stock: ML sólo deja republicarla, y eso crea una
 * publicación NUEVA con otro id. Se conservan el precio y el tipo de
 * publicación; la cantidad sale de Stocker, que es la que manda.
 *
 * Se republica de a una y a pedido de la persona: ML permite una sola
 * republicación por publicación, y republicar es volver a ponerla a la venta
 * con lo que eso implica.
 */
async function republicar(businessId, { mlItemId }) {
  const cuenta = await MercadoLibreAccount.findOne({ where: { businessId } });
  if (!cuenta) throw Object.assign(new Error('No hay una cuenta de MercadoLibre conectada.'), { status: 400 });
  const locales = await stockService.localesQueAbastecenOnline(businessId);
  if (!locales.length) {
    throw Object.assign(
      new Error('Ningún local está marcado para abastecer las ventas online: no hay stock que publicar.'),
      { status: 409, detalles: { codigo: 'SIN_LUGAR_ONLINE' } },
    );
  }

  const token = await tokenValido(cuenta);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [item] = await traerItems([String(mlItemId)], headers);
  if (!item) throw Object.assign(new Error('Esa publicación no existe o no se pudo leer en Mercado Libre.'), { status: 404 });
  /*
   * De la cuenta conectada y de nadie más. El id llega del navegador, y sin
   * este control se podría republicar la publicación de otro vendedor.
   */
  if (item.seller_id && String(item.seller_id) !== String(cuenta.mlUserId)) {
    throw Object.assign(new Error('Esa publicación no es de tu cuenta de Mercado Libre.'), { status: 403 });
  }
  if (item.status !== 'closed') {
    throw Object.assign(
      new Error('Sólo se republican las publicaciones finalizadas. Las pausadas se reactivan solas cuando les llega stock.'),
      { status: 400 },
    );
  }

  const variantes = await variantesPublicables(businessId, { soloActivas: true });
  const cantidades = await cantidadesPublicables(businessId, locales, variantes);
  const porSkuStocker = new Map(variantes.map((v) => [v.sku, v]));
  const cantidadDe = (sku) => {
    const v = sku ? porSkuStocker.get(sku) : null;
    return v ? (cantidades.get(v.id)?.cantidad || 0) : 0;
  };

  let cuerpo;
  if (item.variations?.length) {
    const variations = item.variations
      .map((v) => ({ id: v.id, price: v.price ?? item.price, quantity: cantidadDe(skuDe(v)) }))
      .filter((v) => v.quantity > 0);
    if (!variations.length) {
      throw Object.assign(
        new Error('Ninguna variación de esa publicación tiene stock en Stocker, así que no hay nada para republicar.'),
        { status: 400 },
      );
    }
    cuerpo = { listing_type_id: item.listing_type_id, variations };
  } else {
    const quantity = cantidadDe(skuDe(item));
    if (quantity <= 0) {
      throw Object.assign(
        new Error('No hay stock en Stocker para ese SKU, así que no hay nada para republicar.'),
        { status: 400 },
      );
    }
    cuerpo = { price: item.price, quantity, listing_type_id: item.listing_type_id };
  }

  const { data } = await httpML.post(`${ML_API}/items/${item.id}/relist`, cuerpo, { headers });
  const nuevo = data?.id ? String(data.id) : null;
  return {
    mlItemId: nuevo,
    permalink: data?.permalink || (nuevo ? enlaceDe(nuevo) : null),
    titulo: data?.title || item.title,
    cantidad: cuerpo.quantity ?? cuerpo.variations.reduce((t, v) => t + v.quantity, 0),
    anterior: String(item.id),
  };
}

/**
 * El checklist: qué productos tienen su stock puesto en Mercado Libre y cuáles
 * no, agrupados por producto padre con sus variantes.
 *
 * Mira TODAS las publicaciones, finalizadas incluidas. Una vieja que quedó
 * cerrada no acepta stock —ML sólo deja republicarla—, pero sale en la lista
 * con ese motivo: sin eso, un SKU que en Stocker tiene mercadería y en ML no se
 * está ofreciendo no aparece en ningún lado.
 */
async function coberturaMl(businessId) {
  const cuenta = await MercadoLibreAccount.findOne({ where: { businessId } });
  if (!cuenta) throw Object.assign(new Error('No hay una cuenta de MercadoLibre conectada.'), { status: 400 });

  const locales = await stockService.localesQueAbastecenOnline(businessId);
  const { porSku } = await destinosDeLaCuenta(cuenta, businessId, { incluirFinalizadas: true });
  const variantes = await variantesPublicables(businessId, { soloActivas: true });
  const cantidades = locales.length
    ? await cantidadesPublicables(businessId, locales, variantes)
    : new Map();

  const porProducto = new Map();
  for (const v of variantes) {
    const padre = v.producto;
    if (!porProducto.has(padre.id)) {
      porProducto.set(padre.id, {
        productId: padre.id,
        sku: padre.skuAgrupador || padre.sku,
        titulo: padre.titulo,
        categoria: padre.categoria || null,
        variantes: [],
      });
    }
    const d = porSku.get(v.sku);
    const c = cantidades.get(v.id) || { cantidad: 0, margen: 0, disponible: 0 };
    porProducto.get(padre.id).variantes.push({
      variantId: v.id,
      sku: v.sku,
      etiqueta: [v.variante1Valor, v.variante2Valor].filter(Boolean).join(' / '),
      esPack: Boolean(v.esPack),
      enMl: Boolean(d),
      sincronizable: Boolean(d) && d.editable !== false,
      motivo: d && d.editable === false ? d.motivoNoEditable : null,
      manual: Boolean(d?.manual),
      mlItemId: d?.mlItemId || null,
      mlVariationId: d?.mlVariationId || null,
      permalink: d ? (d.permalink || enlaceDe(d.mlItemId)) : null,
      estadoMl: d?.status || null,
      subEstadosMl: d?.subEstados || [],
      tipoNombre: d ? (NOMBRE_TIPO[d.tipo] || null) : null,
      otras: (d?.otras || []).length,
      stockMl: d?.stockActual ?? null,
      stockStocker: c.cantidad,
      alDia: Boolean(d) && d.editable !== false && d.stockActual === c.cantidad,
    });
  }

  const productos = [...porProducto.values()].map((g) => {
    const enMl = g.variantes.filter((x) => x.enMl).length;
    const sincronizables = g.variantes.filter((x) => x.sincronizable).length;
    return {
      ...g,
      total: g.variantes.length,
      enMl,
      sinMl: g.variantes.length - enMl,
      alDia: g.variantes.filter((x) => x.alDia).length,
      estado: sincronizables === 0 ? 'sin-publicar'
        : (sincronizables === g.variantes.length ? 'completo' : 'parcial'),
    };
  });
  // Primero lo que falta: esto es una lista de tareas, no un inventario.
  const orden = { 'sin-publicar': 0, parcial: 1, completo: 2 };
  productos.sort((a, b) => (orden[a.estado] - orden[b.estado])
    || String(a.titulo || '').localeCompare(String(b.titulo || ''), 'es'));

  return {
    sinLugarOnline: !locales.length,
    lugares: locales.map((l) => ({ id: l.id, nombre: l.nombre })),
    productos,
    resumen: {
      productos: productos.length,
      completos: productos.filter((p) => p.estado === 'completo').length,
      parciales: productos.filter((p) => p.estado === 'parcial').length,
      sinPublicar: productos.filter((p) => p.estado === 'sin-publicar').length,
      variantes: productos.reduce((t, p) => t + p.total, 0),
      variantesEnMl: productos.reduce((t, p) => t + p.enMl, 0),
      variantesSinMl: productos.reduce((t, p) => t + p.sinMl, 0),
    },
  };
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

  const { token, publicaciones, porSku, multiOrigen } = await destinosDeLaCuenta(cuenta, businessId);

  const variantes = await variantesPublicables(businessId);
  const cantidades = await cantidadesPublicables(businessId, locales, variantes);

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
  // Las duplicadas que hay que dejar en cero, una por publicación.
  const aCero = new Map();
  let duplicadasEnCero = 0;

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
    /*
     * Y el margen de seguridad se descuenta al final, sobre lo disponible:
     * son unidades que el negocio prefiere no ofrecer online. Nunca baja de
     * cero. En un pack el margen son packs enteros, porque lo disponible de un
     * pack ya viene contado en packs.
     */
    const { margen: margenMl, cantidad } = cantidades.get(v.id) || { margen: 0, cantidad: 0 };
    const fila = {
      sku: v.sku, titulo: v.producto.titulo, margenMl,
      mlItemId: destino.mlItemId, mlVariationId: destino.mlVariationId,
      stockStocker: cantidad, stockMl: destino.stockActual ?? null,
      lugar: locales.map((l) => l.nombre).join(', '),
      manual: Boolean(destino.manual),
      permalink: destino.permalink || enlaceDe(destino.mlItemId),
      estadoMl: destino.status || null,
      subEstadosMl: destino.subEstados || [],
      tipo: destino.tipo || null,
      tipoNombre: NOMBRE_TIPO[destino.tipo] || null,
      catalogo: Boolean(destino.catalogo),
      full: Boolean(destino.full),
      otras: (destino.otras || []).map((o) => resumenDeOtra(o, destino)),
    };

    // Lo que ML no deja escribir se muestra con su motivo, sin pedir nada.
    const motivo = !destino.editable ? destino.motivoNoEditable
      : (multiOrigen && destino.via === 'items' ? MOTIVO_MULTIORIGEN : null);
    if (motivo) {
      resultados.push({ ...fila, estado: 'no-sincronizable', motivo });
      continue;
    }
    fila.aviso = avisoDeEstado(destino, cantidad);

    /*
     * Las otras publicaciones con el mismo SKU van a cero.
     *
     * Mercado Libre no permite publicaciones duplicadas, y mientras una siga
     * con el stock viejo puede vender algo que ya no está: el stock de Stocker
     * es uno solo y se publica en la asignada. El cero es además la forma que
     * ML documenta para pausar una publicación.
     *
     * Las que COMPARTEN stock con la asignada no se tocan: ML las sincroniza
     * solas, y un cero ahí vaciaría también la buena.
     */
    for (const o of destino.otras || []) {
      if (!o.editable || o.mlItemId === destino.mlItemId) continue;
      if (multiOrigen && o.via === 'items') continue;
      if (comparteStockCon(o, destino)) continue;
      if (Number(o.stockActual) === 0) continue;
      const clave = `${o.mlItemId}:${o.mlVariationId || ''}`;
      const resumen = (fila.otras || []).find((x) => `${x.mlItemId}:${x.mlVariationId || ''}` === clave);
      if (resumen) resumen.seVaACero = true;
      if (!aCero.has(clave)) aCero.set(clave, { v: { id: null, sku: v.sku }, destino: o, cantidad: 0, fila: null });
    }

    /*
     * Lo que ya coincide no se toca. Es el ahorro más grande de todos: en una
     * sincronización de rutina, casi nada cambió, y mandar doscientas
     * peticiones para escribir el mismo número es gastar el límite de la API
     * en no hacer nada.
     */
    // El stock de Flex se compara al mandar: el de la publicación suma lo que está en Full.
    if (destino.via !== 'selling_address' && destino.stockActual === cantidad) {
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
  const enviados = await enParalelo(agruparEnvios(aMandar), CONCURRENCIA, async (grupo) => {
    try {
      const { sinCambios } = await enviarGrupo(token, grupo);
      const salida = [];
      for (const { v, cantidad, fila } of grupo) {
        await MercadoLibreLink.update(
          { ultimoStockEnviado: cantidad, ultimaSync: new Date(), ultimoError: null },
          { where: { businessId, sku: v.sku } },
        );
        salida.push({ variantId: v.id, fila: { ...fila, estado: sinCambios ? 'sin-cambios' : 'actualizado' } });
      }
      return salida;
    } catch (err) {
      const detalle = detalleDeError(err);
      const salida = [];
      for (const { v, fila } of grupo) {
        await MercadoLibreLink.update({ ultimoError: detalle }, { where: { businessId, sku: v.sku } });
        salida.push({ variantId: null, fila: { ...fila, estado: 'error', error: detalle } });
      }
      return salida;
    }
  });

  for (const e of enviados.flat()) {
    if (e.variantId) sincronizados.push(e.variantId);
    resultados.push(e.fila);
  }

  // Recién después, las duplicadas a cero: primero queda bien la asignada.
  if (!simular && aCero.size) {
    const puestas = await enParalelo(agruparEnvios([...aCero.values()]), CONCURRENCIA, async (grupo) => {
      const clave = (e) => `${e.destino.mlItemId}:${e.destino.mlVariationId || ''}`;
      try {
        await enviarGrupo(token, grupo);
        return grupo.map((e) => ({ clave: clave(e), ok: true }));
      } catch (err) {
        const detalle = detalleDeError(err);
        return grupo.map((e) => ({ clave: clave(e), ok: false, detalle }));
      }
    });
    const porClave = new Map(puestas.flat().map((x) => [x.clave, x]));
    for (const r of resultados) {
      for (const o of r.otras || []) {
        const hecho = porClave.get(`${o.mlItemId}:${o.mlVariationId || ''}`);
        if (!hecho) continue;
        o.enCero = hecho.ok;
        if (!hecho.ok) o.errorCero = hecho.detalle;
      }
    }
    duplicadasEnCero = puestas.flat().filter((x) => x.ok).length;
  }

  // SKUs publicados en ML que no existen en Stocker: los reportamos para que
  // el usuario sepa qué quedó sin vincular.
  const skusStocker = new Set(variantes.map((v) => v.sku));
  const huerfanosMl = [...porSku.entries()]
    .filter(([sku]) => !skusStocker.has(sku))
    .map(([sku, d]) => ({ sku, mlItemId: d.mlItemId, titulo: d.titulo, permalink: d.permalink || enlaceDe(d.mlItemId) }));

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
      noSincronizables: resultados.filter((r) => r.estado === 'no-sincronizable').length,
      duplicadasACero: aCero.size,
      duplicadasEnCero,
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

/*
 * A la lista de SKU que cambiaron, se le agregan los packs que los llevan.
 *
 * Un pack no tiene stock propio: lo que se publica de él es cuántos se pueden
 * armar con lo que haya adentro. Así que vender una remera suelta cambia el
 * stock publicado del pack de tres remeras, aunque el SKU del pack no se haya
 * tocado. Sin esto, la publicación del pack se quedaba con el número viejo
 * hasta que alguien sincronizara a mano — y mientras tanto puede vender packs
 * que ya no se pueden armar.
 *
 * Se resuelve acá, al vaciar la tanda, y no en cada movimiento de stock: es UNA
 * consulta por tanda en vez de una por línea de cada venta.
 */
async function conLosPacksQueLosUsan(skus, businessId) {
  if (!skus.length) return skus;
  try {
    const { ProductVariant, PackComponente } = require('../models');
    const variantes = await ProductVariant.findAll({
      where: { businessId, sku: skus }, attributes: ['id'],
    });
    if (!variantes.length) return skus;

    const filas = await PackComponente.findAll({
      where: { businessId, componenteVariantId: variantes.map((v) => v.id) },
      attributes: ['packVariantId'],
    });
    if (!filas.length) return skus;

    const packs = await ProductVariant.findAll({
      where: { id: filas.map((f) => f.packVariantId), businessId, activo: true },
      attributes: ['sku'],
    });
    return [...new Set([...skus, ...packs.map((p) => p.sku)])];
  } catch (e) {
    /*
     * Si esto falla se sincroniza igual lo que sí se sabe. Perder la
     * actualización de un pack es malo; perder también la de la prenda que la
     * disparó, peor.
     */
    log.warn('mercadolibre', 'no se pudieron resolver los packs afectados', {
      businessId, motivo: e.message?.slice(0, 200),
    });
    return skus;
  }
}

async function correrSyncPendiente(businessId) {
  const entrada = pendientesSync.get(businessId);
  if (!entrada) return;
  pendientesSync.delete(businessId);

  const skus = await conLosPacksQueLosUsan([...entrada.skus], businessId);
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
  coberturaMl,
  republicar,
  // Expuesto para las pruebas: es la regla que hace que un pack publicado no
  // se quede con el stock viejo cuando se mueve una de sus prendas.
  __conLosPacksQueLosUsan: conLosPacksQueLosUsan,
};
