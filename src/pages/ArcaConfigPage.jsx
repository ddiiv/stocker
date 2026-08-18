import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  ArrowLeft, CheckCircle2, XCircle, ExternalLink, Copy, RefreshCw,
  ShieldCheck, AlertCircle, Info, Store, KeyRound, HelpCircle,
} from "lucide-react";
import { PageHeader, Card } from "../components/ui/Layout";
import Modal from "../components/ui/Modal";
import { getArcaConfig, saveArcaConfig, verifyArcaDelegation, getArcaStatus } from "../services/arcaConfigService";

const CONDICIONES = [
  "Responsable Inscripto",
  "Monotributo",
  "Exento",
];

export default function ArcaConfigPage() {
  const { cuitId } = useParams();
  const [data, setData] = useState(null);
  const [health, setHealth] = useState(null);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState(null);
  const [error, setError] = useState("");
  const [puntoVenta, setPuntoVenta] = useState("");
  const [condicionIva, setCondicionIva] = useState("");
  const [ambiente, setAmbiente] = useState("homologacion");
  const [showHelp, setShowHelp] = useState(false);

  async function load() {
    setError("");
    try {
      const d = await getArcaConfig(cuitId);
      setData(d);
      setPuntoVenta(d.config?.puntoVenta ?? "");
      setCondicionIva(d.config?.condicionIva || d.cuit?.condicionIva || "");
      setAmbiente(d.config?.ambiente || "homologacion");
      const h = await getArcaStatus(d.config?.ambiente || "homologacion");
      setHealth(h);
    } catch (e) {
      setError(e.response?.data?.message || "Error al cargar la configuración");
    }
  }
  useEffect(() => { load(); }, [cuitId]);

  async function handleSave() {
    setSaving(true);
    try {
      await saveArcaConfig(cuitId, { puntoVenta: puntoVenta || null, condicionIva, ambiente });
      await load();
    } catch (e) { setError(e.response?.data?.message || "Error al guardar"); }
    finally { setSaving(false); }
  }

  async function handleVerify() {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await verifyArcaDelegation(cuitId);
      setVerifyResult(res);
      await load();
    } catch (e) { setError(e.response?.data?.message || "Error al verificar"); }
    finally { setVerifying(false); }
  }

  if (!data) return <div className="card h-64 animate-pulse bg-paper-200/60" />;

  const stockerCuit = data.stockerCuit || "(sin configurar en el servidor)";
  const cuit = data.cuit;
  const config = data.config;
  const puntoVentaMatchesArca =
    verifyResult?.ok && verifyResult.puntosVenta?.some((pv) => Number(pv.Nro) === Number(config?.puntoVenta));

  return (
    <div>
      <Link to="/facturacion/cuits" className="mb-4 inline-flex items-center gap-1 text-sm text-ink-600 hover:text-ink-950">
        <ArrowLeft size={15} /> Volver a CUITs
      </Link>
      <PageHeader
        title={`Configurar ARCA · ${cuit.nombre}`}
        subtitle={`Activar facturación electrónica para el CUIT ${cuit.cuit}`}
        actions={
          <button className="btn-ghost" onClick={() => setShowHelp(true)}>
            <HelpCircle size={15} /> ¿Cómo funciona?
          </button>
        }
      />

      {error && <p className="mb-4 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}

      {/* Estado global del servicio */}
      <div className={`mb-6 rounded-md border px-4 py-3 text-sm ${health?.ok ? "border-teal-500 bg-teal-50 text-teal-600" : "border-line bg-paper-100 text-ink-700"}`}>
        {data.mockMode ? (
          <><strong>⚠ Modo MOCK activo</strong> — los CAE se generan simulados sin llamar a AFIP. Este panel valida flujos pero no emite facturas reales. Cuando Stocker esté configurado con el certificado real, tocás el switch a producción.</>
        ) : health?.ok ? (
          <>✓ Servicio ARCA responde OK ({health.ambiente}). Certificado de Stocker configurado y funcionando.</>
        ) : (
          <>✗ Servicio ARCA no responde. {health?.error || "Verificá certificado en el servidor."}</>
        )}
      </div>

      {/* Explicación rápida del modelo */}
      <div className="mb-6 rounded-md border border-brass-500/40 bg-brass-50/50 px-4 py-3 text-sm text-ink-700">
        <p className="mb-1 flex items-center gap-1 font-medium text-ink-950"><Info size={14} /> ¿Qué hago acá?</p>
        <p>Vas a autorizar a Stocker a emitir facturas <strong>a tu nombre</strong> ante AFIP.
        Nosotros ponemos el certificado y firma; vos ponés el CUIT y el punto de venta.
        Solo necesitás hacer 2 clicks en AFIP una única vez (pasos <strong>1</strong> y <strong>2</strong> abajo).</p>
      </div>

      {/* ═══════════════════ PASOS EN AFIP ═══════════════════ */}
      <p className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-600">Lo que hacés en AFIP (una única vez, ~5 min)</p>

      <div className="mb-6 grid gap-5 lg:grid-cols-2">
        {/* Paso 1 — crear PdV Web Services */}
        <Card>
          <div className="mb-3 flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brass-500 text-xs font-bold text-ink-950">1</span>
            <Store size={16} className="text-brass-600" />
            <h3 className="font-display text-base font-semibold text-ink-950">Crear Punto de Venta electrónico</h3>
          </div>
          <p className="mb-3 text-sm text-ink-700">
            Entrá a{" "}
            <a className="text-brass-600 hover:underline inline-flex items-center gap-1" href="https://auth.afip.gob.ar/contribuyente_/login.xhtml" target="_blank" rel="noreferrer">
              AFIP con Clave Fiscal <ExternalLink size={11} />
            </a>{" "}
            → buscá el servicio <strong>Administración de puntos de venta y domicilios</strong> → tocá <strong>A/B/M de puntos de venta</strong> → <strong>Agregar</strong>.
          </p>
          <p className="rounded-md border border-brass-500 bg-brass-50 px-3 py-2 text-xs text-ink-900">
            <strong>Importante:</strong> el tipo debe ser <strong>"Web Services"</strong>
            <span className="text-ink-600"> (o "Factura Electrónica - Monotributo - Web Services" si sos monotributista). </span>
            <br />Anotate el número que te asigna AFIP (ej. <span className="font-mono">0001</span>) — lo vas a necesitar abajo.
          </p>
        </Card>

        {/* Paso 2 — Delegar wsfe */}
        <Card>
          <div className="mb-3 flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brass-500 text-xs font-bold text-ink-950">2</span>
            <KeyRound size={16} className="text-brass-600" />
            <h3 className="font-display text-base font-semibold text-ink-950">Delegar el servicio wsfe a Stocker</h3>
          </div>
          <p className="mb-3 text-sm text-ink-700">
            En el mismo portal → <strong>Administrador de Relaciones de Clave Fiscal</strong> → seleccioná tu CUIT → <strong>Nueva Relación</strong>.
          </p>
          <ul className="mb-3 space-y-1 text-sm text-ink-700">
            <li><strong>Servicio:</strong> AFIP → Web Services → <strong>Facturación Electrónica (wsfe)</strong></li>
            <li><strong>Representante:</strong> ingresá el CUIT de Stocker (abajo)</li>
          </ul>
          <div className="rounded-md border border-line bg-paper-100 px-3 py-2 text-sm">
            <p className="text-xs uppercase tracking-wide text-ink-600">CUIT de Stocker (copiar y pegar en AFIP)</p>
            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="font-mono text-base font-semibold text-ink-950">{stockerCuit}</span>
              <button
                className="btn-ghost px-2 py-1"
                onClick={() => navigator.clipboard.writeText(String(stockerCuit).replace(/\D/g, "")).then(() => alert("CUIT copiado"))}
                disabled={stockerCuit.startsWith("(")}
              >
                <Copy size={13} /> Copiar
              </button>
            </div>
          </div>
        </Card>
      </div>

      {/* ═══════════════════ CONFIG EN STOCKER ═══════════════════ */}
      <p className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-600">Configuración en Stocker</p>

      <div className="mb-6 grid gap-5 lg:grid-cols-3">
        {/* Paso 3 — cargar en Stocker */}
        <Card className="lg:col-span-2">
          <div className="mb-3 flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brass-500 text-xs font-bold text-ink-950">3</span>
            <h3 className="font-display text-base font-semibold text-ink-950">Punto de venta y condición IVA</h3>
          </div>
          <p className="mb-3 text-sm text-ink-700">Ingresá el número de Punto de Venta que te dio AFIP en el paso 1, y tu condición frente al IVA.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Punto de Venta (nro) *</label>
              <input
                className="input font-mono"
                type="number"
                min="1"
                max="99999"
                step="1"
                inputMode="numeric"
                value={puntoVenta}
                onChange={(e) => setPuntoVenta(e.target.value.replace(/\D/g, "").slice(0, 5))}
                placeholder="1"
              />
            </div>
            <div>
              <label className="label">Condición IVA</label>
              <select className="input" value={condicionIva} onChange={(e) => setCondicionIva(e.target.value)}>
                <option value="">— Elegir —</option>
                {CONDICIONES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Ambiente</label>
              <select className="input" value={ambiente} onChange={(e) => setAmbiente(e.target.value)}>
                <option value="homologacion">Homologación (test)</option>
                <option value="produccion">Producción (real)</option>
              </select>
              <p className="mt-1 text-xs text-ink-500">Empezá en Homologación para probar sin emitir facturas reales.</p>
            </div>
            <div className="self-end">
              <button className="btn-accent w-full" onClick={handleSave} disabled={saving}>{saving ? "Guardando…" : "Guardar configuración"}</button>
            </div>
          </div>
        </Card>

        {/* Estado actual */}
        <Card>
          <div className="mb-3 flex items-center gap-2">
            <ShieldCheck size={18} className={config?.delegacionVerificada ? "text-teal-500" : "text-ink-400"} />
            <h3 className="font-display text-sm font-semibold text-ink-950">Estado actual</h3>
          </div>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between"><dt className="text-ink-600">Punto de venta</dt><dd className="font-mono text-ink-900">{config?.puntoVenta || "—"}</dd></div>
            <div className="flex justify-between"><dt className="text-ink-600">Ambiente</dt><dd className="text-ink-900">{config?.ambiente || "—"}</dd></div>
            <div className="flex justify-between"><dt className="text-ink-600">Delegación</dt>
              <dd>{config?.delegacionVerificada ? <span className="badge badge-ok">Verificada</span> : <span className="badge badge-low">Sin verificar</span>}</dd>
            </div>
            {config?.ultimaVerificacion && (
              <div className="flex justify-between"><dt className="text-ink-600">Última prueba</dt>
                <dd className="text-xs text-ink-500">{new Date(config.ultimaVerificacion).toLocaleString("es-AR")}</dd></div>
            )}
            {config?.ultimoError && (
              <div className="mt-2 flex items-start gap-1 rounded-md bg-brick-50 px-2 py-1 text-xs text-brick-500">
                <AlertCircle size={12} className="mt-0.5 shrink-0" />
                <span>{config.ultimoError}</span>
              </div>
            )}
          </dl>
        </Card>
      </div>

      {/* ═══════════════════ VERIFICAR ═══════════════════ */}
      <Card>
        <div className="mb-3 flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brass-500 text-xs font-bold text-ink-950">4</span>
          <h3 className="font-display text-base font-semibold text-ink-950">Verificar delegación con AFIP</h3>
        </div>
        <p className="mb-3 text-sm text-ink-700">Le preguntamos a AFIP si tu CUIT ya nos delegó el servicio wsfe y si el punto de venta existe. Es una prueba de conectividad, no emite ninguna factura.</p>
        <button className="btn-accent" onClick={handleVerify} disabled={verifying || !config?.puntoVenta}>
          <RefreshCw size={15} className={verifying ? "animate-spin" : ""} /> {verifying ? "Verificando…" : "Verificar ahora"}
        </button>
        {!config?.puntoVenta && <p className="mt-2 text-xs text-ink-500">Primero completá y guardá el punto de venta.</p>}

        {/* Delegación OK y punto de venta dado de alta son dos cosas: con la
            primera sola AFIP contesta, pero facturar todavía falla. */}
        {verifyResult && (
          <div className={`mt-4 rounded-md border px-4 py-3 text-sm ${
            !verifyResult.ok ? "border-brick-500 bg-brick-50"
            : verifyResult.listoParaFacturar === false ? "border-brass-500 bg-brass-50"
            : "border-teal-500 bg-teal-50"
          }`}>
            {verifyResult.ok ? (
              <>
                <div className={`flex items-start gap-2 ${verifyResult.listoParaFacturar === false ? "text-brass-700" : "text-teal-600"}`}>
                  {verifyResult.listoParaFacturar === false
                    ? <AlertCircle size={16} className="mt-0.5" />
                    : <CheckCircle2 size={16} className="mt-0.5" />}
                  <div>
                    <p className="font-medium">
                      {verifyResult.listoParaFacturar === false
                        ? "Falta dar de alta el punto de venta"
                        : "Todo listo para facturar ✓"}
                    </p>
                    <p className="text-xs mt-1">
                      {verifyResult.advertencia
                        || `ARCA confirma que Stocker puede facturar en nombre de ${cuit.cuit}.`} Ambiente: <strong>{verifyResult.ambiente}</strong>.
                    </p>
                  </div>
                </div>

                {/* Los pasos exactos del alta en AFIP: es el trámite que más
                    consultas genera y sin él la facturación no arranca. */}
                {verifyResult.pasos?.length > 0 && (
                  <ol className="mt-3 space-y-1 rounded-md border border-line bg-paper-50 px-3 py-2 text-xs text-ink-700">
                    {verifyResult.pasos.map((paso, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="font-mono text-ink-400">{i + 1}.</span>
                        <span>{paso}</span>
                      </li>
                    ))}
                  </ol>
                )}
                {/* Lo que AFIP contestó, cuando no devolvió ningún punto de
                    venta y tampoco explicó por qué. Es feo a propósito: sin
                    esto, la pantalla afirma un diagnóstico que no puede
                    sostener, y el usuario rehace un trámite que ya hizo. */}
                {verifyResult.respuestaAfip && (
                  <details className="mt-3 rounded-md border border-line bg-paper-100 px-3 py-2">
                    <summary className="cursor-pointer text-xs text-ink-600">Qué contestó AFIP exactamente</summary>
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] text-ink-700">
                      {verifyResult.respuestaAfip}
                    </pre>
                  </details>
                )}

                {verifyResult.erroresAfip?.length > 0 && (
                  <ul className="mt-3 space-y-1">
                    {verifyResult.erroresAfip.map((e) => (
                      <li key={e.codigo} className="rounded-md bg-brick-50 px-3 py-2 text-xs text-brick-600">
                        <span className="font-mono">AFIP {e.codigo}</span> · {e.mensaje}
                      </li>
                    ))}
                  </ul>
                )}

                {verifyResult.puntosVenta?.length > 0 && (
                  <div className="mt-3 rounded-md bg-paper-50 border border-line px-3 py-2 text-ink-700">
                    <p className="text-xs uppercase tracking-wide text-ink-600 mb-1">Puntos de venta electrónicos que AFIP ve en tu CUIT:</p>
                    <ul className="text-xs">
                      {verifyResult.puntosVenta.map((pv) => (
                        <li key={pv.Nro} className="flex items-center gap-2 py-0.5">
                          <span className={`inline-block h-2 w-2 rounded-full ${Number(pv.Nro) === Number(config?.puntoVenta) ? "bg-teal-500" : "bg-ink-400"}`} />
                          <span className="font-mono">Nro {String(pv.Nro).padStart(4, "0")}</span>
                          {pv.EmisionTipo && <span className="text-ink-500">· {pv.EmisionTipo}</span>}
                          {/* El estado se muestra: un punto de venta bloqueado
                              figura en la lista y no sirve para facturar. */}
                          {pv.Bloqueado && <span className="text-brick-500">· bloqueado</span>}
                          {pv.FchBaja && <span className="text-brick-500">· dado de baja</span>}
                          {Number(pv.Nro) === Number(config?.puntoVenta) && <span className="ml-auto text-teal-600 font-medium">← el que configuraste</span>}
                        </li>
                      ))}
                    </ul>
                    {!puntoVentaMatchesArca && (
                      <p className="mt-2 flex items-start gap-1 text-xs text-brick-500">
                        <AlertCircle size={12} className="mt-0.5" />
                        El punto de venta que cargaste ({config?.puntoVenta}) NO aparece entre los de este CUIT
                        en <strong>{verifyResult.ambiente}</strong>. Si lo diste de alta en el otro ambiente, cambiá
                        el ambiente acá arriba: los de homologación y los de producción son listas separadas.
                      </p>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="flex items-start gap-2 text-brick-500">
                <XCircle size={16} className="mt-0.5" />
                <div>
                  {/* El ambiente va en el título del error y no sólo en el
                      detalle: casi todos los rechazos de AFIP se explican por
                      haber hecho el trámite en uno y consultar el otro, y sin
                      verlo acá hay que ir a buscarlo a la config. */}
                  <p className="font-medium">No verificado · ambiente {verifyResult.ambiente}</p>
                  <p className="text-xs mt-1"><strong>Error:</strong> {verifyResult.error}</p>
                  {verifyResult.hint && <p className="text-xs mt-1"><strong>Sugerencia:</strong> {verifyResult.hint}</p>}
                  {/* Las causas van numeradas y en orden: el rechazo de AFIP es
                      siempre el mismo mensaje para tres problemas distintos, y
                      sin separarlos se revisa el que ya estaba bien. */}
                  {verifyResult.causas?.length > 0 && (
                    <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs text-ink-700">
                      {verifyResult.causas.map((c, i) => <li key={i}>{c}</li>)}
                    </ol>
                  )}
                  {verifyResult.erroresAfip?.length > 1 && (
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {verifyResult.erroresAfip.map((e) => (
                        <li key={e.codigo}><span className="font-mono">AFIP {e.codigo}</span> · {e.mensaje}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Modal de ayuda */}
      <Modal open={showHelp} onClose={() => setShowHelp(false)} title="¿Cómo funciona la facturación con Stocker?" width="max-w-2xl">
        <div className="space-y-4 text-sm text-ink-700">
          <p>Stocker actúa como <strong>intermediario técnico</strong> entre tu negocio y AFIP. Vos seguís siendo el emisor legal de las facturas — nosotros solo firmamos técnicamente y enviamos el pedido.</p>

          <div className="rounded-md border border-line bg-paper-100 p-3">
            <p className="mb-2 font-medium text-ink-950">Flujo cuando emitís una factura</p>
            <ol className="list-inside list-decimal space-y-1 text-xs">
              <li>Cerrás una venta en Stocker y tocás "Generar factura".</li>
              <li>Nuestro servidor arma el XML de la factura con <strong>tu CUIT como emisor</strong> y <strong>tu punto de venta</strong>.</li>
              <li>Firmamos el pedido con el certificado de Stocker (paso técnico requerido por AFIP).</li>
              <li>AFIP recibe el XML, verifica que tu CUIT nos delegó el servicio wsfe, y emite el CAE a tu nombre.</li>
              <li>Guardamos el CAE + PDF en Stocker y te lo mostramos.</li>
            </ol>
          </div>

          <div className="rounded-md border border-line bg-paper-100 p-3">
            <p className="mb-2 font-medium text-ink-950">Ventajas del modelo</p>
            <ul className="list-inside list-disc space-y-1 text-xs">
              <li><strong>Cero mantenimiento de certificados</strong>: vos no generás, subís ni renovás ningún .crt/.key.</li>
              <li><strong>Nunca pedimos tu Clave Fiscal</strong> — ni la guardamos.</li>
              <li><strong>Revocación limpia</strong>: si dejás de usar Stocker, quitás la delegación desde AFIP en 30 segundos y listo.</li>
              <li><strong>Auditabilidad</strong>: en AFIP queda registro de que Stocker es el representante autorizado.</li>
            </ul>
          </div>

          <div className="rounded-md border border-line bg-paper-100 p-3">
            <p className="mb-2 font-medium text-ink-950">Preguntas frecuentes</p>
            <div className="space-y-2 text-xs">
              <div>
                <p className="font-medium text-ink-900">¿Las facturas salen a mi nombre o a Stocker?</p>
                <p className="text-ink-600">A tu nombre. Stocker es solo el intermediario técnico; el CUIT emisor es siempre el tuyo.</p>
              </div>
              <div>
                <p className="font-medium text-ink-900">¿Puedo dejar de usar Stocker?</p>
                <p className="text-ink-600">Sí. En AFIP → Administrador de Relaciones → sacás la delegación wsfe hacia nuestro CUIT y desde ese momento no podemos emitir más facturas a tu nombre.</p>
              </div>
              <div>
                <p className="font-medium text-ink-900">¿Qué pasa si me equivoco de punto de venta?</p>
                <p className="text-ink-600">La verificación (paso 4) te lo avisa antes de facturar. Si el número no matchea con los PdV que AFIP ve en tu CUIT, corregís y probás de nuevo.</p>
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <button className="btn-accent" onClick={() => setShowHelp(false)}>Entendido</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
