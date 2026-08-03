import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { http } from "../../lib/http";
import { formatCurrency } from "../../utils/formatters";

export default function ProductPicker({ onPick }) {
  const [term, setTerm] = useState("");
  const [variants, setVariants] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!term.trim()) { setVariants([]); return; }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const { data } = await http.get("/products", { params: { search: term, limit: 50 } });
        const flat = [];
        for (const p of data.data || []) {
          for (const v of p.productVariants || []) {
            flat.push({
              ...v,
              title: p.titulo,
              precioMinorista: Number(p.precioMinorista),
              precioMayorista: Number(p.precioMayorista),
              skuAgrupador: p.skuAgrupador,
              productId: p.id,
            });
          }
        }
        setVariants(flat.slice(0, 40));
      } catch { setVariants([]); }
      setLoading(false);
    }, 300);
    return () => clearTimeout(t);
  }, [term]);

  return (
    <div className="relative">
      <div className="relative">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
        <input
          className="input pl-9"
          placeholder="Buscar producto por título o SKU para agregar…"
          value={term}
          onChange={(e) => { setTerm(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
        />
      </div>
      {open && term && (
        <div className="absolute z-10 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-line bg-paper-50 shadow-lg">
          {loading && <p className="px-3 py-2 text-sm text-ink-500">Buscando…</p>}
          {!loading && variants.length === 0 && <p className="px-3 py-2 text-sm text-ink-500">Sin resultados.</p>}
          {variants.map((v) => (
            <button
              type="button"
              key={v.id}
              className="flex w-full items-center justify-between gap-3 border-b border-line px-3 py-2 text-left text-sm last:border-0 hover:bg-paper-100"
              onClick={() => { onPick(v); setTerm(""); setOpen(false); }}
            >
              <div className="min-w-0">
                <p className="truncate text-ink-900">{v.title}</p>
                <p className="text-xs text-ink-500">
                  {v.variante1Nombre}: {v.variante1Valor}
                  {v.variante2Nombre ? ` · ${v.variante2Nombre}: ${v.variante2Valor}` : ""}
                  {" · "}<span className="font-mono">{v.sku}</span>
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-medium text-ink-900">{formatCurrency(v.precioMinorista)}</p>
                <p className={`text-xs ${v.stock === 0 ? "text-brick-500" : "text-ink-500"}`}>{v.stock} en stock</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
