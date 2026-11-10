import { useEffect, useState } from "react";
import Modal from "../ui/Modal";
import { preciosPorPorcentaje } from "../../services/productService";
import { fetchListasProducto } from "../../services/variantTypeService";
import { formatCurrency } from "../../utils/formatters";

const REDONDEOS = [[1, "$1"], [10, "$10"], [100, "$100"], [1000, "$1.000"]];

/*
 * Cambia el precio minorista de todo el catálogo por porcentaje. "Aplicar"
 * sólo se habilita con la vista previa de los mismos valores: cambiar uno
 * la descarta. Las categorías van por nombre, como vienen de la lista.
 */
export default function AumentarPreciosModal({ open, onClose, onAplicado }) {
  const [porcentaje, setPorcentaje] = useState("");
  const [redondeo, setRedondeo] = useState(100);
  const [todas, setTodas] = useState([]);
  const [soloEstas, setSoloEstas] = useState(false);
  const [elegidas, setElegidas] = useState([]);
  const [vista, setVista] = useState(null); // { clave, datos } de la última vista previa
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) fetchListasProducto().then((l) => setTodas(l.categorias || [])).catch(() => {});
  }, [open]);

  const categorias = soloEstas ? elegidas : [];
  const clave = `${porcentaje}|${redondeo}|${JSON.stringify([...categorias].sort())}`;
  const vigente = vista?.clave === clave ? vista.datos : null;

  function cerrar() {
    if (trabajando) return;
    setPorcentaje(""); setRedondeo(100); setSoloEstas(false); setElegidas([]); setVista(null); setError("");
    onClose();
  }

  async function correr(aplicar) {
    const n = Number(String(porcentaje).replace(",", "."));
    if (!Number.isFinite(n) || n === 0) return setError("Poné un porcentaje distinto de 0, por ejemplo 8 o -5.");
    if (soloEstas && !elegidas.length) return setError("Elegí al menos una categoría, o aplicá a todo el catálogo.");
    if (aplicar && !confirm(`Se van a cambiar los precios minoristas de ${vigente.productos} productos. La tienda online los toma en la próxima actualización.`)) return;
    setTrabajando(true);
    setError("");
    try {
      const datos = await preciosPorPorcentaje({ porcentaje: n, redondeo: Number(redondeo), aplicar, ...(categorias.length && { categorias }) });
      if (aplicar) {
        onAplicado(`Listo: se cambiaron los precios de ${datos.productos} productos.`);
        cerrar();
      } else setVista({ clave, datos });
    } catch (e) {
      setError(e.response?.data?.message || "No se pudieron cambiar los precios");
    } finally {
      setTrabajando(false);
    }
  }

  return (
    <Modal open={open} onClose={cerrar} title="Aumentar precios" width="max-w-2xl">
      <div className="space-y-4">
        <p className="text-sm text-ink-600">
          Sólo cambia el precio minorista. El mayorista y el costo no se tocan. Las variantes que heredan el precio del producto lo siguen heredando.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="pp-porcentaje">Porcentaje</label>
            <input id="pp-porcentaje" className="input" inputMode="decimal" autoFocus placeholder="8 sube 8 %, -5 baja 5 %"
              value={porcentaje} onChange={(e) => setPorcentaje(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="pp-redondeo">Redondear a</label>
            <select id="pp-redondeo" className="input" value={redondeo} onChange={(e) => setRedondeo(e.target.value)}>
              {REDONDEOS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
            </select>
          </div>
        </div>
        <fieldset className="space-y-1">
          <legend className="label">Categorías</legend>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name="pp-alcance" checked={!soloEstas} onChange={() => setSoloEstas(false)} /> Todo el catálogo</label>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name="pp-alcance" checked={soloEstas} onChange={() => setSoloEstas(true)} /> Sólo estas categorías</label>
          {soloEstas && (
            <div className="ml-6 flex flex-wrap gap-x-4 gap-y-1">
              {todas.length === 0 && <span className="text-xs text-ink-500">No hay categorías cargadas.</span>}
              {todas.map((c) => (
                <label key={c} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={elegidas.includes(c)}
                    onChange={() => setElegidas((e) => (e.includes(c) ? e.filter((x) => x !== c) : [...e, c]))} /> {c}
                </label>
              ))}
            </div>
          )}
        </fieldset>

        {error && <p role="alert" className="text-sm text-brick-500">{error}</p>}

        {vigente && (
          <div>
            <p className="mb-2 text-sm font-medium text-ink-900" aria-live="polite">
              Cambian {vigente.productos} productos y {vigente.variantes} variantes con precio propio
            </p>
            <div className="max-h-64 overflow-y-auto rounded-md border border-line">
              <table className="w-full text-sm">
                <thead className="bg-paper-200 text-left text-xs text-ink-600">
                  <tr><th className="px-3 py-2">Producto</th><th className="px-3 py-2 text-right">Antes</th><th className="px-3 py-2 text-right">Después</th></tr>
                </thead>
                <tbody>
                  {vigente.muestra.map((m) => (
                    <tr key={m.productoId} className="border-t border-line">
                      <td className="px-3 py-2">{m.nombre}</td>
                      <td className="px-3 py-2 text-right">{formatCurrency(m.antes)}</td>
                      <td className="px-3 py-2 text-right">{formatCurrency(m.despues)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={cerrar} disabled={trabajando}>Cancelar</button>
          <button type="button" className="btn-ghost" onClick={() => correr(false)} disabled={trabajando}>
            {trabajando ? "Calculando…" : "Ver cómo queda"}
          </button>
          <button type="button" className="btn-accent" onClick={() => correr(true)} disabled={trabajando || !vigente}>Aplicar</button>
        </div>
      </div>
    </Modal>
  );
}
