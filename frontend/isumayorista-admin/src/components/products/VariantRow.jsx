import { useState } from "react";
import { Check, Trash2, PencilLine } from "lucide-react";
import { formatCurrency } from "../../utils/formatters";

export default function VariantRow({ variant, onSave, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    costo: variant.costo,
    precio: variant.precio,
    stock: variant.stock,
    stockMinimo: variant.stockMinimo,
  });
  const [saving, setSaving] = useState(false);

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function save() {
    setSaving(true);
    try {
      await onSave(variant, form);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  const status = variant.stock === 0 ? "badge-out" : variant.stock <= variant.stockMinimo ? "badge-low" : "badge-ok";

  return (
    <tr className="border-b border-line last:border-0">
      <td className="px-4 py-3">
        <span className="tag-chip">{variant.sku}</span>
      </td>
      <td className="px-4 py-3 text-ink-700">{variant.talle}</td>
      <td className="px-4 py-3 text-ink-700">{variant.color}</td>
      <td className="px-4 py-3">
        {editing ? (
          <input
            className="input h-8 w-24 text-xs"
            type="number"
            value={form.costo}
            onChange={(e) => set("costo", Number(e.target.value))}
          />
        ) : (
          formatCurrency(variant.costo)
        )}
      </td>
      <td className="px-4 py-3">
        {editing ? (
          <input
            className="input h-8 w-24 text-xs"
            type="number"
            value={form.precio}
            onChange={(e) => set("precio", Number(e.target.value))}
          />
        ) : (
          <span className="font-medium text-ink-900">{formatCurrency(variant.precio)}</span>
        )}
      </td>
      <td className="px-4 py-3">
        {editing ? (
          <input
            className="input h-8 w-20 text-xs"
            type="number"
            value={form.stock}
            onChange={(e) => set("stock", Number(e.target.value))}
          />
        ) : (
          <span className={`badge ${status}`}>{variant.stock} un.</span>
        )}
      </td>
      <td className="px-4 py-3">
        {editing ? (
          <input
            className="input h-8 w-16 text-xs"
            type="number"
            value={form.stockMinimo}
            onChange={(e) => set("stockMinimo", Number(e.target.value))}
          />
        ) : (
          <span className="text-ink-600">{variant.stockMinimo}</span>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        <div className="flex justify-end gap-1">
          {editing ? (
            <button className="btn-accent px-2 py-1.5" onClick={save} disabled={saving} title="Guardar">
              <Check size={14} />
            </button>
          ) : (
            <button className="btn-ghost px-2 py-1.5" onClick={() => setEditing(true)} title="Editar">
              <PencilLine size={14} />
            </button>
          )}
          <button className="btn-danger px-2 py-1.5" onClick={() => onDelete(variant)} title="Eliminar variante">
            <Trash2 size={14} />
          </button>
        </div>
      </td>
    </tr>
  );
}
