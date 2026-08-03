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

function groupBySkuAgrupador(products) {
  const map = new Map();
  for (const p of products) {
    const key = p.skuAgrupador || p.sku;
    if (!map.has(key)) {
      map.set(key, {
        skuAgrupador: key,
        title: p.titulo,
        modelo: p.modelo,
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
      costo: Number(p.costo),
      precio: Number(p.precioMinorista),
      precioMayorista: Number(p.precioMayorista),
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
