import { http } from "../lib/http";

/**
 * Evolución de ventas en el tiempo.
 * @param {object} opts
 * @param {"dia"|"semana"|"mes"|"anio"} opts.granularidad
 * @param {string} [opts.desde] YYYY-MM-DD
 * @param {string} [opts.hasta] YYYY-MM-DD
 * @param {boolean} [opts.incluirPendientes]
 */
export async function getTimeline({ granularidad = "mes", desde, hasta, incluirPendientes } = {}) {
  const params = { granularidad };
  if (desde) params.desde = desde;
  if (hasta) params.hasta = hasta;
  if (incluirPendientes) params.incluirPendientes = "true";
  const { data } = await http.get("/metrics/timeline", { params });
  return data;
}

/** Rendimiento por producto: unidades, ganancia, conversión y locales. */
export async function getProductMetrics({ desde, hasta } = {}) {
  const params = {};
  if (desde) params.desde = desde;
  if (hasta) params.hasta = hasta;
  const { data } = await http.get("/metrics/products", { params });
  return data;
}
