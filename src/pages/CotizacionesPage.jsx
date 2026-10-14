import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw, MessageSquareText } from "lucide-react";
import * as api from "../lib/api";
import { mensajeDe } from "../lib/http";
import { Card, PageHead, Aviso, Cargando, Vacio, Tabla, Modal, Campo } from "../components/ui";

/*
 * Los pedidos de cotización de un desarrollo a medida.
 *
 * Los hace el cliente desde Plataformas: su portal mayorista o conectar una
 * tienda propia. Cada uno es un cliente que quiere pagar un trabajo, así que
 * se guarda ANTES de mandar el mail de aviso: si el correo falla, el pedido
 * está igual acá. Esta lista es la que no deja que se pierda; la columna
 * "Aviso" dice si el mail salió.
 *
 * El estado lo mueve el equipo y el cliente lo ve en su pantalla ("Te
 * contactamos", "Presupuesto enviado"…). La nota interna no la ve nunca.
 */

const ESTADOS = [
  { valor: "nueva",      etiqueta: "Nueva",      chip: "chip-warn" },
  { valor: "contactada", etiqueta: "Contactada", chip: "chip-mute" },
  { valor: "cotizada",   etiqueta: "Cotizada",   chip: "chip-mute" },
  { valor: "aceptada",   etiqueta: "Aceptada",   chip: "chip-ok" },
  { valor: "descartada", etiqueta: "Descartada", chip: "chip-mute" },
];
const deEstado = (v) => ESTADOS.find((e) => e.valor === v) || { etiqueta: v, chip: "chip-mute" };

const fecha = (v) => (v ? new Intl.DateTimeFormat("es-AR", {
  day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
}).format(new Date(v)) : "—");

