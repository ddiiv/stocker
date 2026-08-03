// ------------------------------------------------------------------
// Almacenamiento local (localStorage) para los módulos que todavía no
// existen en el backend Stocker (auth/negocio, empleados, stock por variante,
// ventas/cotizaciones, facturas y recibos).
//
// Cada "service" en /src/services usa estas funciones. El día que el
// backend real tenga estos endpoints, solo hay que reemplazar el
// contenido de esos services por llamadas a `http` — los componentes
// no se enteran del cambio.
// ------------------------------------------------------------------

const NS = "isu_admin";

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(`${NS}:${key}`);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  localStorage.setItem(`${NS}:${key}`, JSON.stringify(value));
  return value;
}

function seedOnce(key, seedValue) {
  const existing = localStorage.getItem(`${NS}:${key}`);
  if (existing === null) write(key, seedValue);
}

function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Simula latencia de red para que loaders/estados se sientan reales.
function delay(ms = 250) {
  return new Promise((res) => setTimeout(res, ms));
}

export const localDb = { read, write, seedOnce, uid, delay };
