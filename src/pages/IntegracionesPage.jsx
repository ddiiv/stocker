import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Copy, Check, AlertTriangle, Plug, Power } from "lucide-react";
import * as api from "../lib/api";
import { mensajeDe } from "../lib/http";
import { Card, PageHead, Aviso, Cargando, Vacio, Tabla, Modal, Campo } from "../components/ui";

/*
 * Las credenciales con las que un sistema de afuera le escribe a un negocio.
 *
 * Hoy la única es el portal mayorista: el cliente arma el pedido allá y acá
 * entra como una solicitud para revisar. Sin credencial no entra nada, y
 * emitirla es la última pieza del alta de ese cliente — por eso la hacemos
 * nosotros y no él: hasta que el puente funciona, del otro lado no hay nada
 * que se pueda hacer solo.
 *
 * ── El token se muestra una vez ──────────────────────────────────
 *
 * Se guarda hasheado, así que ni esta pantalla ni la base pueden volver a
 * mostrarlo. Si se pierde, se emite otro — y eso apaga el anterior, que es
 * justo lo que hay que decir antes de apretar el botón y no después.
 */

const ORIGENES = [
  { valor: "isuwaya", etiqueta: "Portal mayorista (ISUWAYA)" },
];

function Copiable({ valor, etiqueta = "Copiar" }) {
  const [copiado, setCopiado] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(valor);
        setCopiado(true);
        setTimeout(() => setCopiado(false), 1500);
      }}
      className="btn-ghost gap-1.5 text-sm"
    >
      {copiado ? <Check size={14} className="text-ok" /> : <Copy size={14} />} {copiado ? "Copiado" : etiqueta}
    </button>
  );
}

function CuandoSeUso({ fecha }) {
  if (!fecha) return <span className="text-warn">nunca</span>;
  const dias = Math.floor((Date.now() - new Date(fecha).getTime()) / 86400000);
  /*
   * Se marca a partir de tres días sin uso. Un portal conectado manda pedidos
   * seguido: que deje de hacerlo es la primera señal de que algo se rompió —y
   * del otro lado nadie se entera, porque los pedidos se siguen tomando allá.
   */
  return (
    <span className={dias >= 3 ? "text-warn" : "text-dim"}>
      {dias === 0 ? "hoy" : dias === 1 ? "ayer" : `hace ${dias} días`}
    </span>
  );
}

