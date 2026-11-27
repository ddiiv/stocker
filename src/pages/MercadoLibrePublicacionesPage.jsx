import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft, ChevronDown, Search, RefreshCw, AlertTriangle, ExternalLink, Calculator, FileText, Pause, Play, Plus, PackageSearch,
} from "lucide-react";
import {
  getMlPublicaciones, setMlEstadoPublicaciones, unificarColoresPublicacionesMl, getMlPreciosEstado,
} from "../services/mercadolibreService";
import { PageHeader, Card, EmptyState } from "../components/ui/Layout";
import { Alerta, ResultadoPorItem, $, mensajeDe } from "../components/mercadolibre/comun";
import { DescripcionModal, NombreModal } from "../components/mercadolibre/EditarPublicaciones";
import CalculadoraMl from "../components/mercadolibre/CalculadoraMl";
import { PreciosModal, AvancePrecios } from "../components/mercadolibre/PreciosTanda";
import { enTandas } from "../utils/tandas";

// El tope del servidor para una tanda de precios.
const TOPE_TILDADAS = 200;

const ESTADOS = {
  active: ["Activa", "badge-ok"],
  paused: ["Pausada", "badge-low"],
  under_review: ["En revisión", "badge-out"],
  inactive: ["Inactiva", "badge-out"],
};

// Un ítem del modelo viejo viene en varias filas (una por variación): las acciones son por ítem.
const itemsDe = (filas) => [...new Set(filas.map((v) => v.itemId))];

