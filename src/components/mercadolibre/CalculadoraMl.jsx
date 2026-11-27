import { useEffect, useState } from "react";
import Modal from "../ui/Modal";
import { calcularPrecioMl } from "../../services/mercadolibreService";
import { Alerta, Desglose, $ } from "./comun";

/*
 * La calculadora de una publicación, con lo que ML cobra de verdad. No cambia
 * nada: para aplicar el precio se pasa por la vista previa de precios.
 */
export default function CalculadoraMl({ variante, onClose, onUsarPrecio }) {
  const [precio, setPrecio] = useState(variante.precioOriginal ?? variante.precio ?? "");
  const [quiere, setQuiere] = useState("");
  const [extra, setExtra] = useState("");
  const [peso, setPeso] = useState("");
  const [r, setR] = useState(null);
  const [calculando, setCalculando] = useState(""); // "precio" | "objetivo" | ""
  const [error, setError] = useState("");

  async function calcular(modo) {
    setCalculando(modo); setError(""); setR(null);
    const cuerpo = { itemId: variante.itemId };
    if (modo === "precio") cuerpo.precio = Number(precio);
    else if (quiere !== "") cuerpo.quiere = Number(quiere);
    if (extra !== "") cuerpo.extraPct = Number(extra);
    if (peso !== "") cuerpo.pesoGramos = Number(peso);
    try { setR(await calcularPrecioMl(cuerpo)); }
    catch (e) {
      const texto = e.response?.data?.message || "No se pudo calcular.";
      setError(e.response?.data?.codigo === "SIN_COSTO_ML" ? `${texto} No te mostramos una estimación: probá de nuevo en un rato.` : texto);
    }
    setCalculando("");
  }

  // Al abrir se muestra qué queda con el precio de hoy.
  useEffect(() => { if (Number(precio) > 0) calcular("precio"); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Cambiar un dato deja viejo el resultado: se borra para no leerlo como actual.
  const cambiar = (poner) => (e) => { poner(e.target.value); setR(null); setError(""); };

  return (
    <Modal open onClose={onClose} title="Calculadora de precio" width="max-w-xl">
      <div className="space-y-4">
        <p className="break-words text-sm text-ink-700">
          {[r?.nombre, variante.color, variante.talle].filter(Boolean).join(" · ")} <span className="font-mono text-[11px] text-ink-500">{variante.itemId}</span>
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-ink-600">Extra para descuento (%)
            <input className="input mt-1" type="number" min="0" max="79" step="any" placeholder="El de la publicación" value={extra} onChange={cambiar(setExtra)} disabled={Boolean(calculando)} />
          </label>
          <label className="text-xs text-ink-600">Peso del paquete (gramos)
            <input className="input mt-1" type="number" min="1" max="100000" placeholder="El de los parámetros" value={peso} onChange={cambiar(setPeso)} disabled={Boolean(calculando)} />
          </label>
        </div>

        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); calcular("precio"); }}>
          <label className="min-w-0 flex-1 text-xs text-ink-600">Si lo publico a ($)
            <input className="input mt-1" type="number" min="1" step="any" required value={precio} onChange={cambiar(setPrecio)} disabled={Boolean(calculando)} />
          </label>
          <button className="btn-ghost shrink-0" disabled={Boolean(calculando)}>{calculando === "precio" ? "Calculando…" : "Ver qué queda"}</button>
        </form>

        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); calcular("objetivo"); }}>
          <label className="min-w-0 flex-1 text-xs text-ink-600">Quiero que me queden ($)
            <input className="input mt-1" type="number" min="1" step="any" placeholder="Costo × multiplicador + packing" value={quiere} onChange={cambiar(setQuiere)} disabled={Boolean(calculando)} />
          </label>
          <button className="btn-primary shrink-0" disabled={Boolean(calculando)}>{calculando === "objetivo" ? "Buscando…" : "Buscar precio"}</button>
        </form>

        {calculando && <p className="text-sm text-ink-600" role="status">Preguntando los costos a Mercado Libre…</p>}
        <Alerta>{error}</Alerta>

        {r && (
          <div className="space-y-3">
            <p className="text-xs text-ink-600">
              Costo en Stocker: {r.costo == null ? "sin cargar" : $(r.costo)} · packing {$(r.packing)} · extra {r.extraPct}% · {r.pesoGramos} g · precio de lista hoy {$(r.precioActual)}
            </p>
            {r.costoParcial && <Alerta tono="aviso">Hay variantes de esta publicación sin costo en Stocker: la ganancia usa el costo más alto de las que sí tienen.</Alerta>}
            {r.afectaVariaciones > 0 && <Alerta tono="aviso">En esta publicación el precio es uno solo para sus {r.afectaVariaciones} variaciones.</Alerta>}
            {r.modo === "objetivo" && (
              <Alerta tono="ok">
                Para que te queden {$(r.objetivo)} hay que publicar a {$(r.desglose.precio)}{r.minimoExacto ? "." : " (cumple, aunque puede haber un precio un poco más bajo)."}
              </Alerta>
            )}
            <Desglose d={r.desglose} />
            {r.desglose.bajoPiso && <Alerta>Con este precio te queda menos que costo + packing.</Alerta>}
            {r.extraPct !== r.extraDeLaPublicacion && (
              <Alerta tono="aviso">
                Calculaste con {r.extraPct}% de extra y esta publicación tiene {r.extraDeLaPublicacion}%: la vista previa de precios usa el de la publicación, y acá no se cambia el descuento.
              </Alerta>
            )}
            <div className="flex justify-end">
              <button type="button" className="btn-accent" onClick={() => onUsarPrecio(r.desglose.precio)}>Usar este precio (ver vista previa)</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
