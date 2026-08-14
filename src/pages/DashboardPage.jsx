import { useEffect, useState } from "react";
import { DollarSign, TrendingUp, ShoppingBag, PackageX, ReceiptText } from "lucide-react";
import { getDashboardMetrics } from "../services/dashboardService";
import { formatCurrency, formatDate } from "../utils/formatters";
import { Card, PageHeader } from "../components/ui/Layout";
import StatCard from "../components/dashboard/StatCard";
import MetricsTabs from "../components/dashboard/MetricsTabs";
import RevenueChart from "../components/dashboard/RevenueChart";
import TopProductsChart from "../components/dashboard/TopProductsChart";

const RANGE_OPTIONS = [
  { value: 7, label: "7 días" },
  { value: 30, label: "30 días" },
  { value: 90, label: "90 días" },
  { value: 365, label: "1 año" },
];

export default function DashboardPage() {
  const [range, setRange] = useState(30);
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getDashboardMetrics({ rangeDays: range }).then((m) => {
      setMetrics(m);
      setLoading(false);
    });
  }, [range]);

  return (
    <div>
      <PageHeader
        title="Métricas del negocio"
        subtitle="Ventas pagas, costos y stock — calculado sobre el período seleccionado"
        actions={
          <div className="flex rounded-md border border-line bg-paper-50 p-1">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setRange(opt.value)}
                className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                  range === opt.value ? "bg-ink-950 text-paper-50" : "text-ink-600 hover:bg-paper-200"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        }
      />
      <MetricsTabs />

      {loading || !metrics ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card h-28 animate-pulse bg-paper-200/60" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Facturación (pagas)" value={formatCurrency(metrics.revenue)} icon={DollarSign} accent="brass" hint={`${metrics.salesCount} ventas cobradas`} />
            <StatCard label="Margen bruto" value={formatCurrency(metrics.margin)} icon={TrendingUp} accent="teal" hint={`${metrics.marginPct}% sobre facturado`} />
            <StatCard label="Ticket promedio" value={formatCurrency(metrics.ticketPromedio)} icon={ShoppingBag} accent="ink" hint="Por venta cobrada" />
            <StatCard label="Pendiente de cobro" value={formatCurrency(metrics.pendingAmount)} icon={PackageX} accent="brick" hint="Ventas sin cobrar en el período" />
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-5">
            <Card className="lg:col-span-3">
              <p className="mb-4 font-display text-sm font-semibold text-ink-950">Ingresos por día</p>
              {metrics.revenueSeries.length ? (
                <RevenueChart data={metrics.revenueSeries} />
              ) : (
                <p className="py-10 text-center text-sm text-ink-600">Sin ventas cobradas en este período.</p>
              )}
            </Card>
            <Card className="lg:col-span-2">
              <p className="mb-4 font-display text-sm font-semibold text-ink-950">Productos más vendidos</p>
              {metrics.topProducts.length ? (
                <TopProductsChart data={metrics.topProducts} />
              ) : (
                <p className="py-10 text-center text-sm text-ink-600">Sin datos todavía.</p>
              )}
            </Card>
          </div>

          {/* Evolución año a año: crecimiento del negocio en el tiempo. */}
          {metrics.serieAnual?.length > 0 && (
            <Card className="mt-6">
              <p className="mb-4 font-display text-sm font-semibold text-ink-950">Progreso por año</p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-600">
                      <th className="py-2 font-medium">Año</th>
                      <th className="py-2 font-medium">Facturado</th>
                      <th className="py-2 font-medium">Ventas</th>
                      <th className="py-2 font-medium">Unidades</th>
                      <th className="py-2 font-medium">vs. año anterior</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.serieAnual.map((a) => {
                      const maxTotal = Math.max(...metrics.serieAnual.map((x) => x.total));
                      return (
                        <tr key={a.anio} className="border-b border-line last:border-0">
                          <td className="py-2 font-display font-semibold text-ink-900">{a.anio}</td>
                          <td className="py-2">
                            <div className="flex items-center gap-2">
                              <span className="w-24 text-ink-900">{formatCurrency(a.total)}</span>
                              <span className="h-1.5 flex-1 rounded-full bg-paper-200">
                                <span className="block h-full rounded-full bg-brass-500" style={{ width: `${maxTotal ? (a.total / maxTotal) * 100 : 0}%` }} />
                              </span>
                            </div>
                          </td>
                          <td className="py-2 text-ink-700">{a.ventas}</td>
                          <td className="py-2 text-ink-700">{a.unidades} un.</td>
                          <td className="py-2">
                            {a.variacionPct == null ? (
                              <span className="text-xs text-ink-500">—</span>
                            ) : (
                              <span className={`text-xs font-medium ${a.variacionPct >= 0 ? "text-teal-600" : "text-brick-500"}`}>
                                {a.variacionPct >= 0 ? "▲" : "▼"} {Math.abs(a.variacionPct)}%
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Variantes concretas (talle/color) con más salida. */}
          {metrics.topVariants?.length > 0 && (
            <Card className="mt-6">
              <p className="mb-4 font-display text-sm font-semibold text-ink-950">Variantes con más salida</p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-600">
                      <th className="py-2 font-medium">Producto</th>
                      <th className="py-2 font-medium">Variante</th>
                      <th className="py-2 font-medium">SKU</th>
                      <th className="py-2 font-medium">Unidades</th>
                      <th className="py-2 font-medium">Facturado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.topVariants.map((v) => (
                      <tr key={v.sku} className="border-b border-line last:border-0">
                        <td className="py-2 text-ink-900">{v.titulo}</td>
                        <td className="py-2 text-ink-700">
                          {[v.variante1Valor, v.variante2Valor].filter(Boolean).join(" · ") || "—"}
                        </td>
                        <td className="py-2"><span className="tag-chip">{v.sku}</span></td>
                        <td className="py-2 font-medium text-ink-900">{v.unidades} un.</td>
                        <td className="py-2 text-ink-700">{formatCurrency(v.facturado)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <div className="mt-6 grid gap-4 lg:grid-cols-5">
            <Card className="lg:col-span-3">
              <div className="mb-3 flex items-center justify-between">
                <p className="font-display text-sm font-semibold text-ink-950">Costos vs. facturación</p>
              </div>
              <div className="space-y-3">
                <Row label="Facturado" value={metrics.revenue} max={metrics.revenue} color="bg-brass-500" />
                <Row label="Costo de mercadería" value={metrics.cogs} max={metrics.revenue} color="bg-ink-700" />
                <Row label="Margen" value={metrics.margin} max={metrics.revenue} color="bg-teal-500" />
              </div>
              <div className="mt-4 flex items-center gap-2 border-t border-line pt-4 text-sm text-ink-600">
                <ReceiptText size={16} />
                {metrics.invoicesCount} facturas emitidas por {formatCurrency(metrics.invoicesTotal)}
              </div>
            </Card>

            <Card className="lg:col-span-2">
              <p className="mb-3 font-display text-sm font-semibold text-ink-950">Stock bajo / agotado</p>
              {metrics.lowStock.length ? (
                <ul className="divide-y divide-line">
                  {metrics.lowStock.map((v) => (
                    <li key={v.sku} className="flex items-center justify-between py-2 text-sm">
                      <div className="min-w-0">
                        <p className="truncate text-ink-900">{v.titulo}</p>
                        <p className="tag-chip mt-1">{v.sku}</p>
                      </div>
                      <span className={`badge ${v.stock === 0 ? "badge-out" : "badge-low"}`}>
                        {v.stock === 0 ? "Sin stock" : `${v.stock} un.`}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-10 text-center text-sm text-ink-600">Todo el stock está por encima del mínimo.</p>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, value, max, color }) {
  const pct = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="text-ink-700">{label}</span>
        <span className="font-medium text-ink-950">{formatCurrency(value)}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-paper-200">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
