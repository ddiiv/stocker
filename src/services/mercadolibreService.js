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

/*
 * Qué locales abastecen las ventas online.
 *
 * Es la misma marca que se ve en Empleados → Locales, no una copia: se
 * configura desde acá porque es donde se la mira cuando el número que ML
 * publica no cierra.
 */
/*
 * Traer las ventas anteriores a que se configuraran las notificaciones.
 *
 * El webhook sólo avisa de lo que pasa desde que está tildado: las ventas de
 * antes no llegan nunca por ahí. Es idempotente, así que se puede repetir.
 */
export async function importarPedidosMl(dias) {
  const { data } = await http.post("/mercadolibre/importar-pedidos", { dias });
  return data;
}

export async function getMlLocales() {
  const { data } = await http.get("/mercadolibre/locales");
  return data;
}

export async function setMlLocales(locationIds) {
  const { data } = await http.put("/mercadolibre/locales", { locationIds });
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
