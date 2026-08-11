/*
 * Cookie de sesión.
 *
 * El token viaja en una cookie httpOnly en vez de localStorage: el JS de la
 * página no puede leerla, así que un XSS ya no se lleva la sesión de un
 * negocio (con su CUIT, certificados y facturación AFIP detrás).
 *
 * Requiere que el front y la API compartan origen — en dev lo resuelve el
 * proxy de Vite, en producción el servicio web que sirve el build y proxea
 * /api por la red privada de Railway. Con mismo origen alcanza SameSite=Lax,
 * que es la opción más restrictiva que deja pasar la navegación normal.
 */

const COOKIE_NAME = 'stockerToken';

// La cookie dura lo mismo que la ventana de inactividad y se renueva en cada
// pedido autenticado. Así el navegador la descarta solo cuando el usuario deja
// de trabajar, en lugar de mostrar una sesión "viva" que el servidor ya
// rechaza. El corte real igual lo hace el backend (ver utils/session.js).
const { IDLE_MS } = require('./session');
const MAX_AGE_MS = IDLE_MS;

// Decidir `secure` sólo por NODE_ENV falla abierto: si la variable no está
// seteada en el deploy, la cookie sale sin el flag y viaja también por http.
// Con `trust proxy` activo, req.secure refleja el X-Forwarded-Proto que pone
// el edge de Railway, así que el propio request nos dice si hay TLS.
function isSecureRequest(req) {
  if (req?.secure) return true;                       // llegó por https
  return process.env.NODE_ENV === 'production';       // ante la duda, cerrado
}

// Strict: la cookie no viaja en ningún request originado por otro sitio, ni
// siquiera al navegar por un enlace. Es lo que corta el CSRF de raíz.
//
// En una SPA no molesta: el index.html se sirve sin autenticación, así que
// aterrizar desde afuera (por ejemplo al volver del OAuth de MercadoLibre)
// funciona igual, y una vez cargada la página todas las llamadas a la API
// son same-site y sí llevan la cookie.
function cookieOptions(req) {
  return {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: process.env.COOKIE_SAMESITE || 'strict',
    maxAge: MAX_AGE_MS,
    path: '/',
  };
}

function setAuthCookie(res, token, req = res.req) {
  res.cookie(COOKIE_NAME, token, cookieOptions(req));
}

function clearAuthCookie(res, req = res.req) {
  // clearCookie sólo borra si coinciden path/sameSite/secure con los del set.
  const { maxAge, ...opts } = cookieOptions(req);
  res.clearCookie(COOKIE_NAME, opts);
}

function readAuthCookie(req) {
  return req.cookies?.[COOKIE_NAME] || null;
}

module.exports = { COOKIE_NAME, setAuthCookie, clearAuthCookie, readAuthCookie };
