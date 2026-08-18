import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { fetchProductGroups, adjustVariantStock, createVariant, deleteVariant, updateVariant } from "../services/productService";
import { suggestSku, skuDisponible } from "../services/skuService";
import { PageHeader, Card, EmptyState } from "../components/ui/Layout";
import AddVariantModal from "../components/products/AddVariantModal";
import { formatCurrency } from "../utils/formatters";
import { Boxes, PencilLine, Check, X, Wand2, Loader2 } from "lucide-react";

export default function ProductDetailPage() {
  const { skuAgrupador } = useParams();
  const [group, setGroup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);

  async function load() {
    setLoading(true);
    const groups = await fetchProductGroups({ search: skuAgrupador });
    setGroup(groups.find((g) => g.skuAgrupador === skuAgrupador) || null);
    setLoading(false);
  }

  useEffect(() => { load(); }, [skuAgrupador]);

  async function handleAdjustStock(variant, tipo, cantidad, motivo) {
    // El error se propaga a propósito: la fila lo muestra al lado del campo.
    // Antes se perdía en una promesa sin capturar y el botón quedaba trabado.
    await adjustVariantStock(variant.id, { tipo, cantidad: Number(cantidad), motivo });
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

  if (loading) return <div className="card h-64 animate-pulse bg-paper-200/60" />;
  if (!group)  return <EmptyState icon={Boxes} title="Producto no encontrado" action={<Link to="/stock" className="btn-ghost">Volver a stock</Link>} />;

  return (
    <div>
      <AddVariantModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        group={group}
        onCreate={handleCreateVariant}
      />

      <Link to="/stock" className="mb-4 inline-flex items-center gap-1 text-sm text-ink-600 hover:text-ink-950">
        <ArrowLeft size={15} /> Volver a stock
      </Link>
      <PageHeader
        title={group.title}
        subtitle={`${group.categoria || ""} · ${group.genero || ""} · SKU agrupador: ${group.skuAgrupador}`}
        actions={<button className="btn-accent" onClick={() => setAddOpen(true)}><Plus size={15} /> Nueva variante</button>}
      />

      <div className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card><p className="text-xs uppercase tracking-wide text-ink-600">Variantes</p><p className="mt-2 font-display text-lg font-semibold">{group.variants.length}</p></Card>
        <Card><p className="text-xs uppercase tracking-wide text-ink-600">Stock total</p><p className="mt-2 font-display text-lg font-semibold">{group.stockTotal} un.</p></Card>
        <Card><p className="text-xs uppercase tracking-wide text-ink-600">Precio minorista</p><p className="mt-2 font-display text-lg font-semibold">{formatCurrency(group.precioDesde)}</p></Card>
        <Card><p className="text-xs uppercase tracking-wide text-ink-600">Precio mayorista</p><p className="mt-2 font-display text-lg font-semibold">{formatCurrency(group.variants[0]?.precioMayorista || 0)}</p></Card>
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[700px] text-sm">
          <thead>
            <tr className="border-b border-line bg-paper-100 text-left text-xs uppercase tracking-wide text-ink-600">
              <th className="px-4 py-3 font-medium">SKU</th>
              <th className="px-4 py-3 font-medium">Dim 1</th>
              <th className="px-4 py-3 font-medium">Dim 2</th>
              <th className="px-4 py-3 font-medium">Stock</th>
              <th className="px-4 py-3 font-medium">Stock mín.</th>
              <th className="px-4 py-3 font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {group.variants.map((v) => (
              <VariantEditRow key={v.id} variant={v}
                onAdjust={handleAdjustStock} onDelete={handleDeleteVariant}
                agrupador={group.skuAgrupador} onSaved={load} />
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

function VariantEditRow({ variant, onAdjust, onDelete, agrupador, onSaved }) {
  const [form, setForm] = useState({ tipo: "ingreso", cantidad: 1, motivo: "" });
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const disponible = Number(variant.stock) || 0;
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
      <td className="px-4 py-3"><CeldaSku variant={variant} agrupador={agrupador} onSaved={onSaved} /></td>
      <td className="px-4 py-3 text-ink-700">{variant.variante1Nombre && <><span className="text-ink-400 text-xs">{variant.variante1Nombre}:</span> {variant.variante1Valor}</>}</td>
      <td className="px-4 py-3 text-ink-700">{variant.variante2Nombre && <><span className="text-ink-400 text-xs">{variant.variante2Nombre}:</span> {variant.variante2Valor}</>}</td>
      <td className="px-4 py-3"><span className={`badge ${status}`}>{variant.stock} un.</span></td>
      <td className="px-4 py-3 text-ink-600">{variant.stockMinimo}</td>
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
            <button className="btn-accent px-2 py-1" onClick={save} disabled={saving || excede}><Check size={13} /></button>
            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => { setEditing(false); setError(""); }}>✕</button>
          </div>
          {excede && (
            <p className="mt-1 text-xs text-brick-500">
              Sólo hay {disponible}. Para corregir el número usá «Ajuste».
            </p>
          )}
          {error && <p className="mt-1 text-xs text-brick-500">{error}</p>}
          </div>
        ) : (
          <div className="flex gap-1">
            <button className="btn-ghost px-2 py-1.5 text-xs" onClick={() => setEditing(true)}><PencilLine size={13} /> Ajustar stock</button>
            <button className="btn-ghost px-2 py-1.5 text-xs text-brick-500" title="Eliminar variante" onClick={() => onDelete(variant)}><Trash2 size={13} /></button>
          </div>
        )}
      </td>
    </tr>
  );
}
