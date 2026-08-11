/*
 * Vigencia de la sesión: dos límites que corren en paralelo.
 *
 *   · Inactividad (30 min por defecto): si no hay pedidos durante ese lapso,
 *     la sesión muere. Es lo que protege la caja del local cuando alguien deja
 *     la pantalla abierta y se va.
 *
 *   · Absoluto (24 h): aunque el usuario esté activo todo el día, a las 24 h
 *     hay que volver a autenticarse. Acota cuánto sirve un token robado.
 *
 * Se implementa sin tabla de sesiones: el `exp` del JWT lleva la ventana de
 * inactividad y se renueva en cada pedido, mientras que `absExp` viaja firmado
 * adentro y no se mueve. Como el `exp` corto lo valida el propio jsonwebtoken,
 * la inactividad la corta el servidor — no depende de que el navegador borre
 * la cookie, que es lo que haría un atacante con el token en la mano.
 */

const { signToken, verifyToken } = require('./jwt');

const IDLE_MIN    = Number(process.env.SESSION_IDLE_MINUTES)    || 30;
const ABSOLUTE_H  = Number(process.env.SESSION_ABSOLUTE_HOURS)  || 24;

const IDLE_MS     = IDLE_MIN   * 60 * 1000;
const ABSOLUTE_MS = ABSOLUTE_H * 60 * 60 * 1000;

// Token de una sesión nueva (login/registro).
function crearSesion(payload) {
  const absExp = Math.floor((Date.now() + ABSOLUTE_MS) / 1000); // en segundos, como exp
  return signToken({ ...payload, absExp }, { expiresIn: `${IDLE_MIN}m` });
}

// Token renovado: mueve la ventana de inactividad, conserva el tope absoluto.
// Devuelve null si ya se pasó el límite absoluto.
function renovarSesion(payload) {
  const absExp = payload.absExp;
  if (!absExp) {
    // Sesión emitida antes de este cambio: le damos un tope desde ahora para
    // que las que estaban abiertas no se corten de golpe en el deploy.
    return crearSesion(despojar(payload));
  }
  if (Date.now() / 1000 >= absExp) return null;

  // El nuevo exp no puede pasarse del tope absoluto.
  const restanteSeg = Math.floor(absExp - Date.now() / 1000);
  const ventanaSeg  = Math.min(Math.floor(IDLE_MS / 1000), restanteSeg);
  if (ventanaSeg <= 0) return null;

  return signToken({ ...despojar(payload), absExp }, { expiresIn: ventanaSeg });
}

// Saca los campos que pone jsonwebtoken para que no se dupliquen al re-firmar.
function despojar(payload) {
  const { iat, exp, nbf, absExp, ...resto } = payload;
  return resto;
}

module.exports = {
  crearSesion,
  renovarSesion,
  verifyToken,
  IDLE_MS,
  ABSOLUTE_MS,
  IDLE_MIN,
  ABSOLUTE_H,
};
