import { Package } from "lucide-react";

/*
 * Cuánto se lleva escaneado de cada producto en esta sesión.
 *
 * El historial cronológico ya existe y sirve para otra cosa: revisar la última
 * lectura y detectar un error. Pero recorriendo la tienda la pregunta es otra
 * —"¿cuántas del jean azul llevo?"— y responderla contando renglones repetidos
 * en una lista de sesenta lecturas no es razonable con el teléfono en la mano.
 *
 * Se agrupa por SKU, que es único por negocio y viene en cada respuesta.
 */
export function agruparPorProducto(historial) {
  const mapa = new Map();

  for (const h of historial) {
    if (!h.ok) continue;
    const acum = mapa.get(h.sku);
    if (acum) {
      acum.lecturas += 1;
      acum.neto += h.delta || 0;
      // El stock que vale es el de la lectura más nueva, no el de la primera.
      if (h.at >= acum.at) { acum.stockNuevo = h.stockNuevo; acum.at = h.at; }
    } else {
      mapa.set(h.sku, {
        sku: h.sku, titulo: h.titulo, variante: h.variante,
        lecturas: 1, neto: h.delta || 0, stockNuevo: h.stockNuevo, at: h.at,
      });
    }
  }

  // Lo último escaneado va arriba: es lo que el empleado tiene en la mano.
  return [...mapa.values()].sort((a, b) => b.at - a.at);
}

function Neto({ valor }) {
  if (!valor) return <span className="text-ink-500">±0</span>;
  return (
    <span className={valor > 0 ? "text-teal-600" : "text-brick-500"}>
      {valor > 0 ? `+${valor}` : valor}
    </span>
  );
}

/*
 * `oscuro` existe porque esta misma lista va sobre la cámara, donde el fondo es
 * negro. Es el mismo componente y no una copia: si fueran dos, la de la cámara
 * se quedaría atrás en el primer cambio.
 */
export default function ResumenEscaneo({ historial, oscuro = false, vacio }) {
  const filas = agruparPorProducto(historial);

  const borde = oscuro ? "border-white/10" : "border-line";
  const titulo = oscuro ? "text-white" : "text-ink-900";
  const suave = oscuro ? "text-white/50" : "text-ink-500";

  if (filas.length === 0) {
    return (
      <p className={`flex items-center justify-center gap-2 px-4 py-8 text-center text-sm ${suave}`}>
        <Package size={15} /> {vacio || "Todavía no escaneaste nada."}
      </p>
    );
  }

  return (
    <ul>
      {filas.map((f) => (
        <li key={f.sku} className={`flex items-center gap-3 border-b ${borde} px-4 py-2.5 last:border-0`}>
          <div className="min-w-0 flex-1">
            <p className={`truncate text-sm ${titulo}`}>{f.titulo}</p>
            <p className={`truncate text-xs ${suave}`}>
              {f.sku}{f.variante && ` · ${f.variante}`}
              {f.lecturas > 1 && ` · ${f.lecturas} lecturas`}
            </p>
          </div>
          <div className="whitespace-nowrap text-right">
            <p className="font-display text-lg font-semibold tabular-nums leading-tight">
              <Neto valor={f.neto} />
            </p>
            <p className={`text-[11px] tabular-nums ${suave}`}>queda en {f.stockNuevo}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
