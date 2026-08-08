import { useEffect, useState } from "react";
import { TrendingUp, TrendingDown, Calendar, Trophy, RefreshCw } from "lucide-react";
import { getTimeline } from "../services/metricsService";
import { formatCurrency } from "../utils/formatters";
import { PageHeader, Card, EmptyState } from "../components/ui/Layout";
import MetricsTabs from "../components/dashboard/MetricsTabs";

const GRANULARIDADES = [
  { value: "dia",    label: "Por día" },
  { value: "semana", label: "Por semana" },
  { value: "mes",    label: "Por mes" },
  { value: "anio",   label: "Por año" },
];

// Etiqueta legible según cómo esté agrupada la serie.
function etiquetaPeriodo(periodo, granularidad) {
  if (granularidad === "anio") return periodo;
  if (granularidad === "mes") {
    const [a, m] = periodo.split("-");
    const meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
    return `${meses[Number(m) - 1]} ${a}`;
  }
  const [a, m, d] = periodo.split("-");
  return granularidad === "semana" ? `sem. ${d}/${m}` : `${d}/${m}/${a.slice(2)}`;
}

export default function SalesTimelinePage() {
  const [granularidad, setGranularidad] = useState("mes");
  const [incluirPendientes, setIncluirPendientes] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function cargar() {
    setLoading(true); setError("");
    try {
      setData(await getTimeline({ granularidad, incluirPendientes }));
    } catch (e) {
      setError(e.response?.data?.message || "No se pudieron cargar las métricas");
    } finally { setLoading(false); }
  }

  useEffect(() => { cargar(); }, [granularidad, incluirPendientes]);

  const serie = data?.serie || [];
  const maxTotal = Math.max(...serie.map((p) => p.total), 0);

  return (
    <div>
      <PageHeader title="Métricas" subtitle="Evolución de las ventas a lo largo del tiempo" />
      <MetricsTabs />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex rounded-md border border-line bg-paper-50 p-1">
          {GRANULARIDADES.map((g) => (
            <button
              key={g.value}
              onClick={() => setGranularidad(g.value)}
              className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                granularidad === g.value ? "bg-ink-950 text-paper-50" : "text-ink-600 hover:bg-paper-200"
              }`}
            >
              {g.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input type="checkbox" checked={incluirPendientes} onChange={(e) => setIncluirPendientes(e.target.checked)} />
          Incluir ventas sin cobrar
        </label>
        <button className="btn-ghost ml-auto" onClick={cargar}><RefreshCw size={15} /> Actualizar</button>
      </div>

      {error && <p className="mb-4 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}

      {loading ? (
        <div className="card h-64 animate-pulse bg-paper-200/60" />
      ) : serie.length === 0 ? (
        <EmptyState icon={Calendar} title="Sin ventas registradas" description="Cuando cargues ventas vas a ver acá su evolución." />
      ) : (
        <>
          <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <p className="text-xs uppercase tracking-wide text-ink-600">Facturado total</p>
              <p className="mt-2 font-display text-xl font-semibold">{formatCurrency(data.resumen.totalFacturado)}</p>
              <p className="mt-1 text-xs text-ink-500">{data.resumen.totalVentas} ventas · {data.resumen.totalUnidades} unidades</p>
            </Card>
            <Card>
              <p className="text-xs uppercase tracking-wide text-ink-600">Ganancia total</p>
              <p className="mt-2 font-display text-xl font-semibold text-teal-600">{formatCurrency(data.resumen.gananciaTotal)}</p>
            </Card>
            <Card>
              <p className="text-xs uppercase tracking-wide text-ink-600">Promedio por período</p>
              <p className="mt-2 font-display text-xl font-semibold">{formatCurrency(data.resumen.promedioPorPeriodo)}</p>
              <p className="mt-1 text-xs text-ink-500">{data.resumen.periodos} períodos con ventas</p>
            </Card>
            <Card>
              <p className="text-xs uppercase tracking-wide text-ink-600">Mejor período</p>
              <p className="mt-2 flex items-center gap-1.5 font-display text-xl font-semibold">
                <Trophy size={16} className="text-brass-500" />
                {data.resumen.mejorPeriodo ? etiquetaPeriodo(data.resumen.mejorPeriodo.periodo, granularidad) : "—"}
              </p>
              <p className="mt-1 text-xs text-ink-500">
                {data.resumen.mejorPeriodo ? formatCurrency(data.resumen.mejorPeriodo.total) : ""}
              </p>
            </Card>
          </div>

          {/* Gráfico de barras: cada período contra el máximo de la serie. */}
          <Card className="mb-5">
            <p className="mb-4 font-display text-sm font-semibold text-ink-950">Facturación por período</p>
            <div className="flex h-56 items-end gap-1 overflow-x-auto pb-2">
              {serie.map((p) => (
                <div key={p.periodo} className="group flex min-w-[28px] flex-1 flex-col items-center justify-end gap-1">
                  <span className="pointer-events-none rounded bg-ink-950 px-1.5 py-0.5 text-[10px] text-paper-50 opacity-0 transition group-hover:opacity-100">
                    {formatCurrency(p.total)}
                  </span>
                  <div
                    className="w-full rounded-t bg-brass-500 transition-all group-hover:bg-brass-600"
                    style={{ height: `${maxTotal ? Math.max((p.total / maxTotal) * 100, 2) : 2}%` }}
                  />
                  <span className="whitespace-nowrap text-[10px] text-ink-500">{etiquetaPeriodo(p.periodo, granularidad)}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-0">
            <p className="border-b border-line px-4 py-3 font-display text-sm font-semibold text-ink-950">Detalle por período</p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b border-line bg-paper-100 text-left text-xs uppercase tracking-wide text-ink-600">
                    <th className="px-4 py-2 font-medium">Período</th>
                    <th className="px-4 py-2 font-medium">Facturado</th>
                    <th className="px-4 py-2 font-medium">Ganancia</th>
                    <th className="px-4 py-2 font-medium">Margen</th>
                    <th className="px-4 py-2 font-medium">Ventas</th>
                    <th className="px-4 py-2 font-medium">Unidades</th>
                    <th className="px-4 py-2 font-medium">Ticket prom.</th>
                    <th className="px-4 py-2 font-medium">vs. anterior</th>
                  </tr>
                </thead>
                <tbody>
                  {[...serie].reverse().map((p) => (
                    <tr key={p.periodo} className="border-b border-line last:border-0 hover:bg-paper-100/70">
                      <td className="px-4 py-2 font-medium text-ink-900">{etiquetaPeriodo(p.periodo, granularidad)}</td>
                      <td className="px-4 py-2 text-ink-900">{formatCurrency(p.total)}</td>
                      <td className="px-4 py-2 text-teal-600">{formatCurrency(p.ganancia)}</td>
                      <td className="px-4 py-2 text-ink-700">{p.margenPct}%</td>
                      <td className="px-4 py-2 text-ink-700">{p.ventas}</td>
                      <td className="px-4 py-2 text-ink-700">{p.unidades} un.</td>
                      <td className="px-4 py-2 text-ink-700">{formatCurrency(p.ticketPromedio)}</td>
                      <td className="px-4 py-2">
                        {p.variacionPct == null ? (
                          <span className="text-xs text-ink-500">—</span>
                        ) : (
                          <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${p.variacionPct >= 0 ? "text-teal-600" : "text-brick-500"}`}>
                            {p.variacionPct >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                            {Math.abs(p.variacionPct)}%
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
