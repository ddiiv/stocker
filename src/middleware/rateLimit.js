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
/*
 * La clave del limitador: IP más QUIÉN, cuando se puede saber quién.
 *
 * El email del cuerpo cubre los endpoints públicos —login, recupero—, donde es
 * el único identificador que hay. Pero `/account/password/solicitar` no lleva
 * email: va autenticado y el dato viaja en la cookie. Sin mirar la sesión, ese
 * endpoint quedaba llaveado sólo por IP, y en un negocio con una sola IP
 * pública —o sea, cualquier local— el dueño y los empleados compartían un cupo
 * de cinco cada quince minutos: el tercero que intentara cambiar su contraseña
 * se comía un bloqueo por lo que hicieron los otros dos.
 *
 * Mirar `req.auth` no afloja nada: los endpoints públicos no lo tienen y
 * siguen exactamente como estaban.
 *
 * Con sesión, el QUIÉN sale SÓLO del token, nunca del cuerpo. Antes el email
 * del cuerpo ganaba también acá, y en una ruta autenticada ese email no lo
 * mira nadie: mandando uno inventado distinto en cada pedido, cada intento
 * caía en un contador nuevo y el freno de cinco no llegaba nunca. Así se
 * adivinaba la contraseña contra "cerrar sesiones" o "desactivar el 2FA" con
 * una sesión ajena abierta (la PC del mostrador). Y el dueño y cada empleado
 * van en cupos separados: los errores de un cajero no pueden dejar al dueño,
 * desde la misma IP del local, sin el botón de pánico.
 */
function claveIpMasEmail(req) {
  const ip = ipKeyGenerator(req.ip);
  if (req.auth?.businessId) {
    const quien = req.auth.type === 'employee' ? `empleado:${req.auth.employeeId}` : 'dueno';
    return `${ip}|negocio:${req.auth.businessId}|${quien}`;
  }
  const email = String(req.body?.email || '').toLowerCase().trim();
  if (email) return `${ip}|${email}`;
  return ip;
}

/*
 * La clave de las rutas que piden la contraseña de quien ya tiene la sesión
 * abierta (cerrar sesiones): la SESIÓN misma.
 *
 * Por sesión y no por IP + persona, por dos razones:
 *
 *   · Quien tiene una sesión robada no puede conseguir otra sin la
 *     contraseña, así que no hay forma de rotar la clave. Con la IP adentro,
 *     cambiar de IP en cada pedido sumaba cinco intentos más por IP.
 *   · El dueño que encuentra su sesión abierta en la PC del local y la quiere
 *     echar desde el celular —en la misma red, misma IP pública— tiene su
 *     propio cupo. Con IP + persona, el que está en la PC le gastaba el cupo
 *     y le bloqueaba justo el botón que necesita.
 *
 * requireAuth ya exige el sid (un token sin sid no pasa), así que la vuelta a
 * la clave de arriba es sólo por si este freno se pone delante de otra ruta.
 */
function claveDeSesion(req) {
  if (req.auth?.sid) return `sesion:${req.auth.sid}`;
  return claveIpMasEmail(req);
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

/*
 * Contraseña pedida DENTRO de una sesión (cerrar una sesión, cerrar todas).
 *
 * Dos frenos, los dos por sesión (claveDeSesion) y los dos sin contar los
 * aciertos, así que usarlo de verdad nunca se acerca a ninguno:
 *
 *   · Cinco errores por minuto, como el login: frena el ataque rápido.
 *   · Veinte errores en el día. Cinco por minuto durante las 24 h que puede
 *     durar una sesión siguen siendo miles de intentos; el login no tiene ese
 *     problema porque bloqueoService corta a los cinco fallos por cuenta. Acá
 *     no se usa bloqueoService a propósito: sus fallos bloquean el LOGIN de
 *     la cuenta, y entonces cualquiera que conozca el email del dueño podría,
 *     fallando el login desde afuera, dejarlo sin el botón de pánico justo
 *     cuando lo necesita. Pasado el tope del día, la salida es la de siempre:
 *     salir y volver a entrar, que exige la contraseña con todos los frenos
 *     del login.
 *
 * Va primero el de un minuto: un pedido que ése ya rechazó no llega al del
 * día y no le gasta el cupo.
 *
 * En memoria, como los demás limitadores de este archivo.
 */
const contrasenaSesionRapido = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: claveDeSesion,
  skipSuccessfulRequests: true,
  handler: respuesta('Demasiados intentos fallidos. Esperá un minuto antes de reintentar.'),
});
const contrasenaSesionDiario = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: claveDeSesion,
  skipSuccessfulRequests: true,
  handler: respuesta('Demasiados intentos fallidos con la contraseña desde esta sesión. Salí y volvé a entrar para seguir.'),
});
const frenoContrasenaDeSesion = [contrasenaSesionRapido, contrasenaSesionDiario];

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

/*
 * Todo lo que manda un mail a pedido de alguien.
 *
 * El límite general son 600 pedidos por minuto: para una pantalla está bien, y
 * para un endpoint que escribe un mail por llamada es un grifo abierto. Con una
 * cuenta —que cualquiera puede abrir— se pueden mandar cientos de mails por
 * minuto a la casilla de soporte. No hace falta que el contenido moleste: el
 * volumen alcanza para que el proveedor marque la cuenta de envío como spam, y
 * ahí dejan de llegar las facturas y los códigos de recuperación de todos.
 *
 * Diez por hora y por cuenta es holgado para reportar un problema de verdad —el
 * mismo problema no se reporta once veces— y corta el uso automático.
 */
const reporteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  /*
   * Por cuenta y no sólo por IP: un local con varias cajas sale por la misma
   * IP, y limitar ahí haría que el reporte de una cajera bloquee el de otra.
   * Sin sesión se cae a la IP, que es lo único que hay.
   */
  keyGenerator: (req) => {
    const ip = ipKeyGenerator(req.ip);
    const quien = req.auth?.businessId ? `n${req.auth.businessId}` : null;
    return quien ? `${ip}|${quien}` : ip;
  },
  handler: respuesta('Ya mandaste varios reportes seguidos. Esperá un rato: los estamos leyendo.'),
});

module.exports = {
  loginLimiter, passwordResetLimiter, registerLimiter, reporteLimiter,
  apiLimiter, burstLimiter, publicLimiter, frenoContrasenaDeSesion,
  claveIpMasEmail, claveDeSesion,
};
