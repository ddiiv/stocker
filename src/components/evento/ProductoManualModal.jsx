import { useEffect, useState } from "react";
import { Loader2, PackagePlus } from "lucide-react";
import Modal from "../ui/Modal";
import { crearProductoDeEvento } from "../../services/feriaService";
import { mensajeDeError } from "../../utils/errores";
import { formatCurrency } from "../../utils/formatters";

/*
 * Un producto de evento cargado a mano.
 *
 * Generar desde el catálogo cubre el caso normal: lo que ya se vende en el
 * local, con otro precio para el evento. Pero hay mercadería que SÓLO se vende
 * en eventos y nunca estuvo en el catálogo — un saldo comprado para el fin de
 * semana, una promoción armada para el puesto.
 *
 * Sin esto había que inventarle un producto al catálogo normal, generarle su
 * versión de evento y después acordarse de dar de baja el original: tres pasos
 * y un producto fantasma para cargar una prenda.
 *
 * Se piden cuatro cosas y nada más. Un producto de evento no lleva stock, no
 * tiene talles ni colores y no pide reposición: preguntarle al que está
 * armando el puesto por variantes o mínimos sería pedirle datos que no existen.
 */
const VACIO = { titulo: "", sku: "", precioMinorista: "", precioMayorista: "", costo: "" };

export default function ProductoManualModal({ open, onClose, prefijo, onCreado }) {
  const [form, setForm] = useState(VACIO);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { if (open) { setForm(VACIO); setError(""); } }, [open]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const codigoBase = form.sku.trim().toUpperCase();
  const codigoFinal = codigoBase ? `${prefijo || "EVE"}${codigoBase}` : "";

  const minorista = Number(form.precioMinorista);
  const puedeGuardar = Boolean(form.titulo.trim())
    && Boolean(codigoBase)
    && form.precioMinorista !== ""
    && Number.isFinite(minorista) && minorista >= 0
    && !guardando;

  async function guardar() {
    setGuardando(true); setError("");
    try {
      const creado = await crearProductoDeEvento({
        titulo: form.titulo.trim(),
        sku: codigoBase,
        precioMinorista: minorista,
        /*
         * El mayorista vacío no viaja: el servidor lo iguala al minorista.
         * Mandarlo en cero haría que una venta mayorista saliera gratis.
         */
        ...(form.precioMayorista === "" ? {} : { precioMayorista: Number(form.precioMayorista) }),
        ...(form.costo === "" ? {} : { costo: Number(form.costo) }),
        prefijo,
      });
      onCreado?.(creado);
      onClose?.();
    } catch (e) {
      setError(mensajeDeError(e, "No se pudo cargar el producto."));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Modal open={open} onClose={guardando ? undefined : onClose} title="Producto de evento" width="max-w-md">
      <p className="mb-4 text-xs text-ink-500">
        Para lo que se vende sólo en eventos y no está en el catálogo del local. No lleva stock
        ni variantes: se escanea el código y sale el precio.
      </p>

      {error && <p className="mb-3 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}

      <div className="space-y-3">
        <div>
          <label className="label" htmlFor="pm-titulo">Producto *</label>
          <input
            id="pm-titulo" className="input" autoFocus maxLength={150}
            placeholder="Remera lisa saldo"
            value={form.titulo} onChange={(e) => set("titulo", e.target.value)}
          />
        </div>

        <div>
          <label className="label" htmlFor="pm-sku">Código *</label>
          <input
            id="pm-sku" className="input font-mono uppercase" maxLength={30}
            placeholder="REM-01"
            value={form.sku} onChange={(e) => set("sku", e.target.value)}
          />
          {/* El prefijo lo pone el servidor, igual que a los generados. Se
              muestra el resultado para que nadie se sorprenda al escanear. */}
          <p className="mt-1 text-xs text-ink-500">
            Va a quedar como <span className="font-mono text-ink-900">{codigoFinal || "…"}</span>
            {" "}— el prefijo lo lleva todo el catálogo de evento.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label" htmlFor="pm-min">Precio minorista *</label>
            <input
              id="pm-min" className="input" type="number" min="0" step="0.01"
              value={form.precioMinorista} onChange={(e) => set("precioMinorista", e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="pm-may">Precio mayorista</label>
            <input
              id="pm-may" className="input" type="number" min="0" step="0.01"
              placeholder={form.precioMinorista || "igual al minorista"}
              value={form.precioMayorista} onChange={(e) => set("precioMayorista", e.target.value)}
            />
          </div>
        </div>

        <div>
          <label className="label" htmlFor="pm-costo">
            Costo <span className="font-normal text-ink-500">(opcional)</span>
          </label>
          <input
            id="pm-costo" className="input" type="number" min="0" step="0.01"
            value={form.costo} onChange={(e) => set("costo", e.target.value)}
          />
          <p className="mt-1 text-xs text-ink-500">Sirve para el margen. Sin costo, el reporte lo cuenta como cero.</p>
        </div>

        {/* Los dos precios a la vista: es la comprobación que hace quien carga,
            antes de guardar. La regla del puesto decide después cuál se cobra. */}
        {form.precioMinorista !== "" && Number.isFinite(minorista) && minorista > 0 && (
          <p className="rounded-md bg-paper-100 px-3 py-2 text-xs text-ink-600">
            Minorista {formatCurrency(minorista)} · mayorista{" "}
            {formatCurrency(form.precioMayorista === "" ? minorista : Number(form.precioMayorista) || 0)}
          </p>
        )}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onClose} disabled={guardando}>Cancelar</button>
        <button type="button" className="btn-accent" onClick={guardar} disabled={!puedeGuardar}>
          {guardando
            ? <><Loader2 size={15} className="animate-spin" /> Guardando…</>
            : <><PackagePlus size={15} /> Agregar al catálogo</>}
        </button>
      </div>
    </Modal>
  );
}
