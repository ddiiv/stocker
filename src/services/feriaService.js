import { http } from "../lib/http";

/*
 * Catálogo de feria.
 *
 * Vender en la feria usa el punto de venta de siempre: se escanea el código y
 * listo. Lo que vive acá es el trabajo de preparar ese catálogo una vez.
 */

/** Los padres del catálogo normal, marcando cuáles ya tienen versión de feria. */
export async function fetchCandidatos(prefijo) {
  const { data } = await http.get("/feria/candidatos", { params: prefijo ? { prefijo } : {} });
  return data;
}

/**
 * Genera la versión de feria de un lote de productos.
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
 * Recalcula los precios de productos de feria YA generados.
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
