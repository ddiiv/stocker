import axios from "axios";

export const API_URL = import.meta.env.VITE_API_URL ;

export const http = axios.create({
  baseURL: API_URL,
  headers: {
    "Content-Type": "application/json",
    // Saltea la interstitial page que ngrok (plan free) muestra a browsers.
    // Sin esto, axios recibe HTML en vez de JSON en la primera request.
    "ngrok-skip-browser-warning": "true",
  },
});

http.interceptors.request.use((config) => {
  const token = localStorage.getItem("isu_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
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
      // Sólo cerrar sesión si es un endpoint autenticado (no en /auth/login o forgot).
      const url = err.config?.url || "";
      if (!/\/auth\/(login|register|forgot-password|verify-reset-code|reset-password|employee-login)/.test(url)) {
        localStorage.removeItem("isu_token");
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
