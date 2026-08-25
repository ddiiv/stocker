import { useEffect, useState } from "react";
import { History, ChevronDown, ChevronRight, Truck, Check, X, Clock } from "lucide-react";
import { fetchPedidos } from "../../services/depositoService";
import { formatDateTime } from "../../utils/formatters";

/*
 * Historial de reposiciones del depósito.
 *
 * Lo que se despachó, a quién, cuándo y con qué diferencias. Es el papel que
 * alguien va a querer abrir cuando el local diga "esto nunca llegó": ahí están
 * las tres cantidades de cada línea —pedida, enviada, recibida— y quién firmó
 * cada paso, que es lo único que permite ubicar dónde se cortó.
 *
 * Va cerrado por defecto y se abre pedido por pedido: el detalle de veinte
 * pedidos junto es ruido, y lo que se consulta siempre es uno.
 */

const CHIP = {
  pendiente: "badge-low", aprobado: "badge-low", enviado: "badge-low",
  recibido: "badge-ok", recibido_parcial: "badge-low",
  rechazado: "badge-out", cancelado: "badge-out",
};

const NOMBRE = {
  pendiente: "por aprobar", aprobado: "por preparar", enviado: "en camino",
  recibido: "recibido", recibido_parcial: "recibido parcial",
  rechazado: "rechazado", cancelado: "cancelado",
};

const FILTROS = [
  { key: "", label: "Todos" },
  { key: "enviado", label: "En camino" },
  { key: "recibido,recibido_parcial", label: "Cerrados" },
  { key: "rechazado,cancelado", label: "Rechazados" },
];

