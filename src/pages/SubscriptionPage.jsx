import { useEffect, useState } from "react";
import {
  CreditCard, Landmark, Download, Check, X, AlertTriangle, Loader2,
  RefreshCw, ArrowUpRight, Trash2, Users, Building2, Store, Tags, FileText,
  SearchCheck, Mail, Minus,
} from "lucide-react";
import {
  fetchSuscripcion, fetchPlanes, fetchFeatures, fetchPagos, crearCheckout,
  fetchDatosTransferencia, informarTransferencia, cambiarRenovacion,
  solicitarBaja, cancelarBaja, descargarRecibo, verificarPagos,
} from "../services/billingService";
import { PageHeader, Card } from "../components/ui/Layout";


import Modal from "../components/ui/Modal";
import { formatCurrency, formatDate } from "../utils/formatters";

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

  async function abrirPago(codigo) {
    setModalPago(codigo); setError("");
    if (!banco) fetchDatosTransferencia().then(setBanco).catch(() => {});
  }

  async function pagarConMercadoPago(modo) {
    setBusy("mp"); setError("");
    try {
      const r = await crearCheckout({ plan: modalPago, modo });
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
      const r = await informarTransferencia({});
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
  const planActual = planes.find((p) => p.codigo === sub.plan?.codigo);

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
            </div>
            <span className={`rounded-md border px-3 py-1 text-sm font-medium ${est.clase}`}>
              {est.texto}
            </span>
          </div>

          <div className="mt-5 grid gap-4 border-t border-line pt-4 sm:grid-cols-3">
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
              nota={sub.ultimoPagoEn ? `Último pago ${formatDate(sub.ultimoPagoEn)}` : "Todavía sin pagos"}
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
            <button className="btn-accent" onClick={() => abrirPago(sub.plan?.codigo)}>
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
            <Medidor icono={Users}     rotulo="Usuarios" dato={sub.uso?.empleados} />
            <Medidor icono={Store}     rotulo="Locales" dato={sub.uso?.locales} />
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
              </div>
              <p className="mt-2 font-display text-xl font-semibold text-ink-950">
                {p.precioMensual != null ? formatCurrency(p.precioMensual) : "A cotizar"}
                {p.precioMensual != null && <span className="text-xs font-normal text-ink-500"> /mes</span>}
              </p>
              <p className="mt-1 text-xs text-ink-600">{p.descripcion}</p>
              <ul className="mt-3 space-y-1 text-xs text-ink-700">
                <li>{tope(p.maxComprobantes)} comprobantes/mes</li>
                <li>{tope(p.maxSkus)} SKUs</li>
                <li>{tope(p.maxCuits)} CUIT{p.maxCuits === 1 ? "" : "s"}</li>
                <li>{tope(p.maxEmpleados)} usuario{p.maxEmpleados === 1 ? "" : "s"}</li>
                <li>{tope(p.maxLocales)} local{p.maxLocales === 1 ? "" : "es"}</li>
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
      <Modal open={Boolean(modalPago)} onClose={() => setModalPago(null)} title="Cómo querés pagar">
        <div className="space-y-4">
          {error && <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}

          {(() => {
            const p = planes.find((x) => x.codigo === modalPago) || planActual;
            const monto = p?.codigo === sub.plan?.codigo ? sub.precio : p?.precioMensual;
            return (
              <p className="text-sm text-ink-700">
                {p?.nombre} — <strong>{monto != null ? formatCurrency(monto) : "a cotizar"}</strong> por mes.
              </p>
            );
          })()}

          {/* Sin ninguna pasarela configurada el modal quedaba vacío, y eso se
              lee como que el sistema no cobra. Se dice qué falta y se ofrece el
              canal que sí funciona siempre. */}
          {!sub.mediosDisponibles?.mercadopago && !(banco?.cbu || banco?.alias) && (
            <div className="rounded-md border border-line bg-paper-50 p-3">
              <p className="text-sm text-ink-900">Todavía no hay pago automático activo.</p>
              <p className="mt-1 text-xs text-ink-600">
                Escribinos y coordinamos el pago por transferencia. Te activamos la cuenta
                en el momento en que se acredita.
              </p>
              <a
                className="btn-accent mt-3 w-full justify-center"
                href={`mailto:danteinsauviola@gmail.com?subject=${encodeURIComponent(`Pago de suscripción — ${sub.plan?.nombre || "Stocker"}`)}`}
              >
                <Mail size={15} /> Escribir para pagar
              </a>
            </div>
          )}

          {sub.mediosDisponibles?.mercadopago ? (
            <div className="space-y-2">
              <button
                className="btn-accent w-full justify-center"
                onClick={() => pagarConMercadoPago("recurrente")}
                disabled={busy === "mp"}
              >
                {busy === "mp" ? <Loader2 size={15} className="animate-spin" /> : <CreditCard size={15} />}
                Débito automático mensual
              </button>
              <button
                className="btn-ghost w-full justify-center"
                onClick={() => pagarConMercadoPago("unico")}
                disabled={busy === "mp"}
              >
                Pagar un mes con Mercado Pago
              </button>
            </div>
          ) : null}

          {(banco?.cbu || banco?.alias) && (
            <div className="rounded-md border border-line bg-paper-50 p-3">
              <p className="flex items-center gap-1.5 text-sm font-medium text-ink-900">
                <Landmark size={15} /> Transferencia bancaria
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
                disabled={busy === "transf"}
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

/** "Sin tope" es información, no un dato faltante: se dice con palabras. */
function tope(v) {
  return v == null ? "Sin tope de" : v.toLocaleString("es-AR");
}

/*
 * Uso contra el tope del plan. Sin tope no hay barra: no hay nada que llenar.
 *
 * Los comprobantes son un tope por mes, no acumulativo, y el medidor lo aclara
 * con la fecha de reinicio: ver "4.800 / 5000" sin saber que se reinicia el 1
 * suena a que la cuenta se está terminando para siempre.
 */
function Medidor({ icono: Icono, rotulo, dato }) {
  if (!dato) return null;
  const sinTope = dato.tope == null;
  const pct = sinTope ? 0 : Math.min(100, Math.round((dato.usado / Math.max(1, dato.tope)) * 100));
  const lleno = !sinTope && dato.usado >= dato.tope;
  // Amarillo desde el 80%: da margen para pasar de plan antes de quedarse
  // trabado en la mitad de una jornada de facturación.
  const cerca = !lleno && pct >= 80;

  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="flex items-center gap-1.5 text-ink-700"><Icono size={14} /> {rotulo}</span>
        <span className="tabular-nums text-ink-950">
          {dato.usado.toLocaleString("es-AR")}
          {sinTope ? "" : ` / ${dato.tope.toLocaleString("es-AR")}`}
        </span>
      </div>
      {sinTope ? (
        <p className="mt-1 text-xs text-ink-500">Sin límite</p>
      ) : (
        <>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-paper-200">
            <div
              className={`h-full rounded-full ${lleno ? "bg-brick-500" : cerca ? "bg-brass-400" : "bg-brass-500"}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          {dato.periodo === "mes" && (
            <p className="mt-1 text-[11px] text-ink-500">
              De este mes · vuelve a cero el {formatDate(dato.reinicia)}
            </p>
          )}
          {lleno && (
            <p className="mt-1 text-[11px] text-brick-500">
              Llegaste al tope del plan.
            </p>
          )}
        </>
      )}
    </div>
  );
}
