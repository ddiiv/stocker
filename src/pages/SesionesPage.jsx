import { useEffect, useState } from "react";
import { Check, Monitor, Smartphone, RefreshCw, History, MonitorSmartphone } from "lucide-react";
import { listarSesiones, cerrarSesion } from "../services/accountService";
import { PageHeader, Card } from "../components/ui/Layout";
import CuentaTabs from "../components/cuenta/CuentaTabs";
import CerrarSesiones from "../components/cuenta/CerrarSesiones";
import Medidor from "../components/cuenta/Medidor";
import { useAuth } from "../context/AuthContext";
import { esAdministradorTotal } from "../utils/permissions";
import {
  haceCuanto, fechaYHora, deQuienEs, esMovil, ordenarActivas, textoDelLimite,
} from "../utils/cuenta";

/*
 * Dónde está abierta la cuenta.
 *
 * Las sesiones abiertas ahora y las que terminaron en los últimos 30 días, con
 * el dispositivo, la IP y la última actividad: lo que hace falta para
 * reconocer "ésta es la PC del local, ésta es mi celular" y, sobre todo, para
 * ver la que no se reconoce y cerrarla.
 *
 * El dueño ve las de todo el negocio y el tope de dispositivos de su plan. Un
 * empleado ve sólo las suyas (lo filtra el backend) y puede cerrarlas: el
 * teléfono que se olvidó abierto es de él.
 */

// La lista de los 30 días puede tener cientos de renglones en un negocio con
// muchos empleados. Se muestra de a tandas para que la página no sea eterna.
const TANDA = 20;

