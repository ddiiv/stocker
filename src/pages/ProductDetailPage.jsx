import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { fetchProductGroups, adjustVariantStock, createVariant, deleteVariant, updateVariant, fetchVariantesPorLocal } from "../services/productService";
import { mensajeDeError } from "../utils/errores";
import { suggestSku, skuDisponible } from "../services/skuService";
import { ordenarVariantes, CRITERIOS } from "../utils/ordenVariantes";
import { useAuth } from "../context/AuthContext";
import { canEdit } from "../utils/permissions";
import { GrupoFiltro, OpcionFiltro } from "../components/ui/Filtros";
import { PageHeader, Card, EmptyState } from "../components/ui/Layout";
import AddVariantModal from "../components/products/AddVariantModal";
import BulkVariantsModal from "../components/products/BulkVariantsModal";
import EditProductModal from "../components/products/EditProductModal";
import CargaRapidaStock from "../components/products/CargaRapidaStock";
import CeldaPrecio from "../components/products/CeldaPrecio";
import { formatCurrency } from "../utils/formatters";
import { Boxes, PencilLine, Check, X, Wand2, Loader2, Tag, ListPlus, Store, MapPin, LayoutGrid } from "lucide-react";

export default function ProductDetailPage() {
  /*
   * Ver el stock de todos los locales lo puede hacer cualquier empleado del
   * negocio. Modificarlo —ajustar, cargar, cambiar precios, crear variantes—
   * pide permiso de edición.
   */
  const { user } = useAuth();
  const puedeEditar = canEdit(user, "stock");

  const { skuAgrupador } = useParams();
  const [group, setGroup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [masivoOpen, setMasivoOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [orden, setOrden] = useState("talle");
  const [cargaRapida, setCargaRapida] = useState(false);
  /*
   * El desglose por local del producto.
   *
   * Sin esto la columna "Stock" es el total de todos los locales y no lo dice:
   * se lee como "hay 32 acá" cuando pueden estar repartidas entre tres
   * sucursales. En un sistema con stock por local, un número sin lugar no
   * significa nada.
   */
  const [porLocal, setPorLocal] = useState(null);
  /*
   * A qué local se aplican los ajustes de esta pantalla.
   *
   * Antes no existía la pregunta porque el stock era uno solo. Ahora ajustar
   * sin decir dónde descontaría del local principal por descarte, que casi
   * nunca es el que uno tiene delante.
   */
  const [localAjuste, setLocalAjuste] = useState("");

  /*
   * `load` no lanza nunca: muestra su propio error y vuelve.
   *
   * Esa garantía es la que arregla dos cosas de una. Sin el `finally`, un
   * error dejaba la pantalla en esqueleto para siempre. Y como `load` se
   * llama al final de las operaciones —ajustar stock, guardar un SKU—, si
   * lanzaba, el catch de esa operación lo tomaba como propio: se ajustaba el
   * stock bien y el usuario leía "No se pudo ajustar el stock".
   */
  async function load() {
    setLoading(true);
    setLoadError("");
    let g = null;
    try {
      const groups = await fetchProductGroups({ search: skuAgrupador });
      g = groups.find((x) => x.skuAgrupador === skuAgrupador) || null;
      setGroup(g);
    } catch (e) {
      setLoadError(mensajeDeError(e, "No se pudo cargar el producto."));
      return;
    } finally {
      setLoading(false);
    }

    // El desglose se pide aparte y no bloquea el resto de la pantalla: si
    // fallara, el producto se sigue viendo con su total.
    const productId = g?.variants?.[0]?.productId;
    if (productId) {
      fetchVariantesPorLocal(productId)
        .then((d) => {
          setPorLocal(d);
          // Con un solo local no hay nada que elegir.
          setLocalAjuste((actual) => actual || (d.locales.length === 1 ? String(d.locales[0].id) : ""));
        })
        .catch(() => setPorLocal(null));
    }
  }

  useEffect(() => { load(); }, [skuAgrupador]);

  async function handleAdjustStock(variant, tipo, cantidad, motivo) {
    // El error se propaga a propósito: la fila lo muestra al lado del campo.
    // Antes se perdía en una promesa sin capturar y el botón quedaba trabado.
    // `locationId` va explícito: el ajuste es sobre el local elegido arriba.
    await adjustVariantStock(variant.id, {
      tipo, cantidad: Number(cantidad), motivo,
      locationId: localAjuste ? Number(localAjuste) : undefined,
    });
    await load();
  }

  /*
   * El producto al que se le cuelga la variante.
   *
   * Un agrupador puede abarcar más de un producto —pasa con datos importados—,
   * así que se toma el del primero. Con el alta desde el sistema siempre hay
   * uno solo.
   */
  async function handleCreateVariant(values) {
    const productId = group?.variants?.[0]?.productId;
    if (!productId) throw new Error("Este producto no tiene una variante de referencia.");
    await createVariant(productId, values);
    await load();
  }

  async function handleDeleteVariant(variant) {
    if (!confirm(`¿Eliminar la variante ${variant.sku}? Esta acción no se puede deshacer.`)) return;
    try {
      await deleteVariant(variant.id);
      load();
    } catch (err) {
      alert(err.response?.data?.message || "Error al eliminar la variante");
    }
  }

  const locales = porLocal?.locales || [];
  // Qué columnas de local se dibujan: todas, o sólo la elegida.
  const localesVisibles = localAjuste
    ? locales.filter((l) => String(l.id) === String(localAjuste))
    : locales;
  // variantId → [{ locationId, local, stock }]
  const stockDe = new Map((porLocal?.variantes || []).map((v) => [v.variantId, v.porLocal]));

  if (loading) return <div className="card h-64 animate-pulse bg-paper-200/60" />;
  if (loadError) {
    return (
      <div className="card">
        <p className="text-sm text-brick-500">{loadError}</p>
        <button className="btn-ghost mt-3" onClick={load}>Reintentar</button>
      </div>
    );
  }
  if (!group)  return <EmptyState icon={Boxes} title="Producto no encontrado" action={<Link to="/stock" className="btn-ghost">Volver a stock</Link>} />;

  return (
    <div>
      <AddVariantModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        group={group}
        onCreate={handleCreateVariant}
      />
      <BulkVariantsModal
        open={masivoOpen}
        onClose={() => setMasivoOpen(false)}
        group={group}
        onCreated={load}
      />
      <EditProductModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        group={group}
        onSaved={load}
      />

      <Link to="/stock" className="mb-4 inline-flex items-center gap-1 text-sm text-ink-600 hover:text-ink-950">
        <ArrowLeft size={15} /> Volver a stock
      </Link>
      <PageHeader
        title={group.title}
        subtitle={`${group.categoria || ""} · ${group.genero || ""} · SKU agrupador: ${group.skuAgrupador}`}
        actions={<>
          <Link to={`/stock/etiquetas?producto=${encodeURIComponent(group.skuAgrupador)}`} className="btn-ghost">
            <Tag size={15} /> Etiquetas
          </Link>
          {/* Las tres modifican el catálogo: sin permiso de edición no se
              muestran. Etiquetas y la vista por local quedan para todos. */}
          {puedeEditar && (
            <>
              <button className="btn-ghost" onClick={() => setCargaRapida((v) => !v)}>
                <ListPlus size={15} /> {cargaRapida ? "Salir de carga rápida" : "Cargar stock"}
              </button>
              <button className="btn-ghost" onClick={() => setEditOpen(true)}><PencilLine size={15} /> Editar producto</button>
              {/* La combinatoria desde la tabla maestra es el camino rápido; el
                  alta de a una queda para el caso suelto que no está en la tabla. */}
              <button className="btn-ghost" onClick={() => setMasivoOpen(true)}><LayoutGrid size={15} /> Desde tabla maestra</button>
              <button className="btn-accent" onClick={() => setAddOpen(true)}><Plus size={15} /> Nueva variante</button>
            </>
          )}
        </>}
      />

      <div className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card><p className="text-xs uppercase tracking-wide text-ink-600">Variantes</p><p className="mt-2 font-display text-lg font-semibold">{group.variants.length}</p></Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-ink-600">Stock total</p>
          <p className="mt-2 font-display text-lg font-semibold">{group.stockTotal} un.</p>
          {/* Cuántos locales suma ese total: es la diferencia entre "hay 32
              acá" y "hay 32 repartidas en tres sucursales". */}
          {locales.length > 1 && (
            <p className="mt-0.5 text-xs text-ink-500">sumando {locales.length} locales</p>
          )}
        </Card>
        <Card><p className="text-xs uppercase tracking-wide text-ink-600">Precio minorista</p><p className="mt-2 font-display text-lg font-semibold">{formatCurrency(group.precioDesde)}</p></Card>
        <Card><p className="text-xs uppercase tracking-wide text-ink-600">Precio mayorista</p><p className="mt-2 font-display text-lg font-semibold">{formatCurrency(group.variants[0]?.precioMayorista || 0)}</p></Card>
      </div>

      {cargaRapida && (
        <div className="mb-5">
          <CargaRapidaStock
            group={group}
            orden={orden}
            onCancelar={() => setCargaRapida(false)}
            /*
             * Se recarga el producto pero NO se sale del modo: al descargar un
             * remito se cargan varias tandas seguidas, y salir en cada guardado
             * obligaría a volver a entrar cada vez.
             */
            onListo={async () => { await load(); }}
          />
        </div>
      )}

      {/* El orden es de lectura, no de datos: se acomoda como se acomoda la
          mercadería, y el criterio depende de si se está mirando por talle o
          por color. */}
      {locales.length > 1 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-line bg-paper-50 px-3 py-2">
          <MapPin size={14} className="text-ink-500" />
          <span className="text-xs text-ink-700">Ver el stock de</span>
          {/* Un solo selector para las dos cosas: qué columna se destaca y
              sobre qué local operan los ajustes. Dos controles separados —uno
              para mirar y otro para editar— se desincronizan, y ahí es donde
              alguien ajusta el local que no estaba mirando. */}
          <select className="input w-auto py-1 text-xs" value={localAjuste}
            onChange={(e) => setLocalAjuste(e.target.value)}>
            <option value="">Todos los locales</option>
            {locales.map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
          </select>
          {puedeEditar && (
            <span className="text-xs text-ink-500">
              {localAjuste
                ? "Los ajustes se aplican en ese local."
                : "Elegí uno para poder ajustar el stock."}
            </span>
          )}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink-600">Ordenar variantes</span>
        <GrupoFiltro>
          {CRITERIOS.map((c) => (
            <OpcionFiltro key={c.value} activa={orden === c.value} onClick={() => setOrden(c.value)}>
              {c.label}
            </OpcionFiltro>
          ))}
        </GrupoFiltro>
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b border-line bg-paper-100 text-left text-xs uppercase tracking-wide text-ink-600">
              <th className="px-4 py-3 font-medium">SKU</th>
              <th className="px-4 py-3 font-medium">Dim 1</th>
              <th className="px-4 py-3 font-medium">Dim 2</th>
              {/* Una columna por local: el stock no es un número, es un número
                  EN un lugar. Con un solo local la fila no aporta nada y se
                  muestra sólo el total. */}
              {/* Con un local elegido se muestra sólo el suyo: la grilla
                  completa sirve para comparar, y una columna sola para
                  trabajar sobre ese local sin ruido al lado. */}
              {locales.length > 1 && localesVisibles.map((l) => (
                <th key={l.id} className="px-3 py-3 text-right font-medium">{l.nombre}</th>
              ))}
              <th className="px-4 py-3 text-right font-medium">
                {locales.length > 1 ? "Total" : "Stock"}
              </th>
              <th className="px-4 py-3 font-medium">Stock mín.</th>
              {/* El precio por variante: en gris cuando lo hereda del producto,
                  en negro cuando es propio. Sin esa distinción no hay forma de
                  saber por qué dos talles valen distinto. */}
              <th className="px-3 py-3 text-right font-medium">Minorista</th>
              <th className="px-3 py-3 text-right font-medium">Mayorista</th>
              <th className="px-4 py-3 font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {ordenarVariantes(group.variants, orden).map((v) => (
              <VariantEditRow key={v.id} variant={v}
                onAdjust={handleAdjustStock} onDelete={handleDeleteVariant}
                agrupador={group.skuAgrupador} onSaved={load}
                locales={locales} localesVisibles={localesVisibles}
                stockLocal={stockDe.get(v.id)}
                localElegido={localAjuste} puedeEditar={puedeEditar} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/*
 * El SKU de una variante, editable en el lugar.
 *
 * Se edita a mano porque la regla automática no cubre todo: un proveedor
 * impone su código, o una variante vieja quedó con un SKU que ya está impreso
 * en las etiquetas y cambiarlo costaría más que dejarlo.
 *
 * La disponibilidad se consulta mientras se escribe. El servidor igual la
 * verifica al guardar —es donde tiene que estar la garantía—, pero enterarse
 * recién al apretar Guardar significa perder lo tipeado y volver a empezar.
 */
function CeldaSku({ variant, agrupador, onSaved }) {
  const [editando, setEditando] = useState(false);
  const [valor, setValor] = useState(variant.sku);
  const [libre, setLibre] = useState(true);
  const [chequeando, setChequeando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!editando) return;
    const v = valor.trim();
    if (!v || v === variant.sku) { setLibre(true); setChequeando(false); return; }
    setChequeando(true);
    const t = setTimeout(() => {
      skuDisponible(v, variant.id)
        .then(setLibre)
        // Si la consulta falla no se bloquea la edición: el servidor decide al
        // guardar. Dar por ocupado algo que no se pudo verificar frenaría un
        // cambio válido por un corte de red.
        .catch(() => setLibre(true))
        .finally(() => setChequeando(false));
    }, 350);
    return () => clearTimeout(t);
  }, [valor, editando, variant.id, variant.sku]);

  async function sugerir() {
    setError("");
    try {
      const r = await suggestSku({
        agrupador,
        valores: [
          { eje: variant.variante1Nombre, valor: variant.variante1Valor },
          ...(variant.variante2Valor ? [{ eje: variant.variante2Nombre, valor: variant.variante2Valor }] : []),
        ],
        exceptoVariantId: variant.id,
      });
      setValor(r.sugerido || r.sku);
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo sugerir.");
    }
  }

  async function guardar() {
    const v = valor.trim();
    if (!v || v === variant.sku) { setEditando(false); setValor(variant.sku); return; }
    setGuardando(true); setError("");
    try {
      await updateVariant(variant.id, { sku: v });
      setEditando(false);
      await onSaved();
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo guardar el SKU.");
    } finally { setGuardando(false); }
  }

  function cancelar() { setEditando(false); setValor(variant.sku); setError(""); }

  if (!editando) {
    return (
      <button className="group flex items-center gap-1.5 text-left" onClick={() => setEditando(true)} title="Editar el SKU">
        <span className="tag-chip">{variant.sku}</span>
        <PencilLine size={12} className="text-ink-400 opacity-0 transition-opacity group-hover:opacity-100" />
      </button>
    );
  }

  const invalido = !valor.trim() || (!libre && valor.trim() !== variant.sku);

  return (
    <div className="min-w-[15rem]">
      <div className="flex items-center gap-1">
        <input
          autoFocus
          className={`input h-8 flex-1 font-mono text-xs ${invalido ? "border-brick-500" : ""}`}
          value={valor}
          maxLength={100}
          onChange={(e) => setValor(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") guardar(); if (e.key === "Escape") cancelar(); }}
        />
        <button className="btn-ghost px-1.5 py-1" onClick={sugerir} title="Sugerir según la regla del negocio">
          <Wand2 size={13} />
        </button>
        <button className="btn-accent px-1.5 py-1" onClick={guardar} disabled={guardando || invalido} title="Guardar">
          {guardando ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
        </button>
        <button className="btn-ghost px-1.5 py-1" onClick={cancelar} title="Cancelar"><X size={13} /></button>
      </div>
      {chequeando && <p className="mt-1 text-xs text-ink-500">Verificando…</p>}
      {!chequeando && !libre && <p className="mt-1 text-xs text-brick-500">Ese SKU ya lo usa otra variante.</p>}
      {error && <p className="mt-1 text-xs text-brick-500">{error}</p>}
    </div>
  );
}

function VariantEditRow({ variant, onAdjust, onDelete, agrupador, onSaved, locales = [], localesVisibles = [], stockLocal = [], localElegido, puedeEditar = true }) {
  const [form, setForm] = useState({ tipo: "ingreso", cantidad: 1, motivo: "" });
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  /*
   * Lo disponible es lo que hay EN EL LOCAL elegido, no el total.
   *
   * Con 32 en Palermo y 0 en Belgrano, validar contra el total dejaba pedir un
   * egreso de 5 en Belgrano y la comprobación pasaba: el rechazo llegaba
   * después, desde el servidor, con la mercadería ya contada como salida en la
   * cabeza del que la estaba cargando.
   */
  const disponible = locales.length > 1 && localElegido
    ? ((stockLocal || []).find((x) => String(x.locationId) === String(localElegido))?.stock ?? 0)
    : (Number(variant.stock) || 0);
  const nombreLocal = locales.find((l) => String(l.id) === String(localElegido))?.nombre;
  const pedido = Number(form.cantidad) || 0;
  /*
   * Un egreso no puede superar el stock actual. El backend lo rechaza igual;
   * avisarlo acá evita que el usuario mande un movimiento que ya se sabe que va
   * a fallar. Para corregir un número mal cargado está el ajuste, que fija el
   * stock en vez de descontarlo.
   */
  const excede = form.tipo === "egreso" && pedido > disponible;

  async function save() {
    if (excede) return;
    setSaving(true); setError("");
    try {
      await onAdjust(variant, form.tipo, form.cantidad, form.motivo);
      setEditing(false);
    } catch (err) {
      setError(err.response?.data?.message || "No se pudo ajustar el stock.");
    } finally {
      setSaving(false);
    }
  }

  const status = variant.stock === 0 ? "badge-out" : variant.stock <= variant.stockMinimo ? "badge-low" : "badge-ok";

  return (
    <tr className="border-b border-line last:border-0">
      <td className="px-4 py-3">
        {puedeEditar
          ? <CeldaSku variant={variant} agrupador={agrupador} onSaved={onSaved} />
          : <span className="tag-chip">{variant.sku}</span>}
      </td>
      <td className="px-4 py-3 text-ink-700">{variant.variante1Nombre && <><span className="text-ink-400 text-xs">{variant.variante1Nombre}:</span> {variant.variante1Valor}</>}</td>
      <td className="px-4 py-3 text-ink-700">{variant.variante2Nombre && <><span className="text-ink-400 text-xs">{variant.variante2Nombre}:</span> {variant.variante2Valor}</>}</td>
      {/* El stock de cada local, y después el total. El cero se apaga: lo que
          se busca de un vistazo es dónde SÍ hay. */}
      {locales.length > 1 && localesVisibles.map((l) => {
        const n = (stockLocal || []).find((x) => x.locationId === l.id)?.stock ?? 0;
        return (
          <td key={l.id} className="px-3 py-3 text-right tabular-nums">
            <span className={n === 0 ? "text-ink-300" : "text-ink-900"}>{n}</span>
          </td>
        );
      })}
      <td className="px-4 py-3 text-right"><span className={`badge ${status}`}>{variant.stock} un.</span></td>
      <td className="px-4 py-3 text-ink-600">{variant.stockMinimo}</td>
      <td className="px-3 py-3"><CeldaPrecio variant={variant} campo="precioMinorista" onSaved={onSaved} soloLectura={!puedeEditar} /></td>
      <td className="px-3 py-3"><CeldaPrecio variant={variant} campo="precioMayorista" onSaved={onSaved} soloLectura={!puedeEditar} /></td>
      <td className="px-4 py-3">
        {editing ? (
          <div>
          <div className="flex items-center gap-2">
            <select className="input h-8 w-28 text-xs" value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value })}>
              <option value="ingreso">Ingreso</option>
              <option value="egreso">Egreso</option>
              <option value="ajuste">Ajuste</option>
              <option value="devolucion">Devolución</option>
            </select>
            <input
              type="number" min="1"
              max={form.tipo === "egreso" ? disponible : undefined}
              className={`input h-8 w-16 text-xs ${excede ? "border-brick-500" : ""}`}
              value={form.cantidad}
              onChange={(e) => setForm({ ...form, cantidad: e.target.value })}
            />
            <input type="text" className="input h-8 w-24 text-xs" placeholder="Motivo" value={form.motivo} onChange={(e) => setForm({ ...form, motivo: e.target.value })} />
            {nombreLocal && (
              <span className="flex items-center gap-1 whitespace-nowrap text-xs text-ink-600">
                <Store size={12} /> {nombreLocal}
              </span>
            )}
            <button className="btn-accent px-2 py-1" onClick={save} disabled={saving || excede}><Check size={13} /></button>
            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => { setEditing(false); setError(""); }}>✕</button>
          </div>
          {excede && (
            <p className="mt-1 text-xs text-brick-500">
              Sólo hay {disponible}{nombreLocal ? ` en ${nombreLocal}` : ""}. Para corregir el número usá «Ajuste».
            </p>
          )}
          {error && <p className="mt-1 text-xs text-brick-500">{error}</p>}
          </div>
        ) : (
          <div className="flex gap-1">
            {!puedeEditar ? (
              <span className="text-xs text-ink-400">Sólo lectura</span>
            ) : (<>
            <button className="btn-ghost px-2 py-1.5 text-xs"
              onClick={() => setEditing(true)}
              disabled={locales.length > 1 && !localElegido}
              title={locales.length > 1 && !localElegido ? "Elegí primero en qué local" : "Ajustar stock"}>
              <PencilLine size={13} /> Ajustar stock
            </button>
            <button className="btn-ghost px-2 py-1.5 text-xs text-brick-500" title="Eliminar variante" onClick={() => onDelete(variant)}><Trash2 size={13} /></button>
            </>)}
          </div>
        )}
      </td>
    </tr>
  );
}
