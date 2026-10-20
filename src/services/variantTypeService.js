import { http } from "../lib/http";

export async function fetchVariantTypes() {
  const { data } = await http.get("/variant-types");
  return data;
}
export async function createVariantType(payload) {
  const { data } = await http.post("/variant-types", payload);
  return data;
}
export async function updateVariantType(id, payload) {
  const { data } = await http.put(`/variant-types/${id}`, payload);
  return data;
}
export async function deleteVariantType(id) {
  await http.delete(`/variant-types/${id}`);
}

// Las categorías y géneros que se eligen al cargar un producto.
export async function fetchListasProducto() {
  const { data } = await http.get("/catalogo/listas");
  return data;
}
export async function guardarListasProducto(payload) {
  const { data } = await http.put("/catalogo/listas", payload);
  return data;
}
