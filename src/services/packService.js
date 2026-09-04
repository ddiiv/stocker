import { http } from "../lib/http";

/* ── Packs (combos) ─────────────────────────────────────────────
 *
 * Un pack tiene SKU propio y se publica como un artículo más, pero adentro
 * lleva prendas que ya están en el estante. Todo lo que hay acá gira alrededor
 * de eso: el pack no tiene stock propio, tiene una composición, y lo que se
 * puede armar sale de lo que haya de cada componente.
 */

/** Los packs del negocio, con su composición y cuántos se arman hoy. */
export async function fetchPacks() {
  const { data } = await http.get("/packs");
  return data;
}

/**
 * Crea el pack entero: producto propio, variante y composición, en una llamada.
 *
 * Va junto y no en pasos porque si fallara el último quedaría un producto vacío
 * colgado en el listado de stock, sin variantes y sin manera de saber que era
 * un pack a medio nacer.
 *
 * @param {{sku:string, titulo:string, precioMinorista:number,
 *          precioMayorista?:number, costo?:number,
 *          componentes:Array<{componenteVariantId:number, cantidad:number}>}} datos
 */
export async function crearPack(datos) {
  const { data } = await http.post("/packs", datos);
  return data;
}

/** Un pack: composición, cuántos se arman y en qué locales. */
export async function fetchPack(variantId) {
  const { data } = await http.get(`/packs/${variantId}`);
  return data;
}

/**
 * Guarda la composición completa.
 *
 * Reemplaza, no suma: la composición se piensa entera —"tres remeras"—, y
 * mandarla de a un componente dejaría al pack existiendo mal armado entre una
 * llamada y la otra, con Mercado Libre vendiendo contra esa composición.
 *
 * @param {Array<{componenteVariantId:number, cantidad:number}>} componentes
 */
export async function guardarPack(variantId, componentes) {
  const { data } = await http.put(`/packs/${variantId}`, { componentes });
  return data;
}

/** Deja de ser pack y vuelve a ser una variante común. */
export async function desarmarPack(variantId) {
  const { data } = await http.delete(`/packs/${variantId}`);
  return data;
}

/**
 * Qué packs dependen de esta variante.
 *
 * Para avisar antes de desactivarla: sin esto, un pack publicado pasa a stock
 * cero de un día para el otro y nadie sabe por qué.
 */
export async function packsQueUsan(variantId) {
  const { data } = await http.get(`/packs/usan/${variantId}`);
  return data;
}
