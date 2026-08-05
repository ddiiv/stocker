import { useEffect, useState } from "react";
import { Plus, Tag, PencilLine, Trash2, X } from "lucide-react";
import { fetchVariantTypes, createVariantType, updateVariantType, deleteVariantType } from "../services/variantTypeService";
import { EmptyState, Card, PageHeader } from "../components/ui/Layout";
import Modal from "../components/ui/Modal";
import StockTabs from "../components/stock/StockTabs";

export default function VariantTypesPage() {
  const [types, setTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      setTypes(await fetchVariantTypes());
    } catch (e) {
      setError(e.response?.data?.message || "Error al cargar variantes");
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function handleDelete(v) {
    if (!confirm(`¿Eliminar la variante "${v.nombre}"? Los productos ya creados con ella no se van a modificar, pero no vas a poder elegirla para nuevos productos.`)) return;
    try {
      await deleteVariantType(v.id);
      await load();
    } catch (e) { alert(e.response?.data?.message || "Error al eliminar"); }
  }

  return (
    <div>
      <PageHeader title="Stock" subtitle="Productos, variantes maestras y stock" />
      <StockTabs />
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="font-display text-lg font-semibold text-ink-950">Variantes maestras</h3>
          <p className="text-sm text-ink-600">Definí acá los tipos de variante (Color, Talle, etc.) que vas a poder elegir al crear un producto.</p>
        </div>
        <button className="btn-accent" onClick={() => { setEditing(null); setModal(true); }}>
          <Plus size={15} /> Nueva variante
        </button>
      </div>

      {error && <p className="mb-4 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}

      {loading ? (
        <div className="card p-0">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-20 animate-pulse border-b border-line last:border-0" />)}</div>
      ) : types.length === 0 ? (
        <EmptyState icon={Tag} title="Sin variantes cargadas" description='Creá tu primera variante (ej. "Color" con Rojo, Azul, Verde).' />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {types.map((v) => (
            <Card key={v.id}>
              <div className="mb-3 flex items-start justify-between gap-2">
                <div>
                  <p className="font-display text-base font-semibold text-ink-950">{v.nombre}</p>
                  <p className="text-xs text-ink-600">{v.valores.length} valores</p>
                </div>
                <div className="flex gap-1">
                  <button className="btn-ghost px-2 py-1.5" title="Editar" onClick={() => { setEditing(v); setModal(true); }}><PencilLine size={14} /></button>
                  <button className="btn-ghost px-2 py-1.5" title="Eliminar" onClick={() => handleDelete(v)}><Trash2 size={14} /></button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {v.valores.map((val) => <span key={val} className="tag-chip">{val}</span>)}
              </div>
            </Card>
          ))}
        </div>
      )}

      <VariantFormModal open={modal} onClose={() => setModal(false)} onSaved={() => { setModal(false); load(); }} variant={editing} />
    </div>
  );
}

function VariantFormModal({ open, onClose, onSaved, variant }) {
  const [nombre, setNombre] = useState("");
  const [valores, setValores] = useState([]);
  const [nuevo, setNuevo] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setNombre(variant?.nombre || "");
    setValores(variant?.valores || []);
    setNuevo("");
    setError("");
  }, [variant, open]);

  function addValor() {
    const v = nuevo.trim();
    if (!v) return;
    if (valores.includes(v)) { setNuevo(""); return; }
    setValores((arr) => [...arr, v]);
    setNuevo("");
  }
  function removeValor(v) { setValores((arr) => arr.filter((x) => x !== v)); }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (!nombre.trim()) return setError("El nombre es obligatorio.");
    if (valores.length === 0) return setError("Agregá al menos un valor.");
    setSaving(true);
    try {
      if (variant) await updateVariantType(variant.id, { nombre: nombre.trim(), valores });
      else await createVariantType({ nombre: nombre.trim(), valores });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.message || "Error al guardar");
    } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={variant ? `Editar variante: ${variant.nombre}` : "Nueva variante"} width="max-w-lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}
        <div>
          <label className="label">Nombre de la variante *</label>
          <input className="input" required minLength={2} maxLength={80} value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Ej: Color, Talle, Sabor…" />
        </div>
        <div>
          <label className="label">Valores posibles</label>
          <div className="mb-2 flex gap-2">
            <input
              className="input flex-1"
              maxLength={60}
              value={nuevo}
              onChange={(e) => setNuevo(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addValor(); } }}
              placeholder='Escribí un valor y Enter (ej. "Rojo")'
            />
            <button type="button" className="btn-ghost" onClick={addValor}>Agregar</button>
          </div>
          {valores.length === 0 ? (
            <p className="text-xs text-ink-500">Sin valores todavía.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {valores.map((v) => (
                <span key={v} className="inline-flex items-center gap-1 rounded-md bg-paper-200 px-2 py-1 text-xs text-ink-900">
                  {v}
                  <button type="button" className="text-ink-500 hover:text-brick-500" onClick={() => removeValor(v)}><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn-accent" disabled={saving}>{saving ? "Guardando…" : (variant ? "Guardar cambios" : "Crear variante")}</button>
        </div>
      </form>
    </Modal>
  );
}
