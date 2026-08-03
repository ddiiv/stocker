import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, ShoppingCart, CheckCircle2 } from "lucide-react";
import { fetchSales, updateSaleStatus } from "../services/salesService";
import { formatCurrency, formatDate } from "../utils/formatters";
import { PageHeader, EmptyState } from "../components/ui/Layout";
import Modal from "../components/ui/Modal";

const FILTERS = [
  { value: "", label: "Todas" },
  { value: "venta", label: "Ventas" },
  { value: "cotizacion", label: "Cotizaciones" },
];

const ESTADO_BADGE = {
  pagado: "badge-ok",
  pendiente: "badge-low",
  cancelado: "badge-out",
  vencida: "badge-out",
};

export default function SalesPage() {
  const [sales, setSales] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tipo, setTipo] = useState("");
  const [payingSale, setPayingSale] = useState(null);
  const [medioPago, setMedioPago] = useState("efectivo");
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    const data = await fetchSales({ tipo: tipo || undefined });
    setSales(data);
    setLoading(false);
  }

  useEffect(() => { load(); }, [tipo]);

  async function handleMarkPaid() {
    if (!payingSale) return;
    setBusy(true);
    try {
      await updateSaleStatus(payingSale.id, "pagado", medioPago);
      setPayingSale(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Ventas y cotizaciones"
        subtitle="Historial de operaciones con clientes"
        actions={
          <Link to="/ventas/nueva" className="btn-accent">
            <Plus size={15} /> Nueva venta
          </Link>
        }
      />

      <div className="mb-5 flex rounded-md border border-line bg-paper-50 p-1 w-fit">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setTipo(f.value)}
            className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
              tipo === f.value ? "bg-ink-950 text-paper-50" : "text-ink-600 hover:bg-paper-200"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="card p-0">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse border-b border-line last:border-0" />
          ))}
        </div>
      ) : sales.length === 0 ? (
        <EmptyState icon={ShoppingCart} title="Sin operaciones todavía" description="Registrá tu primera venta o cotización." />
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-line bg-paper-100 text-left text-xs uppercase tracking-wide text-ink-600">
                <th className="px-4 py-3 font-medium">N°</th>
                <th className="px-4 py-3 font-medium">Fecha</th>
                <th className="px-4 py-3 font-medium">Cliente</th>
                <th className="px-4 py-3 font-medium">Empleado</th>
                <th className="px-4 py-3 font-medium">Ítems</th>
                <th className="px-4 py-3 font-medium">Total</th>
                <th className="px-4 py-3 font-medium">Estado</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {sales.map((s) => (
                <tr key={s.id} className="border-b border-line last:border-0 hover:bg-paper-100/70">
                  <td className="px-4 py-3">
                    <Link to={`/ventas/${s.id}`} className="font-mono text-xs text-brass-600 hover:underline">
                      {s.numero}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-ink-700">{formatDate(s.fecha)}</td>
                  <td className="px-4 py-3 text-ink-900">{s.cliente ? `${s.cliente.nombre} ${s.cliente.apellido || ""}`.trim() : "—"}</td>
                  <td className="px-4 py-3 text-ink-700">{s.empleado ? `${s.empleado.nombre} ${s.empleado.apellido || ""}`.trim() : "—"}</td>
                  <td className="px-4 py-3 text-ink-700">{s.items?.length ?? 0}</td>
                  <td className="px-4 py-3 font-medium text-ink-900">{formatCurrency(s.total)}</td>
                  <td className="px-4 py-3">
                    <span className={`badge ${ESTADO_BADGE[s.estado] || "badge-low"}`}>{s.estado}</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {s.tipo === "venta" && s.estado === "pendiente" && (
                      <button
                        className="btn-ghost px-2 py-1.5 text-xs"
                        title="Marcar como cobrada"
                        onClick={() => { setPayingSale(s); setMedioPago("efectivo"); }}
                      >
                        <CheckCircle2 size={14} /> Cobrar
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={!!payingSale} onClose={() => setPayingSale(null)} title={`Cobrar venta ${payingSale?.numero || ""}`}>
        <div className="space-y-4">
          <p className="text-sm text-ink-600">
            Total a cobrar: <span className="font-medium text-ink-950">{formatCurrency(payingSale?.total || 0)}</span>. Al confirmar se descuenta el stock de los productos vendidos.
          </p>
          <div>
            <label className="label">Medio de pago</label>
            <select className="input" value={medioPago} onChange={(e) => setMedioPago(e.target.value)}>
              <option value="efectivo">Efectivo</option>
              <option value="transferencia">Transferencia</option>
              <option value="débito">Débito</option>
              <option value="crédito">Crédito</option>
              <option value="mercadopago">MercadoPago</option>
              <option value="cheque">Cheque</option>
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => setPayingSale(null)}>Cancelar</button>
            <button className="btn-accent" onClick={handleMarkPaid} disabled={busy}>{busy ? "Cobrando…" : "Confirmar cobro"}</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
