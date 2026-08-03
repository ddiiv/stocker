import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, CheckCircle2, XCircle, ExternalLink, Copy, RefreshCw, ShieldCheck, AlertCircle } from "lucide-react";
import { PageHeader, Card } from "../components/ui/Layout";
import { getArcaConfig, saveArcaConfig, verifyArcaDelegation, getArcaStatus } from "../services/arcaConfigService";

const CONDICIONES = [
  "Responsable Inscripto",
  "Monotributo",
  "Exento",
];

export default function ArcaConfigPage() {
  const { cuitId } = useParams();
  const [data, setData] = useState(null);   // { cuit, config, stockerCuit, mockMode }
  const [health, setHealth] = useState(null);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState(null);
  const [error, setError] = useState("");
  const [puntoVenta, setPuntoVenta] = useState("");
  const [condicionIva, setCondicionIva] = useState("");
  const [ambiente, setAmbiente] = useState("homologacion");

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

  return (
    <div>
      <Link to="/facturacion/cuits" className="mb-4 inline-flex items-center gap-1 text-sm text-ink-600 hover:text-ink-950">
        <ArrowLeft size={15} /> Volver a CUITs
      </Link>
      <PageHeader
        title={`Configurar ARCA · ${cuit.nombre}`}
        subtitle={`Activar facturación electrónica para el CUIT ${cuit.cuit}`}
      />

      {error && <p className="mb-4 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}

      {/* Estado global del servicio */}
      <div className={`mb-6 rounded-md border px-4 py-3 text-sm ${health?.ok ? "border-teal-500 bg-teal-50 text-teal-600" : "border-line bg-paper-100 text-ink-700"}`}>
        {data.mockMode ? (
          <>⚠ Modo MOCK activo — los CAE se generan simulados sin llamar a AFIP. Cuando cargues el certificado y quites <code>ARCA_MOCK=true</code>, este panel valida contra ARCA real.</>
        ) : health?.ok ? (
          <>✓ Servicio ARCA responde OK ({health.ambiente}). Certificado de Stocker configurado y funcionando.</>
        ) : (
          <>✗ Servicio ARCA no responde. {health?.error || "Verificá certificado en el servidor."}</>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Instrucciones AFIP */}
        <Card className="lg:col-span-2">
          <div className="mb-3 flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brass-500 text-xs font-bold text-ink-950">1</span>
            <h3 className="font-display text-base font-semibold text-ink-950">Delegar el servicio wsfe a Stocker</h3>
          </div>
          <p className="mb-3 text-sm text-ink-700">Entrá al portal de AFIP con la Clave Fiscal del titular del CUIT <span className="font-mono">{cuit.cuit}</span> y agregá una relación nueva:</p>
          <ol className="mb-3 list-inside list-decimal space-y-1 text-sm text-ink-700">
            <li>Ir a <a className="text-brass-600 hover:underline inline-flex items-center gap-1" href="https://auth.afip.gob.ar/contribuyente_/login.xhtml" target="_blank" rel="noreferrer">auth.afip.gob.ar <ExternalLink size={11} /></a></li>
            <li>Buscar el servicio <strong>Administrador de Relaciones de Clave Fiscal</strong>.</li>
            <li>Seleccionar tu CUIT y click en <strong>Nueva Relación</strong>.</li>
            <li>En <em>Servicio</em>: buscar y elegir <strong>Facturación Electrónica</strong> (wsfe).</li>
            <li>En <em>Representante</em>: click en Buscar → poner nuestro CUIT abajo y confirmar.</li>
            <li>Guardar y confirmar la relación.</li>
          </ol>
          <div className="mb-3 rounded-md border border-line bg-paper-100 px-3 py-2 text-sm">
            <p className="text-xs uppercase tracking-wide text-ink-600">CUIT de Stocker (representante):</p>
            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="font-mono text-base text-ink-950">{stockerCuit}</span>
              <button
                className="btn-ghost px-2 py-1"
                onClick={() => navigator.clipboard.writeText(stockerCuit).then(() => alert("CUIT copiado"))}
                disabled={stockerCuit.startsWith("(")}
              >
                <Copy size={13} /> Copiar
              </button>
            </div>
          </div>
        </Card>

        {/* Punto de venta */}
        <Card>
          <div className="mb-3 flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brass-500 text-xs font-bold text-ink-950">2</span>
            <h3 className="font-display text-base font-semibold text-ink-950">Punto de venta</h3>
          </div>
          <p className="mb-3 text-sm text-ink-700">Dá de alta un Punto de Venta <strong>electrónico</strong> en AFIP e ingresá el número acá.</p>
          <label className="label">Número</label>
          <input className="input" type="number" min="1" value={puntoVenta} onChange={(e) => setPuntoVenta(e.target.value)} placeholder="1" />
          <label className="label mt-3">Condición IVA</label>
          <select className="input" value={condicionIva} onChange={(e) => setCondicionIva(e.target.value)}>
            <option value="">— Elegir —</option>
            {CONDICIONES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <label className="label mt-3">Ambiente</label>
          <select className="input" value={ambiente} onChange={(e) => setAmbiente(e.target.value)}>
            <option value="homologacion">Homologación (test)</option>
            <option value="produccion">Producción (real)</option>
          </select>
          <button className="btn-accent mt-3 w-full" onClick={handleSave} disabled={saving}>{saving ? "Guardando…" : "Guardar"}</button>
        </Card>
      </div>

      {/* Verificar delegación */}
      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="mb-3 flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brass-500 text-xs font-bold text-ink-950">3</span>
            <h3 className="font-display text-base font-semibold text-ink-950">Verificar delegación</h3>
          </div>
          <p className="mb-3 text-sm text-ink-700">Cuando hayas hecho el paso 1 en AFIP, tocá <em>Verificar ahora</em>. Stocker le pregunta a ARCA si tiene autorización — si responde OK, ya podés facturar desde este CUIT.</p>
          <button className="btn-accent" onClick={handleVerify} disabled={verifying}>
            <RefreshCw size={15} /> {verifying ? "Verificando…" : "Verificar ahora"}
          </button>

          {verifyResult && (
            <div className={`mt-4 rounded-md border px-4 py-3 text-sm ${verifyResult.ok ? "border-teal-500 bg-teal-50" : "border-brick-500 bg-brick-50"}`}>
              {verifyResult.ok ? (
                <div className="flex items-start gap-2 text-teal-600">
                  <CheckCircle2 size={16} className="mt-0.5" />
                  <div>
                    <p className="font-medium">Delegación verificada ✓</p>
                    <p className="text-xs mt-1">ARCA acepta que Stocker facture en nombre de {cuit.cuit}. Ambiente: {verifyResult.ambiente}.</p>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2 text-brick-500">
                  <XCircle size={16} className="mt-0.5" />
                  <div>
                    <p className="font-medium">No verificado</p>
                    <p className="text-xs mt-1"><strong>Error:</strong> {verifyResult.error}</p>
                    {verifyResult.hint && <p className="text-xs mt-1"><strong>Sugerencia:</strong> {verifyResult.hint}</p>}
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>

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
    </div>
  );
}
