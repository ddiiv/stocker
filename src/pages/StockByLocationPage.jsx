import { useCallback, useEffect, useState } from "react";
import { Boxes, Search, ArrowLeftRight, Loader2, AlertTriangle, Check, ChevronRight, ChevronDown, Store } from "lucide-react";
import { fetchProductosPorLocal, fetchVariantesPorLocal, transferirStock } from "../services/productService";
import { PageHeader, Card, EmptyState } from "../components/ui/Layout";
import StockTabs from "../components/stock/StockTabs";
import { ordenarVariantes, CRITERIOS } from "../utils/ordenVariantes";
import { GrupoFiltro, OpcionFiltro } from "../components/ui/Filtros";
import Modal from "../components/ui/Modal";

/*
 * Stock por local, en dos niveles.
 *
 * Primero se elige el local y se ven los PRODUCTOS: cuánto hay de cada uno acá
 * y cuánto entre todos los locales. Recién al abrir uno aparecen sus variantes
 * con el desglose completo.
 *
 * La versión anterior mostraba todas las variantes de todo el catálogo con una
 * columna por local: cuatrocientas filas para responder "¿qué tengo en
 * Belgrano?". El dato estaba, pero encontrarlo era el problema.
 */

export default function StockByLocationPage() {
  const [locales, setLocales] = useState([]);
  const [local, setLocal] = useState("");
  const [texto, setTexto] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [filtro, setFiltro] = useState("");         // "" | conStock | sinStock
  const [productos, setProductos] = useState([]);
  const [abierto, setAbierto] = useState(null);     // productId desplegado
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");
  const [transferir, setTransferir] = useState(null);
  const [recargar, setRecargar] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setBusqueda(texto), 350);
    return () => clearTimeout(t);
  }, [texto]);

  const cargar = useCallback(() => {
    setCargando(true); setError("");
    fetchProductosPorLocal({ locationId: local, q: busqueda })
      .then((d) => {
        setProductos(d.data);
        setLocales(d.locales);
        // Con un solo local no hay nada que elegir.
        if (!local && d.locales.length === 1) setLocal(String(d.locales[0].id));
      })
      .catch((e) => setError(e.response?.data?.message || "No se pudo cargar el stock."))
      .finally(() => setCargando(false));
  }, [local, busqueda]);

  useEffect(() => { cargar(); }, [cargar, recargar]);

  const nombreLocal = locales.find((l) => String(l.id) === String(local))?.nombre;

  const visibles = productos.filter((p) => {
    if (filtro === "conStock") return local ? p.enLocal > 0 : p.total > 0;
    if (filtro === "sinStock")  return local ? p.enLocal === 0 : p.total === 0;
    return true;
  });

  const sumaLocal = visibles.reduce((s, p) => s + (p.enLocal || 0), 0);
  const sumaTotal = visibles.reduce((s, p) => s + p.total, 0);

  return (
    <div>
      <PageHeader title="Stock" subtitle="Elegí un local y mirá qué hay en él" />
      <StockTabs />

      {/* Elegir local: es la primera decisión, así que va arriba y grande. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-paper-50 p-1">
          <button
            onClick={() => setLocal("")}
            aria-pressed={local === ""}
            className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
              local === "" ? "bg-ink-950 text-paper-50" : "text-ink-600 hover:bg-paper-200"
            }`}
          >
            <Boxes size={13} /> Todos
          </button>
          {locales.map((l) => (
            <button
              key={l.id}
              onClick={() => { setLocal(String(l.id)); setAbierto(null); }}
              aria-pressed={String(local) === String(l.id)}
              className={`flex items-center gap-1.5 whitespace-nowrap rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                String(local) === String(l.id) ? "bg-ink-950 text-paper-50" : "text-ink-600 hover:bg-paper-200"
              }`}
            >
              <Store size={13} /> {l.nombre}
              {!l.activo && <span className="text-ink-400">(inactivo)</span>}
            </button>
          ))}
        </div>

        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-500" />
          <input className="input w-56 py-1.5 pl-8 text-xs" placeholder="Producto, SKU o categoría"
            value={texto} onChange={(e) => setTexto(e.target.value)} />
        </div>

        <GrupoFiltro>
          <OpcionFiltro activa={filtro === ""} onClick={() => setFiltro("")}>Todo</OpcionFiltro>
          <OpcionFiltro activa={filtro === "conStock"} onClick={() => setFiltro("conStock")}>Con stock</OpcionFiltro>
          <OpcionFiltro activa={filtro === "sinStock"} onClick={() => setFiltro("sinStock")}>Sin stock</OpcionFiltro>
        </GrupoFiltro>
      </div>

      {error && (
        <p className="mb-4 flex items-center gap-2 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-600">
          <AlertTriangle size={15} /> {error}
        </p>
      )}

      {/* Cierre de lo que se está viendo */}
      {!cargando && visibles.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-x-8 gap-y-2 rounded-md border border-line bg-paper-50 px-4 py-3">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-ink-600">
              {local ? `En ${nombreLocal}` : "En todos los locales"}
            </p>
            <p className="font-display text-lg font-semibold tabular-nums text-ink-950">
              {local ? sumaLocal : sumaTotal} <span className="text-sm font-normal text-ink-600">unidades</span>
            </p>
          </div>
          {local && (
            <div>
              <p className="text-[11px] uppercase tracking-wide text-ink-600">Total del negocio</p>
              <p className="text-sm tabular-nums text-ink-900">
                {sumaTotal} <span className="text-ink-500">en {locales.length} locales</span>
              </p>
            </div>
          )}
          <div>
            <p className="text-[11px] uppercase tracking-wide text-ink-600">Productos</p>
            <p className="text-sm tabular-nums text-ink-900">{visibles.length}</p>
          </div>
        </div>
      )}

      {cargando ? (
        <div className="card h-64 animate-pulse bg-paper-200/60" />
      ) : visibles.length === 0 ? (
        <EmptyState icon={Boxes} title="Sin resultados"
          description={busqueda || filtro ? "Probá quitar algún filtro." : "Todavía no cargaste productos."} />
      ) : (
        <div className="space-y-2">
          {visibles.map((p) => (
            <FilaProducto
              key={p.productId}
              producto={p}
              local={local}
              nombreLocal={nombreLocal}
              abierto={abierto === p.productId}
              onAbrir={() => setAbierto(abierto === p.productId ? null : p.productId)}
              onTransferir={setTransferir}
              recargar={recargar}
            />
          ))}
        </div>
      )}

      <TransferirModal
        variante={transferir}
        locales={locales}
        onClose={() => setTransferir(null)}
        onHecho={() => { setTransferir(null); setRecargar((n) => n + 1); }}
      />
    </div>
  );
}

