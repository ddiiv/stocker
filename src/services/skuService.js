import { http } from "../lib/http";

/*
 * Confección de SKU.
 *
 * Todo pasa por la API: la fórmula vive en el backend y acá no se replica. Una
 * copia local daría una vista previa más ágil y, al primer retoque de la regla,
 * mostraría un SKU distinto del que se guarda — que es el peor resultado
 * posible para una pantalla cuyo trabajo es mostrar exactamente qué se va a
 * guardar.
 */

export async function fetchReglaSku() {
  const { data } = await http.get("/sku/regla");
  return data;
}

export async function saveReglaSku(regla) {
  const { data } = await http.put("/sku/regla", { regla });
  return data.regla;
}

export async function previewSku({ agrupador, ejes, regla }) {
  const { data } = await http.post("/sku/vista-previa", { agrupador, ejes, regla });
  return data;
}

export async function suggestSku({ agrupador, valores, exceptoVariantId }) {
  const { data } = await http.post("/sku/sugerir", { agrupador, valores, exceptoVariantId });
  return data;
}

export async function skuDisponible(sku, exceptoVariantId) {
  const { data } = await http.get("/sku/disponible", { params: { sku, exceptoVariantId } });
  return data.libre;
}
