import { http } from "../lib/http";

/**
 * Listado de ventas con filtros.
 *
 * Devuelve el objeto completo y no sólo el array: `resumen` trae los totales de
 * TODO el filtro, que es el dato que se busca al filtrar. Sumar las filas
 * visibles daría el total de la página, no del mes.
 *
 * @param {object} f
 * @param {string} [f.medioPago] id de un medio, "combinado" o "fiado"
 * @param {string} [f.desde] y [f.hasta] en formato YYYY-MM-DD
 */
export async function fetchSales({ tipo, estado, medioPago, desde, hasta, limit = 100 } = {}) {
  const params = { limit };
  if (tipo)       params.tipo       = tipo;
  if (estado)     params.estado     = estado;
  if (medioPago)  params.medioPago  = medioPago;
  if (desde)      params.desde      = desde;
  if (hasta)      params.hasta      = hasta;
  const { data } = await http.get("/sales", { params });
  return {
    ventas: data.data || [],
    resumen: data.resumen || { cantidad: 0, cobradas: 0, totalCobrado: 0, totalNeto: 0 },
  };
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

/*
 * Anula una venta: devuelve el stock al local del que salió, cancela la deuda
 * si estaba fiada y deja de contarla como cobrada.
 *
 * Exige motivo. No es burocracia: es lo que después explica un ingreso de
 * stock que nadie recuerda haber hecho.
 */
export async function anularSale(id, motivo) {
  const { data } = await http.post(`/sales/${id}/anular`, { motivo });
  return data;
}
