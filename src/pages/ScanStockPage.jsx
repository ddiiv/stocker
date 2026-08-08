import { useEffect, useRef, useState } from "react";
import {
  ScanLine, Plus, Minus, Hash, Play, Square, Trash2,
  CheckCircle2, XCircle,
} from "lucide-react";
import { scanAdjustStock } from "../services/productService";
import { useBarcodeScanner } from "../hooks/useBarcodeScanner";
import { PageHeader, Card } from "../components/ui/Layout";
import StockTabs from "../components/stock/StockTabs";

const MODOS = [
  { value: "agregar", label: "Agregar",  icon: Plus,  desc: "Suma al stock actual. Para recepción de mercadería.", color: "teal" },
  { value: "quitar",  label: "Quitar",   icon: Minus, desc: "Resta del stock actual. Para bajas o roturas.",       color: "brick" },
  { value: "fijar",   label: "Fijar en", icon: Hash,  desc: "Reemplaza el stock. Para conteo de inventario.",      color: "brass" },
];

export default function ScanStockPage() {
  const [modo, setModo] = useState("agregar");
  const [cantidad, setCantidad] = useState(1);
  const [motivo, setMotivo] = useState("");
  const [escaneando, setEscaneando] = useState(false);
  const [historial, setHistorial] = useState([]);
  const [error, setError] = useState("");
  const inputRef = useRef(null);
  // El modo y la cantidad se leen dentro del callback del scanner, que vive en
  // una ref: sin esto tomaría los valores del primer render.
  const config = useRef({ modo, cantidad, motivo });
  useEffect(() => { config.current = { modo, cantidad, motivo }; }, [modo, cantidad, motivo]);

  async function procesarCodigo(codigo) {
    const { modo: m, cantidad: c, motivo: mo } = config.current;
    setError("");
    try {
      const r = await scanAdjustStock({ codigo, modo: m, cantidad: Number(c) || 1, motivo: mo });
      setHistorial((h) => [{ ...r, codigo, modo: m, ok: true, at: Date.now() }, ...h]);
      // Feedback sonoro: confirma la lectura sin mirar la pantalla.
      beep(880, 80);
    } catch (e) {
      const msg = e.response?.data?.message || "Error al procesar el código";
      setHistorial((h) => [{ codigo, ok: false, error: msg, at: Date.now() }, ...h]);
      setError(msg);
      beep(220, 220);
    }
  }

  useBarcodeScanner({ onScan: procesarCodigo, activo: escaneando });

  useEffect(() => { if (escaneando) inputRef.current?.focus(); }, [escaneando]);

  // Alta manual, para cuando el código no se lee o no hay lector a mano.
  function submitManual(e) {
    e.preventDefault();
    const codigo = inputRef.current?.value?.trim();
    if (!codigo) return;
    procesarCodigo(codigo);
    inputRef.current.value = "";
  }

  const exitosos = historial.filter((h) => h.ok);
  const fallidos = historial.filter((h) => !h.ok);
  const unidadesTotales = exitosos.reduce((s, h) => s + Math.abs(h.delta || 0), 0);

  return (
    <div>
      <PageHeader title="Stock" subtitle="Carga masiva con lector de código de barras" />
      <StockTabs />

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Configuración */}
        <div className="space-y-5 lg:col-span-1">
          <Card>
            <p className="mb-3 font-display text-sm font-semibold text-ink-950">1. Qué hacer con cada lectura</p>
            <div className="space-y-2">
              {MODOS.map((m) => {
                const Icon = m.icon;
                const activo = modo === m.value;
                return (
                  <button
                    key={m.value}
                    type="button"
                    disabled={escaneando}
                    onClick={() => setModo(m.value)}
                    className={`w-full rounded-md border px-3 py-2 text-left transition ${
                      activo ? "border-ink-950 bg-ink-950 text-paper-50" : "border-line bg-paper-50 hover:bg-paper-100"
                    } ${escaneando ? "cursor-not-allowed opacity-60" : ""}`}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium"><Icon size={15} /> {m.label}</span>
                    <span className={`mt-0.5 block text-xs ${activo ? "text-paper-200" : "text-ink-500"}`}>{m.desc}</span>
                  </button>
                );
              })}
            </div>

            <div className="mt-4">
              <label className="label">Cantidad por lectura</label>
              <input
                type="number" min={modo === "fijar" ? 0 : 1} className="input"
                value={cantidad} disabled={escaneando}
                onChange={(e) => setCantidad(e.target.value)}
              />
              <p className="mt-1 text-xs text-ink-500">
                {modo === "fijar"
                  ? "Cada producto escaneado queda con esta cantidad exacta."
                  : `Cada lectura ${modo === "agregar" ? "suma" : "resta"} esta cantidad.`}
              </p>
            </div>

            <div className="mt-4">
              <label className="label">Motivo <span className="font-normal text-ink-500">(opcional)</span></label>
              <input className="input" value={motivo} disabled={escaneando}
                onChange={(e) => setMotivo(e.target.value)} placeholder="Ej: Remito 1234" />
            </div>
          </Card>

          <Card>
            <p className="mb-3 font-display text-sm font-semibold text-ink-950">2. Escanear</p>
            {!escaneando ? (
              <button className="btn-accent w-full justify-center" onClick={() => { setEscaneando(true); setError(""); }}>
                <Play size={15} /> Empezar a escanear
              </button>
            ) : (
              <button className="btn-ghost w-full justify-center border border-brick-300 text-brick-500" onClick={() => setEscaneando(false)}>
                <Square size={15} /> Detener
              </button>
            )}

            {escaneando && (
              <>
                <div className="mt-4 flex items-center gap-2 rounded-md bg-teal-50 px-3 py-2 text-sm text-teal-700">
                  <ScanLine size={16} className="animate-pulse" />
                  Listo — gatillá el lector
                </div>
                <form onSubmit={submitManual} className="mt-3">
                  <label className="label">O ingresá el código a mano</label>
                  <input ref={inputRef} data-scanner="true" className="input font-mono" placeholder="Código o SKU" autoComplete="off" />
                </form>
              </>
            )}
          </Card>
        </div>

        {/* Historial */}
        <div className="lg:col-span-2">
          {error && (
            <p className="mb-4 flex items-center gap-2 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">
              <XCircle size={15} /> {error}
            </p>
          )}

          <div className="mb-4 grid grid-cols-3 gap-3">
            <Card><p className="text-xs uppercase tracking-wide text-ink-600">Lecturas OK</p><p className="mt-1 font-display text-2xl font-semibold text-teal-600">{exitosos.length}</p></Card>
            <Card><p className="text-xs uppercase tracking-wide text-ink-600">Unidades</p><p className="mt-1 font-display text-2xl font-semibold">{unidadesTotales}</p></Card>
            <Card><p className="text-xs uppercase tracking-wide text-ink-600">Con error</p><p className={`mt-1 font-display text-2xl font-semibold ${fallidos.length ? "text-brick-500" : ""}`}>{fallidos.length}</p></Card>
          </div>

          <Card className="p-0">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <p className="font-display text-sm font-semibold text-ink-950">Historial de la sesión</p>
              {historial.length > 0 && (
                <button className="btn-ghost text-xs" onClick={() => setHistorial([])}><Trash2 size={13} /> Limpiar</button>
              )}
            </div>
            {historial.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-ink-600">
                Todavía no escaneaste nada. Elegí el modo, apretá «Empezar a escanear» y gatillá el lector.
              </p>
            ) : (
              <div className="max-h-[520px] overflow-y-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {historial.map((h) => (
                      <tr key={h.at + h.codigo} className="border-b border-line last:border-0">
                        <td className="px-4 py-2 w-8">
                          {h.ok ? <CheckCircle2 size={16} className="text-teal-600" /> : <XCircle size={16} className="text-brick-500" />}
                        </td>
                        <td className="px-2 py-2">
                          {h.ok ? (
                            <>
                              <p className="text-ink-900">{h.titulo}</p>
                              <p className="text-xs text-ink-500">
                                <span className="tag-chip">{h.sku}</span>
                                {h.variante && <span className="ml-1">{h.variante}</span>}
                              </p>
                            </>
                          ) : (
                            <>
                              <p className="text-brick-500">{h.error}</p>
                              <p className="font-mono text-xs text-ink-500">{h.codigo}</p>
                            </>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right whitespace-nowrap">
                          {h.ok && (
                            <>
                              <span className="text-xs text-ink-500">{h.stockAnterior} →</span>{" "}
                              <span className="font-display font-semibold text-ink-900">{h.stockNuevo}</span>
                              <span className={`ml-2 text-xs font-medium ${h.delta > 0 ? "text-teal-600" : h.delta < 0 ? "text-brick-500" : "text-ink-500"}`}>
                                {h.delta > 0 ? `+${h.delta}` : h.delta}
                              </span>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

// Pitido corto vía WebAudio: confirma la lectura sin depender de archivos.
function beep(frecuencia, duracionMs) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = frecuencia;
    gain.gain.value = 0.08;
    osc.start();
    setTimeout(() => { osc.stop(); ctx.close(); }, duracionMs);
  } catch { /* audio bloqueado por el navegador, no es crítico */ }
}
