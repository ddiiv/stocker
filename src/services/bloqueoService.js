const { Op } = require('sequelize');
const { AuthAttempt } = require('../models');
const { log, mask } = require('../utils/logger');
const { normalizar } = require('../utils/ip');

/*
 * Bloqueo por intentos fallidos.
 *
 * El limitador de peticiones (middleware/rateLimit) cuenta REQUESTS por minuto;
 * esto cuenta FALLOS. Son cosas distintas y las dos hacen falta: el limitador
 * frena un ataque rápido, esto frena el lento — cuatro intentos por minuto
 * durante horas no toca nunca el limitador y prueba miles de contraseñas.
 *
 * Se mide en dos ejes a propósito:
 *
 *   Por IP         → alguien probando muchas cuentas desde un lugar.
 *   Por cuenta     → muchas IPs contra una sola cuenta, que es como se ve un
 *                    ataque repartido con proxies. Sólo por IP, no se detecta.
 *
 * El bloqueo se deduce contando filas, no se guarda. Así se vence solo cuando
 * los intentos salen de la ventana, y no queda estado que limpiar ni riesgo de
 * dejar a alguien afuera por un registro que nadie borró.
 *
 * Vive en la base y no en memoria porque en Railway el servicio puede tener más
 * de una réplica: en memoria, cada una contaría por su cuenta y el tope real
 * sería el doble o el triple del configurado.
 */

const VENTANA_MIN = 15;          // en qué lapso se cuentan los fallos

/*
 * Los dos topes no son intercambiables y por eso son tan distintos.
 *
 * POR CUENTA (5) es el que frena el ataque: adivinar una contraseña necesita
 * muchos intentos contra la misma cuenta, y cinco por cuarto de hora hace que
 * probar sea inviable venga de donde venga.
 *
 * POR IP (30) es sólo la señal de volumen — alguien enumerando cuentas. Tiene
 * que ser holgado porque una IP no es una persona: un local con veinte
 * empleados detrás de un router comparte una sola dirección, y un lunes con
 * varios olvidándose la contraseña junta fallos sin que nadie esté atacando.
 * Con un tope bajo, el primero que se equivoca deja al resto sin poder entrar.
 *
 * Treinta está bien arriba de ese ruido y bien abajo de lo que necesita un
 * atacante, que hace cientos de intentos. No se configura por variable a
 * propósito: un número mal puesto acá abre un agujero sin que nadie lo note.
 */
const TOPE_POR_IP = 30;
const TOPE_POR_CUENTA = 5;
const RETENCION_DIAS = 7;        // cuánto se guarda el historial

/*
 * Duración del bloqueo según la insistencia de las últimas 24 horas.
 *
 * Escalonado a propósito: quince minutos alcanzan para el que se olvidó la
 * contraseña, y no alcanzan para el que va a estar probando toda la noche.
 */
const ESCALERA = [
  { desde: 0,   minutos: 15 },
  { desde: 40,  minutos: 60 },
  { desde: 120, minutos: 360 },
];

const haceMinutos = (min) => new Date(Date.now() - min * 60 * 1000);
const enMinutos = (fecha, min) => new Date(new Date(fecha).getTime() + min * 60 * 1000);

function duracionPara(fallosEnUnDia) {
  let minutos = ESCALERA[0].minutos;
  for (const tramo of ESCALERA) if (fallosEnUnDia >= tramo.desde) minutos = tramo.minutos;
  return minutos;
}

const limpiarEmail = (v) => String(v || '').trim().toLowerCase() || null;

/**
 * Registra un intento. Nunca lanza.
 *
 * Si falla el registro no se puede dejar de responder el login: la seguridad no
 * puede convertirse en una forma de tirar abajo el acceso.
 */
async function registrar({ req, tipo, identificador, exito }) {
  try {
    await AuthAttempt.create({
      ip: normalizar(req.ip),
      identificador: limpiarEmail(identificador),
      tipo,
      exito: Boolean(exito),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 200) || null,
    });
  } catch (e) {
    log.warn('bloqueo', 'no se pudo registrar el intento', { error: e.message });
  }
}

/**
 * Borra los fallos de esa cuenta desde esa IP.
 *
 * Se llama al entrar bien: quien recordó la contraseña no tiene que seguir
 * arrastrando sus errores. Se acota a (IP + cuenta) y no a la IP entera —
 * si no, alguien con una cuenta propia válida podría limpiar su contador
 * entrando a la suya y seguir probando contra las demás desde el mismo lugar.
 */
async function limpiar({ req, identificador }) {
  try {
    await AuthAttempt.destroy({
      where: {
        ip: normalizar(req.ip),
        identificador: limpiarEmail(identificador),
        exito: false,
      },
    });
  } catch { /* no es crítico: los fallos vencen solos */ }
}

