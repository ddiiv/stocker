import axios from "axios";

/*
 * Cliente HTTP del backoffice.
 *
 * Mismo origen que la API: en desarrollo lo resuelve el proxy de Vite, en
 * producción el server.js que sirve el build. Así la cookie de sesión no es
 * de terceros y no hace falta relajar SameSite.
 */
export const http = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "/api",
  withCredentials: true,
  headers: { "Content-Type": "application/json" },
});

http.interceptors.response.use(
  (r) => r,
  (err) => {
    const status = err.response?.status;
    const url = err.config?.url || "";

    /*
     * Sesión caída → al login.
     *
     * Se excluye `/backoffice/me`, que es la sonda que corre al montar la app:
     * sin sesión responde 401 y redirigir ahí armaría un bucle (recarga →
     * sonda → redirección → recarga). Y el propio login, donde un 401 es la
     * respuesta esperada a credenciales incorrectas.
     */
    const esperado = /\/backoffice\/(me|login|totp)/.test(url);
    if (status === 401 && !esperado && window.location.pathname !== "/login") {
      window.location.href = "/login";
    }
    return Promise.reject(err);
  }
);

/** Mensaje de error legible, con un respaldo para cuando el backend no manda uno. */
export function mensajeDe(err, porDefecto = "Algo falló. Probá de nuevo.") {
  return err?.response?.data?.message || porDefecto;
}
