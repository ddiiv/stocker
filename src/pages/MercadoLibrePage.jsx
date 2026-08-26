import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  RefreshCw, Link2, Unlink, AlertCircle, CheckCircle2, ExternalLink,
  ArrowUpDown, PackageSearch, Trash2, Plus, Store,
} from "lucide-react";
import {
  getMlStatus, getMlAuthUrl, disconnectMl, previewMlSync, runMlSync,
  getMlLinks, saveMlLink, deleteMlLink,
} from "../services/mercadolibreService";
import { PageHeader, Card } from "../components/ui/Layout";
import Modal from "../components/ui/Modal";

export default function MercadoLibrePage() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");
  const [preview, setPreview] = useState(null);
  const [trabajando, setTrabajando] = useState(false);
  const [links, setLinks] = useState([]);
  const [linkModal, setLinkModal] = useState(false);

  async function cargar() {
    setLoading(true);
    setError("");
    try {
      const [s, l] = await Promise.all([getMlStatus(), getMlLinks().catch(() => [])]);
      setStatus(s);
      setLinks(l);
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo consultar el estado de MercadoLibre");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { cargar(); }, []);

  // El callback de ML nos devuelve acá con ml_ok o ml_error en la URL.
  useEffect(() => {
    if (params.get("ml_ok")) {
      setAviso("Cuenta de MercadoLibre conectada correctamente.");
      params.delete("ml_ok"); setParams(params, { replace: true });
      cargar();
    }
    if (params.get("ml_error")) {
      setError(`MercadoLibre rechazó la conexión: ${params.get("ml_error")}`);
      params.delete("ml_error"); setParams(params, { replace: true });
    }
  }, []);

  async function conectar() {
    try {
      const url = await getMlAuthUrl();
      window.location.href = url;
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo iniciar la conexión");
    }
  }

  async function desconectar() {
    if (!confirm("¿Desconectar la cuenta de MercadoLibre? Vas a tener que autorizar de nuevo para sincronizar.")) return;
    await disconnectMl();
    setPreview(null);
    cargar();
  }

  async function verCambios() {
    setTrabajando(true); setError(""); setAviso("");
    try {
      setPreview(await previewMlSync());
    } catch (e) {
      setError(e.response?.data?.message || "Error al consultar las publicaciones");
    } finally { setTrabajando(false); }
  }

  async function sincronizar() {
    const pendientes = preview?.resumen?.pendientes ?? 0;
    if (pendientes && !confirm(`Se va a actualizar el stock de ${pendientes} publicación(es) en MercadoLibre. ¿Continuar?`)) return;
    setTrabajando(true); setError(""); setAviso("");
    try {
      const r = await runMlSync();
      setPreview(r);
      setAviso(`Sincronización lista: ${r.resumen.actualizados} actualizadas, ${r.resumen.sinCambios} sin cambios${r.resumen.errores ? `, ${r.resumen.errores} con error` : ""}.`);
      cargar();
    } catch (e) {
      setError(e.response?.data?.message || "Error al sincronizar");
    } finally { setTrabajando(false); }
  }

  async function borrarLink(l) {
    if (!confirm(`¿Eliminar el vínculo manual del SKU ${l.sku}?`)) return;
    await deleteMlLink(l.id);
    cargar();
  }

  if (loading) return <div className="card h-64 animate-pulse bg-paper-200/60" />;

  return (
    <div>
      <PageHeader
        title="MercadoLibre"
        subtitle="Sincronizá el stock de tus publicaciones con Stocker usando el SKU"
        actions={
          status?.conectado && (
            <button className="btn-ghost" onClick={desconectar}><Unlink size={15} /> Desconectar</button>
          )
        }
      />

      {error && (
        <p className="mb-4 flex items-start gap-2 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">
          <AlertCircle size={15} className="mt-0.5 shrink-0" /> {error}
        </p>
      )}
      {aviso && (
        <p className="mb-4 flex items-start gap-2 rounded-md bg-teal-50 px-3 py-2 text-sm text-teal-700">
          <CheckCircle2 size={15} className="mt-0.5 shrink-0" /> {aviso}
        </p>
      )}

      {/* Integración no configurada en el servidor */}
      {status && !status.configurado && (
        <Card>
          <p className="font-display text-sm font-semibold text-ink-950">Falta configurar la integración</p>
          <p className="mt-2 text-sm text-ink-600">{status.hint}</p>
          <ol className="mt-4 space-y-2 text-sm text-ink-700">
            <li>1. Entrá a <a className="text-teal-600 underline" href="https://developers.mercadolibre.com.ar/devcenter" target="_blank" rel="noreferrer">developers.mercadolibre.com.ar <ExternalLink size={11} className="inline" /></a> y creá una aplicación.</li>
            <li>2. En la app, poné como <em>Redirect URI</em> la dirección de tu backend seguida de <code className="tag-chip">/api/mercadolibre/callback</code>.</li>
            <li>3. Copiá el <em>App ID</em> y el <em>Secret Key</em> a las variables <code className="tag-chip">ML_CLIENT_ID</code>, <code className="tag-chip">ML_CLIENT_SECRET</code> y <code className="tag-chip">ML_REDIRECT_URI</code> del servidor.</li>
            <li>4. Reiniciá el backend y volvé a esta pantalla.</li>
          </ol>
        </Card>
      )}

      {/* Configurada pero sin conectar */}
      {status?.configurado && !status.conectado && (
        <Card>
          <p className="font-display text-sm font-semibold text-ink-950">Conectá tu cuenta</p>
          <p className="mt-2 text-sm text-ink-600">
            Vas a ir a MercadoLibre para autorizar a Stocker. Solo pedimos permiso para leer tus publicaciones y actualizar su stock —
            no se tocan precios, títulos ni descripciones.
          </p>
          <button className="btn-accent mt-4" onClick={conectar}><Link2 size={15} /> Conectar con MercadoLibre</button>
        </Card>
      )}

      {/* Conectada */}
      {status?.conectado && (
        <>
          <div className="mb-5 grid gap-4 sm:grid-cols-3">
            <Card>
              <p className="text-xs uppercase tracking-wide text-ink-600">Cuenta</p>
              <p className="mt-2 font-display text-lg font-semibold">{status.nickname || status.mlUserId}</p>
            </Card>
            <Card>
              <p className="text-xs uppercase tracking-wide text-ink-600">Última sincronización</p>
              <p className="mt-2 font-display text-lg font-semibold">
                {status.ultimaSync ? new Date(status.ultimaSync).toLocaleString("es-AR") : "Nunca"}
              </p>
            </Card>
            <Card>
              <p className="text-xs uppercase tracking-wide text-ink-600">Vínculos manuales</p>
              <p className="mt-2 font-display text-lg font-semibold">{status.vinculosManuales || 0}</p>
            </Card>
          </div>

          <Card className="mb-5">
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn-ghost" onClick={verCambios} disabled={trabajando}>
                <PackageSearch size={15} /> {trabajando ? "Consultando…" : "Ver qué cambiaría"}
              </button>
              <button className="btn-accent" onClick={sincronizar} disabled={trabajando}>
                <ArrowUpDown size={15} /> Sincronizar stock ahora
              </button>
              <button className="btn-ghost ml-auto" onClick={cargar}><RefreshCw size={15} /> Actualizar</button>
            </div>
            <p className="mt-3 text-xs text-ink-500">
              Stocker manda el stock hacia MercadoLibre. El matcheo es por SKU: el campo que ML muestra como
              «SKU» en tu publicación tiene que coincidir con el SKU de la variante en Stocker.
            </p>
          </Card>

          {preview && (
            <>
              {/* De dónde sale lo que se publica. Sin esto, un número que no
                  coincide con el catálogo parece un error de la integración
                  cuando en realidad es stock que está en otro lado. */}
              {preview.lugar && (
                <p className="mb-4 rounded-md bg-paper-100 px-3 py-2 text-xs text-ink-600">
                  <Store size={13} className="mr-1 inline" />
                  Se publica el stock de <strong className="text-ink-900">{preview.lugar.nombre}</strong>, no el total
                  del negocio. Lo que está en el depósito o en las otras sucursales no se ofrece en MercadoLibre:
                  así lo que se ve en la publicación es lo que se puede despachar.
                </p>
              )}

              <div className="mb-5 grid gap-4 sm:grid-cols-4">
                <Card><p className="text-xs uppercase tracking-wide text-ink-600">Publicaciones</p><p className="mt-2 font-display text-xl font-semibold">{preview.publicacionesEncontradas}</p></Card>
                <Card><p className="text-xs uppercase tracking-wide text-ink-600">{preview.simulado ? "A actualizar" : "Actualizadas"}</p><p className="mt-2 font-display text-xl font-semibold text-brass-600">{preview.simulado ? preview.resumen.pendientes : preview.resumen.actualizados}</p></Card>
                <Card><p className="text-xs uppercase tracking-wide text-ink-600">Sin cambios</p><p className="mt-2 font-display text-xl font-semibold">{preview.resumen.sinCambios}</p></Card>
                <Card><p className="text-xs uppercase tracking-wide text-ink-600">Errores</p><p className={`mt-2 font-display text-xl font-semibold ${preview.resumen.errores ? "text-brick-500" : ""}`}>{preview.resumen.errores}</p></Card>
              </div>

              {preview.resultados.length > 0 ? (
                <Card className="mb-5 p-0">
                  <p className="border-b border-line px-4 py-3 font-display text-sm font-semibold text-ink-950">Detalle por SKU</p>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[720px] text-sm">
                      <thead>
                        <tr className="border-b border-line bg-paper-100 text-left text-xs uppercase tracking-wide text-ink-600">
                          <th className="px-4 py-2 font-medium">SKU</th>
                          <th className="px-4 py-2 font-medium">Producto</th>
                          <th className="px-4 py-2 font-medium">Publicación</th>
                          <th className="px-4 py-2 font-medium">Stock ML</th>
                          <th className="px-4 py-2 font-medium">Stock Stocker</th>
                          <th className="px-4 py-2 font-medium">Estado</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.resultados.map((r) => (
                          <tr key={r.sku} className="border-b border-line last:border-0">
                            <td className="px-4 py-2"><span className="tag-chip">{r.sku}</span></td>
                            <td className="px-4 py-2 text-ink-900">{r.titulo}</td>
                            <td className="px-4 py-2">
                              <a className="text-xs text-teal-600 underline" href={`https://articulo.mercadolibre.com.ar/${r.mlItemId}`} target="_blank" rel="noreferrer">
                                {r.mlItemId}{r.mlVariationId ? ` · var ${r.mlVariationId}` : ""}
                              </a>
                            </td>
                            <td className="px-4 py-2 text-ink-600">{r.stockMl ?? "—"}</td>
                            <td className="px-4 py-2 font-medium text-ink-900">{r.stockStocker}</td>
                            <td className="px-4 py-2">
                              <EstadoChip estado={r.estado} error={r.error} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              ) : (
                <Card className="mb-5">
                  <p className="text-sm text-ink-600">
                    Ningún SKU de Stocker coincide con las publicaciones de MercadoLibre. Cargá el SKU en tus publicaciones
                    de ML, o creá vínculos manuales acá abajo.
                  </p>
                </Card>
              )}

              {preview.huerfanosMl?.length > 0 && (
                <Card className="mb-5">
                  <p className="mb-2 font-display text-sm font-semibold text-ink-950">Publicaciones sin producto en Stocker</p>
                  <p className="mb-3 text-xs text-ink-500">Estos SKUs están en MercadoLibre pero no existen en tu stock. No se tocan.</p>
                  <ul className="divide-y divide-line text-sm">
                    {preview.huerfanosMl.slice(0, 15).map((h) => (
                      <li key={h.mlItemId + h.sku} className="flex items-center justify-between py-2">
                        <span className="text-ink-700">{h.titulo}</span>
                        <span className="tag-chip">{h.sku}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </>
          )}

          <Card className="p-0">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div>
                <p className="font-display text-sm font-semibold text-ink-950">Vínculos manuales</p>
                <p className="text-xs text-ink-500">Para publicaciones que no tienen el SKU cargado en ML.</p>
              </div>
              <button className="btn-ghost text-xs" onClick={() => setLinkModal(true)}><Plus size={14} /> Agregar</button>
            </div>
            {links.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-ink-600">Sin vínculos manuales. El matcheo automático por SKU alcanza en la mayoría de los casos.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {links.map((l) => (
                    <tr key={l.id} className="border-b border-line last:border-0">
                      <td className="px-4 py-2"><span className="tag-chip">{l.sku}</span></td>
                      <td className="px-4 py-2 text-ink-700">{l.titulo || "—"}</td>
                      <td className="px-4 py-2 font-mono text-xs text-ink-600">{l.mlItemId}{l.mlVariationId ? ` · ${l.mlVariationId}` : ""}</td>
                      <td className="px-4 py-2 text-right">
                        <button className="btn-ghost px-2 py-1 text-brick-500" onClick={() => borrarLink(l)}><Trash2 size={13} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <LinkModal open={linkModal} onClose={() => setLinkModal(false)} onSaved={() => { setLinkModal(false); cargar(); }} />
        </>
      )}
    </div>
  );
}

function EstadoChip({ estado, error }) {
  const mapa = {
    "actualizado": { txt: "Actualizado", cls: "bg-teal-50 text-teal-700" },
    "pendiente":   { txt: "Se actualizará", cls: "bg-brass-50 text-brass-700" },
    "sin-cambios": { txt: "Sin cambios", cls: "bg-paper-200 text-ink-600" },
    "error":       { txt: "Error", cls: "bg-brick-50 text-brick-500" },
  };
  const m = mapa[estado] || mapa["sin-cambios"];
  return <span className={`rounded px-2 py-0.5 text-xs ${m.cls}`} title={error || ""}>{m.txt}</span>;
}

function LinkModal({ open, onClose, onSaved }) {
  const [form, setForm] = useState({ sku: "", mlItemId: "", mlVariationId: "", titulo: "" });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => { if (open) { setForm({ sku: "", mlItemId: "", mlVariationId: "", titulo: "" }); setErr(""); } }, [open]);

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setErr("");
    try {
      await saveMlLink(form);
      onSaved();
    } catch (e2) {
      setErr(e2.response?.data?.message || "Error al guardar el vínculo");
    } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Vincular SKU con publicación">
      <form onSubmit={submit} className="space-y-4">
        {err && <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{err}</p>}
        <div>
          <label className="label">SKU en Stocker *</label>
          <input className="input font-mono" required value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} placeholder="REM-NEG-M" />
        </div>
        <div>
          <label className="label">ID de la publicación *</label>
          <input className="input font-mono" required value={form.mlItemId} onChange={(e) => setForm({ ...form, mlItemId: e.target.value })} placeholder="MLA123456789" />
          <p className="mt-1 text-xs text-ink-500">Lo ves en la URL de tu publicación.</p>
        </div>
        <div>
          <label className="label">ID de variación <span className="font-normal text-ink-500">(solo si la publicación tiene variantes)</span></label>
          <input className="input font-mono" value={form.mlVariationId} onChange={(e) => setForm({ ...form, mlVariationId: e.target.value })} placeholder="178456789012" />
        </div>
        <div>
          <label className="label">Título de referencia</label>
          <input className="input" value={form.titulo} onChange={(e) => setForm({ ...form, titulo: e.target.value })} />
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn-accent" disabled={saving}>{saving ? "Guardando…" : "Guardar vínculo"}</button>
        </div>
      </form>
    </Modal>
  );
}
