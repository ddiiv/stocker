import { useEffect, useRef, useState } from "react";
import { Search, Trash2, Plus, Minus } from "lucide-react";
import { http } from "../../lib/http";

/*
 * Elegir artículos y cantidades.
 *
 * Lo usan el ingreso de mercadería y el pedido de reposición: los dos son "una
 * lista de variantes con un número al lado", y tenerlo dos veces garantizaba
 * que se comportaran distinto en el detalle que importa —el escaneo—.
 *
 * Pega contra /products/buscar-variantes, que busca a nivel variante: se puede
 * tipear "buzo beige m" o pegar el SKU del lector. Con lector, el código entra
 * tipeado y termina en Enter: si hay un único resultado, ese Enter lo agrega y
 * suma una unidad si ya estaba en la lista. Contando bultos eso es lo único
 * que hace usable la pantalla.
 */
export default function SelectorArticulos({ items, onChange, etiquetaCantidad = "Cantidad", locationId = null }) {
  const [term, setTerm] = useState("");
  const [resultados, setResultados] = useState([]);
  const [abierto, setAbierto] = useState(false);
  const [buscando, setBuscando] = useState(false);
  const [activo, setActivo] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    const q = term.trim();
    if (q.length < 2) { setResultados([]); setBuscando(false); return; }
    setBuscando(true);
    const t = setTimeout(async () => {
      try {
        const { data } = await http.get("/products/buscar-variantes", {
          // Sin productos de evento: no llevan stock, así que no se pueden
          // ingresar al depósito. Verlos acá es invitar a cargar algo que
          // después no se va a poder mover.
          params: { q, limit: 20, sinEvento: 1, ...(locationId ? { locationId } : {}) },
        });
        setResultados(data.data || []);
        setActivo(0);
      } catch { setResultados([]); }
      setBuscando(false);
    }, 250);
    return () => clearTimeout(t);
  }, [term, locationId]);

  function agregar(v) {
    const yaEsta = items.find((i) => i.productVariantId === v.id);
    if (yaEsta) {
      // Repetido: suma una unidad. Escaneando la misma prenda dos veces se
      // quiere contar dos, no crear dos renglones iguales.
      onChange(items.map((i) => (i.productVariantId === v.id ? { ...i, cantidad: i.cantidad + 1 } : i)));
    } else {
      onChange([...items, {
        productVariantId: v.id,
        sku: v.sku,
        titulo: v.titulo,
        variante: [v.variante1Valor, v.variante2Valor].filter(Boolean).join(" · "),
        enLocal: v.enLocal,
        cantidad: 1,
      }]);
    }
    setTerm("");
    setResultados([]);
    setAbierto(false);
    inputRef.current?.focus();
  }

  function onKeyDown(e) {
    if (!abierto || resultados.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActivo((i) => Math.min(i + 1, resultados.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActivo((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); agregar(resultados[activo] || resultados[0]); }
    else if (e.key === "Escape") setAbierto(false);
  }

  const cambiar = (id, cantidad) =>
    onChange(items.map((i) => (i.productVariantId === id ? { ...i, cantidad: Math.max(0, cantidad) } : i)));
  const quitar = (id) => onChange(items.filter((i) => i.productVariantId !== id));

  const totalUnidades = items.reduce((s, i) => s + (Number(i.cantidad) || 0), 0);

  return (
    <div>
      <div className="relative">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
        <input
          ref={inputRef}
          className="input pl-9"
          placeholder="Escaneá el código o buscá por SKU, título, color y talle…"
          value={term}
          onChange={(e) => { setTerm(e.target.value); setAbierto(true); }}
          onFocus={() => setAbierto(true)}
          onBlur={() => setTimeout(() => setAbierto(false), 120)}
          onKeyDown={onKeyDown}
          autoComplete="off"
        />
        {abierto && term.trim().length >= 2 && (
          <div className="absolute z-10 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-line bg-paper-50 shadow-lg">
            {buscando && <p className="px-3 py-2 text-sm text-ink-500">Buscando…</p>}
            {!buscando && resultados.length === 0 && (
              <p className="px-3 py-2 text-sm text-ink-500">Sin resultados para “{term.trim()}”.</p>
            )}
            {!buscando && resultados.map((v, i) => (
              <button
                type="button"
                key={v.id}
                onMouseEnter={() => setActivo(i)}
                onClick={() => agregar(v)}
                className={`flex w-full items-center justify-between gap-3 border-b border-line px-3 py-2 text-left text-sm last:border-0 ${i === activo ? "bg-paper-100" : ""}`}
              >
                <div className="min-w-0">
                  <p className="truncate text-ink-900">{v.titulo}</p>
                  <p className="truncate text-xs text-ink-500">
                    {[v.variante1Valor, v.variante2Valor].filter(Boolean).join(" · ")}
                    {" · "}<span className="font-mono">{v.sku}</span>
                  </p>
                </div>
                <span className="shrink-0 text-xs text-ink-500">
                  {v.enLocal !== null && v.enLocal !== undefined ? `${v.enLocal} acá` : `${v.stock} total`}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-3 overflow-x-auto">
        {items.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-500">Todavía no agregaste artículos.</p>
        ) : (
          <table className="w-full min-w-[480px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-600">
                <th className="py-2 font-medium">Artículo</th>
                {locationId ? <th className="py-2 font-medium text-right">Hay</th> : null}
                <th className="py-2 font-medium text-center">{etiquetaCantidad}</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.productVariantId} className="border-b border-line last:border-0">
                  <td className="py-2">
                    <p className="text-ink-900">{i.titulo}</p>
                    <p className="text-xs text-ink-500">
                      {i.variante}{i.variante ? " · " : ""}<span className="font-mono">{i.sku}</span>
                    </p>
                  </td>
                  {locationId ? (
                    <td className="py-2 text-right text-xs text-ink-500">{i.enLocal ?? "—"}</td>
                  ) : null}
                  <td className="py-2">
                    <div className="flex items-center justify-center gap-1">
                      <button type="button" className="btn-ghost px-1.5 py-1" onClick={() => cambiar(i.productVariantId, i.cantidad - 1)}>
                        <Minus size={13} />
                      </button>
                      <input
                        type="number"
                        min="0"
                        className="input w-20 py-1 text-center"
                        value={i.cantidad}
                        onChange={(e) => cambiar(i.productVariantId, Number(e.target.value))}
                      />
                      <button type="button" className="btn-ghost px-1.5 py-1" onClick={() => cambiar(i.productVariantId, i.cantidad + 1)}>
                        <Plus size={13} />
                      </button>
                    </div>
                  </td>
                  <td className="py-2 text-right">
                    <button type="button" className="btn-ghost px-1.5 py-1 text-brick-500" onClick={() => quitar(i.productVariantId)}>
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {items.length > 0 && (
        <p className="mt-2 text-right text-xs text-ink-600">
          {items.length} artículo{items.length === 1 ? "" : "s"} ·{" "}
          <strong className="text-ink-900">{totalUnidades}</strong> unidad{totalUnidades === 1 ? "" : "es"}
        </p>
      )}
    </div>
  );
}
