import { useEffect, useMemo, useState } from "react";
import {
  Store, Check, X, Loader2, AlertTriangle, PackageSearch, RefreshCw, ExternalLink,
} from "lucide-react";
import { PageHeader, Card, EmptyState } from "../components/ui/Layout";
import ModalStockFaltante from "../components/sales/ModalStockFaltante";
import PaymentSplit, { lineasParaApi } from "../components/sales/PaymentSplit";
import {
  fetchSolicitudes, fetchSolicitud, aceptarSolicitud, rechazarSolicitud,
} from "../services/solicitudMayoristaService";
import { fetchLocalesDeVenta } from "../services/employeeService";
import { fetchClients } from "../services/clientService";
import { fetchPaymentMethods } from "../services/paymentMethodService";
import { formatCurrency, formatDateTime } from "../utils/formatters";
import { mensajeDeError } from "../utils/errores";
import { useAuth } from "../context/AuthContext";
import { canEdit } from "../utils/permissions";

/*
 * Pedidos mayoristas: lo que llega del portal y todavía no es una venta.
 *
 * El cliente arma el pedido afuera y lo confirma. Acá se mira, y recién al
 * aceptar nace la venta —con el local de quien aprueba, su caja y su decisión
 * de cobrarla o dejarla a cobrar—.
 *
 * ── Por qué se muestra tanto antes del botón ─────────────────────
 *
 * Porque aprobar a ciegas ya salió mal en reposición: se firmaba, y el
 * faltante aparecía cuando el local reclamaba. Acá, antes de aceptar, se ve
 * qué líneas Stocker no reconoce, con qué cliente matchea el CUIT y por cuánto
 * valorizó el pedido el portal. La diferencia de precio importa: el cliente ya
 * vio un total y la venta se registra con la lista de Stocker.
 */

const CHIP = {
  pendiente: "badge-low",
  aceptada:  "badge-ok",
  rechazada: "badge-out",
  cancelada: "badge-out",
};

const NOMBRE_ESTADO = {
  pendiente: "por revisar",
  aceptada:  "aceptada",
  rechazada: "rechazada",
  cancelada: "cancelada en el portal",
};

/* Lo que el portal propuso: es una sugerencia, no una orden. */
const CONDICION_SUGERIDA = {
  contado: "contado",
  cuenta_corriente: "cuenta corriente",
  financiado: "financiado",
};

