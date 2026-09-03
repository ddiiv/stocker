import { useState } from "react";
import { Layers, X, Loader2, Search } from "lucide-react";
import { http } from "../../lib/http";
import { fetchSerie } from "../../services/depositoService";
import { mensajeDeError } from "../../utils/errores";

/*
 * Carga por series.
 *
 * La mercadería no llega en unidades sueltas: llega en conjuntos del mismo
 * modelo que comparten una variante y se diferencian en la otra. Cargarlo uno
 * por uno es escribir cinco líneas para decir una sola cosa, y con veinte
 * modelos por camión es donde aparecen los errores de tipeo.
 *
 * ── Sobre qué variante se arma ─────────────────────────────────────
 *
 * Es la decisión que faltaba, y no es un detalle: cambia cuántas unidades
 * entran y cuáles.
 *
 *   Remera · Negro/Blanco · S/M/L
 *   3 series fijando el COLOR Negro → 3 de cada talle  = 9 unidades
 *   3 series fijando el TALLE M     → 3 de cada color  = 6 unidades
 *
 * Antes se fijaba siempre la primera variante. El que compra "diez de cada
 * color en talle M" no tenía forma de cargarlo sin escribir línea por línea.
 *
 * ── Una sola lista ─────────────────────────────────────────────────
 *
 * Lo que se arma acá no queda en una lista aparte: se expande a líneas y cae
 * en la misma tabla que lo buscado a mano. Antes eran dos listas separadas y
 * el total de lo que se iba a ingresar no estaba en ninguna pantalla: había
 * que sumarlo de cabeza entre "curvas cargadas" y los artículos sueltos.
 *
 * La expansión usa los valores que devolvió el servidor, no una regla propia:
 * acá sólo se arman las líneas con lo que ya vino resuelto.
 */
