import { esAdministradorTotal } from "./permissions.js";
import { formatDate } from "./formatters.js";

/*
 * La sección Configuración de la cuenta: qué pestañas tiene y quién ve cuál.
 *
 * Lo que se le muestra a cada uno sale de lo que el backend ya decide, no de
 * un permiso nuevo:
 *
 *   · Los datos del negocio, la suscripción, el doble factor y los términos
 *     son del titular: sus rutas piden requireOwner y un empleado recibe 403.
 *     Ningún cargo los puede habilitar.
 *   · Las sesiones son lo único que también ve un empleado, y sólo las SUYAS
 *     (GET /api/account/sesiones filtra por quién pregunta). El teléfono que
 *     se olvidó abierto en el colectivo es de él, y tiene que poder cerrarlo
 *     sin pedírselo al dueño.
 *
 * Ocultar una pestaña es comodidad, no seguridad: quién puede qué lo resuelve
 * el backend en cada ruta.
 */
export const PESTANAS_CUENTA = [
  { to: "/cuenta",             label: "Mi cuenta",   end: true, soloDuenio: true },
  { to: "/cuenta/suscripcion", label: "Suscripción",            soloDuenio: true },
  { to: "/cuenta/sesiones",    label: "Sesiones" },
  { to: "/cuenta/seguridad",   label: "Seguridad",              soloDuenio: true },
  { to: "/cuenta/terminos",    label: "Términos",               soloDuenio: true },
];

export function pestanasDeCuenta(user) {
  if (!user) return [];
  const duenio = esAdministradorTotal(user);
  return PESTANAS_CUENTA.filter((p) => duenio || !p.soloDuenio);
}

/*
 * Adónde lleva "Configuración" en el menú.
 *
 * Al dueño, a su cuenta. Al empleado, a la única pestaña que puede abrir: si
 * lo mandara a /cuenta se encontraría con el cartel de "sección del dueño" y
 * creería que no tiene nada que ver ahí.
 */
export function entradaDeCuenta(user) {
  return pestanasDeCuenta(user)[0]?.to || null;
}

/* ── Suscripción ──────────────────────────────────────────────── */

/*
 * Cuándo es el próximo pago y de qué plan, para la pantalla de Suscripción.
 *
 * `sub` es lo que manda GET /api/billing/suscripcion.
 *
 *   · En la prueba no hay cobro: la suscripción se activa a mano.
 *   · Vencida (morosa o en modo lectura): el pago ya se debe. Mostrar la
 *     fecha vieja como "próximo" la haría parecer futura.
 *   · Con la renovación apagada no se vuelve a cobrar.
 *   · Con una bajada ya paga esperando, lo que se paga después es el plan
 *     NUEVO: decir el actual haría pensar que la bajada no se registró.
 */
export function proximoCobro(sub = {}) {
  const rotulo = "Próximo cobro";
  if (sub.estado === "trial") return { rotulo, valor: "Durante la prueba no se cobra", nota: null };
  if (sub.estado === "morosa" || sub.estado === "lectura") {
    return {
      rotulo, valor: "Pendiente", alerta: true,
      nota: sub.vence ? `Venció el ${formatDate(sub.vence)}` : null,
    };
  }
  if (!sub.renovacionAutomatica) {
    return { rotulo, valor: "No se vuelve a cobrar", nota: "La renovación está desactivada" };
  }
  const fecha = sub.proximoCobroEn || sub.vence;
  return {
    rotulo,
    valor: fecha ? formatDate(fecha) : "Sin fecha",
    // Los planes ya se llaman "Plan Pro", "Plan Superior".
    nota: sub.planPendiente?.nombre || sub.plan?.nombre || null,
  };
}

/* ── Sesiones ─────────────────────────────────────────────────── */

const MINUTO = 60 * 1000;
const HORA = 60 * MINUTO;

/*
 * "hace 5 min", "hace 3 h"; más atrás, la fecha y la hora.
 *
 * Para la última actividad lo que importa es cuánto hace, no la hora exacta:
 * "hace un momento" dice "ésta está en uso", y es lo que hay que saber antes
 * de cerrarla. Después de un día, en cambio, "hace 31 h" obliga a hacer la
 * cuenta y la fecha se lee mejor.
 *
 * La última actividad se guarda como mucho una vez por minuto, así que
 * cualquier cosa por debajo de dos minutos es "ahora".
 */
