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
