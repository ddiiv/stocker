/*
 * De qué locales se apartó un ítem de pedido y cuánto en cada uno.
 *
 * Vive en su propio archivo porque lo usan dos servicios que no se pueden
 * importar entre sí sin armar un ciclo: la cola, que devuelve la reserva cuando
 * la plataforma cancela, y Envíos del Día, que la consume al despachar. Los dos
 * tienen que partir la cantidad exactamente igual, o lo que uno aparta el otro
 * no lo encuentra.
 *
 * Los ítems viejos no tienen `reparto`: para ellos vale lo que valía antes, la
 * cantidad entera en `locationId`. Así el cambio no deja ningún pedido que ya
 * estaba en curso sin poder despacharse.
 */
function partesDeItem(item) {
  try {
    const lista = JSON.parse(item?.reparto || 'null');
    if (Array.isArray(lista) && lista.length) {
      return lista
        .map((p) => ({ locationId: Number(p.locationId), unidades: Number(p.unidades) }))
        .filter((p) => p.locationId && Number.isInteger(p.unidades) && p.unidades > 0);
    }
  } catch { /* reparto ilegible: se cae al dato viejo */ }
  return item?.locationId
    ? [{ locationId: Number(item.locationId), unidades: Number(item.cantidad) }]
    : [];
}

module.exports = { partesDeItem };
