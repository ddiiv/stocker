import { http } from "../lib/http.js";

/*
 * Dónde están los textos legales.
 *
 * Viven en la landing y no en la app: son públicos y se leen antes de tener
 * cuenta. La dirección la da el backend (GET /public/legales, que sale de
 * LANDING_DOMAIN) y no está escrita acá: estaba escrita a mano con un dominio
 * que no era el nuestro, y el registro y Configuración mandaban a leer los
 * Términos a un sitio ajeno. Un solo pedido por carga de la app, porque la usan
 * el registro (al aceptarlos) y Configuración (para releerlos).
 *
 * Devuelve { terminos, privacidad, reembolsos, cookies } o null si el backend
 * no tiene la dirección: la pantalla muestra el nombre del texto sin enlace,
 * que es mejor que un enlace a un dominio inventado.
 */
let pedido = null;

export function cargarEnlacesLegales() {
  if (!pedido) {
    pedido = http.get("/public/legales")
      .then(({ data }) => data?.enlaces || null)
      .catch(() => {
        // Que una falla de red no quede guardada: el próximo que pregunte reintenta.
        pedido = null;
        return null;
      });
  }
  return pedido;
}
