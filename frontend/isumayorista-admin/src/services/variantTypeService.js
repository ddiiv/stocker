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
