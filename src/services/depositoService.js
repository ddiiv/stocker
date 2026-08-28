import { http } from "../lib/http";

/* ── Depósito: ingreso de mercadería ───────────────────────────── */

export async function fetchLugares() {
  const { data } = await http.get("/deposito/lugares");
  return data; // { depositos: [], locales: [] }
}

export async function fetchIngresos(filtros = {}) {
  const params = {};
  for (const [k, v] of Object.entries(filtros)) {
    if (v !== "" && v !== null && v !== undefined) params[k] = v;
  }
  const { data } = await http.get("/deposito/ingresos", { params });
  return data;
}

/**
 * Registra un ingreso.
 * @param {"etiquetas"|"conteo"} origen  etiquetas sube el stock ya; conteo espera firma.
 */
/*
 * `payload` acepta `items` (líneas) y, todavía, `curvas`.
 *
 * La pantalla ya no manda `curvas`: expande la serie a líneas antes de mandar,
 * usando los valores que devolvió el servidor, para que todo lo que se va a
 * ingresar se vea en una sola lista. El campo se mantiene en la API porque
 * sigue siendo la forma corta para integraciones.
 */
export async function crearIngreso(payload) {
  const { data } = await http.post("/deposito/ingresos", payload);
  return data;
}

/*
 * Qué abre una serie de ese producto fijando ese valor.
 *
 * Se consulta antes de cargar para poder mostrar lo que entra: sin esto, "20
 * series" es un número que no dice cuántas unidades son.
 *
 * `eje` dice cuál de las dos variantes se fija: 'variante1' o 'variante2'. Es
 * lo que separa "20 series de color Negro" de "20 series de talle M".
 */
export async function fetchSerie({ productId, valor, eje }) {
  const { data } = await http.get("/deposito/curva", { params: { productId, valor, eje } });
  return data;
}

export async function aceptarIngreso(id) {
  const { data } = await http.post(`/deposito/ingresos/${id}/aceptar`);
  return data;
}

export async function rechazarIngreso(id, motivo) {
  const { data } = await http.post(`/deposito/ingresos/${id}/rechazar`, { motivo });
  return data;
}

export async function anularIngreso(id, motivo) {
  const { data } = await http.post(`/deposito/ingresos/${id}/anular`, { motivo });
  return data;
}

/*
 * Etiquetas del ingreso, una por unidad.
 *
 * Llega como blob. Los errores vienen en JSON aunque el pedido esperaba un PDF
 * —por ejemplo cuando un SKU no entra legible—, así que hay que leer el blob
 * para poder mostrarlos en vez de un "error" sin causa.
 */
export async function etiquetasDeIngreso(id) {
  try {
    const { data } = await http.post(`/deposito/ingresos/${id}/etiquetas`, {}, { responseType: "blob" });
    return data;
  } catch (e) {
    const cuerpo = e.response?.data;
    if (cuerpo instanceof Blob && cuerpo.type.includes("json")) {
      const json = JSON.parse(await cuerpo.text());
      throw new Error(json.message || "No se pudieron generar las etiquetas.");
    }
    throw e;
  }
}

/* ── Reposición ────────────────────────────────────────────────── */

export async function fetchPedidos(filtros = {}) {
  const params = {};
  for (const [k, v] of Object.entries(filtros)) {
    if (v !== "" && v !== null && v !== undefined) params[k] = v;
  }
  const { data } = await http.get("/reposicion/pedidos", { params });
  return data;
}

export async function fetchPedido(id) {
  const { data } = await http.get(`/reposicion/pedidos/${id}`);
  return data;
}

export async function crearPedido(payload) {
  const { data } = await http.post("/reposicion/pedidos", payload);
  return data;
}

export async function aprobarPedido(id) {
  const { data } = await http.post(`/reposicion/pedidos/${id}/aprobar`);
  return data;
}

export async function rechazarPedido(id, motivo) {
  const { data } = await http.post(`/reposicion/pedidos/${id}/rechazar`, { motivo });
  return data;
}

export async function cancelarPedido(id, motivo) {
  const { data } = await http.post(`/reposicion/pedidos/${id}/cancelar`, { motivo });
  return data;
}

/** envios: [{ itemId, cantidad }] */
export async function despacharPedido(id, envios) {
  const { data } = await http.post(`/reposicion/pedidos/${id}/despachar`, { envios });
  return data;
}

/** recepciones: [{ itemId, cantidad, notaFaltante }] */
export async function recibirPedido(id, recepciones, nota) {
  const { data } = await http.post(`/reposicion/pedidos/${id}/recibir`, { recepciones, nota });
  return data;
}

export async function fetchEnTransito(locationId) {
  const { data } = await http.get("/reposicion/en-transito", {
    params: locationId ? { locationId } : undefined,
  });
  return data.data || [];
}

/** Contadores de las tres bandejas, para los avisos del menú. */
export async function fetchPendientes() {
  const { data } = await http.get("/reposicion/pendientes");
  return data;
}

/*
 * Qué hay en el depósito de lo que un pedido pide, línea por línea.
 *
 * Es el número que miran los dos lados —oficina para aprobar y el depósito
 * para armar—, y por eso sale del mismo lugar: es lo que evita el "yo aprobé
 * diez" contra "acá había tres".
 */
export async function fetchDisponibilidad(pedidoId) {
  const { data } = await http.get(`/reposicion/pedidos/${pedidoId}/disponibilidad`);
  return data;
}


/*
 * Carga mercadería que estaba en el estante sin registrar, para completar un
 * pedido. Genera el ingreso —con su documento y su movimiento— y sube el stock.
 */
export async function registrarFaltante(pedidoId, items) {
  const { data } = await http.post(`/reposicion/pedidos/${pedidoId}/registrar-faltante`, { items });
  return data;
}

/*
 * Los saldos sin resolver: lo que se pidió, no salió del depósito y espera
 * decisión. Es la bandeja prioritaria — cada uno es mercadería que el local
 * sigue necesitando y que nadie está preparando.
 */
export async function fetchSaldos() {
  const { data } = await http.get("/reposicion/saldos");
  return data.data || [];
}

/** aceptar=true rearma el saldo como pedido nuevo; false lo da de baja. */
export async function resolverSaldo(pedidoId, aceptar, motivo) {
  const { data } = await http.post(`/reposicion/pedidos/${pedidoId}/saldo`, { aceptar, motivo });
  return data;
}
