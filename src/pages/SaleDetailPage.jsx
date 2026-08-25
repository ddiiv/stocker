import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { ArrowLeft, ReceiptText, CheckCircle2, RefreshCw, Printer, NotebookPen, Ban } from "lucide-react";
import { getSale, cobrarSale, convertQuote, printSaleTicket, anularSale } from "../services/salesService";
import { mensajeDeError } from "../utils/errores";
import { generateInvoiceFromSale } from "../services/invoiceService";
import { fetchBusinessCuits } from "../services/businessCuitService";
import { fetchPaymentMethods } from "../services/paymentMethodService";
import PaymentSplit, { lineasParaApi, calcularTotales } from "../components/sales/PaymentSplit";
import { medioPagoBadge } from "../utils/paymentBadge";
import { formatCurrency, formatDate } from "../utils/formatters";
import { Card, PageHeader } from "../components/ui/Layout";
import Modal from "../components/ui/Modal";

const ESTADO_BADGE = { pagado: "badge-ok", pendiente: "badge-low", cancelado: "badge-out", vencida: "badge-out" };

export default function SaleDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [sale, setSale] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [invoiceModal, setInvoiceModal] = useState(false);
  const [invoiceForm, setInvoiceForm] = useState({ clienteCuit: "", clienteEmail: "", clienteDireccion: "", tipo: "B", enviarEmail: true, enviarWhatsapp: true, businessCuitId: "" });
  const [invoiceError, setInvoiceError] = useState("");
  const [businessCuits, setBusinessCuits] = useState([]);
  const [payModal, setPayModal] = useState(false);
  const [payError, setPayError] = useState("");
  const [metodos, setMetodos] = useState([]);
  const [pagos, setPagos] = useState([]);

  async function load() {
    setLoading(true);
    const s = await getSale(id);
    setSale(s);
    if (s?.cliente) setInvoiceForm((f) => ({ ...f, clienteCuit: s.cliente.cuit || "", clienteEmail: s.cliente.email || "" }));
    setLoading(false);
  }

  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    if (invoiceModal) {
      fetchBusinessCuits().then((cs) => {
        setBusinessCuits(cs);
        const principal = cs.find((c) => c.esPrincipal) || cs[0];
        if (principal && !invoiceForm.businessCuitId) {
          setInvoiceForm((f) => ({ ...f, businessCuitId: String(principal.id) }));
        }
      }).catch(() => {});
    }
  }, [invoiceModal]);

  /*
   * Cobro de una venta abierta.
   *
   * El importe es el saldo pendiente y no el total: si el cliente ya pagó algo
   * a cuenta desde su ficha, cobrarle el total de nuevo le sacaría plata de
   * más. El backend calcula lo mismo, esto es para que el cajero vea el número
   * correcto antes de pedirlo.
   */
  const aCobrar = Number(sale?.saldoPendiente) || Number(sale?.total) || 0;

  async function abrirCobro() {
    setPayError("");
    try {
      const m = await fetchPaymentMethods({ soloActivos: true });
      setMetodos(m);
      setPagos(m.length ? [{ paymentMethodId: m[0].id, monto: aCobrar, ajusteManual: "" }] : []);
      setPayModal(true);
    } catch {
      setPayError("No se pudieron cargar los medios de pago.");
      setPayModal(true);
    }
  }

  async function confirmarCobro() {
    setBusy(true); setPayError("");
    try {
      await cobrarSale(id, lineasParaApi(pagos, metodos, aCobrar));
      setPayModal(false);
      await load();
    } catch (e) {
      setPayError(e.response?.data?.message || "No se pudo cobrar la venta.");
    } finally {
      setBusy(false);
    }
  }

  async function handleConvertQuote() {
    setBusy(true);
    await convertQuote(id);
    await load();
    setBusy(false);
  }

  async function handleGenerateInvoice() {
    setInvoiceError("");
    setBusy(true);
    try {
      await generateInvoiceFromSale(sale, { ...invoiceForm, businessCuitId: invoiceForm.businessCuitId ? Number(invoiceForm.businessCuitId) : undefined });
      setInvoiceModal(false);
      await load();
    } catch (err) {
      setInvoiceError(err.response?.data?.message || "Error al generar la factura.");
    } finally { setBusy(false); }
  }

  if (loading) return <div className="card h-64 animate-pulse bg-paper-200/60" />;
  if (!sale)   return <p className="text-ink-600">Venta no encontrada.</p>;

  const items = sale.items || [];

  /*
   * Anulación.
   *
   * Se confirma con el detalle de lo que va a pasar, porque son tres efectos a
   * la vez y ninguno es evidente desde el botón: vuelve la mercadería, deja de
   * contarse el cobro y se borra la deuda si estaba fiada.
   */
  async function handleAnular() {
    const vuelve = sale.stockDescontado
      ? "La mercadería vuelve al stock del local."
      : "No hay stock que devolver: en esta venta nunca llegó a descontarse.";
    const deuda = sale.condicionPago === "cuenta_corriente" && Number(sale.saldoPendiente) > 0
      ? " Se cancela la deuda del cliente." : "";
    const motivo = prompt(`Anular la venta ${sale.numero}.\n\n${vuelve}${deuda}\n\n¿Por qué se anula?`);
    if (!motivo?.trim()) return;

    setBusy(true);
    try {
      const r = await anularSale(sale.id, motivo.trim());
      alert(r.mensaje);
      await load();
    } catch (e) {
      alert(mensajeDeError(e, "No se pudo anular la venta."));
    }
    setBusy(false);
  }

  return (
    <div>
      <Link to="/ventas" className="mb-4 inline-flex items-center gap-1 text-sm text-ink-600 hover:text-ink-950">
        <ArrowLeft size={15} /> Volver
      </Link>
      <PageHeader
        title={sale.numero}
        subtitle={`${sale.tipo === "venta" ? "Venta" : "Cotización"} · ${formatDate(sale.fecha)}`}
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`badge ${ESTADO_BADGE[sale.estado]}`}>{sale.estado}</span>
            {sale.esMayorista && <span className="badge badge-ok">Mayorista</span>}
            {/* Fiada: hay un cliente que debe esta venta hasta que se cobre. */}
            {sale.condicionPago === "cuenta_corriente" && (
              <span className="badge badge-low"><NotebookPen size={12} /> Fiada</span>
            )}
            {sale.tipo === "venta" && sale.estado === "pendiente" && (
              <button className="btn-accent" onClick={abrirCobro} disabled={busy}>
                <CheckCircle2 size={15} /> Cobrar {formatCurrency(aCobrar)}
              </button>
            )}
            {sale.tipo === "cotizacion" && (
              <button className="btn-ghost" onClick={handleConvertQuote} disabled={busy}><RefreshCw size={15} /> Convertir a venta</button>
            )}
            <button className="btn-ghost" onClick={() => printSaleTicket(sale)} title="Imprimir ticket 80mm"><Printer size={15} /> Ticket</button>
            {sale.tipo === "venta" && sale.estado === "pagado" && !sale.factura && (
              <button className="btn-accent" onClick={() => setInvoiceModal(true)} disabled={busy}><ReceiptText size={15} /> Generar factura</button>
            )}
            {sale.factura && <Link to="/facturacion" className="btn-ghost text-xs">Ver factura {sale.factura.numero}</Link>}
            {/* Anular va último y en tono de alerta: deshace cosas —stock,
                deuda, cobro— y no debería quedar al lado de "Cobrar". */}
            {sale.tipo === "venta" && sale.estado !== "cancelado" && (
              <button className="btn-ghost text-brick-500" onClick={handleAnular} disabled={busy}>
                <Ban size={15} /> Anular venta
              </button>
            )}
          </div>
        }
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <p className="mb-4 font-display text-sm font-semibold text-ink-950">
            Detalle · {sale.esMayorista ? "Precio mayorista (≥3 prendas)" : "Precio minorista"}
          </p>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-600">
              <th className="py-2 font-medium">Producto</th><th className="py-2 font-medium">Variante</th>
              <th className="py-2 font-medium">Cant.</th><th className="py-2 font-medium">Precio unit.</th>
              <th className="py-2 font-medium">Subtotal</th>
            </tr></thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id} className="border-b border-line last:border-0">
                  <td className="py-2 pr-2"><p className="text-ink-900">{i.titulo}</p><span className="tag-chip mt-1">{i.sku}</span></td>
                  <td className="py-2 pr-2 text-ink-700">{i.variante1Valor}{i.variante2Valor ? ` · ${i.variante2Valor}` : ""}</td>
                  <td className="py-2 pr-2 text-ink-700">{i.cantidad}</td>
                  <td className="py-2 pr-2 text-ink-700">{formatCurrency(i.precioUnitario)}</td>
                  <td className="py-2 font-medium text-ink-900">{formatCurrency(i.subtotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-4 space-y-2 border-t border-line pt-4 text-sm">
            <div className="flex justify-between"><span className="text-ink-600">Subtotal</span><span>{formatCurrency(sale.subtotal)}</span></div>
            {sale.descuentoPct > 0 && <div className="flex justify-between"><span className="text-ink-600">Descuento ({sale.descuentoPct}%)</span><span>-{formatCurrency(sale.descuento)}</span></div>}
            <div className="flex justify-between font-display text-base font-semibold text-ink-950"><span>Total</span><span>{formatCurrency(sale.total)}</span></div>
            {Number(sale.saldoPendiente) > 0 && (
              <div className="flex justify-between text-brick-500">
                <span>Pendiente de cobro</span>
                <span className="font-medium">{formatCurrency(sale.saldoPendiente)}</span>
              </div>
            )}
          </div>
        </Card>

        <div className="space-y-5">
          <Card>
            <p className="mb-3 font-display text-sm font-semibold text-ink-950">Cliente</p>
            <dl className="space-y-2 text-sm">
              <Field label="Nombre" value={sale.cliente ? `${sale.cliente.nombre} ${sale.cliente.apellido || ""}` : "Consumidor final"} />
              <Field label="CUIT" value={sale.cliente?.cuit || "—"} />
              <Field label="Email" value={sale.cliente?.email || "—"} />
              <Field label="Teléfono" value={sale.cliente?.telefono || "—"} />
            </dl>
          </Card>
          <Card>
            <p className="mb-3 font-display text-sm font-semibold text-ink-950">Operación</p>
            <dl className="space-y-2 text-sm">
              <Field label="Empleado" value={sale.empleado ? `${sale.empleado.nombre} ${sale.empleado.apellido}` : "—"} />
              <Field label="Local" value={sale.local?.nombre || "—"} />
              <Field label="Notas" value={sale.notas || "—"} />
            </dl>

            {/*
              Desglose del cobro. Con pago combinado el campo `medioPago` sólo
              dice "Efectivo + Transferencia", que no alcanza para saber cuánto
              entró por cada uno ni para cuadrar la caja.
            */}
            <p className="mb-2 mt-4 font-display text-sm font-semibold text-ink-950">Cobro</p>
            {sale.pagos?.length ? (
              <div className="space-y-2 text-sm">
                {sale.pagos.map((p) => (
                  <div key={p.id} className="flex items-baseline justify-between gap-3">
                    <span className="flex items-center gap-2">
                      <span className={`badge ${medioPagoBadge(p.nombre)}`}>{p.nombre}</span>
                      {Number(p.ajusteMonto) !== 0 && (
                        <span className="text-xs text-ink-500">
                          {formatCurrency(p.monto)} {Number(p.ajusteMonto) > 0 ? "+" : "−"} {p.ajustePct}%
                        </span>
                      )}
                    </span>
                    <span className="font-medium tabular-nums text-ink-950">{formatCurrency(p.montoFinal)}</span>
                  </div>
                ))}
                {Number(sale.recargoPagos) !== 0 && (
                  <div className="flex items-baseline justify-between gap-3 border-t border-ink-100 pt-2">
                    <span className="text-ink-600">Total cobrado</span>
                    <span className="font-semibold tabular-nums text-ink-950">
                      {formatCurrency(sale.totalCobrado || sale.total)}
                    </span>
                  </div>
                )}
              </div>
            ) : sale.condicionPago === "cuenta_corriente" && sale.estado === "pendiente" ? (
              /* Fiada sin cobrar: todavía no hay medio de pago que mostrar,
                 porque se elige recién al cobrarla. */
              <p className="text-sm text-ink-600">
                Fiada — sin cobrar. El medio de pago se define al cobrarla.
              </p>
            ) : (
              <p className="text-sm text-ink-600">
                {sale.medioPago ? (
                  <span className={`badge ${medioPagoBadge(sale.medioPago)}`}>{sale.medioPago}</span>
                ) : "—"}
              </p>
            )}
            {!sale.stockDescontado && sale.tipo === "venta" && sale.estado !== "cancelado" && (
              <p className="mt-3 rounded-md bg-paper-100 px-3 py-2 text-xs text-ink-600">
                La mercadería todavía no salió del stock: sale al cobrar la venta.
              </p>
            )}
          </Card>
        </div>
      </div>

      <Modal open={payModal} onClose={() => setPayModal(false)} title={`Cobrar venta ${sale.numero}`}>
        <div className="space-y-4">
          {payError && <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{payError}</p>}

          <p className="text-sm text-ink-600">
            A cobrar: <span className="font-medium text-ink-950">{formatCurrency(aCobrar)}</span>
            {aCobrar < Number(sale.total) && (
              <span className="text-ink-500"> · ya pagó {formatCurrency(Number(sale.total) - aCobrar)} a cuenta</span>
            )}
            {!sale.stockDescontado && ". Al confirmar sale el stock de los productos vendidos."}
          </p>

          {sale.condicionPago === "cuenta_corriente" && sale.cliente && (
            <p className="rounded-md bg-paper-100 px-3 py-2 text-xs text-ink-700">
              Cobrar esta venta cancela la deuda de {sale.cliente.nombre} {sale.cliente.apellido || ""}.
            </p>
          )}

          {metodos.length === 0 ? (
            <p className="text-sm text-ink-500">No hay medios de pago cargados.</p>
          ) : (
            <PaymentSplit metodos={metodos} total={aCobrar} lineas={pagos} onChange={setPagos} />
          )}

          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => setPayModal(false)}>Cancelar</button>
            <button className="btn-accent" onClick={confirmarCobro} disabled={busy || metodos.length === 0}>
              {busy ? "Cobrando…" : `Cobrar ${formatCurrency(calcularTotales(pagos, metodos, aCobrar).totalCobro)}`}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={invoiceModal} onClose={() => setInvoiceModal(false)} title="Generar factura ARCA">
        <div className="space-y-4">
          {invoiceError && <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{invoiceError}</p>}
          <p className="text-sm text-ink-600">Completá los datos del cliente para la factura. Si tiene CUIT se generará Factura A, sino Factura B.</p>
          <div>
            <label className="label">Emisor (CUIT del negocio)</label>
            <select
              className="input"
              value={invoiceForm.businessCuitId}
              onChange={(e) => setInvoiceForm({ ...invoiceForm, businessCuitId: e.target.value })}
            >
              {businessCuits.length === 0 && <option value="">— Sin CUITs cargados —</option>}
              {businessCuits.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre} · {c.cuit}{c.esPrincipal ? " · principal" : ""}
                </option>
              ))}
            </select>
            {businessCuits.length > 1 && (
              <p className="mt-1 text-xs text-ink-500">Elegí desde cuál de tus CUITs se emite esta factura.</p>
            )}
          </div>
          <div>
            <label className="label">Tipo de factura</label>
            <select className="input" value={invoiceForm.tipo} onChange={(e) => setInvoiceForm({ ...invoiceForm, tipo: e.target.value })}>
              <option value="A">Factura A (con CUIT)</option>
              <option value="B">Factura B (consumidor final)</option>
              <option value="C">Factura C (monotributista)</option>
            </select>
          </div>
          <div><label className="label">CUIT del cliente</label><input className="input" value={invoiceForm.clienteCuit} onChange={(e) => setInvoiceForm({ ...invoiceForm, clienteCuit: e.target.value })} placeholder="20-12345678-3" /></div>
          <div><label className="label">Email del cliente</label><input className="input" type="email" value={invoiceForm.clienteEmail} onChange={(e) => setInvoiceForm({ ...invoiceForm, clienteEmail: e.target.value })} /></div>
          <div><label className="label">Dirección del cliente</label><input className="input" value={invoiceForm.clienteDireccion} onChange={(e) => setInvoiceForm({ ...invoiceForm, clienteDireccion: e.target.value })} /></div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={invoiceForm.enviarEmail} onChange={(e) => setInvoiceForm({ ...invoiceForm, enviarEmail: e.target.checked })} /> Enviar factura por email</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={invoiceForm.enviarWhatsapp} onChange={(e) => setInvoiceForm({ ...invoiceForm, enviarWhatsapp: e.target.checked })} /> Notificar por WhatsApp</label>
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => setInvoiceModal(false)}>Cancelar</button>
            <button className="btn-accent" onClick={handleGenerateInvoice} disabled={busy}>{busy ? "Generando…" : "Generar factura"}</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-600 shrink-0">{label}</dt>
      <dd className="text-right text-ink-900">{value}</dd>
    </div>
  );
}
