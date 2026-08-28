const { log, mask } = require('../utils/logger');
const { normalizar } = require('../utils/ip');

/*
 * Filtros de entrada.
 *
 * Antes de nada, sobre qué NO es esto: no es un detector de "código malicioso".
 * Buscar palabras como SELECT, UNION o <script> en lo que manda el usuario
 * suena a defensa y es sobre todo un generador de fallas raras — un producto
 * llamado "Camisa O'Brien", una nota que dice "poner <b>oferta</b>" o un
 * apellido con comillas quedarían rechazados sin explicación, y el atacante que
 * sabe lo que hace pasa igual con cualquier codificación.
 *
 * Lo que realmente frena la inyección en este proyecto ya está y es estructural:
 *
 *   · Sequelize parametriza todas las consultas. Un valor con comillas viaja
 *     como valor y nunca como parte de la sentencia.
 *   · Los controladores copian del body sólo campos de una lista blanca, así
 *     que no se puede escribir una columna que no corresponde (ver F-02).
 *   · React escapa todo lo que renderiza, así que un <script> guardado en la
 *     base se muestra como texto.
 *
 * Lo que sí vive acá son controles sin ambigüedad: cosas que nunca aparecen en
 * tráfico legítimo y por lo tanto no tienen falsos positivos.
 */

// ── 1. Bytes nulos ───────────────────────────────────────────────
/*
 * Un \0 dentro de un texto no sale de ningún cliente legítimo. Se usa para
 * cortar cadenas antes de tiempo en capas escritas en C y saltear validaciones
 * que sí miraban el resto del string.
 */
function tieneNulo(valor, profundidad = 0) {
  if (profundidad > 6) return false;                 // corta objetos anidados absurdos
  if (typeof valor === 'string') return valor.includes('\0');
  if (Array.isArray(valor)) return valor.some((v) => tieneNulo(v, profundidad + 1));
  if (valor && typeof valor === 'object') {
    return Object.values(valor).some((v) => tieneNulo(v, profundidad + 1));
  }
  return false;
}

// ── 2. Rutas que sólo escanean ───────────────────────────────────
/*
 * Nadie pide /wp-login.php ni /.env a una API de Argentina por error. Son
 * escáneres automáticos, y responderles cuesta CPU y llena los logs.
 *
 * Cortarlos no protege de un atacante decidido, pero saca del registro el ruido
 * que tapa los intentos que sí importan.
 */
const RUTAS_DE_ESCANEO = [
  /^\/\.env/i, /^\/\.git/i, /^\/\.aws/i, /^\/\.ssh/i,
  /^\/wp-(login|admin|content|includes)/i, /^\/xmlrpc\.php/i,
  /^\/phpmyadmin/i, /^\/pma\//i, /^\/adminer/i,
  /^\/(vendor|cgi-bin)\//i, /\.(php|asp|aspx|jsp|cgi)$/i,
  /^\/actuator/i, /^\/config\.json$/i, /^\/backup/i,
  /^\/telescope/i, /^\/_ignition/i,
];

// ── 3. Tamaños ───────────────────────────────────────────────────
const MAX_URL = 2048;           // ninguna ruta legítima de esta API se acerca
const MAX_PARAMS = 40;

// Content-Type esperado al escribir. La excepción son las subidas de archivo,
// que llegan como multipart.
const ESCRITURA = new Set(['POST', 'PUT', 'PATCH']);

function cortar(req, res, motivo, detalle = {}) {
  log.warn('hardening', motivo, { ip: mask.ip(normalizar(req.ip)), ruta: req.originalUrl?.slice(0, 120), ...detalle });
  // 400 y no 403: es una petición mal formada, no un permiso que falta.
  return res.status(400).json({ message: 'Petición inválida.' });
}

/*
 * Va ANTES del parser de JSON: una URL de 100 KB o una ruta de escáner no
 * merecen que se gaste memoria en leerle el cuerpo.
 */
const filtrarPeticion = (req, res, next) => {
  if ((req.originalUrl || '').length > MAX_URL) {
    return cortar(req, res, 'URL desmedida', { largo: req.originalUrl.length });
  }
  if (Object.keys(req.query || {}).length > MAX_PARAMS) {
    return cortar(req, res, 'demasiados parámetros en la query');
  }
  if (RUTAS_DE_ESCANEO.some((rx) => rx.test(req.path))) {
    // 404 seco: a un escáner no se le explica nada.
    log.warn('hardening', 'ruta de escaneo', { ip: mask.ip(normalizar(req.ip)), ruta: req.path.slice(0, 80) });
    return res.status(404).json({ message: 'No encontrado.' });
  }
  next();
};

/*
 * Va DESPUÉS del parser: recién ahí hay un cuerpo que mirar.
 */
const filtrarCuerpo = (req, res, next) => {
  if (!ESCRITURA.has(req.method)) return next();

  const tipo = String(req.headers['content-type'] || '');
  const cuerpoVacio = !req.body || (typeof req.body === 'object' && Object.keys(req.body).length === 0);

  /*
   * En una escritura con cuerpo se exige JSON o multipart. Un formulario HTML
   * de otro sitio no puede mandar application/json sin pasar por CORS, así que
   * exigirlo es una defensa extra contra CSRF, además de la cookie SameSite.
   */
  if (!cuerpoVacio && !/^(application\/json|multipart\/form-data)/i.test(tipo)) {
    return cortar(req, res, 'content-type no admitido en escritura', { tipo: tipo.slice(0, 60) });
  }

  if (tieneNulo(req.body)) {
    return cortar(req, res, 'byte nulo en el cuerpo');
  }

  next();
};

module.exports = { filtrarPeticion, filtrarCuerpo, RUTAS_DE_ESCANEO, MAX_URL };
