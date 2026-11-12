import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft, Search, ChevronDown, ChevronRight, AlertCircle, CheckCircle2, AlertTriangle,
  ExternalLink, RefreshCw, X,
} from "lucide-react";
import {
  previewMlSync, getMlPublicarParametros, setMlPublicarParametros, vistaPreviaMlPublicar,
  validarMlPublicar, descontarMlPublicadas, publicarMl, getMlPublicarEstado,
} from "../services/mercadolibreService";
import { fetchProductGroups } from "../services/productService";
import { PageHeader, Card } from "../components/ui/Layout";
import Modal from "../components/ui/Modal";

const $ = (n) => `$${Math.round(Number(n) || 0).toLocaleString("es-AR")}`;
const msg = (e, base) => e.response?.data?.message || base;

// Cómo se llama cada parámetro en pantalla, en el orden en que se editan.
const CAMPOS = [
  ["multiplicador", "Multiplicador del costo", "veces"],
  ["packing", "Packing", "$"],
  ["comisionPct", "Comisión de Mercado Libre", "%"],
  ["cuotasPct", "Costo de 3 cuotas sin interés", "%"],
  ["envioGratis", "Envío gratis (lo que cobra ML)", "$"],
  ["impuestos", "Impuestos", "$"],
  ["umbral", "Desde qué precio lleva envío y cuotas", "$"],
  ["extraPct", "Extra para descuentos (por defecto)", "%"],
];

