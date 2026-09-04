import { http } from "../lib/http";

/* ── Packs (combos) ─────────────────────────────────────────────
 *
 * Un pack no es un artículo más del catálogo: es la forma de vender de a N
 * unidades de otro producto. Tiene SKU propio para que Mercado Libre pueda
 * publicarlo y el mostrador escanearlo, pero no tiene stock: lo que hay se
 * calcula con lo que haya de las prendas que lleva adentro.
 *
 * Se arma desde el producto padre, y se genera un pack por cada variante del
 * padre: el pack x3 de la remera negra M es distinto del de la beige L, igual
 * que lo son las remeras.
 */

/** Los packs del negocio, agrupados por producto de pack. */
export async function fetchPacks() {
  const { data } = await http.get("/packs");
  return data;
}

/**
 * Qué SKU va a tener cada pack y qué precio se sugiere, sin crear nada.
 *
 * Existe porque un alta que genera veinte SKU de una vez no se puede revisar
 * después: o se ve antes, o se revisa borrando.
 */
export async function fetchSugerencia({ productId, unidades, sku }) {
  const { data } = await http.get("/packs/sugerencia", {
    params: { productId, unidades, ...(sku ? { sku } : {}) },
  });
  return data;
}

/**
 * Crea el pack entero: el producto, una variante por cada variante del padre y
 * la composición de cada una, en una sola transacción.
 *
 * @param {{productId:number, sku:string, unidades:number, titulo?:string,
 *          precioMinorista?:number, precioMayorista?:number, costo?:number,
 *          variantIds?:number[]}} datos
 */
export async function crearPack(datos) {
  const { data } = await http.post("/packs", datos);
  return data;
}

/** Genera los packs de las variantes que el producto padre ganó después. */
export async function completarPack(productId) {
  const { data } = await http.post(`/packs/${productId}/completar`);
  return data;
}

/** Da de baja el pack entero. No se borra: las ventas viejas lo referencian. */
export async function eliminarPack(productId) {
  const { data } = await http.delete(`/packs/producto/${productId}`);
  return data;
}

/** Da de baja una sola combinación del pack. */
export async function bajaVariantePack(variantId) {
  const { data } = await http.delete(`/packs/${variantId}`);
  return data;
}

/** Un pack: composición, cuántos se arman y en qué locales. */
export async function fetchPack(variantId) {
  const { data } = await http.get(`/packs/${variantId}`);
  return data;
}

/**
 * Cambia la composición de UNA variante de pack. Reemplaza, no suma.
 *
 * @param {Array<{componenteVariantId:number, cantidad:number}>} componentes
 */
export async function guardarPack(variantId, componentes) {
  const { data } = await http.put(`/packs/${variantId}`, { componentes });
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
