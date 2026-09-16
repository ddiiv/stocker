import { useEffect, useState } from "react";
import { RefreshCw, AlertTriangle, Check, Store, Unlink } from "lucide-react";
import {
  getJumpsellerStatus, conectarJumpseller, desconectarJumpseller,
  previewJumpseller, syncJumpseller,
} from "../services/jumpsellerService";
import { PageHeader, Card } from "../components/ui/Layout";

/*
 * Jumpseller: el stock de Stocker en la tienda, cruzado por SKU.
 *
 * Misma idea que Mercado Libre: primero se ve qué va a cambiar y recién
 * después se manda. Lo que se publica es lo mismo en los dos canales —lo
 * disponible en los locales que abastecen online, menos el margen— porque sale
 * del mismo cálculo.
 *
 * La tienda se conecta con la clave del panel de Jumpseller. Se manda una vez
 * y no vuelve a mostrarse: si hace falta cambiarla, se desconecta y se conecta
 * de nuevo.
 */
export default function JumpsellerPage() {
  const [estado, setEstado] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");
  const [previa, setPrevia] = useState(null);
  const [form, setForm] = useState({ loginKey: "", authToken: "", tienda: "" });

  async function cargar() {
    setCargando(true); setError("");
    try {
      setEstado(await getJumpsellerStatus());
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo leer el estado de Jumpseller.");
    }
    setCargando(false);
  }
  useEffect(() => { cargar(); }, []);

  async function conectar(e) {
    e.preventDefault();
    setTrabajando(true); setError(""); setAviso("");
    try {
      const r = await conectarJumpseller(form);
      setForm({ loginKey: "", authToken: "", tienda: "" });
      setAviso(`Tienda conectada: ${r.productos} producto(s) en Jumpseller.`);
      await cargar();
    } catch (e2) {
      setError(e2.response?.data?.message || "No se pudo conectar la tienda.");
    } finally { setTrabajando(false); }
  }

  async function desconectar() {
    if (!confirm("¿Desconectar la tienda de Jumpseller? Se borra la clave guardada y deja de sincronizarse el stock.")) return;
    setTrabajando(true); setError(""); setAviso("");
    try {
      await desconectarJumpseller();
      setPrevia(null);
      await cargar();
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo desconectar.");
    } finally { setTrabajando(false); }
  }

  async function verCambios() {
    setTrabajando(true); setError(""); setAviso("");
    try {
      setPrevia(await previewJumpseller());
    } catch (e) {
      setError(e.response?.data?.message || "No se pudieron leer los productos de la tienda.");
    } finally { setTrabajando(false); }
  }

  const pendientes = (previa?.resultados || []).filter((r) => r.estado === "pendiente" || r.estado === "error");

  async function sincronizar() {
    if (!pendientes.length) { setError("No hay nada para mandar."); return; }
    if (!confirm(`Se va a actualizar el stock de ${pendientes.length} producto(s) en Jumpseller. ¿Continuar?`)) return;
    setTrabajando(true); setError(""); setAviso("");
    try {
      const r = await syncJumpseller(pendientes.map((x) => x.sku));
      setPrevia(r);
      setAviso(`Listo: ${r.resumen.actualizados} actualizado(s), ${r.resumen.sinCambios} sin cambios`
        + (r.resumen.errores ? `, ${r.resumen.errores} con error.` : "."));
      await cargar();
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo sincronizar.");
    } finally { setTrabajando(false); }
  }

  return (
    <div>
      <PageHeader
        title="Jumpseller"
        subtitle="El stock de Stocker en tu tienda, cruzado por SKU. Se publica lo disponible en los locales que abastecen las ventas online, menos el margen de seguridad."
        actions={estado?.conectado && (
          <div className="flex flex-wrap gap-2">
            <button className="btn-ghost border border-line" onClick={verCambios} disabled={trabajando}>
              <RefreshCw size={15} className={trabajando ? "animate-spin" : ""} /> Ver cambios
            </button>
            <button className="btn-primary" onClick={sincronizar} disabled={trabajando || (previa !== null && !pendientes.length)}>
              {previa ? `Sincronizar ${pendientes.length} producto(s)` : "Sincronizar stock ahora"}
            </button>
          </div>
        )}
      />

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-brick-200 bg-brick-50 px-3 py-2 text-sm text-brick-700">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" /><span>{error}</span>
        </div>
      )}
      {aviso && (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-line bg-paper-100 px-3 py-2 text-sm text-ink-700">
          <Check size={16} className="mt-0.5 shrink-0" /><span>{aviso}</span>
        </div>
      )}

      {cargando && <p className="mt-4 text-sm text-ink-500">Cargando…</p>}

      {!cargando && !estado?.conectado && (
        <Card className="mt-4 max-w-xl">
          <p className="font-display text-base font-semibold text-ink-900">Conectá tu tienda</p>
          <p className="mt-1 text-sm text-ink-600">
            En el panel de Jumpseller, entrá a <strong>Cuenta → Preferencias</strong> y abrí la sección
            de API: ahí están el <strong>Login Key</strong> y el <strong>Auth Token</strong> de tu tienda.
            Se guardan en Stocker para poder sincronizar y no se muestran más; podés desconectar cuando quieras.
          </p>
          <form className="mt-4 space-y-3" onSubmit={conectar}>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-700">Login Key</span>
              <input className="input font-mono" value={form.loginKey} autoComplete="off" required
                onChange={(e) => setForm({ ...form, loginKey: e.target.value })} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-700">Auth Token</span>
              <input className="input font-mono" type="password" value={form.authToken} autoComplete="off" required
                onChange={(e) => setForm({ ...form, authToken: e.target.value })} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-700">Tienda (opcional)</span>
              <input className="input" placeholder="mitienda.jumpseller.com" value={form.tienda}
                onChange={(e) => setForm({ ...form, tienda: e.target.value })} />
              <span className="mt-1 block text-xs text-ink-500">Sólo para reconocerla en esta pantalla.</span>
            </label>
            <button className="btn-primary" type="submit" disabled={trabajando}>
              {trabajando ? "Probando la clave…" : "Conectar"}
            </button>
          </form>
        </Card>
      )}

      {!cargando && estado?.conectado && (
        <>
          <Card className="mt-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="flex items-center gap-2 font-display text-sm font-semibold text-ink-950">
                  <Store size={15} /> {estado.tienda || "Tienda conectada"}
                </p>
                <p className="mt-1 text-xs text-ink-500">
                  {estado.ultimaSync
                    ? `Última sincronización: ${new Date(estado.ultimaSync).toLocaleString("es-AR")}`
                    : "Todavía no se sincronizó."}
                </p>
                {estado.ultimoError && (
                  <p className="mt-1 text-xs text-brick-700">Último error: {estado.ultimoError}</p>
                )}
              </div>
              <button className="btn-ghost border border-line text-xs" onClick={desconectar} disabled={trabajando}>
                <Unlink size={14} /> Desconectar
              </button>
            </div>
          </Card>

          {previa && (
            <>
              <div className="mt-4 grid gap-4 sm:grid-cols-4">
                <Card><p className="text-xs uppercase tracking-wide text-ink-600">Productos en la tienda</p><p className="mt-2 font-display text-xl font-semibold">{previa.productosEncontrados}</p></Card>
                <Card><p className="text-xs uppercase tracking-wide text-ink-600">{previa.simulado ? "A actualizar" : "Actualizados"}</p><p className="mt-2 font-display text-xl font-semibold text-brass-600">{previa.simulado ? previa.resumen.pendientes : previa.resumen.actualizados}</p></Card>
                <Card><p className="text-xs uppercase tracking-wide text-ink-600">Sin cambios</p><p className="mt-2 font-display text-xl font-semibold">{previa.resumen.sinCambios}</p></Card>
                <Card><p className="text-xs uppercase tracking-wide text-ink-600">Errores</p><p className={`mt-2 font-display text-xl font-semibold ${previa.resumen.errores ? "text-brick-500" : ""}`}>{previa.resumen.errores}</p></Card>
              </div>

              {previa.lugares?.length > 0 && (
                <p className="mt-4 rounded-md bg-paper-100 px-3 py-2 text-xs text-ink-600">
                  Se publica la suma de <strong className="text-ink-900">{previa.lugares.map((l) => l.nombre).join(", ")}</strong>,
                  los locales marcados para abastecer las ventas online. El depósito queda afuera.
                </p>
              )}

              {previa.resumen.noSincronizables > 0 && (
                <p className="mt-2 text-xs text-ink-600">
                  {previa.resumen.noSincronizables} producto(s) no se sincronizan: tienen stock ilimitado en
                  Jumpseller, así que la tienda no lleva la cuenta de las unidades.
                </p>
              )}

              <Card className="mt-4 p-0">
                <p className="border-b border-line px-4 py-3 font-display text-sm font-semibold text-ink-950">Detalle por SKU</p>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead>
                      <tr className="border-b border-line bg-paper-100 text-left text-xs uppercase tracking-wide text-ink-600">
                        <th className="px-4 py-2 font-medium">SKU</th>
                        <th className="px-4 py-2 font-medium">Producto</th>
                        <th className="px-4 py-2 font-medium">En Jumpseller</th>
                        <th className="px-4 py-2 font-medium">Stock tienda</th>
                        <th className="px-4 py-2 font-medium">Stock Stocker</th>
                        <th className="px-4 py-2 font-medium">Estado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previa.resultados.map((r) => (
                        <tr key={`${r.sku}-${r.productId}-${r.variantId || ""}`} className="border-b border-line last:border-0">
                          <td className="px-4 py-2"><span className="tag-chip">{r.sku}</span></td>
                          <td className="px-4 py-2 text-ink-900">{r.titulo}</td>
                          <td className="px-4 py-2">
                            {r.permalink
                              ? <a className="text-xs text-teal-600 underline" href={r.permalink} target="_blank" rel="noreferrer">{r.productId}{r.variantId ? ` · var ${r.variantId}` : ""}</a>
                              : <span className="font-mono text-xs text-ink-600">{r.productId}{r.variantId ? ` · ${r.variantId}` : ""}</span>}
                            {r.estadoTiendaNombre && (
                              <span className="ml-1 rounded bg-paper-200 px-1.5 py-0.5 text-[10px] text-ink-600">{r.estadoTiendaNombre}</span>
                            )}
                            {r.otras?.length > 0 && (
                              <span className="ml-1 text-[11px] text-ink-500">
                                +{r.otras.length} con el mismo SKU (no se tocan)
                              </span>
                            )}
                            {r.aviso && <p className="mt-0.5 text-[11px] text-ink-500">{r.aviso}</p>}
                          </td>
                          <td className="px-4 py-2 text-ink-600">{r.stockTienda ?? "—"}</td>
                          <td className="px-4 py-2 font-medium text-ink-900">
                            {r.stockStocker}
                            {r.margen > 0 && <span className="ml-1 text-[11px] font-normal text-ink-500">(margen −{r.margen})</span>}
                          </td>
                          <td className="px-4 py-2">
                            <EstadoChip estado={r.estado} detalle={r.error || r.motivo} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}

function EstadoChip({ estado, detalle }) {
  const mapa = {
    actualizado: { txt: "Actualizado", cls: "bg-teal-50 text-teal-700" },
    pendiente: { txt: "Se actualizará", cls: "bg-brass-50 text-brass-700" },
    "sin-cambios": { txt: "Sin cambios", cls: "bg-paper-200 text-ink-600" },
    "no-sincronizable": { txt: "No se sincroniza", cls: "bg-paper-200 text-ink-600" },
    error: { txt: "Error", cls: "bg-brick-50 text-brick-500" },
  };
  const m = mapa[estado] || mapa["sin-cambios"];
  return <span className={`rounded px-2 py-0.5 text-xs ${m.cls}`} title={detalle || ""}>{m.txt}</span>;
}
