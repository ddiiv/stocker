import { useEffect, useMemo } from "react";
import { Plus, Trash2, Split, AlertCircle } from "lucide-react";
import { formatCurrency } from "../../utils/formatters";

/*
 * Reparto del cobro entre uno o varios medios de pago.
 *
 * Dos cosas que conviene tener claras antes de leer el código:
 *
 *   · Los IMPORTES son netos de mercadería y tienen que sumar el total de la
 *     venta. El recargo va por encima: no se cubre mercadería con el recargo.
 *   · El ajuste de cada medio se aplica SIEMPRE, sobre su propia línea. Pagar
 *     $300 por transferencia con 5% cuesta $315, sea sola o combinada.
 *
 * Lo segundo cambió: antes, con dos o más medios no se aplicaba ningún ajuste.
 * La intención era no castigar al que reparte, pero dividir el pago pasaba a
 * ser la forma de esquivar el recargo, y el mismo medio costaba distinto según
 * con qué se lo combinara.
 *
 * ── El reparto automático ──────────────────────────────────────────
 *
 * La regla es una y se puede decir en una línea: lo que escribís queda fijo, y
 * lo que falta se reparte entre las líneas que no tocaste. Si las tocaste
 * todas, la última se ajusta.
 *
 * Antes no había reparto: escribir 300 en una de dos líneas dejaba la otra
 * como estaba y aparecía "faltan $700 por asignar", que el cajero tenía que
 * resolver a mano y con el cliente esperando.
 *
 * Replicar acá la regla del servidor no es duplicar lógica por gusto: si la
 * pantalla mostrara un total distinto del que después calcula el servidor, el
 * cliente pagaría un importe y el comprobante saldría con otro.
 */
const redondear = (n) => Math.round(Number(n) * 100) / 100;

/** El ajuste que le corresponde a una línea: el manual gana sobre el del medio. */
function ajusteDe(linea, metodos) {
  const manual = linea.ajusteManual !== "" && linea.ajusteManual !== null && linea.ajusteManual !== undefined;
  if (manual) {
    const n = Number(linea.ajusteManual);
    return Number.isFinite(n) ? n : 0;
  }
  const metodo = metodos.find((m) => String(m.id) === String(linea.paymentMethodId));
  return Number(metodo?.ajustePct || 0);
}

/*
 * Reparte lo que falta entre las líneas libres.
 *
 * `idxEditado` es la línea que la persona acaba de tocar: ésa no se toca nunca,
 * porque pisarle el número que acaba de escribir es la peor forma de ayudar.
 *
 * Se devuelve un array nuevo; el llamador decide si lo usa.
 */
