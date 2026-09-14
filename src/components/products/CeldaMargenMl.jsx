import { useState } from "react";
import { Check, X, Loader2 } from "lucide-react";
import { updateVariant } from "../../services/productService";

/*
 * Margen de seguridad para Mercado Libre, editable en el lugar.
 *
 * Son unidades que no se publican: a Mercado Libre va lo disponible menos este
 * número. Sirve para lo que se vende rápido en el mostrador, donde entre una
 * venta en el local y la próxima sincronización ML puede vender la misma prenda
 * dos veces. En un pack o un combo se descuentan packs enteros, no prendas.
 *
 * Cero es lo normal y se muestra apagado: casi ningún artículo lo necesita.
 */
const AYUDA = "Unidades que no se publican en Mercado Libre: se publica lo disponible menos este número, "
  + "para no vender online algo que ya se vendió en el local.";

export default function CeldaMargenMl({ variantId, margen = 0, onSaved, soloLectura = false }) {
  const actual = Number(margen) || 0;
  const [editando, setEditando] = useState(false);
  const [valor, setValor] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState("");

  const texto = actual > 0 ? `−${actual}` : "—";
  const clase = actual > 0 ? "text-ink-900" : "text-ink-300";

  async function guardar() {
    const limpio = valor.trim();
    const nuevo = limpio === "" ? 0 : Number(limpio);
    if (!Number.isInteger(nuevo) || nuevo < 0 || nuevo > 100000) {
      setError("Entero de 0 en adelante"); return;
    }
    if (nuevo === actual) { setEditando(false); return; }
    setGuardando(true); setError("");
    try {
      await updateVariant(variantId, { margenMl: nuevo });
      setEditando(false);
      await onSaved?.();
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo guardar");
    } finally { setGuardando(false); }
  }

  if (soloLectura) {
    return <span title={AYUDA} className={`tabular-nums ${clase}`}>{texto}</span>;
  }

  if (!editando) {
    return (
      <button
        type="button"
        title={AYUDA}
        aria-label={`Margen de seguridad para Mercado Libre: ${actual}`}
        className={`rounded px-1.5 py-0.5 tabular-nums hover:bg-paper-200 ${clase}`}
        onClick={() => { setValor(String(actual)); setError(""); setEditando(true); }}
      >
        {texto}
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      <input
        autoFocus
        type="number" min="0" step="1"
        className="input h-8 w-16 text-right text-xs"
        aria-label="Margen de seguridad para Mercado Libre"
        value={valor}
        onChange={(e) => setValor(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") guardar();
          if (e.key === "Escape") { e.stopPropagation(); setEditando(false); }
        }}
      />
      <button type="button" className="btn-ghost px-1.5 py-1" onClick={guardar} disabled={guardando} aria-label="Guardar margen">
        {guardando ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
      </button>
      <button type="button" className="btn-ghost px-1.5 py-1" onClick={() => setEditando(false)} disabled={guardando} aria-label="Cancelar">
        <X size={14} />
      </button>
      {error && <span className="w-full text-[11px] text-brick-700">{error}</span>}
    </div>
  );
}
