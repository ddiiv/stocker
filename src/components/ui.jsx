import { useEffect } from "react";
import { X, Loader2, AlertTriangle, Check } from "lucide-react";

/* Piezas compartidas. Ninguna guarda estado propio: eso vive en las páginas. */

export function Card({ children, className = "" }) {
  return <div className={`card ${className}`}>{children}</div>;
}

export function PageHead({ titulo, bajada, acciones }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold">{titulo}</h1>
        {bajada && <p className="mt-1 text-sm text-dim">{bajada}</p>}
      </div>
      {acciones && <div className="flex flex-wrap items-center gap-2">{acciones}</div>}
    </div>
  );
}

/*
 * Estado de una cuenta o de un cobro.
 *
 * El color y el texto van juntos siempre: el color permite barrer la tabla de
 * un vistazo, el texto es lo que hace que signifique algo — y lo que sostiene
 * la lectura de quien no distingue los tonos.
 */
const TONOS = {
  trial:     ["chip-warn", "Prueba"],
  activa:    ["chip-ok",   "Al día"],
  morosa:    ["chip-warn", "Vencida"],
  lectura:   ["chip-crit", "Sólo lectura"],
  cancelada: ["chip-mute", "Cancelada"],
  aprobado:  ["chip-ok",   "Aprobado"],
  pendiente: ["chip-warn", "Pendiente"],
  rechazado: ["chip-crit", "Rechazado"],
  reintegrado: ["chip-mute", "Reintegrado"],
};

export function Estado({ valor }) {
  const [clase, texto] = TONOS[valor] || ["chip-mute", valor || "—"];
  return <span className={`chip ${clase}`}>{texto}</span>;
}

export function Aviso({ tono = "info", children, onCerrar }) {
  if (!children) return null;
  const clases = {
    error: "border-crit/40 bg-crit-bg text-crit",
    ok:    "border-ok/40 bg-ok-bg text-ok",
    info:  "border-line bg-surface2 text-dim",
  }[tono];
  const Icono = tono === "error" ? AlertTriangle : tono === "ok" ? Check : null;

  return (
    <div className={`mb-4 flex items-start gap-2 rounded-[3px] border px-3 py-2 text-sm ${clases}`}>
      {Icono && <Icono size={15} className="mt-0.5 shrink-0" />}
      <span className="flex-1">{children}</span>
      {onCerrar && (
        <button onClick={onCerrar} className="shrink-0 opacity-60 hover:opacity-100" aria-label="Cerrar">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

export function Modal({ open, onClose, titulo, children, ancho = "max-w-lg" }) {
  // Escape cierra: en una herramienta interna se abre y se cierra todo el día.
  useEffect(() => {
    if (!open) return;
    const alTecla = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", alTecla);
    return () => window.removeEventListener("keydown", alTecla);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-deep/80 p-4 sm:p-8">
      <div className={`card w-full ${ancho} shadow-2xl`} role="dialog" aria-modal="true">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-base font-semibold">{titulo}</h2>
          <button onClick={onClose} className="text-faint hover:text-text" aria-label="Cerrar">
            <X size={16} />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function Campo({ etiqueta, ayuda, children }) {
  return (
    <div>
      <label className="label">{etiqueta}</label>
      {children}
      {ayuda && <p className="mt-1 text-[11px] text-faint">{ayuda}</p>}
    </div>
  );
}

export function Cargando({ texto = "Cargando…" }) {
  return (
    <div className="flex items-center gap-2 py-16 text-sm text-dim">
      <Loader2 size={16} className="animate-spin" /> {texto}
    </div>
  );
}

export function Vacio({ children }) {
  return <p className="px-4 py-12 text-center text-sm text-dim">{children}</p>;
}

/* Tabla con desborde propio: nunca empuja el ancho de la página. */
export function Tabla({ cabeceras, children, min = "min-w-[760px]" }) {
  return (
    <div className="overflow-x-auto">
      <table className={`w-full ${min}`}>
        <thead>
          <tr className="border-b border-line bg-surface2">
            {cabeceras.map((c, i) => (
              <th key={i} className={`th ${c.align === "right" ? "text-right" : ""}`}>{c.texto ?? c}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
