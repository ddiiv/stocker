import { useEffect, useState } from "react";
import { Receipt, XCircle, Download } from "lucide-react";
import { fetchInvoices, fetchReceipts, voidInvoice, downloadInvoicePdf } from "../services/invoiceService";
import { formatCurrency, formatDate } from "../utils/formatters";
import { PageHeader, Card, EmptyState } from "../components/ui/Layout";
import BillingTabs from "../components/billing/BillingTabs";

export default function BillingPage() {
  const [tab, setTab] = useState("facturas");
  const [invoices, setInvoices] = useState([]);
  const [receipts, setReceipts] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const [inv, rec] = await Promise.all([fetchInvoices(), fetchReceipts()]);
    setInvoices(inv);
    setReceipts(rec);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function handleVoid(id) {
    if (!confirm("¿Anular esta factura? Esta acción no se puede deshacer.")) return;
    await voidInvoice(id);
    load();
  }

  const totalFacturado = invoices.filter((i) => i.estado === "emitida").reduce((s, i) => s + Number(i.total), 0);

  return (
    <div>
      <PageHeader
        title="Facturación"
        subtitle="Facturas para ARCA generadas desde pedidos pagos, y sus recibos asociados"
      />
      <BillingTabs />

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <Card>
          <p className="text-xs uppercase tracking-wide text-ink-600">Facturas emitidas</p>
          <p className="mt-2 font-display text-2xl font-semibold text-ink-950">
            {invoices.filter((i) => i.estado === "emitida").length}
          </p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-ink-600">Total facturado</p>
          <p className="mt-2 font-display text-2xl font-semibold text-ink-950">{formatCurrency(totalFacturado)}</p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-ink-600">Recibos emitidos</p>
          <p className="mt-2 font-display text-2xl font-semibold text-ink-950">{receipts.length}</p>
        </Card>
      </div>

      <div className="mb-5 flex rounded-md border border-line bg-paper-50 p-1 w-fit">
        {[
          { v: "facturas", label: "Facturas" },
          { v: "recibos", label: "Recibos" },
        ].map((t) => (
          <button
            key={t.v}
            onClick={() => setTab(t.v)}
            className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === t.v ? "bg-ink-950 text-paper-50" : "text-ink-600 hover:bg-paper-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="card p-0">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse border-b border-line last:border-0" />
          ))}
        </div>
      ) : tab === "facturas" ? (
        invoices.length === 0 ? (
          <EmptyState icon={Receipt} title="Todavía no generaste facturas" description="Se generan desde una venta ya cobrada." />
        ) : (
          <div className="card overflow-x-auto p-0">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-line bg-paper-100 text-left text-xs uppercase tracking-wide text-ink-600">
                  <th className="px-4 py-3 font-medium">Número</th>
                  <th className="px-4 py-3 font-medium">Tipo</th>
                  <th className="px-4 py-3 font-medium">Fecha</th>
                  <th className="px-4 py-3 font-medium">Emisor</th>
                  <th className="px-4 py-3 font-medium">Cliente</th>
                  <th className="px-4 py-3 font-medium">CAE</th>
                  <th className="px-4 py-3 font-medium">Total</th>
                  <th className="px-4 py-3 font-medium">Estado</th>
                  <th className="px-4 py-3 font-medium" />
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} className="border-b border-line last:border-0 hover:bg-paper-100/70">
                    <td className="px-4 py-3 font-mono text-xs text-ink-900">{inv.numero}</td>
                    <td className="px-4 py-3">
                      <span className="tag-chip">Factura {inv.tipo}</span>
                    </td>
                    <td className="px-4 py-3 text-ink-700">{formatDate(inv.fechaEmision?.slice(0, 10))}</td>
                    <td className="px-4 py-3 text-ink-700">
                      {inv.emisorNombre ? (
                        <>
                          <p className="text-ink-900">{inv.emisorNombre}</p>
                          <p className="font-mono text-xs text-ink-500">{inv.emisorCuit}</p>
                        </>
                      ) : "—"}
                    </td>
                    <td className="px-4 py-3 text-ink-900">{inv.clienteNombre || (inv.cliente ? `${inv.cliente.nombre} ${inv.cliente.apellido || ""}`.trim() : "—")}</td>
                    <td className="px-4 py-3 font-mono text-xs text-ink-600">{inv.cae}</td>
                    <td className="px-4 py-3 font-medium text-ink-900">{formatCurrency(inv.total)}</td>
                    <td className="px-4 py-3">
                      <span className={`badge ${inv.estado === "emitida" ? "badge-ok" : "badge-out"}`}>{inv.estado}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        <button
                          className="btn-ghost px-2 py-1.5"
                          title="Descargar PDF"
                          onClick={async () => {
                            try { await downloadInvoicePdf(inv); }
                            catch (e) { alert(e.response?.status === 404 ? "PDF no disponible todavía." : "Error al descargar PDF"); }
                          }}
                        >
                          <Download size={14} />
                        </button>
                        {inv.estado === "emitida" && (
                          <button className="btn-ghost px-2 py-1.5" title="Anular" onClick={() => handleVoid(inv.id)}>
                            <XCircle size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : receipts.length === 0 ? (
        <EmptyState icon={Receipt} title="Todavía no hay recibos" description="Se generan junto con cada factura." />
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full min-w-[600px] text-sm">
            <thead>
              <tr className="border-b border-line bg-paper-100 text-left text-xs uppercase tracking-wide text-ink-600">
                <th className="px-4 py-3 font-medium">Número</th>
                <th className="px-4 py-3 font-medium">Fecha</th>
                <th className="px-4 py-3 font-medium">Cliente</th>
                <th className="px-4 py-3 font-medium">Medio de pago</th>
                <th className="px-4 py-3 font-medium">Monto</th>
              </tr>
            </thead>
            <tbody>
              {receipts.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0 hover:bg-paper-100/70">
                  <td className="px-4 py-3 font-mono text-xs text-ink-900">{r.numero}</td>
                  <td className="px-4 py-3 text-ink-700">{formatDate(r.fecha)}</td>
                  <td className="px-4 py-3 text-ink-900">{r.cliente}</td>
                  <td className="px-4 py-3 text-ink-700">{r.medioPago}</td>
                  <td className="px-4 py-3 font-medium text-ink-900">{formatCurrency(r.monto)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
