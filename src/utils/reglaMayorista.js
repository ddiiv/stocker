/*
 * Cuándo una venta va a precio mayorista.
 *
 * Es la MISMA regla que evalúa el servidor (services/reglaMayoristaService.js).
 * Existe una copia acá porque la pantalla tiene que mostrar el precio mientras
 * se arma la venta, antes de que el servidor vea nada.
 *
 * Que haya dos implementaciones es un riesgo conocido, y por eso están escritas
 * igual y las prueba el mismo conjunto de casos: si se separan, la pantalla
 * muestra un precio y la caja cobra otro, que es el peor error posible porque
 * el cliente ya pagó. Antes había TRES copias y ninguna sabía de las otras.
 *
 * El servidor siempre manda: es él quien calcula el precio que se guarda.
 */

const MODOS = ["cantidad", "monto", "ambos", "siempre", "nunca"];
const POR_DEFECTO = { modo: "cantidad", cantidad: 3, monto: null };

export function normalizar(origen) {
  const modo = MODOS.includes(origen?.mayoristaModo ?? origen?.modo)
    ? (origen.mayoristaModo ?? origen.modo)
    : POR_DEFECTO.modo;

  const cantidadCruda = Number(origen?.mayoristaCantidad ?? origen?.cantidad);
  const cantidad = Number.isInteger(cantidadCruda) && cantidadCruda > 0
    ? cantidadCruda
    : POR_DEFECTO.cantidad;

  const montoCrudo = Number(origen?.mayoristaMonto ?? origen?.monto);
  const monto = Number.isFinite(montoCrudo) && montoCrudo > 0 ? montoCrudo : null;

  return { modo, cantidad, monto };
}

/**
 * @param regla       el local, o una regla ya normalizada
 * @param unidades    total de prendas
 * @param montoLista  total A PRECIOS MINORISTAS
 *
 * El monto va en lista porque el precio depende del total y el total del
 * precio. Midiendo en lista, el número contra el que se compara es el mismo que
 * el cajero ve mientras carga.
 */
export function esMayorista(regla, unidades, montoLista = 0) {
  const r = normalizar(regla);
  const u = Number(unidades) || 0;
  const m = Number(montoLista) || 0;

  switch (r.modo) {
    case "siempre": return true;
    case "nunca":   return false;
    case "monto":   return r.monto !== null && m >= r.monto;
    case "ambos":   return u >= r.cantidad || (r.monto !== null && m >= r.monto);
    case "cantidad":
    default:        return u >= r.cantidad;
  }
}

/** Cómo se le explica la regla a una persona. */
export function describir(regla) {
  const r = normalizar(regla);
  const plata = (n) => `$ ${Number(n).toLocaleString("es-AR")}`;
  switch (r.modo) {
    case "siempre": return "Siempre a precio mayorista.";
    case "nunca":   return "Siempre a precio minorista.";
    case "monto":   return r.monto ? `Mayorista desde ${plata(r.monto)} en la venta.` : "Mayorista por monto, sin monto definido.";
    case "ambos":   return r.monto
      ? `Mayorista desde ${r.cantidad} prenda(s) o ${plata(r.monto)}, lo que pase primero.`
      : `Mayorista desde ${r.cantidad} prenda(s).`;
    case "cantidad":
    default:        return `Mayorista desde ${r.cantidad} prenda(s).`;
  }
}

export const MODOS_MAYORISTA = [
  { key: "cantidad", label: "Por cantidad de prendas" },
  { key: "monto",    label: "Por monto de la venta" },
  { key: "ambos",    label: "Cantidad o monto, lo que pase primero" },
  { key: "siempre",  label: "Siempre mayorista" },
  { key: "nunca",    label: "Siempre minorista" },
];

/*
 * La regla del local desde el que se está vendiendo.
 *
 * Hay dos maneras de tenerla y hace falta buscar en las dos, porque cada rol
 * llega con una sola:
 *
 *   · El dueño elige el local de una lista que sí pide al servidor.
 *   · El empleado no pide esa lista —tiene un local y no elige—, pero su
 *     sesión ya trae el local entero, con la regla adentro.
 *
 * Mirar sólo la lista es el bug que tuvimos: para el empleado nunca había
 * coincidencia, la regla quedaba en null, y `esMayorista` caía en la regla de
 * fábrica. En pantalla se leía "Mayorista desde 3 prendas" —que es la de
 * fábrica, no la del negocio— así que parecía configurada y cobraba otra cosa.
 * Con "siempre mayorista" puesto, el empleado cobraba todo a minorista.
 *
 * Devuelve null sólo si de verdad no se sabe de qué local se trata. Ahí el que
 * llama decide: `esMayorista` con null usa la regla de fábrica, que es lo
 * razonable cuando todavía no se eligió local.
 */
export function reglaDelLocal(locations, localId, user) {
  if (!localId) return null;
  const enLista = (locations || []).find((l) => String(l.id) === String(localId));
  if (enLista) return enLista;
  const propio = user?.local;
  return propio && String(propio.id) === String(localId) ? propio : null;
}
