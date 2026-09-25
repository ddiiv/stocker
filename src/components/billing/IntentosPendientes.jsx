import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { fetchIntentosArca, resolverIntentoArca } from "../../services/invoiceService";
import { formatCurrency, formatDateTime } from "../../utils/formatters";
import { mensajeDeError } from "../../utils/errores";

/*
 * Pedidos de CAE que quedaron sin resolver.
 *
 * Es lo único del circuito que una máquina no puede cerrar sola: se le pidió
 * un CAE a ARCA, se cortó la conexión, y después tampoco se pudo averiguar si
 * había quedado autorizado. Reintentar sin saber es exactamente cómo se
 * duplica una factura, así que la decisión la toma una persona.
 *
 * ── Por qué está acá arriba y no en una pantalla aparte ──────────
 *
 * Porque pasa poco y hay que verlo cuando pasa. Un aviso escondido en un menú
 * es un aviso que nadie mira: el problema sólo existiría en una tabla, que es
 * exactamente donde estaba antes de esto.
 */
export default function IntentosPendientes() {
  const [intentos, setIntentos] = useState([]);
  const [resolviendo, setResolviendo] = useState(null);
  const [aviso, setAviso] = useState("");
  const [error, setError] = useState("");

  async function cargar() {
    try { setIntentos(await fetchIntentosArca()); } catch { /* no es lo importante de la pantalla */ }
  }
  useEffect(() => { cargar(); }, []);

  async function resolver(intento) {
    setResolviendo(intento.id); setError(""); setAviso("");
    try {
      const r = await resolverIntentoArca(intento.id);
      setAviso(r.mensaje || `Quedó ${r.estado}.`);
      await cargar();
    } catch (e) {
      setError(mensajeDeError(e, "AFIP no contestó. El pendiente queda como estaba."));
    } finally { setResolviendo(null); }
  }

  if (!intentos.length) return null;

  return (
    <div className="mb-5 rounded-md border border-brass-500 bg-brass-50/60 px-4 py-3">
      <p className="mb-1 flex items-center gap-2 font-medium text-ink-950">
        <AlertTriangle size={15} className="text-brass-600" />
        {intentos.length === 1
          ? "Hay un pedido de comprobante sin resolver"
          : `Hay ${intentos.length} pedidos de comprobante sin resolver`}
      </p>
      <p className="mb-3 text-sm text-ink-700">
        Se le pidió un CAE a ARCA y no se pudo averiguar si quedó autorizado. No se emite nada de
        nuevo por las dudas: emitir sin saber deja dos comprobantes por una venta.
      </p>

      {aviso && <p className="mb-2 rounded border border-teal-500 bg-teal-50 px-3 py-2 text-sm text-teal-700">{aviso}</p>}
      {error && <p className="mb-2 rounded border border-brick-500 bg-brick-50 px-3 py-2 text-sm text-brick-700">{error}</p>}

      <ul className="space-y-2">
        {intentos.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-line bg-paper-50 px-3 py-2 text-sm">
            <div className="min-w-0">
              {/*
                * Los tres datos con los que se busca en AFIP, juntos: punto de
                * venta, tipo y número. Es lo que hay que tipear allá.
                */}
              <p className="text-ink-900">
                Punto de venta <span className="font-mono">{i.comprobante.ptoVta}</span> · tipo{" "}
                <span className="font-mono">{i.comprobante.cbteTipo}</span> · número{" "}
                <span className="font-mono">{i.comprobante.numero}</span>
                {i.total > 0 && <> · {formatCurrency(i.total)}</>}
              </p>
              <p className="text-xs text-ink-500">
                {formatDateTime(i.desde)}
                {i.comprobante.ambiente !== "produccion" && " · homologación"}
                {i.error && ` · ${i.error}`}
              </p>
              {/*
                * Si la venta terminó facturada igual, este pendiente es viejo:
                * alguien reintentó y salió bien. Decirlo ahorra ir a mirar AFIP.
                */}
              {i.ventaYaFacturada && (
                <p className="text-xs text-teal-600">
                  La venta quedó facturada igual ({i.ventaYaFacturada}): esto es un pendiente viejo.
                </p>
              )}
            </div>
            <button
              className="btn-ghost text-sm"
              disabled={resolviendo === i.id}
              onClick={() => resolver(i)}
            >
              {resolviendo === i.id
                ? <Loader2 size={14} className="animate-spin" />
                : <RefreshCw size={14} />}
              Preguntarle a ARCA
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
