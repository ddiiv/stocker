import { http } from "../lib/http";

export async function register(payload) {
  const { data } = await http.post("/auth/register", payload);
  localStorage.setItem("isu_token", data.token);
  return data;
}

export async function login({ email, password }) {
  const { data } = await http.post("/auth/login", { email, password });
  localStorage.setItem("isu_token", data.token);
  return data;
}

export async function employeeLogin({ email, password }) {
  const { data } = await http.post("/auth/employee-login", { email, password });
  localStorage.setItem("isu_token", data.token);
  return data;
}

export function logout() {
  localStorage.removeItem("isu_token");
}

export async function getMe() {
  const token = localStorage.getItem("isu_token");
  if (!token) return null;
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