export default function IntegracionesPage() {
  const [integraciones, setIntegraciones] = useState(null);
  const [cuentas, setCuentas] = useState([]);
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(false);

  const [abrirAlta, setAbrirAlta] = useState(false);
  const [businessId, setBusinessId] = useState("");
  const [origen, setOrigen] = useState("isuwaya");
  const [emitiendo, setEmitiendo] = useState(false);
  const [reciénEmitida, setReciénEmitida] = useState(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError("");
    try {
      const r = await api.getIntegraciones();
      setIntegraciones(r.integraciones || []);
    } catch (e) {
      setError(mensajeDe(e));
      setIntegraciones([]);
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  /* Las cuentas, para elegir el negocio por nombre y no por número. */
  useEffect(() => {
    api.getCuentas({ limit: 300 })
      .then((r) => setCuentas(r.cuentas || r.data || []))
      .catch(() => setCuentas([]));
  }, []);

  async function emitir() {
    setEmitiendo(true);
    setError("");
    try {
      const r = await api.emitirIntegracion({ businessId: Number(businessId), origen });
      setReciénEmitida(r);
      setAbrirAlta(false);
      await cargar();
    } catch (e) {
      setError(mensajeDe(e));
    } finally {
      setEmitiendo(false);
    }
  }

  async function revocar(fila) {
    /*
     * Se pregunta por el nombre del negocio y no por el id: revocarle la
     * credencial al cliente equivocado lo deja sin poder mandar pedidos y sin
     * ninguna señal de por qué.
     */
    if (!window.confirm(
      `Cortar el puente de ${fila.negocio.nombre}?\n\n`
      + "El portal deja de poder mandar pedidos en el momento. "
      + "Para volver a conectarlo hay que emitir una credencial nueva y cargarla allá.",
    )) return;
    try {
      await api.revocarIntegracion(fila.id);
      await cargar();
    } catch (e) { setError(mensajeDe(e)); }
  }

  const activas = (integraciones || []).filter((i) => i.activa);

  return (
    <div>
      <PageHead
        titulo="Integraciones"
        bajada="Las credenciales con las que un sistema de afuera le escribe a un negocio. El token se muestra una sola vez."
        acciones={
          <div className="flex items-center gap-2">
            <button onClick={cargar} disabled={cargando} className="btn-ghost gap-1.5 text-sm">
              <RefreshCw size={14} className={cargando ? "animate-spin" : ""} /> Actualizar
            </button>
            <button onClick={() => { setBusinessId(""); setAbrirAlta(true); }} className="btn-primary gap-1.5 text-sm">
              <Plug size={14} /> Conectar un negocio
            </button>
          </div>
        }
      />

      {error && <Aviso tono="error">{error}</Aviso>}

      {integraciones === null ? (
        <Cargando />
      ) : integraciones.length === 0 ? (
        <Card>
          <Vacio>Todavía no hay ninguna integración conectada.</Vacio>
        </Card>
      ) : (
        <Card className="p-0">
          <Tabla
            cabeceras={["Negocio", "Qué se conectó", "Credencial", "Último pedido que mandó", "Por revisar", ""]}
            min="min-w-[980px]"
          >
            {integraciones.map((f) => (
              <tr key={f.id} className={`border-b border-line last:border-0 ${f.activa ? "" : "opacity-50"}`}>
                <td className="px-4 py-3">
                  <p className="font-medium text-text">{f.negocio?.nombre || "—"}</p>
                  <p className="text-xs text-dim">{f.negocio?.email || ""}</p>
                </td>
                <td className="px-4 py-3">
                  <p className="text-sm text-text">
                    {ORIGENES.find((o) => o.valor === f.origen)?.etiqueta || f.origen}
                  </p>
                  {f.nombre && <p className="text-xs text-dim">{f.nombre}</p>}
                </td>
                <td className="px-4 py-3">
                  {f.activa
                    ? <span className="chip chip-ok">activa</span>
                    : <span className="chip chip-mute">revocada</span>}
                  <p className="mt-1 font-mono text-xs text-faint">···{f.pista}</p>
                </td>
                <td className="px-4 py-3 text-sm"><CuandoSeUso fecha={f.ultimoUsoEn} /></td>
                <td className="px-4 py-3 text-sm">
                  {/*
                    * Pedidos esperando que el cliente los mire en SU panel. Que
                    * se acumulen no es un problema de la conexión, pero es lo
                    * que se necesita saber para levantar el teléfono.
                    */}
                  {f.pedidosPorRevisar > 0
                    ? <span className={f.pedidosPorRevisar >= 5 ? "font-medium text-warn" : "text-text"}>{f.pedidosPorRevisar}</span>
                    : <span className="text-faint">—</span>}
                </td>
                <td className="px-4 py-3 text-right">
                  {f.activa && (
                    <button onClick={() => revocar(f)} className="btn-ghost gap-1.5 text-sm text-crit">
                      <Power size={14} /> Revocar
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </Tabla>
        </Card>
      )}

      <Card className="mt-5">
        <h3 className="mb-1 text-base font-semibold text-text">Cómo se conecta un negocio</h3>
        <p className="mb-4 text-xs text-dim">
          Son dos pasos y el segundo es del otro lado. {activas.length > 0 && `Hoy hay ${activas.length} conectado${activas.length === 1 ? "" : "s"}.`}
        </p>
        <ol className="space-y-3">
          <li className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface2 text-[11px] font-semibold text-text">1</span>
            <div className="min-w-0">
              <p className="text-sm text-text">Acá: «Conectar un negocio», elegir cuál, y copiar el token.</p>
              <p className="mt-1 flex items-start gap-1.5 text-xs text-dim">
                <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warn" />
                <span>Se muestra una sola vez. Si se pierde hay que emitir otro, y eso apaga el anterior.</span>
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface2 text-[11px] font-semibold text-text">2</span>
            <div className="min-w-0">
              <p className="text-sm text-text">
                En el portal: <span className="font-mono text-xs">STOCKER_TOKEN</span> con ese valor y{" "}
                <span className="font-mono text-xs">STOCKER_URL</span> apuntando al backend.
              </p>
              <p className="mt-1 text-xs text-dim">
                El negocio sale del token, no de la configuración de allá: una credencial no puede escribirle a otro cliente.
              </p>
            </div>
          </li>
        </ol>
      </Card>

      {/* ── Emitir ────────────────────────────────────────────── */}
      <Modal open={abrirAlta} onClose={() => setAbrirAlta(false)} titulo="Conectar un negocio">
        <div className="space-y-4">
          <Campo etiqueta="Negocio">
            <select className="input w-full" value={businessId} onChange={(e) => setBusinessId(e.target.value)}>
              <option value="">Elegí una cuenta…</option>
              {cuentas.map((c) => (
                <option key={c.id} value={c.id}>{c.nombreNegocio || c.nombre} · {c.email}</option>
              ))}
            </select>
          </Campo>
          <Campo etiqueta="Qué se conecta">
            <select className="input w-full" value={origen} onChange={(e) => setOrigen(e.target.value)}>
              {ORIGENES.map((o) => <option key={o.valor} value={o.valor}>{o.etiqueta}</option>)}
            </select>
          </Campo>
          {/*
            * El aviso va ANTES del botón: si ese negocio ya tenía una credencial,
            * emitir la apaga y el portal deja de mandar pedidos hasta que carguen
            * la nueva. Decirlo después es decirlo tarde.
            */}
          {businessId && activas.some((i) => String(i.negocio?.id) === String(businessId) && i.origen === origen) && (
            <Aviso tono="error">
              Ese negocio ya tiene una credencial activa para esto. Emitir una nueva la apaga: el portal
              deja de poder mandar pedidos hasta que carguen la nueva.
            </Aviso>
          )}
          <div className="flex justify-end gap-2">
            <button className="btn-ghost text-sm" onClick={() => setAbrirAlta(false)}>Cancelar</button>
            <button className="btn-primary text-sm" disabled={!businessId || emitiendo} onClick={emitir}>
              {emitiendo ? "Emitiendo…" : "Emitir credencial"}
            </button>
          </div>
        </div>
      </Modal>

      {/* ── El token, una sola vez ────────────────────────────── */}
      <Modal open={Boolean(reciénEmitida)} onClose={() => setReciénEmitida(null)} titulo="Copiá el token ahora" ancho="max-w-xl">
        {reciénEmitida && (
          <div className="space-y-4">
            <Aviso tono="error">
              Esto no se vuelve a mostrar. Si se pierde, hay que emitir otro y cargarlo de nuevo del otro lado.
            </Aviso>

            <div>
              <p className="mb-1 text-xs uppercase tracking-wide text-dim">
                Para {reciénEmitida.integracion?.negocio?.nombre}
              </p>
              <div className="flex items-start gap-2 rounded-[3px] border border-line bg-surface2 p-3">
                <code className="min-w-0 flex-1 break-all font-mono text-sm text-text">{reciénEmitida.token}</code>
                <Copiable valor={reciénEmitida.token} etiqueta="Copiar token" />
              </div>
            </div>

            {reciénEmitida.reemplaza && (
              <Aviso tono="info">
                Se apagó la credencial anterior (···{reciénEmitida.reemplaza.pista}). Desde este momento el
                portal no puede mandar pedidos hasta que carguen la nueva.
              </Aviso>
            )}

            <div>
              <p className="mb-1 text-xs uppercase tracking-wide text-dim">Las líneas, listas para pegar allá</p>
              <div className="flex items-start gap-2 rounded-[3px] border border-line bg-surface2 p-3">
                <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-xs text-dim">
{`STOCKER_TOKEN=${reciénEmitida.token}
STOCKER_URL=https://TU-DOMINIO/api`}
                </pre>
                <Copiable
                  valor={`STOCKER_TOKEN=${reciénEmitida.token}\nSTOCKER_URL=https://TU-DOMINIO/api`}
                  etiqueta="Copiar las dos"
                />
              </div>
              <p className="mt-1 text-xs text-dim">
                La dirección tiene que terminar en <span className="font-mono">/api</span>, o ser la interna del
                backend si están en el mismo proyecto.
              </p>
            </div>

            <div className="flex justify-end">
              <button className="btn-primary text-sm" onClick={() => setReciénEmitida(null)}>Ya lo copié</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