export default function MercadoLibrePublicarPage() {
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");

  // 1. Qué publicar y con qué modelo
  const [busqueda, setBusqueda] = useState("");
  const [resultados, setResultados] = useState([]);
  const [buscando, setBuscando] = useState(false);
  const [elegidos, setElegidos] = useState([]); // [{skuAgrupador, title}]
  const [publicaciones, setPublicaciones] = useState(null); // publicaciones de ML para elegir de modelo
  const [cargandoPubs, setCargandoPubs] = useState(false);
  const [modeloItemId, setModeloItemId] = useState("");

  // 2. Parámetros
  const [params, setParams] = useState(null);
  const [guardandoParams, setGuardandoParams] = useState(false);

  // 3. Vista previa. `ajustes` son los cambios a mano de cada producto.
  const [previa, setPrevia] = useState(null);
  const [ajustes, setAjustes] = useState({});
  const [cargandoPrevia, setCargandoPrevia] = useState(false);
  const [desactualizada, setDesactualizada] = useState(false);

  // 4. Probar y publicar
  const [validacion, setValidacion] = useState(null);
  const [validando, setValidando] = useState(false);
  const [confirmar, setConfirmar] = useState(false);
  const [descontando, setDescontando] = useState(false);
  const [trabajo, setTrabajo] = useState(null);
  const timer = useRef(null);

  useEffect(() => {
    getMlPublicarParametros().then(setParams).catch((e) => setError(msg(e, "No se pudieron leer los parámetros.")));
    getMlPublicarEstado().then((t) => { if (t.estado !== "ninguno") setTrabajo(t); }).catch(() => {});
    return () => clearTimeout(timer.current);
  }, []);

  // Mientras la tanda corre, se pregunta cada 3 segundos cómo va.
  useEffect(() => {
    if (trabajo?.estado !== "corriendo") return undefined;
    timer.current = setTimeout(async () => {
      try { setTrabajo(await getMlPublicarEstado()); }
      catch (e) { setError(msg(e, "No se pudo consultar el avance.")); }
    }, 3000);
    return () => clearTimeout(timer.current);
  }, [trabajo]);

  async function buscar(e) {
    e?.preventDefault();
    setBuscando(true); setError("");
    try { setResultados(await fetchProductGroups({ search: busqueda })); }
    catch (err) { setError(msg(err, "No se pudo buscar.")); }
    setBuscando(false);
  }

  function alternar(g) {
    setElegidos((prev) => prev.some((x) => x.skuAgrupador === g.skuAgrupador)
      ? prev.filter((x) => x.skuAgrupador !== g.skuAgrupador)
      : [...prev, { skuAgrupador: g.skuAgrupador, title: g.title }]);
    setDesactualizada(true);
  }

  async function cargarPublicaciones() {
    setCargandoPubs(true); setError("");
    try {
      const r = await previewMlSync();
      const vistos = new Map();
      (r.resultados || []).forEach((x) => { if (x.mlItemId && !vistos.has(x.mlItemId)) vistos.set(x.mlItemId, x.titulo); });
      setPublicaciones([...vistos].map(([id, titulo]) => ({ id, titulo })));
    } catch (e) { setError(msg(e, "No se pudieron traer tus publicaciones.")); }
    setCargandoPubs(false);
  }

  async function guardarParams() {
    setGuardandoParams(true); setError(""); setAviso("");
    try {
      const body = {};
      CAMPOS.forEach(([k]) => { body[k] = Number(params[k]); });
      body.tiendaUrl = params.tiendaUrl;
      setParams(await setMlPublicarParametros(body));
      setAviso("Parámetros guardados. Actualizá la vista previa para ver los precios nuevos.");
      setDesactualizada(true);
    } catch (e) { setError(msg(e, "No se pudieron guardar los parámetros.")); }
    setGuardandoParams(false);
  }

  const cuerpo = () => ({
    modeloItemId: modeloItemId.trim(),
    productos: elegidos.map((g) => {
      const a = ajustes[g.skuAgrupador] || {};
      const p = { skuAgrupador: g.skuAgrupador };
      if (a.familyName) p.familyName = a.familyName;
      if (a.descripcion !== undefined) p.descripcion = a.descripcion;
      if (a.extra !== undefined && a.extra !== "") p.extra = Number(a.extra);
      return p;
    }),
  });

  async function armarPrevia() {
    setCargandoPrevia(true); setError(""); setAviso(""); setValidacion(null);
    try {
      setPrevia(await vistaPreviaMlPublicar(cuerpo()));
      setDesactualizada(false);
    } catch (e) { setError(msg(e, "No se pudo armar la vista previa.")); }
    setCargandoPrevia(false);
  }

  async function probar() {
    setValidando(true); setError(""); setValidacion(null);
    try { setValidacion((await validarMlPublicar(cuerpo())).porSku); }
    catch (e) { setError(msg(e, "No se pudo probar contra Mercado Libre.")); }
    setValidando(false);
  }

  // Las ya publicadas de los productos con 5 % o más de extra (ML no acepta menos).
  const yaPublicadas = (previa?.productos || []).filter((p) => p.extraPct >= 5).reduce((n, p) => n + p.variantes.filter((v) => v.yaPublicada).length, 0);
  async function descontar() {
    if (!window.confirm(`Se le pone a ${yaPublicadas} publicación(es) que ya están en Mercado Libre un descuento igual al extra de su producto. Baja lo que paga el comprador: hacelo sólo si ese precio ya se publicó con el extra adentro. ¿Seguimos?`)) return;
    setDescontando(true); setError(""); setAviso("");
    try {
      const r = await descontarMlPublicadas(cuerpo());
      setAviso(`Descuento: ${r.puestos} puesto(s) ahora${r.fallaron ? `, ${r.fallaron} que Mercado Libre rechazó (se reintentan mañana)` : ""}. Las pausadas lo reciben cuando se activen.`);
    } catch (e) { setError(msg(e, "No se pudo poner el descuento.")); }
    setDescontando(false);
  }

  async function publicar() {
    setConfirmar(false); setError(""); setValidacion(null);
    try { setTrabajo(await publicarMl(cuerpo())); }
    catch (e) { setError(msg(e, "No se pudo empezar a publicar.")); }
  }

  const ajustar = (sku, campo, valor) => {
    setAjustes((a) => ({ ...a, [sku]: { ...a[sku], [campo]: valor } }));
    setDesactualizada(true);
  };

  const publicables = (previa?.productos || []).reduce((n, p) => n + p.publicables, 0);
  const corriendo = trabajo?.estado === "corriendo";
  const puedePrevia = elegidos.length > 0 && /^MLA\d+$/i.test(modeloItemId.trim());

  return (
    <div>
      <PageHeader
        title="Publicar en Mercado Libre"
        subtitle="Elegí productos de Stocker y publicalos de a muchos, con los datos de una publicación tuya como modelo"
        actions={<Link className="btn-ghost" to="/plataformas/mercadolibre"><ArrowLeft size={15} /> Volver</Link>}
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

      {trabajo && <Avance trabajo={trabajo} previa={previa} onCerrar={() => setTrabajo(null)} />}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <p className="font-display text-sm font-semibold text-ink-950">1. Productos</p>
          <form onSubmit={buscar} className="mt-3 flex gap-2">
            <input className="input" placeholder="Buscar por nombre o SKU" value={busqueda} onChange={(e) => setBusqueda(e.target.value)} />
            <button className="btn-ghost" disabled={buscando}><Search size={15} /> Buscar</button>
          </form>
          {resultados.length > 0 && (
            <ul className="mt-3 max-h-56 divide-y divide-line overflow-y-auto rounded-md border border-line">
              {resultados.map((g) => (
                <li key={g.skuAgrupador}>
                  <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-paper-100">
                    <input type="checkbox" checked={elegidos.some((x) => x.skuAgrupador === g.skuAgrupador)} onChange={() => alternar(g)} />
                    <span className="min-w-0 truncate text-ink-900">{g.title}</span>
                    <span className="ml-auto font-mono text-[11px] text-ink-500">{g.skuAgrupador}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {elegidos.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {elegidos.map((g) => (
                <button key={g.skuAgrupador} type="button" onClick={() => alternar(g)} className="tag-chip inline-flex items-center gap-1">
                  {g.title} <X size={11} />
                </button>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <p className="font-display text-sm font-semibold text-ink-950">2. Publicación modelo</p>
          <p className="mt-1 text-xs text-ink-600">
            De ahí se copian la categoría, el tipo de publicación, la ficha técnica, el envío, la garantía y la guía de talles.
          </p>
          <div className="mt-3 flex gap-2">
            <input className="input font-mono" placeholder="MLA123456789" value={modeloItemId} onChange={(e) => { setModeloItemId(e.target.value); setDesactualizada(true); }} />
            <button className="btn-ghost shrink-0" onClick={cargarPublicaciones} disabled={cargandoPubs}>
              <RefreshCw size={15} className={cargandoPubs ? "animate-spin" : ""} /> Mis publicaciones
            </button>
          </div>
          {publicaciones && (
            <select className="input mt-2" value={modeloItemId} onChange={(e) => { setModeloItemId(e.target.value); setDesactualizada(true); }}>
              <option value="">Elegí una publicación…</option>
              {publicaciones.map((p) => <option key={p.id} value={p.id}>{p.titulo} ({p.id})</option>)}
            </select>
          )}
        </Card>
      </div>

      <details className="card mt-4 p-5">
        <summary className="cursor-pointer font-display text-sm font-semibold text-ink-950">Cómo se calcula el precio (parámetros)</summary>
        {params && (
          <div className="mt-4">
            <p className="mb-3 text-xs text-ink-600">
              Lo que te tiene que quedar es costo × multiplicador + packing. El precio se arma para que, descontado lo que cobra
              Mercado Libre, te quede eso. Desde el precio indicado, la publicación lleva envío gratis y cuotas. No se suma nada por publicidad.
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {CAMPOS.map(([k, nombre, unidad]) => (
                <label key={k} className="text-xs text-ink-600">
                  {nombre} ({unidad})
                  <input className="input mt-1" type="number" step="any" value={params[k]} onChange={(e) => setParams({ ...params, [k]: e.target.value })} />
                </label>
              ))}
              <label className="text-xs text-ink-600 sm:col-span-2">
                Tienda de donde salen las fotos
                <input className="input mt-1" value={params.tiendaUrl} onChange={(e) => setParams({ ...params, tiendaUrl: e.target.value })} />
              </label>
            </div>
            <button className="btn-primary mt-4" onClick={guardarParams} disabled={guardandoParams}>Guardar parámetros</button>
          </div>
        )}
      </details>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button className="btn-primary" onClick={armarPrevia} disabled={!puedePrevia || cargandoPrevia}>
          {cargandoPrevia ? "Armando…" : previa ? "Actualizar vista previa" : "3. Ver vista previa"}
        </button>
        {!puedePrevia && <span className="text-xs text-ink-500">Elegí al menos un producto y una publicación modelo (código MLA…).</span>}
        {desactualizada && previa && <span className="text-xs text-brass-600">Cambiaste algo: actualizá la vista previa antes de probar o publicar.</span>}
      </div>

      {previa && (
        <div className="mt-4">
          <Modelo m={previa.modelo} tienda={previa.tienda} />
          <div className="space-y-3">
            {previa.productos.map((p) => (
              <Producto key={p.skuAgrupador} p={p} aj={ajustes[p.skuAgrupador] || {}} ajustar={(c, v) => ajustar(p.skuAgrupador, c, v)} validacion={validacion} />
            ))}
          </div>

          <div className="sticky bottom-0 mt-4 flex flex-wrap items-center gap-2 border-t border-line bg-paper-50 py-3">
            <button className="btn-ghost" onClick={probar} disabled={validando || corriendo || desactualizada || !publicables}>
              {validando ? "Probando… puede tardar" : "Probar (no publica)"}
            </button>
            <button className="btn-accent" onClick={() => setConfirmar(true)} disabled={corriendo || desactualizada || !publicables}>
              Publicar {publicables} variante{publicables === 1 ? "" : "s"}
            </button>
            {yaPublicadas > 0 && (
              <button className="btn-ghost" onClick={descontar} disabled={descontando || corriendo || desactualizada}>
                {descontando ? "Poniendo descuento…" : `Poner descuento a las ${yaPublicadas} ya publicadas`}
              </button>
            )}
            {validacion && <ResumenPrueba v={validacion} />}
          </div>
        </div>
      )}

      <Modal open={confirmar} onClose={() => setConfirmar(false)} title="Publicar en Mercado Libre">
        <p className="text-sm text-ink-800">
          Se van a publicar <strong>{publicables}</strong> publicaciones (una por color y talle) de {previa?.productos.filter((p) => p.publicables).length} producto(s).
          Quedan <strong>activas</strong> en cuanto se crean: las ve cualquiera y pueden vender. Las variantes con problemas se saltean solas.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setConfirmar(false)}>Cancelar</button>
          <button className="btn-accent" onClick={publicar}>Sí, publicar</button>
        </div>
      </Modal>
    </div>
  );
}

function Modelo({ m, tienda }) {
  return (
    <div className="mb-3 rounded-md border border-line bg-paper-100 px-4 py-3 text-xs text-ink-700">
      <p>
        <strong>Modelo:</strong> {m.titulo} ({m.itemId}) · categoría {m.categoriaId} · tipo {m.tipo}
        {m.tresCuotas ? " · con 3 cuotas" : ""}{m.genero ? ` · género ${m.genero}` : ""} · {m.guia ? `guía de talles "${m.guia.nombre}" (${m.guia.talles.join(", ")})` : "sin guía de talles"}
      </p>
      <p className="mt-1">Tienda: {tienda.productos} productos leídos{tienda.fallidos > 0 && <span className="text-brick-600"> · {tienda.fallidos} no se pudieron leer</span>}</p>
    </div>
  );
}

function Desglose({ pr, extra }) {
  if (!pr) return <p className="text-xs font-medium text-brick-600">Sin costo: no se puede calcular el precio.</p>;
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
      <dt className="text-ink-600">Costo</dt><dd>{$(pr.costo)}</dd>
      <dt className="text-ink-600">Te tiene que quedar</dt><dd>{$(pr.neto)}</dd>
      <dt className="text-ink-600">Envío gratis y cuotas</dt><dd>{pr.llevaEnvio ? "Sí" : "No"} / {pr.llevaCuotas ? "Sí" : "No"}</dd>
      <dt className="text-ink-600">Precio publicado</dt><dd className="font-semibold text-ink-950">{$(pr.publicado)}</dd>
      <dt className="text-ink-600">Con {extra}% de descuento</dt><dd>{$(pr.conDescuento)}</dd>
      <dt className="text-ink-600">Te queda (con descuento)</dt><dd className="font-semibold text-teal-700">{$(pr.leQueda)}</dd>
    </dl>
  );
}

function Problemas({ lista }) {
  return lista.map((x, i) => (
    <span key={i} className="mr-1.5 inline-flex items-center gap-1 rounded bg-brick-50 px-1.5 py-0.5 text-[11px] font-medium text-brick-600">
      <AlertTriangle size={11} /> {x.mensaje}
    </span>
  ));
}

function Producto({ p, aj, ajustar, validacion }) {
  const [abierto, setAbierto] = useState(true);
  const extra = aj.extra ?? p.extraPct;
  // Las variantes se agrupan por color: cada color lleva sus fotos.
  const colores = new Map();
  p.variantes.forEach((v) => {
    const k = v.color || "Sin color";
    if (!colores.has(k)) colores.set(k, []);
    colores.get(k).push(v);
  });

  return (
    <Card className="!p-0">
      <button type="button" className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left" onClick={() => setAbierto(!abierto)}>
        <span className="flex items-center gap-2">
          {abierto ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          <span className="font-display text-sm font-semibold text-ink-950">{p.familyName || p.skuAgrupador}</span>
          <span className="font-mono text-[11px] text-ink-500">{p.skuAgrupador}</span>
        </span>
        <span className={`text-xs ${p.publicables ? "text-teal-700" : "text-brick-600"}`}>{p.publicables} para publicar</span>
      </button>
      {abierto && (
        <div className="space-y-4 border-t border-line px-4 py-4">
          {p.problemas.length > 0 && <div><Problemas lista={p.problemas} /></div>}
          {p.avisos.map((a, i) => <p key={i} className="text-xs text-brass-600">{a}</p>)}
          {p.familyName !== null && (
            <>
              <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <label className="text-xs text-ink-600">Título
                  <input className="input mt-1" value={aj.familyName ?? p.familyName} onChange={(e) => ajustar("familyName", e.target.value)} />
                </label>
                <label className="text-xs text-ink-600">Extra para descuentos
                  <div className="mt-1 flex gap-1">
                    {[5, 10].map((n) => (
                      <button key={n} type="button" className={Number(extra) === n ? "btn-primary !px-3" : "btn-ghost !px-3"} onClick={() => ajustar("extra", n)}>{n}%</button>
                    ))}
                    <input className="input !w-20" type="number" min="0" max="90" value={extra} onChange={(e) => ajustar("extra", e.target.value)} aria-label="Extra libre en porcentaje" />
                  </div>
                </label>
              </div>
              <label className="block text-xs text-ink-600">Descripción
                <textarea className="input mt-1" rows={3} value={aj.descripcion ?? p.descripcion} onChange={(e) => ajustar("descripcion", e.target.value)} />
              </label>
            </>
          )}
          <Desglose pr={p.precio} extra={p.extraPct} />
          {[...colores].map(([color, vs]) => (
            <div key={color} className="rounded-md border border-line p-3">
              <p className="text-sm font-medium text-ink-900">{color}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {vs[0].fotos.length === 0
                  ? <span className="text-xs text-brick-600">Sin fotos de este color: no se puede publicar.</span>
                  : vs[0].fotos.slice(0, 8).map((f) => <img key={f} src={f} alt="" loading="lazy" className="h-14 w-14 rounded object-cover" />)}
              </div>
              <ul className="mt-3 divide-y divide-line">
                {vs.map((v) => <Variante key={v.sku} v={v} r={validacion?.[v.sku]} />)}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Variante({ v, r }) {
  return (
    <li className="py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="w-10 font-medium text-ink-900">{v.talle || "Único"}</span>
        <span className="font-mono text-[11px] text-ink-500">{v.sku}</span>
        <span className="text-ink-600">Stock {v.stock}</span>
        {v.precio && <span className="text-ink-600">{$(v.precio.publicado)}</span>}
        {v.yaPublicada && (
          <span className="text-teal-700">
            Ya publicada: <a className="underline" href={v.yaPublicada.link} target="_blank" rel="noreferrer">{v.yaPublicada.itemId}</a> (se saltea)
          </span>
        )}
        {v.publicable && !r && <span className="text-teal-700">{v.stock > 0 ? "Lista" : "Lista: sin stock, queda pausada hasta que entre mercadería"}</span>}
        <Problemas lista={v.problemas} />
        {r?.ok && <span className="text-teal-700">Prueba OK</span>}
      </div>
      {r && !r.ok && <p className="mt-1 break-words text-brick-600">{(r.errores || []).join(" · ")}</p>}
      {r?.avisos?.length > 0 && <p className="mt-1 text-brass-600">{r.avisos.join(" · ")}</p>}
    </li>
  );
}

function ResumenPrueba({ v }) {
  const todas = Object.values(v);
  const mal = todas.filter((x) => !x.ok).length;
  return (
    <span className={`text-xs ${mal ? "text-brick-600" : "text-teal-700"}`}>
      Prueba: {todas.length - mal} bien, {mal} con errores. Que salga bien no asegura que la publicación funcione: Mercado Libre puede igual rechazarla al publicar.
    </span>
  );
}

function Avance({ trabajo, previa, onCerrar }) {
  const pr = trabajo.progreso || {};
  const res = trabajo.resultado;
  const porSku = res?.porSku || pr.porSku || {};
  // Se arma qué variante es de qué producto con la vista previa; lo que no esté ahí va aparte.
  const deProducto = new Map();
  (previa?.productos || []).forEach((p) => p.variantes.forEach((v) => deProducto.set(v.sku, p.skuAgrupador)));
  const grupos = new Map();
  Object.entries(porSku).forEach(([sku, e]) => {
    const g = deProducto.get(sku) || "Otros";
    if (!grupos.has(g)) grupos.set(g, []);
    grupos.get(g).push([sku, e]);
  });
  const pct = pr.total ? Math.round((pr.hechos / pr.total) * 100) : 0;

  return (
    <Card className="mb-4">
      <div className="flex items-start justify-between gap-2">
        <p className="font-display text-sm font-semibold text-ink-950">Publicación en curso</p>
        {trabajo.estado !== "corriendo" && <button className="text-ink-500" onClick={onCerrar} aria-label="Cerrar"><X size={16} /></button>}
      </div>
      {trabajo.estado === "corriendo" && (
        <>
          <p className="mt-2 text-sm text-ink-700">
            {pr.total ? `Publicadas ${pr.hechos} de ${pr.total}…` : "Preparando: leyendo la tienda, la publicación modelo y lo que ya está publicado…"}
          </p>
          {pr.total > 0 && <div className="mt-2 h-2 rounded bg-paper-200"><div className="h-2 rounded bg-teal-600" style={{ width: `${pct}%` }} /></div>}
        </>
      )}
      {trabajo.estado === "error" && <p className="mt-2 text-sm text-brick-600">La tanda falló: {trabajo.error}</p>}
      {res && (
        <p className="mt-2 text-sm text-ink-800">
          Listo: {res.publicadas} publicadas, {res.salteadas} salteadas (ya estaban), {res.omitidas} omitidas (con problemas), {res.conError} con error.
        </p>
      )}
      {[...grupos].map(([g, items]) => (
        <div key={g} className="mt-3">
          <p className="text-xs font-semibold text-ink-900">{g} · {items.filter(([, e]) => e.estado === "publicada").length} de {items.length} publicadas</p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {items.map(([sku, e]) => (
              <li key={sku} className="break-words">
                <span className="font-mono text-[11px] text-ink-500">{sku}</span>{" "}
                {e.estado === "publicada" && <a className="text-teal-700 underline" href={e.link} target="_blank" rel="noreferrer">{e.itemId} <ExternalLink size={10} className="inline" /></a>}
                {e.estado === "publicada" && e.pausada && <span className="text-ink-600"> — pausada (sin stock)</span>}
                {e.estado === "publicada" && e.avisos?.length > 0 && <span className="text-brick-600"> — {e.avisos.join(" · ")}</span>}
                {e.estado === "salteada" && <span className="text-ink-600">salteada: {e.motivo}</span>}
                {e.estado === "omitida" && <span className="text-brick-600">omitida: {(e.problemas || []).map((x) => x.mensaje).join(" · ")}</span>}
                {e.estado === "error" && <span className="text-brick-600">error de Mercado Libre: {e.error}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Card>
  );
}