function repartir(lineas, total, idxEditado) {
  if (lineas.length <= 1) return lineas;

  const fijos = lineas.reduce(
    (s, l, i) => (i === idxEditado || l.fijado ? s + (Number(l.monto) || 0) : s), 0,
  );
  let resto = redondear(total - fijos);

  const libres = lineas
    .map((l, i) => i)
    .filter((i) => i !== idxEditado && !lineas[i].fijado);

  /*
   * Si no quedó ninguna libre, se ajusta la última que no sea la editada.
   *
   * Es el caso de dos líneas ya escritas a mano: sin esto la suma queda mal y
   * el cajero tiene que borrar y empezar de nuevo. Se elige la última y no la
   * primera porque la primera suele ser el efectivo contado, el número que
   * menos se quiere pisar.
   */
  const destinos = libres.length
    ? libres
    : lineas.map((l, i) => i).filter((i) => i !== idxEditado).slice(-1);

  if (!destinos.length) return lineas;

  const copia = lineas.map((l) => ({ ...l }));
  const parte = redondear(resto / destinos.length);
  destinos.forEach((i, k) => {
    // El último se lleva el redondeo: repartir 100 en 3 no da tres números iguales.
    const monto = k === destinos.length - 1 ? redondear(resto) : parte;
    resto = redondear(resto - monto);
    // Nunca negativo: si los importes escritos ya superan el total, el cartel
    // de "superan el total" es el que tiene que aparecer, no un importe en rojo.
    copia[i].monto = Math.max(0, monto);
  });
  return copia;
}

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
    const ajustePct = ajusteDe(l, metodos);
    const monto = Number(l.monto) || 0;
    const ajusteMonto = redondear(monto * ajustePct / 100);
    return { ...l, metodo, ajustePct, ajusteMonto, montoFinal: redondear(monto + ajusteMonto) };
  }), [lineas, metodos]);

  const sumaBase   = redondear(calculadas.reduce((s, l) => s + (Number(l.monto) || 0), 0));
  const ajusteTot  = redondear(calculadas.reduce((s, l) => s + l.ajusteMonto, 0));
  const totalCobro = redondear(sumaBase + ajusteTot);
  const diferencia = redondear(total - sumaBase);
  const cuadra     = Math.abs(diferencia) < 0.02;

  function actualizar(idx, patch) {
    onChange(lineas.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  /*
   * Escribir un importe fija esa línea y reparte el resto.
   *
   * Es el corazón del pedido: poner 300 en transferencia deja 700 en efectivo
   * sin que nadie tenga que restar.
   */
  function cambiarMonto(idx, valor) {
    const conValor = lineas.map((l, i) => (i === idx ? { ...l, monto: valor, fijado: true } : l));
    onChange(repartir(conValor, total, idx));
  }

  function agregar() {
    // La línea nueva arranca con lo que falta cubrir, y queda libre: es la que
    // va a absorber los cambios de las otras.
    const restante = redondear(total - sumaBase);
    const usados = new Set(lineas.map((l) => String(l.paymentMethodId)));
    const libre = metodos.find((m) => !usados.has(String(m.id))) || metodos[0];
    onChange([...lineas, {
      paymentMethodId: libre?.id || "",
      monto: restante > 0 ? restante : 0,
      ajusteManual: "",
      fijado: false,
    }]);
  }

  function quitar(idx) {
    const quedan = lineas.filter((_, i) => i !== idx);
    if (quedan.length === 1) return onChange([{ ...quedan[0], monto: redondear(total), fijado: false }]);
    // Al sacar una línea su importe queda huérfano: se reparte entre las demás.
    onChange(repartir(quedan.map((l) => ({ ...l, fijado: false })), total, -1));
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
              <button type="button" className="btn-ghost px-2 py-1 text-brick-500" onClick={() => quitar(idx)}
                aria-label={`Quitar ${l.metodo?.nombre || "este medio de pago"}`}>
                <Trash2 size={14} />
              </button>
            )}
          </div>

          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <label className="label text-[11px]">
                Importe
                {/* Decir cuál se está ajustando sola evita que el cajero crea
                    que el sistema le cambió un número que él había puesto. */}
                {!esUnico && !l.fijado && (
                  <span className="ml-1 font-normal normal-case text-ink-500">· se ajusta solo</span>
                )}
              </label>
              <input
                type="number" step="0.01" min="0" className="input"
                value={l.monto}
                disabled={esUnico}
                onChange={(e) => cambiarMonto(idx, e.target.value)}
              />
            </div>
            <div>
              <label className="label text-[11px]">Ajuste %</label>
              <input
                type="number" step="0.01" min="-100" max="100" className="input"
                value={l.ajusteManual ?? ""}
                placeholder={String(Number(l.metodo?.ajustePct || 0))}
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
          Escribí un importe y el resto se reparte solo. Cada medio lleva su propio
          recargo, calculado sobre lo que se paga con él.
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
    const pct = ajusteDe(l, metodos);
    // Con una sola línea el importe ES el total, aunque el estado todavía no
    // se haya sincronizado: usarlo evita un parpadeo en el botón de cobro.
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
      /*
       * El ajuste sólo viaja si el cajero lo escribió.
       *
       * Si no, lo pone el servidor con el `ajustePct` del medio — la misma
       * regla que aplica esta pantalla. Mandarlo igual sería tener dos fuentes
       * de verdad para el mismo número.
       */
      ...(manual ? { ajustePct: Number(l.ajusteManual) } : {}),
    };
  });
}
