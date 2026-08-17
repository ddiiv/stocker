/*
 * Límites de peticiones.
 *
 * El objetivo principal es la fuerza bruta contra el login: sin esto, probar
 * miles de contraseñas por minuto contra una cuenta conocida no cuesta nada.
 *
 * La clave del contador combina IP + email cuando el email está disponible.
 * Sólo por IP, una oficina entera detrás de un NAT comparte cupo y un usuario
 * torpe deja afuera a sus compañeros; sólo por email, basta con rotar IPs.
 */
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

const respuesta = (mensaje) => (req, res) => {
  res.status(429).json({ message: mensaje });
};

// Con `trust proxy` activo, req.ip ya es la IP real del cliente y no la del
// edge de Railway — sin eso todos los usuarios compartirían un solo contador.
//
// La IP pasa por ipKeyGenerator, que agrupa IPv6 por /64 en vez de tomar la
// dirección exacta. Importa: a un cliente IPv6 el proveedor le asigna un
// bloque entero, así que contar por dirección exacta permitiría rotar y
// saltear el límite. La red de Railway es IPv6.
function claveIpMasEmail(req) {
  const ip = ipKeyGenerator(req.ip);
  const email = String(req.body?.email || '').toLowerCase().trim();
  return email ? `${ip}|${email}` : ip;
}

// Login: el PDF pide 5 intentos por minuto. Los exitosos no cuentan, así que
// trabajar normalmente nunca acerca al límite.
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: claveIpMasEmail,
  skipSuccessfulRequests: true,
  handler: respuesta('Demasiados intentos fallidos. Esperá un minuto antes de reintentar.'),
});

// Recuperación de contraseña: cada intento manda un mail. Más restrictivo,
// tanto para no filtrar qué cuentas existen como para no convertirnos en
// herramienta de spam contra la casilla de un tercero.
const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: claveIpMasEmail,
  handler: respuesta('Demasiados pedidos de recuperación. Probá de nuevo en unos minutos.'),
});

// Alta de negocios: no hay razón legítima para crear varios seguidos.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: respuesta('Demasiadas cuentas creadas desde esta conexión. Probá más tarde.'),
});

// Red de contención general sobre /api. Holgado a propósito: el punto de venta
// con lector de barras dispara muchas peticiones seguidas y no queremos
// cortarle una jornada de trabajo.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: respuesta('Demasiadas peticiones. Bajá el ritmo un momento.'),
});

/*
 * Ráfagas.
 *
 * El limitador de arriba mira un minuto entero, así que 600 pedidos en dos
 * segundos lo pasan sin problema y saturan igual. Esto mira una ventana corta:
 * es la diferencia entre "usa mucho el sistema" y "algo se soltó".
 *
 * El caso real que hay que no romper es una PC de la oficina con un script o un
 * virus disparando miles de pedidos por segundo. Ese patrón se corta acá en dos
 * segundos, mientras el cajero escaneando —que llega a diez o quince por
 * segundo en el peor caso— queda muy por debajo.
 */
const burstLimiter = rateLimit({
  windowMs: 2 * 1000,
  limit: 60,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: respuesta('Detectamos una ráfaga de pedidos desde tu conexión y la frenamos unos segundos.'),
});

/*
 * Superficie pública sin sesión: login, registro, recuperación, webhooks y el
 * catálogo de planes. Es donde pega un ataque que no tiene credenciales, y no
 * necesita el cupo holgado que sí necesita el punto de venta.
 */
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: respuesta('Demasiadas peticiones. Probá de nuevo en un momento.'),
});

module.exports = {
  loginLimiter, passwordResetLimiter, registerLimiter,
  apiLimiter, burstLimiter, publicLimiter,
};
