import { http } from "../lib/http";

export async function getArcaConfig(cuitId) {
  const { data } = await http.get(`/arca/cuits/${cuitId}/config`);
  return data;
}
export async function saveArcaConfig(cuitId, payload) {
  const { data } = await http.put(`/arca/cuits/${cuitId}/config`, payload);
  return data;
}
export async function verifyArcaDelegation(cuitId) {
  const { data } = await http.post(`/arca/cuits/${cuitId}/verify`);
  return data;
}
export async function getArcaStatus(ambiente = "homologacion") {
  const { data } = await http.get("/arca/status", { params: { ambiente } });
  return data;
}
