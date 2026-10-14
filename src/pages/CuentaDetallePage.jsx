import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, RefreshCw, Check, X, PencilLine, AlertTriangle, CalendarPlus } from "lucide-react";
import * as api from "../lib/api";
import { mensajeDe } from "../lib/http";
import { plata, fecha, fechaHora, numero, tope } from "../lib/formato";
import { useAdmin, puede } from "../context/AdminAuth";
import { Card, PageHead, Aviso, Cargando, Vacio, Tabla, Estado, Modal, Campo } from "../components/ui";

/*
 * Ficha de una cuenta.
 *
 * Es la pantalla donde se toman las decisiones comerciales: cambiar de plan,
 * dar un descuento, cerrar un precio, extender días sin cobrar y acreditar una
 * transferencia. Todo lo que mueve plata pide rol de responsable comercial —
 * el backend lo vuelve a validar, esto sólo evita ofrecer botones que van a
 * fallar.
 */
export default function CuentaDetallePage() {
  const { id } = useParams();
  const { admin } = useAdmin();
  const comercial = puede(admin, "owner");

  const [datos, setDatos] = useState(null);
  const [planes, setPlanes] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [ocupado, setOcupado] = useState("");
  const [modal, setModal] = useState(false);
  const [acreditando, setAcreditando] = useState(null);   // el pago que se está acreditando

  async function cargar() {
    setCargando(true); setError("");
    try {
      const [d, p] = await Promise.all([api.getCuenta(id), api.getPlanes()]);
      setDatos(d); setPlanes(p);
    } catch (e) {
      setError(mensajeDe(e, "No se pudo cargar la cuenta."));
    } finally { setCargando(false); }
  }
  useEffect(() => { cargar(); /* eslint-disable-next-line */ }, [id]);

  /*
   * Acreditar pasa por el modal: quien acredita escribe lo que vio en el banco
   * y el backend lo compara con lo que corresponde. Si no coincide contesta
   * 409 con los dos números, y el modal ofrece acreditarlo igual.
   */
  function alAcreditar(r) {
    setAcreditando(null);
    // Qué pasó con el plan: acreditar un pago de otro plan lo cambia, y
    // quien acredita tiene que verlo en el momento.
    const cambio = r.plan?.cambio === "sube"
      ? ` Pasó al ${r.plan.vigente?.nombre} desde ahora; el vencimiento no se movió.`
      : r.plan?.cambio === "sigue"
        ? ` Se canceló la bajada: sigue en el ${r.plan.vigente?.nombre}.`
        : r.plan?.cambio === "baja" && r.plan.pendiente
          ? ` Pasa al ${r.plan.pendiente.nombre} el ${fecha(r.plan.pendiente.desde)}, al terminar lo que ya pagó.`
          : r.plan?.cambio === "baja"
            ? ` Pasó al ${r.plan.vigente?.nombre} desde ahora (no tenía un período pago en curso).`
            : "";
    setOk(`Pago acreditado. La cuenta queda paga hasta el ${fecha(r.periodo.hasta)}.${cambio}` +
      (r.revisar ? ` Queda anotado: ${r.revisar}` : ""));
    cargar();
  }

  async function accionPago(pagoId, accion) {
    setOcupado(`pago-${pagoId}`); setError(""); setOk("");
    try {
      if (accion === "aprobar") {
        setAcreditando(pagos.find((p) => p.id === pagoId) || null);
        return;
      } else {
        await api.rechazarPago(pagoId, "Rechazado desde el backoffice");
        setOk("Pago marcado como rechazado.");
      }
      await cargar();
    } catch (e) {
      setError(mensajeDe(e, "No se pudo procesar el pago."));
    } finally { setOcupado(""); }
  }

  const pagos = datos?.pagos || [];

  if (cargando) return <Cargando />;
  if (!datos) return <Aviso tono="error">{error || "Cuenta no encontrada."}</Aviso>;

  const { negocio, suscripcion: s, uso, actividad } = datos;

  return (
    <div>
      <Link to="/cuentas" className="mb-4 inline-flex items-center gap-1.5 text-sm text-dim hover:text-text">
        <ArrowLeft size={14} /> Cuentas
      </Link>

      <PageHead
        titulo={negocio.nombreNegocio}
        bajada={`${negocio.ownerNombre} ${negocio.ownerApellido || ""} · ${negocio.email} · CUIT ${negocio.cuit}`}
        acciones={
          <>
            <Estado valor={s.estado} />
            <button className="btn-ghost btn-sm" onClick={cargar}>
              <RefreshCw size={13} /> Actualizar
            </button>
            {comercial && (
              <button className="btn-primary btn-sm" onClick={() => setModal(true)}>
                <PencilLine size={13} /> Editar suscripción
              </button>
            )}
          </>
        }
      />

      <Aviso tono="error" onCerrar={() => setError("")}>{error}</Aviso>
      <Aviso tono="ok" onCerrar={() => setOk("")}>{ok}</Aviso>

      {s.bajaSolicitadaEn && (
        <Card className="mb-5 stripe-crit p-4">
          <p className="flex items-center gap-2 text-sm font-medium text-crit">
            <AlertTriangle size={15} /> Pidió dar de baja la cuenta el {fecha(s.bajaSolicitadaEn)}
          </p>
          {s.bajaMotivo && <p className="mt-1.5 text-sm text-dim">«{s.bajaMotivo}»</p>}
          <p className="mt-2 text-xs text-faint">
            Nada se borró. El borrado se hace a mano después de confirmarlo con el titular.
          </p>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ── Suscripción ─────────────────────────────────── */}
        <Card className="p-4 lg:col-span-2">
          <p className="eyebrow mb-3">Suscripción</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <Dato rotulo="Plan" valor={s.planNombre || "—"} />
            <Dato
              rotulo="Precio mensual"
              valor={plata(s.precio)}
              nota={s.descuentoPct > 0 ? `−${s.descuentoPct}% sobre ${plata(s.precioLista)}` : null}
              notaTono="ok"
            />
            <Dato rotulo="Vence" valor={fecha(s.vence)} nota={
              s.diasRestantes != null ? `${s.diasRestantes} días` : null
            } />
            <Dato rotulo="Renovación" valor={s.renovacionAutomatica ? "Automática" : "Desactivada"} />
            <Dato rotulo="Método de pago" valor={
              s.metodoPago === "mercadopago" ? "Mercado Pago"
              : s.metodoPago === "transferencia" ? "Transferencia"
              : s.metodoPago === "manual" ? "Acordado" : "Sin definir"
            } />
            <Dato rotulo="Precio cerrado" valor={s.precioAcordado != null ? plata(s.precioAcordado) : "De lista"} />
            {/* Una bajada ya paga por el cliente, que rige al terminar el
                período. Poner un plan a mano desde "Editar" la cancela. */}
            {s.planPendiente && (
              <Dato rotulo="Cambio programado" valor={s.planPendienteNombre} nota={`desde el ${fecha(s.planPendienteDesde)}`} />
            )}
            {/* El débito automático tiene que cobrar el precio del plan con el
                que la cuenta sigue: si Mercado Pago no aceptó el monto nuevo,
                se reintenta solo, pero acá tiene que verse. */}
            {s.debito?.activo && (
              <Dato
                rotulo="Débito automático"
                valor={s.debito.monto != null ? `${plata(s.debito.monto)} /mes` : "Monto sin confirmar"}
                nota={s.debito.pendienteDesde
                  ? `Mercado Pago no aceptó el monto nuevo desde el ${fecha(s.debito.pendienteDesde)}: se reintenta solo`
                  : "Sigue al plan con el que sigue la cuenta"}
                notaTono={s.debito.pendienteDesde ? "crit" : undefined}
              />
            )}
          </div>
          {s.descuentoNota && (
            <p className="mt-3 border-t border-line pt-3 text-xs text-dim">{s.descuentoNota}</p>
          )}
          {s.notas && (
            <p className="mt-2 text-xs text-faint">Nota interna: {s.notas}</p>
          )}
        </Card>

        {/* ── Uso ─────────────────────────────────────────── */}
        <Card className="p-4">
          <p className="eyebrow mb-3">Uso contra los topes</p>
          <div className="space-y-3">
            <Medida rotulo="Comprobantes (mes)" dato={uso.comprobantes} />
            <Medida rotulo="SKUs" dato={uso.skus} />
            <Medida rotulo="CUITs" dato={uso.cuits} />
            <Medida rotulo="Usuarios" dato={uso.empleados} />
            {uso.empleados?.suspendidosPorPlan > 0 && (
              <p className="-mt-2 text-xs text-warn">
                {uso.empleados.suspendidosPorPlan} suspendido{uso.empleados.suspendidosPorPlan === 1 ? "" : "s"} por el plan
              </p>
            )}
            <Medida rotulo="Locales" dato={uso.locales} />
          </div>
          <div className="mt-4 border-t border-line pt-3 text-xs text-dim">
            <p>{numero(actividad.ventas)} ventas registradas</p>
            <p className="text-faint">Alta: {fecha(negocio.createdAt)}</p>
          </div>
        </Card>
      </div>

      {/* ── Cobros ─────────────────────────────────────────── */}
      <h2 className="mb-3 mt-8 text-lg font-semibold">Cobros</h2>
      <Card className="p-0">
        {pagos.length === 0 ? (
          <Vacio>Esta cuenta todavía no registró ningún pago.</Vacio>
        ) : (
          <Tabla cabeceras={[
            "Fecha", "Concepto", "Medio",
            { texto: "Importe", align: "right" }, "Estado", "",
          ]}>
            {pagos.map((p) => (
              <tr key={p.id} className={`border-b border-line2 last:border-0 ${
                p.estado === "pendiente" && p.metodo === "transferencia" ? "stripe-warn" : ""
              }`}>
                <td className="td text-dim">{fechaHora(p.fecha)}</td>
                <td className="td">
                  <p className="text-text">{p.detalle || "Suscripción"}</p>
                  {/* El plan del pago es el que se aplica al acreditarlo. */}
                  {p.plan?.nombre && (
                    <p className="text-xs text-dim">
                      {p.plan.nombre}
                      {p.estado === "pendiente" && p.plan.codigo !== s.plan && s.planOrden != null && (
                        <span className="text-warn">
                          {p.plan.orden > s.planOrden ? " · sube de plan al acreditar" : " · baja de plan al terminar el período"}
                        </span>
                      )}
                    </p>
                  )}
                  {p.periodoDesde && (
                    <p className="text-xs text-faint">{fecha(p.periodoDesde)} → {fecha(p.periodoHasta)}</p>
                  )}
                  {p.verificadoPor && (
                    <p className="text-xs text-faint">Verificó {p.verificadoPor}</p>
                  )}
                  {/* Un cobro que no correspondía a lo cotizado: se acreditó
                      por lo que vale y alguien tiene que mirarlo. */}
                  {p.aRevisar && <p className="text-xs text-crit">Revisar: {p.aRevisar}</p>}
                </td>
                <td className="td text-dim">
                  {p.metodo === "mercadopago" ? "Mercado Pago"
                   : p.metodo === "transferencia" ? "Transferencia" : "Manual"}
                </td>
                <td className="td text-right tabular">
                  {plata(p.monto)}
                  {/* Lo que corresponde HOY a ese plan, al lado de lo informado:
                      rojo si no alcanza. Así la diferencia se ve antes de acreditar. */}
                  {p.estado === "pendiente" && p.corresponde && (
                    <p className={`text-xs ${
                      p.corresponde.esperado == null || Number(p.monto) + 1 < p.corresponde.esperado ? "text-crit"
                      : Number(p.monto) > p.corresponde.esperado + 1 ? "text-warn" : "text-faint"
                    }`}>
                      {p.corresponde.esperado == null
                        ? "no se puede aplicar (hay otra bajada)"
                        : `corresponde ${plata(p.corresponde.esperado)}${p.corresponde.concepto === "diferencia" ? ` (diferencia, ${p.corresponde.dias} días)` : ""}`}
                    </p>
                  )}
                </td>
                <td className="td"><Estado valor={p.estado} /></td>
                <td className="td text-right whitespace-nowrap">
                  {/* Acreditar es el paso que a propósito no es automático: el
                      sistema no puede saber si la plata llegó al banco. */}
                  {p.estado === "pendiente" && comercial && (
                    <div className="flex justify-end gap-1">
                      <button
                        className="btn-ghost btn-sm"
                        onClick={() => accionPago(p.id, "aprobar")}
                        disabled={ocupado === `pago-${p.id}`}
                      >
                        <Check size={13} /> Acreditar
                      </button>
                      <button
                        className="btn-ghost btn-sm text-crit"
                        onClick={() => accionPago(p.id, "rechazar")}
                        disabled={ocupado === `pago-${p.id}`}
                        aria-label="Rechazar"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </Tabla>
        )}
      </Card>

      <ModalAcreditar
        pago={acreditando}
        onClose={() => setAcreditando(null)}
        onAcreditado={alAcreditar}
      />

      <ModalEditar
        open={modal}
        onClose={() => setModal(false)}
        suscripcion={s}
        planes={planes}
        onGuardado={(mensaje) => { setModal(false); setOk(mensaje); cargar(); }}
        onError={setError}
        id={id}
      />
    </div>
  );
}

function Dato({ rotulo, valor, nota, notaTono }) {
  return (
    <div>
      <p className="eyebrow">{rotulo}</p>
      <p className="mt-0.5 text-sm font-medium text-text">{valor}</p>
      {nota && <p className={`text-xs ${notaTono === "ok" ? "text-ok" : notaTono === "crit" ? "text-crit" : "text-faint"}`}>{nota}</p>}
    </div>
  );
}

/*
 * Acreditar un cobro.
 *
 * Se escribe lo que entró al banco (viene con el importe que se le pidió al
 * cliente) y el backend lo compara con lo que corresponde HOY a ese plan: el
 * plan entero o, al subir con un período pago corriendo, la diferencia por los
 * días que quedan. Si no coincide no acredita: muestra los dos números y quien
 * acredita decide si lo acepta igual (queda anotado quién) o lo rechaza desde
 * la tabla. Antes el plan del pago se aplicaba sin mirar el importe.
 */
function ModalAcreditar({ pago, onClose, onAcreditado }) {
  const [monto, setMonto] = useState("");
  const [desacuerdo, setDesacuerdo] = useState(null);
  const [error, setError] = useState("");
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    if (pago) { setMonto(String(Number(pago.monto))); setDesacuerdo(null); setError(""); }
  }, [pago]);

  async function enviar(aceptarDiferencia) {
    setEnviando(true); setError("");
    try {
      const r = await api.aprobarPago(pago.id, { montoRecibido: Number(monto), aceptarDiferencia });
      onAcreditado(r);
    } catch (e) {
      const d = e.response?.data;
      if (e.response?.status === 409 && d?.motivo === "monto_no_coincide") setDesacuerdo(d);
      else setError(mensajeDe(e, "No se pudo acreditar el pago."));
    } finally { setEnviando(false); }
  }

  if (!pago) return null;
  return (
    <Modal open={Boolean(pago)} onClose={onClose} titulo="Acreditar cobro">
      <div className="space-y-4">
        <Aviso tono="error">{error}</Aviso>
        <p className="text-sm text-dim">
          {pago.detalle || "Suscripción"}{pago.plan?.nombre ? ` · ${pago.plan.nombre}` : ""}
          {pago.corresponde?.esperado != null && (
            <> · corresponde <span className="text-text">{plata(pago.corresponde.esperado)}</span></>
          )}
        </p>
        <Campo etiqueta="Importe que entró" ayuda="Lo que se ve en el extracto del banco.">
          <input className="input" type="number" min="0" step="0.01" value={monto}
                 onChange={(e) => { setMonto(e.target.value); setDesacuerdo(null); }} />
        </Campo>

        {desacuerdo && (
          <div className="rounded-[3px] border border-crit/40 bg-crit-bg p-3 text-sm text-crit">
            <p>{desacuerdo.message}</p>
            <p className="mt-1 text-xs">
              Entró {plata(desacuerdo.recibido)}
              {desacuerdo.esperado != null ? ` · corresponde ${plata(desacuerdo.esperado)}` : ""}
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancelar</button>
          {desacuerdo ? (
            <button className="btn-primary" disabled={enviando} onClick={() => enviar(true)}>
              {enviando ? "Acreditando…" : "Acreditar igual"}
            </button>
          ) : (
            <button className="btn-primary" disabled={enviando || monto === "" || Number(monto) < 0} onClick={() => enviar(false)}>
              <Check size={13} /> {enviando ? "Acreditando…" : "Acreditar"}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Medida({ rotulo, dato }) {
  if (!dato) return null;
  const sinTope = dato.tope == null;
  const pct = sinTope ? 0 : Math.min(100, (dato.usado / Math.max(1, dato.tope)) * 100);
  const lleno = !sinTope && dato.usado >= dato.tope;

  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-dim">{rotulo}</span>
        <span className="tabular text-text">
          {numero(dato.usado)}{sinTope ? "" : ` / ${numero(dato.tope)}`}
        </span>
      </div>
      {sinTope ? (
        <p className="text-xs text-faint">Sin límite</p>
      ) : (
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface2">
          <div className={`h-full rounded-full ${lleno ? "bg-crit" : "bg-brass"}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

/*
 * Edición comercial.
 *
 * Los campos van vacíos por defecto y sólo se manda lo que se completó: un
 * formulario precargado con todo reenvía valores que nadie quiso tocar, y con
 * el precio cerrado eso significa fijarle a un cliente un precio que era sólo
 * el de lista.
 */
function ModalEditar({ open, onClose, suscripcion, planes, onGuardado, onError, id }) {
  const [form, setForm] = useState({});
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    if (open) setForm({ plan: suscripcion.plan || "", descuentoPct: "", descuentoNota: "", precioAcordado: "", extenderDias: "", notas: "" });
  }, [open, suscripcion.plan]);

  const set = (campo) => (e) => setForm({ ...form, [campo]: e.target.value });

  async function guardar(e) {
    e.preventDefault();
    setGuardando(true);
    try {
      const payload = {};
      if (form.plan && form.plan !== suscripcion.plan) payload.plan = form.plan;
      if (form.descuentoPct !== "") {
        payload.descuentoPct = Number(form.descuentoPct);
        payload.descuentoNota = form.descuentoNota || null;
      }
      if (form.precioAcordado !== "") {
        payload.precioAcordado = form.precioAcordado === "0" ? null : Number(form.precioAcordado);
      }
      if (form.extenderDias !== "") payload.extenderDias = Number(form.extenderDias);
      if (form.notas !== "") payload.notas = form.notas;

      if (!Object.keys(payload).length) return onGuardado("No había cambios que guardar.");

      await api.editarSuscripcion(id, payload);
      onGuardado("Suscripción actualizada.");
    } catch (err) {
      onError(mensajeDe(err, "No se pudo guardar."));
    } finally { setGuardando(false); }
  }

  return (
    <Modal open={open} onClose={onClose} titulo="Editar suscripción">
      <form onSubmit={guardar} className="space-y-4">
        <Campo etiqueta="Plan">
          <select className="input" value={form.plan || ""} onChange={set("plan")}>
            {planes.map((p) => (
              <option key={p.codigo} value={p.codigo}>
                {p.nombre}{p.precioMensual != null ? ` — ${plata(p.precioMensual)}` : " — a cotizar"}
              </option>
            ))}
          </select>
        </Campo>

        <div className="grid gap-3 sm:grid-cols-2">
          <Campo etiqueta="Descuento %" ayuda="Vacío = no tocar.">
            <input className="input" type="number" min="0" max="100" step="0.01"
                   value={form.descuentoPct} onChange={set("descuentoPct")} placeholder="0" />
          </Campo>
          <Campo etiqueta="Precio cerrado" ayuda="0 vuelve al de lista.">
            <input className="input" type="number" min="0" step="0.01"
                   value={form.precioAcordado} onChange={set("precioAcordado")} placeholder="de lista" />
          </Campo>
        </div>

        <Campo etiqueta="Motivo del descuento">
          <input className="input" value={form.descuentoNota} onChange={set("descuentoNota")}
                 placeholder="Ej: cliente fundador" />
        </Campo>

        <Campo
          etiqueta="Extender días sin cobrar"
          ayuda="Para una cortesía o para cubrir la demora de una transferencia."
        >
          <div className="flex items-center gap-2">
            <CalendarPlus size={15} className="shrink-0 text-faint" />
            <input className="input" type="number" min="1" max="365"
                   value={form.extenderDias} onChange={set("extenderDias")} placeholder="0" />
          </div>
        </Campo>

        <Campo etiqueta="Nota interna" ayuda="No la ve el cliente.">
          <textarea className="input min-h-16" value={form.notas} onChange={set("notas")} />
        </Campo>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn-primary" disabled={guardando}>
            {guardando ? "Guardando…" : "Guardar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