export default function PedidosMayoristasPage() {
  const { user } = useAuth();
  const puedeDecidir = canEdit(user, "ventas");

  const [estado, setEstado] = useState("pendiente");
  const [lista, setLista] = useState([]);
  const [pendientes, setPendientes] = useState(0);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");

  const [abierta, setAbierta] = useState(null);      // el detalle que se está mirando
  const [locales, setLocales] = useState([]);
  const [clientes, setClientes] = useState([]);
  const [metodos, setMetodos] = useState([]);

  // Cómo se va a registrar la venta.
  const [locationId, setLocationId] = useState("");
  const [clientId, setClientId] = useState("");
  const [condicionPago, setCondicionPago] = useState("contado");
  const [pagos, setPagos] = useState([]);
  const [llevaMercaderia, setLlevaMercaderia] = useState(true);
  const [motivo, setMotivo] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [faltantes, setFaltantes] = useState(null);
  const [aviso, setAviso] = useState(null);

  async function cargar() {
    setCargando(true); setError("");
    try {
      const r = await fetchSolicitudes({ estado });
      setLista(r.solicitudes);
      setPendientes(r.pendientes);
    } catch (e) { setError(mensajeDeError(e, "No se pudieron traer los pedidos.")); }
    finally { setCargando(false); }
  }

  useEffect(() => { cargar(); /* eslint-disable-next-line */ }, [estado]);

  useEffect(() => {
    Promise.all([
      fetchLocalesDeVenta().catch(() => []),
      fetchClients("", { limit: 300 }).catch(() => []),
      fetchPaymentMethods({ soloActivos: true }).catch(() => []),
    ]).then(([l, c, m]) => {
      const deVenta = (Array.isArray(l) ? l : []).filter((x) => x.activo !== false);
      setLocales(deVenta);
      if (deVenta.length === 1) setLocationId(String(deVenta[0].id));
      setClientes(Array.isArray(c) ? c : c?.data || c?.clientes || []);
      const medios = Array.isArray(m) ? m : m?.data || [];
      setMetodos(medios);
      // Una línea de cobro para empezar, como hace el alta de ventas.
      if (medios.length) setPagos([{ paymentMethodId: medios[0].id, monto: 0, ajusteManual: "" }]);
    });
  }, []);

  async function abrir(id) {
    setError(""); setAviso(null); setMotivo("");
    try {
      const d = await fetchSolicitud(id);
      setAbierta(d);
      /*
       * Lo que el portal propuso entra cargado, pero se puede cambiar: el
       * límite de crédito lo conoce quien aprueba, no el portal.
       */
      setCondicionPago(d.pagoCondicion === "cuenta_corriente" ? "cuenta_corriente" : "contado");
      setClientId(d.clienteSugerido ? String(d.clienteSugerido.id) : "");
      /*
       * El cobro arranca de cero en cada pedido, con una línea: dejar las del
       * pedido anterior es cobrar el de ahora con el reparto del de antes.
       */
      setPagos(metodos.length ? [{ paymentMethodId: metodos[0].id, monto: 0, ajusteManual: "" }] : []);
    } catch (e) { setError(mensajeDeError(e, "No se pudo abrir el pedido.")); }
  }

  const total = Number(abierta?.total || 0);
  const puedeAceptar = Boolean(
    abierta && abierta.estado === "pendiente" && locationId
    && !abierta.sinIdentificar?.length
    && (condicionPago !== "cuenta_corriente" || clientId),
  );

  async function aceptar({ confirmarAltaStock = false } = {}) {
    if (!abierta) return;
    setGuardando(true); setError("");
    try {
      const r = await aceptarSolicitud(abierta.id, {
        locationId: Number(locationId),
        clientId: clientId ? Number(clientId) : null,
        condicionPago,
        confirmarAltaStock,
        ...(condicionPago === "contado"
          ? {
            estado: "pagado",
            /*
             * Las líneas se arman con el mismo helper que el alta de ventas:
             * el ajuste por medio de pago se calcula igual en los dos lados o
             * el cliente paga distinto según por qué pantalla entró.
             */
            pagos: pagos.length ? lineasParaApi(pagos, metodos, total) : undefined,
            medioPago: pagos.length ? undefined : "efectivo",
          }
          : { descontarStock: llevaMercaderia }),
      });
      setFaltantes(null);
      setAviso({
        tipo: "ok",
        texto: `Quedó registrada la venta ${r.venta?.numero}.`
          + (r.venta?.altaStock ? ` ${r.venta.altaStock.mensaje}` : ""),
        venta: r.venta?.numero,
      });
      setAbierta(r.solicitud);
      cargar();
    } catch (e) {
      const d = e.response?.data;
      /*
       * Falta stock: se pregunta, no se rechaza. Es el mismo modal que usa el
       * mostrador, y acá es el caso NORMAL —un pedido mayorista se hace a
       * pedido, así que lo habitual es que la mercadería todavía no esté.
       */
      if (d?.codigo === "SIN_STOCK" && d.faltantes?.length) {
        setFaltantes({ faltantes: d.faltantes, puedeConfirmar: d.puedeConfirmar !== false, local: d.local || null });
      } else {
        setError(mensajeDeError(e, "No se pudo aceptar el pedido."));
      }
    } finally { setGuardando(false); }
  }

  async function rechazar() {
    if (!abierta) return;
    setGuardando(true); setError("");
    try {
      const d = await rechazarSolicitud(abierta.id, motivo);
      setAbierta(d);
      setAviso({ tipo: "ok", texto: "El pedido quedó rechazado." });
      cargar();
    } catch (e) { setError(mensajeDeError(e, "No se pudo rechazar el pedido.")); }
    finally { setGuardando(false); }
  }

  /*
   * La diferencia entre lo que el portal valorizó y lo que Stocker va a
   * cobrar. Se muestra sumada y por renglón: el cliente ya vio un total.
   */
  const totalPortal = useMemo(
    () => (abierta?.items || []).reduce((s, i) => s + (Number(i.precioOrigen) || 0) * i.cantidad, 0),
    [abierta],
  );

  return (
    <div>
      <ModalStockFaltante
        open={Boolean(faltantes)}
        onClose={() => setFaltantes(null)}
        faltantes={faltantes?.faltantes || []}
        puedeConfirmar={faltantes?.puedeConfirmar !== false}
        local={faltantes?.local}
        confirmando={guardando}
        accion="registrar"
        onConfirmar={() => aceptar({ confirmarAltaStock: true })}
      />

      <PageHeader
        title="Pedidos mayoristas"
        subtitle="Lo que llega del portal y espera que alguien lo revise. Al aceptar se registra como venta."
        actions={
          <button className="btn-ghost" onClick={cargar} disabled={cargando}>
            <RefreshCw size={15} className={cargando ? "animate-spin" : ""} /> Actualizar
          </button>
        }
      />

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-brick-500 bg-brick-50 px-4 py-3 text-sm text-brick-700">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" /> <span>{error}</span>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {["pendiente", "aceptada", "rechazada", ""].map((e) => (
          <button
            key={e || "todos"}
            className={`btn-ghost text-sm ${estado === e ? "bg-paper-200 text-ink-950" : ""}`}
            onClick={() => { setEstado(e); setAbierta(null); }}
          >
            {e ? NOMBRE_ESTADO[e] : "todos"}
            {e === "pendiente" && pendientes > 0 && (
              <span className="ml-1 rounded-full bg-brass-500 px-1.5 text-xs font-semibold text-ink-950">{pendientes}</span>
            )}
          </button>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        <Card className="p-0">
          {cargando ? (
            <div className="flex items-center justify-center py-10 text-ink-500"><Loader2 className="animate-spin" /></div>
          ) : !lista.length ? (
            <EmptyState
              icon={PackageSearch}
              title="No hay pedidos acá"
              description={estado === "pendiente" ? "Cuando el portal mande uno, aparece solo." : "Probá con otro filtro."}
            />
          ) : (
            <ul className="divide-y divide-line">
              {lista.map((s) => (
                <li key={s.id}>
                  <button
                    className={`w-full px-4 py-3 text-left hover:bg-paper-100 ${abierta?.id === s.id ? "bg-paper-100" : ""}`}
                    onClick={() => abrir(s.id)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-sm text-ink-950">{s.pedidoExterno}</span>
                      <span className={`badge ${CHIP[s.estado] || "badge-low"}`}>{NOMBRE_ESTADO[s.estado] || s.estado}</span>
                    </div>
                    <p className="mt-0.5 truncate text-sm text-ink-700">{s.cliente?.nombre || s.comprador?.nombre || "Sin nombre"}</p>
                    <p className="text-xs text-ink-500">
                      {s.unidades} u · {formatCurrency(s.total)} · {formatDateTime(s.createdAt)}
                    </p>
                    {s.cambioPosterior && (
                      <p className="mt-1 text-xs text-brass-700">El portal lo cambió después de revisarlo.</p>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {!abierta ? (
          <Card>
            <EmptyState icon={Store} title="Elegí un pedido" description="Se muestra el detalle, qué falta identificar y con qué cliente matchea." />
          </Card>
        ) : (
          <div className="space-y-5">
            <Card>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="font-display text-base font-semibold text-ink-950">
                    Pedido {abierta.pedidoExterno}
                  </h3>
                  <p className="text-xs text-ink-500">
                    {abierta.origen} · {formatDateTime(abierta.createdAt)}
                    {abierta.estadoOrigen ? ` · en el portal está "${abierta.estadoOrigen}"` : ""}
                  </p>
                </div>
                <span className={`badge ${CHIP[abierta.estado]}`}>{NOMBRE_ESTADO[abierta.estado]}</span>
              </div>

              {aviso && (
                <div className="mb-3 rounded-md border border-teal-500 bg-teal-50 px-3 py-2 text-sm text-teal-700">
                  {aviso.texto}{" "}
                  {aviso.venta && (
                    <a className="inline-flex items-center gap-1 underline" href={`/ventas/${encodeURIComponent(aviso.venta)}`}>
                      ver la venta <ExternalLink size={12} />
                    </a>
                  )}
                </div>
              )}

              {abierta.cambioPosterior && (
                <div className="mb-3 rounded-md border border-brass-500 bg-brass-50 px-3 py-2 text-sm text-ink-900">
                  <strong>Ojo:</strong> el portal cambió este pedido después de que se revisó acá
                  {abierta.cambioPosterior.total ? ` (ahora dice ${formatCurrency(abierta.cambioPosterior.total)})` : ""}.
                  La venta registrada no se tocó: si el cambio vale, hay que resolverlo a mano.
                </div>
              )}

              {Boolean(abierta.sinIdentificar?.length) && (
                <div className="mb-3 rounded-md border border-brick-500 bg-brick-50 px-3 py-2 text-sm text-brick-700">
                  <p className="font-medium">Hay líneas que Stocker no reconoce y no se pueden vender:</p>
                  <ul className="mt-1 list-disc pl-5">
                    {abierta.sinIdentificar.map((i) => (
                      <li key={i.sku}><span className="font-mono">{i.sku}</span> {i.descripcion ? `· ${i.descripcion}` : ""}</li>
                    ))}
                  </ul>
                  <p className="mt-1">Corregí el catálogo del portal y que vuelva a mandar el pedido.</p>
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-ink-500">
                    <tr>
                      <th className="py-1">Artículo</th>
                      <th className="py-1 text-right">Cant.</th>
                      <th className="py-1 text-right">Precio del portal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {abierta.items.map((i) => (
                      <tr key={i.id} className="border-t border-line">
                        <td className="py-1.5">
                          <span className="font-mono text-xs text-ink-600">{i.sku}</span>
                          {i.descripcion && <span className="text-ink-900"> · {i.descripcion}</span>}
                          {!i.productVariantId && <span className="ml-1 badge badge-out">sin identificar</span>}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">{i.cantidad}</td>
                        <td className="py-1.5 text-right tabular-nums text-ink-600">
                          {i.precioOrigen === null ? "—" : formatCurrency(i.precioOrigen)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-sm">
                <span className="text-ink-600">
                  {abierta.unidades} unidades · el portal valorizó {formatCurrency(totalPortal || total)}
                </span>
                <span className="text-ink-500">
                  El precio de la venta lo pone Stocker, con su lista y la regla del local.
                </span>
              </div>

              {(abierta.cliente || abierta.envio) && (
                <div className="mt-3 grid gap-3 border-t border-line pt-3 text-sm sm:grid-cols-2">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-ink-500">Quién pidió</p>
                    <p className="text-ink-900">{abierta.cliente?.nombre || "—"}</p>
                    <p className="text-ink-600">{abierta.cliente?.cuit || abierta.comprador?.documento || ""}</p>
                    <p className="text-ink-600">{abierta.cliente?.telefono || ""}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide text-ink-500">A dónde va</p>
                    <p className="text-ink-900">{abierta.envio?.forma || "—"}</p>
                    <p className="text-ink-600">
                      {[abierta.envio?.direccion, abierta.envio?.localidad, abierta.envio?.provincia]
                        .filter(Boolean).join(", ")}
                    </p>
                  </div>
                </div>
              )}
            </Card>

            {abierta.estado === "pendiente" && puedeDecidir && (
              <Card>
                <h3 className="mb-3 font-display text-base font-semibold text-ink-950">Registrarlo como venta</h3>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1 block text-xs uppercase tracking-wide text-ink-600">De qué local sale</span>
                    <select className="input w-full" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                      <option value="">Elegí un local…</option>
                      {locales.map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
                    </select>
                  </label>

                  <label className="block">
                    <span className="mb-1 block text-xs uppercase tracking-wide text-ink-600">
                      Cliente {condicionPago === "cuenta_corriente" && <span className="text-brick-700">(obligatorio para fiar)</span>}
                    </span>
                    <select className="input w-full" value={clientId} onChange={(e) => setClientId(e.target.value)}>
                      <option value="">Sin cliente identificado</option>
                      {clientes.map((c) => (
                        <option key={c.id} value={c.id}>{c.nombre}{c.cuit ? ` · ${c.cuit}` : ""}</option>
                      ))}
                    </select>
                    {abierta.clienteSugerido && String(abierta.clienteSugerido.id) === clientId && (
                      <span className="mt-1 block text-xs text-teal-600">Matchea por CUIT con el que mandó el portal.</span>
                    )}
                    {!abierta.clienteSugerido && (abierta.cliente?.cuit || abierta.comprador?.documento) && (
                      <span className="mt-1 block text-xs text-ink-500">
                        Ningún cliente de Stocker tiene ese CUIT. Si vas a fiar, cargalo primero en Clientes.
                      </span>
                    )}
                  </label>
                </div>

                <div className="mt-4">
                  <span className="mb-1 block text-xs uppercase tracking-wide text-ink-600">
                    Cómo se cobra
                    {abierta.pagoCondicion && (
                      <span className="ml-1 normal-case text-ink-500">
                        · el portal anotó “{CONDICION_SUGERIDA[abierta.pagoCondicion] || abierta.pagoCondicion}”
                        {abierta.pagoForma ? ` (${abierta.pagoForma})` : ""}
                      </span>
                    )}
                  </span>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={`btn-ghost text-sm ${condicionPago === "contado" ? "bg-paper-200 text-ink-950" : ""}`}
                      onClick={() => setCondicionPago("contado")}
                    >
                      Cobrar ahora
                    </button>
                    <button
                      type="button"
                      className={`btn-ghost text-sm ${condicionPago === "cuenta_corriente" ? "bg-paper-200 text-ink-950" : ""}`}
                      onClick={() => setCondicionPago("cuenta_corriente")}
                    >
                      Dejar a cobrar (cuenta corriente)
                    </button>
                  </div>
                </div>

                {condicionPago === "contado" ? (
                  <div className="mt-3">
                    <PaymentSplit total={total} metodos={metodos} lineas={pagos} onChange={setPagos} />
                    <p className="mt-1 text-xs text-ink-500">
                      El importe definitivo lo calcula Stocker al registrar la venta: acá se elige con qué se paga.
                    </p>
                  </div>
                ) : (
                  <label className="mt-3 flex items-center gap-2 text-sm text-ink-800">
                    <input
                      type="checkbox"
                      checked={llevaMercaderia}
                      onChange={(e) => setLlevaMercaderia(e.target.checked)}
                    />
                    La mercadería sale ahora (si no, queda señada y el stock se descuenta al entregarla)
                  </label>
                )}

                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
                  <button className="btn-accent" disabled={!puedeAceptar || guardando} onClick={() => aceptar()}>
                    {guardando ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                    Aceptar y registrar la venta
                  </button>
                  {/*
                    * Por qué no se puede aceptar, al lado del botón.
                    *
                    * Un botón apagado sin explicación manda a buscar el
                    * problema a ciegas, y acá hay tres razones distintas.
                    */}
                  {!locationId && <span className="text-xs text-ink-500">Elegí de qué local sale.</span>}
                  {Boolean(abierta.sinIdentificar?.length) && (
                    <span className="text-xs text-brick-700">
                      Primero hay que identificar las líneas marcadas arriba.
                    </span>
                  )}
                  {condicionPago === "cuenta_corriente" && !clientId && (
                    <span className="text-xs text-brick-700">Para fiar hace falta elegir el cliente.</span>
                  )}
                </div>

                <div className="mt-4 border-t border-line pt-4">
                  <label className="block">
                    <span className="mb-1 block text-xs uppercase tracking-wide text-ink-600">
                      Rechazarlo (hace falta un motivo: del otro lado hay alguien esperando)
                    </span>
                    <textarea
                      className="input w-full"
                      rows={2}
                      value={motivo}
                      onChange={(e) => setMotivo(e.target.value)}
                      placeholder="No hay tela para esa curva hasta el mes que viene."
                    />
                  </label>
                  <button className="btn-ghost mt-2 text-brick-700" disabled={!motivo.trim() || guardando} onClick={rechazar}>
                    <X size={15} /> Rechazar el pedido
                  </button>
                </div>
              </Card>
            )}

            {abierta.estado === "aceptada" && (
              <Card>
                <p className="text-sm text-ink-800">
                  Este pedido ya se aceptó{abierta.revisadoEn ? ` el ${formatDateTime(abierta.revisadoEn)}` : ""}
                  {abierta.saleId ? " y quedó registrado como venta." : "."}
                </p>
              </Card>
            )}

            {abierta.estado === "rechazada" && (
              <Card>
                <p className="text-sm text-ink-800">
                  Rechazado{abierta.revisadoEn ? ` el ${formatDateTime(abierta.revisadoEn)}` : ""}: {abierta.motivoRechazo}
                </p>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
