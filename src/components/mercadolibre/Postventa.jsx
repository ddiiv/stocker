import { useCallback, useEffect, useState } from "react";
import {
  MessageSquare, AlertTriangle, RefreshCw, Check, Clock, ExternalLink,
} from "lucide-react";
import { Card } from "../ui/Layout";
import {
  getMlMensajes, marcarConversacionLeida, getMlReclamos, seguirReclamo,
  sincronizarPostventa,
} from "../../services/mercadolibreService";
import { mensajeDeError } from "../../utils/errores";
import { formatCurrency } from "../../utils/formatters";

/*
 * Lo que pasa después de la venta: lo que escribe el comprador y lo que
 * reclama.
 *
 * Son dos bandejas de trabajo, no dos listados. La pregunta que contestan no es
 * "¿qué pasó?" sino "¿qué me falta atender?", y por eso las dos ordenan
 * poniendo primero lo pendiente y las dos llevan un estado propio —leído,
 * atendido— que Mercado Libre no tiene dónde guardar.
 *
 * El reloj es lo que las separa de una bandeja de correo. Un reclamo que se
 * pasa del plazo lo resuelve ML a favor del comprador y le pega a la reputación
 * de la cuenta: no alcanza con listarlos, hay que decir cuánto queda.
 */
export default function Postventa() {
  const [solapa, setSolapa] = useState("mensajes");
  const [mensajes, setMensajes] = useState(null);
  const [reclamos, setReclamos] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");

  const cargar = useCallback(async () => {
    setCargando(true); setError("");
    try {
      const [m, r] = await Promise.all([getMlMensajes(), getMlReclamos()]);
      setMensajes(m);
      setReclamos(r);
    } catch (e) {
      setError(mensajeDeError(e, "No se pudo cargar la posventa."));
    }
    setCargando(false);
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  async function traerDeMl() {
    setTrabajando(true); setError(""); setAviso("");
    try {
      const r = await sincronizarPostventa();
      setAviso(r.mensaje);
      await cargar();
    } catch (e) {
      setError(mensajeDeError(e, "No se pudo traer la posventa de Mercado Libre."));
    }
    setTrabajando(false);
  }

  const sinLeer = mensajes?.resumen?.sinLeer || 0;
  const sinAtender = reclamos?.resumen?.sinAtender || 0;
  const vencidos = reclamos?.resumen?.vencidos || 0;

  return (
    <Card className="mb-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1">
          <Solapa activa={solapa === "mensajes"} onClick={() => setSolapa("mensajes")}
            icono={MessageSquare} texto="Mensajes" cuenta={sinLeer} />
          <Solapa activa={solapa === "reclamos"} onClick={() => setSolapa("reclamos")}
            icono={AlertTriangle} texto="Reclamos" cuenta={sinAtender} urgente={vencidos > 0} />
        </div>
        {/*
          * El botón existe aunque esto llegue solo por webhook y por el barrido
          * cada quince minutos: cuando alguien sospecha que falta algo, una
          * pantalla que no ofrece forma de comprobarlo es peor que la espera.
          */}
        <button className="btn-ghost gap-1.5 px-3 py-1.5 text-xs" onClick={traerDeMl} disabled={trabajando}>
          <RefreshCw size={13} className={trabajando ? "animate-spin" : ""} />
          {trabajando ? "Trayendo…" : "Traer de Mercado Libre"}
        </button>
      </div>

      {error && (
        <p className="mb-3 flex items-start gap-1.5 rounded-md border border-brick-200 bg-brick-50 px-3 py-2 text-sm text-brick-700">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />{error}
        </p>
      )}
      {aviso && <p className="mb-3 text-xs text-ink-600">{aviso}</p>}

      {cargando ? (
        <p className="py-8 text-center text-sm text-ink-500">Cargando…</p>
      ) : solapa === "mensajes" ? (
        <Mensajes datos={mensajes} onLeida={cargar} onError={setError} />
      ) : (
        <Reclamos datos={reclamos} onCambio={cargar} onError={setError} />
      )}
    </Card>
  );
}

function Solapa({ activa, onClick, icono: Icono, texto, cuenta, urgente }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${
        activa ? "bg-ink-950 text-paper-50" : "text-ink-700 hover:bg-paper-100"
      }`}
    >
      <Icono size={14} /> {texto}
      {cuenta > 0 && (
        <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${
          urgente ? "bg-brick-500 text-paper-50"
            : activa ? "bg-paper-50 text-ink-950" : "bg-brass-50 text-brass-700"
        }`}>
          {cuenta}
        </span>
      )}
    </button>
  );
}

