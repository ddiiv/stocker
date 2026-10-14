/*
 * Por qué se cerró una sesión, para decirlo en la pantalla de entrar.
 *
 * Al que le cierran la sesión desde otro lado lo escupe al login en la mitad
 * de lo que estuviera haciendo. Sin una línea que lo explique parece que el
 * sistema se rompió, y lo primero que hace es reintentar la contraseña vieja.
 *
 * Los códigos son los que manda el backend en el 401 (requireAuth y
 * sesionesService.RECHAZOS). Un código que no está acá no viaja al login: se
 * cae a la pantalla de entrar sin cartel, como antes, en vez de mostrar un
 * texto inventado.
 *
 * SESION_CERRADA dice "se cambió la contraseña" porque desde que las sesiones
 * tienen tabla es sólo eso: cerrar desde otro dispositivo y "cerrar todas"
 * tienen su propio código.
 */
export const AVISOS_DE_CIERRE = {
  SESION_CERRADA: "Se cambió la contraseña, así que se cerraron las sesiones abiertas. Entrá con la nueva.",
  SESION_REVOCADA: "Tu usuario ya no tiene acceso. Pedile al dueño de la cuenta que lo revise.",
  SESION_DESPLAZADA:
    "Se cerró tu sesión porque se entró a la cuenta desde otro dispositivo y el plan tiene un máximo de dispositivos a la vez. Si no fuiste vos, cambiá la contraseña.",
  SESION_CERRADA_REMOTA: "Se cerró tu sesión desde otro dispositivo. Volvé a entrar.",
  SESION_FINALIZADA: "La sesión terminó. Volvé a entrar.",
  SESION_ANTERIOR: "Actualizamos la forma de iniciar sesión. Volvé a entrar: es una sola vez.",
  // La cuenta bajó a un plan con menos usuarios y éste quedó afuera: no es que
  // lo echaron, y lo resuelve el dueño eligiéndolo o subiendo de plan.
  SESION_SUSPENDIDA_PLAN:
    "Tu usuario quedó suspendido porque la cuenta pasó a un plan con menos usuarios. Pedile al dueño que te habilite.",
};

/*
 * Propia y no heredada: `?motivo=toString` no puede sacar un cartel. Con
 * hasOwnProperty y no Object.hasOwn, que no existe en el Safari de los
 * iPhone que no se actualizan, y esto corre en el camino de cada 401.
 */
const tieneCartel = (codigo) => Object.prototype.hasOwnProperty.call(AVISOS_DE_CIERRE, codigo || "");

/** El `?motivo=…` para el login, o "" si el código no tiene cartel. */
export function motivoParaLogin(codigo) {
  return tieneCartel(codigo) ? `?motivo=${codigo}` : "";
}

/** El texto del cartel para un `?motivo=` del login, o null. */
export function avisoDeCierre(motivo) {
  return tieneCartel(motivo) ? AVISOS_DE_CIERRE[motivo] : null;
}
