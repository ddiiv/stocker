import { useEffect, useState } from "react";
import {
  CreditCard, Landmark, Download, Check, AlertTriangle, Loader2,
  RefreshCw, ArrowUpRight, Trash2, Users, Building2, Store, Tags, FileText,
  SearchCheck, Mail, Minus, MonitorSmartphone,
} from "lucide-react";
import {
  fetchSuscripcion, fetchPlanes, fetchFeatures, fetchPagos, crearCheckout,
  fetchDatosTransferencia, informarTransferencia, cambiarRenovacion,
  solicitarBaja, cancelarBaja, descargarRecibo, verificarPagos, fetchCotizacion,
} from "../services/billingService";
import { PageHeader, Card } from "../components/ui/Layout";
import CuentaTabs from "../components/cuenta/CuentaTabs";
import Medidor from "../components/cuenta/Medidor";
import Modal from "../components/ui/Modal";
import { formatCurrency, formatDate } from "../utils/formatters";
import { proximoCobro } from "../utils/cuenta";

/*
 * Suscripción a Stocker.
 *
 * Una sola pantalla para todo lo que el dueño necesita saber y hacer con su
 * plan: qué está pagando, hasta cuándo, cómo, y los botones para renovar,
 * cambiar de plan, dejar de renovar o pedir la baja.
 *
 * El estado de la cuenta va arriba de todo y en color: si quedó en modo
 * lectura, eso es lo primero que tiene que ver, no un dato más en una lista.
 */

const ESTADO = {
  trial:     { texto: "Prueba gratis", clase: "bg-brass-50 text-brass-700 border-brass-500" },
  activa:    { texto: "Al día",        clase: "bg-teal-50 text-teal-700 border-teal-600" },
  morosa:    { texto: "Vencida",       clase: "bg-brick-50 text-brick-700 border-brick-500" },
  lectura:   { texto: "Sólo lectura",  clase: "bg-brick-50 text-brick-700 border-brick-500" },
  cancelada: { texto: "Cancelada",     clase: "bg-paper-200 text-ink-700 border-line" },
};

const ESTADO_PAGO = {
  aprobado:  "badge-ok",
  pendiente: "badge-low",
  rechazado: "badge-out",
};

