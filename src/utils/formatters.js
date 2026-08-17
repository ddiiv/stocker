export function formatCurrency(value = 0) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(value || 0);
}

/*
 * Interpreta tanto una fecha sola ("2026-08-31") como un instante completo
 * ("2026-08-31T03:21:35.102Z").
 *
 * A la fecha sola hay que forzarle la hora: `new Date("2026-08-31")` la lee
 * como UTC y en Argentina se mostraría el día anterior. A la que ya trae hora
 * no se le toca nada — concatenarle "T00:00:00" la vuelve inválida, que es
 * exactamente lo que rompía la pantalla de suscripción.
 */
function aFecha(value) {
  if (value instanceof Date) return value;
  const soloFecha = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  return new Date(soloFecha ? `${value}T00:00:00` : value);
}

export function formatDate(value) {
  if (!value) return "—";
  const d = aFecha(value);
  // Un dato con formato inesperado devuelve un guion, no una excepción:
  // `Intl.format` sobre una fecha inválida tira RangeError, y un helper de
  // presentación no puede tumbar la pantalla que lo usa.
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
}

export function formatDateTime(value) {
  if (!value) return "—";
  const d = aFecha(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function initials(nombre = "", apellido = "") {
  return `${nombre[0] || ""}${apellido[0] || ""}`.toUpperCase();
}
