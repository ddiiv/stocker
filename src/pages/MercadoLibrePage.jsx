import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  RefreshCw, Link2, Unlink, AlertCircle, CheckCircle2, ExternalLink, Check,
  ArrowUpDown, PackageSearch, Trash2, Plus, Store, AlertTriangle,
} from "lucide-react";
import {
  getMlStatus, getMlAuthUrl, disconnectMl, previewMlSync, runMlSync,
  getMlLocales, setMlLocales, importarPedidosMl,
  getMlLinks, saveMlLink, deleteMlLink, getMlCobertura, republicarMl, reactivarMl,
} from "../services/mercadolibreService";
import { PageHeader, Card } from "../components/ui/Layout";
import Postventa from "../components/mercadolibre/Postventa";
import Modal from "../components/ui/Modal";

export default function MercadoLibrePage() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");
  const [preview, setPreview] = useState(null);

  /*
   * Qué publicaciones sincronizar.
   *
   * Un catálogo de doscientas publicaciones no se sincroniza entero cada vez:
   * casi siempre lo que cambió son diez. Barrer las doscientas es un minuto de
   * espera y doscientas peticiones contra el límite de la API para escribir el
   * mismo número que ya estaba.
   *
   * `null` es "todas": es lo que se quiere la primera vez y después de un
   * ingreso grande, y evita que quien no toca nada tenga que tildar doscientas
   * casillas para hacer lo de siempre.
   */
  const [elegidos, setElegidos] = useState(null);

  // Los locales que abastecen online. Se editan acá además de en Empleados →
  // Locales: es donde se los mira cuando el número publicado no cierra.
  const [locales, setLocales] = useState([]);
  const [guardandoLocales, setGuardandoLocales] = useState(false);

  // Traer las ventas viejas. El webhook sólo avisa de lo que pasa desde que
  // está configurado; lo anterior hay que ir a buscarlo.
  const [importando, setImportando] = useState(false);
  const [diasImportar, setDiasImportar] = useState(7);
  const [trabajando, setTrabajando] = useState(false);
  const [links, setLinks] = useState([]);
  const [linkModal, setLinkModal] = useState(false);

  async function cargar() {
    setLoading(true);
    setError("");
    try {
      const [s, l, loc] = await Promise.all([
        getMlStatus(),
        getMlLinks().catch(() => []),
        getMlLocales().catch(() => []),
      ]);
      setStatus(s);
      setLinks(l);
      setLocales(loc);
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
      // La lista de pendientes es otra: una selección vieja apuntaría a SKU que
      // ya no tienen nada que cambiar.
      setElegidos(null);
    } catch (e) {
      setError(e.response?.data?.message || "Error al consultar las publicaciones");
    } finally { setTrabajando(false); }
  }

  /*
   * Los que se van a mandar: los tildados, o todos los que tienen algo que
   * cambiar si no se tildó ninguno.
   */
  const pendientesDeCambio = (preview?.resultados || [])
    .filter((r) => r.estado === "pendiente" || r.estado === "error");
  const aSincronizar = elegidos === null
    ? pendientesDeCambio.map((r) => r.sku)
    : pendientesDeCambio.filter((r) => elegidos.has(r.sku)).map((r) => r.sku);

  function alternar(sku) {
    setElegidos((prev) => {
      // Del "todos" implícito se pasa a una selección explícita con todos
      // menos el que se acaba de destildar: es lo que la persona espera.
      const base = prev === null
        ? new Set(pendientesDeCambio.map((r) => r.sku))
        : new Set(prev);
      if (base.has(sku)) base.delete(sku); else base.add(sku);
      return base;
    });
  }

  async function guardarLocales(ids) {
    setGuardandoLocales(true); setError(""); setAviso("");
    try {
      const r = await setMlLocales(ids);
      setLocales(r.locales);
      // La cuenta cambia: lo que se publica es la suma de los elegidos.
      setPreview(null);
      setAviso("Locales actualizados. Volvé a previsualizar para ver los números nuevos.");
    } catch (e) {
      setError(e.response?.data?.message || "No se pudieron guardar los locales.");
    } finally { setGuardandoLocales(false); }
  }

  async function importarVentas() {
    if (!confirm(
      `Se van a traer las ventas de los últimos ${diasImportar} días que todavía hay que despachar.\n\n`
      + "Las que ya se entregaron o se cancelaron NO se tocan: apartarles stock restaría del inventario "
      + "mercadería que físicamente ya no está.\n\n"
      + "Las que tienen la etiqueta impresa SÍ entran: Mercado Libre las marca despachadas al imprimir, "
      + "pero la mercadería puede seguir en el estante.",
    )) return;

    setImportando(true); setError(""); setAviso("");
    try {
      const r = await importarPedidosMl(diasImportar);
      setAviso(r.mensaje);
    } catch (e) {
      setError(e.response?.data?.message || "No se pudieron traer las ventas anteriores.");
    } finally { setImportando(false); }
  }

  /*
   * Despausar lo que se pausó a mano en Mercado Libre.
   *
   * ML reactiva sola la que pausó por falta de stock, pero no la que pausó el
   * vendedor: eso fue una decisión suya. La sincronización le manda el stock y
   * avisa; despausarla se pide desde acá.
   */
  const pausadasPorVos = (preview?.resultados || [])
    .filter((r) => (r.subEstadosMl || []).includes("paused_by_seller") && r.mlItemId);

  async function reactivar(ids) {
    if (!ids.length) return;
    if (!confirm(`Se van a reactivar ${ids.length} publicación(es) pausada(s) por vos en MercadoLibre. ¿Continuar?`)) return;
    setTrabajando(true); setError(""); setAviso("");
    try {
      const r = await reactivarMl(ids);
      const fallaron = (r.resultados || []).filter((x) => !x.ok);
      setAviso(`${r.reactivadas} publicación(es) reactivada(s)`
        + (fallaron.length ? `. ${fallaron.length} no se pudo: ${fallaron[0].error}` : "."));
      await verCambios();
    } catch (e) {
      setError(e.response?.data?.message || "No se pudieron reactivar.");
    } finally { setTrabajando(false); }
  }

  async function sincronizar() {
    if (!aSincronizar.length) {
      setError("No hay ninguna publicación seleccionada con cambios para mandar.");
      return;
    }
    if (!confirm(`Se va a actualizar el stock de ${aSincronizar.length} publicación(es) en MercadoLibre. ¿Continuar?`)) return;
    setTrabajando(true); setError(""); setAviso("");
    try {
      const r = await runMlSync(aSincronizar);
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
          {/*
            * El último error de la sincronización automática.
            *
            * Stocker sincroniza solo: en cada movimiento de stock y con un
            * barrido cada quince minutos. Cuando eso falla —el token venció, ML
            * rechazó una publicación— antes quedaba sólo en el log del
            * servidor, donde no lo ve nadie: el stock publicado se iba quedando
            * viejo en silencio mientras se seguía vendiendo contra él.
            *
            * Se muestra acá, que es la pantalla donde alguien vendría a mirar
            * si algo anda raro con Mercado Libre.
            */}
          {status.ultimoError && (
            <div className="mb-5 flex items-start gap-2 rounded-md border border-brick-200 bg-brick-50 px-3 py-2.5 text-sm text-brick-700">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">La última sincronización automática falló.</p>
                <p className="mt-0.5 text-xs">{status.ultimoError}</p>
                <p className="mt-1 text-xs">
                  Se reintenta sola cada 15 minutos. Si el mensaje habla del token,
                  desconectá y volvé a autorizar la cuenta: eso no se arregla solo.
                </p>
              </div>
            </div>
          )}

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

          {/*
            * La posventa va ARRIBA de la sincronización.
            *
            * Sincronizar stock es algo que ahora pasa solo; lo que trae a
            * alguien a esta pantalla es un comprador esperando respuesta o un
            * reclamo con el reloj corriendo. Lo que hay que atender va primero.
            */}
          <Postventa />

          <Card className="mb-5">
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn-ghost" onClick={verCambios} disabled={trabajando}>
                <PackageSearch size={15} /> {trabajando ? "Consultando…" : "Ver qué cambiaría"}
              </button>
              <button className="btn-accent" onClick={sincronizar}
                disabled={trabajando || (preview !== null && aSincronizar.length === 0)}>
                <ArrowUpDown size={15} />
                {/*
                  * El botón dice cuántas va a mandar. "Sincronizar ahora" sobre
                  * un catálogo de doscientas no dice si son doscientas o tres,
                  * y esa diferencia es un minuto de espera o dos segundos.
                  */}
                {preview
                  ? `Sincronizar ${aSincronizar.length} publicación(es)`
                  : "Sincronizar stock ahora"}
              </button>
              {/*
                * Traer lo anterior al webhook.
                *
                * Va al lado de sincronizar porque es la otra mitad de la misma
                * pregunta —"¿por qué no veo mis ventas?"— y porque es lo
                * primero que hace falta después de configurar los tópicos.
                */}
              <div className="flex items-center gap-1.5">
                <select className="input h-9 w-28 text-sm"
                  value={diasImportar} onChange={(e) => setDiasImportar(Number(e.target.value))}>
                  <option value={3}>3 días</option>
                  <option value={7}>7 días</option>
                  <option value={15}>15 días</option>
                  <option value={30}>30 días</option>
                </select>
                <button className="btn-ghost gap-1.5" onClick={importarVentas} disabled={importando}>
                  {importando
                    ? <><RefreshCw size={15} className="animate-spin" /> Trayendo…</>
                    : <><ArrowUpDown size={15} /> Traer ventas anteriores</>}
                </button>
              </div>
              <button className="btn-ghost ml-auto" onClick={cargar}><RefreshCw size={15} /> Actualizar</button>
            </div>
            <p className="mt-3 text-xs text-ink-500">
              Las notificaciones de Mercado Libre sólo avisan de lo que pasa <strong>desde</strong> que se
              configuraron: para ver las ventas anteriores hay que traerlas con el botón de arriba. Sólo se
              saltean las que ya se entregaron o se cancelaron. Una con la etiqueta impresa entra igual:
              Mercado Libre la marca despachada al imprimir, pero la mercadería puede seguir en el estante.
            </p>
            <p className="mt-2 text-xs text-ink-500">
              Stocker manda el stock hacia MercadoLibre. El matcheo es por SKU: el campo que ML muestra como
              «SKU» en tu publicación tiene que coincidir con el SKU de la variante en Stocker.
            </p>
          </Card>

          {preview && (
            <>
              {/* De dónde sale lo que se publica. Sin esto, un número que no
                  coincide con el catálogo parece un error de la integración
                  cuando en realidad es stock que está en otro lado. */}
              {/*
                * Qué locales abastecen lo que se publica.
                *
                * Va acá y no sólo en Empleados → Locales porque es donde se lo
                * mira: quien está viendo un número que no entiende está en esta
                * pantalla, y mandarlo a otra sección a buscar un tilde es donde
                * se pierde la mitad de la gente.
                */}
              {locales.length > 0 && (
                <Card className="mb-4">
                  <p className="font-display text-sm font-semibold text-ink-950">
                    De qué locales sale el stock que se publica
                  </p>
                  <p className="mt-0.5 text-xs text-ink-500">
                    Se publica la suma de los tildados, y de ahí se descuentan las ventas online.
                    El depósito no aparece: lo que está ahí hay que moverlo antes de poder despachar.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {locales.map((l) => {
                      const activo = Boolean(l.abasteceOnline);
                      return (
                        <button
                          key={l.id}
                          type="button"
                          disabled={guardandoLocales}
                          onClick={() => {
                            const ids = locales
                              .filter((x) => (x.id === l.id ? !activo : x.abasteceOnline))
                              .map((x) => x.id);
                            guardarLocales(ids);
                          }}
                          className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors ${
                            activo
                              ? "border-teal-400 bg-teal-50 text-teal-600"
                              : "border-line bg-paper-50 text-ink-600 hover:border-ink-300"
                          }`}
                        >
                          {activo ? <Check size={14} /> : <span className="h-3.5 w-3.5 rounded border border-line" />}
                          {l.nombre}
                        </button>
                      );
                    })}
                  </div>
                </Card>
              )}

              {preview.lugares?.length > 0 && (
                <p className="mb-4 rounded-md bg-paper-100 px-3 py-2 text-xs text-ink-600">
                  <Store size={13} className="mr-1 inline" />
                  Se publica la suma de{" "}
                  <strong className="text-ink-900">
                    {preview.lugares.map((l) => l.nombre).join(", ")}
                  </strong>
                  , los locales marcados para abastecer las ventas online. El depósito queda afuera: lo que se
                  ofrece en MercadoLibre es lo que se puede despachar hoy. Se cambia desde Empleados → Locales.
                </p>
              )}

              <div className="mb-5 grid gap-4 sm:grid-cols-4">
                <Card><p className="text-xs uppercase tracking-wide text-ink-600">Publicaciones</p><p className="mt-2 font-display text-xl font-semibold">{preview.publicacionesEncontradas}</p></Card>
                <Card><p className="text-xs uppercase tracking-wide text-ink-600">{preview.simulado ? "A actualizar" : "Actualizadas"}</p><p className="mt-2 font-display text-xl font-semibold text-brass-600">{preview.simulado ? preview.resumen.pendientes : preview.resumen.actualizados}</p></Card>
                <Card><p className="text-xs uppercase tracking-wide text-ink-600">Sin cambios</p><p className="mt-2 font-display text-xl font-semibold">{preview.resumen.sinCambios}</p></Card>
                <Card><p className="text-xs uppercase tracking-wide text-ink-600">Errores</p><p className={`mt-2 font-display text-xl font-semibold ${preview.resumen.errores ? "text-brick-500" : ""}`}>{preview.resumen.errores}</p></Card>
              </div>

              {(preview.resumen.duplicadasACero > 0 || preview.resumen.duplicadasEnCero > 0) && (
                <p className="-mt-2 mb-5 text-xs text-ink-600">
                  {preview.simulado
                    ? `${preview.resumen.duplicadasACero} publicación(es) duplicada(s) con el mismo SKU se van a poner en 0: Mercado Libre no permite duplicadas y, con stock viejo, pueden vender algo que ya no está. Las que comparten stock con la asignada no se tocan.`
                    : `${preview.resumen.duplicadasEnCero} publicación(es) duplicada(s) quedaron en 0 y Mercado Libre las pausa.`}
                </p>
              )}
              {pausadasPorVos.length > 0 && (
                <p className="-mt-2 mb-5 flex flex-wrap items-center gap-2 text-xs text-ink-600">
                  <span>
                    {pausadasPorVos.length} publicación(es) están pausadas por vos en MercadoLibre: reciben el stock,
                    pero ML no las reactiva sola.
                  </span>
                  <button
                    className="btn-ghost border border-line px-2 py-1 text-xs"
                    disabled={trabajando}
                    onClick={() => reactivar(pausadasPorVos.map((r) => r.mlItemId))}
                  >
                    Reactivar {pausadasPorVos.length === 1 ? "la publicación" : `las ${pausadasPorVos.length}`}
                  </button>
                </p>
              )}
              {preview.resumen.noSincronizables > 0 && (
                <p className="-mt-2 mb-5 text-xs text-ink-600">
                  {preview.resumen.noSincronizables} publicación(es) no se pueden sincronizar desde Stocker
                  (Full, finalizadas, en revisión o multi-origen). El motivo está en cada fila.
                </p>
              )}

              {preview.resultados.length > 0 ? (
                <Card className="mb-5 p-0">
                  <p className="border-b border-line px-4 py-3 font-display text-sm font-semibold text-ink-950">Detalle por SKU</p>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[720px] text-sm">
                      <thead>
                        <tr className="border-b border-line bg-paper-100 text-left text-xs uppercase tracking-wide text-ink-600">
                          {/*
                            * La casilla de "todos" sólo alcanza a lo que tiene
                            * algo que cambiar. Tildar lo que ya coincide no
                            * haría nada y daría a entender que sí.
                            */}
                          <th className="w-10 px-4 py-2">
                            <input
                              type="checkbox"
                              aria-label="Seleccionar todas las que tienen cambios"
                              checked={elegidos === null || (pendientesDeCambio.length > 0 && aSincronizar.length === pendientesDeCambio.length)}
                              onChange={(e) => setElegidos(e.target.checked ? null : new Set())}
                            />
                          </th>
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
                            <td className="px-4 py-2">
                              {/*
                                * Sin casilla en lo que ya coincide: no hay nada
                                * que mandar, y una casilla que no hace nada es
                                * peor que ninguna.
                                */}
                              {(r.estado === "pendiente" || r.estado === "error") ? (
                                <input
                                  type="checkbox"
                                  aria-label={`Sincronizar ${r.sku}`}
                                  checked={elegidos === null || elegidos.has(r.sku)}
                                  onChange={() => alternar(r.sku)}
                                />
                              ) : (
                                <span className="block h-3.5 w-3.5" />
                              )}
                            </td>
                            <td className="px-4 py-2"><span className="tag-chip">{r.sku}</span></td>
                            <td className="px-4 py-2 text-ink-900">{r.titulo}</td>
                            <td className="px-4 py-2">
                              <DetallePublicacion r={r} onReactivar={() => reactivar([r.mlItemId])} />
                            </td>
                            <td className="px-4 py-2 text-ink-600">{r.stockMl ?? "—"}</td>
                            <td className="px-4 py-2 font-medium text-ink-900">
                              {r.stockStocker}
                              {r.margenMl > 0 && (
                                <span className="ml-1 text-[11px] font-normal text-ink-500" title="Margen de seguridad: esas unidades no se publican">
                                  (margen −{r.margenMl})
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-2">
                              <EstadoChip estado={r.estado} error={r.error || r.motivo} />
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
                        <a className="text-ink-700 underline decoration-line hover:text-teal-600" href={h.permalink || enlaceMl(h.mlItemId)} target="_blank" rel="noreferrer">{h.titulo}</a>
                        <span className="tag-chip">{h.sku}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </>
          )}

          <ChecklistPublicaciones />

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
                      <td className="px-4 py-2 font-mono text-xs text-ink-600"><a className="text-teal-600 underline" href={enlaceMl(l.mlItemId)} target="_blank" rel="noreferrer">{l.mlItemId}</a>{l.mlVariationId ? ` · ${l.mlVariationId}` : ""}</td>
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
    "no-sincronizable": { txt: "No se sincroniza", cls: "bg-paper-200 text-ink-600" },
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

/*
 * El link de una publicación.
 *
 * Se usa el permalink que devuelve Mercado Libre. Armado a mano como
 * articulo.mercadolibre.com.ar/MLA123 no abre nada: ML espera el guión
 * (MLA-123), y las publicaciones nuevas redirigen a la página del producto.
 */
function enlaceMl(id) {
  return `https://articulo.mercadolibre.com.ar/${String(id || "").replace(/^([A-Z]{3})(\d+)$/, "$1-$2")}`;
}

function estadoMlTexto(estado, subEstados = []) {
  if (!estado || estado === "active") return null;
  if (estado === "paused") {
    if (subEstados.includes("paused_by_seller")) return "Pausada por vos";
    if (subEstados.includes("out_of_stock")) return "Pausada sin stock";
    return "Pausada";
  }
  return { closed: "Finalizada", under_review: "En revisión", inactive: "Inactiva" }[estado] || estado;
}

/*
 * Qué se dice de una publicación repetida.
 *
 * Por SKU se usa una sola, la de mejor exposición. Las otras se ponen en cero
 * —ML no permite duplicadas, y con el stock viejo pueden vender algo que ya no
 * está—, salvo las que comparten stock con la asignada, que ML actualiza sola.
 */
function textoDeOtra(o) {
  if (o.comparteStock) return "comparte stock con la asignada: Mercado Libre las actualiza juntas";
  if (o.enCero) return "duplicada: quedó en 0 y Mercado Libre la pausa";
  if (o.errorCero) return `duplicada: no se pudo poner en 0 (${o.errorCero})`;
  if (o.seVaACero) return "duplicada: se va a poner en 0";
  return "duplicada: no se le escribe stock";
}

function Etiqueta({ children }) {
  return <span className="rounded bg-paper-200 px-1.5 py-0.5 text-[10px] text-ink-600">{children}</span>;
}

/*
 * La publicación asignada a un SKU: su link, su tipo y estado en ML, y las
 * demás publicaciones con el mismo SKU.
 *
 * Por SKU se escribe UNA sola, la de mejor exposición. Las otras se muestran
 * para que se entienda por qué no cambian, y cuáles comparten stock con la
 * elegida (Mercado Libre las actualiza juntas).
 */
function DetallePublicacion({ r, onReactivar }) {
  const [verOtras, setVerOtras] = useState(false);
  const estado = estadoMlTexto(r.estadoMl, r.subEstadosMl);
  const otras = r.otras || [];
  return (
    <div className="min-w-[12rem]">
      <a className="text-xs text-teal-600 underline" href={r.permalink || enlaceMl(r.mlItemId)} target="_blank" rel="noreferrer">
        {r.mlItemId}{r.mlVariationId ? ` · var ${r.mlVariationId}` : ""}
      </a>
      <div className="mt-1 flex flex-wrap gap-1">
        {r.tipoNombre && <Etiqueta>{r.tipoNombre}</Etiqueta>}
        {estado && <Etiqueta>{estado}</Etiqueta>}
        {r.catalogo && <Etiqueta>Catálogo</Etiqueta>}
        {r.full && <Etiqueta>Full</Etiqueta>}
        {r.manual && <Etiqueta>Vínculo manual</Etiqueta>}
      </div>
      {r.aviso && <p className="mt-1 text-[11px] text-ink-500">{r.aviso}</p>}
      {onReactivar && (r.subEstadosMl || []).includes("paused_by_seller") && (
        <button type="button" className="mt-1 text-[11px] text-teal-600 underline" onClick={onReactivar}>
          Reactivar en MercadoLibre
        </button>
      )}
      {otras.length > 0 && (
        <div className="mt-1">
          <button type="button" className="text-[11px] text-ink-600 underline" onClick={() => setVerOtras((x) => !x)}>
            {verOtras ? "Ocultar" : `${otras.length} publicación${otras.length === 1 ? "" : "es"} más con este SKU`}
          </button>
          {verOtras && (
            <ul className="mt-1 space-y-1">
              {otras.map((o) => (
                <li key={`${o.mlItemId}-${o.mlVariationId || ""}`} className="text-[11px] text-ink-500">
                  <a className="text-teal-600 underline" href={o.permalink || enlaceMl(o.mlItemId)} target="_blank" rel="noreferrer">
                    {o.mlItemId}
                  </a>
                  {[o.tipoNombre, estadoMlTexto(o.estadoMl, o.subEstadosMl), o.full ? "Full" : null]
                    .filter(Boolean).map((t) => ` · ${t}`).join("")}
                  {" — "}
                  {textoDeOtra(o)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/*
 * El checklist de publicaciones.
 *
 * Contesta la pregunta que la previa de sincronización no contestaba: de todo
 * lo que hay en Stocker, qué está puesto en Mercado Libre y qué no. Se agrupa
 * por producto padre porque así se compra y así se piensa —"las remeras negras
 * están, los pantalones no"—, y adentro se ve talle por talle.
 *
 * Se pide cuando la persona lo abre: mira también las publicaciones
 * finalizadas, que es una búsqueda más cara y no hace falta en cada venta.
 */
function ChecklistPublicaciones() {
  const [datos, setDatos] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState("");
  const [soloFaltantes, setSoloFaltantes] = useState(true);
  const [abiertos, setAbiertos] = useState(() => new Set());
  const [aviso, setAviso] = useState("");
  const [republicando, setRepublicando] = useState(null);

  async function cargar() {
    setCargando(true); setError("");
    try {
      setDatos(await getMlCobertura());
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo armar el checklist.");
    }
    setCargando(false);
  }

  /*
   * Republicar es lo único que se puede hacer con una finalizada: ML no le
   * acepta stock. Crea otra publicación, así que se pide confirmación y se
   * hace de a una.
   */
  async function reactivar(v) {
    setRepublicando(v.variantId); setError(""); setAviso("");
    try {
      const r = await reactivarMl([v.mlItemId]);
      const falla = (r.resultados || []).find((x) => !x.ok);
      if (falla) setError(falla.error);
      else setAviso(`${v.sku}: publicación reactivada.`);
      await cargar();
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo reactivar.");
    }
    setRepublicando(null);
  }

  async function republicar(v) {
    const ok = window.confirm(
      `¿Republicar ${v.sku} en Mercado Libre?\n\n`
      + `Se crea una publicación NUEVA, con otro código, el precio y el tipo de la anterior y `
      + `${v.stockStocker} unidad(es) de Stocker. Mercado Libre permite republicar una sola vez `
      + "y la publicación vuelve a estar a la venta.",
    );
    if (!ok) return;
    setRepublicando(v.variantId); setError(""); setAviso("");
    try {
      const r = await republicarMl(v.mlItemId);
      setAviso(`${v.sku}: republicada como ${r.mlItemId} con ${r.cantidad} unidad(es).`);
      await cargar();
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo republicar.");
    }
    setRepublicando(null);
  }

  const productos = (datos?.productos || []).filter((p) => !soloFaltantes || p.estado !== "completo");
  const alternar = (id) => setAbiertos((prev) => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const ICONO = {
    completo: <CheckCircle2 size={15} className="shrink-0 text-teal-600" />,
    parcial: <AlertCircle size={15} className="shrink-0 text-brass-600" />,
    "sin-publicar": <AlertTriangle size={15} className="shrink-0 text-brick-500" />,
  };

  return (
    <Card className="mb-5 p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <p className="font-display text-sm font-semibold text-ink-950">Checklist de publicaciones</p>
          <p className="text-xs text-ink-500">
            Qué productos tienen su stock puesto en Mercado Libre y cuáles no. Incluye las publicaciones
            finalizadas y pausadas.
          </p>
        </div>
        <button className="btn-ghost text-xs" onClick={cargar} disabled={cargando}>
          <RefreshCw size={14} className={cargando ? "animate-spin" : ""} />
          {datos ? "Actualizar" : "Armar checklist"}
        </button>
      </div>

      {error && (
        <p className="flex items-start gap-1.5 px-4 py-3 text-sm text-brick-700">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />{error}
        </p>
      )}
      {aviso && (
        <p className="flex items-start gap-1.5 px-4 py-3 text-sm text-ink-700">
          <Check size={15} className="mt-0.5 shrink-0 text-teal-600" />{aviso}
        </p>
      )}

      {!datos && !error && (
        <p className="px-4 py-6 text-center text-sm text-ink-600">
          {cargando ? "Leyendo tus publicaciones de Mercado Libre…" : "Todavía no lo armaste."}
        </p>
      )}

      {datos && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2 text-xs text-ink-600">
            <span>
              <strong className="text-ink-900">{datos.resumen.variantesEnMl}</strong> de{" "}
              <strong className="text-ink-900">{datos.resumen.variantes}</strong> variantes están en Mercado Libre
              {" · "}{datos.resumen.completos} producto(s) completo(s)
              {" · "}{datos.resumen.parciales} a medias
              {" · "}{datos.resumen.sinPublicar} sin publicar
            </span>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={soloFaltantes} onChange={(e) => setSoloFaltantes(e.target.checked)} />
              Ver sólo lo que falta
            </label>
          </div>

          {datos.sinLugarOnline && (
            <p className="border-b border-line bg-paper-100 px-4 py-2 text-xs text-ink-600">
              Ningún local abastece las ventas online, así que no hay stock para publicar. Se marca desde
              Empleados → Locales.
            </p>
          )}

          {productos.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-ink-600">
              {soloFaltantes ? "No falta ninguno: todo lo que tenés está publicado." : "No hay productos para mostrar."}
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {productos.map((p) => (
                <li key={p.productId}>
                  <button
                    type="button"
                    className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-left hover:bg-paper-100"
                    onClick={() => alternar(p.productId)}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {ICONO[p.estado]}
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-ink-900">{p.titulo}</span>
                        <span className="block truncate font-mono text-[11px] text-ink-500">{p.sku}</span>
                      </span>
                    </span>
                    <span className="text-xs text-ink-600">
                      {p.enMl} de {p.total} en Mercado Libre
                      {p.sinMl > 0 && <span className="text-brick-600"> · faltan {p.sinMl}</span>}
                    </span>
                  </button>

                  {abiertos.has(p.productId) && (
                    <ul className="border-t border-line bg-paper-50 px-4 py-2">
                      {p.variantes.map((v) => (
                        <li key={v.variantId} className="flex flex-wrap items-start justify-between gap-2 py-1.5 text-xs">
                          <span className="flex items-start gap-2">
                            {v.sincronizable
                              ? <Check size={13} className="mt-0.5 shrink-0 text-teal-600" />
                              : <span className="mt-0.5 h-3 w-3 shrink-0 rounded-full border border-brick-300" />}
                            <span>
                              <span className="text-ink-800">{v.etiqueta || "Sin variantes"}</span>
                              <span className="ml-1.5 font-mono text-[11px] text-ink-500">{v.sku}</span>
                              {v.esPack && <span className="ml-1 text-[10px] text-ink-500">(pack)</span>}
                              {v.enMl ? (
                                <span className="ml-2">
                                  <a className="text-teal-600 underline" href={v.permalink} target="_blank" rel="noreferrer">
                                    {v.mlItemId}
                                  </a>
                                  {[v.tipoNombre, estadoMlTexto(v.estadoMl, v.subEstadosMl)]
                                    .filter(Boolean).map((t) => ` · ${t}`).join("")}
                                </span>
                              ) : (
                                <span className="ml-2 text-brick-600">sin publicación en Mercado Libre</span>
                              )}
                              {v.motivo && <span className="ml-1 text-ink-500">— {v.motivo}</span>}
                              {(v.subEstadosMl || []).includes("paused_by_seller") && (
                                <button
                                  type="button"
                                  className="ml-2 text-[11px] text-teal-600 underline disabled:text-ink-400"
                                  disabled={republicando === v.variantId}
                                  onClick={() => reactivar(v)}
                                >
                                  {republicando === v.variantId ? "Reactivando…" : "Reactivar"}
                                </button>
                              )}
                              {v.estadoMl === "closed" && (
                                <button
                                  type="button"
                                  className="ml-2 text-[11px] text-teal-600 underline disabled:text-ink-400"
                                  disabled={republicando === v.variantId}
                                  onClick={() => republicar(v)}
                                >
                                  {republicando === v.variantId ? "Republicando…" : "Republicar"}
                                </button>
                              )}
                            </span>
                          </span>
                          <span className="whitespace-nowrap text-ink-600">
                            {v.enMl && <>ML {v.stockMl ?? "—"} · </>}Stocker {v.stockStocker}
                            {v.enMl && v.sincronizable && !v.alDia && (
                              <span className="ml-1 text-brass-700">a sincronizar</span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