export default function CargaPorSeries({ onAgregar }) {
  const [texto, setTexto] = useState("");
  const [resultados, setResultados] = useState([]);
  const [buscando, setBuscando] = useState(false);
  const [error, setError] = useState("");

  const [producto, setProducto] = useState(null);   // { id, titulo }
  const [serie, setSerie] = useState(null);         // respuesta de fetchSerie
  const [eje, setEje] = useState("variante1");      // cuál se fija
  const [valorFijo, setValorFijo] = useState("");
  const [cantidad, setCantidad] = useState(1);
  const [porValor, setPorValor] = useState(null);   // null = serie pareja

  async function buscar(e) {
    e?.preventDefault?.();
    const q = texto.trim();
    if (q.length < 2) return;
    setBuscando(true); setError("");
    try {
      // Sin productos de evento: no llevan stock y no entran al depósito.
      const { data } = await http.get("/products/buscar-variantes", { params: { q, limit: 40, sinEvento: 1 } });
      const r = data.data || data || [];
      /*
       * Se busca por variante pero se elige el PRODUCTO: la serie es del modelo
       * entero, no de un talle. Se agrupa por producto para no mostrar nueve
       * veces el mismo pantalón.
       */
      const porProducto = new Map();
      for (const v of r || []) {
        if (v.esFeria) continue;  // los de evento no llevan stock
        if (!porProducto.has(v.productId)) {
          porProducto.set(v.productId, { id: v.productId, titulo: v.titulo, sku: v.skuAgrupador });
        }
      }
      setResultados([...porProducto.values()].slice(0, 8));
    } catch (err) {
      setError(mensajeDeError(err, "No se pudo buscar."));
    } finally {
      setBuscando(false);
    }
  }

  async function abrir(p, { valor = "", ejePedido = eje } = {}) {
    setError("");
    try {
      const s = await fetchSerie({ productId: p.id, valor, eje: ejePedido });
      setProducto(p);
      setSerie(s);
      setEje(s.ejeUsado || ejePedido);
      setValorFijo(s.necesitaValor ? "" : (s.fijo || ""));
      setPorValor(null);
      setCantidad(1);
      setResultados([]);
      setTexto("");
    } catch (err) {
      setError(mensajeDeError(err, "No se pudo abrir la serie de ese producto."));
    }
  }

  /* Cambiar el eje vuelve al paso de elegir valor: los valores del eje viejo
     no significan nada en el nuevo. */
  function cambiarEje(nuevo) {
    if (!producto || nuevo === eje) return;
    setEje(nuevo);
    abrir(producto, { valor: "", ejePedido: nuevo });
  }

  const valores = serie?.valores || [];
  const unidades = porValor
    ? Object.values(porValor).reduce((s, n) => s + (Number(n) || 0), 0)
    : valores.length * (Number(cantidad) || 0);

  /*
   * Se agregan LÍNEAS, no una serie.
   *
   * Cada valor del eje recorrido es una variante concreta, con su id y su SKU:
   * expandirlo acá es lo que permite que caiga en la misma lista que lo
   * buscado a mano, y que después se pueda corregir una cantidad suelta sin
   * tener que rehacer la serie entera.
   */
  function agregar() {
    if (!producto || !valores.length) return;
    const lineas = valores
      .map((v) => ({
        productVariantId: v.variantId,
        sku: v.sku,
        titulo: producto.titulo,
        /*
         * Siempre en el orden variante1 · variante2.
         *
         * Da igual cuál se haya fijado: en la lista conviven estas líneas con
         * las buscadas a mano, que salen en ese orden. Armarlas al revés
         * cuando se fija el talle mostraba "M · Beige" al lado de
         * "Beige · M" y parecían dos productos distintos.
         */
        variante: (serie.ejeUsado === "variante2"
          ? [v.valor, serie.fijo]
          : [serie.fijo, v.valor]).filter(Boolean).join(" · "),
        cantidad: porValor ? (Number(porValor[v.valor]) || 0) : (Number(cantidad) || 0),
        // De qué serie salió, para poder decirlo en la lista.
        origenSerie: serie.fijo ? `${serie.ejeFijo || "Serie"} ${serie.fijo}` : "Serie",
      }))
      .filter((l) => l.cantidad > 0);

    if (!lineas.length) return;
    onAgregar(lineas);
    setProducto(null); setSerie(null); setValorFijo(""); setPorValor(null); setCantidad(1);
  }

  const dosDimensiones = serie && !serie.unaDimension;
  const nombreFijo = serie?.ejeFijo || "Variante";
  const nombreRecorrido = serie?.ejeRecorrido || serie?.eje || "Variante";

  return (
    <div className="rounded-md border border-line bg-paper-50 p-3">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-600">
        <Layers size={13} className="mr-1 inline" /> Cargar por series
      </p>

      {error && <p className="mb-2 rounded-md bg-brick-50 px-2 py-1.5 text-xs text-brick-500">{error}</p>}

      {!producto ? (
        <>
          <form onSubmit={buscar} className="flex gap-2">
            <input
              className="input flex-1 py-1 text-sm"
              placeholder="Buscar el modelo por título o SKU…"
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
            />
            <button className="btn-ghost py-1 text-xs" type="submit" disabled={buscando}>
              {buscando ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} Buscar
            </button>
          </form>

          {resultados.length > 0 && (
            <ul className="mt-2 divide-y divide-line rounded-md border border-line bg-paper-50">
              {resultados.map((p) => (
                <li key={p.id}>
                  <button
                    className="flex w-full items-baseline justify-between px-3 py-2 text-left text-sm hover:bg-paper-200"
                    onClick={() => abrir(p)}
                  >
                    <span className="text-ink-900">{p.titulo}</span>
                    <span className="font-mono text-xs text-ink-500">{p.sku}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <div>
          <div className="mb-3 flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-ink-950">{producto.titulo}</p>
              {serie?.fijo && (
                <p className="text-xs text-ink-500">
                  {nombreFijo} {serie.fijo} · {valores.length} {String(serie.eje).toLowerCase()}(s)
                </p>
              )}
            </div>
            <button
              className="rounded p-1 text-ink-600 hover:bg-paper-200"
              onClick={() => { setProducto(null); setSerie(null); }}
              aria-label="Elegir otro producto"
            >
              <X size={15} />
            </button>
          </div>

          {/*
            * Sobre qué variante se arma.
            *
            * Sólo aparece si el producto tiene dos: con una sola no hay nada
            * que elegir, y ofrecer una opción que no cambia nada hace dudar de
            * si se eligió bien.
            */}
          {dosDimensiones && (
            <div className="mb-3">
              <p className="mb-1 text-xs text-ink-600">Armar la serie fijando:</p>
              <div className="grid grid-cols-2 gap-1 rounded-md bg-paper-100 p-1">
                {[
                  { v: "variante1", texto: eje === "variante1" ? nombreFijo : nombreRecorrido },
                  { v: "variante2", texto: eje === "variante1" ? nombreRecorrido : nombreFijo },
                ].map((op) => (
                  <button
                    key={op.v}
                    type="button"
                    onClick={() => cambiarEje(op.v)}
                    className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                      eje === op.v ? "bg-paper-50 text-ink-950 shadow-sm" : "text-ink-600 hover:text-ink-900"
                    }`}
                  >
                    {op.texto}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-ink-500">
                Fijás {String(nombreFijo).toLowerCase()} y la serie entra una unidad por cada{" "}
                {String(nombreRecorrido).toLowerCase()}.
              </p>
            </div>
          )}

          {/* Paso 2: salen los valores de la variante que se fija. */}
          {serie?.necesitaValor ? (
            <>
              <p className="mb-2 text-xs text-ink-600">Elegí {String(nombreFijo).toLowerCase()}:</p>
              <div className="flex flex-wrap gap-1">
                {(serie.opciones || []).map((o) => (
                  <button
                    key={o}
                    className="rounded border border-line px-2 py-1 text-xs text-ink-700 hover:bg-paper-200"
                    onClick={() => abrir(producto, { valor: o })}
                  >
                    {o}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-end gap-3">
                <div>
                  <label className="label" htmlFor="serie-cant">Series</label>
                  <input
                    id="serie-cant"
                    className="input w-24 py-1 text-sm"
                    type="number" min="0" step="1"
                    value={cantidad}
                    disabled={Boolean(porValor)}
                    onChange={(e) => setCantidad(e.target.value)}
                  />
                </div>
                <p className="pb-1 text-xs text-ink-600">
                  × {valores.length} {String(serie.eje).toLowerCase()}(s) ={" "}
                  <strong className="text-ink-950">{unidades} unidades</strong>
                </p>
                <button
                  className="btn-ghost ml-auto py-1 text-xs"
                  onClick={() => setPorValor(
                    porValor ? null : Object.fromEntries(valores.map((v) => [v.valor, Number(cantidad) || 0])),
                  )}
                >
                  {porValor ? "Volver a serie pareja" : "Repartir distinto"}
                </button>
              </div>

              {/* La serie despareja: 1-2-2-1 en S-M-L-XL es como viene de verdad. */}
              {porValor && (
                <div className="mb-3 flex flex-wrap gap-2">
                  {valores.map((v) => (
                    <div key={v.variantId}>
                      <label className="label text-[10px]" htmlFor={`sv-${v.variantId}`}>{v.valor}</label>
                      <input
                        id={`sv-${v.variantId}`}
                        className="input w-16 py-1 text-sm"
                        type="number" min="0" step="1"
                        value={porValor[v.valor] ?? 0}
                        onChange={(e) => setPorValor({ ...porValor, [v.valor]: e.target.value })}
                      />
                    </div>
                  ))}
                </div>
              )}

              <button className="btn-accent py-1 text-sm" onClick={agregar} disabled={unidades <= 0}>
                Agregar {unidades} unidad{unidades === 1 ? "" : "es"} a la lista
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
