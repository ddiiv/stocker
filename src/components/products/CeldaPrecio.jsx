import { useEffect, useState } from "react";
import { Check, X, Loader2, Undo2 } from "lucide-react";
import { updateVariant } from "../../services/productService";
import { formatCurrency } from "../../utils/formatters";

/*
 * El precio de una variante, editable en el lugar.
 *
 * Casi todas las variantes valen lo mismo que su producto y ese es el caso
 * normal: se muestran en gris para dejar claro que el número no es propio, y
 * que si mañana cambia el precio del producto, cambia también el de ellas.
 *
 * Las que tienen precio propio —un talle grande que sale más caro, un color
 * especial— se muestran en negro. La distinción importa: sin ella no hay forma
 * de saber por qué dos talles del mismo modelo tienen precios distintos, ni
 * cuáles van a seguir un cambio del padre.
 *
 * Vaciar el campo devuelve la variante a heredar, que es la única manera de
 * deshacer sin tener que acordarse del precio original.
 */
export default function CeldaPrecio({ variant, campo, onSaved, soloLectura = false }) {
  const propio = variant.precioPropio?.[campo];
  const esPropio = propio !== null && propio !== undefined && propio !== "";
  const efectivo = campo === "precioMinorista" ? variant.precio
    : campo === "precioMayorista" ? variant.precioMayorista
      : variant.costo;
  const delPadre = variant.precioPadre?.[campo] ?? 0;

  const [editando, setEditando] = useState(false);
  const [valor, setValor] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (editando) setValor(esPropio ? String(propio) : "");
  }, [editando, esPropio, propio]);

  async function guardar() {
    const texto = valor.trim();
    // Vacío = volver a heredar. Se manda null, que es lo que el backend
    // interpreta como "usá el del producto".
    const nuevo = texto === "" ? null : Number(texto);
    if (nuevo !== null && (!Number.isFinite(nuevo) || nuevo < 0)) {
      setError("Número inválido"); return;
    }
    if ((esPropio ? Number(propio) : null) === nuevo) { setEditando(false); return; }

    setGuardando(true); setError("");
    try {
      await updateVariant(variant.id, { [campo]: nuevo });
      setEditando(false);
      await onSaved();
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo guardar");
    } finally { setGuardando(false); }
  }

  if (!editando) {
    return (
      <button
        onClick={() => { if (!soloLectura) setEditando(true); }}
        disabled={soloLectura}
        className="group flex w-full items-center justify-end gap-1 text-right"
        title={esPropio ? `Precio propio de esta variante (el producto vale ${formatCurrency(delPadre)})` : "Hereda el precio del producto"}
      >
        <span className={`tabular-nums ${esPropio ? "font-medium text-ink-950" : "text-ink-400"}`}>
          {formatCurrency(efectivo)}
        </span>
        {esPropio && <span className="text-[9px] uppercase text-brass-600">propio</span>}
      </button>
    );
  }

  return (
    <div className="min-w-[9rem]">
      <div className="flex items-center gap-1">
        <input
          autoFocus
          type="number" min="0" step="0.01" inputMode="decimal"
          className="input h-8 w-24 text-right text-xs"
          placeholder={String(delPadre)}
          value={valor}
          onChange={(e) => setValor(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") guardar(); if (e.key === "Escape") setEditando(false); }}
        />
        <button className="btn-accent px-1.5 py-1" onClick={guardar} disabled={guardando}>
          {guardando ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
        </button>
        <button className="btn-ghost px-1.5 py-1" onClick={() => { setEditando(false); setError(""); }}>
          <X size={13} />
        </button>
      </div>
      <p className="mt-1 text-[11px] text-ink-500">
        {valor.trim() === ""
          ? <>Vacío: hereda {formatCurrency(delPadre)} del producto.</>
          : <span className="inline-flex items-center gap-1">
              <Undo2 size={10} /> Vaciá para volver a heredar.
            </span>}
      </p>
      {error && <p className="text-[11px] text-brick-500">{error}</p>}
    </div>
  );
}
