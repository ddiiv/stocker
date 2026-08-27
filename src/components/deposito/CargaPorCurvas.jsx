import { useState } from "react";
import { Layers, X, Loader2, Search } from "lucide-react";
import { http } from "../../lib/http";
import { fetchCurva } from "../../services/depositoService";
import { mensajeDeError } from "../../utils/errores";

/*
 * Carga por curvas.
 *
 * La mercadería no llega en unidades sueltas: llega en corridas. "20 curvas de
 * pantalón negro" son 20 de cada talle de ese color — con 5 talles, 100
 * unidades. Cargarlo talle por talle es escribir cinco líneas para decir una
 * sola cosa, y con veinte modelos por camión es donde aparecen los errores.
 *
 * El recorrido es el del depósito: se busca el producto, salen los colores, se
 * elige uno y se dice cuántas curvas entran. El total se muestra ANTES de
 * agregar, porque "20 curvas" no dice cuántas unidades son hasta saber cuántos
 * talles tiene el modelo.
 */
export default function CargaPorCurvas({ onAgregar }) {
  const [texto, setTexto] = useState("");
  const [resultados, setResultados] = useState([]);
  const [buscando, setBuscando] = useState(false);
  const [error, setError] = useState("");

  const [producto, setProducto] = useState(null);   // { id, titulo }
  const [curva, setCurva] = useState(null);         // respuesta de fetchCurva
  const [color, setColor] = useState("");
  const [cantidad, setCantidad] = useState(1);
  const [porTalle, setPorTalle] = useState(null);   // null = pareja

  async function buscar(e) {
    e?.preventDefault?.();
    const q = texto.trim();
    if (q.length < 2) return;
    setBuscando(true); setError("");
    try {
      const { data } = await http.get("/products/buscar-variantes", { params: { q, limit: 40 } });
      const r = data.data || data || [];
      /*
       * Se busca por variante pero se elige el PRODUCTO: la curva es del modelo
       * entero, no de un talle. Se agrupa por producto para no mostrar nueve
       * veces el mismo pantalón.
       */
      const porProducto = new Map();
      for (const v of r || []) {
        if (v.esFeria) continue;  // los de evento no llevan stock
        if (!porProducto.has(v.productId)) {
          porProducto.set(v.productId, { id: v.productId, titulo: v.titulo, sku: v.skuAgrupador });
        }
      }
      setResultados([...porProducto.values()].slice(0, 8));
    } catch (err) {
      setError(mensajeDeError(err, "No se pudo buscar."));
    } finally {
      setBuscando(false);
    }
  }

  async function elegirProducto(p, valor = "") {
    setError("");
    try {
      const c = await fetchCurva({ productId: p.id, valor });
      setProducto(p);
      setCurva(c);
      setColor(c.necesitaValor ? "" : (c.fijo || ""));
      setPorTalle(null);
      setCantidad(1);
      setResultados([]);
      setTexto("");
    } catch (err) {
      setError(mensajeDeError(err, "No se pudo abrir la curva de ese producto."));
    }
  }

  const talles = curva?.valores || [];
  const unidades = porTalle
    ? Object.values(porTalle).reduce((s, n) => s + (Number(n) || 0), 0)
    : talles.length * (Number(cantidad) || 0);

  function agregar() {
    if (!producto || !talles.length) return;
    onAgregar({
      productId: producto.id,
      valor: color || undefined,
      ...(porTalle
        ? { porValor: Object.fromEntries(Object.entries(porTalle).map(([k, v]) => [k, Number(v) || 0])) }
        : { cantidad: Number(cantidad) || 0 }),
      // Sólo para mostrarlo en la lista antes de guardar.
      _resumen: {
        titulo: producto.titulo, color: color || null,
        talles: talles.length, unidades,
      },
    });
    setProducto(null); setCurva(null); setColor(""); setPorTalle(null); setCantidad(1);
  }

  return (
    <div className="rounded-md border border-line bg-paper-50 p-3">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-600">
        <Layers size={13} className="mr-1 inline" /> Cargar por curvas
      </p>

      {error && <p className="mb-2 rounded-md bg-brick-50 px-2 py-1.5 text-xs text-brick-500">{error}</p>}

      {!producto ? (
        <>
          <form onSubmit={buscar} className="flex gap-2">
            <input
              className="input flex-1 py-1 text-sm"
              placeholder="Buscar el modelo por título o SKU…"
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
            />
            <button className="btn-ghost py-1 text-xs" type="submit" disabled={buscando}>
              {buscando ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} Buscar
            </button>
          </form>

          {resultados.length > 0 && (
            <ul className="mt-2 divide-y divide-line rounded-md border border-line bg-paper-50">
              {resultados.map((p) => (
                <li key={p.id}>
                  <button
                    className="flex w-full items-baseline justify-between px-3 py-2 text-left text-sm hover:bg-paper-200"
                    onClick={() => elegirProducto(p)}
                  >
                    <span className="text-ink-900">{p.titulo}</span>
                    <span className="font-mono text-xs text-ink-500">{p.sku}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <div>
          <div className="mb-3 flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-ink-950">{producto.titulo}</p>
              {curva?.fijo && (
                <p className="text-xs text-ink-500">{curva.eje}: corrida de {talles.length} valores</p>
              )}
            </div>
            <button
              className="rounded p-1 text-ink-600 hover:bg-paper-200"
              onClick={() => { setProducto(null); setCurva(null); }}
              aria-label="Elegir otro producto"
            >
              <X size={15} />
            </button>
          </div>

          {/* Paso 2: salen los colores. */}
          {curva?.necesitaValor ? (
            <>
              <p className="mb-2 text-xs text-ink-600">Elegí {String(curva.ejeFijo).toLowerCase()}:</p>
              <div className="flex flex-wrap gap-1">
                {(curva.opciones || []).map((o) => (
                  <button
                    key={o}
                    className="rounded border border-line px-2 py-1 text-xs text-ink-700 hover:bg-paper-200"
                    onClick={() => elegirProducto(producto, o)}
                  >
                    {o}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-end gap-3">
                <div>
                  <label className="label" htmlFor="curva-cant">Curvas</label>
                  <input
                    id="curva-cant"
                    className="input w-24 py-1 text-sm"
                    type="number" min="0" step="1"
                    value={cantidad}
                    disabled={Boolean(porTalle)}
                    onChange={(e) => setCantidad(e.target.value)}
                  />
                </div>
                <p className="pb-1 text-xs text-ink-600">
                  × {talles.length} {String(curva.eje).toLowerCase()}s ={" "}
                  <strong className="text-ink-950">{unidades} unidades</strong>
                </p>
                <button
                  className="btn-ghost ml-auto py-1 text-xs"
                  onClick={() => setPorTalle(
                    porTalle ? null : Object.fromEntries(talles.map((v) => [v.valor, Number(cantidad) || 0])),
                  )}
                >
                  {porTalle ? "Volver a curva pareja" : "Repartir distinto"}
                </button>
              </div>

              {/* La curva despareja: 1-2-2-1 en S-M-L-XL es como viene de verdad. */}
              {porTalle && (
                <div className="mb-3 flex flex-wrap gap-2">
                  {talles.map((v) => (
                    <div key={v.variantId}>
                      <label className="label text-[10px]" htmlFor={`t-${v.variantId}`}>{v.valor}</label>
                      <input
                        id={`t-${v.variantId}`}
                        className="input w-16 py-1 text-sm"
                        type="number" min="0" step="1"
                        value={porTalle[v.valor] ?? 0}
                        onChange={(e) => setPorTalle({ ...porTalle, [v.valor]: e.target.value })}
                      />
                    </div>
                  ))}
                </div>
              )}

              <button className="btn-accent py-1 text-sm" onClick={agregar} disabled={unidades <= 0}>
                Agregar {unidades} unidad{unidades === 1 ? "" : "es"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
