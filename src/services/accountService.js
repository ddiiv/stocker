import { http } from "../lib/http";

export async function fetchAccount() {
  const { data } = await http.get("/account");
  return data;
}

/** Sólo datos que no son credenciales: email y contraseña tienen su propio flujo. */
export async function updateAccount(payload) {
  const { data } = await http.put("/account", payload);
  return data;
}

/** Trae nombre, apellido y condición fiscal del padrón de ARCA. */
export async function sincronizarConArca() {
  const { data } = await http.post("/account/sincronizar-arca");
  return data;
}

export async function solicitarCambioEmail(emailNuevo) {
  const { data } = await http.post("/account/email/solicitar", { emailNuevo });
  return data;
}
export async function confirmarCambioEmail(code) {
  const { data } = await http.post("/account/email/confirmar", { code });
  return data;
}

export async function solicitarCambioPassword(passwordActual) {
  const { data } = await http.post("/account/password/solicitar", { passwordActual });
  return data;
}
export async function confirmarCambioPassword({ code, passwordNueva }) {
  const { data } = await http.post("/account/password/confirmar", { code, passwordNueva });
  return data;
}

/*
 * Saca a todo el mundo de todas las computadoras, sin cambiar contraseñas.
 * Pide la actual: si no, cualquiera que agarre la máquina del mostrador con la
 * sesión abierta deja al negocio afuera en el medio de un sábado.
 */
export async function cerrarTodasLasSesiones(passwordActual) {
  const { data } = await http.post("/account/sesiones/cerrar", { passwordActual });
  return data;
}

/*
 * ── Verificación en dos pasos ────────────────────────────────────
 *
 * Activar son DOS llamadas: `iniciar` entrega el secreto para cargar en la app
 * y `activar` lo confirma con un código. Hasta la segunda no protege nada, y
 * es a propósito: si se activara de una, quien abre la pantalla y se distrae
 * queda con el 2FA prendido y sin ninguna app cargada.
 */
export async function iniciar2FA(passwordActual) {
  const { data } = await http.post("/account/2fa/iniciar", { passwordActual });
  return data;
}
export async function activar2FA(code) {
  const { data } = await http.post("/account/2fa/activar", { code });
  return data;
}
export async function desactivar2FA({ passwordActual, code }) {
  const { data } = await http.post("/account/2fa/desactivar", { passwordActual, code });
  return data;
}
export async function regenerarCodigos2FA({ passwordActual, code }) {
  const { data } = await http.post("/account/2fa/codigos", { passwordActual, code });
  return data;
}
