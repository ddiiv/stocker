import { useState } from "react";
import { ean13Interno } from "../../utils/ean";

/*
 * El código de barras de la variante, debajo del SKU. Es el que sale en la
 * etiqueta: el propio si lo tiene (un EAN de fábrica) y, si no, el interno, que
 * sale del id de la variante y no del SKU: cambiar el SKU no lo mueve. Hasta la
 * primera impresión el interno todavía no está guardado (la caja no lo encuentra
 * al escanear), por eso se ve apagado. Tocarlo lo copia.
 */
export default function EanDeVariante({ id, codigoBarras }) {
  const [copiado, setCopiado] = useState(false);
  const guardado = codigoBarras;
  const codigo = guardado || ean13Interno(id);
  async function copiar() {
    try { await navigator.clipboard.writeText(codigo); setCopiado(true); setTimeout(() => setCopiado(false), 1200); }
    catch { /* sin permiso del navegador: el número igual se ve y se puede seleccionar */ }
  }
  return (
    <button
      type="button"
      onClick={copiar}
      className={`mt-0.5 block text-left font-mono text-[11px] tabular-nums hover:text-ink-900 ${guardado ? "text-ink-600" : "text-ink-400"}`}
      title={guardado ? "Código de barras de la etiqueta. Tocá para copiar." : "Todavía no se imprimió: se guarda con este número al imprimir la etiqueta. Tocá para copiar."}
    >
      {copiado ? "Copiado" : codigo}
    </button>
  );
}