export function haceCuanto(fecha, ahora = Date.now()) {
  if (!fecha) return "—";
  const t = new Date(fecha).getTime();
  if (Number.isNaN(t)) return "—";
  const dif = Math.max(0, new Date(ahora).getTime() - t);
  if (dif < 2 * MINUTO) return "hace un momento";
  if (dif < HORA) return `hace ${Math.floor(dif / MINUTO)} min`;
  if (dif < 24 * HORA) return `hace ${Math.floor(dif / HORA)} h`;
  return fechaYHora(t);
}

export function fechaYHora(fecha) {
  if (!fecha) return "—";
  const d = new Date(fecha);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    // 24 horas, igual que el resto del sistema.
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
}

/*
 * De quién es una sesión, dicho para quien mira la lista.
 *
 * El dueño ve las de todo el negocio y necesita saber cuál es suya y cuál de
 * la cajera. El empleado sólo ve las suyas: ponerle su propio nombre a cada
 * renglón no le dice nada.
 */
export function deQuienEs(sesion, user) {
  if (!esAdministradorTotal(user)) return null;
  if (sesion.tipo === "business") return "Vos (dueño)";
  const e = sesion.empleado;
  const nombre = [e?.nombre, e?.apellido].filter(Boolean).join(" ");
  // Un empleado borrado no tiene nombre, pero su sesión existió igual.
  return nombre || "Empleado dado de baja";
}

/*
 * Si el dispositivo es un teléfono o una tablet, para elegir el ícono.
 * La etiqueta la arma el backend («Chrome · Android»): acá sólo se mira.
 */
export function esMovil(dispositivo) {
  return /\b(Android|iPhone|iPad)\b/.test(String(dispositivo || ""));
}

/*
 * El orden de las activas: la de este dispositivo primero (es la referencia
 * con la que se lee el resto), después las del dueño, después las de los
 * empleados; y dentro de cada grupo, la más reciente arriba.
 *
 * Al dueño le importan primero las suyas: son las que cuentan para el límite
 * del plan y las que delatan a alguien que entró con su contraseña.
 */
export function ordenarActivas(sesiones = []) {
  const peso = (s) => (s.actual ? 0 : s.tipo === "business" ? 1 : 2);
  return [...sesiones].sort((a, b) =>
    peso(a) - peso(b) ||
    new Date(b.ultimaActividadEn).getTime() - new Date(a.ultimaActividadEn).getTime());
}

/*
 * Qué decir del límite de dispositivos del dueño.
 *
 * `limite` es lo que manda GET /api/account/sesiones: { tope, modo, activas },
 * o null para un empleado (no tiene límite y no le toca ver el del dueño).
 *
 * El modo cambia lo que es verdad decir:
 *   activo  pasarse cierra sola la sesión con menos actividad.
 *   sombra  se cuenta, pero todavía no se cierra nada: decir "se cierra"
 *           sería prometer algo que hoy no pasa.
 *   off     no se cuenta: no hay nada que medir.
 */
export function textoDelLimite(limite) {
  if (!limite) return null;
  const { tope, modo, activas = 0 } = limite;
  if (modo === "off" || tope == null) {
    return {
      cifra: `${activas} abierta${activas === 1 ? "" : "s"}`,
      detalle: "Tu plan no limita en cuántos dispositivos podés tener abierta la sesión del dueño.",
      pasado: false,
      conBarra: false,
    };
  }
  const pasado = activas > tope;
  const dispositivos = `${tope} dispositivo${tope === 1 ? "" : "s"}`;
  const detalle = modo === "activo"
    ? `Tu plan permite la sesión del dueño abierta en ${dispositivos} a la vez. Si entrás desde uno más, se cierra sola la que tenga menos actividad reciente.`
    : `Tu plan incluye la sesión del dueño abierta en ${dispositivos} a la vez. Por ahora no cerramos ninguna por pasarte: cuando empiece a aplicarse, al entrar desde uno más se va a cerrar sola la que tenga menos actividad reciente.`;
  return { cifra: `${activas} de ${tope}`, detalle, pasado, conBarra: true };
}

/* ── Términos ─────────────────────────────────────────────────── */

/*
 * Cómo está la cuenta respecto de los Términos vigentes.
 *
 *   al-dia      aceptó la versión que rige hoy.
 *   anterior    aceptó otra (la vigente se publicó después).
 *   sin-registro la cuenta es de antes de que se guardara la aceptación.
 */
export function estadoDeTerminos({ terminosVersion, terminosVigente } = {}) {
  if (!terminosVersion) return "sin-registro";
  if (!terminosVigente || terminosVersion === terminosVigente) return "al-dia";
  return "anterior";
}
