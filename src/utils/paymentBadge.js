/*
 * Color del badge según el medio de pago.
 *
 * Los medios los define cada negocio, así que no se puede mapear por id ni por
 * una lista cerrada: alguien puede llamarlo "Transferencia Galicia" o "Mercado
 * Pago QR". Se busca por palabra clave sobre el nombre, y lo que no coincide
 * cae en un neutro — que es preferible a pintar dos medios distintos igual.
 */
const REGLAS = [
  { clase: "badge-mixto",    test: (n) => n.includes("+") },      // pago combinado
  { clase: "badge-efectivo", test: (n) => /efectivo|cash|contado/.test(n) },
  { clase: "badge-transfer", test: (n) => /transfer|cbu|banco|deposito|depósito/.test(n) },
  { clase: "badge-credito",  test: (n) => /credito|crédito|tarjeta de cr/.test(n) },
  { clase: "badge-debito",   test: (n) => /debito|débito|tarjeta/.test(n) },
  { clase: "badge-digital",  test: (n) => /qr|billetera|mercado ?pago|virtual|app/.test(n) },
];

export function medioPagoBadge(nombre) {
  const n = String(nombre || "").toLowerCase();
  if (!n) return "badge-digital";
  return REGLAS.find((r) => r.test(n))?.clase || "badge-digital";
}
