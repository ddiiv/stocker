import { useEffect, useState } from "react";
import { Receipt, XCircle, Download, Filter } from "lucide-react";
import { fetchInvoices, fetchReceipts, voidInvoice, downloadInvoicePdf } from "../services/invoiceService";
import { mensajeDeError } from "../utils/errores";
import { formatCurrency, formatDate } from "../utils/formatters";
import { PageHeader, EmptyState } from "../components/ui/Layout";
import BillingTabs from "../components/billing/BillingTabs";
import { rangoDe, etiquetaDe } from "../utils/periodos";
import { FiltroPeriodo, ResumenFiltro, DatoResumen } from "../components/ui/Filtros";

export default function BillingPage() {
  const [tab, setTab] = useState("facturas");
  const [invoices, setInvoices] = useState([]);
  const [receipts, setReceipts] = useState([]);
  const [resumen, setResumen] = useState(null);
  const [loading, setLoading] = useState(true);
  const [periodo, setPeriodo] = useState("");
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      // El mismo rango para facturas y recibos: los recibos se derivan de las
      // facturas, así que filtrarlos distinto mostraría dos verdades.
      const rango = rangoDe(periodo);
      const [inv, rec] = await Promise.all([fetchInvoices(rango), fetchReceipts(rango)]);
      setInvoices(inv.facturas);
      setResumen(inv.resumen);
      setReceipts(rec);
    } catch (e) {
      // Son dos consultas en paralelo: si falla cualquiera, sin este catch la
      // pantalla quedaba en esqueleto sin decir cuál ni por qué.
      setError(mensajeDeError(e, "No se pudo cargar la facturación."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [periodo]);

  /*
   * Anular una factura toca ARCA, y ARCA falla seguido: certificado vencido,
   * el servicio caído, un CAE que no se puede anular. Sin catch, todo eso era
   * un rechazo sin manejar: la pantalla no cambiaba y el usuario no sabía si
   * la factura quedó anulada o no.
   */
  async function handleVoid(id) {
    if (!confirm("¿Anular esta factura? Esta acción no se puede deshacer.")) return;
    setError("");
    try {
      await voidInvoice(id);
    } catch (e) {
      setError(mensajeDeError(e, "No se pudo anular la factura."));
      return;
    }
    await load();
  }

  return (
    <div>
      <PageHeader
        title="Facturación"
        subtitle="Facturas para ARCA generadas desde pedidos pagos, y sus recibos asociados"
      />
      <BillingTabs />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <FiltroPeriodo valor={periodo} onChange={setPeriodo} />
        {periodo && (
          <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setPeriodo("")}>
            Ver todo
          </button>
        )}
      </div>

      {/*
        Los totales los calcula el backend sobre el filtro completo. Antes se
        sumaban las filas traídas, que con más de cien facturas daba el total de
        la primera página y no del período.
      */}
      {resumen && (
        <ResumenFiltro>
          <DatoResumen rotulo="Emitidas" valor={resumen.emitidas} />
          <DatoResumen
            rotulo="Facturado"
            valor={formatCurrency(resumen.totalEmitido)}
            destacado
            nota={periodo ? etiquetaDe(periodo) : "desde siempre"}
          />
          {resumen.anuladas > 0 && (
            <DatoResumen
              rotulo="Anuladas"
              valor={resumen.anuladas}
              nota="no suman al facturado"
            />
          )}
          <DatoResumen rotulo="Recibos" valor={receipts.length} />
        </ResumenFiltro>
      )}

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

      {/* El error de carga y el de anulación comparten lugar: los dos son
          "algo salió mal en esta pantalla" y no compiten entre sí. */}
      {error && (
        <p className="mb-4 rounded-md border border-brick-500/30 bg-brick-50 px-3 py-2 text-sm text-brick-500">
          {error}
        </p>
      )}

      {loading ? (
        <div className="card p-0">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse border-b border-line last:border-0" />
          ))}
        </div>
      ) : tab === "facturas" ? (
        invoices.length === 0 ? (
          <EmptyState
            icon={periodo ? Filter : Receipt}
            title={periodo ? `Sin facturas de ${etiquetaDe(periodo)}` : "Todavía no generaste facturas"}
            description={periodo
              ? "Probá ampliando el período."
              : "Se generan desde una venta ya cobrada."}
            action={periodo && (
              <button className="btn-ghost" onClick={() => setPeriodo("")}>Ver todo</button>
            )}
          />
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
        <EmptyState
          icon={periodo ? Filter : Receipt}
          title={periodo ? `Sin recibos de ${etiquetaDe(periodo)}` : "Todavía no hay recibos"}
          description={periodo
            ? "Probá ampliando el período."
            : "Se generan junto con cada factura."}
        />
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