export default function SesionesPage() {
  const { user } = useAuth();
  const esDuenio = esAdministradorTotal(user);

  const [datos, setDatos] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");
  const [actualizando, setActualizando] = useState(false);
  const [visibles, setVisibles] = useState(TANDA);

  // Cerrar una: un solo formulario abierto a la vez, el de la fila elegida.
  const [cerrandoId, setCerrandoId] = useState(null);
  const [clave, setClave] = useState("");
  const [errorCierre, setErrorCierre] = useState("");
  const [ocupado, setOcupado] = useState(false);

  async function load() {
    setActualizando(true);
    try {
      setDatos(await listarSesiones());
      setError("");
    } catch (e) {
      setError(e.response?.data?.message || "No se pudieron cargar las sesiones");
    } finally {
      setLoading(false);
      setActualizando(false);
    }
  }
  useEffect(() => { load(); }, []);

  function abrirCierre(id) {
    setCerrandoId(id); setClave(""); setErrorCierre(""); setAviso("");
  }
  function cancelarCierre() {
    setCerrandoId(null); setClave(""); setErrorCierre("");
  }

  async function confirmarCierre(e) {
    e.preventDefault();
    setOcupado(true); setErrorCierre("");
    try {
      const r = await cerrarSesion(cerrandoId, clave);
      setAviso(r?.message || "Listo. Esa sesión se cerró.");
      cancelarCierre();
      await load();
    } catch (err) {
      // 404: ya no está (la cerraron desde otro lado o venció). La lista
      // que se ve está vieja: se recarga para que no ofrezca cerrarla otra vez.
      if (err.response?.status === 404) {
        cancelarCierre();
        setAviso(err.response?.data?.message || "Esa sesión ya no está abierta.");
        await load();
      } else {
        setErrorCierre(err.response?.data?.message || "No se pudo cerrar la sesión");
      }
    } finally { setOcupado(false); }
  }

  const activas = ordenarActivas(datos?.sesiones || []);
  const historial = datos?.historial || [];
  const limite = textoDelLimite(datos?.limite);

  return (
    <div>
      <PageHeader
        title="Sesiones"
        subtitle={esDuenio
          ? "Dónde está abierta la cuenta, tuya y de tus empleados"
          : "Dónde está abierto tu usuario"}
        actions={
          <button className="btn-ghost" onClick={load} disabled={actualizando}>
            <RefreshCw size={15} className={actualizando ? "animate-spin" : ""} /> Actualizar
          </button>
        }
      />
      <CuentaTabs />

      {loading ? (
        <div className="card h-64 animate-pulse bg-paper-200/60" />
      ) : (
        <div className="space-y-5">
          {error && <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}
          {aviso && (
            <p className="flex items-start gap-2 rounded-md bg-teal-50 px-3 py-2 text-sm text-teal-700" role="status">
              <Check size={15} className="mt-0.5 shrink-0" /> {aviso}
            </p>
          )}

          {/* ── El tope del plan: sólo el dueño lo tiene ── */}
          {limite && (
            <Card>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="flex items-center gap-2 font-display text-base font-semibold text-ink-950">
                  <MonitorSmartphone size={17} /> Dispositivos del dueño
                </p>
                {/* Con barra, la cifra ya está en el medidor: dos veces es ruido. */}
                {!limite.conBarra && (
                  <p className="font-display text-lg font-semibold tabular-nums text-ink-950">{limite.cifra}</p>
                )}
              </div>
              {limite.conBarra && (
                <div className="mt-2">
                  <Medidor
                    icono={Monitor}
                    rotulo="Abiertas ahora"
                    dato={{ usado: datos.limite.activas, tope: datos.limite.tope }}
                    // El tope de sesiones no frena un ingreso: no corresponde
                    // el "llegaste al tope" de los demás medidores.
                    avisarTope={false}
                    nota={limite.pasado ? "Hay más abiertas de las que incluye tu plan." : null}
                  />
                </div>
              )}
              <p className="mt-2 text-sm text-ink-600">{limite.detalle}</p>
              <p className="mt-1 text-xs text-ink-500">
                Cuentan las sesiones del dueño con actividad en la última media hora. Las de
                tus empleados no tienen tope.
              </p>
            </Card>
          )}

          {/* ── Abiertas ahora ── */}
          <section aria-labelledby="titulo-activas">
            <h3 id="titulo-activas" className="mb-2 font-display text-base font-semibold text-ink-950">
              Abiertas ahora <span className="font-normal text-ink-500">({activas.length})</span>
            </h3>
            <ul className="space-y-2">
              {activas.map((s) => (
                <FilaSesion key={s.id} s={s} quien={deQuienEs(s, user)}>
                  {!s.actual && cerrandoId !== s.id && (
                    <button type="button" className="btn-ghost border border-line px-3 py-1.5 text-xs"
                      onClick={() => abrirCierre(s.id)}
                      aria-label={`Cerrar la sesión de ${s.dispositivo}${deQuienEs(s, user) ? `, ${deQuienEs(s, user)}` : ""}`}>
                      Cerrar
                    </button>
                  )}
                  {cerrandoId === s.id && (
                    <form onSubmit={confirmarCierre} className="mt-3 w-full space-y-2 border-t border-line pt-3">
                      <p className="text-sm text-ink-700">
                        En su próximo clic, ese dispositivo va a tener que volver a entrar.
                        {s.tipo === "employee" && esDuenio && " Si está vendiendo, pierde lo que no haya guardado."}
                      </p>
                      {errorCierre && (
                        <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{errorCierre}</p>
                      )}
                      <div>
                        <label className="label" htmlFor={`clave-sesion-${s.id}`}>Confirmá con tu contraseña actual</label>
                        <input id={`clave-sesion-${s.id}`} className="input" type="password" value={clave}
                          aria-required="true" autoComplete="current-password" autoFocus
                          onChange={(e) => setClave(e.target.value)} />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button className="btn-accent px-3 py-1.5 text-xs" disabled={ocupado || !clave}>
                          {ocupado ? "Cerrando…" : "Cerrar esa sesión"}
                        </button>
                        <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={cancelarCierre}>
                          Cancelar
                        </button>
                      </div>
                    </form>
                  )}
                </FilaSesion>
              ))}
            </ul>
          </section>

          <CerrarSesiones esDuenio={esDuenio} onListo={load} />

          {/* ── Los últimos 30 días ── */}
          <section aria-labelledby="titulo-historial">
            <h3 id="titulo-historial" className="mb-1 flex items-center gap-2 font-display text-base font-semibold text-ink-950">
              <History size={16} /> Cerradas en los últimos 30 días
              <span className="font-normal text-ink-500">({historial.length})</span>
            </h3>
            <p className="mb-2 text-xs text-ink-500">
              Las que se cerraron con «Salir», desde otro dispositivo o porque vencieron.
            </p>
            {historial.length === 0 ? (
              <p className="rounded-md bg-paper-200 px-3 py-3 text-sm text-ink-600">
                No hay sesiones cerradas en los últimos 30 días.
              </p>
            ) : (
              <>
                <ul className="space-y-2">
                  {historial.slice(0, visibles).map((s) => (
                    <FilaSesion key={s.id} s={s} quien={deQuienEs(s, user)} cerrada />
                  ))}
                </ul>
                {historial.length > visibles && (
                  <button type="button" className="btn-ghost mt-2 border border-line text-xs"
                    onClick={() => setVisibles((v) => v + TANDA * 2)}>
                    Ver más ({historial.length - visibles} restantes)
                  </button>
                )}
                {datos?.historialTruncado && historial.length <= visibles && (
                  <p className="mt-2 text-xs text-ink-500">
                    Se muestran las más recientes. Las más viejas de los 30 días no entran en la lista.
                  </p>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

/*
 * Un renglón de la lista. Igual para las abiertas y las cerradas: cambia la
 * última línea (actividad o cierre) y si lleva botón.
 *
 * Tarjeta y no tabla: en un teléfono una tabla de cinco columnas se corta o
 * obliga a arrastrar de costado, y ésta es justo la pantalla que se abre desde
 * el celular cuando se perdió el otro.
 */
function FilaSesion({ s, quien, cerrada = false, children }) {
  const Icono = esMovil(s.dispositivo) ? Smartphone : Monitor;
  return (
    <li className="rounded-md border border-line bg-paper-50 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-paper-200 text-ink-700">
            <Icono size={16} />
          </div>
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-ink-900">
              {s.dispositivo || "Dispositivo desconocido"}
              {s.actual && <span className="badge badge-ok">Este dispositivo</span>}
              {s.suspendida && (s.suspendidaPorPlan ? (
                <span className="badge badge-low" title="La cuenta pasó a un plan con menos usuarios: vuelve solo si sube de plan.">
                  Suspendido por el plan
                </span>
              ) : (
                <span className="badge badge-out" title="El usuario está desactivado: no puede entrar hasta que lo reactiven.">
                  Usuario desactivado
                </span>
              ))}
              {cerrada && (
                <span className="badge bg-paper-200 text-ink-700">{s.estado === "vencida" ? "Venció" : "Cerrada"}</span>
              )}
            </p>
            {quien && <p className="text-xs text-ink-700">{quien}</p>}
            <p className="text-xs text-ink-500">
              IP <span className="font-mono">{s.ip || "—"}</span> · Entró {fechaYHora(s.creadaEn)}
            </p>
            {cerrada ? (
              <p className="text-xs text-ink-500">
                Terminó {fechaYHora(s.cerradaEn)}{s.motivoTexto ? ` · ${s.motivoTexto}` : ""}
              </p>
            ) : (
              <p className="text-xs text-ink-500">Última actividad: {haceCuanto(s.ultimaActividadEn)}</p>
            )}
          </div>
        </div>
        {children}
      </div>
    </li>
  );
}
