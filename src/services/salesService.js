import { http } from "../lib/http";

export async function fetchSales({ tipo, estado } = {}) {
  const params = { limit: 100 };
  if (tipo)   params.tipo   = tipo;
  if (estado) params.estado = estado;
  const { data } = await http.get("/sales", { params });
  return data.data || [];
}

export async function getSale(id) {
  const { data } = await http.get(`/sales/${id}`);
  return data;
}

export async function createSale(payload) {
  const { data } = await http.post("/sales", payload);
  return data;
}

export async function updateSaleStatus(id, estado, medioPago) {
  const { data } = await http.patch(`/sales/${id}/estado`, { estado, medioPago });
  return data;
}

/**
 * Cobra una venta que quedó abierta (fiada o pendiente).
 *
 * Va por su propio endpoint y no por el cambio de estado porque acá sí se
 * registra con qué se pagó: el reparto entre medios, sus recargos, y la
 * cancelación de la deuda si la venta era fiada.
 */
export async function cobrarSale(id, pagos) {
  const { data } = await http.post(`/sales/${id}/cobrar`, { pagos });
  return data;
}

export async function convertQuote(id) {
  const { data } = await http.post(`/sales/cotizacion/${id}/convertir`);
  return data;
}

// Descarga el PDF del ticket 80mm y lo abre en una nueva pestaña (para imprimir)
export async function printSaleTicket(sale) {
  const { data } = await http.get(`/sales/${sale.id}/ticket`, { responseType: "blob" });
  const url = window.URL.createObjectURL(new Blob([data], { type: "application/pdf" }));
  const win = window.open(url, "_blank");
  // Si el navegador bloquea popups, forzamos descarga
  if (!win) {
    const a = document.createElement("a");
    a.href = url;
    a.download = `ticket-${sale.numero.replace(/\//g, "-")}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  setTimeout(() => window.URL.revokeObjectURL(url), 5000);
}
