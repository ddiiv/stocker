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

  async function accionPago(pagoId, accion) {
    setOcupado(`pago-${pagoId}`); setError(""); setOk("");
    try {
      if (accion === "aprobar") {
        const r = await api.aprobarPago(pagoId);
        setOk(`Pago acreditado. La cuenta queda paga hasta el ${fecha(r.periodo.hasta)}.`);
      } else {
        await api.rechazarPago(pagoId, "Rechazado desde el backoffice");
        setOk("Pago marcado como rechazado.");
      }
      await cargar();
    } catch (e) {
      setError(mensajeDe(e, "No se pudo procesar el pago."));
    } finally { setOcupado(""); }
  }

  if (cargando) return <Cargando />;
  if (!datos) return <Aviso tono="error">{error || "Cuenta no encontrada."}</Aviso>;

  const { negocio, suscripcion: s, uso, pagos, actividad } = datos;

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
                  {p.periodoDesde && (
                    <p className="text-xs text-faint">{fecha(p.periodoDesde)} → {fecha(p.periodoHasta)}</p>
                  )}
                  {p.verificadoPor && (
                    <p className="text-xs text-faint">Verificó {p.verificadoPor}</p>
                  )}
                </td>
                <td className="td text-dim">
                  {p.metodo === "mercadopago" ? "Mercado Pago"
                   : p.metodo === "transferencia" ? "Transferencia" : "Manual"}
                </td>
                <td className="td text-right tabular">{plata(p.monto)}</td>
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
      {nota && <p className={`text-xs ${notaTono === "ok" ? "text-ok" : "text-faint"}`}>{nota}</p>}
    </div>
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
