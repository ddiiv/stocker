import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { fetchProductGroups, adjustVariantStock, createVariant, deleteVariant } from "../services/productService";
import { PageHeader, Card, EmptyState } from "../components/ui/Layout";
import { formatCurrency } from "../utils/formatters";
import { Boxes, PencilLine, Check } from "lucide-react";

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
    await adjustVariantStock(variant.id, { tipo, cantidad: Number(cantidad), motivo });
    load();
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
            {group.variants.map((v) => <VariantEditRow key={v.id} variant={v} onAdjust={handleAdjustStock} onDelete={handleDeleteVariant} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function VariantEditRow({ variant, onAdjust, onDelete }) {
  const [form, setForm] = useState({ tipo: "ingreso", cantidad: 1, motivo: "" });
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    await onAdjust(variant, form.tipo, form.cantidad, form.motivo);
    setSaving(false);
    setEditing(false);
  }

  const status = variant.stock === 0 ? "badge-out" : variant.stock <= variant.stockMinimo ? "badge-low" : "badge-ok";

  return (
    <tr className="border-b border-line last:border-0">
      <td className="px-4 py-3"><span className="tag-chip">{variant.sku}</span></td>
      <td className="px-4 py-3 text-ink-700">{variant.variante1Nombre && <><span className="text-ink-400 text-xs">{variant.variante1Nombre}:</span> {variant.variante1Valor}</>}</td>
      <td className="px-4 py-3 text-ink-700">{variant.variante2Nombre && <><span className="text-ink-400 text-xs">{variant.variante2Nombre}:</span> {variant.variante2Valor}</>}</td>
      <td className="px-4 py-3"><span className={`badge ${status}`}>{variant.stock} un.</span></td>
      <td className="px-4 py-3 text-ink-600">{variant.stockMinimo}</td>
      <td className="px-4 py-3">
        {editing ? (
          <div className="flex items-center gap-2">
            <select className="input h-8 w-28 text-xs" value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value })}>
              <option value="ingreso">Ingreso</option>
              <option value="egreso">Egreso</option>
              <option value="ajuste">Ajuste</option>
              <option value="devolucion">Devolución</option>
            </select>
            <input type="number" min="1" className="input h-8 w-16 text-xs" value={form.cantidad} onChange={(e) => setForm({ ...form, cantidad: e.target.value })} />
            <input type="text" className="input h-8 w-24 text-xs" placeholder="Motivo" value={form.motivo} onChange={(e) => setForm({ ...form, motivo: e.target.value })} />
            <button className="btn-accent px-2 py-1" onClick={save} disabled={saving}><Check size={13} /></button>
            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setEditing(false)}>✕</button>
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
