/*
 * La tarjeta de una métrica.
 *
 * Sigue el ritmo del sistema Snow: algunas tarjetas van tintadas y otras
 * neutras, alternando. Con las cuatro iguales la fila se lee como una sola
 * mancha y hay que buscar el número que interesa; con el tinte alternado el
 * ojo se ancla y las agrupa de a pares.
 *
 * El tinte es latón y no el pastel de Snow porque el latón es la marca —está
 * en el logo, en el landing y en el ticket—. Lo que se toma es la FORMA: el
 * tinte suave, el radio grande, el número grande y sin borde.
 *
 * `tinta` es del que llama y no automático por índice: quien arma la pantalla
 * sabe cuál es la métrica principal, y el componente no.
 */
export default function StatCard({ label, value, hint, accent = "ink", icon: Icon, tinta = false }) {
  const accentClasses = {
    ink: "bg-ink-950 text-paper-100",
    brass: "bg-brass-500 text-[#1c1c1c]",
    teal: "bg-teal-500 text-paper-100",
    brick: "bg-brick-500 text-paper-100",
  }[accent];

  return (
    <div className={`rounded-2xl p-5 ${tinta ? "bg-brass-50" : "bg-paper-50"}`}>
      <div className="flex items-start justify-between gap-3">
        {/*
          * La etiqueta en mayúsculas y chica, el número grande: es el orden en
          * que se lee una métrica —primero qué es, después cuánto— y el que
          * permite recorrer cuatro tarjetas sin leerlas enteras.
          */}
        <p className="text-xs font-medium uppercase tracking-wide text-ink-600">{label}</p>
        {Icon && (
          <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${accentClasses}`}>
            <Icon size={15} />
          </div>
        )}
      </div>
      <p className="mt-3 font-display text-2xl font-semibold text-ink-950">{value}</p>
      {hint && <p className="mt-1 text-xs text-ink-600">{hint}</p>}
    </div>
  );
}
