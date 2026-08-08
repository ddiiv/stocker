import { useEffect, useMemo, useState } from "react";
import {
  PackageSearch, RefreshCw, ChevronDown, ChevronRight, Store,
  AlertTriangle, Search,
} from "lucide-react";
import { getProductMetrics } from "../services/metricsService";
import { formatCurrency } from "../utils/formatters";
import { PageHeader, Card, EmptyState } from "../components/ui/Layout";
import MetricsTabs from "../components/dashboard/MetricsTabs";

const ORDENES = [
  { value: "facturado", label: "Más facturado" },
  { value: "ganancia",  label: "Más ganancia" },
  { value: "unidades",  label: "Más unidades" },
  { value: "conversionPct", label: "Mayor conversión" },
  { value: "margenPct", label: "Mejor margen" },
  { value: "rotacionPct", label: "Mayor rotación" },
];

export default function ProductMetricsPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [orden, setOrden] = useState("facturado");
  const [busqueda, setBusqueda] = useState("");
  const [abierto, setAbierto] = useState(null);

  async function cargar() {
    setLoading(true); setError("");
    try {
      setData(await getProductMetrics());
    } catch (e) {
      setError(e.response?.data?.message || "No se pudieron cargar las métricas de productos");
    } finally { setLoading(false); }
  }

  useEffect(() => { cargar(); }, []);

  const productos = useMemo(() => {
    const lista = data?.productos || [];
    const filtrada = busqueda
      ? lista.filter((p) =>
          `${p.titulo} ${p.skuAgrupador} ${p.categoria || ""}`.toLowerCase().includes(busqueda.toLowerCase()))
      : lista;
    return [...filtrada].sort((a, b) => (b[orden] ?? 0) - (a[orden] ?? 0));
  }, [data, orden, busqueda]);

  if (loading) return (
    <div>
      <PageHeader title="Métricas" subtitle="Rendimiento de cada producto" />
      <MetricsTabs />
      <div className="card h-64 animate-pulse bg-paper-200/60" />
    </div>
  );

  return (
    <div>
      <PageHeader title="Métricas" subtitle="Rendimiento de cada producto: ventas, ganancia, conversión y locales" />
      <MetricsTabs />

      {error && <p className="mb-4 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}

      {/* Comparativa entre locales, independiente del producto */}
      {data?.locales?.length > 1 && (
        <Card className="mb-5">
          <p className="mb-3 flex items-center gap-1.5 font-display text-sm font-semibold text-ink-950">
            <Store size={15} /> Rendimiento por local
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {data.locales.map((l) => {
              const max = Math.max(...data.locales.map((x) => x.facturado));
              return (
                <div key={l.locationId ?? "sin"} className="rounded-md border border-line bg-paper-50 p-3">
                  <p className="truncate text-sm font-medium text-ink-900">{l.nombre}</p>
                  <p className="mt-1 font-display text-lg font-semibold">{formatCurrency(l.facturado)}</p>
                  <div className="mt-2 h-1.5 rounded-full bg-paper-200">
                    <div className="h-full rounded-full bg-teal-500" style={{ width: `${max ? (l.facturado / max) * 100 : 0}%` }} />
                  </div>
                  <p className="mt-1.5 text-xs text-ink-500">{l.ventas} ventas · {l.unidades} un.</p>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="relative max-w-xs flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input className="input pl-9" placeholder="Buscar producto…" value={busqueda} onChange={(e) => setBusqueda(e.target.value)} />
        </div>
        <select className="input w-auto" value={orden} onChange={(e) => setOrden(e.target.value)}>
          {ORDENES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button className="btn-ghost ml-auto" onClick={cargar}><RefreshCw size={15} /> Actualizar</button>
      </div>

      {productos.length === 0 ? (
        <EmptyState icon={PackageSearch} title="Sin ventas registradas" description="Cuando vendas productos vas a ver acá su rendimiento." />
      ) : (
        <Card className="mb-5 p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-line bg-paper-100 text-left text-xs uppercase tracking-wide text-ink-600">
                  <th className="px-3 py-2 font-medium" />
                  <th className="px-3 py-2 font-medium">Producto</th>
                  <th className="px-3 py-2 font-medium">Unidades</th>
                  <th className="px-3 py-2 font-medium">Facturado</th>
                  <th className="px-3 py-2 font-medium">Ganancia</th>
                  <th className="px-3 py-2 font-medium" title="Ganancia sobre lo facturado">Margen</th>
                  <th className="px-3 py-2 font-medium" title="Ganancia promedio por unidad vendida">$/unidad</th>
                  <th className="px-3 py-2 font-medium" title="En qué porcentaje de las ventas aparece este producto">Conversión</th>
                  <th className="px-3 py-2 font-medium" title="Qué proporción del stock disponible ya se vendió">Rotación</th>
                  <th className="px-3 py-2 font-medium">Mejor local</th>
                </tr>
              </thead>
              <tbody>
                {productos.map((p) => (
                  <FilaProducto
                    key={p.skuAgrupador}
                    producto={p}
                    abierto={abierto === p.skuAgrupador}
                    onToggle={() => setAbierto(abierto === p.skuAgrupador ? null : p.skuAgrupador)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Capital inmovilizado: lo más útil para decidir liquidaciones */}
      {data?.sinVentas?.length > 0 && (
        <Card>
          <p className="mb-1 flex items-center gap-1.5 font-display text-sm font-semibold text-ink-950">
            <AlertTriangle size={15} className="text-brass-500" /> Productos sin ventas
          </p>
          <p className="mb-3 text-xs text-ink-500">
            Están en el catálogo con stock pero no se vendió ninguna unidad. Ordenados por stock inmovilizado.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-600">
                  <th className="py-2 font-medium">Producto</th>
                  <th className="py-2 font-medium">Categoría</th>
                  <th className="py-2 font-medium">Variantes</th>
                  <th className="py-2 font-medium">Stock parado</th>
                </tr>
              </thead>
              <tbody>
                {data.sinVentas.slice(0, 20).map((p) => (
                  <tr key={p.skuAgrupador} className="border-b border-line last:border-0">
                    <td className="py-2 text-ink-900">{p.titulo}</td>
                    <td className="py-2 text-ink-600">{p.categoria || "—"}</td>
                    <td className="py-2 text-ink-600">{p.variantesCount}</td>
                    <td className="py-2 font-medium text-brick-500">{p.stockActual} un.</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function FilaProducto({ producto: p, abierto, onToggle }) {
  return (
    <>
      <tr className="cursor-pointer border-b border-line hover:bg-paper-100/70" onClick={onToggle}>
        <td className="px-3 py-2 text-ink-400">{abierto ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</td>
        <td className="px-3 py-2">
          <p className="font-medium text-ink-900">{p.titulo}</p>
          <span className="tag-chip mt-0.5">{p.skuAgrupador}</span>
        </td>
        <td className="px-3 py-2 font-medium text-ink-900">{p.unidades}</td>
        <td className="px-3 py-2 text-ink-900">{formatCurrency(p.facturado)}</td>
        <td className="px-3 py-2 font-medium text-teal-600">{formatCurrency(p.ganancia)}</td>
        <td className="px-3 py-2 text-ink-700">{p.margenPct}%</td>
        <td className="px-3 py-2 text-ink-700">{formatCurrency(p.gananciaPorUnidad)}</td>
        <td className="px-3 py-2"><Barrita pct={p.conversionPct} color="bg-teal-500" sufijo={`${p.ventasCount} ventas`} /></td>
        <td className="px-3 py-2"><Barrita pct={p.rotacionPct} color="bg-brass-500" sufijo={`quedan ${p.stockActual}`} /></td>
        <td className="px-3 py-2 text-xs text-ink-600">{p.mejorLocal || "—"}</td>
      </tr>

      {abierto && (
        <tr className="border-b border-line bg-paper-50">
          <td />
          <td colSpan={9} className="px-3 py-4">
            <div className="grid gap-5 lg:grid-cols-2">
              <div>
                <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-600">
                  <Store size={13} /> Dónde se vende
                </p>
                {p.porLocal.length === 0 ? (
                  <p className="text-sm text-ink-500">Sin datos de local.</p>
                ) : (
                  <ul className="space-y-2">
                    {p.porLocal.map((l) => {
                      const max = Math.max(...p.porLocal.map((x) => x.unidades));
                      return (
                        <li key={l.locationId ?? "sin"}>
                          <div className="flex items-baseline justify-between text-sm">
                            <span className="text-ink-900">{l.nombre}</span>
                            <span className="text-ink-600">{l.unidades} un. · {formatCurrency(l.facturado)}</span>
                          </div>
                          <div className="mt-1 h-1.5 rounded-full bg-paper-200">
                            <div className="h-full rounded-full bg-teal-500" style={{ width: `${max ? (l.unidades / max) * 100 : 0}%` }} />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-600">Por variante</p>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-ink-500">
                      <th className="py-1 font-medium">SKU</th>
                      <th className="py-1 font-medium">Variante</th>
                      <th className="py-1 font-medium">Vendidas</th>
                      <th className="py-1 font-medium">Stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.porVariante.map((v) => (
                      <tr key={v.sku} className="border-b border-line last:border-0">
                        <td className="py-1"><span className="tag-chip">{v.sku}</span></td>
                        <td className="py-1 text-ink-700">{[v.variante1Valor, v.variante2Valor].filter(Boolean).join(" · ") || "—"}</td>
                        <td className="py-1 font-medium text-ink-900">{v.unidades}</td>
                        <td className="py-1 text-ink-600">{v.stockActual ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Barrita({ pct, color, sufijo }) {
  return (
    <div className="min-w-[80px]">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium text-ink-900">{pct}%</span>
      </div>
      <div className="mt-0.5 h-1.5 rounded-full bg-paper-200">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      {sufijo && <p className="mt-0.5 text-[10px] text-ink-500">{sufijo}</p>}
    </div>
  );
}
