import { useEffect, useMemo } from "react";
import { Plus, Trash2, Split, AlertCircle } from "lucide-react";
import { formatCurrency } from "../../utils/formatters";

/*
 * Reparto del cobro entre uno o varios medios de pago.
 *
 * El ajuste configurado en cada medio se aplica sólo cuando el cobro es con un
 * único medio — misma regla que aplica el backend al guardar. Con el pago
 * repartido no se aplica ninguno, pero el cajero puede escribirlo a mano en la
 * línea que corresponda.
 *
 * Replicar acá la regla no es duplicar lógica por gusto: si la pantalla
 * mostrara un total distinto del que después calcula el servidor, el cliente
 * pagaría un importe y el comprobante saldría con otro.
 */
const redondear = (n) => Math.round(Number(n) * 100) / 100;

export default function PaymentSplit({ metodos, total, lineas, onChange }) {
  const esUnico = lineas.length === 1;

  // Con una sola línea el importe siempre es el total: que quede desfasado por
  // haber editado y después borrado una línea sería un error silencioso.
  useEffect(() => {
    if (esUnico && redondear(lineas[0]?.monto) !== redondear(total)) {
      onChange([{ ...lineas[0], monto: redondear(total) }]);
    }
  }, [total, esUnico, lineas, onChange]);

  const calculadas = useMemo(() => lineas.map((l) => {
    const metodo = metodos.find((m) => String(m.id) === String(l.paymentMethodId));
    // Ajuste efectivo: el manual gana; si no, el del medio sólo con cobro único.
    const ajustePct = l.ajusteManual !== "" && l.ajusteManual !== null && l.ajusteManual !== undefined
      ? Number(l.ajusteManual)
      : (esUnico ? Number(metodo?.ajustePct || 0) : 0);
    const monto = Number(l.monto) || 0;
    const ajusteMonto = redondear(monto * ajustePct / 100);
    return { ...l, metodo, ajustePct, ajusteMonto, montoFinal: redondear(monto + ajusteMonto) };
  }), [lineas, metodos, esUnico]);

  const sumaBase   = redondear(calculadas.reduce((s, l) => s + (Number(l.monto) || 0), 0));
  const ajusteTot  = redondear(calculadas.reduce((s, l) => s + l.ajusteMonto, 0));
  const totalCobro = redondear(sumaBase + ajusteTot);
  const diferencia = redondear(total - sumaBase);
  const cuadra     = Math.abs(diferencia) < 0.02;

  function actualizar(idx, patch) {
    onChange(lineas.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  function agregar() {
    // La línea nueva arranca con lo que falta cubrir, que es lo que se quiere
    // el 90% de las veces: el resto después de una parte en efectivo.
    const restante = redondear(total - sumaBase);
    const usados = new Set(lineas.map((l) => String(l.paymentMethodId)));
    const libre = metodos.find((m) => !usados.has(String(m.id))) || metodos[0];
    onChange([...lineas, {
      paymentMethodId: libre?.id || "",
      monto: restante > 0 ? restante : 0,
      ajusteManual: "",
    }]);
  }

  function quitar(idx) {
    const quedan = lineas.filter((_, i) => i !== idx);
    // Al volver a una sola línea, esa línea cubre todo el total.
    onChange(quedan.length === 1 ? [{ ...quedan[0], monto: redondear(total) }] : quedan);
  }

  return (
    <div className="space-y-3">
      {calculadas.map((l, idx) => (
        <div key={idx} className="rounded-md border border-line bg-paper-50 p-3">
          <div className="flex items-center gap-2">
            <select
              className="input flex-1"
              value={l.paymentMethodId}
              onChange={(e) => actualizar(idx, { paymentMethodId: e.target.value })}
            >
              {metodos.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
            </select>
            {lineas.length > 1 && (
              <button type="button" className="btn-ghost px-2 py-1 text-brick-500" onClick={() => quitar(idx)}>
                <Trash2 size={14} />
              </button>
            )}
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2">
            <div>
              <label className="label text-[11px]">Importe</label>
              <input
                type="number" step="0.01" min="0" className="input"
                value={l.monto}
                disabled={esUnico}
                onChange={(e) => actualizar(idx, { monto: e.target.value })}
              />
            </div>
            <div>
              <label className="label text-[11px]">Ajuste %</label>
              <input
                type="number" step="0.01" min="-100" max="100" className="input"
                value={l.ajusteManual ?? ""}
                placeholder={String(l.ajustePct)}
                onChange={(e) => actualizar(idx, { ajusteManual: e.target.value })}
              />
            </div>
          </div>

          {l.ajusteMonto !== 0 && (
            <p className={`mt-1.5 text-xs ${l.ajusteMonto > 0 ? "text-brick-500" : "text-teal-600"}`}>
              {l.ajusteMonto > 0 ? "Recargo" : "Descuento"} {Math.abs(l.ajustePct)}%:{" "}
              {l.ajusteMonto > 0 ? "+" : "−"}{formatCurrency(Math.abs(l.ajusteMonto))} → cobra {formatCurrency(l.montoFinal)}
            </p>
          )}
        </div>
      ))}

      {lineas.length < metodos.length && (
        <button type="button" className="btn-ghost w-full justify-center border border-dashed border-line text-xs" onClick={agregar}>
          <Plus size={13} /> Dividir en otro medio de pago
        </button>
      )}

      {!cuadra && (
        <p className="flex items-start gap-1.5 rounded-md bg-brick-50 px-3 py-2 text-xs text-brick-500">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          {diferencia > 0
            ? `Faltan ${formatCurrency(diferencia)} por asignar.`
            : `Los importes superan el total en ${formatCurrency(Math.abs(diferencia))}.`}
        </p>
      )}

      {ajusteTot !== 0 && cuadra && (
        <div className="rounded-md bg-paper-100 px-3 py-2 text-sm">
          <div className="flex justify-between text-ink-600">
            <span>Mercadería</span><span>{formatCurrency(sumaBase)}</span>
          </div>
          <div className={`flex justify-between ${ajusteTot > 0 ? "text-brick-500" : "text-teal-600"}`}>
            <span>{ajusteTot > 0 ? "Recargo" : "Descuento"}</span>
            <span>{ajusteTot > 0 ? "+" : "−"}{formatCurrency(Math.abs(ajusteTot))}</span>
          </div>
          <div className="mt-1 flex justify-between border-t border-line pt-1 font-display font-semibold text-ink-950">
            <span>A cobrar</span><span>{formatCurrency(totalCobro)}</span>
          </div>
        </div>
      )}

      {lineas.length > 1 && (
        <p className="flex items-start gap-1.5 text-xs text-ink-500">
          <Split size={13} className="mt-0.5 shrink-0" />
          Al repartir el pago no se aplican los recargos configurados. Si corresponde
          cobrar uno, escribilo en la línea.
        </p>
      )}
    </div>
  );
}

/**
 * Totales del cobro según el reparto actual.
 *
 * Lo usa el POS para que el botón muestre lo que hay que pedirle al cliente y
 * no el neto de mercadería: con un recargo del 5% son importes distintos, y
 * cobrar el que no es se descubre recién al contar la caja.
 */
export function calcularTotales(lineas, metodos, total) {
  const esUnico = lineas.length === 1;
  let ajuste = 0;
  for (const l of lineas) {
    const metodo = metodos.find((m) => String(m.id) === String(l.paymentMethodId));
    const manual = l.ajusteManual !== "" && l.ajusteManual !== null && l.ajusteManual !== undefined;
    const pct = manual ? Number(l.ajusteManual) : (esUnico ? Number(metodo?.ajustePct || 0) : 0);
    const base = esUnico ? Number(total) : (Number(l.monto) || 0);
    ajuste += base * (Number.isFinite(pct) ? pct : 0) / 100;
  }
  const ajusteTotal = redondear(ajuste);
  return { ajusteTotal, totalCobro: redondear(Number(total) + ajusteTotal) };
}

/** Convierte las líneas de la pantalla al formato que espera la API. */
export function lineasParaApi(lineas, metodos, total) {
  const esUnico = lineas.length === 1;
  return lineas.map((l) => {
    const metodo = metodos.find((m) => String(m.id) === String(l.paymentMethodId));
    const manual = l.ajusteManual !== "" && l.ajusteManual !== null && l.ajusteManual !== undefined;
    return {
      paymentMethodId: l.paymentMethodId ? Number(l.paymentMethodId) : null,
      nombre: metodo?.nombre,
      monto: esUnico ? redondear(total) : redondear(l.monto),
      // Sólo se manda si el cajero lo escribió: si no, que decida el backend
      // con su propia regla y no haya dos fuentes de verdad.
      ...(manual ? { ajustePct: Number(l.ajusteManual) } : {}),
    };
  });
}