export default function HistorialReposiciones() {
  const [pedidos, setPedidos] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [filtro, setFiltro] = useState("");
  const [abierto, setAbierto] = useState(null);

  useEffect(() => {
    let vivo = true;
    setCargando(true);
    fetchPedidos({ estado: filtro || undefined, limit: 50 })
      .then((r) => { if (vivo) setPedidos(r.data || []); })
      .catch(() => { if (vivo) setPedidos([]); })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [filtro]);

  return (
    <div className="card p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h3 className="font-display text-base font-semibold text-ink-950">
          <History size={16} className="mr-1 inline text-ink-500" /> Historial de reposiciones
        </h3>
        <div className="flex flex-wrap gap-1 text-xs">
          {FILTROS.map((f) => (
            <button key={f.key}
              className={`rounded px-2 py-1 ${filtro === f.key ? "bg-ink-950 text-paper-50" : "text-ink-600 hover:bg-paper-200"}`}
              onClick={() => setFiltro(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {cargando ? (
        <div className="h-32 animate-pulse bg-paper-200/60" />
      ) : pedidos.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-ink-500">No hay pedidos con ese filtro.</p>
      ) : (
        <div className="divide-y divide-line">
          {pedidos.map((p) => {
            const abre = abierto === p.id;
            const items = p.items || [];
            const pedidas  = items.reduce((s, i) => s + i.cantidadPedida, 0);
            const enviadas = items.reduce((s, i) => s + i.cantidadEnviada, 0);
            const recibidas = items.reduce((s, i) => s + i.cantidadRecibida, 0);
            /*
             * Las dos diferencias se muestran por separado porque significan
             * cosas distintas: lo que no salió es un saldo que quizá haya que
             * mandar; lo que salió y no llegó es una pérdida que hay que
             * investigar.
             */
            const sinSalir = pedidas - enviadas;
            const perdidas = enviadas - recibidas;

            return (
              <div key={p.id}>
                <button
                  className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left hover:bg-paper-100"
                  onClick={() => setAbierto(abre ? null : p.id)}
                >
                  <div className="min-w-0">
                    <p className="text-sm text-ink-900">
                      {abre ? <ChevronDown size={13} className="mr-1 inline" /> : <ChevronRight size={13} className="mr-1 inline" />}
                      <span className="font-mono">{p.numero}</span>
                      <span className={`badge ${CHIP[p.estado] || ""} ml-2`}>{NOMBRE[p.estado] || p.estado}</span>
                      {p.saldoEstado === "pendiente" && (
                        <span className="badge badge-low ml-1">saldo sin resolver</span>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-500">
                      → {p.local?.nombre} · {formatDateTime(p.createdAt)} ·{" "}
                      {pedidas} pedidas / {enviadas} enviadas
                      {recibidas !== enviadas || p.estado.startsWith("recibido") ? ` / ${recibidas} recibidas` : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right text-xs">
                    {sinSalir > 0 && <p className="text-brass-800">{sinSalir} sin salir</p>}
                    {perdidas > 0 && <p className="text-brick-500">{perdidas} no llegaron</p>}
                  </div>
                </button>

                {abre && (
                  <div className="bg-paper-100 px-4 py-3">
                    {/* Quién hizo cada paso: es lo que se consulta cuando hay
                        que preguntarle a alguien qué pasó. */}
                    <div className="mb-3 grid grid-cols-1 gap-1 text-xs text-ink-600 sm:grid-cols-2">
                      <p><Clock size={12} className="mr-1 inline" />Pedido por {p.solicitadoPor?.nombre || "—"} · {formatDateTime(p.createdAt)}</p>
                      {p.aprobadoEn && (
                        <p><Check size={12} className="mr-1 inline" />
                          {p.estado === "rechazado" ? "Rechazado" : "Aprobado"} por {p.aprobadoPor?.nombre || "—"} · {formatDateTime(p.aprobadoEn)}
                        </p>
                      )}
                      {p.enviadoEn && (
                        <p><Truck size={12} className="mr-1 inline" />Despachado por {p.enviadoPor?.nombre || "—"} · {formatDateTime(p.enviadoEn)}</p>
                      )}
                      {p.recibidoEn && (
                        <p><Check size={12} className="mr-1 inline" />Recibido por {p.recibidoPor?.nombre || "—"} · {formatDateTime(p.recibidoEn)}</p>
                      )}
                    </div>

                    {p.notas && <p className="mb-2 text-xs text-ink-600">Nota: {p.notas}</p>}
                    {p.motivoRechazo && <p className="mb-2 text-xs text-brick-500">Rechazo: {p.motivoRechazo}</p>}
                    {p.notaRecepcion && <p className="mb-2 text-xs text-brass-800">Recepción: {p.notaRecepcion}</p>}
                    {p.saldoMotivo && <p className="mb-2 text-xs text-ink-600">Saldo: {p.saldoMotivo}</p>}

                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[460px] text-xs">
                        <thead>
                          <tr className="text-left uppercase tracking-wide text-ink-600">
                            <th className="py-1 font-medium">Artículo</th>
                            <th className="py-1 text-right font-medium">Pedidas</th>
                            <th className="py-1 text-right font-medium">Enviadas</th>
                            <th className="py-1 text-right font-medium">Recibidas</th>
                            <th className="py-1 text-right font-medium">Diferencia</th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((i) => {
                            const noSalio = i.cantidadPedida - i.cantidadEnviada;
                            const noLlego = i.cantidadEnviada - i.cantidadRecibida;
                            return (
                              <tr key={i.id} className="border-t border-line/60">
                                <td className="py-1.5 text-ink-700">
                                  {i.descripcion || i.sku}
                                  <span className="ml-1 font-mono text-ink-400">{i.sku}</span>
                                  {i.notaFaltante && <p className="text-brick-500">{i.notaFaltante}</p>}
                                </td>
                                <td className="py-1.5 text-right text-ink-900">{i.cantidadPedida}</td>
                                <td className="py-1.5 text-right text-ink-700">{i.cantidadEnviada}</td>
                                <td className="py-1.5 text-right text-ink-700">{i.cantidadRecibida}</td>
                                <td className="py-1.5 text-right">
                                  {noSalio > 0 && <span className="text-brass-800">−{noSalio} sin salir</span>}
                                  {noSalio > 0 && noLlego > 0 && " · "}
                                  {noLlego > 0 && <span className="text-brick-500">−{noLlego} no llegaron</span>}
                                  {noSalio === 0 && noLlego === 0 && <span className="text-teal-600">completo</span>}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
