import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ScanLine, Trash2, Plus, Minus, XCircle, ShoppingCart,
  Receipt, Loader2, UserCircle2,
} from "lucide-react";
import { scanProduct } from "../services/productService";
import { createSale, printSaleTicket } from "../services/salesService";
import { fetchEmployees, fetchPos } from "../services/employeeService";
import { useBarcodeScanner } from "../hooks/useBarcodeScanner";
import { formatCurrency } from "../utils/formatters";
import { PageHeader, Card } from "../components/ui/Layout";

const MEDIOS_PAGO = ["Efectivo", "Débito", "Crédito", "Transferencia", "QR / Billetera"];
// Mismo criterio que el backend: 3 o más unidades es precio mayorista.
const UMBRAL_MAYORISTA = 3;

export default function PosPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const [medioPago, setMedioPago] = useState("Efectivo");
  const [employeeId, setEmployeeId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [employees, setEmployees] = useState([]);
  const [locations, setLocations] = useState([]);
  const [cobrando, setCobrando] = useState(false);
  const [ultimaVenta, setUltimaVenta] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    fetchEmployees().then(setEmployees).catch(() => {});
    fetchPos().then(setLocations).catch(() => {});
    inputRef.current?.focus();
  }, []);

  const totalUnidades = items.reduce((s, i) => s + i.cantidad, 0);
  const esMayorista = totalUnidades >= UMBRAL_MAYORISTA;
  const precioDe = (i) => (esMayorista ? i.precioMayorista : i.precioMinorista);
  const total = items.reduce((s, i) => s + precioDe(i) * i.cantidad, 0);

  async function procesarCodigo(codigo) {
    setError("");
    try {
      const p = await scanProduct(codigo);
      setItems((prev) => {
        const existente = prev.find((i) => i.id === p.id);
        if (existente) {
          // Producto repetido: sumamos una unidad en vez de duplicar la línea.
          return prev.map((i) => (i.id === p.id ? { ...i, cantidad: i.cantidad + 1 } : i));
        }
        return [...prev, { ...p, cantidad: 1 }];
      });
      beep(880, 70);
    } catch (e) {
      setError(e.response?.data?.message || `No se encontró el código ${codigo}`);
      beep(220, 200);
    }
  }

  useBarcodeScanner({ onScan: procesarCodigo, activo: !cobrando });

  function submitManual(e) {
    e.preventDefault();
    const codigo = inputRef.current?.value?.trim();
    if (!codigo) return;
    procesarCodigo(codigo);
    inputRef.current.value = "";
  }

  function cambiarCantidad(id, delta) {
    setItems((prev) => prev
      .map((i) => (i.id === id ? { ...i, cantidad: i.cantidad + delta } : i))
      .filter((i) => i.cantidad > 0));
  }

  function quitar(id) { setItems((prev) => prev.filter((i) => i.id !== id)); }

  async function cobrar() {
    if (!items.length) return;
    setCobrando(true); setError("");
    try {
      const venta = await createSale({
        tipo: "venta",
        fecha: new Date().toISOString().slice(0, 10),
        clientId: null,          // consumidor final
        locationId: locationId || null,
        employeeId: employeeId || null,
        estado: "pagado",        // en mostrador se cobra en el acto
        medioPago,
        items: items.map((i) => ({ productVariantId: i.id, cantidad: i.cantidad })),
      });
      setUltimaVenta(venta);
      setItems([]);
      inputRef.current?.focus();
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo registrar la venta");
    } finally {
      setCobrando(false);
    }
  }

  // ── Pantalla de venta cerrada ───────────────────────────────────
  if (ultimaVenta) {
    return (
      <div>
        <PageHeader title="Venta registrada" subtitle={`Comprobante ${ultimaVenta.numero}`} />
        <Card className="mx-auto max-w-md text-center">
          <p className="font-display text-4xl font-semibold text-teal-600">{formatCurrency(ultimaVenta.total)}</p>
          <p className="mt-1 text-sm text-ink-600">{ultimaVenta.medioPago}</p>
          <div className="mt-6 flex flex-col gap-2">
            <button className="btn-accent justify-center" onClick={() => printSaleTicket(ultimaVenta)}>
              <Receipt size={15} /> Imprimir ticket
            </button>
            <button className="btn-ghost justify-center" onClick={() => { setUltimaVenta(null); inputRef.current?.focus(); }}>
              <ScanLine size={15} /> Nueva venta
            </button>
            <button className="btn-ghost justify-center text-xs" onClick={() => navigate(`/ventas/${ultimaVenta.id}`)}>
              Ver detalle de la venta
            </button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Punto de venta" subtitle="Escaneá los productos y cobrá" />

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Carrito */}
        <div className="lg:col-span-2">
          <Card className="mb-4">
            <form onSubmit={submitManual}>
              <div className="flex items-center gap-2 rounded-md border-2 border-dashed border-teal-300 bg-teal-50/50 px-3 py-3">
                <ScanLine size={20} className="shrink-0 animate-pulse text-teal-600" />
                <input
                  ref={inputRef}
                  data-scanner="true"
                  className="w-full bg-transparent font-mono text-sm outline-none placeholder:text-ink-400"
                  placeholder="Escaneá un producto o escribí el código…"
                  autoComplete="off"
                />
              </div>
            </form>
            {error && (
              <p className="mt-2 flex items-center gap-1.5 text-sm text-brick-500"><XCircle size={14} /> {error}</p>
            )}
          </Card>

          <Card className="p-0">
            {items.length === 0 ? (
              <div className="px-4 py-16 text-center">
                <ShoppingCart size={32} className="mx-auto text-ink-300" />
                <p className="mt-3 text-sm text-ink-600">Escaneá el primer producto para empezar.</p>
              </div>
            ) : (
              <div className="max-h-[440px] overflow-y-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {items.map((i) => (
                      <tr key={i.id} className="border-b border-line last:border-0">
                        <td className="px-4 py-3">
                          <p className="font-medium text-ink-900">{i.titulo}</p>
                          <p className="mt-0.5 text-xs text-ink-500">
                            <span className="tag-chip">{i.sku}</span>
                            {[i.variante1Valor, i.variante2Valor].filter(Boolean).length > 0 && (
                              <span className="ml-1">{[i.variante1Valor, i.variante2Valor].filter(Boolean).join(" · ")}</span>
                            )}
                            {i.cantidad > i.stock && (
                              <span className="ml-2 text-brick-500">Stock: {i.stock}</span>
                            )}
                          </p>
                        </td>
                        <td className="px-2 py-3 text-right text-xs text-ink-600 whitespace-nowrap">
                          {formatCurrency(precioDe(i))} c/u
                        </td>
                        <td className="px-2 py-3">
                          <div className="flex items-center justify-center gap-1">
                            <button className="btn-ghost px-1.5 py-1" onClick={() => cambiarCantidad(i.id, -1)}><Minus size={13} /></button>
                            <span className="w-8 text-center font-display font-semibold">{i.cantidad}</span>
                            <button className="btn-ghost px-1.5 py-1" onClick={() => cambiarCantidad(i.id, 1)}><Plus size={13} /></button>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right font-display font-semibold text-ink-900 whitespace-nowrap">
                          {formatCurrency(precioDe(i) * i.cantidad)}
                        </td>
                        <td className="px-2 py-3">
                          <button className="btn-ghost px-1.5 py-1 text-brick-500" onClick={() => quitar(i.id)}><Trash2 size={13} /></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        {/* Totales y cobro */}
        <div className="space-y-4">
          <Card>
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-ink-600">{totalUnidades} {totalUnidades === 1 ? "unidad" : "unidades"}</span>
              {esMayorista && <span className="rounded bg-brass-50 px-2 py-0.5 text-xs font-medium text-brass-700">Precio mayorista</span>}
            </div>
            <p className="mt-2 font-display text-4xl font-semibold text-ink-950">{formatCurrency(total)}</p>
          </Card>

          <Card>
            <label className="label">Medio de pago</label>
            <div className="grid grid-cols-2 gap-2">
              {MEDIOS_PAGO.map((m) => (
                <button
                  key={m} type="button" onClick={() => setMedioPago(m)}
                  className={`rounded-md border px-2 py-2 text-xs font-medium transition ${
                    medioPago === m ? "border-ink-950 bg-ink-950 text-paper-50" : "border-line bg-paper-50 hover:bg-paper-100"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </Card>

          <Card>
            <p className="mb-2 flex items-center gap-1.5 text-xs text-ink-500">
              <UserCircle2 size={13} /> Se registra como consumidor final
            </p>
            <label className="label">Vendedor</label>
            <select className="input mb-3" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">Sin asignar</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.nombre} {e.apellido || ""}</option>)}
            </select>
            <label className="label">Local</label>
            <select className="input" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Sin asignar</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
            </select>
          </Card>

          <button
            className="btn-accent w-full justify-center py-3 text-base"
            disabled={!items.length || cobrando}
            onClick={cobrar}
          >
            {cobrando ? <><Loader2 size={16} className="animate-spin" /> Registrando…</> : <>Cobrar {formatCurrency(total)}</>}
          </button>
          {items.length > 0 && (
            <button className="btn-ghost w-full justify-center text-xs text-brick-500" onClick={() => setItems([])}>
              Vaciar carrito
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function beep(frecuencia, duracionMs) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = frecuencia;
    gain.gain.value = 0.08;
    osc.start();
    setTimeout(() => { osc.stop(); ctx.close(); }, duracionMs);
  } catch { /* audio bloqueado, no es crítico */ }
}
