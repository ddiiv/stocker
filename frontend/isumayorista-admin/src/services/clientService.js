import { http } from "../lib/http";

export async function fetchClients(search) {
  const params = search ? { search } : {};
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
