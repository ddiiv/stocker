/*
 * Rangos de fecha para los filtros de las pantallas de historial.
 *
 * Vive acá y no en cada página para que "Este mes" signifique lo mismo en
 * Ventas y en Facturación. Con dos definiciones, un ajuste en una deja a la
 * otra contando distinto y los números dejan de cuadrar entre pantallas.
 *
 * Las fechas se arman en hora LOCAL, no con toISOString(). En Argentina
 * (UTC−3), `new Date().toISOString()` de las 22 h devuelve el día siguiente, y
 * una venta de la noche caería fuera del rango del día en que se hizo.
 */

const yyyymmdd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const PERIODOS = [
  { value: "", label: "Todo", rango: () => ({}) },
  {
    value: "dia",
    label: "Hoy",
    rango: () => {
      const h = new Date();
      return { desde: yyyymmdd(h), hasta: yyyymmdd(h) };
    },
  },
  {
    value: "mes",
    label: "Este mes",
    rango: () => {
      const h = new Date();
      return {
        desde: yyyymmdd(new Date(h.getFullYear(), h.getMonth(), 1)),
        // Día 0 del mes siguiente es el último del actual: sirve para cualquier
        // mes sin tener que saber si tiene 28, 30 o 31.
        hasta: yyyymmdd(new Date(h.getFullYear(), h.getMonth() + 1, 0)),
      };
    },
  },
  {
    value: "anio",
    label: "Este año",
    rango: () => {
      const h = new Date();
      return {
        desde: yyyymmdd(new Date(h.getFullYear(), 0, 1)),
        hasta: yyyymmdd(new Date(h.getFullYear(), 11, 31)),
      };
    },
  },
];

/** Rango de un período por su valor. Devuelve {} para "Todo". */
export function rangoDe(value) {
  return (PERIODOS.find((p) => p.value === value) || PERIODOS[0]).rango();
}

/** Cómo nombrar el período en un mensaje. */
export function etiquetaDe(value) {
  return (PERIODOS.find((p) => p.value === value) || PERIODOS[0]).label.toLowerCase();
}

export { yyyymmdd };
