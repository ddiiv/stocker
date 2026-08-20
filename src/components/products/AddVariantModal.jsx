import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import Modal from "../ui/Modal";
import { suggestSku } from "../../services/skuService";

/*
 * Alta de una variante dentro de un producto.
 *
 * Los campos son los que el producto ya usa para diferenciar sus variantes. No
 * están fijos en "talle" y "color": un negocio puede tener Color/Talle y otro
 * Sabor/Tamaño, y el nombre de cada eje se guarda en el propio producto. Acá se
 * leen de las variantes que ya existen para que la nueva sea consistente con
 * ellas; en un producto sin variantes todavía, se piden.
 *
 * No hay costo ni precio: viven en el producto y son iguales para todas sus
 * variantes. El formulario anterior los mostraba, el usuario los completaba, y
 * el backend los descartaba sin decir nada.
 */

const schema = z.object({
  variante1Nombre: z.string().trim().min(1, "Requerido"),
  variante1Valor:  z.string().trim().min(1, "Requerido"),
  variante2Nombre: z.string().trim().optional(),
  variante2Valor:  z.string().trim().optional(),
  sku:             z.string().trim().min(3, "Al menos 3 caracteres"),
  codigoBarras:    z.string().trim().optional(),
  stock:           z.coerce.number().int("Sin decimales").min(0, "No puede ser negativo"),
  stockMinimo:     z.coerce.number().int("Sin decimales").min(0, "No puede ser negativo"),
}).refine((v) => !v.variante2Nombre?.trim() || v.variante2Valor?.trim(), {
  message: "Requerido", path: ["variante2Valor"],
});

