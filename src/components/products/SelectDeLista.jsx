import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchListasProducto } from "../../services/variantTypeService";

/*
 * Categoría o género de un producto, elegido de la lista que se carga en
 * Stock → Variantes y categorías. `actual` es el valor que ya tiene el
 * producto: si no está en la lista (se cargó antes, o por planilla) se ofrece
 * igual, para que editar no lo borre sin querer.
 */
export default function SelectDeLista({ label, lista, actual, ...registro }) {
  const [opciones, setOpciones] = useState([]);
  useEffect(() => {
    fetchListasProducto().then((l) => setOpciones(l[lista] || [])).catch(() => {});
  }, [lista]);
  const todas = actual && !opciones.includes(actual) ? [actual, ...opciones] : opciones;
  return (
    <div>
      <label className="label">{label}</label>
      <select className="input" {...registro}>
        <option value="">—</option>
        {todas.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      {opciones.length === 0 && (
        <p className="mt-1 text-xs text-ink-500">Cargá la lista en <Link className="underline" to="/stock/variantes">Variantes y categorías</Link>.</p>
      )}
    </div>
  );
}