/**
 * ¿Está bloqueado ahora mismo?
 *
 * @returns {Promise<null|{ motivo, hasta, minutos, mensaje }>}
 */
async function revisar({ req, identificador }) {
  const ip = normalizar(req.ip);
  const email = limpiarEmail(identificador);
  const desde = haceMinutos(VENTANA_MIN);

  const [porIp, porCuenta] = await Promise.all([
    AuthAttempt.findAll({
      where: { ip, exito: false, fecha: { [Op.gte]: desde } },
      order: [['fecha', 'DESC']],
      attributes: ['fecha'],
    }),
    email
      ? AuthAttempt.findAll({
          where: { identificador: email, exito: false, fecha: { [Op.gte]: desde } },
          order: [['fecha', 'DESC']],
          attributes: ['fecha'],
        })
      : Promise.resolve([]),
  ]);

  const excedidos = [];
  if (porIp.length >= TOPE_POR_IP) excedidos.push({ motivo: 'ip', intentos: porIp });
  if (porCuenta.length >= TOPE_POR_CUENTA) excedidos.push({ motivo: 'cuenta', intentos: porCuenta });
  if (!excedidos.length) return null;

  // Gana el que libera más tarde: si los dos ejes están excedidos, aflojar por
  // el más blando dejaría abierto el que hacía falta.
  let peor = null;
  for (const { motivo, intentos } of excedidos) {
    const ultimo = intentos[0].fecha;
    const enUnDia = await AuthAttempt.count({
      where: motivo === 'ip'
        ? { ip, exito: false, fecha: { [Op.gte]: haceMinutos(24 * 60) } }
        : { identificador: email, exito: false, fecha: { [Op.gte]: haceMinutos(24 * 60) } },
    });
    const minutos = duracionPara(enUnDia);
    const hasta = enMinutos(ultimo, minutos);
    if (!peor || hasta > peor.hasta) peor = { motivo, hasta, minutos };
  }

  if (peor.hasta <= new Date()) return null;   // ya se venció

  const restan = Math.max(1, Math.ceil((peor.hasta - Date.now()) / 60000));

  return {
    ...peor,
    minutos: restan,
    /*
     * El mensaje no distingue si el bloqueo fue por IP o por cuenta, ni si la
     * cuenta existe. Decir "bloqueamos esta cuenta" ya confirma que la cuenta
     * está registrada, que es justamente lo que un atacante quiere averiguar.
     */
    mensaje: `Demasiados intentos fallidos. Volvé a probar en ${restan} minuto${restan === 1 ? '' : 's'}. ` +
             `Si no recordás la contraseña, usá la recuperación por email.`,
  };
}

/**
 * Middleware para poner delante de un login.
 *
 * Va antes de comprobar la contraseña: si ya está bloqueado, no hay que gastar
 * un bcrypt ni darle ninguna señal sobre si los datos eran correctos.
 */
const frenarSiBloqueado = (tipo) => async (req, res, next) => {
  try {
    const bloqueo = await revisar({ req, identificador: req.body?.email });
    if (!bloqueo) return next();

    log.warn('bloqueo', 'intento rechazado por bloqueo activo', {
      tipo, motivo: bloqueo.motivo, ip: normalizar(req.ip),
      cuenta: mask.email(req.body?.email), minutos: bloqueo.minutos,
    });

    // 429 y no 401: no es que las credenciales estén mal, es que no se está
    // evaluando. Y `Retry-After` deja que un cliente sepa cuánto esperar.
    res.set('Retry-After', String(bloqueo.minutos * 60));
    return res.status(429).json({ message: bloqueo.mensaje, motivo: 'bloqueo' });
  } catch (e) {
    // Si la comprobación falla, se deja pasar al login normal en vez de negar
    // el acceso a todo el mundo. El limitador de peticiones sigue en pie.
    log.warn('bloqueo', 'no se pudo comprobar el bloqueo, se continúa', { error: e.message });
    return next();
  }
};

/** Borra historial viejo. Se llama al arrancar. */
async function purgar() {
  try {
    const borrados = await AuthAttempt.destroy({
      where: { fecha: { [Op.lt]: haceMinutos(RETENCION_DIAS * 24 * 60) } },
    });
    if (borrados) log.info('bloqueo', `intentos antiguos purgados: ${borrados}`);
    return borrados;
  } catch (e) {
    log.warn('bloqueo', 'no se pudo purgar el historial', { error: e.message });
    return 0;
  }
}

module.exports = {
  registrar, limpiar, revisar, frenarSiBloqueado, purgar,
  VENTANA_MIN, TOPE_POR_IP, TOPE_POR_CUENTA,
};
