import { useEffect, useState } from "react";
import Modal from "../ui/Modal";
import { preciosPorPorcentaje } from "../../services/productService";
import { fetchListasProducto } from "../../services/variantTypeService";
import { formatCurrency } from "../../utils/formatters";

const REDONDEOS = [[1, "$1"], [10, "$10"], [100, "$100"], [1000, "$1.000"]];

/*
 * Cambia el precio minorista o mayorista en masa, por porcentaje o importe,
 * desde su precio actual, el mayorista o el costo. "Aplicar"
 * sólo se habilita con la vista previa de los mismos valores: cambiar uno
 * la descarta. Las categorías van por nombre, como vienen de la lista.
 */
export default function AumentarPreciosModal({ open, onClose, onAplicado }) {
  const [precio, setPrecio] = useState("minorista");
  const [base, setBase] = useState("mismo");
  const [modo, setModo] = useState("porcentaje");
  const [valor, setValor] = useState("");
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
  const clave = `${precio}|${base}|${modo}|${valor}|${redondeo}|${JSON.stringify([...categorias].sort())}`;
  const vigente = vista?.clave === clave ? vista.datos : null;

  const baseTxt = base === "mismo" ? `${precio === "minorista" ? "Minorista" : "Mayorista"} actual` : base === "mayorista" ? "mayorista" : "costo";
  const num = valor.trim() === "" ? "…" : Number(String(valor).replace(",", ".")).toLocaleString("es-AR");
  const cuenta = modo === "porcentaje" ? (n) => `${n} %` : (n) => `$ ${n}`;
  const neg = base === "mismo" && num.startsWith("-");
  const frase = `${base === "mismo" ? "" : `${precio === "minorista" ? "Minorista" : "Mayorista"} = `}${baseTxt} ${neg ? "−" : "+"} ${cuenta(neg ? num.slice(1) : num)}`;

  function cerrar() {
    if (trabajando) return;
    setPrecio("minorista"); setBase("mismo"); setModo("porcentaje"); setValor(""); setRedondeo(100); setSoloEstas(false); setElegidas([]); setVista(null); setError("");
    onClose();
  }

  async function correr(aplicar) {
    const n = Number(String(valor).replace(",", "."));
    if (valor.trim() === "" || !Number.isFinite(n)) return setError("Poné un valor, por ejemplo 8 o -5.");
    if (base === "mismo" && n === 0) return setError("Poné un valor distinto de 0.");
    if (base !== "mismo" && n < 0) return setError("Con esta base el valor no puede ser negativo.");
    if (soloEstas && !elegidas.length) return setError("Elegí al menos una categoría, o aplicá a todo el catálogo.");
    if (aplicar && !confirm(`Se van a cambiar los precios ${precio}s de ${vigente.productos} productos.`)) return;
    setTrabajando(true);
    setError("");
    try {
      const datos = await preciosPorPorcentaje({ precio, base, modo, valor: n, redondeo: Number(redondeo), aplicar, ...(categorias.length && { categorias }) });
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
    <Modal open={open} onClose={cerrar} title="Cambiar precios en masa" width="max-w-2xl">
      <div className="space-y-4">
        <p className="text-sm text-ink-600">
          Cambia sólo el precio elegido; los demás y el costo no se tocan. Se aplica una vez: si después cambia el costo o el mayorista, volvé a correrlo. Los precios se pueden seguir editando a mano.
          {precio === "mayorista" && " El portal mayorista toma los precios nuevos en su próxima lectura."}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="pp-precio">Qué precio cambiar</label>
            <select id="pp-precio" className="input" autoFocus value={precio} onChange={(e) => { setPrecio(e.target.value); setBase("mismo"); }}>
              <option value="minorista">Minorista</option>
              <option value="mayorista">Mayorista</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="pp-base">Calcular desde</label>
            <select id="pp-base" className="input" value={base} onChange={(e) => setBase(e.target.value)}>
              <option value="mismo">Su precio actual</option>
              {precio === "minorista" ? <option value="mayorista">El precio mayorista</option> : <option value="costo">El costo</option>}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="pp-modo">Cómo</label>
            <select id="pp-modo" className="input" value={modo} onChange={(e) => setModo(e.target.value)}>
              <option value="porcentaje">Porcentaje (%)</option>
              <option value="importe">Importe fijo ($)</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="pp-valor">{modo === "porcentaje" ? "Porcentaje" : "Importe"}</label>
            <input id="pp-valor" className="input" inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)}
              placeholder={base === "mismo" ? "Con signo: 8 sube, -5 baja" : "0 o más"} />
          </div>
          <div>
            <label className="label" htmlFor="pp-redondeo">Redondear a</label>
            <select id="pp-redondeo" className="input" value={redondeo} onChange={(e) => setRedondeo(e.target.value)}>
              {REDONDEOS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
            </select>
          </div>
        </div>
        <p className="text-sm font-medium text-ink-900" aria-live="polite">{frase}</p>
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
                  <tr><th className="px-3 py-2">Producto</th>{base !== "mismo" && <th className="px-3 py-2 text-right">Base</th>}<th className="px-3 py-2 text-right">Antes</th><th className="px-3 py-2 text-right">Después</th></tr>
                </thead>
                <tbody>
                  {vigente.muestra.map((m) => (
                    <tr key={m.productoId} className="border-t border-line">
                      <td className="px-3 py-2">{m.nombre}</td>
                      {base !== "mismo" && <td className="px-3 py-2 text-right">{formatCurrency(m.base)}</td>}
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
