import { http } from "../lib/http";

export async function fetchProductGroups({ search = "" } = {}) {
  const params = { limit: 200 };
  if (search) params.search = search;
  const { data } = await http.get("/products", { params });
  return groupBySkuAgrupador(data.data || []);
}

export async function getProductGroup(skuAgrupador) {
  const { data } = await http.get("/products", { params: { search: skuAgrupador, limit: 100 } });
  const variants = (data.data || []).filter((p) => p.skuAgrupador === skuAgrupador);
  if (!variants.length) return null;
  const groups = groupBySkuAgrupador(variants);
  return groups[0] || null;
}

/*
 * Un precio propio se distingue del heredado por no ser nulo, no por ser mayor
 * a cero: una variante de muestra puede valer 0 y eso es una decisión.
 */
const heredado = (propio, delPadre) =>
  Number(propio !== null && propio !== undefined && propio !== "" ? propio : delPadre) || 0;

function groupBySkuAgrupador(products) {
  const map = new Map();
  for (const p of products) {
    const key = p.skuAgrupador || p.sku;
    if (!map.has(key)) {
      map.set(key, {
        skuAgrupador: key,
        title: p.titulo,
        modelo: p.modelo,
        // La descripción viaja porque el formulario de edición la precarga: sin
        // ella el campo arrancaría vacío y guardar borraría la que había.
        descripcion: p.descripcion,
        categoria: p.categoria,
        genero: p.genero,
        variants: [],
      });
    }
    const group = map.get(key);
    // Flatten variantes from ProductVariants (nested)
    // la asociación se llama productVariants en el backend (variantes es el campo JSON del padre)
    const vars = p.productVariants || [];
    vars.forEach((v) => group.variants.push({
      id: v.id, productId: p.id,
      sku: v.sku,
      talle: v.variante2Valor || v.variante1Valor,
      color: v.variante1Valor,
      variante1Nombre: v.variante1Nombre, variante1Valor: v.variante1Valor,
      variante2Nombre: v.variante2Nombre, variante2Valor: v.variante2Valor,
      stock: v.stock, stockMinimo: v.stockMinimo,
      /*
       * El precio de la variante si lo tiene; si no, el del producto.
       *
       * Nulo significa "hereda", no "cero": la mayoría de las variantes
       * comparte el precio del padre y tiene que seguir el cambio cuando ese
       * precio se toca. Sólo las que llevan un número propio se apartan.
       */
      costo:           heredado(v.costo, p.costo),
      precio:          heredado(v.precioMinorista, p.precioMinorista),
      precioMayorista: heredado(v.precioMayorista, p.precioMayorista),
      // Los valores crudos, para que la edición sepa cuál es propio y cuál no.
      precioPropio: {
        costo: v.costo, precioMinorista: v.precioMinorista, precioMayorista: v.precioMayorista,
      },
      // Y los del padre, para poder mostrar de qué se está apartando.
      precioPadre: {
        costo: Number(p.costo), precioMinorista: Number(p.precioMinorista), precioMayorista: Number(p.precioMayorista),
      },
    }));
  }
  return Array.from(map.values()).map((g) => {
    const stockTotal = g.variants.reduce((s, v) => s + v.stock, 0);
    const precios = g.variants.map((v) => v.precio).filter(Boolean);
    return {
      ...g,
      stockTotal,
      precioDesde: precios.length ? Math.min(...precios) : 0,
      precioHasta: precios.length ? Math.max(...precios) : 0,
      colores: [...new Set(g.variants.map((v) => v.color).filter(Boolean))],
      talles:  [...new Set(g.variants.map((v) => v.talle).filter(Boolean))],
    };
  });
}

export async function adjustVariantStock(variantId, payload) {
  const { data } = await http.patch(`/products/variants/${variantId}/stock`, payload);
  return data;
}

export async function createVariant(productId, payload) {
  const { data } = await http.post(`/products/${productId}/variants`, payload);
  return data;
}

export async function updateVariant(variantId, payload) {
  const { data } = await http.put(`/products/variants/${variantId}`, payload);
  return data;
}

export async function createProduct(payload) {
  const { data } = await http.post("/products", payload);
  return data;
}

export async function updateProduct(id, payload) {
  const { data } = await http.put(`/products/${id}`, payload);
  return data;
}

export async function deleteVariant(variantId) {
  return http.delete(`/products/variants/${variantId}`);
}

export async function deleteProduct(id) {
  await http.delete(`/products/${id}`);
}

export function getStockFor() { return { costo: 0, precio: 0, stock: 0, stockMinimo: 5 }; }

