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

/*
 * La lista de precios del puesto, en PDF.
 *
 * Se pide como blob y se abre en una pestaña: es un papel para imprimir, y
 * mandarlo directo a la impresora desde acá le sacaría a la persona la
 * posibilidad de mirarlo antes de gastar diez hojas.
 *
 * Si algún código quedó con barras demasiado finas para imprimirse bien, el
 * servidor lo avisa en una cabecera. Se devuelve junto al PDF para que la
 * pantalla lo muestre: enterarse en el puesto, con el lector fallando y gente
 * esperando, es tarde.
 */
export async function descargarListaPrecios() {
  const r = await http.get("/feria/lista-precios", { responseType: "blob" });
  const aviso = r.headers?.["x-aviso"] ? decodeURIComponent(r.headers["x-aviso"]) : null;
  const filas = Number(r.headers?.["x-filas"] || 0);

  const url = window.URL.createObjectURL(new Blob([r.data], { type: "application/pdf" }));
  const ventana = window.open(url, "_blank");
  if (!ventana) {
    // El navegador bloqueó la pestaña: se descarga, que es la otra forma de
    // que el papel llegue a la impresora.
    const a = document.createElement("a");
    a.href = url;
    a.download = "lista-precios-evento.pdf";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  // Se libera después: revocarla en el acto deja la pestaña recién abierta sin
  // nada que mostrar.
  setTimeout(() => window.URL.revokeObjectURL(url), 5000);

  return { aviso, filas };
}

/*
 * Carga un producto de evento a mano.
 *
 * Para la mercadería que sólo se vende en eventos y nunca estuvo en el
 * catálogo normal. El servidor le pone el prefijo al código, igual que a los
 * generados: así todos los de evento empiezan igual.
 */
export async function crearProductoDeEvento(datos) {
  const { data } = await http.post("/feria/productos", datos);
  return data;
}

export async function fetchProductosFeria() {
  const { data } = await http.get("/feria/productos");
  return data;
}
