const { parsearLista, estaEnLista, normalizar } = require('../utils/ip');
const { log } = require('../utils/logger');

/*
 * Restricción por IP para el backoffice.
 *
 * El backoffice ve los datos de todas las cuentas. Limitarlo a las IPs de
 * quien lo opera saca al 99,9% de internet de la ecuación antes de que llegue
 * a probar una contraseña.
 *
 * Es una capa, no LA capa. Sigue haciendo falta el segundo factor:
 *
 *   · Una IP doméstica cambia. Si la conexión se reinicia y la IP se mueve, el
 *     acceso se corta hasta actualizar la variable — es el costo de esto.
 *   · La IP del cliente llega en X-Forwarded-For, que la pone el edge de
 *     Railway. Es confiable mientras haya exactamente un proxy delante y
 *     `trust proxy` esté en 1, porque Express toma el último salto y no lo que
 *     el cliente haya querido inventar. Si algún día se agrega otro proxy hay
 *     que ajustar ese número o la lista pasa a ser decorativa.
 *
 * Responde 404 y no 403 a propósito. Un 403 confirma que el backoffice está en
 * esa URL y que sólo falta estar en la lista; un 404 no le dice nada a quien
 * está escaneando.
 */

const VARIABLE = 'BACKOFFICE_IPS';

/*
 * En desarrollo el localhost entra siempre, sin configurar nada. En producción
 * no se agrega solo: una IP de loopback ahí no sería el operador sino algo
 * corriendo dentro del contenedor.
 */
const LOCALES = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

let avisado = false;

function reglas() {
  return parsearLista(process.env[VARIABLE]);
}

/** Estado de la restricción, para mostrarlo en el arranque y en el backoffice. */
function estado() {
  const lista = reglas();
  return {
    activa: lista.length > 0,
    cantidad: lista.length,
    // Nunca se devuelven las IPs completas: aunque el panel sea interno, una
    // captura de pantalla con la IP del operador es un dato que no hace falta
    // que salga de la variable de entorno.
    variable: VARIABLE,
  };
}

const esProduccion = () => process.env.NODE_ENV === 'production';

const restringirBackoffice = (req, res, next) => {
  const lista = reglas();

  if (lista.length === 0) {
    /*
     * Sin lista configurada se deja pasar, pero se avisa fuerte una vez por
     * arranque. La alternativa —cerrar por defecto— dejaría a alguien afuera
     * de su propio panel en el primer deploy, sin forma de entrar a arreglarlo.
     * El aviso es lo que hace que no pase inadvertido.
     */
    if (!avisado) {
      avisado = true;
      log.warn('backoffice', `${VARIABLE} sin configurar: el panel acepta conexiones desde cualquier IP`);
    }
    return next();
  }

  const ip = normalizar(req.ip);
  const permitida = estaEnLista(ip, lista) || (!esProduccion() && LOCALES.includes(ip));

  if (permitida) return next();

  /*
   * Se registra la IP rechazada: el motivo real de casi todos estos rechazos es
   * que el operador cambió de dirección, y para agregarla hay que verla.
   *
   * Si además parece una IP interna, el problema no es la lista sino
   * TRUST_PROXY_HOPS: el backend está leyendo el salto equivocado de la cadena
   * y ninguna lista va a coincidir nunca. Se dice, porque desde afuera esto se
   * ve igual que "mi IP no está autorizada" y se pierde mucho tiempo ahí.
   */
  const pareceInterna = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fd|fe80:|::1$)/i.test(ip);
  log.warn('backoffice', 'acceso rechazado por IP', {
    ip, ruta: req.originalUrl,
    ...(pareceInterna ? { aviso: 'la IP resuelta es interna: revisá TRUST_PROXY_HOPS, se está leyendo el salto equivocado' } : {}),
  });
  return res.status(404).json({ message: 'No encontrado.' });
};

module.exports = { restringirBackoffice, estado, VARIABLE };
