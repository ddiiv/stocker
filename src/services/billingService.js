import { http } from "../lib/http";

/*
 * Qué funciones existen, con su nombre.
 *
 * Se pide en vez de tenerlas escritas en la pantalla: la misma lista vivía a
 * mano acá, en el backoffice y en la landing, y las tres se desincronizaron
 * cuando entraron Eventos, Depósito y Reposición.
 */
export async function fetchFeatures() {
  const { data } = await http.get("/billing/features");
  return data;
}

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
 * Cuánto se cobra un plan y por qué, antes de pagar: el plan entero o, al
 * subir con un período pago corriendo, sólo la diferencia por los días que
 * quedan; cuándo rige; qué pasa con el débito automático; y, al bajar, cuánto
 * se pasa de cada tope y quiénes pueden seguir. Es la misma cuenta que cobra
 * el checkout: el modal no calcula precios por su lado.
 */
export async function fetchCotizacion(plan) {
  const { data } = await http.get("/billing/cotizacion", { params: { plan } });
  return data;
}

/**
 * Genera el link de pago y devuelve a dónde mandar al cliente.
 * @param {"unico"|"recurrente"} modo  un pago suelto, o débito automático
 * @param {number[]} [conservar]  al bajar con empleados de más, los que siguen
 */
export async function crearCheckout({ plan, modo = "unico", conservar } = {}) {
  const { data } = await http.post("/billing/checkout", { plan, modo, conservar });
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
