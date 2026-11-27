import { useEffect, useState } from "react";
import Modal from "../ui/Modal";
import { buscarVariantes } from "../../services/productService";
import { vincularPublicacionMl, desvincularPublicacionMl } from "../../services/mercadolibreService";
import { Alerta } from "./comun";

/*
 * A qué variante de Stocker corresponde una publicación. Se elige buscando por
 * SKU o nombre; el vínculo es lo que usa la sincronización de stock.
 */
export default function VincularModal({ variante, onClose, onCambio }) {
  const [texto, setTexto] = useState(variante.sku || "");
  const [opciones, setOpciones] = useState(null);
  const [buscando, setBuscando] = useState(false);
  const [elegida, setElegida] = useState(null);
  const [enMl, setEnMl] = useState(true);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState("");
  const [listo, setListo] = useState(null);

  useEffect(() => {
    const q = texto.trim();
    if (q.length < 2) { setOpciones(null); return undefined; }
    let vigente = true;
    const timer = setTimeout(async () => {
      setBuscando(true);
      try {
        const r = await buscarVariantes(q);
        if (vigente) setOpciones(r);
      } catch {
        if (vigente) setError("No se pudo buscar en Stocker.");
      }
      if (vigente) setBuscando(false);
    }, 300);
    return () => { vigente = false; clearTimeout(timer); };
  }, [texto]);

  const cuerpo = { itemId: variante.itemId, mlVariationId: variante.mlVariationId };

  async function guardar(confirmado = false) {
    setEnviando(true); setError("");
    try {
      const r = await vincularPublicacionMl({ ...cuerpo, variantId: elegida.id, escribirEnMl: enMl, confirmado });
      setListo(r);
      onCambio();
    } catch (e) {
      if (e.response?.data?.codigo === "SKU_EN_OTRA" && window.confirm(`${e.response.data.message} ¿Seguimos?`)) return guardar(true);
      setError(e.response?.data?.message || "No se pudo vincular.");
    }
    setEnviando(false);
  }

  async function quitar() {
    if (!window.confirm("Se quita el vínculo manual: la publicación vuelve a tomar el SKU que tenga escrito en Mercado Libre. ¿Seguimos?")) return;
    setEnviando(true); setError("");
    try {
      const r = await desvincularPublicacionMl(cuerpo);
      if (!r.quitados) setError("Esta publicación no tenía un vínculo manual.");
      else { onCambio(); onClose(); }
    } catch (e) { setError(e.response?.data?.message || "No se pudo quitar el vínculo."); }
    setEnviando(false);
  }

  return (
    <Modal open onClose={enviando ? () => {} : onClose} title="SKU y vínculo con Stocker" width="max-w-xl">
      <div className="space-y-3">
        <p className="break-words text-sm text-ink-700">
          {[variante.color, variante.talle].filter(Boolean).join(" / ") || "Sin variante"}{" "}
          <span className="font-mono text-[11px] text-ink-500">{variante.itemId}</span>
        </p>
        <p className="text-xs text-ink-600">
          Hoy: SKU <span className="font-mono">{variante.sku || "sin SKU"}</span> ·{" "}
          {variante.variantId ? [variante.productoTitulo, variante.colorStocker, variante.talleStocker].filter(Boolean).join(" · ") : "sin vincular a Stocker"}
        </p>

        {listo ? (
          <>
            <Alerta tono="aviso">Quedó vinculada a {listo.sku}. El stock se actualiza solo en unos segundos.</Alerta>
            {listo.enMl?.ok === false && <Alerta>Mercado Libre no dejó escribir el SKU ({listo.enMl.error}). El vínculo de Stocker funciona igual.</Alerta>}
            <div className="flex justify-end"><button type="button" className="btn-primary" onClick={onClose}>Cerrar</button></div>
          </>
        ) : (
          <>
            <label className="block text-xs text-ink-600">Buscá la variante que corresponde (SKU, nombre, color o talle)
              <input className="input mt-1" value={texto} disabled={enviando} onChange={(e) => { setTexto(e.target.value); setElegida(null); setError(""); }} />
            </label>
            {buscando && <p className="text-xs text-ink-500" role="status">Buscando…</p>}
            {!buscando && opciones && !opciones.length && <p className="text-xs text-ink-500">No hay variantes que coincidan. Probá con el nombre del producto.</p>}
            <ul className="max-h-56 space-y-1 overflow-y-auto">
              {(opciones || []).map((o) => (
                <li key={o.id}>
                  <button type="button" disabled={enviando} aria-pressed={elegida?.id === o.id} onClick={() => setElegida(o)}
                    className={`w-full rounded-md border px-3 py-2 text-left text-xs ${elegida?.id === o.id ? "border-teal-600 bg-paper-200" : "border-line"}`}>
                    <span className="block break-words text-ink-900">{[o.titulo, o.variante1Valor, o.variante2Valor].filter(Boolean).join(" · ")}</span>
                    <span className="font-mono text-[11px] text-ink-500">{o.sku}</span>
                  </button>
                </li>
              ))}
            </ul>
            <label className="flex items-start gap-2 text-xs text-ink-700">
              <input type="checkbox" className="mt-0.5" checked={enMl} disabled={enviando} onChange={(e) => setEnMl(e.target.checked)} />
              Escribir también ese SKU en Mercado Libre
            </label>
            <Alerta>{error}</Alerta>
            <div className="flex flex-wrap justify-between gap-2">
              <button type="button" className="btn-ghost" onClick={quitar} disabled={enviando}>Quitar vínculo</button>
              <button type="button" className="btn-primary" onClick={() => guardar(false)} disabled={enviando || !elegida}>{enviando ? "Guardando…" : "Vincular"}</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
