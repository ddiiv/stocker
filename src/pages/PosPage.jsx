import { useEffect, useRef, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  ScanLine, Trash2, Plus, Minus, XCircle, ShoppingCart,
  Receipt, Loader2, UserCircle2,
} from "lucide-react";
import { scanProduct } from "../services/productService";
import { createSale, printSaleTicket } from "../services/salesService";
import { fetchEmployees, fetchPos } from "../services/employeeService";
import { fetchClients } from "../services/clientService";
import { fetchPaymentMethods } from "../services/paymentMethodService";
import { useBarcodeScanner } from "../hooks/useBarcodeScanner";
import { formatCurrency } from "../utils/formatters";
import { PageHeader, Card } from "../components/ui/Layout";
import { useAuth } from "../context/AuthContext";
import { esAdministradorTotal } from "../utils/permissions";
import PaymentSplit, { lineasParaApi, calcularTotales } from "../components/sales/PaymentSplit";
// Mismo criterio que el backend: 3 o más unidades es precio mayorista.
const UMBRAL_MAYORISTA = 3;

export default function PosPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  // El dueño elige vendedor y local; el empleado vende siempre como él mismo
  // y en su local. El backend lo impone igual, esto sólo evita mostrar
  // controles que no van a tener efecto.
  const puedeElegirVendedor = esAdministradorTotal(user);

  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const [metodos, setMetodos] = useState([]);
  const [pagos, setPagos] = useState([]);
  const [employeeId, setEmployeeId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [employees, setEmployees] = useState([]);
  const [locations, setLocations] = useState([]);
  const [clientes, setClientes] = useState([]);
  const [clientId, setClientId] = useState("");
  const [buscarCliente, setBuscarCliente] = useState("");
  const [cobrando, setCobrando] = useState(false);
  const [ultimaVenta, setUltimaVenta] = useState(null);
  const [faltaTurno, setFaltaTurno] = useState(false);
  const [resaltado, setResaltado] = useState(null);
  const inputRef = useRef(null);
  const resaltadoTimer = useRef(null);

  useEffect(() => () => clearTimeout(resaltadoTimer.current), []);

  useEffect(() => {
    // Un empleado no tiene permiso de ver el padrón de empleados ni la lista
    // de locales para elegir, así que esas dos sólo se piden si va a usarlas.
    if (puedeElegirVendedor) {
      fetchEmployees().then(setEmployees).catch(() => {});
      fetchPos().then(setLocations).catch(() => {});
    }
    fetchClients().then((c) => setClientes(c.data || c)).catch(() => {});
    fetchPaymentMethods({ soloActivos: true })
      .then((m) => {
        setMetodos(m);
        // Arranca con una sola línea: el medio por defecto cubre todo.
        if (m.length) setPagos([{ paymentMethodId: m[0].id, monto: 0, ajusteManual: "" }]);
      })
      .catch(() => {});
    inputRef.current?.focus();
  }, [puedeElegirVendedor]);

  const totalUnidades = items.reduce((s, i) => s + i.cantidad, 0);
  const esMayorista = totalUnidades >= UMBRAL_MAYORISTA;
  const precioDe = (i) => (esMayorista ? i.precioMayorista : i.precioMinorista);
  const total = items.reduce((s, i) => s + precioDe(i) * i.cantidad, 0);

  // El backend rechaza el cobro si los importes no suman el total. Chequearlo
  // acá evita mandar una venta que ya se sabe que va a fallar.
  const sumaPagos = pagos.reduce((s, p) => s + (Number(p.monto) || 0), 0);
  const pagosCuadran = pagos.length === 1 || Math.abs(total - sumaPagos) < 0.02;
  const puedeCobrar = items.length > 0 && metodos.length > 0 && pagosCuadran && !cobrando;

  // El botón muestra lo que hay que pedirle al cliente, recargo incluido.
  const { totalCobro } = calcularTotales(pagos, metodos, total);

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
      // Escaneando rápido no se alcanza a leer la tabla: resaltar la línea que
      // acaba de cambiar es lo que permite confirmar que sumó al producto
      // correcto y no creó una línea nueva.
      setResaltado(p.id);
      clearTimeout(resaltadoTimer.current);
      resaltadoTimer.current = setTimeout(() => setResaltado(null), 1200);
      beep(880, 70);
    } catch (e) {
      setError(e.response?.data?.message || `No se encontró el código ${codigo}`);
      beep(220, 200);
    }
  }

  // Siempre activo salvo mientras se está cobrando, para que un escaneo
  // accidental no altere una venta que ya se está registrando.
  const { scannerActivo, lecturas } = useBarcodeScanner({ onScan: procesarCodigo, activo: !cobrando });

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
        // Sin cliente elegido la venta es a consumidor final.
        clientId: clientId ? Number(clientId) : null,
        locationId: locationId || null,
        employeeId: employeeId || null,
        estado: "pagado",        // en mostrador se cobra en el acto
        pagos: lineasParaApi(pagos, metodos, total),
        items: items.map((i) => ({ productVariantId: i.id, cantidad: i.cantidad })),
      });
      setUltimaVenta(venta);
      setItems([]);
      setClientId("");
      setBuscarCliente("");
      if (metodos.length) setPagos([{ paymentMethodId: metodos[0].id, monto: 0, ajusteManual: "" }]);
      inputRef.current?.focus();
    } catch (e) {
      const msg = e.response?.data?.message || "No se pudo registrar la venta";
      // Sin turno abierto el backend responde 409: se ofrece el atajo para
      // abrirlo en vez de dejar al cajero adivinando qué falta.
      setFaltaTurno(e.response?.status === 409 && /turno de caja/i.test(msg));
      setError(msg);
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
          {/* Lo cobrado, no el neto: con recargo son importes distintos y el
              cajero necesita ver el que le pidió al cliente. */}
          <p className="font-display text-4xl font-semibold text-teal-600">
            {formatCurrency(ultimaVenta.totalCobrado || ultimaVenta.total)}
          </p>
          <p className="mt-1 text-sm text-ink-600">{ultimaVenta.medioPago}</p>
          {Number(ultimaVenta.recargoPagos) !== 0 && (
            <p className="mt-1 text-xs text-ink-500">
              Mercadería {formatCurrency(ultimaVenta.total)}
              {Number(ultimaVenta.recargoPagos) > 0 ? " + recargo " : " − descuento "}
              {formatCurrency(Math.abs(Number(ultimaVenta.recargoPagos)))}
            </p>
          )}
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
              <div className={`flex items-center gap-2 rounded-md border-2 border-dashed px-3 py-3 transition-colors ${
                scannerActivo ? "border-teal-400 bg-teal-50" : "border-line bg-paper-100/60"
              }`}>
                {/* Late sólo cuando hay lecturas reales: un ícono animado
                    permanente no distingue "funciona" de "no hay lector". */}
                <ScanLine size={20} className={`shrink-0 ${scannerActivo ? "animate-pulse text-teal-600" : "text-ink-400"}`} />
                <input
                  ref={inputRef}
                  data-scanner="true"
                  className="w-full bg-transparent font-mono text-sm outline-none placeholder:text-ink-400"
                  placeholder="Escaneá un producto o escribí el código…"
                  autoComplete="off"
                />
                {lecturas > 0 && (
                  <span className="shrink-0 text-xs tabular-nums text-ink-500">{lecturas} lect.</span>
                )}
              </div>
            </form>
            {error && (
              <div className="mt-2 text-sm text-brick-500">
                <p className="flex items-center gap-1.5"><XCircle size={14} /> {error}</p>
                {faltaTurno && (
                  <Link to="/caja" className="ml-5 mt-1 inline-block font-medium underline">
                    Abrir mi turno de caja
                  </Link>
                )}
              </div>
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
                      <tr
                        key={i.id}
                        className={`border-b border-line last:border-0 transition-colors ${
                          resaltado === i.id ? "bg-teal-50" : ""
                        }`}
                      >
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
            <label className="label">Cómo paga</label>
            {metodos.length === 0 ? (
              <p className="text-xs text-ink-500">
                No hay medios de pago cargados. Pedile al dueño que configure al menos uno.
              </p>
            ) : (
              <PaymentSplit metodos={metodos} total={total} lineas={pagos} onChange={setPagos} />
            )}
          </Card>

          <Card>
            <label className="label">Cliente</label>
            {clientId ? (
              <div className="flex items-center justify-between rounded-md border border-line bg-paper-100 px-3 py-2">
                <span className="text-sm text-ink-900">
                  {(() => {
                    const c = clientes.find((x) => String(x.id) === String(clientId));
                    return c ? `${c.nombre} ${c.apellido || ""}`.trim() : "Cliente";
                  })()}
                </span>
                <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => { setClientId(""); setBuscarCliente(""); }}>
                  Quitar
                </button>
              </div>
            ) : (
              <>
                <input
                  className="input"
                  placeholder="Buscar cliente por nombre…"
                  value={buscarCliente}
                  onChange={(e) => setBuscarCliente(e.target.value)}
                />
                {buscarCliente.trim().length >= 2 && (
                  <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-line">
                    {clientes
                      .filter((c) => `${c.nombre} ${c.apellido || ""}`.toLowerCase().includes(buscarCliente.toLowerCase()))
                      .slice(0, 8)
                      .map((c) => (
                        <button
                          key={c.id} type="button"
                          className="block w-full px-3 py-2 text-left text-sm hover:bg-paper-100"
                          onClick={() => { setClientId(c.id); setBuscarCliente(""); }}
                        >
                          {c.nombre} {c.apellido || ""}
                        </button>
                      ))}
                  </div>
                )}
                <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-500">
                  <UserCircle2 size={13} /> Sin elegir cliente se registra como consumidor final.
                </p>
              </>
            )}
          </Card>

          {/* El empleado vende siempre como él mismo y en su local: el backend
              ignora lo que llegue en el request, así que no se muestran los
              desplegables para no sugerir una elección que no existe. */}
          {puedeElegirVendedor ? (
            <Card>
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
          ) : (
            <Card className="bg-paper-100">
              <p className="text-xs uppercase tracking-wide text-ink-600">Vendedor</p>
              <p className="font-medium text-ink-900">{user?.nombre} {user?.apellido || ""}</p>
              {user?.local?.nombre && (
                <>
                  <p className="mt-2 text-xs uppercase tracking-wide text-ink-600">Local</p>
                  <p className="font-medium text-ink-900">{user.local.nombre}</p>
                </>
              )}
              <p className="mt-2 text-xs text-ink-500">Se registran automáticamente con tu sesión.</p>
            </Card>
          )}

          <button
            className="btn-accent w-full justify-center py-3 text-base"
            disabled={!puedeCobrar}
            onClick={cobrar}
          >
            {cobrando
              ? <><Loader2 size={16} className="animate-spin" /> Registrando…</>
              : <>Cobrar {formatCurrency(totalCobro)}</>}
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
