import { http } from "../lib/http";

export async function fetchBusinessCuits() {
  const { data } = await http.get("/business-cuits");
  return data;
}
export async function createBusinessCuit(payload) {
  const { data } = await http.post("/business-cuits", payload);
  return data;
}
export async function updateBusinessCuit(id, payload) {
  const { data } = await http.put(`/business-cuits/${id}`, payload);
  return data;
}
export async function deleteBusinessCuit(id) {
  await http.delete(`/business-cuits/${id}`);
}
