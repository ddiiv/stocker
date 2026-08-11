import axios from "axios";

// Mismo origen: en dev lo resuelve el proxy de Vite, en producción el
// servicio web que sirve el build y reenvía /api por la red privada.
export const API_URL = import.meta.env.VITE_API_URL || "/api";

export const http = axios.create({
  baseURL: API_URL,
  // El token viaja en una cookie httpOnly que el navegador adjunta solo.
  // Ya no hay nada que leer desde JS, así que tampoco hay nada que robar.
  withCredentials: true,
  headers: {
    "Content-Type": "application/json",
  },
});

// Callback opcional que dispara un modal global cuando el backend responde 403.
// Se registra desde PermissionGuardProvider al montarse.
let onForbidden = null;
export function registerForbiddenHandler(handler) { onForbidden = handler; }

http.interceptors.response.use(
  (r) => r,
  (err) => {
    const status = err.response?.status;
    if (status === 401) {
      // Endpoints donde un 401 es una respuesta esperada, no una sesión caída.
      //
      // `/auth/me` es el que importa: es la sonda de sesión que corre al montar
      // la app. Sin cookie válida responde 401, y si eso redirigiera a /login
      // tendríamos un loop — la recarga vuelve a montar la app, que vuelve a
      // sondear, que vuelve a redirigir.
      const url = err.config?.url || "";
      const esperado = /\/auth\/(me|login|register|forgot-password|verify-reset-code|reset-password|employee-login)/.test(url);

      // Estando ya en /login no hay adónde ir: redirigir sería otra recarga en vano.
      const yaEnLogin = window.location.pathname === "/login";

      if (!esperado && !yaEnLogin) {
        // La cookie es httpOnly: sólo el backend puede borrarla.
        window.location.href = "/login";
      }
    }
    if (status === 403 && onForbidden) {
      const msg = err.response?.data?.message || "";
      // Parseamos "Sin permiso de <level> en <modulo>." para mostrar el modal correcto
      const match = msg.match(/Sin permiso de (\w+) en (\w+)/);
      if (match) onForbidden({ permission: match[2], level: match[1] });
      else onForbidden({ permission: "acción", level: "editar" });
    }
    return Promise.reject(err);
  }
);
