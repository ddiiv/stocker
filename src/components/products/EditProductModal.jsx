import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import Modal from "../ui/Modal";
import { updateProduct } from "../../services/productService";

/*
 * Edición del producto padre.
 *
 * Son los datos que comparten todas sus variantes: cómo se llama, a cuánto se
 * vende y cómo se clasifica. El stock y el SKU no están acá porque son de cada
 * variante y se editan en su fila.
 *
 * Los precios viven en el producto y no en la variante: un talle M y un XL del
 * mismo modelo valen lo mismo. Por eso cambiarlos acá los cambia para todas, y
 * conviene que se vea que es así.
 */
export default function EditProductModal({ open, onClose, group, onSaved }) {
  const [error, setError] = useState("");
  // El primer variante trae los datos del padre: el agrupador puede abarcar más
  // de un producto, pero el alta desde el sistema siempre crea uno solo.
  const base = group?.variants?.[0];

  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm();

  useEffect(() => {
    if (!open || !group) return;
    reset({
      titulo: group.title || "",
      modelo: group.modelo || "",
      categoria: group.categoria || "",
      genero: group.genero || "",
      descripcion: group.descripcion || "",
      costo: base?.costo ?? 0,
      precioMinorista: base?.precio ?? 0,
      precioMayorista: base?.precioMayorista ?? 0,
    });
    setError("");
  }, [open, group, base, reset]);

  async function onSubmit(v) {
    setError("");
    if (!base?.productId) { setError("Este producto no tiene una variante de referencia."); return; }
    try {
      await updateProduct(base.productId, {
        titulo: v.titulo.trim(),
        modelo: v.modelo?.trim() || null,
        categoria: v.categoria?.trim() || null,
        genero: v.genero?.trim() || null,
        descripcion: v.descripcion?.trim() || null,
        costo: Number(v.costo) || 0,
        precioMinorista: Number(v.precioMinorista) || 0,
        precioMayorista: Number(v.precioMayorista) || 0,
      });
      await onSaved();
      onClose();
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo guardar.");
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Editar — ${group?.title || ""}`} width="max-w-2xl">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {error && <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}

        <div>
          <label className="label">Título *</label>
          <input className="input" maxLength={200}
            {...register("titulo", { required: "Obligatorio", minLength: { value: 2, message: "Mínimo 2 caracteres" } })} />
          {errors.titulo && <p className="field-error">{errors.titulo.message}</p>}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label className="label">Modelo</label>
            <input className="input" maxLength={80} {...register("modelo")} />
            {/* Es lo que encabeza la etiqueta impresa, antes de la categoría. */}
            <p className="mt-1 text-xs text-ink-500">Encabeza la etiqueta.</p>
          </div>
          <div><label className="label">Categoría</label><input className="input" maxLength={80} {...register("categoria")} /></div>
          <div><label className="label">Género</label><input className="input" maxLength={40} {...register("genero")} /></div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label className="label">Costo</label>
            <input className="input" type="number" min="0" step="0.01" inputMode="decimal"
              {...register("costo", { min: { value: 0, message: "No puede ser negativo" } })} />
            {errors.costo && <p className="field-error">{errors.costo.message}</p>}
          </div>
          <div>
            <label className="label">Precio minorista</label>
            <input className="input" type="number" min="0" step="0.01" inputMode="decimal"
              {...register("precioMinorista", { min: { value: 0, message: "No puede ser negativo" } })} />
            {errors.precioMinorista && <p className="field-error">{errors.precioMinorista.message}</p>}
          </div>
          <div>
            <label className="label">Precio mayorista</label>
            <input className="input" type="number" min="0" step="0.01" inputMode="decimal"
              {...register("precioMayorista", { min: { value: 0, message: "No puede ser negativo" } })} />
            {errors.precioMayorista && <p className="field-error">{errors.precioMayorista.message}</p>}
          </div>
        </div>

        <div>
          <label className="label">Descripción</label>
          <textarea className="input min-h-16" maxLength={2000} {...register("descripcion")} />
        </div>

        <p className="rounded-md bg-paper-100 px-3 py-2 text-xs text-ink-600">
          Estos datos son del producto: el cambio se aplica a todas sus variantes.
          El stock y el SKU se editan en cada fila.
        </p>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn-accent" disabled={isSubmitting}>
            {isSubmitting ? "Guardando…" : "Guardar cambios"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
