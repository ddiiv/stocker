import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { http } from "../../lib/http";
import { formatCurrency } from "../../utils/formatters";

/*
 * Buscador de artículos para venta/cotización.
 *
 * Pega contra /products/buscar-variantes, que busca a nivel variante: tipeando
 * "buzo beige m" cae esa variante sola, y pegando un SKU cae esa sola fila. La
 * versión anterior traía productos y desplegaba todas sus variantes, así que
 * buscar un talle puntual igual devolvía los nueve hermanos.
 */
export default function ProductPicker({ onPick, locationId = null }) {
  const [term, setTerm] = useState("");
  const [variants, setVariants] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activo, setActivo] = useState(0);
  const listaRef = useRef(null);

  useEffect(() => {
    const q = term.trim();
    if (q.length < 2) { setVariants([]); setLoading(false); return; }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const { data } = await http.get("/products/buscar-variantes", {
          params: { q, limit: 30, ...(locationId ? { locationId } : {}) },
        });
        setVariants(data.data || []);
        setActivo(0);
      } catch { setVariants([]); }
      setLoading(false);
    }, 250);
    return () => clearTimeout(t);
  }, [term, locationId]);

  // Que la fila resaltada siga visible al moverse con las flechas.
  useEffect(() => {
    listaRef.current?.querySelector('[data-activo="1"]')?.scrollIntoView({ block: "nearest" });
  }, [activo]);

  function elegir(v) {
    onPick({ ...v, title: v.titulo });
    setTerm("");
    setVariants([]);
    setOpen(false);
  }

  /*
   * Flechas y Enter: con lector de códigos, el SKU entra tipeado y termina en
   * Enter. Si hay un único resultado, ese Enter tiene que agregarlo.
   */
  function onKeyDown(e) {
    if (!open || variants.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActivo((i) => Math.min(i + 1, variants.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActivo((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); elegir(variants[activo] || variants[0]); }
    else if (e.key === "Escape") { setOpen(false); }
  }

  const rotulo = (v) => [
    v.variante1Valor && `${v.variante1Nombre || "Variante"}: ${v.variante1Valor}`,
    v.variante2Valor && `${v.variante2Nombre || "Variante"}: ${v.variante2Valor}`,
  ].filter(Boolean).join(" · ");

  return (
    <div className="relative">
      <div className="relative">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
        <input
          className="input pl-9"
          placeholder="Buscar por SKU, o por título con color y talle…"
          value={term}
          onChange={(e) => { setTerm(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          autoComplete="off"
        />
      </div>
      {open && term.trim().length >= 2 && (
        <div ref={listaRef} className="absolute z-10 mt-1 max-h-80 w-full overflow-y-auto rounded-md border border-line bg-paper-50 shadow-lg">
          {loading && <p className="px-3 py-2 text-sm text-ink-500">Buscando…</p>}
          {!loading && variants.length === 0 && (
            <p className="px-3 py-2 text-sm text-ink-500">Sin resultados para “{term.trim()}”.</p>
          )}
          {!loading && variants.map((v, i) => {
            const stock = v.enLocal ?? v.stock;
            return (
              <button
                type="button"
                key={v.id}
                data-activo={i === activo ? "1" : "0"}
                onMouseEnter={() => setActivo(i)}
                className={`flex w-full items-start justify-between gap-3 border-b border-line px-3 py-2 text-left text-sm last:border-0 ${i === activo ? "bg-paper-100" : ""}`}
                onClick={() => elegir(v)}
              >
                <div className="min-w-0">
                  <p className="truncate text-ink-900">
                    {v.titulo}
                    {v.categoria ? <span className="text-ink-500"> · {v.categoria}</span> : null}
                  </p>
                  <p className="truncate text-xs text-ink-500">
                    {rotulo(v)}
                    {rotulo(v) ? " · " : ""}
                    <span className="font-mono">{v.sku}</span>
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-medium text-ink-900">{formatCurrency(v.precioMinorista)}</p>
                  <p className={`text-xs ${stock <= 0 ? "text-brick-500" : "text-ink-500"}`}>
                    {stock <= 0 ? "sin stock" : `${stock} en stock`}
                    {v.enLocal !== null && v.enLocal !== undefined && v.stock !== v.enLocal
                      ? <span className="text-ink-400"> · {v.stock} total</span> : null}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
