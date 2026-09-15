import { useEffect, useRef, useState } from "react";
import { Boxes, Plus, Trash2, AlertTriangle, X, Search, Check } from "lucide-react";
import { PageHeader, Card, EmptyState } from "../components/ui/Layout";
import StockTabs from "../components/stock/StockTabs";
import { http } from "../lib/http";
import {
  fetchPacks, fetchSugerencia, crearPack, completarPack, eliminarPack,
  fetchSugerenciaCombo, crearCombo, ampliarCombo,
} from "../services/packService";
import { formatCurrency } from "../utils/formatters";
import { mensajeDeError } from "../utils/errores";
import { useAuth } from "../context/AuthContext";
import { canEdit } from "../utils/permissions";
import CeldaMargenMl from "../components/products/CeldaMargenMl";

/*
 * Packs (combos).
 *
 * Un pack no es un artículo más del catálogo. Es la forma de vender de a N
 * unidades de otro producto: una capa intermedia con SKU propio, para que
 * Mercado Libre pueda publicarlo y el mostrador escanearlo. No tiene stock, no
 * se ingresa, no se transfiere, no se cuenta en un inventario. Por eso no
 * aparece en Stock › Productos ni en ninguna pantalla de mercadería: vive acá.
 *
 * Se arma desde el producto padre y se genera un pack por cada variante del
 * padre, con sus mismos atributos: el pack x3 de la remera negra M es distinto
 * del de la beige L, igual que lo son las remeras. Los SKU salen de la regla
 * del negocio, la misma que usan los productos normales.
 *
 * Un combo junta productos DISTINTOS —remera + pantalón— y cada variante es un
 * color y un talle que tienen todas las prendas ("Negro / M"), o una mezcla de
 * colores elegida a mano ("Blanco + Negro / M"). Por debajo es un pack más: sin stock propio, se cuenta, se publica
 * y se vende igual.
 *
 * "Se arman" nunca es un campo editable, en ningún lado. Es el mínimo de lo que
 * dan sus componentes, y aparece siempre junto al desglose por local, porque un
 * pack se arma entero en un mismo local: con las prendas repartidas entre dos
 * sucursales no hay pack aunque la suma alcance.
 */
export default function PacksPage() {
  const { user } = useAuth();
  const puedeEditar = canEdit(user, "stock");

  const [packs, setPacks] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");
  const [creando, setCreando] = useState(false);
  // El combo al que se le están sumando colores o talles.
  const [ampliando, setAmpliando] = useState(null);

  async function cargar() {
    setCargando(true); setError("");
    try {
      setPacks(await fetchPacks());
    } catch (e) {
      setError(mensajeDeError(e, "No se pudieron cargar los packs."));
    }
    setCargando(false);
  }
  useEffect(() => { cargar(); }, []);

  async function eliminar(p) {
    const ok = window.confirm(
      `¿Dar de baja “${p.titulo}”?\n\n`
      + `Son ${p.variantes.length} pack(s). Dejan de venderse y de descontar stock. `
      + "No se borran: las ventas que ya se hicieron los siguen nombrando.\n\n"
      + "Si están publicados en Mercado Libre, pausá esas publicaciones.",
    );
    if (!ok) return;
    try {
      const r = await eliminarPack(p.productId);
      setAviso(r.mensaje);
      await cargar();
    } catch (e) {
      setError(mensajeDeError(e, "No se pudo dar de baja el pack."));
    }
  }

  async function completar(p) {
    try {
      const r = await completarPack(p.productId);
      setAviso(r.mensaje);
      await cargar();
    } catch (e) {
      setError(mensajeDeError(e, "No se pudieron generar los packs que faltaban."));
    }
  }

  return (
    <div>
      <PageHeader
        title="Packs"
        subtitle="Vender de a N unidades de un producto, o varios productos juntos en un combo. No llevan stock propio: se cuentan los ENTEROS que se pueden armar con lo que haya."
        actions={puedeEditar && (
          <div className="flex flex-wrap gap-2">
            <button className="btn-ghost border border-line" onClick={() => { setAmpliando(null); setCreando("combo"); }}>
              <Plus size={16} /> Nuevo combo
            </button>
            <button className="btn-primary" onClick={() => { setAmpliando(null); setCreando("pack"); }}>
              <Plus size={16} /> Nuevo pack
            </button>
          </div>
        )}
      />
      <StockTabs />

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-brick-200 bg-brick-50 px-3 py-2 text-sm text-brick-700">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {aviso && (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-line bg-paper-100 px-3 py-2 text-sm text-ink-700">
          <Check size={16} className="mt-0.5 shrink-0" />
          <span>{aviso}</span>
        </div>
      )}

      {creando === "pack" && (
        <NuevoPack
          onCerrar={() => setCreando(false)}
          onCreado={async (msg) => { setCreando(false); setAviso(msg); await cargar(); }}
        />
      )}
      {creando === "combo" && (
        <NuevoCombo
          onCerrar={() => setCreando(false)}
          onCreado={async (msg) => { setCreando(false); setAviso(msg); await cargar(); }}
        />
      )}
      {ampliando && (
        <NuevoCombo
          key={`ampliar-${ampliando.productId}`}
          existente={ampliando}
          onCerrar={() => setAmpliando(null)}
          onCreado={async (msg) => { setAmpliando(null); setAviso(msg); await cargar(); }}
        />
      )}

      <div className="mt-4 space-y-3">
        {cargando && <p className="text-sm text-ink-500">Cargando…</p>}

        {!cargando && packs.length === 0 && !creando && (
          <EmptyState
            icon={Boxes}
            title="Todavía no hay packs"
            description="Elegí un producto y cuántas unidades entran por pack. Se genera un pack por cada color y talle, con su SKU, y al venderlo el stock sale del producto."
            action={puedeEditar && (
              <button className="btn-primary" onClick={() => setCreando("pack")}>
                <Plus size={16} /> Crear el primero
              </button>
            )}
          />
        )}

        {!cargando && packs.map((p) => (
          <TarjetaPack onGuardado={cargar}
            key={p.productId}
            pack={p}
            puedeEditar={puedeEditar}
            onEliminar={() => eliminar(p)}
            onCompletar={() => completar(p)}
            onAmpliar={() => { setCreando(false); setAmpliando(p); window.scrollTo({ top: 0, behavior: "smooth" }); }}
          />
        ))}
      </div>
    </div>
  );
}

