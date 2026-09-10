import { http } from "../lib/http";

// El backend responde con Set-Cookie (httpOnly): no hay token que guardar
// acá, el navegador lo adjunta solo en cada request.
export async function register(payload) {
  const { data } = await http.post("/auth/register", payload);
  return data;
}

/*
 * El código del segundo factor viaja en el MISMO pedido que la contraseña.
 *
 * La alternativa sería que el primer pedido devolviera un token de "media
 * sesión" y el segundo lo canjeara. Eso es una credencial más para robar, con
 * su propia vigencia y sus propias formas de salir mal, a cambio de ahorrarle
 * al servidor una comparación de contraseña que ya sabe hacer.
 */
export async function login({ email, password, code }) {
  const { data } = await http.post("/auth/login", { email, password, code });
  return data;
}

/*
 * Pide el código de segundo factor antes de entrar, cuando el canal es el mail
 * o el WhatsApp. Va con la contraseña: si no, cualquiera podría hacer que le
 * lluevan códigos a un dueño ajeno hasta que se canse.
 */
export async function enviarCodigo2FA({ email, password, canal }) {
  const { data } = await http.post("/auth/2fa/enviar", { email, password, canal });
  return data;
}

export async function employeeLogin({ email, password }) {
  const { data } = await http.post("/auth/employee-login", { email, password });
  return data;
}

export async function logout() {
  // Sólo el servidor puede borrar una cookie httpOnly.
  try { await http.post("/auth/logout"); } catch { /* la sesión se cierra igual */ }
}

// Sin token en JS, la única forma de saber si hay sesión es preguntarle
// al backend: si la cookie no vale, responde 401 y devolvemos null.
export async function getMe() {
  try {
    const { data } = await http.get("/auth/me");
    return data;
  } catch {
    return null;
  }
}

// ── Recuperación de contraseña ─────────────────────────────────
export async function forgotPassword({ email, cuit }) {
  const { data } = await http.post("/auth/forgot-password", { email, cuit });
  return data;
}
export async function verifyResetCode({ email, code }) {
  const { data } = await http.post("/auth/verify-reset-code", { email, code });
  return data;
}
export async function resetPassword({ email, code, newPassword }) {
  const { data } = await http.post("/auth/reset-password", { email, code, newPassword });
  return data;
}
