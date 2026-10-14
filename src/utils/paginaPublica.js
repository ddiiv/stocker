/*
 * Dónde está la página pública (la landing) y, en ella, los textos legales.
 *
 * Sale de LANDING_DOMAIN y no del código. Las direcciones de los Términos
 * estaban escritas a mano en el front con un dominio que no era el nuestro, y
 * el registro y Configuración mandaban a leerlos a un sitio ajeno. Con una sola
 * variable, el día que cambia el dominio se cambia en Railway y no queda un
 * enlace viejo en ninguna pantalla.
 *
 * Sin la variable devuelve null: mejor un texto sin enlace que un enlace a un
 * dominio inventado.
 */

const RUTAS_LEGALES = {
  terminos: '/terminos',
  privacidad: '/privacidad',
  reembolsos: '/reembolsos',
  cookies: '/cookies',
};

/** URL pública de la landing, o null si LANDING_DOMAIN no está. */
function urlPaginaPublica() {
  const bruto = (process.env.LANDING_DOMAIN || '').trim().replace(/\/+$/, '');
  if (!bruto) return null;
  return /^https?:\/\//i.test(bruto) ? bruto : `https://${bruto}`;
}

/** { terminos, privacidad, reembolsos, cookies } con la URL completa, o null. */
function enlacesLegales() {
  const base = urlPaginaPublica();
  if (!base) return null;
  return Object.fromEntries(Object.entries(RUTAS_LEGALES).map(([k, ruta]) => [k, base + ruta]));
}

module.exports = { urlPaginaPublica, enlacesLegales, RUTAS_LEGALES };
