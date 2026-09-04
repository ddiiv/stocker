import { http } from "../lib/http";

/* ── Envíos del Día ─────────────────────────────────────────────
 *
 * La jornada del depósito: qué sale hoy, qué hay que bajar del estante, y el
 * despacho — que es el único momento en que la mercadería de un pedido online
 * baja de verdad del inventario.
 */

/**
 * @param {object} filtros
 * @param {string} [filtros.fecha]              qué día. Por defecto hoy.
 * @param {number} [filtros.locationId]         sólo lo que sale de este local.
 * @param {string} [filtros.envioTipo]          'flex' para ver sólo los que tienen corte.
 * @param {number} [filtros.diasAdelante]      0 = sólo hoy; 7 = la semana que viene.
 * @param {string} [filtros.filtro]             para_enviar | en_camino | entregado |
 *                                              cancelado | con_faltante | todos
 */
export async function fetchJornada(filtros = {}) {
  const params = {};
  if (filtros.fecha) params.fecha = filtros.fecha;
  if (filtros.locationId) params.locationId = filtros.locationId;
  if (filtros.envioTipo) params.envioTipo = filtros.envioTipo;
  if (filtros.diasAdelante) params.diasAdelante = filtros.diasAdelante;
  if (filtros.filtro) params.filtro = filtros.filtro;
  const { data } = await http.get("/envios/del-dia", { params });
  return data;
}

/**
 * El PDF de la jornada, para imprimir.
 *
 * Se pide como blob y se abre en una pestaña: bajarlo al disco obliga a
 * buscarlo en Descargas y abrirlo a mano, y esto se imprime en el momento.
 */
export async function abrirPdfJornada(filtros = {}) {
  const params = {};
  if (filtros.fecha) params.fecha = filtros.fecha;
  if (filtros.locationId) params.locationId = filtros.locationId;
  if (filtros.envioTipo) params.envioTipo = filtros.envioTipo;
  if (filtros.diasAdelante) params.diasAdelante = filtros.diasAdelante;
  if (filtros.filtro) params.filtro = filtros.filtro;

  const { data } = await http.get("/envios/del-dia/pdf", { params, responseType: "blob" });
  const url = URL.createObjectURL(data);
  window.open(url, "_blank", "noopener");
  /*
   * Se libera después de que el navegador lo abrió. Revocarlo enseguida deja
   * la pestaña con un visor vacío; un minuto alcanza y no acumula memoria.
   */
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** El paquete salió: la reserva se convierte en egreso. */
export async function despacharPaquete(id) {
  const { data } = await http.post(`/envios/${id}/despachar`);
  return data;
}

/**
 * Vuelve a intentar las líneas de un pedido cuyo SKU no existía cuando entró.
 *
 * El caso típico: la venta llegó de Mercado Libre con el SKU de un pack que se
 * armó después. La línea quedó apuntando a nada y no apartó mercadería, así que
 * despachar el paquete no descontaría una sola prenda.
 */
export async function reprocesarPedido(id) {
  const { data } = await http.post(`/online/pedidos/${id}/reprocesar`);
  return data;
}

/** No se encontró la mercadería. No toca el stock: ver el servicio. */
export async function marcarFaltante(id, nota) {
  const { data } = await http.post(`/envios/${id}/faltante`, { nota });
  return data;
}