export default function AddVariantModal({ open, onClose, group, onCreate }) {
  const [serverError, setServerError] = useState("");

  // Los ejes salen de las variantes que ya tiene el producto.
  const ejes = useMemo(() => {
    const v = group?.variants?.[0];
    return { nombre1: v?.variante1Nombre || "", nombre2: v?.variante2Nombre || "" };
  }, [group]);

  const {
    register, handleSubmit, reset, watch, setValue,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: {
      variante1Nombre: ejes.nombre1, variante1Valor: "",
      variante2Nombre: ejes.nombre2, variante2Valor: "",
      sku: "", codigoBarras: "", stock: 0, stockMinimo: 5,
    },
  });

  // Al abrir se recargan los ejes: el modal se monta una vez y el producto
  // puede cambiar entre aperturas.
  useEffect(() => {
    if (!open) return;
    reset({
      variante1Nombre: ejes.nombre1, variante1Valor: "",
      variante2Nombre: ejes.nombre2, variante2Valor: "",
      sku: "", codigoBarras: "", stock: 0, stockMinimo: 5,
    });
    setServerError("");
  }, [open, ejes, reset]);

  const [n1, v1, n2, v2, sku] = watch(["variante1Nombre", "variante1Valor", "variante2Nombre", "variante2Valor", "sku"]);

  /*
   * La sugerencia la arma el servidor con la regla del negocio.
   *
   * Antes se calculaba acá con una fórmula propia, que daba otro SKU que el que
   * el sistema genera al crear un producto entero. Dos productos iguales
   * terminaban con códigos de formato distinto según por dónde se los cargó.
   * Ahora hay una sola fórmula, y de paso el servidor avisa si ya está tomado.
   */
  const [sugerido, setSugerido] = useState("");
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    if (!open || !v1?.trim()) { setSugerido(""); setOcupado(false); return; }
    const t = setTimeout(() => {
      suggestSku({
        agrupador: group?.skuAgrupador || "",
        valores: [
          { eje: n1 || "", valor: v1 },
          ...(v2?.trim() ? [{ eje: n2 || "", valor: v2 }] : []),
        ],
      })
        .then((r) => { setSugerido(r.sugerido || r.sku); setOcupado(!r.libre); })
        .catch(() => setSugerido(""));
    }, 350);
    return () => clearTimeout(t);
  }, [open, group?.skuAgrupador, n1, v1, n2, v2]);

  // Un SKU repetido lo rechaza la base con un error críptico. Se avisa antes,
  // mientras todavía se está escribiendo.
  const repetido = useMemo(
    () => !!sku?.trim() && (group?.variants || []).some((v) => v.sku?.toLowerCase() === sku.trim().toLowerCase()),
    [sku, group],
  );

  async function onSubmit(values) {
    setServerError("");
    if (repetido) { setServerError(`El SKU ${values.sku} ya lo usa otra variante de este producto.`); return; }
    try {
      await onCreate({
        ...values,
        sku: values.sku.trim(),
        codigoBarras: values.codigoBarras?.trim() || null,
        variante2Nombre: values.variante2Nombre?.trim() || null,
        variante2Valor:  values.variante2Valor?.trim()  || null,
      });
      onClose();
    } catch (err) {
      /*
       * El mensaje que importa viene del backend, no de la excepción de axios.
       * Leyendo `err.message` se mostraba "Request failed with status code 409"
       * en lugar de "llegaste al tope de SKUs de tu plan", que es lo único que
       * le dice al usuario qué hacer.
       */
      setServerError(err.response?.data?.message || err.message || "No se pudo crear la variante.");
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Nueva variante — ${group?.title || ""}`}>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {serverError && <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{serverError}</p>}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="label">
              {ejes.nombre1 || "Primer atributo"}
              {!ejes.nombre1 && <span className="font-normal text-ink-500"> (ej: Color)</span>}
            </label>
            {!ejes.nombre1 && (
              <input className="input mb-2" placeholder="Nombre del atributo" {...register("variante1Nombre")} />
            )}
            <input className="input" placeholder={ejes.nombre1 ? "Negro" : "Valor"} {...register("variante1Valor")} />
            {(errors.variante1Valor || errors.variante1Nombre) && (
              <p className="field-error">{(errors.variante1Valor || errors.variante1Nombre).message}</p>
            )}
          </div>

          <div>
            <label className="label">
              {ejes.nombre2 || "Segundo atributo"}
              <span className="font-normal text-ink-500"> {ejes.nombre2 ? "" : "(opcional)"}</span>
            </label>
            {!ejes.nombre2 && (
              <input className="input mb-2" placeholder="Ej: Talle" {...register("variante2Nombre")} />
            )}
            <input className="input" placeholder={ejes.nombre2 ? "M" : "Valor"} {...register("variante2Valor")} />
            {errors.variante2Valor && <p className="field-error">{errors.variante2Valor.message}</p>}
          </div>
        </div>

        <div>
          <label className="label">SKU de la variante</label>
          <input className="input font-mono" placeholder={sugerido || "SKU"} {...register("sku")} />
          <div className="mt-1 flex items-center gap-2">
            {errors.sku && <p className="field-error">{errors.sku.message}</p>}
            {repetido && <p className="field-error">Ya existe en este producto.</p>}
            {sugerido && sugerido !== sku && (
              <button type="button" className="text-xs text-ink-600 underline hover:text-ink-950"
                onClick={() => setValue("sku", sugerido, { shouldValidate: true })}>
                Usar {sugerido}
              </button>
            )}
            {/* Que el código de la regla estuviera tomado es información, no un
                error: la sugerencia ya viene corrida al siguiente libre. */}
            {ocupado && sugerido && (
              <p className="text-xs text-ink-500">El código de la regla ya está en uso; se sugiere el siguiente libre.</p>
            )}
          </div>
        </div>

        <div>
          <label className="label">
            Código de barras <span className="font-normal text-ink-500">(opcional)</span>
          </label>
          <input className="input font-mono" placeholder="7791234567898" {...register("codigoBarras")} />
          {/* Sin código no se puede escanear, y es más fácil cargarlo ahora que
              descubrirlo con el lector en la mano frente a la góndola. */}
          <p className="mt-1 text-xs text-ink-500">Es lo que lee el escáner. Se puede cargar después.</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
          <button type="button" className="btn-ghost" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn-accent" disabled={isSubmitting}>
            {isSubmitting ? "Creando…" : "Crear variante"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