/*
 * Un producto padre: su stock en el local elegido, su total, y al desplegarlo
 * el detalle por variante.
 *
 * Las variantes se piden recién al abrir. Traerlas todas de entrada serían
 * cientos de filas que casi nunca se miran.
 */
function FilaProducto({ producto: p, local, nombreLocal, abierto, onAbrir, onTransferir, recargar }) {
  const [detalle, setDetalle] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [orden, setOrden] = useState("talle");

  useEffect(() => {
    if (!abierto) return;
    setCargando(true);
    fetchVariantesPorLocal(p.productId)
      .then(setDetalle)
      .catch(() => setDetalle(null))
      .finally(() => setCargando(false));
  }, [abierto, p.productId, recargar]);

  const enLocal = p.enLocal;
  const soloAca = local && enLocal === p.total;

  return (
    <Card className="p-0">
      <button onClick={onAbrir} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-paper-100">
        {abierto ? <ChevronDown size={16} className="shrink-0 text-ink-500" /> : <ChevronRight size={16} className="shrink-0 text-ink-500" />}

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink-950">{p.titulo}</p>
          <p className="truncate text-xs text-ink-500">
            <span className="tag-chip">{p.skuAgrupador}</span>
            {p.categoria && <span className="ml-2">{p.categoria}</span>}
            <span className="ml-2">{p.variantes} variantes</span>
          </p>
        </div>

        {local ? (
          <>
            <div className="text-right">
              <p className="text-[11px] uppercase tracking-wide text-ink-600">{nombreLocal}</p>
              <p className={`font-display text-lg font-semibold tabular-nums ${enLocal === 0 ? "text-ink-300" : "text-ink-950"}`}>
                {enLocal}
              </p>
            </div>
            {/* El total va siempre al lado: es lo que dice si lo que falta acá
                está en otro local o no existe en el negocio. */}
            <div className="w-20 text-right">
              <p className="text-[11px] uppercase tracking-wide text-ink-600">Total</p>
              <p className="text-sm tabular-nums text-ink-700">
                {p.total}
                {soloAca && <span className="ml-1 text-[10px] text-ink-400">todo acá</span>}
              </p>
            </div>
          </>
        ) : (
          <div className="text-right">
            <p className="text-[11px] uppercase tracking-wide text-ink-600">Total</p>
            <p className="font-display text-lg font-semibold tabular-nums text-ink-950">{p.total}</p>
          </div>
        )}
      </button>

      {abierto && (
        <div className="border-t border-line">
          {cargando ? (
            <div className="h-24 animate-pulse bg-paper-200/40" />
          ) : !detalle ? (
            <p className="px-4 py-6 text-center text-sm text-ink-600">No se pudo cargar el detalle.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 px-4 py-2">
                <span className="text-xs text-ink-600">Ordenar</span>
                <GrupoFiltro>
                  {CRITERIOS.map((c) => (
                    <OpcionFiltro key={c.value} activa={orden === c.value} onClick={() => setOrden(c.value)}>
                      {c.label}
                    </OpcionFiltro>
                  ))}
                </GrupoFiltro>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm" style={{ minWidth: `${340 + detalle.locales.length * 110}px` }}>
                  <thead>
                    <tr className="border-y border-line bg-paper-100 text-left text-xs uppercase tracking-wide text-ink-600">
                      <th className="px-4 py-2 font-medium">Variante</th>
                      <th className="px-2 py-2 font-medium">SKU</th>
                      {detalle.locales.map((l) => (
                        <th key={l.id} className={`px-2 py-2 text-right font-medium ${String(l.id) === String(local) ? "text-ink-950" : ""}`}>
                          {l.nombre}
                        </th>
                      ))}
                      <th className="px-3 py-2 text-right font-medium">Total</th>
                      <th className="px-4 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {ordenarVariantes(detalle.variantes, orden).map((v) => {
                      const bajo = v.total <= (v.stockMinimo ?? 0);
                      return (
                        <tr key={v.variantId} className="border-b border-line last:border-0">
                          <td className="whitespace-nowrap px-4 py-2 text-ink-800">
                            {[v.variante1Valor, v.variante2Valor].filter(Boolean).join(" · ") || <span className="text-ink-400">—</span>}
                          </td>
                          <td className="px-2 py-2"><span className="tag-chip">{v.sku}</span></td>
                          {detalle.locales.map((l) => {
                            const n = v.porLocal.find((x) => x.locationId === l.id)?.stock || 0;
                            const esElElegido = String(l.id) === String(local);
                            return (
                              <td key={l.id} className={`px-2 py-2 text-right tabular-nums ${esElElegido ? "bg-paper-100" : ""}`}>
                                <span className={n === 0 ? "text-ink-300" : esElElegido ? "font-semibold text-ink-950" : "text-ink-700"}>{n}</span>
                              </td>
                            );
                          })}
                          <td className="px-3 py-2 text-right">
                            <span className={`font-display font-semibold tabular-nums ${bajo ? "text-brick-500" : "text-ink-950"}`}>{v.total}</span>
                            {bajo && <span className="ml-1 text-[10px] uppercase text-brick-500">mín {v.stockMinimo}</span>}
                          </td>
                          <td className="px-4 py-2 text-right">
                            {detalle.locales.length > 1 && v.total > 0 && (
                              <button className="btn-ghost px-2 py-1 text-xs" title="Transferir entre locales"
                                onClick={() => onTransferir({ ...v, titulo: detalle.producto.titulo })}>
                                <ArrowLeftRight size={13} />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

/*
 * Transferencia entre locales.
 *
 * El origen sólo ofrece locales que tienen stock: ofrecer uno vacío es ofrecer
 * un error. El máximo se ata a lo que hay en el origen, que es la restricción
 * que el backend va a aplicar igual.
 */
function TransferirModal({ variante, locales, onClose, onHecho }) {
  const [desde, setDesde] = useState("");
  const [hacia, setHacia] = useState("");
  const [cantidad, setCantidad] = useState(1);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState("");

  const conStock = (variante?.porLocal || []).filter((p) => p.stock > 0);
  const disponible = conStock.find((p) => String(p.locationId) === String(desde))?.stock ?? 0;

  useEffect(() => {
    if (!variante) return;
    const primero = (variante.porLocal || []).filter((p) => p.stock > 0)[0]?.locationId;
    setDesde(primero ? String(primero) : "");
    setHacia(""); setCantidad(1); setError("");
  }, [variante]);

  async function enviar(e) {
    e.preventDefault();
    setError("");
    if (!desde || !hacia) { setError("Elegí desde y hacia qué local."); return; }
    setGuardando(true);
    try {
      await transferirStock({
        variantId: variante.variantId,
        desde: Number(desde), hacia: Number(hacia),
        cantidad: Number(cantidad),
      });
      onHecho();
    } catch (err) {
      setError(err.response?.data?.message || "No se pudo transferir.");
    } finally { setGuardando(false); }
  }

  if (!variante) return null;

  return (
    <Modal open={!!variante} onClose={onClose} title={`Transferir — ${variante.sku}`}>
      <form onSubmit={enviar} className="space-y-4">
        {error && <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}

        <p className="rounded-md bg-paper-100 px-3 py-2 text-xs text-ink-600">
          {variante.titulo}
          {[variante.variante1Valor, variante.variante2Valor].filter(Boolean).length > 0 &&
            ` · ${[variante.variante1Valor, variante.variante2Valor].filter(Boolean).join(" · ")}`}
        </p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="label">Desde</label>
            <select className="input" value={desde} onChange={(e) => setDesde(e.target.value)}>
              <option value="">Elegir…</option>
              {conStock.map((p) => <option key={p.locationId} value={p.locationId}>{p.local} ({p.stock})</option>)}
            </select>
          </div>
          <div>
            <label className="label">Hacia</label>
            <select className="input" value={hacia} onChange={(e) => setHacia(e.target.value)}>
              <option value="">Elegir…</option>
              {locales.filter((l) => String(l.id) !== String(desde)).map((l) => (
                <option key={l.id} value={l.id}>{l.nombre}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="label">Cantidad</label>
          <input type="number" min="1" max={disponible || 1} className="input" value={cantidad}
            onChange={(e) => setCantidad(e.target.value)} />
          <p className="mt-1 text-xs text-ink-500">
            {desde ? `Hay ${disponible} en el local de origen.` : "Elegí el local de origen."}
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn-accent"
            disabled={guardando || !desde || !hacia || Number(cantidad) < 1 || Number(cantidad) > disponible}>
            {guardando ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
            {guardando ? "Transfiriendo…" : "Transferir"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
