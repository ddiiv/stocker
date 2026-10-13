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

/*
 * El logo de la factura de cada CUIT. Viaja aparte del CUIT: el listado sólo
 * dice si hay uno (`tieneLogo`), y la imagen se baja cuando se va a mostrar.
 */
export async function fetchCuitLogo(id) {
  const { data } = await http.get(`/business-cuits/${id}/logo`, { responseType: "blob" });
  return data;
}
export async function uploadCuitLogo(id, file) {
  const formData = new FormData();
  formData.append("logo", file);
  const { data } = await http.put(`/business-cuits/${id}/logo`, formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return data;
}
export async function deleteCuitLogo(id) {
  const { data } = await http.delete(`/business-cuits/${id}/logo`);
  return data;
}
