import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import Modal from "../ui/Modal";
import { Card } from "../ui/Layout";
import { vistaPreviaPreciosMl, aplicarPreciosMl } from "../../services/mercadolibreService";
import { enTandas } from "../../utils/tandas";
import { Alerta, $ } from "./comun";

// Cada precio sugerido son varios pedidos a ML: de a pocos para no pasarse de los 30 s del proxy.
const POR_PEDIDO = 4;

/*
 * Vista previa y aplicación de precios. `cambios` es [{itemId, precio?}]: sin
 * precio, el servidor sugiere el mínimo para el objetivo por defecto.
 */
export function PreciosModal({ cambios, onClose, onArranco }) {
  const [filas, setFilas] = useState({}); // {[itemId]: fila}
  const [precios, setPrecios] = useState({}); // lo escrito en cada fila
  const [tildados, setTildados] = useState(() => new Set());
  const [confirmados, setConfirmados] = useState(() => new Set());
  const [rechazos, setRechazos] = useState({});
  const [peso, setPeso] = useState("");
  const [calculando, setCalculando] = useState(null); // {hechos, total}
  const [aplicando, setAplicando] = useState(false);
  const [error, setError] = useState("");
  const abierta = useRef(true);

  const sacar = (set, ids) => { const s = new Set(set); ids.forEach((id) => s.delete(id)); return s; };
  const alternar = (poner, id) => poner((s) => { const n = new Set(s); if (!n.delete(id)) n.add(id); return n; });

  async function calcular(lista) {
    setCalculando({ hechos: 0, total: lista.length }); setError("");
    const ids = lista.map((c) => c.itemId);
    setTildados((s) => sacar(s, ids));
    setConfirmados((s) => sacar(s, ids));
    setRechazos((r) => Object.fromEntries(Object.entries(r).filter(([id]) => !ids.includes(id))));
    // Las filas viejas se van: si el recálculo falla, que no quede una cuenta anterior para tildar.
    setFilas((f) => Object.fromEntries(Object.entries(f).filter(([id]) => !ids.includes(id))));
    try {
      await enTandas(lista, POR_PEDIDO, (parte) => vistaPreviaPreciosMl({ cambios: parte, ...(peso !== "" ? { pesoGramos: Number(peso) } : {}) }), (r, hechos) => {
        if (!abierta.current) return false;
        setFilas((f) => ({ ...f, ...Object.fromEntries(r.filas.map((x) => [x.itemId, x])) }));
        setPrecios((p) => ({ ...p, ...Object.fromEntries(r.filas.map((x) => [x.itemId, x.precioNuevo ?? p[x.itemId] ?? ""])) }));
        setCalculando({ hechos, total: lista.length });
        return true;
      });
    } catch (e) {
      setError(`${e.response?.data?.message || "No se pudo armar la vista previa."} Quedaron ${e.sinMandar.length} sin calcular.`);
    }
    setCalculando(null);
  }

  useEffect(() => {
    abierta.current = true;
    calcular(cambios);
    return () => { abierta.current = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Escrito distinto de lo calculado: hay que recalcular antes de poder tildarla.
  const vieja = (id) => precios[id] !== undefined && String(precios[id]) !== String(filas[id]?.precioNuevo ?? "");
  const aplicable = (id) => Boolean(filas[id]?.despues) && !vieja(id);
  const pideOk = (id) => filas[id]?.requiereConfirmacion || rechazos[id]?.requiereConfirmacion;

  // Sin respuesta (o con error) la fila no existe: se recalcula con lo que ya estaba escrito.
  const pedidoDe = (c) => {
    const escrito = precios[c.itemId] ?? c.precio;
    return escrito === undefined || escrito === "" ? { itemId: c.itemId } : { itemId: c.itemId, precio: Number(escrito) };
  };
  const porRecalcular = cambios.filter((c) => !filas[c.itemId]?.despues || vieja(c.itemId));
  const elegidos = cambios.map((c) => c.itemId).filter((id) => tildados.has(id) && aplicable(id));
  const faltaOk = elegidos.filter((id) => pideOk(id) && !confirmados.has(id));
  const enRojo = elegidos.filter((id) => filas[id].despues.bajoPiso).length;
  const ocupado = Boolean(calculando) || aplicando;

  async function aplicar() {
    const aviso = enRojo ? ` OJO: ${enRojo} quedan por debajo de costo + packing.` : "";
    if (!window.confirm(`Se cambia el precio en Mercado Libre de ${elegidos.length} publicación(es).${aviso} ¿Seguimos?`)) return;
    setAplicando(true); setError(""); setRechazos({});
    try {
      const trabajo = await aplicarPreciosMl(elegidos.map((id) => ({
        itemId: id, precio: Number(filas[id].precioNuevo), ...(confirmados.has(id) ? { confirmado: true } : {}),
      })));
      onArranco(trabajo);
      return;
    } catch (e) {
      const lista = e.response?.data?.rechazados;
      if (lista) setRechazos(Object.fromEntries(lista.map((x) => [x.itemId, x])));
      setError(e.response?.data?.message || "No llegó respuesta: antes de repetir, cerrá y mirá si el cambio de precios figura en curso o ya se aplicó.");
    }
    setAplicando(false);
  }

  return (
    <Modal open onClose={aplicando ? () => {} : onClose} title="Cambiar precios" width="max-w-3xl">
      <div className="space-y-3">
        <p className="text-sm text-ink-700">
          Escribí el precio a publicar o dejá el sugerido (el mínimo para costo × multiplicador + packing). Sólo se cambian las que tildes.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-ink-600">Peso del paquete (gramos)
            <input className="input mt-1 !w-44" type="number" min="1" max="100000" placeholder="El de los parámetros" value={peso} disabled={ocupado}
              onChange={(e) => {
                setPeso(e.target.value);
                // Con otro peso el sugerido es otro: se olvida; lo escrito a mano queda.
                setPrecios((p) => Object.fromEntries(Object.entries(p).filter(([id]) => !filas[id]?.sugerido || vieja(id))));
                setFilas({}); setTildados(new Set());
              }} />
          </label>
          {porRecalcular.length > 0 && (
            <button type="button" className="btn-ghost" disabled={ocupado} onClick={() => calcular(porRecalcular.map(pedidoDe))}>
              Recalcular {porRecalcular.length}
            </button>
          )}
          <button type="button" className="btn-ghost" disabled={ocupado}
            onClick={() => setTildados(new Set(cambios.map((c) => c.itemId).filter((id) => aplicable(id) && !filas[id].despues.bajoPiso && filas[id].precioNuevo !== filas[id].precioActual)))}>
            Tildar las que cambian y no quedan en rojo
          </button>
        </div>
        {calculando && <p className="text-sm text-ink-600" role="status">Preguntando los costos a Mercado Libre: {calculando.hechos} de {calculando.total}…</p>}

        <ul className="space-y-2">
          {cambios.map((c) => {
            const id = c.itemId;
            const f = filas[id];
            const rojo = f?.despues?.bajoPiso && !vieja(id);
            return (
              <li key={id} className={`rounded-md border p-3 text-xs ${rojo ? "border-brick-500 bg-brick-50" : "border-line"}`}>
                <div className="flex items-start gap-2">
                  <input type="checkbox" className="mt-0.5" aria-label={`Aplicar el precio nuevo a ${id}`} disabled={ocupado || !aplicable(id)}
                    checked={tildados.has(id) && aplicable(id)} onChange={() => alternar(setTildados, id)} />
                  <p className="min-w-0 break-words text-ink-900">
                    {f ? [f.nombre, f.color, f.talle].filter(Boolean).join(" · ") : "Sin calcular"}{" "}
                    <span className="font-mono text-[11px] text-ink-500">{id}</span>
                  </p>
                </div>
                {f && (
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <div>
                      <p className="text-ink-500">Actual</p>
                      <p className="text-ink-900">{$(f.precioActual)}</p>
                      {f.precioCobradoHoy != null && f.precioCobradoHoy !== f.precioActual && <p className="text-ink-500">se cobra {$(f.precioCobradoHoy)}</p>}
                    </div>
                    <label className="text-ink-500">Nuevo{f.sugerido ? " (sugerido)" : ""}
                      <input className="input mt-0.5 !px-2 !py-1" type="number" min="1" step="any" value={precios[id] ?? ""} disabled={ocupado}
                        onChange={(e) => setPrecios({ ...precios, [id]: e.target.value })} />
                      {f.cambioPct != null && !vieja(id) && <span>{f.cambioPct > 0 ? "+" : ""}{f.cambioPct}%</span>}
                    </label>
                    <div>
                      <p className="text-ink-500">Te queda hoy</p>
                      <p className="text-ink-900">{$(f.antes?.leQueda)}</p>
                    </div>
                    <div>
                      <p className="text-ink-500">Te quedaría</p>
                      <p className={`font-semibold ${rojo ? "text-brick-500" : "text-teal-600"}`}>{vieja(id) ? "Recalculá" : $(f.despues?.leQueda)}</p>
                      {f.piso != null && <p className="text-ink-500">costo + packing {$(f.piso)}</p>}
                      {f.piso == null && <p className="text-brass-700">Sin costo en Stocker</p>}
                    </div>
                  </div>
                )}
                {f?.extraPct > 0 && f.despues && !vieja(id) && <p className="mt-1 text-ink-600">Con {f.extraPct}% de descuento el comprador paga {$(f.despues.precioConDescuento)}.</p>}
                {rojo && <p className="mt-1 font-semibold text-brick-500">Queda por debajo de costo + packing.</p>}
                {f?.error && <p className="mt-1 break-words text-brick-500">{f.error}</p>}
                {rechazos[id] && <p className="mt-1 break-words text-brick-500">{rechazos[id].motivo}</p>}
                {pideOk(id) && aplicable(id) && (
                  <label className="mt-2 flex items-start gap-2 text-brass-700">
                    <input type="checkbox" checked={confirmados.has(id)} disabled={ocupado} onChange={() => alternar(setConfirmados, id)} />
                    Confirmo este cambio grande de precio ({$(f.precioActual)} a {$(f.precioNuevo)})
                  </label>
                )}
              </li>
            );
          })}
        </ul>

        <div className="sticky bottom-0 space-y-2 border-t border-line bg-paper-50 py-3">
          <Alerta>{error}</Alerta>
          {elegidos.length > 1 && <Alerta tono="aviso">Si es la primera vez, probá primero con una sola publicación: Mercado Libre puede rechazar el cambio de precio.</Alerta>}
          {faltaOk.length > 0 && <p className="text-xs text-brass-700">Falta confirmar el cambio grande en {faltaOk.length} publicación(es) tildada(s).</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={onClose} disabled={aplicando}>Cancelar</button>
            <button type="button" className="btn-accent" onClick={aplicar} disabled={ocupado || !elegidos.length || faltaOk.length > 0}>
              {aplicando ? "Enviando…" : `Aplicar ${elegidos.length} precio${elegidos.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** El avance (y el resultado) del cambio de precios que corre en el servidor. */
export function AvancePrecios({ trabajo, onCerrar }) {
  const pr = trabajo.progreso || {};
  const res = trabajo.resultado;
  const items = Object.entries(res?.porItem || pr.porItem || {});
  const pct = pr.total ? Math.round((pr.hechos / pr.total) * 100) : 0;
  return (
    <Card className="mb-4">
      <div className="flex items-start justify-between gap-2">
        <p className="font-display text-sm font-semibold text-ink-950">Cambio de precios</p>
        {trabajo.estado !== "corriendo" && <button type="button" className="text-ink-500" onClick={onCerrar} aria-label="Cerrar"><X size={16} /></button>}
      </div>
      {trabajo.estado === "corriendo" && (
        <>
          <p className="mt-2 text-sm text-ink-700" role="status">{pr.total ? `Van ${pr.hechos} de ${pr.total}…` : "Empezando…"}</p>
          <div className="mt-2 h-2 rounded bg-paper-200"><div className="h-2 rounded bg-teal-600" style={{ width: `${pct}%` }} /></div>
        </>
      )}
      {trabajo.estado === "error" && <p className="mt-2 break-words text-sm text-brick-500">El cambio de precios falló: {trabajo.error}</p>}
      {trabajo.estado === "ninguno" && <p className="mt-2 text-sm text-brick-500">Se perdió el seguimiento (el servidor se reinició). Actualizá la lista y revisá qué precios cambiaron.</p>}
      {res && <p className="mt-2 text-sm text-ink-800">Listo: {res.cambiados} cambiado(s), {res.fallaron} con error.</p>}
      <ul className="mt-2 max-h-56 space-y-0.5 overflow-y-auto text-xs">
        {items.map(([id, x]) => (
          <li key={id} className="break-words">
            <span className="font-mono text-[11px] text-ink-500">{id}</span> {$(x.de)} a {$(x.a)}{" "}
            {x.estado === "cambiado" ? <span className="text-teal-600">cambiado</span> : <span className="text-brick-500">{x.error}</span>}
            {x.aviso && <span className="text-brass-700"> — {x.aviso}</span>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
