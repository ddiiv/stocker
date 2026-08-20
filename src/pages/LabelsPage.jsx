import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Tag, Printer, RotateCcw, Search, Loader2, AlertTriangle, PackagePlus, Info } from "lucide-react";
import { fetchProductGroups, generarEtiquetas, fetchIngresosDelDia } from "../services/productService";
import { fetchPos } from "../services/employeeService";
import { PageHeader, Card, EmptyState } from "../components/ui/Layout";
import StockTabs from "../components/stock/StockTabs";
import { GrupoFiltro, OpcionFiltro } from "../components/ui/Filtros";
import { ordenarVariantes, CRITERIOS } from "../utils/ordenVariantes";

/*
 * Generación de etiquetas de góndola.
 *
 * La cantidad por variante arranca en su stock: el caso normal es etiquetar lo
 * que hay en el depósito, una etiqueta por prenda. Pero es editable porque al
 * recibir mercadería se imprime por lo que entró, que todavía no está cargado,
 * y porque a veces se reponen las que se despegaron.
 *
 * Las variantes salen ordenadas por talle o por color: el rollo se imprime en
 * ese orden y así se pega recorriendo la percha sin ir y volver.
 */

export default function LabelsPage() {
  const [params, setParams] = useSearchParams();
  const [grupos, setGrupos] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [busqueda, setBusqueda] = useState(params.get("producto") || "");
  const [texto, setTexto] = useState(params.get("producto") || "");
  const [orden, setOrden] = useState("talle");
  const [cantidades, setCantidades] = useState({});   // variantId → cantidad
  const [generando, setGenerando] = useState(false);
  const [error, setError] = useState("");

  // Etiquetar por lo que ENTRÓ un día, en vez de por lo que hay.
  const [fuente, setFuente] = useState("stock");     // stock | ingresos
  const [fecha, setFecha] = useState(() => new Date().toLocaleDateString("sv-SE"));
  const [localIngreso, setLocalIngreso] = useState("");
  const [locales, setLocales] = useState([]);
  const [resumenIngresos, setResumenIngresos] = useState(null);
  const [cargandoIngresos, setCargandoIngresos] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setBusqueda(texto);
      // La búsqueda queda en la URL: así el botón "Etiquetas" del producto
      // abre esta pantalla ya filtrada, y el enlace se puede compartir.
      setParams(texto ? { producto: texto } : {}, { replace: true });
    }, 350);
    return () => clearTimeout(t);
  }, [texto, setParams]);

  const cargar = useCallback(() => {
    setCargando(true); setError("");
    fetchProductGroups({ search: busqueda })
      .then((g) => {
        setGrupos(g);
        // Al cargar, cada variante arranca con su stock. Es lo que se quiere
        // el 90 % de las veces y evita tipear cantidad por cantidad.
        setCantidades((previas) => {
          const next = { ...previas };
          for (const grupo of g) {
            for (const v of grupo.variants) {
              if (next[v.id] === undefined) next[v.id] = Math.max(0, v.stock || 0);
            }
          }
          return next;
        });
      })
      .catch((e) => setError(e.response?.data?.message || "No se pudieron cargar los productos."))
      .finally(() => setCargando(false));
  }, [busqueda]);

  useEffect(() => { cargar(); }, [cargar]);

  useEffect(() => { fetchPos().then(setLocales).catch(() => {}); }, []);

  /*
   * Carga las cantidades desde los ingresos del día elegido.
   *
   * Es el caso de recibir mercadería: se necesita una etiqueta por unidad que
   * ENTRÓ, no por unidad que hay. Con 20 en el local y 6 recibidas, etiquetar
   * por stock imprime 26 y hay que despegar 20.
   *
   * Todo lo que no entró ese día se pone en cero: si quedara con su stock, el
   * lote mezclaría la mercadería nueva con la que ya estaba etiquetada.
   */
  async function cargarIngresos() {
    setCargandoIngresos(true); setError("");
    try {
      const r = await fetchIngresosDelDia({ fecha, locationId: localIngreso || null });
      const porVariante = new Map(r.data.map((x) => [x.variantId, x.unidades]));
      setCantidades(() => {
        const next = {};
        for (const g of grupos) for (const v of g.variants) next[v.id] = porVariante.get(v.id) || 0;
        return next;
      });
      setResumenIngresos(r);
      if (r.data.length === 0) {
        setError(`No entró mercadería el ${fecha}${localIngreso ? " en ese local" : ""}.`);
      }
    } catch (e) {
      setError(e.response?.data?.message || "No se pudieron cargar los ingresos del día.");
    } finally {
      setCargandoIngresos(false);
    }
  }

  const items = useMemo(() => {
    const out = [];
    for (const g of grupos) {
      for (const v of ordenarVariantes(g.variants, orden)) {
        const cantidad = Number(cantidades[v.id]) || 0;
        if (cantidad > 0) out.push({ variantId: v.id, cantidad });
      }
    }
    return out;
  }, [grupos, cantidades, orden]);

  const total = items.reduce((s, i) => s + i.cantidad, 0);

  function poner(id, valor) {
    const n = Math.max(0, Math.min(999, Math.floor(Number(valor) || 0)));
    setCantidades((c) => ({ ...c, [id]: n }));
    setError("");
  }

  function usarStock(grupo) {
    setCantidades((c) => {
      const next = { ...c };
      for (const v of grupo.variants) next[v.id] = Math.max(0, v.stock || 0);
      return next;
    });
  }

  function vaciar(grupo) {
    setCantidades((c) => {
      const next = { ...c };
      for (const v of grupo.variants) next[v.id] = 0;
      return next;
    });
  }

  async function generar(soloGrupo = null) {
    const pedido = soloGrupo
      ? ordenarVariantes(soloGrupo.variants, orden)
          .map((v) => ({ variantId: v.id, cantidad: Number(cantidades[v.id]) || 0 }))
          .filter((x) => x.cantidad > 0)
      : items;

    if (!pedido.length) { setError("No hay ninguna etiqueta para generar: todas las cantidades están en cero."); return; }

    setGenerando(true); setError("");
    try {
      const blob = await generarEtiquetas(pedido);
      // Descarga directa: el PDF es de un solo uso, va a la impresora y se
      // descarta. Guardarlo en el servidor sería juntar basura.
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `etiquetas-${soloGrupo?.skuAgrupador || "lote"}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message || e.response?.data?.message || "No se pudieron generar las etiquetas.");
    } finally {
      setGenerando(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Stock"
        subtitle="Etiquetas de 50 × 25 mm con código de barras, una por unidad"
        actions={
          <button className="btn btn-primary" onClick={() => generar()} disabled={generando || total === 0}>
            {generando ? <Loader2 size={15} className="animate-spin" /> : <Printer size={15} />}
            {generando ? "Generando…" : `Generar ${total || ""} etiqueta${total === 1 ? "" : "s"}`}
          </button>
        }
      />
      <StockTabs />

      {/* De dónde salen las cantidades */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <GrupoFiltro>
          <OpcionFiltro activa={fuente === "stock"} onClick={() => { setFuente("stock"); setResumenIngresos(null); }}>
            Por stock actual
          </OpcionFiltro>
          <OpcionFiltro activa={fuente === "ingresos"} onClick={() => setFuente("ingresos")}>
            Por lo que entró
          </OpcionFiltro>
        </GrupoFiltro>

        {fuente === "ingresos" && (
          <>
            <input type="date" className="input w-auto py-1.5 text-xs" value={fecha}
              onChange={(e) => setFecha(e.target.value)} />
            {locales.length > 1 && (
              <select className="input w-auto py-1.5 text-xs" value={localIngreso}
                onChange={(e) => setLocalIngreso(e.target.value)}>
                <option value="">Todos los locales</option>
                {locales.map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
              </select>
            )}
            <button className="btn-accent text-xs" onClick={cargarIngresos} disabled={cargandoIngresos}>
              {cargandoIngresos ? <Loader2 size={13} className="animate-spin" /> : <PackagePlus size={13} />}
              {cargandoIngresos ? "Buscando…" : "Cargar ese día"}
            </button>
          </>
        )}
      </div>

      {resumenIngresos && resumenIngresos.data.length > 0 && (
        <p className="mb-4 flex items-start gap-2 rounded-md bg-teal-50 px-3 py-2 text-sm text-teal-700">
          <Info size={15} className="mt-0.5 shrink-0" />
          <span>
            El {resumenIngresos.fecha} entraron <strong>{resumenIngresos.totalUnidades} unidades</strong> en{" "}
            {resumenIngresos.data.length} variante{resumenIngresos.data.length === 1 ? "" : "s"}.
            Las cantidades de abajo quedaron cargadas con eso; el resto en cero.
          </span>
        </p>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-500" />
          <input className="input w-64 py-1.5 pl-8 text-xs" placeholder="Buscar producto o SKU"
            value={texto} onChange={(e) => setTexto(e.target.value)} />
        </div>
        <GrupoFiltro>
          {CRITERIOS.map((c) => (
            <OpcionFiltro key={c.value} activa={orden === c.value} onClick={() => setOrden(c.value)}>
              {c.label}
            </OpcionFiltro>
          ))}
        </GrupoFiltro>
        <span className="text-xs text-ink-600">
          {total > 0 ? `${total} etiqueta${total === 1 ? "" : "s"} en el lote` : "Sin etiquetas seleccionadas"}
        </span>
      </div>

      {error && (
        <p className="mb-4 flex items-start gap-2 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-600">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}
        </p>
      )}

      {cargando ? (
        <div className="card h-64 animate-pulse bg-paper-200/60" />
      ) : grupos.length === 0 ? (
        <EmptyState icon={Tag} title="No se encontraron productos"
          description={busqueda ? `Sin resultados para "${busqueda}".` : "Todavía no cargaste productos."} />
      ) : (
        <div className="space-y-4">
          {grupos.map((g) => {
            const variantes = ordenarVariantes(g.variants, orden);
            const delGrupo = variantes.reduce((s, v) => s + (Number(cantidades[v.id]) || 0), 0);
            return (
              <Card key={g.skuAgrupador} className="p-0">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-display text-sm font-semibold text-ink-950">{g.title}</p>
                    <p className="text-xs text-ink-600">
                      <span className="tag-chip">{g.skuAgrupador}</span>
                      <span className="ml-2">{variantes.length} variantes · {delGrupo} etiqueta{delGrupo === 1 ? "" : "s"}</span>
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button className="btn-ghost text-xs" onClick={() => usarStock(g)}>
                      <RotateCcw size={13} /> Usar stock
                    </button>
                    <button className="btn-ghost text-xs" onClick={() => vaciar(g)}>Vaciar</button>
                    <button className="btn-accent text-xs" disabled={generando || delGrupo === 0}
                      onClick={() => generar(g)}>
                      <Printer size={13} /> Generar este
                    </button>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead>
                      <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-600">
                        <th className="px-4 py-2 font-medium">SKU</th>
                        <th className="px-2 py-2 font-medium">Color</th>
                        <th className="px-2 py-2 font-medium">Talle</th>
                        <th className="px-2 py-2 text-right font-medium">Stock</th>
                        <th className="px-4 py-2 text-right font-medium">Etiquetas</th>
                      </tr>
                    </thead>
                    <tbody>
                      {variantes.map((v) => {
                        const cant = Number(cantidades[v.id]) || 0;
                        return (
                          <tr key={v.id} className="border-b border-line last:border-0">
                            <td className="px-4 py-2"><span className="tag-chip">{v.sku}</span></td>
                            <td className="px-2 py-2 text-ink-700">{v.variante1Valor || <span className="text-ink-400">—</span>}</td>
                            <td className="px-2 py-2 text-ink-700">{v.variante2Valor || <span className="text-ink-400">—</span>}</td>
                            <td className="px-2 py-2 text-right tabular-nums text-ink-600">{v.stock}</td>
                            <td className="px-4 py-2 text-right">
                              <input
                                type="number" min="0" max="999" inputMode="numeric"
                                className={`input h-8 w-20 text-right text-xs ${cant === 0 ? "text-ink-400" : ""}`}
                                value={cant}
                                onChange={(e) => poner(v.id, e.target.value)}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <p className="mt-4 text-xs text-ink-500">
        Cada etiqueta es una página de 50 × 25 mm, para rollo térmico. El código de barras lleva el
        código propio de la variante y, si no tiene, su SKU — los dos los resuelve el escáner.
      </p>
    </div>
  );
}