export async function exportProductsExcel() {
  const { data } = await http.get("/products/export", { responseType: "blob" });
  const url = window.URL.createObjectURL(new Blob([data]));
  const a = document.createElement("a");
  a.href = url;
  a.download = "productos.xlsx";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

export async function importProductsExcel(file) {
  const formData = new FormData();
  formData.append("file", file);
  const { data } = await http.post("/products/import", formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return data;
}

/** Identifica un producto por el código que devuelve el lector de barras. */
export async function scanProduct(codigo) {
  const { data } = await http.get(`/products/scan/${encodeURIComponent(codigo)}`);
  return data;
}

/**
 * Modifica el stock de un producto escaneado.
 * @param {string} codigo  Lo que devolvió el lector
 * @param {"agregar"|"quitar"|"fijar"} modo
 * @param {number} cantidad
 */
export async function scanAdjustStock({ codigo, modo = "agregar", cantidad = 1, motivo }) {
  const { data } = await http.post("/products/scan/stock", { codigo, modo, cantidad, motivo });
  return data;
}

/*
 * Libro de movimientos de stock del negocio.
 *
 * Los parámetros vacíos no se mandan: un `tipo=` suelto en la URL es ruido en
 * los logs del servidor y hace que dos consultas idénticas se vean distintas.
 */
export async function fetchStockMovements(filtros = {}) {
  const params = {};
  for (const [k, v] of Object.entries(filtros)) {
    if (v !== "" && v !== null && v !== undefined) params[k] = v;
  }
  const { data } = await http.get("/stock/movimientos", { params });
  return data;
}

/*
 * PDF de etiquetas.
 *
 * Llega como blob y se descarga en el navegador. Los errores del backend vienen
 * en JSON aunque el pedido esperaba un PDF —por ejemplo cuando un SKU no entra
 * legible en la etiqueta—, así que hay que leer el blob para poder mostrarlos:
 * sin esto el usuario vería "error" y nunca sabría cuál es el SKU problemático.
 */
export async function generarEtiquetas(items) {
  try {
    const { data } = await http.post("/products/etiquetas", { items }, { responseType: "blob" });
    return data;
  } catch (e) {
    const cuerpo = e.response?.data;
    if (cuerpo instanceof Blob && cuerpo.type.includes("json")) {
      const texto = await cuerpo.text();
      try {
        const json = JSON.parse(texto);
        const err = new Error(json.message || "No se pudieron generar las etiquetas.");
        err.codigos = json.codigos;
        throw err;
      } catch (parseo) {
        if (parseo instanceof Error && parseo.message !== "Unexpected end of JSON input") throw parseo;
      }
    }
    throw e;
  }
}

/*
 * Stock desglosado por local, con el total.
 *
 * Una sola llamada devuelve las tres cosas —cuánto en cada local, dónde está
 * cada cosa y el total— porque separarlas obligaría a sumar del lado del
 * navegador y a que dos pantallas puedan discrepar.
 */
export async function fetchStockPorLocal(filtros = {}) {
  const params = {};
  for (const [k, v] of Object.entries(filtros)) {
    if (v !== "" && v !== null && v !== undefined && v !== false) params[k] = v;
  }
  const { data } = await http.get("/stock/por-local", { params });
  return data;
}

export async function transferirStock(payload) {
  const { data } = await http.post("/stock/transferir", payload);
  return data;
}

/*
 * Los dos niveles de la vista por local: primero productos, después variantes.
 *
 * Separados porque un catálogo de 20 productos con 20 variantes son 400 filas,
 * y la pregunta "¿qué tengo en Belgrano?" no se responde recorriendo 400 filas.
 */
export async function fetchProductosPorLocal({ locationId, q } = {}) {
  const params = {};
  if (locationId) params.locationId = locationId;
  if (q) params.q = q;
  const { data } = await http.get("/stock/por-local/productos", { params });
  return data;
}

export async function fetchVariantesPorLocal(productId) {
  const { data } = await http.get(`/stock/por-local/producto/${productId}`);
  return data;
}

/*
 * Ajuste de stock de varias variantes en un solo pedido.
 *
 * Es lo que hace posible cargar un remito sin esperar una llamada por línea.
 * El backend lo aplica todo junto o nada: no puede quedar medio remito cargado.
 */
export async function ajusteMasivoStock({ locationId, motivo, items }) {
  const { data } = await http.post("/stock/ajuste-masivo", { locationId, motivo, items });
  return data;
}

/** Lo que entró en un día, por variante. Para etiquetar mercadería recibida. */
export async function fetchIngresosDelDia({ fecha, locationId } = {}) {
  const params = {};
  if (fecha) params.fecha = fecha;
  if (locationId) params.locationId = locationId;
  const { data } = await http.get("/stock/ingresos", { params });
  return data;
}
