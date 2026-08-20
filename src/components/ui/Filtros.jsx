import { PERIODOS } from "../../utils/periodos";

/*
 * Piezas de filtrado compartidas entre las pantallas de historial.
 *
 * Están acá y no repetidas en cada página para que se vean y se comporten
 * igual: si el selector de período de Ventas y el de Facturación se dibujan
 * distinto, el usuario duda de si filtran distinto.
 */

/*
 * Grupo de opciones excluyentes, estilo segmentado.
 *
 * Scrollea de costado cuando no entra. Un grupo de cinco opciones —el de tipo
 * de movimiento— mide más que la pantalla de un celular, y sin scroll la última
 * queda afuera sin forma de tocarla. `w-fit` mantiene el ancho justo en
 * pantallas grandes; `max-w-full` es lo que le permite achicarse en las chicas.
 */
export function GrupoFiltro({ children }) {
  return (
    <div className="flex w-fit max-w-full overflow-x-auto rounded-md border border-line bg-paper-50 p-1
                    [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {children}
    </div>
  );
}

export function OpcionFiltro({ activa, onClick, children }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={activa}
      className={`shrink-0 whitespace-nowrap rounded px-3 py-1.5 text-xs font-medium transition-colors ${
        activa ? "bg-ink-950 text-paper-50" : "text-ink-600 hover:bg-paper-200"
      }`}
    >
      {children}
    </button>
  );
}

/** Todo · Hoy · Este mes · Este año. */
export function FiltroPeriodo({ valor, onChange }) {
  return (
    <GrupoFiltro>
      {PERIODOS.map((p) => (
        <OpcionFiltro key={p.value} activa={valor === p.value} onClick={() => onChange(p.value)}>
          {p.label}
        </OpcionFiltro>
      ))}
    </GrupoFiltro>
  );
}

/*
 * Franja de totales del filtro.
 *
 * Va arriba de la tabla porque es la respuesta a la pregunta que motiva
 * filtrar. Los números son del filtro completo, no de las filas visibles:
 * sumar la página daría el total de treinta ventas y no el del mes.
 */
export function ResumenFiltro({ children }) {
  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-8 gap-y-2 rounded-md border border-line bg-paper-50 px-4 py-3">
      {children}
    </div>
  );
}

export function DatoResumen({ rotulo, valor, nota, destacado }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-ink-600">{rotulo}</p>
      <p className={`tabular-nums ${
        destacado ? "font-display text-lg font-semibold text-ink-950" : "text-sm text-ink-900"
      }`}>
        {valor}
      </p>
      {nota && <p className="text-[11px] text-ink-500">{nota}</p>}
    </div>
  );
}
