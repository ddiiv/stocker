import { useEffect, useState } from "react";
import {
  Wallet, PlayCircle, Lock, ArrowDownCircle, ArrowUpCircle, HandCoins,
  AlertTriangle, CheckCircle2, Clock,
} from "lucide-react";
import {
  fetchTurnoActual, abrirTurno, cerrarTurno, registrarMovimiento,
} from "../services/cashService";
import { formatCurrency } from "../utils/formatters";
import { Card, PageHeader } from "../components/ui/Layout";
import Modal from "../components/ui/Modal";
import OwnerCashView from "../components/cash/OwnerCashView";

const TIPOS_MOV = [
  { value: "ingreso", label: "Ingreso",  icon: ArrowDownCircle, ayuda: "Entra plata que no viene de una venta." },
  { value: "egreso",  label: "Egreso",   icon: ArrowUpCircle,   ayuda: "Sale plata por un gasto del local." },
  { value: "retiro",  label: "Retiro",   icon: HandCoins,       ayuda: "Se saca efectivo de la caja." },
];

const fechaHora = (v) =>
  new Date(v).toLocaleString("es-AR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });

export default function CashPage() {
  const [estado, setEstado] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [modalApertura, setModalApertura] = useState(false);
  const [montoInicial, setMontoInicial] = useState("");
  const [modalCierre, setModalCierre] = useState(false);
  const [montoDeclarado, setMontoDeclarado] = useState("");
  const [notaCierre, setNotaCierre] = useState("");
  const [resultadoCierre, setResultadoCierre] = useState(null);
  const [modalMov, setModalMov] = useState(false);
  const [mov, setMov] = useState({ tipo: "retiro", monto: "", motivo: "" });
  const [enviando, setEnviando] = useState(false);

  async function load() {
    setLoading(true); setError("");
    try { setEstado(await fetchTurnoActual()); }
    catch (e) { setError(e.response?.data?.message || "No se pudo cargar el estado de la caja"); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function handleAbrir(e) {
    e.preventDefault();
    setEnviando(true); setError("");
    try {
      await abrirTurno({ montoInicial: Number(montoInicial) || 0 });
      setModalApertura(false); setMontoInicial("");
      await load();
    } catch (err) {
      setError(err.response?.data?.message || "No se pudo abrir el turno");
    } finally { setEnviando(false); }
  }

/*
 * Qué decirle a quien no pudo cerrar la caja.
 *
 * Hasta acá cualquier fallo daba "No se pudo cerrar el turno", y eso tapó un
 * defecto de código durante días: la llamada al servidor se había perdido en
 * una edición, el navegador tiraba un ReferenceError, el catch lo convertía en
 * ese mismo mensaje y la cajera reintentaba pensando que era la conexión.
 *
 * Un error del servidor y un error nuestro no son lo mismo y no se resuelven
 * igual: uno se reintenta, el otro hay que reportarlo. Se distinguen, y el
 * segundo además queda en la consola con el error entero, que es lo único que
 * permite ubicarlo después.
 */
function mensajeDeCierre(err) {
  if (err?.response) {
    return err.response.data?.message || "No se pudo cerrar el turno. Probá de nuevo.";
  }
  if (err instanceof TypeError || err instanceof ReferenceError) {
    // eslint-disable-next-line no-console
    console.error("[caja] error de la aplicación al cerrar el turno:", err);
    return "Hay una falla en la aplicación, no en tu cierre. El turno sigue abierto: avisá a soporte.";
  }
  return "No se pudo cerrar el turno: revisá la conexión y probá de nuevo.";
}

  async function handleCerrar(e) {
    e.preventDefault();
    setEnviando(true); setError("");
    try {
      const r = await cerrarTurno({ montoDeclarado: Number(montoDeclarado) || 0, notaCierre });
      /*
       * Se guarda la respuesta ENTERA, no sólo el turno.
       *
       * El servidor manda el desglose —de dónde sale el esperado— y acá se
       * descartaba con `r.turno || r`. El cajero veía "faltan $12.400" y no
       * tenía contra qué compararlo: ni cuánto entró en efectivo, ni cuántas
       * ventas fueron, ni cuánto se retiró. Explicar la diferencia es
       * justamente para lo que existe ese desglose.
       */
      setResultadoCierre({ ...(r.turno || r), desglose: r.desglose || null });
      setModalCierre(false); setMontoDeclarado(""); setNotaCierre("");
      await load();
    } catch (err) {
      setError(mensajeDeCierre(err));
    } finally { setEnviando(false); }
  }

  async function handleMovimiento(e) {
    e.preventDefault();
    setEnviando(true); setError("");
    try {
      await registrarMovimiento({
        tipo: mov.tipo,
        monto: Number(mov.monto) || 0,
        motivo: mov.motivo || null,
      });
      setModalMov(false); setMov({ tipo: "retiro", monto: "", motivo: "" });
      await load();
    } catch (err) {
      setError(err.response?.data?.message || "No se pudo registrar el movimiento");
    } finally { setEnviando(false); }
  }

  // El dueño no rinde caja propia: ve las de su personal, abiertas y cerradas.
  if (!loading && estado?.esDueno) {
    return (
      <div>
        <PageHeader title="Caja" subtitle="Todas las cajas del negocio, en curso e históricas" />
        <OwnerCashView />
      </div>
    );
  }

  const turno = estado?.turno;
  const d = estado?.desglose;

  return (
    <div>
      <PageHeader
        title="Caja"
        subtitle={turno ? `Turno abierto desde el ${fechaHora(turno.abiertoEn)}` : "Abrí tu turno para empezar a vender"}
        actions={turno && (
          <button className="btn-ghost border border-line" onClick={() => { setModalCierre(true); setMontoDeclarado(""); }}>
            <Lock size={15} /> Cerrar turno
          </button>
        )}
      />

      {error && <p className="mb-4 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}

      {/* Resultado del último cierre, con el descuadre si lo hubo. */}
      {resultadoCierre && (
        <Card className={`mb-5 border-l-4 ${Number(resultadoCierre.diferencia) === 0 ? "border-l-teal-500" : "border-l-brick-500"}`}>
          <p className="flex items-center gap-2 font-display text-base font-semibold text-ink-950">
            {Number(resultadoCierre.diferencia) === 0
              ? <><CheckCircle2 size={18} className="text-teal-600" /> Turno cerrado sin diferencias</>
              : <><AlertTriangle size={18} className="text-brick-500" /> Turno cerrado con diferencia</>}
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div><p className="text-xs uppercase tracking-wide text-ink-600">Esperado</p><p className="font-display text-lg">{formatCurrency(resultadoCierre.montoEsperado)}</p></div>
            <div><p className="text-xs uppercase tracking-wide text-ink-600">Declarado</p><p className="font-display text-lg">{formatCurrency(resultadoCierre.montoDeclarado)}</p></div>
            <div>
              <p className="text-xs uppercase tracking-wide text-ink-600">Diferencia</p>
              <p className={`font-display text-lg font-semibold ${Number(resultadoCierre.diferencia) === 0 ? "text-teal-600" : "text-brick-500"}`}>
                {Number(resultadoCierre.diferencia) > 0 ? "+" : ""}{formatCurrency(resultadoCierre.diferencia)}
              </p>
            </div>
          </div>
          {/*
            * De dónde sale el número esperado.
            *
            * Se muestra SIEMPRE, cuadre o no. Cuando cuadra confirma que el
            * cálculo es el que el cajero tenía en la cabeza; cuando no cuadra
            * es lo único que permite ir a buscar dónde está la diferencia.
            */}
          {resultadoCierre.desglose && (
            <div className="mt-4 rounded-md bg-paper-100 px-3 py-2.5 text-sm">
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-600">
                Cómo se llegó a los {formatCurrency(resultadoCierre.montoEsperado)}
              </p>
              <dl className="space-y-1">
                <div className="flex justify-between text-ink-600">
                  <dt>Con lo que abriste</dt><dd>{formatCurrency(resultadoCierre.desglose.montoInicial)}</dd>
                </div>
                <div className="flex justify-between text-ink-600">
                  <dt>
                    Ventas cobradas en efectivo
                    {resultadoCierre.desglose.ventasEnEfectivo > 0 && (
                      <span className="text-ink-500"> · {resultadoCierre.desglose.ventasEnEfectivo} venta(s)</span>
                    )}
                  </dt>
                  <dd>+ {formatCurrency(resultadoCierre.desglose.efectivoVentas)}</dd>
                </div>
                {resultadoCierre.desglose.ingresos > 0 && (
                  <div className="flex justify-between text-ink-600">
                    <dt>Otros ingresos</dt><dd>+ {formatCurrency(resultadoCierre.desglose.ingresos)}</dd>
                  </div>
                )}
                {resultadoCierre.desglose.egresos > 0 && (
                  <div className="flex justify-between text-ink-600">
                    <dt>Gastos pagados de la caja</dt><dd>− {formatCurrency(resultadoCierre.desglose.egresos)}</dd>
                  </div>
                )}
                {resultadoCierre.desglose.retiros > 0 && (
                  <div className="flex justify-between text-ink-600">
                    <dt>Retiros</dt><dd>− {formatCurrency(resultadoCierre.desglose.retiros)}</dd>
                  </div>
                )}
                <div className="flex justify-between border-t border-line pt-1 font-medium text-ink-950">
                  <dt>Tendría que haber</dt><dd>{formatCurrency(resultadoCierre.montoEsperado)}</dd>
                </div>
                <div className="flex justify-between text-ink-950">
                  <dt>Contaste</dt><dd>{formatCurrency(resultadoCierre.montoDeclarado)}</dd>
                </div>
              </dl>
            </div>
          )}

          {/*
            * Qué significa la diferencia, en plata y en palabras.
            *
            * Faltar y sobrar no son lo mismo y no se arreglan igual: el
            * faltante se busca contra las ventas cobradas en efectivo, el
            * sobrante casi siempre es un movimiento que no se cargó.
            */}
          {Number(resultadoCierre.diferencia) < 0 ? (
            <div className="mt-3 rounded-md border border-brick-500/30 bg-brick-50 px-3 py-2.5 text-sm text-brick-500">
              <p className="font-medium">
                Faltan {formatCurrency(Math.abs(Number(resultadoCierre.diferencia)))} en la caja.
              </p>
              <p className="mt-1 text-ink-700">
                {resultadoCierre.desglose?.efectivoVentas > 0 ? (
                  <>
                    Se cobraron {formatCurrency(resultadoCierre.desglose.efectivoVentas)} en efectivo
                    {resultadoCierre.desglose.ventasEnEfectivo > 0
                      ? ` en ${resultadoCierre.desglose.ventasEnEfectivo} venta${resultadoCierre.desglose.ventasEnEfectivo === 1 ? "" : "s"}`
                      : ""}
                    {" "}y en el cajón hay {formatCurrency(resultadoCierre.montoDeclarado)}. Esa plata está
                    registrada como cobrada pero no está contada.
                  </>
                ) : (
                  <>En el cajón hay menos de lo que debería según lo que se abrió y lo que se movió.</>
                )}
              </p>
              <p className="mt-1.5 text-ink-700">
                Antes de dar por cerrado: fijate si quedó un retiro sin cargar, un gasto pagado de la
                caja, o un vuelto mal dado. Si aparece, cargalo como movimiento y el próximo cierre
                arranca derecho. Se le avisó al dueño con este mismo detalle.
              </p>
            </div>
          ) : Number(resultadoCierre.diferencia) > 0 ? (
            <div className="mt-3 rounded-md border border-brass-500/40 bg-brass-50 px-3 py-2.5 text-sm text-brass-800">
              <p className="font-medium">
                Sobran {formatCurrency(Number(resultadoCierre.diferencia))} en la caja.
              </p>
              <p className="mt-1 text-ink-700">
                Suele ser una venta cobrada en efectivo que se registró con otro medio de pago, o
                plata que entró sin cargarse como ingreso. Se le avisó al dueño.
              </p>
            </div>
          ) : (
            <p className="mt-3 rounded-md border border-teal-500/30 bg-teal-50 px-3 py-2.5 text-sm text-teal-700">
              La caja cierra exacta: lo contado coincide peso por peso con lo que tenía que haber.
            </p>
          )}
          <button className="btn-ghost mt-3 text-xs" onClick={() => setResultadoCierre(null)}>Entendido</button>
        </Card>
      )}

      {loading ? (
        <div className="card h-56 animate-pulse bg-paper-200/60" />
      ) : !turno ? (
        <Card className="text-center">
          <Wallet size={32} className="mx-auto text-ink-400" />
          <p className="mt-3 font-display text-lg font-semibold text-ink-950">No tenés un turno abierto</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-ink-600">
            Necesitás abrir tu turno con el efectivo con el que arrancás para poder vender.
          </p>
          {estado?.ultimoCierre && (
            <p className="mt-3 text-xs text-ink-500">
              Tu último cierre fue el {fechaHora(estado.ultimoCierre.cerradoEn)} con {formatCurrency(estado.ultimoCierre.montoDeclarado)} declarados.
            </p>
          )}
          <button className="btn-accent mx-auto mt-4" onClick={() => setModalApertura(true)}>
            <PlayCircle size={15} /> Abrir turno
          </button>
        </Card>
      ) : (
        <>
          <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <p className="text-xs uppercase tracking-wide text-ink-600">Caja inicial</p>
              <p className="mt-1 font-display text-xl font-semibold">{formatCurrency(d.montoInicial)}</p>
            </Card>
            <Card>
              <p className="text-xs uppercase tracking-wide text-ink-600">Ventas en efectivo</p>
              <p className="mt-1 font-display text-xl font-semibold text-teal-600">{formatCurrency(d.efectivoVentas)}</p>
              <p className="mt-1 text-xs text-ink-500">Tarjeta y transferencia no entran</p>
            </Card>
            <Card>
              <p className="text-xs uppercase tracking-wide text-ink-600">Salidas</p>
              <p className="mt-1 font-display text-xl font-semibold text-brick-500">
                {formatCurrency(Number(d.egresos) + Number(d.retiros))}
              </p>
              <p className="mt-1 text-xs text-ink-500">Retiros {formatCurrency(d.retiros)} · Gastos {formatCurrency(d.egresos)}</p>
            </Card>
            <Card className="border-l-4 border-l-brass-500">
              <p className="text-xs uppercase tracking-wide text-ink-600">Debería haber</p>
              <p className="mt-1 font-display text-xl font-semibold">{formatCurrency(d.montoEsperado)}</p>
            </Card>
          </div>

          <div className="mb-4 flex justify-end">
            <button className="btn-ghost border border-line" onClick={() => setModalMov(true)}>
              <HandCoins size={15} /> Registrar movimiento
            </button>
          </div>

          <Card className="p-0">
            <p className="border-b border-line px-4 py-3 font-display text-sm font-semibold text-ink-950">
              Movimientos del turno
            </p>
            {!estado.movimientos?.length ? (
              <p className="px-4 py-10 text-center text-sm text-ink-600">
                Todavía no registraste movimientos. Las ventas se suman solas.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-line bg-paper-100 text-left text-xs uppercase tracking-wide text-ink-600">
                      <th className="px-4 py-2 font-medium">Hora</th>
                      <th className="px-4 py-2 font-medium">Tipo</th>
                      <th className="px-4 py-2 font-medium">Importe</th>
                      <th className="px-4 py-2 font-medium">Nota</th>
                    </tr>
                  </thead>
                  <tbody>
                    {estado.movimientos.map((m) => {
                      const suma = m.tipo === "ingreso";
                      return (
                        <tr key={m.id} className="border-b border-line last:border-0">
                          <td className="px-4 py-2 text-ink-600">
                            <span className="inline-flex items-center gap-1">
                              <Clock size={12} />
                              {new Date(m.fecha).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false })}
                            </span>
                          </td>
                          <td className="px-4 py-2 capitalize text-ink-900">{m.tipo}</td>
                          <td className={`px-4 py-2 font-medium ${suma ? "text-teal-600" : "text-brick-500"}`}>
                            {suma ? "+" : "−"}{formatCurrency(m.monto)}
                          </td>
                          <td className="px-4 py-2 text-ink-600">{m.motivo || <span className="text-ink-400">sin nota</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      {/* ── Apertura ── */}
      <Modal open={modalApertura} onClose={() => setModalApertura(false)} title="Abrir turno de caja">
        <form onSubmit={handleAbrir} className="space-y-4">
          <div>
            <label className="label">¿Con cuánto efectivo arrancás?</label>
            <input
              type="number" step="0.01" min="0" className="input" autoFocus
              value={montoInicial} onChange={(e) => setMontoInicial(e.target.value)}
              placeholder="0"
            />
            <p className="mt-1 text-xs text-ink-500">
              Contá la plata que hay en la caja antes de empezar. Es el punto de partida del arqueo.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setModalApertura(false)}>Cancelar</button>
            <button className="btn-accent" disabled={enviando}>{enviando ? "Abriendo…" : "Abrir turno"}</button>
          </div>
        </form>
      </Modal>

      {/* ── Movimiento ── */}
      <Modal open={modalMov} onClose={() => setModalMov(false)} title="Registrar movimiento">
        <form onSubmit={handleMovimiento} className="space-y-4">
          <div className="space-y-2">
            {TIPOS_MOV.map((t) => {
              const Icon = t.icon;
              const activo = mov.tipo === t.value;
              return (
                <button
                  key={t.value} type="button"
                  onClick={() => setMov({ ...mov, tipo: t.value })}
                  className={`w-full rounded-md border px-3 py-2 text-left transition ${
                    activo ? "border-ink-950 bg-ink-950 text-paper-50" : "border-line bg-paper-50 hover:bg-paper-100"
                  }`}
                >
                  <span className="flex items-center gap-2 text-sm font-medium"><Icon size={15} /> {t.label}</span>
                  <span className={`mt-0.5 block text-xs ${activo ? "text-paper-200" : "text-ink-500"}`}>{t.ayuda}</span>
                </button>
              );
            })}
          </div>

          <div>
            <label className="label">Importe</label>
            <input
              type="number" step="0.01" min="0" className="input"
              value={mov.monto} onChange={(e) => setMov({ ...mov, monto: e.target.value })}
            />
          </div>

          <div>
            <label className="label">Nota <span className="font-normal text-ink-500">(opcional)</span></label>
            <input
              className="input" value={mov.motivo}
              onChange={(e) => setMov({ ...mov, motivo: e.target.value })}
              placeholder="Ej: depósito bancario, pago a proveedor"
            />
          </div>

          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setModalMov(false)}>Cancelar</button>
            <button className="btn-accent" disabled={enviando}>{enviando ? "Guardando…" : "Registrar"}</button>
          </div>
        </form>
      </Modal>

      {/* ── Cierre / arqueo ── */}
      <Modal open={modalCierre} onClose={() => setModalCierre(false)} title="Cerrar turno y arquear">
        <form onSubmit={handleCerrar} className="space-y-4">
          <Card className="bg-paper-100">
            <p className="text-xs uppercase tracking-wide text-ink-600">Según el sistema debería haber</p>
            <p className="mt-1 font-display text-2xl font-semibold">{formatCurrency(d?.montoEsperado || 0)}</p>
          </Card>

          <div>
            <label className="label">¿Cuánto efectivo contaste?</label>
            <input
              type="number" step="0.01" min="0" className="input" autoFocus
              value={montoDeclarado} onChange={(e) => setMontoDeclarado(e.target.value)}
              placeholder="0"
            />
            <p className="mt-1 text-xs text-ink-500">
              Contá la caja sin mirar el número de arriba. Si no coincide, se avisa al dueño.
            </p>
          </div>

          {montoDeclarado !== "" && (
            <p className={`rounded-md px-3 py-2 text-sm ${
              Math.abs(Number(montoDeclarado) - Number(d?.montoEsperado || 0)) < 0.01
                ? "bg-teal-50 text-teal-700" : "bg-brick-50 text-brick-500"
            }`}>
              {(() => {
                const dif = Number(montoDeclarado) - Number(d?.montoEsperado || 0);
                if (Math.abs(dif) < 0.01) return "Coincide con lo esperado.";
                return `${dif < 0 ? "Faltan" : "Sobran"} ${formatCurrency(Math.abs(dif))}.`;
              })()}
            </p>
          )}

          <div>
            <label className="label">Nota de cierre <span className="font-normal text-ink-500">(opcional)</span></label>
            <input
              className="input" value={notaCierre}
              onChange={(e) => setNotaCierre(e.target.value)}
              placeholder="Ej: faltó un vuelto que no se registró"
            />
          </div>

          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setModalCierre(false)}>Cancelar</button>
            <button className="btn-accent" disabled={enviando}>{enviando ? "Cerrando…" : "Cerrar turno"}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