export default function MercadoLibrePublicacionesPage() {
  const [texto, setTexto] = useState("");
  const [filtro, setFiltro] = useState({ buscar: "", conProblemas: false, pagina: 1, fresco: false });
  const [datos, setDatos] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [errorLista, setErrorLista] = useState("");

  const [tildadas, setTildadas] = useState(() => new Map()); // itemId -> su fila; sobrevive al cambio de página
  const [ocupado, setOcupado] = useState("");
  const [hecho, setHecho] = useState(null); // {titulo, error, filas}
  const [editar, setEditar] = useState(null); // {tipo:'descripcion'|'nombre', grupo, itemId}
  const [calcular, setCalcular] = useState(null); // la fila
  const [precios, setPrecios] = useState(null); // [{itemId, precio?}]
  const [trabajo, setTrabajo] = useState(null);
  const pedido = useRef(0);

  useEffect(() => {
    const n = ++pedido.current;
    setCargando(true); setErrorLista("");
    getMlPublicaciones({
      buscar: filtro.buscar || undefined, conProblemas: filtro.conProblemas ? 1 : undefined,
      pagina: filtro.pagina, porPagina: 20, fresco: filtro.fresco ? 1 : undefined,
    })
      // Con filtros que se cambian rápido, una respuesta vieja no puede pisar a la nueva.
      .then((r) => { if (n === pedido.current) setDatos(r); })
      .catch((e) => { if (n === pedido.current) { setDatos(null); setErrorLista(e.response?.data?.message || "No se pudieron traer tus publicaciones."); } })
      .finally(() => { if (n === pedido.current) setCargando(false); });
  }, [filtro]);

  const filtrar = (cambio) => setFiltro((f) => ({ ...f, pagina: 1, fresco: false, ...cambio }));
  const recargar = () => setFiltro((f) => ({ ...f, fresco: true }));

  useEffect(() => {
    getMlPreciosEstado().then((t) => { if (t.estado !== "ninguno") setTrabajo(t); }).catch(() => {});
  }, []);

  // Mientras la tanda corre, se pregunta cada 3 segundos cómo va.
  useEffect(() => {
    if (trabajo?.estado !== "corriendo") return undefined;
    const timer = setTimeout(async () => {
      try {
        const t = await getMlPreciosEstado();
        setTrabajo(t);
        if (t.estado !== "corriendo") recargar();
      } catch {
        setTrabajo((t) => ({ ...t })); // un corte no frena el seguimiento
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, [trabajo]);

  function tildar(filas, poner) {
    setTildadas((m) => {
      const n = new Map(m);
      for (const v of filas) {
        if (!poner) n.delete(v.itemId);
        else if (n.size < TOPE_TILDADAS) n.set(v.itemId, v);
      }
      return n;
    });
  }

  async function cambiarEstado(filas, estado) {
    const ids = itemsDe(filas);
    const sinStock = estado === "active" ? itemsDe(filas.filter((v) => !v.full && !(v.stockStocker > 0))) : [];
    const pregunta = estado === "paused"
      ? `Se pausan ${ids.length} publicación(es) en Mercado Libre: dejan de venderse. ¿Seguimos?`
      : `Se reactivan ${ids.length} publicación(es) en Mercado Libre: quedan a la venta.${sinStock.length ? ` OJO: ${sinStock.length} no muestra(n) stock publicable en Stocker; sin stock no tiene sentido reactivar y no se va(n) a reactivar.` : ""} ¿Seguimos?`;
    if (!window.confirm(pregunta)) return;
    setOcupado("estado"); setHecho(null);
    const titulo = estado === "paused" ? "Pausar" : "Reactivar";
    const resultados = [];
    let error = "";
    try {
      await enTandas(ids, 10, (parte) => setMlEstadoPublicaciones(parte, estado), (r) => { resultados.push(...r.resultados); });
    } catch (e) {
      error = `${mensajeDe(e, "No se pudo cambiar el estado.")} Sin confirmar: ${e.sinMandar.join(", ")}.`;
    }
    setHecho({
      titulo, error,
      filas: resultados.map((r) => ({ itemId: r.itemId, mal: !r.ok, texto: !r.ok ? r.error : r.yaEstaba ? "ya estaba así" : estado === "paused" ? "pausada" : "reactivada" })),
    });
    setOcupado("");
    recargar();
  }

  async function unificar(grupo) {
    const ids = itemsDe(grupo.variantes);
    if (!window.confirm(`Se le cambia el color en Mercado Libre a las variantes de "${grupo.nombre}" que figuran distinto, para que cada color de Stocker tenga un solo nombre (gana el que usa la mayoría). ¿Seguimos?`)) return;
    setOcupado("colores"); setHecho(null);
    try {
      const r = await unificarColoresPublicacionesMl(ids);
      setHecho({
        titulo: `Unificar colores: ${r.unificados} unificada(s), ${r.fallaron} con error`, error: "",
        filas: Object.entries(r.porItem).map(([itemId, x]) => ({ itemId, mal: x.estado === "error", texto: x.error || `"${x.de}" pasó a "${x.a}"` })),
      });
    } catch (e) {
      setHecho({ titulo: "Unificar colores", error: mensajeDe(e, "No se pudieron unificar los colores."), filas: [] });
    }
    setOcupado("");
    recargar();
  }

  const corriendo = trabajo?.estado === "corriendo";
  const trabado = Boolean(ocupado) || corriendo || cargando;
  const elegidas = [...tildadas.values()];

  return (
    <div>
      <PageHeader
        title="Mis publicaciones"
        subtitle="Lo que tenés publicado en Mercado Libre, agrupado por producto, con sus precios y costos reales"
        actions={
          <>
            <Link className="btn-accent" to="/plataformas/mercadolibre/publicar"><Plus size={15} /> Publicar productos</Link>
            <Link className="btn-ghost" to="/plataformas/mercadolibre"><ArrowLeft size={15} /> Volver</Link>
          </>
        }
      />

      {trabajo && <AvancePrecios trabajo={trabajo} onCerrar={() => setTrabajo(null)} />}

      {ocupado && <div className="mb-4"><Alerta tono="aviso">Enviando a Mercado Libre… no cierres esta pantalla.</Alerta></div>}
      {hecho && (
        <Card className="mb-4 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <p className="font-display text-sm font-semibold text-ink-950">{hecho.titulo}</p>
            <button type="button" className="text-xs text-ink-500 underline" onClick={() => setHecho(null)}>Cerrar</button>
          </div>
          <Alerta>{hecho.error}</Alerta>
          {hecho.filas.length ? <ResultadoPorItem filas={hecho.filas} /> : !hecho.error && <p className="text-xs text-ink-600">No había nada para cambiar.</p>}
        </Card>
      )}

      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); filtrar({ buscar: texto.trim() }); }}>
        <input className="input !w-full sm:!w-72" placeholder="Buscar por nombre, SKU, color o MLA…" aria-label="Buscar publicaciones" value={texto} onChange={(e) => setTexto(e.target.value)} />
        <button className="btn-ghost" disabled={cargando}><Search size={15} /> Buscar</button>
        <label className="flex items-center gap-2 text-sm text-ink-800">
          <input type="checkbox" checked={filtro.conProblemas} onChange={(e) => filtrar({ conProblemas: e.target.checked })} /> Con problemas
        </label>
        <button type="button" className="btn-ghost sm:ml-auto" onClick={recargar} disabled={cargando || Boolean(ocupado)}>
          <RefreshCw size={15} className={cargando ? "animate-spin" : ""} /> Actualizar
        </button>
      </form>

      {datos && (
        <p className="mt-2 text-xs text-ink-500">
          {datos.resumen.publicaciones} publicación(es) en {datos.resumen.grupos} grupo(s) · {datos.resumen.conProblemas} con problemas · mostrando {datos.total} que coinciden
        </p>
      )}
      {datos?.sinLugarOnline && <div className="mt-3"><Alerta tono="aviso">No hay ningún local marcado para vender online: no se puede mostrar el stock publicable.</Alerta></div>}

      <div className="mt-4 space-y-3">
        {errorLista && (
          <div className="space-y-2">
            <Alerta>{errorLista}</Alerta>
            <button type="button" className="btn-ghost" onClick={recargar}>Reintentar</button>
          </div>
        )}
        {cargando && !datos && !errorLista && (
          <>
            <p className="text-sm text-ink-600" role="status">Leyendo tus publicaciones en Mercado Libre… con muchas puede tardar.</p>
            <div className="card h-48 animate-pulse bg-paper-200/60" />
          </>
        )}
        {!cargando && datos && !datos.grupos.length && (
          <EmptyState icon={PackageSearch} title="No hay publicaciones para mostrar"
            description={filtro.buscar || filtro.conProblemas ? "Probá con otra búsqueda o sacá el filtro." : "Cuando tengas publicaciones en Mercado Libre van a aparecer acá."} />
        )}
        {datos?.grupos.map((g) => (
          <Grupo key={g.clave} g={g} tildadas={tildadas} tildar={tildar} trabado={trabado}
            onEditar={(tipo, itemId) => setEditar({ tipo, grupo: g, itemId })} onCalcular={setCalcular}
            onEstado={cambiarEstado} onUnificar={() => unificar(g)} />
        ))}
      </div>

      {datos && datos.paginas > 1 && (
        <div className="mt-4 flex items-center justify-center gap-3 text-sm text-ink-700">
          <button type="button" className="btn-ghost" disabled={cargando || datos.pagina <= 1} onClick={() => filtrar({ pagina: datos.pagina - 1 })}>Anterior</button>
          <span>Página {datos.pagina} de {datos.paginas}</span>
          <button type="button" className="btn-ghost" disabled={cargando || datos.pagina >= datos.paginas} onClick={() => filtrar({ pagina: datos.pagina + 1 })}>Siguiente</button>
        </div>
      )}

      {elegidas.length > 0 && (
        <div className="sticky bottom-0 z-10 mt-4 flex flex-wrap items-center gap-2 border-t border-line bg-paper-50 p-3">
          <span className="text-sm font-medium text-ink-900">
            {elegidas.length} tildada{elegidas.length === 1 ? "" : "s"}{elegidas.length >= TOPE_TILDADAS ? " (es el máximo)" : ""}
          </span>
          <button type="button" className="btn-accent" disabled={trabado} onClick={() => setPrecios(elegidas.map((v) => ({ itemId: v.itemId })))}>Cambiar precios</button>
          <button type="button" className="btn-ghost" disabled={trabado} onClick={() => cambiarEstado(elegidas, "paused")}><Pause size={14} /> Pausar</button>
          <button type="button" className="btn-ghost" disabled={trabado} onClick={() => cambiarEstado(elegidas, "active")}><Play size={14} /> Reactivar</button>
          <button type="button" className="btn-ghost" onClick={() => setTildadas(new Map())}>Destildar</button>
        </div>
      )}

      {editar?.tipo === "descripcion" && (
        <DescripcionModal itemId={editar.itemId} delGrupo={itemsDe(editar.grupo.variantes)} onClose={() => setEditar(null)} onCambio={recargar} />
      )}
      {editar?.tipo === "nombre" && (
        <NombreModal grupo={editar.grupo} delGrupo={itemsDe(editar.grupo.variantes)} onClose={() => setEditar(null)} onCambio={recargar} />
      )}
      {calcular && (
        <CalculadoraMl variante={calcular} onClose={() => setCalcular(null)}
          onUsarPrecio={(precio) => { setPrecios([{ itemId: calcular.itemId, precio }]); setCalcular(null); }} />
      )}
      {precios && (
        <PreciosModal cambios={precios} onClose={() => {
          setPrecios(null);
          // Por si el pedido de aplicar se quedó sin respuesta pero la tanda arrancó.
          getMlPreciosEstado().then((t) => { if (t.estado === "corriendo") setTrabajo(t); }).catch(() => {});
        }}
          onArranco={(t) => { setTrabajo(t); setPrecios(null); setTildadas(new Map()); window.scrollTo({ top: 0, behavior: "smooth" }); }} />
      )}
    </div>
  );
}

function Grupo({ g, tildadas, tildar, trabado, onEditar, onCalcular, onEstado, onUnificar }) {
  const todas = g.variantes.every((v) => tildadas.has(v.itemId));
  const colorRepartido = g.problemas.some((p) => p.codigo === "COLOR_REPARTIDO");
  // Cerrado por defecto: con muchos productos, las variantes a la vista tapan todo.
  const [abierto, setAbierto] = useState(false);
  const precios = g.variantes.map((v) => Number(v.precio)).filter((n) => n > 0);
  const [desde, hasta] = [Math.min(...precios), Math.max(...precios)];
  const pausadas = g.variantes.filter((v) => v.estado === "paused").length;
  const elegidasAca = g.variantes.filter((v) => tildadas.has(v.itemId)).length;
  return (
    <Card className="!p-0">
      <div className="space-y-2 px-4 py-3">
        <div className="flex items-start gap-2">
          <input type="checkbox" className="mt-1" checked={todas} onChange={() => tildar(g.variantes, !todas)} aria-label={`Tildar todo el grupo ${g.nombre}`} />
          <button type="button" className="flex min-w-0 flex-1 items-start gap-2 text-left" aria-expanded={abierto} onClick={() => setAbierto(!abierto)}>
            <ChevronDown size={16} className={`mt-0.5 shrink-0 text-ink-500 transition-transform ${abierto ? "" : "-rotate-90"}`} />
            <span className="min-w-0 flex-1">
              <span className="block break-words font-display text-sm font-semibold text-ink-950">{g.nombre}</span>
              <span className="block text-xs text-ink-500">
                {g.variantes.length} variante{g.variantes.length === 1 ? "" : "s"} · stock en ML {g.variantes.reduce((n, v) => n + (v.stockMl || 0), 0)}
                {precios.length > 0 && <> · {$(desde)}{hasta > desde && ` a ${$(hasta)}`}</>}
                {pausadas > 0 && ` · ${pausadas} pausada${pausadas === 1 ? "" : "s"}`}
                {elegidasAca > 0 && ` · ${elegidasAca} tildada${elegidasAca === 1 ? "" : "s"}`}
              </span>
            </span>
            {g.problemas.length > 0 && <span className="badge badge-out shrink-0"><AlertTriangle size={11} className="mr-1 inline" />{g.problemas.length}<span className="sr-only"> problema(s)</span></span>}
          </button>
        </div>
        {abierto && (<>
        <p className="text-xs text-ink-500">
          {itemsDe(g.variantes).length} publicación(es) · {g.categoriaId}{g.modelo === "clasico" ? " · modelo viejo (variaciones en una sola publicación)" : ""}
        </p>
        {g.problemas.map((p) => (
          <p key={`${p.codigo}:${p.mensaje}`} className="flex items-start gap-1.5 rounded bg-brick-50 px-2 py-1 text-xs text-brick-500">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{p.mensaje} <span className="font-mono text-[11px]">{p.itemIds.join(", ")}</span></span>
          </p>
        ))}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-ghost !px-3 !py-1.5 !text-xs" disabled={trabado} onClick={() => onEditar("nombre", g.variantes[0].itemId)}>Cambiar nombre</button>
          <button type="button" className="btn-ghost !px-3 !py-1.5 !text-xs" disabled={trabado} onClick={() => onEditar("descripcion", g.variantes[0].itemId)}><FileText size={13} /> Descripción</button>
          {colorRepartido && <button type="button" className="btn-ghost !px-3 !py-1.5 !text-xs" disabled={trabado} onClick={onUnificar}>Unificar colores</button>}
        </div>
        </>)}
      </div>
      {abierto && <ul className="divide-y divide-line border-t border-line">
        {g.variantes.map((v) => (
          <Fila key={`${v.itemId}:${v.mlVariationId || ""}`} v={v} tildada={tildadas.has(v.itemId)} tildar={tildar} trabado={trabado}
            onEditar={onEditar} onCalcular={onCalcular} onEstado={onEstado}
            // Pausar y reactivar es de la publicación entera: se mandan todas sus filas.
            hermanas={g.variantes.filter((x) => x.itemId === v.itemId)} />
        ))}
      </ul>}
    </Card>
  );
}

function Fila({ v, hermanas, tildada, tildar, trabado, onEditar, onCalcular, onEstado }) {
  const [estado, clase] = ESTADOS[v.estado] || [v.estado || "Sin estado", "badge-out"];
  const distinto = v.sincroniza && !v.full && v.stockStocker != null && v.stockMl !== v.stockStocker;
  const boton = "btn-ghost !px-2.5 !py-1.5 !text-xs";
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3 text-xs">
      <input type="checkbox" className="mt-0.5" checked={tildada} onChange={() => tildar([v], !tildada)} aria-label={`Tildar ${v.itemId} ${v.color || ""} ${v.talle || ""}`} />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-ink-900">{[v.color, v.talle].filter(Boolean).join(" / ") || "Sin variante"}</span>
          <span className={`badge ${clase}`}>{estado}</span>
          {v.subEstados.length > 0 && <span className="text-ink-500">{v.subEstados.join(", ")}</span>}
          <a className="inline-flex items-center gap-1 font-mono text-[11px] text-ink-500 underline" href={v.link} target="_blank" rel="noreferrer">{v.itemId} <ExternalLink size={10} /></a>
        </p>
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-ink-600">
          <span>SKU <span className="font-mono text-[11px]">{v.sku || "sin SKU"}</span></span>
          <span className="text-ink-900">
            {$(v.precio)}{v.precioOriginal != null && <s className="ml-1 text-ink-500">{$(v.precioOriginal)}</s>}
          </span>
          <span className={distinto ? "font-semibold text-brick-500" : ""}>Stock en ML: {v.stockMl ?? "—"} · publicable en Stocker: {v.stockStocker ?? "—"}</span>
          <span>{[v.tipoNombre || v.tipo, v.catalogo && "catálogo", v.full && "Full"].filter(Boolean).join(" · ")}</span>
        </p>
        <p className="break-words text-ink-500">
          {v.variantId
            ? <>En Stocker: <Link className="underline" to={`/stock/${encodeURIComponent(v.productoSku)}`}>{v.productoTitulo}</Link> {[v.colorStocker, v.talleStocker].filter(Boolean).join(" / ")}</>
            : <span className="text-brick-500">Sin vincular a Stocker</span>}
        </p>
      </div>
      <div className="flex w-full flex-wrap gap-1.5 pl-6 sm:w-auto sm:pl-0">
        <button type="button" className={boton} disabled={trabado} onClick={() => onCalcular(v)}><Calculator size={13} /> Calcular</button>
        <button type="button" className={boton} disabled={trabado} onClick={() => onEditar("descripcion", v.itemId)} aria-label={`Descripción de ${v.itemId}`}><FileText size={13} /> Descripción</button>
        {v.estado === "active" && <button type="button" className={boton} disabled={trabado} onClick={() => onEstado(hermanas, "paused")}><Pause size={13} /> Pausar</button>}
        {v.estado === "paused" && <button type="button" className={boton} disabled={trabado} onClick={() => onEstado(hermanas, "active")}><Play size={13} /> Reactivar</button>}
      </div>
    </li>
  );
}