function TarjetaPack({ pack, puedeEditar, onEliminar, onCompletar, onGuardado, onAmpliar }) {
  const [abierto, setAbierto] = useState(false);
  const caidos = pack.variantes.filter((v) => v.componentes.some((c) => c.activo === false));

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-base font-semibold text-ink-900">{pack.titulo}</p>
          <p className="mt-0.5 text-xs text-ink-500">
            <span className="font-mono">{pack.sku}</span>
            {pack.unidades ? ` · ${pack.unidades} unidades por pack` : ""}
            {" · "}{formatCurrency(pack.precioMinorista)}
          </p>
          {pack.padre && (
            <p className="mt-0.5 text-xs text-ink-500">
              Sale de <span className="text-ink-700">{pack.padre.titulo}</span>{" "}
              (<span className="font-mono">{pack.padre.sku}</span>)
            </p>
          )}
          {pack.tipo === "combo" && pack.piezas?.length > 0 && (
            <p className="mt-0.5 text-xs text-ink-500">
              Combo:{" "}
              {pack.piezas.map((pz, i) => (
                <span key={pz.productId}>
                  {i > 0 && " + "}
                  <span className="text-ink-700">{pz.titulo}</span>
                  {pz.cantidad > 1 ? ` ×${pz.cantidad}` : ""}
                </span>
              ))}
            </p>
          )}
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="font-display text-xl font-semibold text-ink-950">{pack.armables}</p>
            <p className="text-[11px] uppercase tracking-wide text-ink-500">se arman</p>
          </div>
          {puedeEditar && pack.tipo === "combo" && !pack.legado && (
            <button className="btn-ghost border border-line px-2 py-1 text-xs" onClick={onAmpliar}>
              <Plus size={13} /> Colores o talles
            </button>
          )}
          {puedeEditar && (
            <button className="btn-ghost px-2 py-1 text-brick-500" onClick={onEliminar} title="Dar de baja">
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </div>

      {/*
        * El producto padre ganó variantes después de crear el pack: ese color
        * no se puede vender de a tres y no hay ningún error que lo diga.
        */}
      {pack.faltanVariantes > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-paper-100 px-3 py-2">
          <p className="text-xs text-ink-700">
            {pack.tipo === "combo"
              ? <>{pack.faltanVariantes === 1
                ? "Hay 1 combinación elegida que las prendas ya permiten y todavía no existe: no se vende."
                : `Hay ${pack.faltanVariantes} combinaciones elegidas que las prendas ya permiten y todavía no existen: no se venden.`}</>
              : <>El producto tiene {pack.faltanVariantes} variante{pack.faltanVariantes === 1 ? "" : "s"}{" "}
                sin pack: no se pueden vender de a {pack.unidades}.</>}
          </p>
          {puedeEditar && (
            <button className="btn-ghost px-2 py-1 text-xs" onClick={onCompletar}>
              Generar las que faltan
            </button>
          )}
        </div>
      )}

      {caidos.length > 0 && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-brick-700">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          {caidos.length} pack{caidos.length === 1 ? " tiene su prenda" : "s tienen su prenda"}{" "}
          desactivada: no se arma ninguno aunque haya stock.
        </p>
      )}

      <div className="mt-3 border-t border-line pt-3">
        <button
          className="text-xs uppercase tracking-wide text-ink-500 hover:text-ink-800"
          onClick={() => setAbierto((v) => !v)}
        >
          {abierto ? "Ocultar" : "Ver"} las {pack.variantes.length} combinaciones
        </button>

        {abierto && (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-600">
                  <th className="py-1.5 font-medium">Combinación</th>
                  <th className="py-1.5 font-medium">SKU del pack</th>
                  <th className="py-1.5 font-medium">Sale de</th>
                  <th className="py-1.5 text-right font-medium">Packs enteros</th>
                  <th className="py-1.5 pl-3 text-right font-medium" title="Packs que no se publican en Mercado Libre">Margen ML</th>
                </tr>
              </thead>
              <tbody>
                {pack.variantes.map((v) => (
                  <tr key={v.variantId} className="border-b border-line last:border-0">
                    <td className="py-1.5 text-ink-800">{v.etiqueta || "—"}</td>
                    <td className="py-1.5 font-mono text-xs text-ink-600">{v.sku}</td>
                    <td className="py-1.5 text-xs text-ink-500">
                      {v.componentes.map((c) => (
                        <span key={c.componenteVariantId}>
                          {c.cantidad}× <span className="font-mono">{c.sku}</span>
                          {/*
                            * Cuánto hay del componente, al lado del SKU.
                            *
                            * Sin esto, "se arman 5" pide un acto de fe: hay que
                            * ir a Stock a contar para saber si está bien. Con el
                            * stock a la vista la cuenta se comprueba de un
                            * vistazo —15 disponibles, 3 por pack, 5 packs— y si
                            * alguna vez el número estuviera mal, se nota.
                            */}
                          <span className="ml-1 text-ink-400">
                            (hay {c.disponible ?? 0})
                          </span>
                          {c.activo === false && (
                            <span className="ml-1 rounded bg-brick-100 px-1 py-0.5 text-[10px] text-brick-700">
                              desactivada
                            </span>
                          )}
                        </span>
                      ))}
                    </td>
                    <td className="py-1.5 text-right">
                      <span className="font-display font-semibold text-ink-900">{v.armables}</span>
                      {/*
                        * Un pack se arma entero en un local. Sin el desglose,
                        * un cero con stock de sobra repartido entre dos
                        * sucursales no se entiende.
                        */}
                      {v.porLocal.length > 0 && (
                        <span className="ml-2 text-[11px] text-ink-500">
                          {v.porLocal.map((l) => `${l.local}: ${l.armables}`).join(" · ")}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pl-3 text-right">
                      <CeldaMargenMl variantId={v.variantId} margen={v.margenMl} onSaved={onGuardado} soloLectura={!puedeEditar} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

/*
 * El alta.
 *
 * Se elige el producto y cuántas unidades entran, y la pantalla muestra ANTES
 * de guardar qué SKU va a tener cada combinación. Un alta que genera veinte SKU
 * de una vez no se puede revisar después: o se ve antes, o se revisa borrando.
 */
function NuevoPack({ onCerrar, onCreado }) {
  const [padre, setPadre] = useState(null);
  const [unidades, setUnidades] = useState(3);
  const [sku, setSku] = useState("");
  const [skuTocado, setSkuTocado] = useState(false);
  const [titulo, setTitulo] = useState("");
  const [tituloTocado, setTituloTocado] = useState(false);
  const [precio, setPrecio] = useState("");
  const [precioTocado, setPrecioTocado] = useState(false);
  const [previa, setPrevia] = useState(null);
  const [excluidas, setExcluidas] = useState(() => new Set());
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState("");

  /*
   * La previa se recalcula al cambiar producto, unidades o SKU.
   *
   * Los campos que la persona ya tocó no se pisan: escribir un precio y verlo
   * saltar de vuelta al sugerido porque cambió una unidad es la forma más
   * rápida de que nadie confíe en el formulario.
   */
  useEffect(() => {
    if (!padre) { setPrevia(null); return undefined; }
    let vigente = true;
    const t = setTimeout(async () => {
      try {
        const s = await fetchSugerencia({
          productId: padre.id, unidades, sku: skuTocado ? sku : undefined,
        });
        if (!vigente) return;
        setPrevia(s);
        setError("");
        if (!skuTocado) setSku(s.sku);
        if (!tituloTocado) setTitulo(s.titulo);
        if (!precioTocado) setPrecio(String(s.precioMinorista ?? ""));
      } catch (e) {
        if (vigente) { setPrevia(null); setError(mensajeDeError(e, "No se pudo calcular la previa.")); }
      }
    }, 300);
    return () => { vigente = false; clearTimeout(t); };
  }, [padre, unidades, sku, skuTocado, tituloTocado, precioTocado]);

  const incluidas = (previa?.variantes || []).filter((v) => !excluidas.has(v.componenteVariantId));

  async function guardar() {
    setError("");
    if (!padre) { setError("Elegí de qué producto sale el pack."); return; }
    if (!incluidas.length) { setError("Dejá al menos una combinación."); return; }
    setGuardando(true);
    try {
      const r = await crearPack({
        productId: padre.id,
        sku: sku.trim(),
        unidades: Number(unidades),
        titulo: titulo.trim(),
        precioMinorista: Number(precio),
        variantIds: incluidas.length === previa.variantes.length
          ? undefined
          : incluidas.map((v) => v.componenteVariantId),
      });
      await onCreado(r.mensaje);
    } catch (e) {
      setError(mensajeDeError(e, "No se pudo crear el pack."));
    }
    setGuardando(false);
  }

  return (
    <Card className="mt-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="font-display text-base font-semibold text-ink-900">Nuevo pack</p>
          <p className="mt-0.5 text-sm text-ink-600">
            Elegí el producto y cuántas unidades entran. Se genera un pack por cada color y
            talle, con su propio SKU, y al venderlo el stock sale de esa combinación.
          </p>
        </div>
        <button className="btn-ghost px-2 py-1" onClick={onCerrar}><X size={16} /></button>
      </div>

      <BuscadorProducto valor={padre} onElegir={(p) => { setPadre(p); setExcluidas(new Set()); }} />

      {padre && (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-4">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-700">Unidades por pack</span>
              <input
                className="input" type="number" min="1" max="1000" value={unidades}
                onChange={(e) => setUnidades(Math.max(1, Number(e.target.value) || 1))}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-700">SKU del pack</span>
              <input
                className="input font-mono" value={sku} maxLength={80}
                onChange={(e) => { setSku(e.target.value); setSkuTocado(true); }}
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-xs font-medium text-ink-700">Nombre</span>
              <input
                className="input" value={titulo} maxLength={120}
                onChange={(e) => { setTitulo(e.target.value); setTituloTocado(true); }}
              />
            </label>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-700">Precio del pack</span>
              <input
                className="input" type="number" min="0" step="0.01" value={precio}
                onChange={(e) => { setPrecio(e.target.value); setPrecioTocado(true); }}
              />
            </label>
            {/*
              * De dónde sale el número sugerido. Se dice en vez de dejarlo
              * aparecer solo: si no, un precio que nadie escribió parece un
              * dato del sistema y no una cuenta que se puede discutir.
              */}
            <p className="self-end pb-2 text-xs text-ink-500 sm:col-span-3">
              {previa
                ? <>Sugerido: {formatCurrency(previa.padre.precioMinorista)} × {unidades} ={" "}
                  {formatCurrency(previa.padre.precioMinorista * unidades)}. Es una sugerencia:
                  la mayoría de los packs se venden con descuento.</>
                : "Calculando…"}
            </p>
          </div>

          {previa?.avisos?.map((a) => (
            <p key={a} className="mt-2 flex items-start gap-1.5 text-xs text-ink-600">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />{a}
            </p>
          ))}

          {previa && (
            <div className="mt-4">
              <p className="mb-1.5 text-xs font-medium text-ink-700">
                Se van a crear {incluidas.length} pack{incluidas.length === 1 ? "" : "s"}
              </p>
              <div className="max-h-64 overflow-y-auto rounded-md border border-line">
                <table className="w-full min-w-[420px] text-sm">
                  <thead className="sticky top-0 bg-paper-100">
                    <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-600">
                      <th className="px-2 py-1.5 font-medium" />
                      <th className="px-2 py-1.5 font-medium">Combinación</th>
                      <th className="px-2 py-1.5 font-medium">Sale de</th>
                      <th className="px-2 py-1.5 font-medium">SKU del pack</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previa.variantes.map((v) => {
                      const dentro = !excluidas.has(v.componenteVariantId);
                      return (
                        <tr key={v.componenteVariantId} className="border-b border-line last:border-0">
                          <td className="px-2 py-1.5">
                            <input
                              type="checkbox" checked={dentro}
                              onChange={() => setExcluidas((prev) => {
                                const n = new Set(prev);
                                if (n.has(v.componenteVariantId)) n.delete(v.componenteVariantId);
                                else n.add(v.componenteVariantId);
                                return n;
                              })}
                            />
                          </td>
                          <td className={`px-2 py-1.5 ${dentro ? "text-ink-800" : "text-ink-400 line-through"}`}>
                            {v.etiqueta || "—"}
                          </td>
                          <td className="px-2 py-1.5 font-mono text-xs text-ink-500">{v.skuPadre}</td>
                          <td className="px-2 py-1.5 font-mono text-xs text-ink-600">
                            {v.sku}
                            {v.repetido && (
                              <span className="ml-1 rounded bg-paper-200 px-1 py-0.5 text-[10px] text-ink-600">
                                se le agrega un sufijo
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {error && (
        <p className="mt-3 flex items-start gap-1.5 text-sm text-brick-700">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />{error}
        </p>
      )}

      <div className="mt-4 flex justify-end gap-2 border-t border-line pt-3">
        <button className="btn-ghost" onClick={onCerrar} disabled={guardando}>Cancelar</button>
        <button className="btn-primary" onClick={guardar} disabled={guardando || !previa}>
          {guardando ? "Creando…" : `Crear ${incluidas.length || ""} pack${incluidas.length === 1 ? "" : "s"}`}
        </button>
      </div>
    </Card>
  );
}

// `uid` identifica la tarjeta: con el índice, quitar una prenda le pasaba la búsqueda a la de al lado.
let siguientePieza = 0;
const nuevaPieza = () => ({ uid: `p${++siguientePieza}`, producto: null, cantidad: 1 });
const normTexto = (v) => String(v ?? "").trim().toUpperCase();
const claveOpcion = (valores) => valores.map(normTexto).join("|");
const nombreOpcion = (valores) => {
  const presentes = valores.filter(Boolean);
  const unColor = presentes.length > 0 && presentes.every((c) => normTexto(c) === normTexto(presentes[0]));
  return unColor ? presentes[0] : presentes.join(" + ");
};

function Chip({ activo, bloqueado = false, onClick, titulo, children }) {
  return (
    <button
      type="button"
      aria-pressed={activo}
      disabled={bloqueado}
      title={titulo}
      onClick={onClick}
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs transition-colors ${
        activo ? "border-ink-800 bg-paper-200 font-medium text-ink-900" : "border-line text-ink-600 hover:border-ink-400"
      } ${bloqueado ? "cursor-default opacity-80" : ""}`}
    >
      {activo && <Check size={12} className="mr-1" />}
      {children}
    </button>
  );
}

/*
 * El alta de un combo, y la ampliación de uno que ya existe.
 *
 * Cada variante del combo es un color y un talle: "Negro / M" lleva la remera
 * negra M y el pantalón negro M. Los colores y talles se eligen entre los que
 * tienen TODAS las prendas; la pantalla muestra antes de guardar qué
 * combinaciones salen, cuáles no se pueden armar porque a alguna prenda le
 * falta esa variante, y con qué SKU. También se pueden combinar colores
 * distintos en una variante ("Blanco + Negro / M"). El talle es siempre el
 * mismo para todas las prendas.
 *
 * Al ampliar, las prendas y lo ya elegido quedan fijos: sólo se suma.
 */
function NuevoCombo({ onCerrar, onCreado, existente = null }) {
  const [piezas, setPiezas] = useState(() => (existente
    ? existente.piezas.map((p) => ({ uid: `e${p.productId}`, producto: { id: p.productId, titulo: p.titulo, sku: p.sku }, cantidad: p.cantidad }))
    : [nuevaPieza(), nuevaPieza()]));
  // null: lo que propone el servidor (todos los colores y talles en común).
  const [colores, setColores] = useState(null);
  const [talles, setTalles] = useState(null);
  const [excluidos, setExcluidos] = useState(() => new Set());
  const [mezcla, setMezcla] = useState({});
  // Al ampliar: lo que el combo ya tenía elegido, que no se puede sacar.
  const [bloqueadas, setBloqueadas] = useState(null);
  const inicializado = useRef(false);
  const [sku, setSku] = useState("");
  const [skuTocado, setSkuTocado] = useState(false);
  const [titulo, setTitulo] = useState("");
  const [tituloTocado, setTituloTocado] = useState(false);
  const [precio, setPrecio] = useState("");
  const [precioTocado, setPrecioTocado] = useState(false);
  const [previa, setPrevia] = useState(null);
  // La previa está vieja: hay un cambio que todavía no volvió del servidor.
  const [pendiente, setPendiente] = useState(false);
  const errorDePrevia = useRef(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState("");

  const completas = piezas.length >= 2 && piezas.every((p) => p.producto);

  // Cambiar una prenda invalida lo elegido: los colores y talles eran de otra.
  function cambiarPiezas(cambio) {
    setPiezas(cambio);
    // La previa de las prendas anteriores no sirve: sus colores tendrían otro largo.
    setPrevia(null);
    setColores(null); setTalles(null); setExcluidos(new Set()); setMezcla({});
  }

  // El SKU sólo cuenta si lo escribió la persona: el sugerido no dispara otra previa.
  const skuManual = skuTocado ? sku : null;

  /*
   * La previa se recalcula con cada cambio. Como en el pack, el SKU, el nombre
   * y el precio que la persona ya tocó no se pisan.
   */
  useEffect(() => {
    if (!completas) { setPrevia(null); setPendiente(false); return undefined; }
    setPendiente(true);
    let vigente = true;
    const t = setTimeout(async () => {
      try {
        const s = await fetchSugerenciaCombo({
          ...(existente
            ? { productId: existente.productId }
            : {
              sku: skuManual ?? undefined,
              piezas: piezas.map((p) => ({ productId: p.producto.id, cantidad: p.cantidad })),
            }),
          colores: colores ?? undefined,
          talles: talles ?? undefined,
        });
        if (!vigente) return;
        setPrevia(s);
        setPendiente(false);
        // Sólo se borra el error de una previa anterior: el de guardar tiene que quedar a la vista.
        if (errorDePrevia.current) { errorDePrevia.current = false; setError(""); }
        if (existente && !inicializado.current) {
          inicializado.current = true;
          setBloqueadas({ opciones: new Set(s.opciones.map(claveOpcion)), talles: new Set(s.talles.map(normTexto)) });
          setExcluidos(new Set(s.variantes.filter((v) => v.excluida && !v.existe).map((v) => v.clave)));
        }
        if (!existente) {
          if (!skuTocado) setSku(s.sku);
          if (!tituloTocado) setTitulo(s.titulo);
          if (!precioTocado) setPrecio(String(s.precioMinorista ?? ""));
        }
      } catch (e) {
        if (vigente) {
          setPrevia(null);
          setPendiente(false);
          errorDePrevia.current = true;
          setError(mensajeDeError(e, "No se pudo calcular la previa."));
        }
      }
    }, 300);
    return () => { vigente = false; clearTimeout(t); };
    // `existente` no cambia mientras el formulario está abierto: se monta con otra key.
  }, [piezas, completas, colores, talles, skuManual, tituloTocado, precioTocado]); // eslint-disable-line react-hooks/exhaustive-deps

  const info = previa?.piezas || [];
  const problema = info.find((p) => p.problema)?.problema;
  const conColor = info.some((p) => p.colores.length > 0);
  const conTalle = info.some((p) => p.talles.length > 0);
  const opciones = colores ?? previa?.opciones ?? [];
  const tallesElegidos = talles ?? previa?.talles ?? [];
  const elegidas = new Set(opciones.map(claveOpcion));
  const opcionDeColor = (c) => info.map((p) => (p.colores.length ? c : null));
  const mezcladas = opciones.filter((op) => {
    const presentes = op.filter(Boolean);
    return presentes.some((c) => normTexto(c) !== normTexto(presentes[0]));
  });
  const filas = previa?.variantes || [];
  const nuevas = filas.filter((f) => !f.existe);
  const aCrear = nuevas.filter((f) => !excluidos.has(f.clave));
  /*
   * Se guarda sólo lo que se ve: con una previa en camino, la tabla todavía
   * muestra la elección anterior y se crearía algo que nadie revisó.
   */
  const puedeGuardar = Boolean(previa) && !pendiente && !problema && !previa?.invalidas?.length
    && aCrear.length > 0 && !guardando && (Boolean(existente) || sku.trim() !== "");

  function alternarOpcion(op) {
    const clave = claveOpcion(op);
    if (bloqueadas?.opciones.has(clave)) return;
    setColores(elegidas.has(clave) ? opciones.filter((o) => claveOpcion(o) !== clave) : [...opciones, op]);
  }

  function agregarMezcla() {
    const valores = info.map((p, i) => (p.colores.length ? (mezcla[i] || "") : null));
    if (valores.some((v, i) => info[i].colores.length && !v)) {
      setError("Para combinar colores, elegí un color para cada prenda.");
      return;
    }
    if (!elegidas.has(claveOpcion(valores))) setColores([...opciones, valores]);
    setMezcla({});
    setError("");
  }

  function alternarTalle(tl) {
    const clave = normTexto(tl);
    if (bloqueadas?.talles.has(clave)) return;
    const elegido = tallesElegidos.some((x) => normTexto(x) === clave);
    setTalles(elegido ? tallesElegidos.filter((x) => normTexto(x) !== clave) : [...tallesElegidos, tl]);
  }

  function alternarFila(clave) {
    setExcluidos((prev) => {
      const n = new Set(prev);
      if (n.has(clave)) n.delete(clave); else n.add(clave);
      return n;
    });
  }

  async function guardar() {
    setError("");
    if (!puedeGuardar) return;
    setGuardando(true);
    const eleccion = {
      ...(previa.legado ? {} : { colores: opciones }),
      talles: tallesElegidos,
      excluidas: nuevas.filter((f) => excluidos.has(f.clave)).map((f) => f.clave),
    };
    try {
      const r = existente
        ? await ampliarCombo(existente.productId, eleccion)
        : await crearCombo({
          sku: sku.trim(),
          titulo: titulo.trim(),
          precioMinorista: Number(precio),
          piezas: piezas.map((p) => ({ productId: p.producto.id, cantidad: p.cantidad })),
          ...eleccion,
        });
      await onCreado(r.mensaje);
    } catch (e) {
      setError(mensajeDeError(e, existente ? "No se pudo ampliar el combo." : "No se pudo crear el combo."));
    }
    setGuardando(false);
  }

  return (
    <Card className="mt-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="font-display text-base font-semibold text-ink-900">
            {existente ? `Colores o talles para ${existente.titulo}` : "Nuevo combo"}
          </p>
          <p className="mt-0.5 text-sm text-ink-600">
            {existente
              ? "Lo que el combo ya tiene queda como está. Sumá colores, talles o combinaciones de colores: se crean sólo las variantes nuevas."
              : "Elegí las prendas y cuántas de cada una. Después, los colores y talles: cada variante del combo lleva todas las prendas en ese color y ese talle."}
          </p>
        </div>
        <button className="btn-ghost px-2 py-1" onClick={onCerrar} aria-label="Cerrar"><X size={16} /></button>
      </div>

      {existente ? (
        <p className="text-sm text-ink-700">
          {existente.piezas.map((p, i) => (
            <span key={p.productId}>
              {i > 0 && " + "}{p.titulo}{p.cantidad > 1 ? ` ×${p.cantidad}` : ""}
            </span>
          ))}
        </p>
      ) : (
        <div className="space-y-3">
          {piezas.map((p, i) => {
            const pz = info[i];
            return (
              <div key={p.uid} className="rounded-md border border-line p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-ink-600">Prenda {i + 1}</p>
                  {piezas.length > 2 && (
                    <button type="button" className="btn-ghost px-2 py-1 text-xs"
                      onClick={() => cambiarPiezas((prev) => prev.filter((_, j) => j !== i))}>
                      Quitar
                    </button>
                  )}
                </div>
                <BuscadorProducto valor={p.producto}
                  onElegir={(prod) => cambiarPiezas((prev) => prev.map((x, j) => (j === i ? { ...x, producto: prod } : x)))} />
                {p.producto && (
                  <div className="mt-2 grid gap-3 sm:grid-cols-4">
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-ink-700">Cantidad</span>
                      <input className="input" type="number" min="1" max="1000" value={p.cantidad}
                        onChange={(e) => {
                          const cantidad = Math.max(1, Math.min(1000, Math.trunc(Number(e.target.value)) || 1));
                          setPiezas((prev) => prev.map((x, j) => (j === i ? { ...x, cantidad } : x)));
                        }} />
                    </label>
                    {pz && !pz.problema && (
                      <p className="self-end pb-2 text-xs text-ink-500 sm:col-span-3">
                        {pz.colores.length > 0 && <>Colores: {pz.colores.join(", ")}. </>}
                        {pz.talles.length > 0 && <>Talles: {pz.talles.join(", ")}.</>}
                        {!pz.colores.length && !pz.talles.length && "Sin colores ni talles: entra igual en todas las variantes."}
                      </p>
                    )}
                  </div>
                )}
                {pz?.problema && (
                  <p className="mt-2 flex items-start gap-1.5 text-xs text-brick-700">
                    <AlertTriangle size={13} className="mt-0.5 shrink-0" />{pz.problema}
                  </p>
                )}
              </div>
            );
          })}
          {piezas.length < 10 && (
            <button type="button" className="btn-ghost border border-line text-xs"
              onClick={() => cambiarPiezas((prev) => [...prev, nuevaPieza()])}>
              <Plus size={14} /> Agregar prenda
            </button>
          )}
        </div>
      )}

      {previa && !problema && (
        <div className="mt-4 space-y-4">
          {previa.legado && (
            <p className="text-xs text-ink-600">
              Este combo se creó con la versión anterior, con un color fijo por prenda: sólo se le pueden sumar talles.
            </p>
          )}

          {conColor && !previa.legado && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-ink-600">Colores</p>
              <p className="mt-0.5 text-xs text-ink-500">
                Mismo color en todas las prendas. Sólo aparecen los que tienen todas.
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {previa.coloresComunes.map((c) => {
                  const op = opcionDeColor(c);
                  const fija = Boolean(bloqueadas?.opciones.has(claveOpcion(op)));
                  return (
                    <Chip key={c} activo={elegidas.has(claveOpcion(op))} bloqueado={fija}
                      titulo={fija ? "Ya es parte del combo" : undefined} onClick={() => alternarOpcion(op)}>
                      {c}
                    </Chip>
                  );
                })}
                {!previa.coloresComunes.length && (
                  <span className="text-xs text-ink-500">Las prendas no comparten ningún color.</span>
                )}
              </div>

              {mezcladas.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {mezcladas.map((op) => {
                    const fija = Boolean(bloqueadas?.opciones.has(claveOpcion(op)));
                    return (
                      <Chip key={claveOpcion(op)} activo bloqueado={fija}
                        titulo={fija ? "Ya es parte del combo" : "Quitar esta combinación de colores"}
                        onClick={() => alternarOpcion(op)}>
                        {nombreOpcion(op)}
                        {!fija && <X size={11} className="ml-1" />}
                      </Chip>
                    );
                  })}
                </div>
              )}

              <div className="mt-3 rounded-md border border-dashed border-line p-3">
                <p className="text-xs font-medium text-ink-700">Combinar colores distintos</p>
                <p className="mt-0.5 text-xs text-ink-500">
                  Por ejemplo, remera blanca con pantalón negro. Elegí un color por prenda.
                </p>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  {info.map((pz, i) => pz.colores.length > 0 && (
                    <label key={pz.productId} className="block">
                      <span className="mb-1 block text-xs text-ink-600">{pz.titulo}</span>
                      <select className="input" value={mezcla[i] || ""}
                        onChange={(e) => setMezcla((prev) => ({ ...prev, [i]: e.target.value }))}>
                        <option value="">Elegí…</option>
                        {pz.colores.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </label>
                  ))}
                  <button type="button" className="btn-ghost border border-line text-xs" onClick={agregarMezcla}>
                    <Plus size={14} /> Agregar
                  </button>
                </div>
              </div>
            </div>
          )}

          {conTalle && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-ink-600">Talles</p>
              <p className="mt-0.5 text-xs text-ink-500">
                El mismo talle en todas las prendas. Sólo aparecen los que tienen todas.
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {previa.tallesComunes.map((tl) => {
                  const fija = Boolean(bloqueadas?.talles.has(normTexto(tl)));
                  return (
                    <Chip key={tl} activo={tallesElegidos.some((x) => normTexto(x) === normTexto(tl))}
                      bloqueado={fija} titulo={fija ? "Ya es parte del combo" : undefined}
                      onClick={() => alternarTalle(tl)}>
                      {tl}
                    </Chip>
                  );
                })}
              </div>
            </div>
          )}

          {[...(previa.avisos || []), ...(previa.invalidas || [])].map((a, i) => (
            <p key={`${i}-${a}`} className="flex items-start gap-1.5 text-xs text-ink-600">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />{a}
            </p>
          ))}

          {!existente && (
            <div>
              <div className="grid gap-3 sm:grid-cols-4">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-ink-700">SKU del combo</span>
                  <input className="input font-mono" value={sku} maxLength={80}
                    onChange={(e) => { setSku(e.target.value); setSkuTocado(e.target.value.trim() !== ""); }} />
                </label>
                <label className="block sm:col-span-2">
                  <span className="mb-1 block text-xs font-medium text-ink-700">Nombre</span>
                  <input className="input" value={titulo} maxLength={120}
                    onChange={(e) => { setTitulo(e.target.value); setTituloTocado(true); }} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-ink-700">Precio del combo</span>
                  <input className="input" type="number" min="0" step="0.01" value={precio}
                    onChange={(e) => { setPrecio(e.target.value); setPrecioTocado(true); }} />
                </label>
              </div>
              <p className="mt-2 text-xs text-ink-500">
                Sugerido: la suma de las prendas, {formatCurrency(previa.precioMinorista)}. Es una sugerencia:
                la mayoría de los combos se venden con descuento.
              </p>
            </div>
          )}

          {filas.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-ink-700">
                {existente
                  ? `Se van a agregar ${aCrear.length} combinaci${aCrear.length === 1 ? "ón" : "ones"}`
                  : `Se van a crear ${aCrear.length} combo${aCrear.length === 1 ? "" : "s"}`}
              </p>
              <div className="max-h-72 overflow-auto rounded-md border border-line">
                <table className="w-full min-w-[480px] text-sm">
                  <thead className="sticky top-0 bg-paper-100">
                    <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-600">
                      <th className="px-2 py-1.5 font-medium"><span className="sr-only">Incluir</span></th>
                      <th className="px-2 py-1.5 font-medium">Combinación</th>
                      <th className="px-2 py-1.5 font-medium">Lleva</th>
                      <th className="px-2 py-1.5 font-medium">SKU</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filas.map((v) => {
                      const dentro = v.existe || !excluidos.has(v.clave);
                      return (
                        <tr key={v.clave} className="border-b border-line last:border-0">
                          <td className="px-2 py-1.5">
                            <input type="checkbox" checked={dentro} disabled={v.existe}
                              aria-label={`Incluir ${v.etiqueta || "el combo"}`}
                              onChange={() => alternarFila(v.clave)} />
                          </td>
                          <td className={`px-2 py-1.5 ${dentro ? "text-ink-800" : "text-ink-400 line-through"}`}>
                            {v.etiqueta || "Único"}
                          </td>
                          <td className="px-2 py-1.5 font-mono text-xs text-ink-500">
                            {v.componentes.map((c) => `${c.cantidad}× ${c.skuPadre}`).join(" + ")}
                          </td>
                          <td className="px-2 py-1.5 font-mono text-xs text-ink-600">
                            {v.sku}
                            {v.existe && (
                              <span className="ml-1 rounded bg-paper-200 px-1 py-0.5 text-[10px] text-ink-600">ya existe</span>
                            )}
                            {!v.existe && v.repetido && (
                              <span className="ml-1 rounded bg-paper-200 px-1 py-0.5 text-[10px] text-ink-600">
                                se le agrega un sufijo
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {previa.imposibles?.length > 0 && (
            <div className="rounded-md bg-paper-100 px-3 py-2">
              <p className="text-xs font-medium text-ink-700">
                No se pueden armar ({previa.imposibles.length}): a alguna prenda le falta esa variante
              </p>
              <ul className="mt-1 space-y-0.5 text-xs text-ink-500">
                {previa.imposibles.slice(0, 12).map((x) => (
                  <li key={x.clave}>{x.etiqueta || "Único"}: falta {x.faltan.join(", ")}.</li>
                ))}
                {previa.imposibles.length > 12 && <li>Y {previa.imposibles.length - 12} más.</li>}
              </ul>
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="mt-3 flex items-start gap-1.5 text-sm text-brick-700">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />{error}
        </p>
      )}

      <div className="mt-4 flex justify-end gap-2 border-t border-line pt-3">
        <button className="btn-ghost" onClick={onCerrar} disabled={guardando}>Cancelar</button>
        <button className="btn-primary" onClick={guardar} disabled={!puedeGuardar}>
          {guardando
            ? "Guardando…"
            : existente
              ? `Agregar ${aCrear.length || ""} combinaci${aCrear.length === 1 ? "ón" : "ones"}`
              : `Crear ${aCrear.length || ""} combo${aCrear.length === 1 ? "" : "s"}`}
        </button>
      </div>
    </Card>
  );
}

/*
 * Buscador del producto padre.
 *
 * Busca productos y no variantes: el pack se arma sobre el producto entero y
 * después se genera uno por combinación. Elegir una variante suelta llevaría a
 * pensar que el pack es de un solo talle.
 */
function BuscadorProducto({ valor, onElegir }) {
  const [term, setTerm] = useState("");
  const [resultados, setResultados] = useState([]);
  const [buscando, setBuscando] = useState(false);
  const [abierto, setAbierto] = useState(false);

  useEffect(() => {
    const q = term.trim();
    if (q.length < 2) { setResultados([]); return undefined; }
    setBuscando(true);
    const t = setTimeout(async () => {
      try {
        const { data } = await http.get("/products", { params: { search: q, limit: 10 } });
        setResultados(data.data || []);
      } catch { setResultados([]); }
      setBuscando(false);
    }, 250);
    return () => clearTimeout(t);
  }, [term]);

  if (valor) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-paper-100 px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm text-ink-900">{valor.titulo}</p>
          <p className="truncate text-xs text-ink-500">
            <span className="font-mono">{valor.skuAgrupador || valor.sku}</span>
            {" · "}{formatCurrency(valor.precioMinorista)} por unidad
          </p>
        </div>
        <button className="btn-ghost px-2 py-1 text-xs" onClick={() => onElegir(null)}>Cambiar</button>
      </div>
    );
  }

  return (
    <div className="relative">
      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
      <input
        className="input pl-9"
        placeholder="¿De qué producto es el pack? Buscá por nombre o SKU…"
        value={term}
        onChange={(e) => { setTerm(e.target.value); setAbierto(true); }}
        onFocus={() => setAbierto(true)}
        onBlur={() => setTimeout(() => setAbierto(false), 150)}
        autoComplete="off"
      />
      {abierto && term.trim().length >= 2 && (
        <div className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-line bg-paper-50 shadow-lg">
          {buscando && <p className="px-3 py-2 text-sm text-ink-500">Buscando…</p>}
          {!buscando && resultados.length === 0 && (
            <p className="px-3 py-2 text-sm text-ink-500">Sin resultados para “{term.trim()}”.</p>
          )}
          {resultados.map((p) => (
            <button
              type="button" key={p.id} onClick={() => onElegir(p)}
              className="flex w-full items-center justify-between gap-3 border-b border-line px-3 py-2 text-left text-sm last:border-0 hover:bg-paper-100"
            >
              <div className="min-w-0">
                <p className="truncate text-ink-900">{p.titulo}</p>
                <p className="truncate text-xs text-ink-500">
                  <span className="font-mono">{p.skuAgrupador || p.sku}</span>
                  {" · "}{formatCurrency(p.precioMinorista)}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
