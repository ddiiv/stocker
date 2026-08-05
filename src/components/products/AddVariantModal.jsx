import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import Modal from "../ui/Modal";

const schema = z.object({
  talle: z.string().min(1, "Requerido"),
  color: z.string().min(1, "Requerido"),
  sku: z.string().min(3, "Requerido"),
  costo: z.coerce.number().min(0, "Debe ser positivo"),
  precio: z.coerce.number().min(0, "Debe ser positivo"),
  stock: z.coerce.number().min(0, "Debe ser positivo"),
  stockMinimo: z.coerce.number().min(0, "Debe ser positivo"),
});

export default function AddVariantModal({ open, onClose, group, onCreate }) {
  const [serverError, setServerError] = useState("");
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: { talle: "", color: "", sku: "", costo: 0, precio: 0, stock: 0, stockMinimo: 5 },
  });

  async function onSubmit(values) {
    setServerError("");
    try {
      await onCreate(values);
      reset();
      onClose();
    } catch (err) {
      setServerError(err.message || "No se pudo crear la variante");
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Nueva variante — ${group?.title || ""}`}>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {serverError && <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{serverError}</p>}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Talle</label>
            <input className="input" placeholder="M" {...register("talle")} />
            {errors.talle && <p className="field-error">{errors.talle.message}</p>}
          </div>
          <div>
            <label className="label">Color</label>
            <input className="input" placeholder="Negro" {...register("color")} />
            {errors.color && <p className="field-error">{errors.color.message}</p>}
          </div>
        </div>
        <div>
          <label className="label">SKU de la variante</label>
          <input className="input font-mono" placeholder={`${group?.skuAgrupador || ""}NEGM`} {...register("sku")} />
          {errors.sku && <p className="field-error">{errors.sku.message}</p>}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Costo</label>
            <input className="input" type="number" min="0" step="0.01" inputMode="decimal" {...register("costo")} />
            {errors.costo && <p className="field-error">{errors.costo.message}</p>}
          </div>
          <div>
            <label className="label">Precio de venta</label>
            <input className="input" type="number" min="0" step="0.01" inputMode="decimal" {...register("precio")} />
            {errors.precio && <p className="field-error">{errors.precio.message}</p>}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Stock inicial</label>
            <input className="input" type="number" min="0" step="1" inputMode="numeric" {...register("stock")} />
            {errors.stock && <p className="field-error">{errors.stock.message}</p>}
          </div>
          <div>
            <label className="label">Stock mínimo</label>
            <input className="input" type="number" min="0" step="1" inputMode="numeric" {...register("stockMinimo")} />
            {errors.stockMinimo && <p className="field-error">{errors.stockMinimo.message}</p>}
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn-accent" disabled={isSubmitting}>
            {isSubmitting ? "Creando…" : "Crear variante"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
