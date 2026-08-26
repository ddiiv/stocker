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

/*
 * Las ventas se piden por su NÚMERO de comprobante, no por el id de la base.
 *
 * El número ya es único dentro del negocio y es el que el cliente tiene
 * impreso en el ticket; el id, en cambio, es un contador global de la
 * plataforma y no tiene por qué salir a la URL.
 */
const ref = (venta) => encodeURIComponent(
  typeof venta === 'object' ? venta.numero : venta,
);

export async function getSale(numero) {
  const { data } = await http.get(`/sales/${ref(numero)}`);
  return data;
}

export async function createSale(payload) {
  const { data } = await http.post("/sales", payload);
  return data;
}

export async function updateSaleStatus(numero, estado, medioPago) {
  const { data } = await http.patch(`/sales/${ref(numero)}/estado`, { estado, medioPago });
  return data;
}

/**
 * Cobra una venta que quedó abierta (fiada o pendiente).
 *
 * Va por su propio endpoint y no por el cambio de estado porque acá sí se
 * registra con qué se pagó: el reparto entre medios, sus recargos, y la
 * cancelación de la deuda si la venta era fiada.
 */
export async function cobrarSale(numero, pagos) {
  const { data } = await http.post(`/sales/${ref(numero)}/cobrar`, { pagos });
  return data;
}

/*
 * Pasa la cotización a venta.
 *
 * `locationId` va explícito: la cotización pudo haberse hecho sin local
 * —no descuenta stock, así que no hacía falta— pero la venta necesita saber
 * de dónde sale la mercadería. Sin esto el backend contestaba 400 pidiendo el
 * local y la pantalla no tenía forma de darlo.
 */
export async function convertQuote(numero, locationId) {
  const { data } = await http.post(
    `/sales/cotizacion/${ref(numero)}/convertir`,
    locationId ? { locationId } : {},
  );
  return data;
}

// Descarga el PDF del ticket 80mm y lo abre en una nueva pestaña (para imprimir)
export async function printSaleTicket(sale) {
  const { data } = await http.get(`/sales/${ref(sale)}/ticket`, { responseType: "blob" });
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
export async function anularSale(numero, motivo) {
  const { data } = await http.post(`/sales/${ref(numero)}/anular`, { motivo });
  return data;
}
