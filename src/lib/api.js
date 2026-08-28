import { http } from "./http";

/* Toda la superficie del backoffice, en un solo lugar. */

// ── Sesión ───────────────────────────────────────────────────────
export const login = (payload) => http.post("/backoffice/login", payload).then((r) => r.data);
export const logout = () => http.post("/backoffice/logout").then((r) => r.data);
export const yo = () => http.get("/backoffice/me").then((r) => r.data);
export const activarTotp = (payload) => http.post("/backoffice/totp/activar", payload).then((r) => r.data);

// ── Panel ────────────────────────────────────────────────────────
export const getResumen = () => http.get("/backoffice/resumen").then((r) => r.data);

// ── Cuentas ──────────────────────────────────────────────────────
export const getCuentas = (params) => http.get("/backoffice/cuentas", { params }).then((r) => r.data);
export const getCuenta = (id) => http.get(`/backoffice/cuentas/${id}`).then((r) => r.data);
export const editarSuscripcion = (id, payload) =>
  http.put(`/backoffice/cuentas/${id}/suscripcion`, payload).then((r) => r.data);

// ── Cobros ───────────────────────────────────────────────────────
export const aprobarPago = (id) => http.post(`/backoffice/pagos/${id}/aprobar`).then((r) => r.data);
export const rechazarPago = (id, motivo) =>
  http.post(`/backoffice/pagos/${id}/rechazar`, { motivo }).then((r) => r.data);

// ── Planes ───────────────────────────────────────────────────────
export const getPlanes = () => http.get("/backoffice/planes").then((r) => r.data);
/* Qué funciones existen, con su nombre y para qué sirve cada una. Se pide en
   vez de tenerlas escritas acá: la lista local se quedó en nueve de doce. */
export const getCatalogoFeatures = () =>
  http.get("/backoffice/planes/catalogo").then((r) => r.data);
export const editarPlan = (codigo, payload) =>
  http.put(`/backoffice/planes/${codigo}`, payload).then((r) => r.data);

// ── Cobro (Mercado Pago) ─────────────────────────────────────────
/* Estado de la pasarela. No devuelve el token ni el secreto, sólo si andan. */
export const getMercadoPago = () => http.get("/backoffice/mercadopago").then((r) => r.data);

// ── Seguridad ────────────────────────────────────────────────────
/* Estado de las defensas de borde. No devuelve IPs ni secretos. */
export const getSeguridad = () => http.get("/backoffice/seguridad").then((r) => r.data);

// ── Página pública ───────────────────────────────────────────────
export const getAjustes = () => http.get("/backoffice/ajustes").then((r) => r.data);
/*
 * Lo mismo que lee la página pública, con los valores por defecto ya
 * resueltos. La vista previa consulta esto y no los ajustes guardados: un
 * campo vacío no significa que el visitante vea vacío, significa que ve el
 * valor por defecto, y mostrarle "—" al operador lo llevaría a "cargar" algo
 * que ya estaba bien.
 */
export const getVistaPublica = () => http.get("/public/landing").then((r) => r.data);
export const editarAjustes = (payload) => http.put("/backoffice/ajustes", payload).then((r) => r.data);
