import { http } from "../lib/http";

export async function fetchPaymentMethods({ soloActivos = false } = {}) {
  const { data } = await http.get("/payment-methods", {
    params: soloActivos ? { activos: "true" } : undefined,
  });
  return data;
}

export async function createPaymentMethod(payload) {
  const { data } = await http.post("/payment-methods", payload);
  return data;
}

export async function updatePaymentMethod(id, payload) {
  const { data } = await http.put(`/payment-methods/${id}`, payload);
  return data;
}

/*
 * El backend desactiva en lugar de borrar cuando el medio ya se usó en alguna
 * venta, y avisa con `desactivado: true`. La pantalla tiene que distinguirlo
 * para no decir "eliminado" cuando en realidad sigue en el historial.
 */
export async function deletePaymentMethod(id) {
  const { data } = await http.delete(`/payment-methods/${id}`);
  return data || { eliminado: true };
}