export default function SubscriptionPage() {
  const [sub, setSub] = useState(null);
  const [planes, setPlanes] = useState([]);
  const [funciones, setFunciones] = useState([]);
  const [pagos, setPagos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");

  const [modalPago, setModalPago] = useState(null);   // código del plan a pagar
  const [cot, setCot] = useState(null);               // la cotización de ese plan
  const [cotError, setCotError] = useState("");
  const [conservar, setConservar] = useState([]);     // al bajar: los empleados que siguen
  const [modalBaja, setModalBaja] = useState(false);
  const [motivoBaja, setMotivoBaja] = useState("");
  const [banco, setBanco] = useState(null);

  async function load() {
    setLoading(true); setError("");
    try {
      const [s, p, f, h] = await Promise.all([
        fetchSuscripcion(), fetchPlanes(), fetchFeatures(), fetchPagos(),
      ]);
      setSub(s); setPlanes(p); setFunciones(f); setPagos(h);
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo cargar la suscripción.");
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  /*
   * El modal pide la cotización al servidor en vez de calcular el precio acá.
   * Antes mostraba el precio de lista del plan elegido aunque se cobrara con
   * descuento, y no podía saber cuánto era la diferencia de una subida.
   */
  async function abrirPago(codigo) {
    setModalPago(codigo); setError(""); setCot(null); setCotError("");
    if (!banco) fetchDatosTransferencia().then(setBanco).catch(() => {});
    try {
      const c = await fetchCotizacion(codigo);
      setCot(c);
      setConservar(c.empleados?.sugeridos || []);
    } catch (e) {
      setCotError(e.response?.data?.message || "No se pudo calcular cuánto hay que pagar.");
    }
  }

  // La elección viaja sólo si hacía falta elegir.
  const eleccion = () => (cot?.empleados ? conservar : undefined);
  const eleccionInvalida = Boolean(cot?.empleados?.tope != null && conservar.length > cot.empleados.tope);

  async function pagarConMercadoPago(modo) {
    setBusy("mp"); setError("");
    try {
      const r = await crearCheckout({ plan: modalPago, modo, conservar: eleccion() });
      // Se abre en una pestaña nueva para no perder la sesión de Stocker
      // mientras el cliente completa el pago en Mercado Pago.
      window.open(r.url, "_blank", "noopener");
      setModalPago(null);
      setAviso('Te abrimos Mercado Pago en otra pestaña. Cuando termines de pagar, volvé acá y tocá «Ya pagué».');
      await load();
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo generar el pago.");
    } finally { setBusy(""); }
  }

  /*
   * "Ya pagué": le pregunta a Mercado Pago en vez de esperar el aviso.
   *
   * El webhook puede no haber llegado —seguro no llega en desarrollo— y sin
   * esto la plata quedaría cobrada con la cuenta pidiendo pagar de nuevo.
   */
  async function confirmarPago() {
    setBusy("verificar"); setError("");
    try {
      const r = await verificarPagos();
      setAviso(r.message);
      await load();
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo verificar el pago.");
    } finally { setBusy(""); }
  }

  async function avisarTransferencia() {
    setBusy("transf"); setError("");
    try {
      // Con el plan elegido: si no, una transferencia del Superior desde
      // "Cambiar a este plan" quedaba anotada como un pago del plan actual.
      const r = await informarTransferencia({ plan: modalPago, conservar: eleccion() });
      setModalPago(null);
      setAviso(r.message);
      await load();
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo registrar el aviso.");
    } finally { setBusy(""); }
  }

  async function togglearRenovacion() {
    setBusy("renov"); setError("");
    try {
      const r = await cambiarRenovacion(!sub.renovacionAutomatica);
      setAviso(r.message);
      await load();
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo cambiar la renovación.");
    } finally { setBusy(""); }
  }

  async function pedirBaja() {
    setBusy("baja"); setError("");
    try {
      const r = await solicitarBaja(motivoBaja);
      setModalBaja(false); setMotivoBaja("");
      setAviso(r.message);
      await load();
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo enviar el pedido.");
    } finally { setBusy(""); }
  }

  async function revertirBaja() {
    setBusy("baja");
    try {
      const r = await cancelarBaja();
      setAviso(r.message);
      await load();
    } finally { setBusy(""); }
  }

  if (loading) return <div className="card h-64 animate-pulse bg-paper-200/60" />;
  if (!sub) return <p className="text-ink-600">{error || "No se pudo cargar la suscripción."}</p>;

  const est = ESTADO[sub.estado] || ESTADO.trial;

  return (
    <div>
      <PageHeader
        title="Suscripción"
        subtitle="Tu plan, tus pagos y los comprobantes"
        actions={
          <button className="btn-ghost" onClick={load} disabled={busy}>
            <RefreshCw size={15} /> Actualizar
          </button>
        }
      />
      <CuentaTabs />

      {error && <p className="mb-4 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}
      {aviso && (
        <p className="mb-4 flex items-start gap-2 rounded-md bg-paper-200 px-3 py-2 text-sm text-ink-700">
          <Check size={15} className="mt-0.5 shrink-0 text-teal-600" /> {aviso}
        </p>
      )}

      {/* Baja pedida: es lo más importante que puede estar pasando. */}
      {sub.bajaSolicitadaEn && (
        <Card className="mb-4 border-l-4 border-l-brick-500">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink-700">
              <strong>Pediste dar de baja la cuenta</strong> el {formatDate(sub.bajaSolicitadaEn)}.
              Todavía no borramos nada — te vamos a escribir para confirmarlo.
            </p>
            <button className="btn-ghost text-xs" onClick={revertirBaja} disabled={busy === "baja"}>
              Cancelar el pedido
            </button>
          </div>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        {/* ── Estado del plan ─────────────────────────────── */}
        <Card className="lg:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-wide text-ink-600">Plan actual</p>
              <p className="mt-1 font-display text-2xl font-semibold text-ink-950">
                {sub.plan?.nombre || "—"}
              </p>
              {sub.precio != null && (
                <p className="mt-1 text-sm text-ink-600">
                  {formatCurrency(sub.precio)} por mes
                  {sub.descuentoPct > 0 && (
                    <span className="ml-2 text-teal-600">
                      −{sub.descuentoPct}% aplicado
                      {sub.precioLista ? ` sobre ${formatCurrency(sub.precioLista)}` : ""}
                    </span>
                  )}
                </p>
              )}
              {sub.descuentoNota && <p className="mt-0.5 text-xs text-ink-500">{sub.descuentoNota}</p>}
              {/* Una bajada ya paga espera al fin del período del plan actual.
                  Sin este aviso el cliente paga el plan más barato, sigue
                  viendo el caro y no sabe si el cambio se hizo. */}
              {sub.planPendiente && (
                <p className="mt-2 text-sm text-ink-700">
                  Desde el <strong>{formatDate(sub.planPendiente.desde)}</strong> pasás
                  al <strong>{sub.planPendiente.nombre}</strong>. Ya está pago; hasta esa fecha
                  seguís con todo lo de tu plan actual.{" "}
                  {/* Arrepentirse de la bajada es pagar la diferencia de lo que
                      se había pagado como plan bajo: lo cotiza el servidor. */}
                  <button className="font-medium text-brass-700 underline" onClick={() => abrirPago(sub.plan?.codigo)}>
                    Seguir con el {sub.plan?.nombre}
                  </button>
                </p>
              )}
            </div>
            <span className={`rounded-md border px-3 py-1 text-sm font-medium ${est.clase}`}>
              {est.texto}
            </span>
          </div>

          <div className="mt-5 grid gap-4 border-t border-line pt-4 sm:grid-cols-3">
            {/* Qué cubre lo que se está usando: "vence el 30" solo no dice si
                es lo que se pagó la semana pasada o lo anterior. */}
            <Dato
              rotulo={sub.periodo?.tipo === "prueba" ? "Período de prueba" : "Período actual"}
              valor={sub.periodo
                ? `${formatDate(sub.periodo.desde)} al ${formatDate(sub.periodo.hasta)}`
                : "Sin período en curso"}
              nota={sub.periodo?.tipo === "pago" ? "Pagado" : null}
            />
            <Dato {...proximoCobro(sub)} />
            <Dato
              rotulo={sub.estado === "trial" ? "La prueba vence" : "Vence"}
              valor={sub.vence ? formatDate(sub.vence) : "Sin vencimiento"}
              nota={sub.diasRestantes != null
                ? sub.diasRestantes >= 0
                  ? `Quedan ${sub.diasRestantes} día${sub.diasRestantes === 1 ? "" : "s"}`
                  : "Vencido"
                : null}
              alerta={sub.diasRestantes != null && sub.diasRestantes <= 3}
            />
            <Dato
              rotulo="Renovación"
              valor={sub.renovacionAutomatica ? "Automática" : "Desactivada"}
              nota={sub.renovacionAutomatica ? "Se cobra sola cada mes" : "No se vuelve a cobrar"}
            />
            <Dato
              rotulo="Método de pago"
              valor={sub.metodoPago === "mercadopago" ? "Mercado Pago"
                   : sub.metodoPago === "transferencia" ? "Transferencia"
                   : sub.metodoPago === "manual" ? "Acordado" : "Sin definir"}
              nota={sub.debito?.activo && sub.debito.monto != null
                ? `Débito automático de ${formatCurrency(sub.debito.monto)} por mes`
                : sub.ultimoPagoEn ? `Último pago ${formatDate(sub.ultimoPagoEn)}` : "Todavía sin pagos"}
            />
          </div>

          {sub.soloLectura && (
            <p className="mt-4 flex items-start gap-2 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-700">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <span>
                La cuenta está en <strong>modo lectura</strong>: podés ver y exportar todo lo cargado,
                pero no vender ni facturar. Tus datos están intactos y vuelven a estar operativos
                apenas se acredite el pago.
              </span>
            </p>
          )}

          <div className="mt-5 flex flex-wrap gap-2">
            {/* Renovar es pagar el plan con el que se sigue: con una bajada
                esperando, pagar el actual la cancelaría sin quererlo. */}
            <button className="btn-accent" onClick={() => abrirPago(sub.planPendiente?.codigo || sub.plan?.codigo)}>
              <CreditCard size={15} />
              {sub.estado === "trial" ? "Activar suscripción" : "Pagar o renovar"}
            </button>
            {/* Sólo aparece si hay un cobro sin confirmar: un botón permanente
                invitaría a tocarlo sin haber pagado nada. */}
            {sub.pagoPendiente && sub.mediosDisponibles?.mercadopago && (
              <button className="btn-ghost" onClick={confirmarPago} disabled={busy === "verificar"}>
                {busy === "verificar"
                  ? <><Loader2 size={15} className="animate-spin" /> Buscando el pago…</>
                  : <><SearchCheck size={15} /> Ya pagué</>}
              </button>
            )}
            <button
              className="btn-ghost"
              onClick={togglearRenovacion}
              disabled={busy === "renov"}
            >
              {busy === "renov" ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              {sub.renovacionAutomatica ? "Cancelar suscripción" : "Reactivar renovación"}
            </button>
          </div>
          {sub.renovacionAutomatica && (
            <p className="mt-2 text-xs text-ink-500">
              Cancelar no corta el servicio en el acto: seguís hasta que termine el período que ya pagaste.
            </p>
          )}
        </Card>

        {/* ── Uso contra los topes ────────────────────────── */}
        <Card>
          <p className="mb-3 font-display text-sm font-semibold text-ink-950">Uso del plan</p>
          <div className="space-y-4">
            <Medidor icono={FileText}  rotulo="Comprobantes" dato={sub.uso?.comprobantes} />
            <Medidor icono={Tags}      rotulo="SKUs" dato={sub.uso?.skus} />
            <Medidor icono={Building2} rotulo="CUITs" dato={sub.uso?.cuits} />
            <Medidor icono={Users}     rotulo="Usuarios" dato={sub.uso?.empleados}
              nota={sub.uso?.empleados?.suspendidosPorPlan > 0
                ? `${sub.uso.empleados.suspendidosPorPlan} suspendido${sub.uso.empleados.suspendidosPorPlan === 1 ? "" : "s"} por el plan: vuelven solos si subís de plan.`
                : null} />
            <Medidor icono={Store}     rotulo="Locales" dato={sub.uso?.locales} />
            {/* El tope de sesiones no frena un alta como los demás: pasarlo
                cierra la del dueño con menos actividad, o todavía nada si el
                límite se está midiendo en modo sombra. */}
            {sub.uso?.sesiones?.modo !== "off" && (
              <Medidor icono={MonitorSmartphone} rotulo="Dispositivos del dueño" dato={sub.uso?.sesiones}
                avisarTope={false}
                nota={sub.uso?.sesiones?.tope == null ? null
                  : sub.uso.sesiones.modo === "activo"
                    ? "Abiertas ahora. Si entrás desde uno más, se cierra la de menos actividad."
                    : "Abiertas ahora. Por ahora no se cierra ninguna por pasarte."} />
            )}
          </div>
        </Card>
      </div>

      {/* ── Planes ─────────────────────────────────────────── */}
      <h2 className="mb-3 mt-8 font-display text-lg font-semibold text-ink-950">Planes disponibles</h2>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {planes.map((p) => {
          const esActual = p.codigo === sub.plan?.codigo;
          return (
            <Card key={p.codigo} className={esActual ? "border-brass-500" : ""}>
              <div className="flex items-start justify-between gap-2">
                <p className="font-display font-semibold text-ink-950">{p.nombre}</p>
                {esActual && <span className="badge badge-ok">Tu plan</span>}
                {p.codigo === sub.planPendiente?.codigo && (
                  <span className="badge badge-low">Desde el {formatDate(sub.planPendiente.desde)}</span>
                )}
              </div>
              <p className="mt-2 font-display text-xl font-semibold text-ink-950">
                {p.precioMensual != null ? formatCurrency(p.precioMensual) : "A cotizar"}
                {p.precioMensual != null && <span className="text-xs font-normal text-ink-500"> /mes</span>}
              </p>
              {/* El precio de lista es el de todos; el de esta cuenta lleva su descuento. */}
              {p.precioMensual != null && sub.descuentoPct > 0 && (
                <p className="text-xs text-teal-600">
                  Con tu {sub.descuentoPct}%: {formatCurrency(Math.round(p.precioMensual * (1 - sub.descuentoPct / 100)))}
                </p>
              )}
              <p className="mt-1 text-xs text-ink-600">{p.descripcion}</p>
              <ul className="mt-3 space-y-1 text-xs text-ink-700">
                <li>{tope(p.maxComprobantes)} comprobantes/mes</li>
                <li>{tope(p.maxSkus)} SKUs</li>
                <li>{tope(p.maxCuits)} CUIT{p.maxCuits === 1 ? "" : "s"}</li>
                <li>{tope(p.maxEmpleados)} usuario{p.maxEmpleados === 1 ? "" : "s"}</li>
                <li>{tope(p.maxLocales)} local{p.maxLocales === 1 ? "" : "es"}</li>
                <li>{tope(p.maxSesiones)} dispositivo{p.maxSesiones === 1 ? "" : "s"} a la vez para el dueño</li>
              </ul>

              {/*
                * Qué funciones entran, tildadas una por una.
                *
                * Antes de esto la tarjeta mostraba cinco topes y UNA sola
                * función —Mercado Libre— escrita a mano. Todo lo demás que
                * separa un plan de otro no estaba en ninguna pantalla: el
                * cliente no tenía forma de saber qué ganaba pagando el doble.
                *
                * La lista sale de FUNCIONES y no del objeto que manda el
                * servidor: hace falta poder mostrar también las que el plan NO
                * tiene, que es justamente lo que hace visible la diferencia.
                */}
              <ul className="mt-3 space-y-1 border-t border-line pt-3 text-xs">
                {funciones.map((f) => {
                  const incluida = Boolean(p.features?.[f.clave]);
                  return (
                    <li key={f.clave} className={`flex items-start gap-1.5 ${incluida ? "text-ink-700" : "text-ink-400"}`}>
                      {incluida
                        ? <Check size={13} className="mt-0.5 shrink-0 text-teal-600" />
                        : <Minus size={13} className="mt-0.5 shrink-0 text-ink-300" />}
                      <span className={incluida ? "" : "line-through decoration-ink-300"} title={f.ayuda}>{f.label}</span>
                    </li>
                  );
                })}
              </ul>

              <ul className="mt-3 space-y-1 text-xs text-ink-700">
                <li className="text-ink-500">{p.soporte}</li>
              </ul>
              {/* Con una bajada programada, el plan actual también se puede
                  elegir: es arrepentirse de la bajada. */}
              {esActual && sub.planPendiente && (
                <button className="btn-ghost mt-4 w-full justify-center text-xs" onClick={() => abrirPago(p.codigo)}>
                  Seguir con este plan
                </button>
              )}
              {!esActual && (
                <button
                  className="btn-ghost mt-4 w-full justify-center text-xs"
                  onClick={() => (p.requiereCotizacion
                    ? window.open("mailto:danteinsauviola@gmail.com?subject=Cotización Plan Enterprise", "_blank")
                    : abrirPago(p.codigo))}
                >
                  {p.requiereCotizacion ? "Pedir cotización" : <>Cambiar a este plan <ArrowUpRight size={13} /></>}
                </button>
              )}
            </Card>
          );
        })}
      </div>

      {/* ── Historial ──────────────────────────────────────── */}
      <h2 className="mb-3 mt-8 font-display text-lg font-semibold text-ink-950">Pagos y comprobantes</h2>
      <Card className="p-0">
        {pagos.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-ink-600">
            Todavía no hay pagos registrados. Cuando actives la suscripción, acá vas a poder
            descargar cada comprobante.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-line bg-paper-100 text-left text-xs uppercase tracking-wide text-ink-600">
                  <th className="px-4 py-2 font-medium">Fecha</th>
                  <th className="px-4 py-2 font-medium">Concepto</th>
                  <th className="px-4 py-2 font-medium">Medio</th>
                  <th className="px-4 py-2 font-medium">Importe</th>
                  <th className="px-4 py-2 font-medium">Estado</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {pagos.map((p) => (
                  <tr key={p.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-3 text-ink-700">{formatDate(p.fecha)}</td>
                    <td className="px-4 py-3">
                      <p className="text-ink-900">{p.detalle || "Suscripción a Stocker"}</p>
                      {p.plan?.nombre && <p className="text-xs text-ink-500">{p.plan.nombre}</p>}
                      {p.periodoDesde && p.periodoHasta && (
                        <p className="text-xs text-ink-500">
                          {formatDate(p.periodoDesde)} → {formatDate(p.periodoHasta)}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-ink-700">
                      {p.metodo === "mercadopago" ? "Mercado Pago"
                       : p.metodo === "transferencia" ? "Transferencia" : "Manual"}
                    </td>
                    <td className="px-4 py-3 font-medium tabular-nums text-ink-950">{formatCurrency(p.monto)}</td>
                    <td className="px-4 py-3">
                      <span className={`badge ${ESTADO_PAGO[p.estado] || "badge-low"}`}>{p.estado}</span>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {p.estado === "aprobado" ? (
                        <button className="btn-ghost text-xs" onClick={() => descargarRecibo(p)}>
                          <Download size={13} /> Recibo
                        </button>
                      ) : p.linkPago ? (
                        <a className="btn-ghost text-xs" href={p.linkPago} target="_blank" rel="noopener noreferrer">
                          Pagar
                        </a>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── Baja de cuenta ─────────────────────────────────── */}
      {!sub.bajaSolicitadaEn && (
        <Card className="mt-8 border-l-4 border-l-line">
          <p className="font-display text-sm font-semibold text-ink-950">Dar de baja la cuenta</p>
          <p className="mt-1 max-w-2xl text-sm text-ink-600">
            Distinto de cancelar la suscripción. Esto pide eliminar la cuenta y todos sus datos.
            No se borra nada en el momento: nos llega el pedido y te escribimos para confirmarlo,
            así tenés tiempo de exportar lo que necesites.
          </p>
          <button className="btn-ghost mt-3 text-xs text-brick-500" onClick={() => setModalBaja(true)}>
            <Trash2 size={13} /> Solicitar baja de cuenta
          </button>
        </Card>
      )}

      {/* ── Modal de pago ──────────────────────────────────── */}
      <Modal open={Boolean(modalPago)} onClose={() => setModalPago(null)} title="Cómo querés pagar" width="max-w-2xl">
        <div className="space-y-4">
          {error && <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}
          {cotError && <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{cotError}</p>}
          {!cot && !cotError && (
            <p className="flex items-center gap-2 text-sm text-ink-600">
              <Loader2 size={15} className="animate-spin" /> Calculando cuánto hay que pagar…
            </p>
          )}

          {cot && (
            <>
              <ResumenCotizacion cot={cot} />

              {/* Decisión 20: el débito automático sigue al plan nuevo solo. */}
              {cot.debito?.activo && (
                <p className="rounded-md bg-paper-200 px-3 py-2 text-xs text-ink-700">
                  {cot.debito.montoActual != null && Math.round(cot.debito.montoActual) !== Math.round(cot.debito.montoNuevo)
                    ? <>Tu débito automático de Mercado Pago pasa de <strong>{formatCurrency(cot.debito.montoActual)}</strong> a{" "}
                        <strong>{formatCurrency(cot.debito.montoNuevo)}</strong> por mes desde el próximo débito.</>
                    : <>Tu débito automático de Mercado Pago queda en <strong>{formatCurrency(cot.debito.montoNuevo)}</strong> por mes.</>}
                  {cot.concepto === "periodo" && " Ya lo tenés: no hace falta dar de alta otro."}
                </p>
              )}

              {/* Decisión 19: antes de pagar una bajada, cuánto se pasa de cada tope. */}
              {cot.excesos?.length > 0 && (
                <div className="rounded-md border border-brass-500 bg-brass-50 p-3">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-ink-900">
                    <AlertTriangle size={15} /> Con el {cot.plan.nombre} te pasás de estos topes
                  </p>
                  <ul className="mt-2 space-y-1.5 text-xs text-ink-700">
                    {cot.excesos.map((x) => (
                      <li key={x.recurso}>{textoExceso(x, cot.plan.nombre, sub.uso?.sesiones?.modo)}</li>
                    ))}
                  </ul>
                </div>
              )}

              {cot.empleados && (
                <div className="rounded-md border border-line p-3">
                  <p className="text-sm font-medium text-ink-900">
                    ¿Quiénes siguen usando Stocker?{" "}
                    <span className={`font-normal ${eleccionInvalida ? "text-brick-500" : "text-ink-500"}`}>
                      ({conservar.length} de {cot.empleados.tope})
                    </span>
                  </p>
                  <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-sm">
                    {cot.empleados.lista.map((e) => {
                      const elegido = conservar.includes(e.id);
                      return (
                        <li key={e.id}>
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={elegido}
                              disabled={!elegido && conservar.length >= cot.empleados.tope}
                              onChange={() => setConservar(elegido
                                ? conservar.filter((id) => id !== e.id)
                                : [...conservar, e.id])}
                            />
                            <span className="text-ink-900">{e.nombre} {e.apellido}</span>
                            <span className="text-xs text-ink-500">
                              {e.ultimaConexion ? `entró el ${formatDate(e.ultimaConexion)}` : "nunca entró"}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="mt-2 text-xs text-ink-600">
                    Los que no elijas quedan suspendidos{" "}
                    {cot.tipo === "bajada" ? `desde el ${formatDate(cot.rige)}` : "apenas se acredite el pago"}:
                    no pueden entrar ni operar, pero no se borra nada. Si volvés a subir de plan, vuelven solos.
                  </p>
                </div>
              )}
            </>
          )}

          {/* Sin ninguna pasarela configurada el modal quedaba vacío, y eso se
              lee como que el sistema no cobra. Se dice qué falta y se ofrece el
              canal que sí funciona siempre. */}
          {cot && !cot.medios?.mercadopago && !cot.medios?.transferencia && (
            <div className="rounded-md border border-line bg-paper-50 p-3">
              <p className="text-sm text-ink-900">Todavía no hay pago automático activo.</p>
              <p className="mt-1 text-xs text-ink-600">
                Escribinos y coordinamos el pago por transferencia. Te activamos la cuenta
                en el momento en que se acredita.
              </p>
              <a
                className="btn-accent mt-3 w-full justify-center"
                href={`mailto:danteinsauviola@gmail.com?subject=${encodeURIComponent(`Pago de suscripción — ${cot.plan?.nombre || "Stocker"}`)}`}
              >
                <Mail size={15} /> Escribir para pagar
              </a>
            </div>
          )}

          {cot?.medios?.mercadopago && (
            <div className="space-y-2">
              {cot.medios.debitoAutomatico && (
                <button
                  className="btn-accent w-full justify-center"
                  onClick={() => pagarConMercadoPago("recurrente")}
                  disabled={busy === "mp" || eleccionInvalida}
                >
                  {busy === "mp" ? <Loader2 size={15} className="animate-spin" /> : <CreditCard size={15} />}
                  Débito automático mensual
                </button>
              )}
              <button
                className={`${cot.medios.debitoAutomatico ? "btn-ghost" : "btn-accent"} w-full justify-center`}
                onClick={() => pagarConMercadoPago("unico")}
                disabled={busy === "mp" || eleccionInvalida}
              >
                {busy === "mp" && !cot.medios.debitoAutomatico
                  ? <Loader2 size={15} className="animate-spin" />
                  : <CreditCard size={15} />}
                Pagar {formatCurrency(cot.monto)} con Mercado Pago
              </button>
              {cot.concepto === "diferencia" && (
                <p className="text-[11px] text-ink-500">
                  El link vale por hoy: la diferencia se calcula con los días que quedan.
                </p>
              )}
            </div>
          )}

          {cot?.medios?.transferencia && (banco?.cbu || banco?.alias) && (
            <div className="rounded-md border border-line bg-paper-50 p-3">
              <p className="flex items-center gap-1.5 text-sm font-medium text-ink-900">
                <Landmark size={15} /> Transferencia bancaria
              </p>
              {/* El importe lo pone Stocker: es lo que se compara al acreditarla. */}
              <p className="mt-1 text-sm text-ink-700">
                Transferí exactamente <strong>{formatCurrency(cot.monto)}</strong>.
              </p>
              <dl className="mt-2 space-y-1 font-mono text-xs text-ink-700">
                {banco.titular && <DatoBanco k="Titular" v={banco.titular} />}
                {banco.cuit    && <DatoBanco k="CUIT" v={banco.cuit} />}
                {banco.cbu     && <DatoBanco k="CBU" v={banco.cbu} />}
                {banco.alias   && <DatoBanco k="Alias" v={banco.alias} />}
              </dl>
              <button
                className="btn-ghost mt-3 w-full justify-center text-xs"
                onClick={avisarTransferencia}
                disabled={busy === "transf" || eleccionInvalida}
              >
                {busy === "transf" ? "Enviando…" : "Ya transferí, avisar"}
              </button>
              <p className="mt-1 text-[11px] text-ink-500">
                La verificamos contra el banco y activamos la cuenta. Suele tardar unas horas.
              </p>
            </div>
          )}

          <div className="flex justify-end">
            <button className="btn-ghost" onClick={() => setModalPago(null)}>Cerrar</button>
          </div>
        </div>
      </Modal>

      {/* ── Modal de baja ──────────────────────────────────── */}
      <Modal open={modalBaja} onClose={() => setModalBaja(false)} title="Solicitar baja de cuenta">
        <div className="space-y-4">
          <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-700">
            Vas a pedir la eliminación de la cuenta y de todo lo que tiene cargado: productos,
            ventas, facturas y clientes. No se borra ahora — recibimos el pedido y te escribimos
            para confirmarlo.
          </p>
          <div>
            <label className="label">¿Por qué te vas? <span className="font-normal text-ink-500">(opcional)</span></label>
            <textarea
              className="input min-h-20"
              value={motivoBaja}
              onChange={(e) => setMotivoBaja(e.target.value)}
              placeholder="Nos sirve para mejorar."
            />
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => setModalBaja(false)}>Mejor no</button>
            <button className="btn-accent !bg-brick-500" onClick={pedirBaja} disabled={busy === "baja"}>
              {busy === "baja" ? "Enviando…" : "Enviar solicitud"}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function Dato({ rotulo, valor, nota, alerta }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-ink-600">{rotulo}</p>
      <p className="mt-0.5 font-medium text-ink-950">{valor}</p>
      {nota && <p className={`text-xs ${alerta ? "text-brick-500" : "text-ink-500"}`}>{nota}</p>}
    </div>
  );
}

function DatoBanco({ k, v }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-500">{k}</dt>
      <dd className="text-ink-900">{v}</dd>
    </div>
  );
}

const conCentavos = (v) => new Intl.NumberFormat("es-AR", {
  style: "currency", currency: "ARS", minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format(v || 0);

/*
 * Qué se paga y qué pasa, dicho ANTES de pagar. Sale entero de la cotización
 * del servidor (la misma cuenta que cobra el checkout): fechas, importes y el
 * detalle del prorrateo. La pantalla no calcula precios.
 */
function ResumenCotizacion({ cot }) {
  const p = cot.plan.nombre;
  const actual = cot.planActual?.nombre;
  const precio = <strong>{formatCurrency(cot.monto)}</strong>;

  if (cot.tipo === "subida" || cot.tipo === "seguir") {
    return (
      <div className="space-y-2 text-sm text-ink-700">
        {cot.tipo === "subida" ? (
          <p>
            Pasás al <strong>{p}</strong> apenas se acredite el pago, con sus topes y funciones. Como
            ya tenés pago hasta el <strong>{formatDate(cot.venceDespues)}</strong>, ahora pagás sólo la
            diferencia por los días que quedan: {precio}. El vencimiento no cambia.
            {/* Subir con una bajada programada la cancela (el servidor cobra
                los días del plan bajo a su precio): tiene que decirse antes. */}
            {cot.planPendiente && <> Se cancela el paso al {cot.planPendiente.nombre} que tenías programado.</>}
          </p>
        ) : (
          <p>
            Cancelás el paso al <strong>{cot.planPendiente?.nombre}</strong> y seguís con el{" "}
            <strong>{p}</strong>. Pagás la diferencia de los días que ya habías pagado
            como {cot.planPendiente?.nombre}: {precio}. El vencimiento no cambia.
          </p>
        )}
        <TablaTramos cot={cot} />
        <p className="text-xs text-ink-600">
          Desde el {formatDate(cot.venceDespues)}, el {p} sale {formatCurrency(cot.precioMensual)} por mes
          {cot.descuentoPct > 0 ? ` (con tu ${cot.descuentoPct}% de descuento)` : ""}.
        </p>
      </div>
    );
  }
  if (cot.tipo === "bajada") {
    return (
      <p className="text-sm text-ink-700">
        Seguís con el <strong>{actual}</strong> hasta el <strong>{formatDate(cot.rige)}</strong>, que ya
        está pago, y desde ahí pasás al <strong>{p}</strong>. Ahora pagás el primer mes del {p}:{" "}
        {precio}, y quedás pago hasta el {formatDate(cot.venceDespues)}.
      </p>
    );
  }
  if (cot.tipo === "renovacion") {
    return (
      <div className="space-y-1 text-sm text-ink-700">
        <p>
          {p}: {precio} por 30 días más. Quedás pago hasta el <strong>{formatDate(cot.venceDespues)}</strong>.
        </p>
        {cot.planPendiente?.codigo === cot.plan.codigo && (
          <p className="text-xs text-ink-600">
            Sigue en pie el paso al {p} desde el {formatDate(cot.planPendiente.desde)}.
          </p>
        )}
      </div>
    );
  }
  // alta: sin período pago en curso, rige apenas se acredita.
  return (
    <p className="text-sm text-ink-700">
      {cot.plan.codigo === cot.planActual?.codigo
        ? <>Activás el <strong>{p}</strong>: {precio} por 30 días, hasta el {formatDate(cot.venceDespues)}.</>
        : <>Pasás al <strong>{p}</strong> apenas se acredite el pago: {precio} por 30 días, hasta
            el {formatDate(cot.venceDespues)}.</>}
    </p>
  );
}

/*
 * El detalle del prorrateo, tramo por tramo. Con una bajada programada hay dos:
 * los días que se pagaron con el plan actual y los que se pagaron con el plan
 * bajo valen distinto.
 */
function TablaTramos({ cot }) {
  const tramos = cot.detalle?.tramos || [];
  if (!tramos.length) return null;
  return (
    <div className="overflow-x-auto rounded-md border border-line">
      <table className="w-full min-w-[420px] text-xs">
        <thead>
          <tr className="bg-paper-100 text-left text-ink-600">
            <th className="px-2 py-1.5 font-medium">Días</th>
            <th className="px-2 py-1.5 font-medium">Ya pagados como</th>
            <th className="px-2 py-1.5 text-right font-medium">Diferencia por mes</th>
            <th className="px-2 py-1.5 text-right font-medium">Importe</th>
          </tr>
        </thead>
        <tbody>
          {tramos.map((t) => (
            <tr key={`${t.plan.codigo}-${t.desde}`} className="border-t border-line">
              <td className="px-2 py-1.5 text-ink-900">
                {t.dias} <span className="text-ink-500">({formatDate(t.desde)} → {formatDate(t.hasta)})</span>
              </td>
              <td className="px-2 py-1.5 text-ink-700">{t.plan.nombre} ({formatCurrency(t.precioMensual)}/mes)</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(Math.max(0, cot.precioMensual - t.precioMensual))}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{conCentavos(t.importe)}</td>
            </tr>
          ))}
          <tr className="border-t border-line font-medium">
            <td className="px-2 py-1.5" colSpan={3}>Total, redondeado al peso</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(cot.monto)}</td>
          </tr>
        </tbody>
      </table>
      <p className="border-t border-line px-2 py-1.5 text-[11px] text-ink-500">
        Cada tramo: diferencia por mes × días / {cot.detalle.diasPeriodo}. El día empezado cuenta entero.
      </p>
    </div>
  );
}

/** Cuánto se pasa de un tope y qué pasa con eso, en palabras. */
function textoExceso(x, plan, modoSesiones) {
  const base = `tenés ${x.usado.toLocaleString("es-AR")} y el ${plan} incluye ${x.tope.toLocaleString("es-AR")}`;
  switch (x.recurso) {
    case "empleados":
      return `Usuarios: ${base}. Elegí abajo quiénes siguen; los demás quedan guardados pero no pueden entrar.`;
    case "locales":
      return `Locales: ${base}. Quedan todos como están, pero no vas a poder crear otro.`;
    case "cuits":
      return `CUIT: ${base}. Quedan como están, pero no vas a poder agregar otro.`;
    case "skus":
      return `SKUs: ${base}. No se borra ninguno, pero no vas a poder cargar más.`;
    case "comprobantes":
      return `Comprobantes: este mes llevás ${x.usado.toLocaleString("es-AR")} y el ${plan} permite ${x.tope.toLocaleString("es-AR")} por mes. Pasado el tope no se puede facturar hasta el 1 del mes siguiente.`;
    case "sesiones":
      return `Dispositivos del dueño: ${base} a la vez. ${modoSesiones === "activo"
        ? "Al entrar desde uno más, se cierra el de menos actividad."
        : "Por ahora no se cierra ninguno por pasarte."}`;
    default:
      return `${x.recurso}: ${base}.`;
  }
}

/** "Sin tope" es información, no un dato faltante: se dice con palabras. */
function tope(v) {
  return v == null ? "Sin tope de" : v.toLocaleString("es-AR");
}
