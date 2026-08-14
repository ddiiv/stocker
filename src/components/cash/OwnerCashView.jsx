import { useEffect, useState, useCallback } from "react";
import {
  Wallet, RefreshCw, AlertTriangle, CheckCircle2, Radio, ChevronDown, ChevronRight, HandCoins, Clock,
} from "lucide-react";
import { fetchTurnos, fetchTurno, fetchRetiros } from "../../services/cashService";
import { formatCurrency } from "../../utils/formatters";
import { Card, EmptyState } from "../ui/Layout";

/*
 * Vista de caja del dueño.
 *
 * Ve todas las cajas de su negocio: las abiertas con su estado al momento y
 * las cerradas con el resultado del arqueo. Un empleado nunca llega acá — el
 * backend además filtra por employeeId, así que aunque alguien llame al
 * endpoint a mano sólo obtiene lo suyo.
 */
const fechaHora = (v) =>
  new Date(v).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

// Fecha y hora completas, para el sello de "última actualización": con sólo la
// hora no se distingue un dato de hace un rato de uno de ayer.
// Al volver a la pestaña sólo se recarga si el dato tiene más de un minuto.
const ANTIGUEDAD_MINIMA_MS = 60_000;

const selloCompleto = (v) =>
  new Date(v).toLocaleString("es-AR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

export default function OwnerCashView() {
  const [turnos, setTurnos] = useState([]);
  const [retiros, setRetiros] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expandido, setExpandido] = useState(null);
  const [detalle, setDetalle] = useState({});
  const [actualizado, setActualizado] = useState(null);
  const [refrescando, setRefrescando] = useState(false);

  const load = useCallback(async () => {
    setError(""); setRefrescando(true);
    try {
      const [t, r] = await Promise.all([fetchTurnos({ limit: 100 }), fetchRetiros()]);
      setTurnos(t);
      setRetiros(r);
      // El detalle de cada turno se cachea al desplegarlo. Si no se descarta,
      // una fila abierta seguiría mostrando los números de la consulta previa
      // al lado de totales ya actualizados.
      setDetalle({});
      setActualizado(new Date());
    } catch (e) {
      setError(e.response?.data?.message || "No se pudieron cargar las cajas");
    } finally { setLoading(false); setRefrescando(false); }
  }, []);

  /*
   * Se consulta al entrar y cuando el dueño lo pide, nunca en un intervalo.
   *
   * Cada consulta trae los turnos y los retiros, y para cada caja abierta
   * calcula su desglose al momento: son varias queries por turno. Repetirlo en
   * bucle con la pantalla abierta todo el día multiplica el costo del servidor
   * sin que nadie esté mirando. Por eso el dato es una foto con su hora, y
   * refrescarlo es una decisión explícita.
   */
  useEffect(() => { load(); }, [load]);

  /*
   * Al volver a la pestaña se refresca, pero sólo si el dato ya tiene cierta
   * antigüedad. Sin ese piso, alternar entre pestañas dispararía una consulta
   * por cada cambio de foco — el mismo goteo que se quiso evitar al sacar el
   * intervalo. Mientras la pestaña está en segundo plano no cuesta nada.
   */
  useEffect(() => {
    function alVolver() {
      if (document.visibilityState !== "visible") return;
      const edad = actualizado ? Date.now() - actualizado.getTime() : Infinity;
      if (edad > ANTIGUEDAD_MINIMA_MS) load();
    }
    document.addEventListener("visibilitychange", alVolver);
    return () => document.removeEventListener("visibilitychange", alVolver);
  }, [load, actualizado]);

  async function alternar(turno) {
    if (expandido === turno.id) return setExpandido(null);
    setExpandido(turno.id);
    if (!detalle[turno.id]) {
      try {
        const d = await fetchTurno(turno.id);
        setDetalle((prev) => ({ ...prev, [turno.id]: d }));
      } catch { /* el detalle es opcional: la fila ya muestra lo esencial */ }
    }
  }

  const abiertos = turnos.filter((t) => t.estado === "abierto");
  const cerrados = turnos.filter((t) => t.estado !== "abierto");
  const descuadres = cerrados.filter((t) => Number(t.diferencia) !== 0);

  if (loading) return <div className="card h-64 animate-pulse bg-paper-200/60" />;

  return (
    <div>
      {error && <p className="mb-4 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}

      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <p className="text-xs uppercase tracking-wide text-ink-600">Cajas abiertas</p>
          <p className="mt-1 font-display text-xl font-semibold text-teal-600">{abiertos.length}</p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-ink-600">En caja ahora</p>
          <p className="mt-1 font-display text-xl font-semibold">
            {formatCurrency(abiertos.reduce((s, t) => s + Number(t.desglose?.montoEsperado || 0), 0))}
          </p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-ink-600">Turnos con diferencia</p>
          <p className={`mt-1 font-display text-xl font-semibold ${descuadres.length ? "text-brick-500" : ""}`}>
            {descuadres.length}
          </p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-ink-600">Efectivo retirado</p>
          <p className="mt-1 font-display text-xl font-semibold">{formatCurrency(retiros?.total || 0)}</p>
          <p className="mt-1 text-xs text-ink-500">{retiros?.cantidad || 0} retiros</p>
        </Card>
      </div>

      {/* El dato no se actualiza solo: el sello tiene que ser evidente para que
          nadie tome una decisión con cifras de hace horas creyéndolas de ahora. */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-paper-100 px-3 py-2">
        <div className="flex items-start gap-2">
          <Clock size={14} className="mt-0.5 shrink-0 text-ink-500" />
          <div>
            <p className="text-xs text-ink-700">
              Datos al <span className="font-medium text-ink-900">{actualizado ? selloCompleto(actualizado) : "—"}</span>
            </p>
            <p className="text-[11px] text-ink-500">
              Las cajas abiertas siguen moviéndose. Actualizá para ver los importes al momento.
            </p>
          </div>
        </div>
        <button className="btn-ghost text-xs" onClick={load} disabled={refrescando}>
          <RefreshCw size={13} className={refrescando ? "animate-spin" : ""} />
          {refrescando ? "Actualizando…" : "Actualizar"}
        </button>
      </div>

      {turnos.length === 0 ? (
        <EmptyState
          icon={Wallet}
          title="Todavía no hay cajas"
          description="Cuando un empleado abra su turno vas a verlo acá, con su movimiento al día."
        />
      ) : (
        <Card className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-line bg-paper-100 text-left text-xs uppercase tracking-wide text-ink-600">
                  <th className="px-4 py-2 font-medium">Empleado</th>
                  <th className="px-4 py-2 font-medium">Local</th>
                  <th className="px-4 py-2 font-medium">Abierto</th>
                  <th className="px-4 py-2 font-medium">Cerrado</th>
                  <th className="px-4 py-2 font-medium">En caja</th>
                  <th className="px-4 py-2 font-medium">Diferencia</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {turnos.map((t) => {
                  const abierto = t.estado === "abierto";
                  const dif = Number(t.diferencia);
                  const enCaja = abierto ? Number(t.desglose?.montoEsperado || 0) : Number(t.montoDeclarado);
                  const det = detalle[t.id];
                  return (
                    <>
                      <tr
                        key={t.id}
                        className="cursor-pointer border-b border-line last:border-0 hover:bg-paper-100/70"
                        onClick={() => alternar(t)}
                      >
                        <td className="px-4 py-3">
                          <p className="font-medium text-ink-900">
                            {t.empleado ? `${t.empleado.nombre} ${t.empleado.apellido || ""}`.trim() : "—"}
                          </p>
                          <p className="text-xs text-ink-500">Caja #{t.id}</p>
                        </td>
                        <td className="px-4 py-3 text-ink-700">{t.local?.nombre || "—"}</td>
                        <td className="px-4 py-3 text-ink-700">{fechaHora(t.abiertoEn)}</td>
                        <td className="px-4 py-3">
                          {abierto ? (
                            <span className="inline-flex items-center gap-1 text-teal-600">
                              <Radio size={13} /> En curso
                            </span>
                          ) : (
                            <span className="text-ink-700">{fechaHora(t.cerradoEn)}</span>
                          )}
                        </td>
                        <td className="px-4 py-3 font-medium text-ink-900">{formatCurrency(enCaja)}</td>
                        <td className="px-4 py-3">
                          {abierto ? (
                            <span className="text-xs text-ink-400">—</span>
                          ) : dif === 0 ? (
                            <span className="inline-flex items-center gap-1 text-teal-600">
                              <CheckCircle2 size={13} /> Sin diferencia
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 font-medium text-brick-500">
                              <AlertTriangle size={13} /> {dif > 0 ? "+" : ""}{formatCurrency(dif)}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-3 text-ink-400">
                          {expandido === t.id ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                        </td>
                      </tr>

                      {expandido === t.id && (
                        <tr key={`${t.id}-det`} className="border-b border-line bg-paper-100/50">
                          <td colSpan={7} className="px-4 py-3">
                            {!det ? (
                              <p className="text-xs text-ink-500">Cargando detalle…</p>
                            ) : (
                              <div className="grid gap-4 md:grid-cols-2">
                                <div>
                                  <p className="mb-1 text-xs uppercase tracking-wide text-ink-600">Composición</p>
                                  <dl className="space-y-0.5 text-sm">
                                    <div className="flex justify-between"><dt className="text-ink-600">Caja inicial</dt><dd>{formatCurrency(det.desglose?.montoInicial)}</dd></div>
                                    <div className="flex justify-between"><dt className="text-ink-600">Ventas en efectivo</dt><dd className="text-teal-600">{formatCurrency(det.desglose?.efectivoVentas)}</dd></div>
                                    <div className="flex justify-between"><dt className="text-ink-600">Ingresos</dt><dd>{formatCurrency(det.desglose?.ingresos)}</dd></div>
                                    <div className="flex justify-between"><dt className="text-ink-600">Egresos</dt><dd className="text-brick-500">−{formatCurrency(det.desglose?.egresos)}</dd></div>
                                    <div className="flex justify-between"><dt className="text-ink-600">Retiros</dt><dd className="text-brick-500">−{formatCurrency(det.desglose?.retiros)}</dd></div>
                                    <div className="flex justify-between border-t border-line pt-1 font-medium">
                                      <dt>Debería haber</dt><dd>{formatCurrency(det.desglose?.montoEsperado)}</dd>
                                    </div>
                                  </dl>
                                  {det.turno?.notaCierre && (
                                    <p className="mt-2 text-xs text-ink-600">Nota de cierre: {det.turno.notaCierre}</p>
                                  )}
                                </div>
                                <div>
                                  <p className="mb-1 text-xs uppercase tracking-wide text-ink-600">
                                    Movimientos ({det.movimientos?.length || 0})
                                  </p>
                                  {!det.movimientos?.length ? (
                                    <p className="text-xs text-ink-500">Sin movimientos registrados.</p>
                                  ) : (
                                    <ul className="max-h-40 space-y-1 overflow-y-auto text-sm">
                                      {det.movimientos.map((m) => (
                                        <li key={m.id} className="flex items-baseline justify-between gap-2">
                                          <span className="text-ink-700">
                                            <span className="capitalize">{m.tipo}</span>
                                            {m.motivo && <span className="text-ink-500"> · {m.motivo}</span>}
                                          </span>
                                          <span className={m.tipo === "ingreso" ? "text-teal-600" : "text-brick-500"}>
                                            {m.tipo === "ingreso" ? "+" : "−"}{formatCurrency(m.monto)}
                                          </span>
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                </div>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {retiros?.retiros?.length > 0 && (
        <Card className="mt-5 p-0">
          <p className="flex items-center gap-2 border-b border-line px-4 py-3 font-display text-sm font-semibold text-ink-950">
            <HandCoins size={15} /> Efectivo retirado de las cajas
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <tbody>
                {retiros.retiros.map((r) => (
                  <tr key={r.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-2 font-medium text-brick-500">{formatCurrency(r.monto)}</td>
                    <td className="px-4 py-2 text-ink-700">{r.empleado}</td>
                    <td className="px-4 py-2 text-ink-600">Caja #{r.turnoId ?? "—"}</td>
                    <td className="px-4 py-2 text-ink-600">{fechaHora(r.fecha)}</td>
                    <td className="px-4 py-2 text-ink-600">{r.nota || <span className="text-ink-400">sin nota</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
