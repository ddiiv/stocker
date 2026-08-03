export function formatCurrency(value = 0) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(value || 0);
}

export function formatDate(value) {
  if (!value) return "—";
  const d = new Date(`${value}T00:00:00`);
  return new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
}

export function formatDateTime(value) {
  const d = new Date(value);
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
