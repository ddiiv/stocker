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
