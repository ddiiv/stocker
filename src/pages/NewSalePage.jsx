import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Trash2, UserPlus, UserCircle2, Check } from "lucide-react";
import ProductPicker from "../components/sales/ProductPicker";
import { fetchEmployees, fetchLocalesDeVenta, fetchClients, createClient } from "../services/employeeService";
import { createSale } from "../services/salesService";
import { fetchPaymentMethods } from "../services/paymentMethodService";
import PaymentSplit, { lineasParaApi, calcularTotales } from "../components/sales/PaymentSplit";
import { formatCurrency } from "../utils/formatters";
import { esMayorista as evaluarMayorista, describir as describirRegla } from "../utils/reglaMayorista";
import { PageHeader, Card } from "../components/ui/Layout";
import AvisoError from "../components/ui/AvisoError";
import { analizarError } from "../utils/errores";
import { useAuth } from "../context/AuthContext";
import { esAdministradorTotal } from "../utils/permissions";

const today = () => new Date().toISOString().slice(0, 10);

export default function NewSalePage() {
  const navigate = useNavigate();
  const [tipo, setTipo] = useState("venta");
  const [fecha, setFecha] = useState(today());
  const [items, setItems] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [locations, setLocations] = useState([]);
  const [clients, setClients] = useState([]);
  const [clientSearch, setClientSearch] = useState("");
  const [selectedClientId, setSelectedClientId] = useState("");
  const [consumidorFinal, setConsumidorFinal] = useState(false);
  const [employeeId, setEmployeeId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [descuentoPct, setDescuentoPct] = useState(0);
  const [metodos, setMetodos] = useState([]);
  const [pagos, setPagos] = useState([]);
  const [marcarPagada, setMarcarPagada] = useState(false);
  const [notas, setNotas] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
    const { user } = useAuth();
  const puedeElegirVendedor = esAdministradorTotal(user);

  useEffect(() => {
    // El listado de empleados exige permiso de "empleados", que un vendedor no
    // tiene. Pedirlo igual devolvía 403 y disparaba el modal de permisos al
    // entrar, bloqueando una venta que la persona sí puede hacer.
    // El servidor asigna el vendedor y el local desde la sesión de todos modos.
    if (puedeElegirVendedor) {
      fetchEmployees().then((emps) => { setEmployees(emps.filter((e) => e.activo)); if (emps[0]) setEmployeeId(emps[0].id); });
      fetchLocalesDeVenta().then((pos) => {
        setLocations(pos);
        /*
         * Sólo se preselecciona si hay uno.
         *
         * Antes se elegía el primero siempre, y con varios locales eso es una
         * decisión tomada por el sistema: el stock salía del primero de la
         * lista aunque la venta fuera de otra sucursal.
         */
        if (pos.length === 1) setLocationId(pos[0].id);
      });
    }
    fetchClients().then(setClients);
    fetchPaymentMethods({ soloActivos: true })
      .then((m) => {
        setMetodos(m);
        if (m.length) setPagos([{ paymentMethodId: m[0].id, monto: 0, ajusteManual: "" }]);
      })
      .catch(() => {});
  }, [puedeElegirVendedor]);

  useEffect(() => {
    const t = setTimeout(() => { if (clientSearch) fetchClients(clientSearch).then(setClients); }, 300);
    return () => clearTimeout(t);
  }, [clientSearch]);

  function addItem(variant) {
    setItems((prev) => {
      const existing = prev.find((i) => i.variantId === variant.id);
      if (existing) return prev.map((i) => i.variantId === variant.id ? { ...i, cantidad: i.cantidad + 1 } : i);
      return [...prev, {
        variantId: variant.id,
        productVariantId: variant.id,
        sku: variant.sku,
        titulo: variant.title,
        variante1Nombre: variant.variante1Nombre, variante1Valor: variant.variante1Valor,
        variante2Nombre: variant.variante2Nombre, variante2Valor: variant.variante2Valor,
        cantidad: 1,
        precioUnitario: variant.precioMinorista,
        precioMayorista: variant.precioMayorista,
      }];
    });
  }

  const totalUnidades = items.reduce((s, i) => s + i.cantidad, 0);

  // La misma regla que aplica el servidor, tomada del local elegido. Ver
  // utils/reglaMayorista: antes este `>= 3` estaba escrito tres veces.
  const localRegla = locations.find((l) => String(l.id) === String(locationId)) || null;
  const totalEnLista = items.reduce((s, i) => s + (Number(i.precioUnitario) || 0) * i.cantidad, 0);
  const esMayorista   = evaluarMayorista(localRegla, totalUnidades, totalEnLista);
  const subtotal = items.reduce((s, i) => s + i.cantidad * (esMayorista ? i.precioMayorista : i.precioUnitario), 0);
  const descuento = Math.round(subtotal * descuentoPct / 100);
  const total     = subtotal - descuento;
  // Con recargo por medio de pago, lo que se le cobra al cliente difiere del
  // neto de mercadería. El resumen tiene que mostrar el importe real.
  const { ajusteTotal, totalCobro } = calcularTotales(pagos, metodos, total);
  const cobraAhora = tipo === "venta" && marcarPagada && metodos.length > 0;

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (!items.length) return setError({ tipo: "validacion", titulo: "Agregá al menos un producto." });
    if (puedeElegirVendedor && !employeeId) return setError({ tipo: "validacion", titulo: "Seleccioná el empleado que realiza la venta." });
    setSubmitting(true);
    try {
      const sale = await createSale({
        tipo, fecha, clientId: selectedClientId || null,
        locationId: locationId || null,
        employeeId,
        items: items.map((i) => ({ productVariantId: i.productVariantId, cantidad: i.cantidad })),
        descuentoPct,
        estado: tipo === "venta" && marcarPagada ? "pagado" : "pendiente",
        pagos: tipo === "venta" && marcarPagada ? lineasParaApi(pagos, metodos, total) : undefined,
        notas,
      });
      navigate(`/ventas/${encodeURIComponent(sale.numero)}`);
    } catch (err) {
      /*
       * El error se clasifica antes de mostrarlo.
       *
       * "No se pudo registrar la venta" no distingue entre quedarse sin stock,
       * no tener turno de caja, haber perdido la sesión o que el servidor esté
       * caído — y cada una se arregla distinto. `analizarError` devuelve la
       * causa concreta y, cuando existe, el atajo que la destraba.
       */
      setError(analizarError(err, "No se pudo registrar la venta."));
    } finally { setSubmitting(false); }
  }

  return (
    <form onSubmit={handleSubmit}>
      <PageHeader title="Nueva venta / cotización" subtitle="Seleccioná los productos, el cliente y el empleado" />
      <AvisoError error={error} className="mb-4" />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <div className="mb-4 flex items-center gap-2">
              <TypeToggle tipo={tipo} setTipo={setTipo} />
              <input type="date" className="input ml-auto w-auto" value={fecha} onChange={(e) => setFecha(e.target.value)} />
            </div>
            {/* El "≥ 3 prendas" estaba escrito a mano y dejó de ser cierto en
                cuanto cada local pudo tener su regla: un cartel que afirma algo
                que el sistema ya no hace es peor que no tener cartel. */}
            {esMayorista
              ? (
                <p className="mb-3 rounded-md bg-teal-50 px-3 py-2 text-xs font-medium text-teal-600">
                  ✓ Precio MAYORISTA aplicado — {describirRegla(localRegla)}
                </p>
              )
              : localRegla && (
                <p className="mb-3 text-xs text-ink-500">{describirRegla(localRegla)}</p>
              )}
            <ProductPicker onPick={addItem} locationId={locationId || null} />
            <div className="mt-4 overflow-x-auto">
              {items.length === 0 ? (
                <p className="py-8 text-center text-sm text-ink-500">Todavía no agregaste productos.</p>
              ) : (
                <table className="w-full min-w-[520px] text-sm">
                  <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-600">
                    <th className="py-2 font-medium">Producto</th><th className="py-2 font-medium">Variante</th>
                    <th className="py-2 font-medium">Cant.</th><th className="py-2 font-medium">Precio</th>
                    <th className="py-2 font-medium">Subtotal</th><th className="py-2 font-medium" />
                  </tr></thead>
                  <tbody>
                    {items.map((i) => {
                      const precio = esMayorista ? i.precioMayorista : i.precioUnitario;
                      return (
                        <tr key={i.variantId} className="border-b border-line last:border-0">
                          <td className="py-2 pr-2"><p className="text-ink-900">{i.titulo}</p><span className="tag-chip mt-1">{i.sku}</span></td>
                          <td className="py-2 pr-2 text-ink-700">{i.variante1Valor}{i.variante2Valor ? ` · ${i.variante2Valor}` : ""}</td>
                          <td className="py-2 pr-2">
                            <input type="number" min="1" className="input h-8 w-16 text-xs" value={i.cantidad}
                              onChange={(e) => setItems((prev) => prev.map((x) => x.variantId === i.variantId ? { ...x, cantidad: Math.max(1, Number(e.target.value)) } : x))} />
                          </td>
                          <td className="py-2 pr-2 text-ink-700">{formatCurrency(precio)}</td>
                          <td className="py-2 pr-2 font-medium text-ink-900">{formatCurrency(i.cantidad * precio)}</td>
                          <td className="py-2"><button type="button" className="btn-danger px-2 py-1.5" onClick={() => setItems((prev) => prev.filter((x) => x.variantId !== i.variantId))}><Trash2 size={13} /></button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </Card>

          <Card>
            <p className="mb-4 font-display text-sm font-semibold text-ink-950">Cliente</p>

            {/* Consumidor final: venta rápida sin datos del cliente. Es el caso
                del mostrador, donde no hace falta identificarlo ni facturar. */}
            <button
              type="button"
              onClick={() => { setConsumidorFinal(true); setSelectedClientId(""); setClientSearch(""); }}
              className={`mb-3 w-full rounded-md border px-3 py-2 text-left text-sm transition ${
                consumidorFinal
                  ? "border-teal-500 bg-teal-50 text-teal-700"
                  : "border-line bg-paper-50 text-ink-700 hover:bg-paper-100"
              }`}
            >
              <span className="flex items-center gap-2">
                <UserCircle2 size={15} />
                Consumidor final
                {consumidorFinal && <Check size={14} className="ml-auto" />}
              </span>
              <span className="mt-0.5 block text-xs text-ink-500">Venta sin datos del cliente</span>
            </button>

            <div className="mb-3">
              <label className="label">O buscar cliente registrado</label>
              <input
                className="input"
                placeholder="Nombre, email o CUIT…"
                value={clientSearch}
                onChange={(e) => { setClientSearch(e.target.value); if (e.target.value) setConsumidorFinal(false); }}
              />
              {clients.length > 0 && clientSearch && (
                <div className="mt-1 rounded-md border border-line bg-paper-50 shadow">
                  {clients.map((c) => (
                    <button type="button" key={c.id}
                      onClick={() => { setSelectedClientId(c.id); setConsumidorFinal(false); setClientSearch(`${c.nombre} ${c.apellido || ""}`); }}
                      className="flex w-full items-center justify-between border-b border-line px-3 py-2 text-left text-sm last:border-0 hover:bg-paper-100">
                      <span>{c.nombre} {c.apellido}</span>
                      <span className="text-xs text-ink-500">{c.cuit || c.email}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <p className="text-xs text-ink-500">
              {consumidorFinal
                ? "La venta se registra como consumidor final, sin datos personales."
                : "Si no está registrado podés elegir consumidor final o crearlo en la sección de Clientes."}
            </p>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <p className="mb-4 font-display text-sm font-semibold text-ink-950">Empleado y local</p>
            {puedeElegirVendedor ? (
              <div className="space-y-4">
                <div>
                  <label className="label">Empleado</label>
                  <select className="input" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                    {employees.map((e) => <option key={e.id} value={e.id}>{e.nombre} {e.apellido}</option>)}
                  </select>
                </div>
                <div>
                  {/* Ya no existe "sin local específico": el stock sale de un
                      local concreto y hay que decir de cuál. */}
                  <label className="label">Local <span className="text-brick-500">*</span></label>
                  <select className={`input ${!locationId ? "border-brick-500" : ""}`}
                    value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                    <option value="">Elegí el local…</option>
                    {locations.map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
                  </select>
                </div>
              </div>
            ) : (
              /*
               * Un empleado no elige: vende como él mismo y en su local, y el
               * servidor lo impone igual.
               *
               * Antes acá se dibujaban los dos desplegables vacíos: las listas
               * sólo se piden con permiso de empleados, que un vendedor no
               * tiene, así que quedaban sin opciones. Ofrecer una decisión que
               * no se puede tomar —y que además el servidor ignora— es peor que
               * no ofrecerla.
               */
              <div className="rounded-md bg-paper-100 px-3 py-2.5">
                <p className="text-xs uppercase tracking-wide text-ink-600">Vendedor</p>
                <p className="font-medium text-ink-900">
                  {[user?.nombre, user?.apellido].filter(Boolean).join(" ") || "Tu usuario"}
                </p>
                {user?.local?.nombre ? (
                  <>
                    <p className="mt-2 text-xs uppercase tracking-wide text-ink-600">Local</p>
                    <p className="font-medium text-ink-900">{user.local.nombre}</p>
                    <p className="mt-2 text-xs text-ink-500">
                      Se registran automáticamente con tu sesión. El stock sale de este local.
                    </p>
                  </>
                ) : (
                  <p className="mt-2 rounded-md bg-brick-50 px-2 py-1.5 text-xs text-brick-600">
                    No tenés un local asignado, así que no vas a poder registrar la venta.
                    Pedile al dueño que te asigne uno desde Empleados.
                  </p>
                )}
              </div>
            )}
          </Card>

          <Card>
            <p className="mb-4 font-display text-sm font-semibold text-ink-950">Totales</p>
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-ink-600">Total unidades</span>
                <span className={`font-medium ${esMayorista ? "text-teal-600" : "text-ink-900"}`}>{totalUnidades} {esMayorista ? "(mayorista)" : "(minorista)"}</span>
              </div>
              <div className="flex items-center justify-between"><span className="text-ink-600">Subtotal</span><span>{formatCurrency(subtotal)}</span></div>
              <div className="flex items-center justify-between">
                <span className="text-ink-600">Descuento (%)</span>
                <input type="number" min="0" max="100" className="input h-8 w-20 text-right text-xs" value={descuentoPct} onChange={(e) => setDescuentoPct(Number(e.target.value))} />
              </div>
              <div className="flex items-center justify-between border-t border-line pt-3 font-display text-base font-semibold text-ink-950">
                <span>Total</span><span>{formatCurrency(total)}</span>
              </div>
              {cobraAhora && ajusteTotal !== 0 && (
                <div className="mt-1 space-y-0.5 border-t border-line pt-1 text-sm">
                  <div className={`flex justify-between ${ajusteTotal > 0 ? "text-brick-500" : "text-teal-600"}`}>
                    <span>{ajusteTotal > 0 ? "Recargo" : "Descuento"} por medio de pago</span>
                    <span>{ajusteTotal > 0 ? "+" : "−"}{formatCurrency(Math.abs(ajusteTotal))}</span>
                  </div>
                  <div className="flex justify-between font-display font-semibold text-ink-950">
                    <span>A cobrar</span><span>{formatCurrency(totalCobro)}</span>
                  </div>
                </div>
              )}
            </div>

            {tipo === "venta" && (
              <div className="mt-4 space-y-3 border-t border-line pt-4">
                <label className="flex items-center gap-2 text-sm text-ink-700">
                  <input type="checkbox" checked={marcarPagada} onChange={(e) => setMarcarPagada(e.target.checked)} />
                  Marcar como cobrada ahora
                </label>
                {/* Mismo componente que el punto de venta: antes esta pantalla
                    tenía una lista de medios escrita a mano, así que sus ventas
                    no llevaban recargo ni se discriminaban en la factura. */}
                {marcarPagada && (
                  metodos.length === 0 ? (
                    <p className="text-xs text-ink-500">
                      No hay medios de pago cargados. Pedile al dueño que configure al menos uno.
                    </p>
                  ) : (
                    <PaymentSplit metodos={metodos} total={total} lineas={pagos} onChange={setPagos} />
                  )
                )}
              </div>
            )}

            <div className="mt-4">
              <label className="label">Notas</label>
              <textarea className="input min-h-16" value={notas} onChange={(e) => setNotas(e.target.value)} />
            </div>
            <button className="btn-accent mt-4 w-full" type="submit" disabled={submitting}>
              {submitting ? "Guardando…" : tipo === "venta" ? "Registrar venta" : "Guardar cotización"}
            </button>
          </Card>
        </div>
      </div>
    </form>
  );
}

function TypeToggle({ tipo, setTipo }) {
  return (
    <div className="flex rounded-md border border-line bg-paper-100 p-1">
      {[{ v: "venta", label: "Venta" }, { v: "cotizacion", label: "Cotización" }].map((opt) => (
        <button key={opt.v} type="button" onClick={() => setTipo(opt.v)}
          className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${tipo === opt.v ? "bg-ink-950 text-paper-50" : "text-ink-600 hover:bg-paper-200"}`}>
          {opt.label}
        </button>
      ))}
    </div>
  );
}
