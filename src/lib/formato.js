/*
 * Formateo para pantalla.
 *
 * Regla que atraviesa el archivo: un dato raro devuelve un guion, nunca una
 * excepción. `Intl.format` sobre una fecha inválida tira RangeError, y un
 * helper de presentación que rompe se lleva puesta la pantalla entera.
 */

const fmtPesos = new Intl.NumberFormat("es-AR", {
  style: "currency", currency: "ARS", maximumFractionDigits: 0,
});

export function plata(v) {
  const n = Number(v);
  return Number.isFinite(n) ? fmtPesos.format(n) : "—";
}

/** Acepta tanto "2026-08-31" como "2026-08-31T03:21:35.102Z". */
function aFecha(v) {
  if (v instanceof Date) return v;
  const soloFecha = typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  // A la fecha sola hay que forzarle la hora local: leída como UTC, en
  // Argentina se mostraría el día anterior.
  return new Date(soloFecha ? `${v}T00:00:00` : v);
}

export function fecha(v) {
  if (!v) return "—";
  const d = aFecha(v);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
}

export function fechaHora(v) {
  if (!v) return "—";
  const d = aFecha(v);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(d);
}

export const numero = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? new Intl.NumberFormat("es-AR").format(n) : "—";
};

/** "Sin tope" es información, no un dato faltante: se dice con palabras. */
export const tope = (v) => (v == null ? "Sin tope" : numero(v));
