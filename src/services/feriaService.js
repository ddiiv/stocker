import { http } from "../lib/http";

/*
 * Catálogo de evento.
 *
 * Vender en un evento usa el punto de venta de siempre: se escanea el código y
 * listo. Lo que vive acá es el trabajo de preparar ese catálogo una vez.
 *
 * OJO con el nombre: en la interfaz esto se llama EVENTO, pero adentro —acá,
 * en la API y en la base— sigue diciendo `feria`. Se renombró lo que ve el
 * cliente y no lo que está guardado, porque los locales existentes tienen
 * `tipo = "feria"` grabado y migrarlo no le cambia nada a nadie.
 */

/** Los padres del catálogo normal, marcando cuáles ya tienen versión de evento. */
export async function fetchCandidatos(prefijo) {
  const { data } = await http.get("/feria/candidatos", { params: prefijo ? { prefijo } : {} });
  return data;
}

/**
 * Genera la versión de evento de un lote de productos.
 *
 * `precio` decide con qué precio nacen: igual al minorista o al mayorista, o un
 * porcentaje sobre alguno. Cargar cincuenta precios a mano antes de la primera
 * venta no es una opción; después cada uno se edita como cualquier producto.
 */
export async function generarFeria({ productIds, prefijo, precio }) {
  const { data } = await http.post("/feria/generar", { productIds, prefijo, precio });
  return data;
}

/*
 * Recalcula los precios de productos de evento YA generados.
 *
 * Generar es idempotente —si no, un segundo lote duplicaría el catálogo— así
 * que sin esto, cambiar de lista de precios obligaba a borrar todo y volver a
 * generar. La base sigue siendo el producto original.
 */
export async function reaplicarPrecios({ productIds, precio }) {
  const { data } = await http.post("/feria/precios", { productIds, precio });
  return data;
}

export async function fetchProductosFeria() {
  const { data } = await http.get("/feria/productos");
  return data;
}
