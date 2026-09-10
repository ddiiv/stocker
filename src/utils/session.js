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
//
// `iniciada` es cuándo empezó ESTA sesión, y viaja firmada adentro. No alcanza
// con el `iat` del JWT: la ventana deslizante re-firma el token en cada pedido,
// así que su `iat` es siempre de hace un segundo. Justamente el token robado
// que se está usando tendría el `iat` más nuevo de todos, y un corte por `iat`
// echaría a los legítimos y dejaría entrar al intruso.
function crearSesion(payload) {
  const absExp = Math.floor((Date.now() + ABSOLUTE_MS) / 1000); // en segundos, como exp
  // En milisegundos, no en segundos como `exp`: con precisión de un segundo,
  // una sesión abierta en el MISMO segundo que el cierre quedaba del lado de
  // adentro. Es una ventana de un segundo, pero también volvía inestable a la
  // prueba que lo cubre —pasaba o fallaba según dónde cayera el borde del
  // segundo—, y una prueba de seguridad que a veces pasa no sirve de nada.
  const iniciada = Date.now();
  return signToken({ ...payload, iniciada, absExp }, { expiresIn: `${IDLE_MIN}m` });
}

/*
 * ¿Esta sesión sigue valiendo, o la cuenta cerró todo desde entonces?
 *
 * `sesionesDesde` lo mueve el cambio de contraseña. Nulo —el caso de todas las
 * cuentas hasta que alguien cambie la suya— significa que no se cerró nada
 * nunca, así que todo vale y el deploy no desloguea a nadie.
 *
 * Un token sin `iniciada` es de antes de este cambio: si la cuenta cerró
 * sesiones, no hay forma de saber si ésta es anterior o posterior al corte, y
 * ante la duda se cierra. Es lo correcto para lo que esto protege: la duda
 * aparece justo cuando alguien acaba de cambiar la contraseña porque sospecha
 * que le entraron.
 */
function sesionVigente(payload, sesionesDesde) {
  if (!sesionesDesde) return true;
  const iniciada = Number(payload?.iniciada);
  if (!Number.isFinite(iniciada)) return false;
  return iniciada >= new Date(sesionesDesde).getTime();
}

/*
 * El instante que se guarda en `sesionesDesde` al cerrar todo.
 *
 * Con la precisión completa que aguanta la columna (datetimeoffset(7) en SQL
 * Server, timestamptz en Postgres). El que cambia su contraseña y se queda
 * adentro no depende de redondeos: se le emite la sesión DESPUÉS de escribir
 * el corte, así que su `iniciada` es necesariamente posterior.
 */
function corteDeSesiones(fecha = new Date()) {
  return new Date(fecha.getTime());
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
// `iniciada` NO se saca: es el momento en que empezó la sesión y tiene que
// sobrevivir a todas las renovaciones, que es lo que hace que el corte por
// cambio de contraseña funcione.
function despojar(payload) {
  const { iat, exp, nbf, absExp, ...resto } = payload;
  return resto;
}

module.exports = {
  crearSesion,
  renovarSesion,
  sesionVigente,
  corteDeSesiones,
  verifyToken,
  IDLE_MS,
  ABSOLUTE_MS,
  IDLE_MIN,
  ABSOLUTE_H,
};
