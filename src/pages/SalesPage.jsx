import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, ShoppingCart, CheckCircle2, NotebookPen } from "lucide-react";
import { fetchSales, cobrarSale } from "../services/salesService";
import { fetchPaymentMethods } from "../services/paymentMethodService";
import PaymentSplit, { lineasParaApi, calcularTotales } from "../components/sales/PaymentSplit";
import { formatCurrency, formatDate } from "../utils/formatters";
import { PageHeader, EmptyState } from "../components/ui/Layout";
import Modal from "../components/ui/Modal";
import { medioPagoBadge } from "../utils/paymentBadge";

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
  const [metodos, setMetodos] = useState([]);
  const [pagos, setPagos] = useState([]);
  const [payError, setPayError] = useState("");
  const [busy, setBusy] = useState(false);

  // Lo que falta cobrar de la venta abierta, que no siempre es su total: el
  // cliente pudo haber pagado una parte a cuenta desde su ficha.
  const aCobrar = Number(payingSale?.saldoPendiente) || Number(payingSale?.total) || 0;

  async function load() {
    setLoading(true);
    const data = await fetchSales({ tipo: tipo || undefined });
    setSales(data);
    setLoading(false);
  }

  useEffect(() => { load(); }, [tipo]);

  async function abrirCobro(venta) {
    setPayError("");
    setPayingSale(venta);
    const pendiente = Number(venta.saldoPendiente) || Number(venta.total) || 0;
    try {
      const m = await fetchPaymentMethods({ soloActivos: true });
      setMetodos(m);
      setPagos(m.length ? [{ paymentMethodId: m[0].id, monto: pendiente, ajusteManual: "" }] : []);
    } catch {
      setPayError("No se pudieron cargar los medios de pago.");
    }
  }

  async function handleCobro() {
    if (!payingSale) return;
    setBusy(true); setPayError("");
    try {
      await cobrarSale(payingSale.id, lineasParaApi(pagos, metodos, aCobrar));
      setPayingSale(null);
      await load();
    } catch (e) {
      setPayError(e.response?.data?.message || "No se pudo cobrar la venta.");
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
                <th className="px-4 py-3 font-medium">Pago</th>
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
                  <td className="px-4 py-3 font-medium text-ink-900">
                    {/* Con recargo, lo cobrado difiere del neto: se muestran los
                        dos para que el número no parezca un error de cálculo. */}
                    {formatCurrency(s.totalCobrado || s.total)}
                    {Number(s.recargoPagos) !== 0 && (
                      <span className="ml-1 block text-xs font-normal text-ink-500">
                        neto {formatCurrency(s.total)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {s.medioPago ? (
                      <span className={`badge ${medioPagoBadge(s.medioPago)}`}>{s.medioPago}</span>
                    ) : s.condicionPago === "cuenta_corriente" ? (
                      /* Fiada: todavía no hay medio, pero sí hay alguien que debe. */
                      <span className="badge badge-low"><NotebookPen size={12} /> Fiada</span>
                    ) : (
                      <span className="text-ink-400">—</span>
                    )}
                    {Number(s.recargoPagos) !== 0 && (
                      <span className={`ml-1 block text-xs ${Number(s.recargoPagos) > 0 ? "text-brick-500" : "text-teal-600"}`}>
                        {Number(s.recargoPagos) > 0 ? "+" : "−"}{formatCurrency(Math.abs(Number(s.recargoPagos)))}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`badge ${ESTADO_BADGE[s.estado] || "badge-low"}`}>{s.estado}</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {s.tipo === "venta" && s.estado === "pendiente" && (
                      <button
                        className="btn-ghost px-2 py-1.5 text-xs"
                        title="Marcar como cobrada"
                        onClick={() => abrirCobro(s)}
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
          {payError && <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{payError}</p>}

          <p className="text-sm text-ink-600">
            A cobrar: <span className="font-medium text-ink-950">{formatCurrency(aCobrar)}</span>
            {!payingSale?.stockDescontado && ". Al confirmar sale el stock de los productos vendidos."}
          </p>

          {payingSale?.condicionPago === "cuenta_corriente" && payingSale?.cliente && (
            <p className="rounded-md bg-paper-100 px-3 py-2 text-xs text-ink-700">
              Cancela la deuda de {payingSale.cliente.nombre} {payingSale.cliente.apellido || ""}.
            </p>
          )}

          {metodos.length === 0 ? (
            <p className="text-sm text-ink-500">No hay medios de pago cargados.</p>
          ) : (
            <PaymentSplit metodos={metodos} total={aCobrar} lineas={pagos} onChange={setPagos} />
          )}

          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => setPayingSale(null)}>Cancelar</button>
            <button className="btn-accent" onClick={handleCobro} disabled={busy || metodos.length === 0}>
              {busy ? "Cobrando…" : `Cobrar ${formatCurrency(calcularTotales(pagos, metodos, aCobrar).totalCobro)}`}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
