import { http } from "../lib/http";

/** Catálogo de planes. Público: lo necesita quien está en modo lectura. */
export async function fetchPlanes() {
  const { data } = await http.get("/billing/planes");
  return data;
}

/** Estado de la suscripción del negocio: plan, vencimiento, uso y topes. */
export async function fetchSuscripcion() {
  const { data } = await http.get("/billing/suscripcion");
  return data;
}

export async function fetchPagos() {
  const { data } = await http.get("/billing/pagos");
  return data;
}

/**
 * Genera el link de pago y devuelve a dónde mandar al cliente.
 * @param {"unico"|"recurrente"} modo  un mes suelto, o débito automático
 */
export async function crearCheckout({ plan, modo = "unico" } = {}) {
  const { data } = await http.post("/billing/checkout", { plan, modo });
  return data;
}

export async function fetchDatosTransferencia() {
  const { data } = await http.get("/billing/transferencia");
  return data;
}

/** Avisa que se transfirió. Queda pendiente hasta que alguien lo verifique. */
export async function informarTransferencia(payload) {
  const { data } = await http.post("/billing/transferencia", payload);
  return data;
}

/**
 * "Ya pagué": le pregunta a Mercado Pago y acredita lo aprobado.
 *
 * Es lo que hace que el cobro no dependa de que el webhook haya llegado. En
 * desarrollo es el único camino, porque Mercado Pago no puede avisar a
 * localhost.
 */
export async function verificarPagos() {
  const { data } = await http.post("/billing/verificar");
  return data;
}

/** Prende o apaga la renovación automática. Apagarla no corta el servicio. */
export async function cambiarRenovacion(activa) {
  const { data } = await http.post("/billing/renovacion", { activa });
  return data;
}

export async function solicitarBaja(motivo) {
  const { data } = await http.post("/billing/baja", { motivo });
  return data;
}

export async function cancelarBaja() {
  const { data } = await http.delete("/billing/baja");
  return data;
}

/** Descarga el comprobante del pago y lo abre para imprimir o guardar. */
export async function descargarRecibo(pago) {
  const { data } = await http.get(`/billing/pagos/${pago.id}/recibo`, { responseType: "blob" });
  const url = window.URL.createObjectURL(new Blob([data], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `recibo-stocker-${pago.id}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => window.URL.revokeObjectURL(url), 5000);
}