function Mensajes({ datos, onLeida, onError }) {
  const [abierta, setAbierta] = useState(null);
  const conversaciones = datos?.conversaciones || [];

  if (!conversaciones.length) {
    return (
      <p className="py-8 text-center text-sm text-ink-500">
        No hay mensajes de compradores. Aparecen solos apenas Mercado Libre los avisa.
      </p>
    );
  }

  async function marcar(packId) {
    try {
      await marcarConversacionLeida(packId);
      await onLeida();
    } catch (e) {
      onError(mensajeDeError(e, "No se pudo marcar como leída."));
    }
  }

  return (
    <ul className="divide-y divide-line">
      {conversaciones.map((c) => (
        <li key={c.packId} className="py-3">
          <button
            className="flex w-full items-start justify-between gap-3 text-left"
            onClick={() => setAbierta(abierta === c.packId ? null : c.packId)}
          >
            <div className="min-w-0">
              <p className="text-sm text-ink-900">
                {c.comprador || `Venta ${c.pedidoExterno || c.packId}`}
                {c.sinLeer > 0 && (
                  <span className="ml-2 rounded-full bg-brass-50 px-1.5 py-0.5 text-[11px] font-semibold text-brass-700">
                    {c.sinLeer} sin leer
                  </span>
                )}
              </p>
              {/*
                * El último mensaje en la fila: es lo que deja decidir si abrir o
                * no sin abrir. Una lista de nombres obliga a entrar a todas.
                */}
              <p className="mt-0.5 truncate text-xs text-ink-500">
                {c.mensajes[c.mensajes.length - 1]?.deQuien === "vendedor" ? "Vos: " : ""}
                {c.mensajes[c.mensajes.length - 1]?.texto}
              </p>
            </div>
            <span className="shrink-0 text-[11px] text-ink-400">
              {c.ultimo ? new Date(c.ultimo).toLocaleString("es-AR") : ""}
            </span>
          </button>

          {abierta === c.packId && (
            <div className="mt-3 space-y-2 rounded-md bg-paper-100 p-3">
              {c.mensajes.map((m) => (
                <div key={m.id} className={m.deQuien === "vendedor" ? "text-right" : ""}>
                  <p className={`inline-block max-w-[85%] rounded-md px-2.5 py-1.5 text-sm ${
                    m.deQuien === "vendedor"
                      ? "bg-ink-950 text-paper-50"
                      : "bg-paper-50 text-ink-900"
                  }`}>
                    {m.texto}
                  </p>
                  {m.adjuntos?.length > 0 && (
                    <p className="mt-0.5 text-[11px] text-ink-500">
                      Adjuntos: {m.adjuntos.join(", ")} — se ven en Mercado Libre
                    </p>
                  )}
                  <p className="mt-0.5 text-[11px] text-ink-400">
                    {m.enviadoEn ? new Date(m.enviadoEn).toLocaleString("es-AR") : ""}
                  </p>
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
                {c.sinLeer > 0 && (
                  <button className="btn-ghost gap-1.5 px-2 py-1 text-xs" onClick={() => marcar(c.packId)}>
                    <Check size={13} /> Marcar leída
                  </button>
                )}
                {/*
                  * Responder se hace en Mercado Libre. Contestar desde acá
                  * manda un mensaje a nombre del vendedor, y eso merece su
                  * propia decisión: por ahora la pantalla es para enterarse y
                  * no perder de vista lo que espera respuesta.
                  */}
                <a
                  className="btn-ghost gap-1.5 px-2 py-1 text-xs"
                  href={`https://myaccount.mercadolibre.com.ar/ventas/${c.pedidoExterno || c.packId}`}
                  target="_blank" rel="noopener noreferrer"
                >
                  <ExternalLink size={13} /> Responder en Mercado Libre
                </a>
                {c.total ? (
                  <span className="text-[11px] text-ink-500">Venta de {formatCurrency(c.total)}</span>
                ) : null}
              </div>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function Reclamos({ datos, onCambio, onError }) {
  const reclamos = datos?.reclamos || [];
  const [editando, setEditando] = useState(null);
  const [nota, setNota] = useState("");

  if (!reclamos.length) {
    return (
      <p className="py-8 text-center text-sm text-ink-500">
        No hay reclamos. Aparecen solos apenas Mercado Libre los abre.
      </p>
    );
  }

  async function guardar(r, atendido) {
    try {
      await seguirReclamo(r.id, { atendido, nota: editando === r.id ? nota : undefined });
      setEditando(null); setNota("");
      await onCambio();
    } catch (e) {
      onError(mensajeDeError(e, "No se pudo guardar el seguimiento."));
    }
  }

  return (
    <ul className="divide-y divide-line">
      {reclamos.map((r) => (
        <li key={r.id} className="py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-ink-900">
                {r.razon || r.tipo || "Reclamo"}
                {r.pedidoExterno && (
                  <span className="ml-2 text-xs text-ink-500">venta {r.pedidoExterno}</span>
                )}
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-500">
                <span className="tag-chip">{r.estadoMl || "sin estado"}</span>
                {r.etapa && <span>etapa {r.etapa}</span>}
                {r.abiertoEn && <span>abierto {new Date(r.abiertoEn).toLocaleDateString("es-AR")}</span>}
              </p>
              {r.nota && <p className="mt-1 text-xs text-ink-600">Nota: {r.nota}</p>}
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {/*
                * El reloj es lo que hace accionable la lista. Vencido significa
                * que ML ya puede resolverlo a favor del comprador: no queda
                * nada que hacer desde acá salvo entender qué falló.
                */}
              {r.vencido ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-brick-500 px-2 py-0.5 text-[11px] font-medium text-paper-50">
                  <Clock size={11} /> plazo vencido
                </span>
              ) : r.horasParaVencer !== null ? (
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  r.horasParaVencer <= 24 ? "bg-brass-50 text-brass-700" : "bg-paper-100 text-ink-600"
                }`}>
                  <Clock size={11} /> {r.horasParaVencer} h para responder
                </span>
              ) : r.cerradoEn ? (
                <span className="rounded-full bg-paper-100 px-2 py-0.5 text-[11px] text-ink-600">cerrado</span>
              ) : null}

              {!r.cerradoEn && (
                <button
                  className="btn-ghost gap-1.5 px-2 py-1 text-xs"
                  onClick={() => guardar(r, !r.atendidoEn)}
                >
                  <Check size={13} /> {r.atendidoEn ? "Atendido" : "Marcar atendido"}
                </button>
              )}
              <button
                className="btn-ghost px-2 py-1 text-xs"
                onClick={() => { setEditando(editando === r.id ? null : r.id); setNota(r.nota || ""); }}
              >
                Nota
              </button>
            </div>
          </div>

          {editando === r.id && (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <textarea
                className="input min-h-[60px] flex-1" value={nota} maxLength={4000}
                placeholder="Qué se hizo o qué falta hacer. Mercado Libre no tiene dónde anotar esto."
                onChange={(e) => setNota(e.target.value)}
              />
              <button className="btn-primary px-3 py-1.5 text-xs" onClick={() => guardar(r, Boolean(r.atendidoEn))}>
                Guardar
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
