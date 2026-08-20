import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, X, AlertTriangle, Undo2 } from "lucide-react";
import { ajusteMasivoStock, fetchVariantesPorLocal } from "../../services/productService";
import { fetchPos } from "../../services/employeeService";
import { ordenarVariantes, CRITERIOS } from "../../utils/ordenVariantes";
import { GrupoFiltro, OpcionFiltro } from "../ui/Filtros";

/*
 * Carga de stock de todas las variantes de un producto, de una sola vez.
 *
 * Reemplaza el ir variante por variante: escribir un número, esperar la
 * llamada, ver la página recargarse y buscar dónde estaba uno. Al descargar un
 * remito de veinte líneas eso son veinte esperas y veinte veces perder el hilo.
 *
 * Acá se completa toda la columna con el teclado —Enter y flechas bajan a la
 * siguiente— y se manda todo junto. El servidor lo aplica en una transacción:
 * entra el remito completo o no entra nada.
 */

const MODOS = [
  { value: "sumar", label: "Sumar", ayuda: "Lo que ENTRÓ. Se suma a lo que ya hay." },
  { value: "fijar", label: "Fijar",  ayuda: "Lo que CONTASTE. Reemplaza el stock actual." },
];

export default function CargaRapidaStock({ group, orden: ordenInicial = "talle", onListo, onCancelar }) {
  /*
   * El stock por local del producto.
   *
   * "Stock actual" tiene que ser el del local al que se está cargando, no el
   * total. Mostrando el total, con 32 en Palermo y 0 en Belgrano, elegir
   * Belgrano y fijar 5 mostraba "32 → 5" como si se estuvieran sacando 27 de
   * ahí, cuando en ese local no hay ninguna.
   */
  const [desglose, setDesglose] = useState(null);
  const [modo, setModo] = useState("sumar");
  const [orden, setOrden] = useState(ordenInicial);
  const [valores, setValores] = useState({});          // variantId → texto
  const [locales, setLocales] = useState([]);
  const [locationId, setLocationId] = useState("");
  const [motivo, setMotivo] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchPos()
      .then((ls) => {
        setLocales(ls);
        // Con un solo local no hay nada que elegir.
        if (ls.length === 1) setLocationId(String(ls[0].id));
      })
      .catch(() => {});

    const productId = group.variants?.[0]?.productId;
    if (productId) fetchVariantesPorLocal(productId).then(setDesglose).catch(() => setDesglose(null));
  }, [group]);

  // variantId → stock en el local elegido. Sin local elegido, el total.
  const stockActual = (v) => {
    if (!locationId || !desglose) return v.stock;
    const fila = desglose.variantes.find((x) => x.variantId === v.id);
    return fila?.porLocal.find((p) => String(p.locationId) === String(locationId))?.stock ?? 0;
  };

  const variantes = useMemo(() => ordenarVariantes(group.variants, orden), [group.variants, orden]);

  /*
   * Sólo viajan las líneas con un número cargado.
   *
   * Un campo vacío no es "poner cero": es "esta variante no se toca". Mandarlas
   * todas convertiría un remito de tres líneas en un ajuste de veinte, con
   * diecisiete puestas en cero.
   */
  const lineas = variantes
    .map((v) => {
      const texto = (valores[v.id] ?? "").trim();
      if (texto === "") return null;
      const n = Number(texto);
      if (!Number.isFinite(n)) return null;
      return modo === "fijar"
        ? { variantId: v.id, fijar: n }
        : (n === 0 ? null : { variantId: v.id, delta: n });
    })
    .filter(Boolean);

  const unidades = lineas.reduce((s, l) => s + Math.abs(l.delta ?? 0), 0);

  function poner(id, valor) {
    // Se permite el signo menos: en modo sumar, "-2" es una baja.
    if (!/^-?\d*$/.test(valor)) return;
    setValores((v) => ({ ...v, [id]: valor }));
    setError("");
  }

  /*
   * Enter y flechas mueven al siguiente campo.
   *
   * Es lo que convierte la carga en algo de teclado: se recorre el remito sin
   * soltar la mano para ir al mouse.
   */
  function teclas(e, i) {
    const siguiente = (paso) => {
      const campos = [...e.target.closest("tbody").querySelectorAll("input")];
      const destino = campos[i + paso];
      if (destino) { destino.focus(); destino.select(); }
      e.preventDefault();
    };
    if (e.key === "Enter" || e.key === "ArrowDown") siguiente(1);
    if (e.key === "ArrowUp") siguiente(-1);
    if (e.key === "Escape") onCancelar();
  }

  async function guardar() {
    if (!lineas.length) { setError("No cargaste ninguna cantidad."); return; }
    if (locales.length > 1 && !locationId) { setError("Elegí a qué local entra la mercadería."); return; }
    setGuardando(true); setError("");
    try {
      const r = await ajusteMasivoStock({
        locationId: locationId || null,
        /*
         * El motivo por defecto sigue al signo.
         *
         * En modo sumar, un número negativo es una corrección sobre lo que se
         * acaba de cargar, no un ingreso. Anotarlo como "Ingreso de mercadería"
         * dejaba en el libro un egreso con motivo de entrada, que es
         * exactamente lo que uno no quiere encontrar auditando.
         */
        motivo: motivo.trim() || (
          modo === "fijar" ? "Conteo de inventario"
            : (lineas.every((l) => (l.delta ?? 0) < 0) ? "Corrección de ingreso" : "Ingreso de mercadería")
        ),
        items: lineas,
      });
      await onListo(r);
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo guardar.");
    } finally {
      setGuardando(false);
    }
  }

  const ayuda = MODOS.find((m) => m.value === modo)?.ayuda;

  return (
    <div className="card p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <GrupoFiltro>
            {MODOS.map((m) => (
              <OpcionFiltro key={m.value} activa={modo === m.value} onClick={() => setModo(m.value)}>
                {m.label}
              </OpcionFiltro>
            ))}
          </GrupoFiltro>
          <span className="text-xs text-ink-600">{ayuda}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {locales.length > 1 && (
            <select className="input w-auto py-1.5 text-xs" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">¿A qué local?</option>
              {locales.map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
            </select>
          )}
          <input className="input w-40 py-1.5 text-xs" placeholder="Motivo (ej: Remito 1234)"
            value={motivo} onChange={(e) => setMotivo(e.target.value)} />
          <GrupoFiltro>
            {CRITERIOS.map((c) => (
              <OpcionFiltro key={c.value} activa={orden === c.value} onClick={() => setOrden(c.value)}>
                {c.label}
              </OpcionFiltro>
            ))}
          </GrupoFiltro>
        </div>
      </div>

      {error && (
        <p className="flex items-start gap-2 border-b border-line bg-brick-50 px-4 py-2.5 text-sm text-brick-600">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-line bg-paper-100 text-left text-xs uppercase tracking-wide text-ink-600">
              <th className="px-4 py-2 font-medium">Variante</th>
              <th className="px-2 py-2 font-medium">SKU</th>
              <th className="px-2 py-2 text-right font-medium">
                {/* Se nombra el local: "stock actual" a secas es ambiguo en
                    cuanto hay más de uno. */}
                Stock {locales.find((l) => String(l.id) === String(locationId))?.nombre || "actual"}
              </th>
              <th className="px-2 py-2 text-right font-medium">{modo === "fijar" ? "Contado" : "Entró"}</th>
              <th className="px-4 py-2 text-right font-medium">Queda</th>
            </tr>
          </thead>
          <tbody>
            {variantes.map((v, i) => {
              const texto = valores[v.id] ?? "";
              const n = texto.trim() === "" ? null : Number(texto);
              const actual = stockActual(v);
              const queda = n === null || !Number.isFinite(n)
                ? null
                : (modo === "fijar" ? n : actual + n);
              const negativo = queda !== null && queda < 0;
              return (
                <tr key={v.id} className={`border-b border-line last:border-0 ${negativo ? "bg-brick-50" : ""}`}>
                  <td className="whitespace-nowrap px-4 py-1.5 text-ink-800">
                    {[v.variante1Valor, v.variante2Valor].filter(Boolean).join(" · ") || <span className="text-ink-400">—</span>}
                  </td>
                  <td className="px-2 py-1.5"><span className="tag-chip">{v.sku}</span></td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-ink-600">{actual}</td>
                  <td className="px-2 py-1.5 text-right">
                    <input
                      className={`input h-8 w-24 text-right text-xs ${negativo ? "border-brick-500" : ""}`}
                      inputMode="numeric"
                      autoFocus={i === 0}
                      placeholder="—"
                      value={texto}
                      onChange={(e) => poner(v.id, e.target.value)}
                      onKeyDown={(e) => teclas(e, i)}
                      onFocus={(e) => e.target.select()}
                    />
                  </td>
                  <td className="px-4 py-1.5 text-right">
                    {queda === null ? (
                      <span className="text-ink-300">{actual}</span>
                    ) : (
                      <span className={`font-display font-semibold tabular-nums ${negativo ? "text-brick-500" : "text-ink-950"}`}>
                        {queda}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
        <p className="text-xs text-ink-600">
          {lineas.length === 0
            ? "Completá las cantidades. Las vacías no se tocan."
            : modo === "fijar"
              ? `${lineas.length} variante${lineas.length === 1 ? "" : "s"} se van a fijar.`
              : `${lineas.length} variante${lineas.length === 1 ? "" : "s"} · ${unidades} unidades.`}
          <span className="ml-2 text-ink-400">Enter baja a la siguiente.</span>
        </p>
        <div className="flex items-center gap-2">
          <button className="btn-ghost" onClick={onCancelar} disabled={guardando}>
            <X size={15} /> Cancelar
          </button>
          {Object.keys(valores).length > 0 && (
            <button className="btn-ghost text-xs" onClick={() => { setValores({}); setError(""); }} disabled={guardando}>
              <Undo2 size={13} /> Limpiar
            </button>
          )}
          <button className="btn btn-primary" onClick={guardar} disabled={guardando || lineas.length === 0}>
            {guardando ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
            {guardando ? "Guardando…" : "Guardar todo"}
          </button>
        </div>
      </div>
    </div>
  );
}
