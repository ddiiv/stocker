import { http } from "../lib/http";

export async function getMlStatus() {
  const { data } = await http.get("/mercadolibre/status");
  return data;
}

export async function getMlAuthUrl() {
  const { data } = await http.get("/mercadolibre/auth-url");
  return data.url;
}

export async function disconnectMl() {
  return http.delete("/mercadolibre/disconnect");
}

/** Simula la sincronización: devuelve qué cambiaría sin tocar ML. */
export async function previewMlSync() {
  const { data } = await http.get("/mercadolibre/preview");
  return data;
}

/** Sincroniza de verdad. Si se pasan SKUs, solo esos. */
export async function runMlSync(skus) {
  const { data } = await http.post("/mercadolibre/sync", skus?.length ? { skus } : {});
  return data;
}

export async function getMlLinks() {
  const { data } = await http.get("/mercadolibre/links");
  return data;
}

export async function saveMlLink(payload) {
  const { data } = await http.post("/mercadolibre/links", payload);
  return data;
}

export async function deleteMlLink(id) {
  return http.delete(`/mercadolibre/links/${id}`);
}
