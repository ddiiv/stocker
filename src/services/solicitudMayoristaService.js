import { http } from "../lib/http";

/*
 * Pedidos mayoristas que llegan de afuera y esperan que alguien los mire.
 *
 * Hoy los manda ISUWAYA, el portal donde el cliente arma el pedido. Acá no son
 * ventas todavía: son solicitudes. La venta nace cuando una persona acepta,
 * con su local, su caja y su decisión de cobrar o fiar.
 */

export async function fetchSolicitudes({ estado = "pendiente", limite = 100 } = {}) {
  const { data } = await http.get("/solicitudes-mayoristas", { params: { estado: estado || undefined, limite } });
  return { pendientes: data.pendientes || 0, solicitudes: data.solicitudes || [] };
}

export async function fetchSolicitud(id) {
  const { data } = await http.get(`/solicitudes-mayoristas/${id}`);
  return data;
}

/**
 * Acepta el pedido y crea la venta.
 *
 * Los artículos no viajan: salen de la solicitud del lado del servidor.
 * Acá va cómo se registra —local, cliente, contado o cuenta corriente— y,
 * cuando ya se vio qué faltaba, el permiso para dar de alta esas unidades.
 */
export async function aceptarSolicitud(id, cuerpo) {
  const { data } = await http.post(`/solicitudes-mayoristas/${id}/aceptar`, cuerpo);
  return data;
}

export async function rechazarSolicitud(id, motivo) {
  const { data } = await http.post(`/solicitudes-mayoristas/${id}/rechazar`, { motivo });
  return data;
}
