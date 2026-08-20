import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Search, Boxes, RefreshCw, Plus, Download, Upload, Trash2 } from "lucide-react";
import { fetchProductGroups, createProduct, deleteProduct, exportProductsExcel, importProductsExcel } from "../services/productService";
import { fetchVariantTypes } from "../services/variantTypeService";
import { formatCurrency } from "../utils/formatters";
import { PageHeader, EmptyState } from "../components/ui/Layout";
import Modal from "../components/ui/Modal";
import { useForm } from "react-hook-form";
import StockTabs from "../components/stock/StockTabs";

export default function StockPage() {
  const [search, setSearch] = useState("");
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [newProductOpen, setNewProductOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [importError, setImportError] = useState("");
  const fileInputRef = useRef(null);

  async function load(term = "") {
    setLoading(true);
    setError("");
    try {
      const data = await fetchProductGroups({ search: term });
      setGroups(data);
    } catch (e) {
      setError(e.response?.data?.message || "Error al cargar productos");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);
  useEffect(() => { const t = setTimeout(() => load(search), 300); return () => clearTimeout(t); }, [search]);

  async function handleExport() {
    setExporting(true);
    try {
      await exportProductsExcel();
    } catch (e) {
      setError(e.response?.data?.message || "Error al exportar productos");
    } finally {
      setExporting(false);
    }
  }

  function handleImportClick() {
    fileInputRef.current?.click();
  }

  async function handleDeleteGroup(g) {
    if (!confirm(`¿Eliminar el producto "${g.title}" y todas sus variantes? Esta acción no se puede deshacer.`)) return;
    try {
      // Un grupo puede tener varios productos padre; los eliminamos todos
      await Promise.all(g.variants.map((v) => deleteProduct(v.productId)));
      await load(search);
    } catch (err) {
      alert(err.response?.data?.message || "Error al eliminar el producto");
    }
  }

  async function handleImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImporting(true);
    setImportError("");
    setImportResult(null);
    try {
      const summary = await importProductsExcel(file);
      setImportResult(summary);
      await load(search);
    } catch (err) {
      setImportError(err.response?.data?.message || "Error al importar el archivo");
    } finally {
      setImporting(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Stock"
        subtitle="Productos agrupados por SKU agrupador. Hacé click en uno para ver y editar sus variantes."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileInputRef} type="file" accept=".xlsx" className="hidden" onChange={handleImportFile} />
            <button className="btn-ghost" onClick={handleImportClick} disabled={importing}>
              <Upload size={15} /> {importing ? "Importando…" : "Importar Excel"}
            </button>
            <button className="btn-ghost" onClick={handleExport} disabled={exporting}>
              <Download size={15} /> {exporting ? "Exportando…" : "Exportar Excel"}
            </button>
            <button className="btn-accent" onClick={() => setNewProductOpen(true)}>
              <Plus size={15} /> Nuevo producto
            </button>
          </div>
        }
      />

      <StockTabs />

      {error && <p className="mb-4 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}
      {importError && <p className="mb-4 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{importError}</p>}
      {importResult && (
        <div className="mb-4 rounded-md border border-line bg-paper-100 px-3 py-2 text-sm text-ink-700">
          <p>
            Importación completa: {importResult.productsCreated} productos creados, {importResult.productsUpdated} actualizados,{" "}
            {importResult.variantsCreated} variantes creadas, {importResult.variantsUpdated} actualizadas.
          </p>
          {importResult.errors?.length > 0 && (
            <ul className="mt-2 list-inside list-disc text-brick-500">
              {importResult.errors.map((msg, i) => <li key={i}>{msg}</li>)}
            </ul>
          )}
        </div>
      )}

      <div className="mb-5 flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input className="input pl-9" placeholder="Buscar por título o SKU…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <button className="btn-ghost" onClick={() => load(search)}>
          <RefreshCw size={15} /> Actualizar
        </button>
      </div>

      {loading ? (
        <div className="card p-0">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-16 animate-pulse border-b border-line last:border-0" />)}</div>
      ) : groups.length === 0 ? (
        <EmptyState icon={Boxes} title="No se encontraron productos" description={search ? `Sin resultados para "${search}".` : "Todavía no cargaste productos."} />
      ) : (
        /* La tabla scrollea de costado en pantallas chicas. Con
           `overflow-hidden` sus últimas columnas quedaban cortadas y sin forma
           de alcanzarlas: 615 px de tabla dentro de 341 de pantalla. El `min-w`
           evita que las columnas se compriman hasta volverse ilegibles. */
        <div className="card overflow-x-auto p-0">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-line bg-paper-100 text-left text-xs uppercase tracking-wide text-ink-600">
                <th className="px-4 py-3 font-medium">Producto</th>
                <th className="px-4 py-3 font-medium">Categoría</th>
                <th className="px-4 py-3 font-medium">Variantes</th>
                <th className="px-4 py-3 font-medium">Precio desde</th>
                <th className="px-4 py-3 font-medium">Stock total</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.skuAgrupador} className="border-b border-line last:border-0 hover:bg-paper-100/70">
                  <td className="px-4 py-3">
                    <p className="font-medium text-ink-900">{g.title}</p>
                    <span className="tag-chip mt-1">{g.skuAgrupador}</span>
                  </td>
                  <td className="px-4 py-3 text-ink-700">{g.categoria} · {g.genero}</td>
                  <td className="px-4 py-3 text-ink-700">{g.variants.length} ({g.colores.length} colores, {g.talles.length} talles)</td>
                  <td className="px-4 py-3 text-ink-900">{formatCurrency(g.precioDesde)}</td>
                  <td className="px-4 py-3">
                    <span className={`badge ${g.stockTotal === 0 ? "badge-out" : g.stockTotal <= 10 ? "badge-low" : "badge-ok"}`}>
                      {g.stockTotal} un.
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      <Link to={`/stock/${g.skuAgrupador}`} className="btn-ghost px-3 py-1.5 text-xs">Ver / editar</Link>
                      <button className="btn-ghost px-2 py-1.5 text-brick-500" title="Eliminar producto" onClick={() => handleDeleteGroup(g)}><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <NewProductModal open={newProductOpen} onClose={() => setNewProductOpen(false)} onCreated={() => { setNewProductOpen(false); load(search); }} />
    </div>
  );
}

function NewProductModal({ open, onClose, onCreated }) {
  const { register, handleSubmit, formState: { errors, isSubmitting }, reset } = useForm();
  const [serverError, setServerError] = useState("");
  const [variantTypes, setVariantTypes] = useState([]);
  const [dim1TypeId, setDim1TypeId] = useState("");
  const [dim1Selected, setDim1Selected] = useState([]);
  const [dim2TypeId, setDim2TypeId] = useState("");
  const [dim2Selected, setDim2Selected] = useState([]);

  useEffect(() => {
    if (open) {
      fetchVariantTypes().then(setVariantTypes).catch(() => setVariantTypes([]));
      setDim1TypeId(""); setDim1Selected([]); setDim2TypeId(""); setDim2Selected([]);
      setServerError("");
    }
  }, [open]);

  const dim1Type = variantTypes.find((v) => String(v.id) === String(dim1TypeId));
  const dim2Type = variantTypes.find((v) => String(v.id) === String(dim2TypeId));
  const availableDim2 = variantTypes.filter((v) => String(v.id) !== String(dim1TypeId));

  function toggle(arrSet, val, setter) {
    setter(arrSet.includes(val) ? arrSet.filter((x) => x !== val) : [...arrSet, val]);
  }

  async function onSubmit(values) {
    setServerError("");
    const variantes = {};
    if (dim1Type && dim1Selected.length > 0) variantes[dim1Type.nombre] = dim1Selected;
    if (dim2Type && dim2Selected.length > 0) variantes[dim2Type.nombre] = dim2Selected;
    try {
      await createProduct({
        titulo: values.titulo, sku: values.sku, skuAgrupador: values.skuAgrupador,
        descripcion: values.descripcion, precioMinorista: Number(values.precioMinorista),
        precioMayorista: Number(values.precioMayorista), costo: Number(values.costo),
        categoria: values.categoria, genero: values.genero, modelo: values.modelo, variantes,
      });
      reset();
      onCreated();
    } catch (e) {
      setServerError(e.response?.data?.message || "Error al crear el producto");
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Nuevo producto" width="max-w-2xl">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {serverError && <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{serverError}</p>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="label">Título *</label>
            <input className="input" maxLength={200} {...register("titulo", { required: "Obligatorio", minLength: { value: 2, message: "Mínimo 2 caracteres" } })} />
            {errors.titulo && <p className="field-error">{errors.titulo.message}</p>}
          </div>
          <div>
            <label className="label">SKU padre *</label>
            <input className="input font-mono uppercase" maxLength={80} {...register("sku", { required: "Obligatorio", pattern: { value: /^[A-Za-z0-9._-]+$/, message: "Solo letras, números, . _ -" } })} />
            {errors.sku && <p className="field-error">{errors.sku.message}</p>}
          </div>
          <div>
            <label className="label">SKU agrupador *</label>
            <input className="input font-mono uppercase" maxLength={80} {...register("skuAgrupador", { required: "Obligatorio", pattern: { value: /^[A-Za-z0-9._-]+$/, message: "Solo letras, números, . _ -" } })} />
            {errors.skuAgrupador && <p className="field-error">{errors.skuAgrupador.message}</p>}
          </div>
          <div><label className="label">Modelo</label><input className="input" maxLength={80} {...register("modelo")} /></div>
          <div><label className="label">Categoría</label><input className="input" maxLength={80} {...register("categoria")} /></div>
          <div><label className="label">Género</label><input className="input" maxLength={40} {...register("genero")} /></div>
          <div>
            <label className="label">Costo</label>
            <input className="input" type="number" min="0" step="0.01" inputMode="decimal" {...register("costo", { min: { value: 0, message: "No puede ser negativo" } })} />
            {errors.costo && <p className="field-error">{errors.costo.message}</p>}
          </div>
          <div>
            <label className="label">Precio minorista</label>
            <input className="input" type="number" min="0" step="0.01" inputMode="decimal" {...register("precioMinorista", { min: { value: 0, message: "No puede ser negativo" } })} />
            {errors.precioMinorista && <p className="field-error">{errors.precioMinorista.message}</p>}
          </div>
          <div>
            <label className="label">Precio mayorista (≥3 prendas)</label>
            <input className="input" type="number" min="0" step="0.01" inputMode="decimal" {...register("precioMayorista", { min: { value: 0, message: "No puede ser negativo" } })} />
            {errors.precioMayorista && <p className="field-error">{errors.precioMayorista.message}</p>}
          </div>
        </div>
        <div><label className="label">Descripción</label><textarea className="input min-h-16" {...register("descripcion")} /></div>

        <div className="rounded-md border border-line bg-paper-50 p-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-600">Variantes del producto</p>
          {variantTypes.length === 0 ? (
            <p className="text-sm text-ink-600">
              Todavía no cargaste variantes maestras. <Link to="/stock/variantes" className="text-brass-600 hover:underline">Crear la primera →</Link>
            </p>
          ) : (
            <div className="space-y-4">
              <VariantPicker
                label="Variante 1 (opcional)"
                types={variantTypes}
                selectedTypeId={dim1TypeId}
                onSelectType={(id) => { setDim1TypeId(id); setDim1Selected([]); }}
                selectedValues={dim1Selected}
                onToggleValue={(val) => toggle(dim1Selected, val, setDim1Selected)}
                type={dim1Type}
              />
              {dim1Type && (
                <VariantPicker
                  label="Variante 2 (opcional)"
                  types={availableDim2}
                  selectedTypeId={dim2TypeId}
                  onSelectType={(id) => { setDim2TypeId(id); setDim2Selected([]); }}
                  selectedValues={dim2Selected}
                  onToggleValue={(val) => toggle(dim2Selected, val, setDim2Selected)}
                  type={dim2Type}
                />
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn-accent" disabled={isSubmitting}>{isSubmitting ? "Creando…" : "Crear producto"}</button>
        </div>
      </form>
    </Modal>
  );
}

function VariantPicker({ label, types, selectedTypeId, onSelectType, selectedValues, onToggleValue, type }) {
  return (
    <div>
      <label className="label">{label}</label>
      <select className="input mb-2" value={selectedTypeId} onChange={(e) => onSelectType(e.target.value)}>
        <option value="">— Sin variante —</option>
        {types.map((t) => <option key={t.id} value={t.id}>{t.nombre} ({t.valores.length} valores)</option>)}
      </select>
      {type && (
        <div>
          <p className="mb-1 text-xs text-ink-600">Elegí qué valores de <strong>{type.nombre}</strong> usar en este producto:</p>
          <div className="flex flex-wrap gap-2">
            {type.valores.map((v) => {
              const active = selectedValues.includes(v);
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => onToggleValue(v)}
                  className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                    active
                      ? "border-brass-500 bg-brass-500 text-ink-950"
                      : "border-line bg-paper-50 text-ink-700 hover:bg-paper-200"
                  }`}
                >
                  {v}
                </button>
              );
            })}
          </div>
          {selectedValues.length === 0 && <p className="mt-1 text-xs text-ink-500">Ninguno seleccionado — no se van a generar variantes para esta dimensión.</p>}
        </div>
      )}
    </div>
  );
}
