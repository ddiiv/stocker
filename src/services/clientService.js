import { http } from "../lib/http";

export async function fetchClients(search, { limit } = {}) {
  const params = {};
  if (search) params.search = search;
  /*
   * `limit` lo usan las pantallas de venta, que necesitan un buscador y no el
   * padrón entero. La de Clientes lo omite: ahí sí hay que verlo completo.
   */
  if (limit) params.limit = limit;
  const { data } = await http.get("/clients", { params });
  return data;
}

export async function createClient(payload) {
  const { data } = await http.post("/clients", payload);
  return data;
}

export async function updateClient(id, payload) {
  const { data } = await http.put(`/clients/${id}`, payload);
  return data;
}

export async function deleteClient(id) {
  await http.delete(`/clients/${id}`);
}

export async function lookupCuit(cuit) {
  const clean = String(cuit || "").replace(/[^0-9]/g, "");
  if (clean.length !== 11) return null;
  try {
    const { data } = await http.get(`/arca/cuit/${clean}`);
    return data;
  } catch (err) {
    if (err.response?.status === 400) return err.response.data; // CUIT inválido con detalle
    return null;
  }
}

// ─── Cuenta corriente ────────────────────────────────────────────
export async function fetchCuentas(soloDeudores = true) {
  const { data } = await http.get("/clients/cuentas", { params: { soloDeudores } });
  return data;
}

export async function fetchCuenta(clientId) {
  const { data } = await http.get(`/clients/${clientId}/cuenta`);
  return data;
}

export async function updateCuentaConfig(clientId, payload) {
  const { data } = await http.put(`/clients/${clientId}/cuenta`, payload);
  return data;
}

export async function registrarPagoCuenta(clientId, payload) {
  const { data } = await http.post(`/clients/${clientId}/cuenta/pagos`, payload);
  return data;
}