export default function CotizacionesPage() {
  const [filtro, setFiltro] = useState("");
  const [lista, setLista] = useState(null);
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(false);
  const [abierta, setAbierta] = useState(null);
  const [nota, setNota] = useState("");
  const [estado, setEstado] = useState("nueva");
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError("");
    try {
      const r = await api.getCotizaciones(filtro ? { estado: filtro } : {});
      setLista(r.cotizaciones || []);
    } catch (e) {
      setError(mensajeDe(e));
      setLista([]);
    } finally {
      setCargando(false);
    }
  }, [filtro]);

  useEffect(() => { cargar(); }, [cargar]);

  function abrir(c) {
    setAbierta(c);
    setNota(c.notaInterna || "");
    setEstado(c.estado);
  }

  async function guardar() {
    setGuardando(true);
    setError("");
    try {
      await api.editarCotizacion(abierta.id, { estado, notaInterna: nota });
      setAbierta(null);
      await cargar();
    } catch (e) {
      setError(mensajeDe(e));
    } finally {
      setGuardando(false);
    }
  }

  const nuevas = (lista || []).filter((c) => c.estado === "nueva").length;

  return (
    <div>
      <PageHead
        titulo="Cotizaciones"
        bajada="Pedidos de un desarrollo a medida (portal mayorista, tienda propia). Se guardan aunque el mail de aviso no salga."
        acciones={
          <button onClick={cargar} disabled={cargando} className="btn-ghost gap-1.5 text-sm">
            <RefreshCw size={14} className={cargando ? "animate-spin" : ""} /> Actualizar
          </button>
        }
      />

      {error && <Aviso tono="error">{error}</Aviso>}

      <div className="mb-4 flex flex-wrap gap-1.5">
        {[{ valor: "", etiqueta: "Todas" }, ...ESTADOS].map((e) => (
          <button
            key={e.valor || "todas"}
            onClick={() => setFiltro(e.valor)}
            className={`rounded-[3px] border px-3 py-1 text-xs ${filtro === e.valor ? "border-brass bg-surface2 text-brass" : "border-line text-dim hover:text-text"}`}
          >
            {e.etiqueta}
            {e.valor === "nueva" && !filtro && nuevas > 0 ? ` (${nuevas})` : ""}
          </button>
        ))}
      </div>

      {lista === null ? (
        <Cargando />
      ) : lista.length === 0 ? (
        <Card><Vacio>No hay pedidos de cotización {filtro ? "en ese estado" : "todavía"}.</Vacio></Card>
      ) : (
        <Card className="p-0">
          <Tabla cabeceras={["#", "Cuándo", "Negocio", "Qué pide", "Contacto", "Aviso", "Estado", ""]} min="min-w-[1000px]">
            {lista.map((c) => (
              <tr key={c.id} className="border-b border-line last:border-0 align-top">
                <td className="px-4 py-3 font-mono text-xs text-dim">{c.id}</td>
                <td className="px-4 py-3 text-sm text-dim">{fecha(c.createdAt)}</td>
                <td className="px-4 py-3">
                  <Link to={`/cuentas/${c.negocio?.id}`} className="font-medium text-text hover:text-brass">{c.negocio?.nombre || "—"}</Link>
                  <p className="text-xs text-dim">{c.negocio?.email || ""}</p>
                </td>
                <td className="max-w-[280px] px-4 py-3">
                  <p className="text-sm text-text">{c.tipoTexto}</p>
                  {/* Texto del cliente: React lo escapa al pintarlo. */}
                  <p className="line-clamp-2 text-xs text-dim">{c.detalle}</p>
                </td>
                <td className="px-4 py-3 text-xs text-dim">
                  <p className="text-text">{c.contactoNombre || "—"}</p>
                  <p>{c.contactoEmail || ""}</p>
                  <p>{c.contactoTelefono || ""}</p>
                </td>
                <td className="px-4 py-3 text-xs">
                  {c.avisoEnviadoEn
                    ? <span className="text-ok">mail enviado</span>
                    : c.avisoError
                      ? <span className="text-warn" title={c.avisoError}>no salió el mail</span>
                      : <span className="text-faint">enviando…</span>}
                </td>
                <td className="px-4 py-3">
                  <span className={`chip ${deEstado(c.estado).chip}`}>{deEstado(c.estado).etiqueta}</span>
                  {c.estadoCambiadoPor && <p className="mt-1 text-[11px] text-faint">{c.estadoCambiadoPor}</p>}
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => abrir(c)} className="btn-ghost gap-1.5 text-sm">
                    <MessageSquareText size={14} /> Ver
                  </button>
                </td>
              </tr>
            ))}
          </Tabla>
        </Card>
      )}

      <Modal open={Boolean(abierta)} onClose={() => setAbierta(null)} titulo={abierta ? `Cotización #${abierta.id} · ${abierta.negocio?.nombre || ""}` : ""} ancho="max-w-xl">
        {abierta && (
          <div className="space-y-4">
            <div>
              <p className="mb-1 text-xs uppercase tracking-wide text-dim">{abierta.tipoTexto}</p>
              <p className="whitespace-pre-wrap rounded-[3px] border border-line bg-surface2 p-3 text-sm text-text">{abierta.detalle}</p>
            </div>
            <p className="text-xs text-dim">
              Contacto: {[abierta.contactoNombre, abierta.contactoEmail, abierta.contactoTelefono].filter(Boolean).join(" · ") || "—"}
            </p>
            {abierta.avisoError && (
              <Aviso tono="error">El mail de aviso no salió ({abierta.avisoError}). El pedido está guardado igual.</Aviso>
            )}
            <Campo etiqueta="Estado" ayuda="El cliente ve el estado en su pantalla de Plataformas.">
              <select className="input w-full" value={estado} onChange={(e) => setEstado(e.target.value)}>
                {ESTADOS.map((e) => <option key={e.valor} value={e.valor}>{e.etiqueta}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Nota interna" ayuda="Sólo para el equipo: el cliente no la ve.">
              <textarea className="input min-h-[90px] w-full" maxLength={4000} value={nota} onChange={(e) => setNota(e.target.value)} />
            </Campo>
            <div className="flex justify-end gap-2">
              <button className="btn-ghost text-sm" onClick={() => setAbierta(null)}>Cancelar</button>
              <button className="btn-primary text-sm" disabled={guardando} onClick={guardar}>
                {guardando ? "Guardando…" : "Guardar"}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
