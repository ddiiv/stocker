import { http } from "../lib/http";

/*
 * Plataformas: el estado de cada conexión del negocio y los pedidos de
 * cotización de un desarrollo a medida.
 *
 * El estado no trae ningún token (ni de las credenciales de máquina, ni de
 * Mercado Libre, ni de Jumpseller): sólo si está conectada, desde cuándo y
 * cuándo se usó por última vez.
 */

export async function fetchPlataformas() {
  const { data } = await http.get("/plataformas");
  return data;
}

export async function fetchCotizaciones() {
  const { data } = await http.get("/plataformas/cotizaciones");
  return data.cotizaciones || [];
}

/**
 * Pide la cotización. El negocio sale de la sesión: acá viaja sólo lo que la
 * persona escribió. Devuelve { cotizacion, whatsapp, mensaje }.
 */
export async function pedirCotizacion({ tipo, detalle, contactoNombre, contactoEmail, contactoTelefono }) {
  const { data } = await http.post("/plataformas/cotizaciones", {
    tipo, detalle, contactoNombre, contactoEmail, contactoTelefono,
  });
  return data;
}
