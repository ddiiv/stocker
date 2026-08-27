import { useCallback, useEffect, useMemo, useState } from "react";
import { Store, Tag, AlertTriangle, Check, RefreshCw } from "lucide-react";
import { PageHeader, Card, EmptyState } from "../components/ui/Layout";
import { fetchCandidatos, generarFeria, fetchProductosFeria, reaplicarPrecios } from "../services/feriaService";
import { formatCurrency } from "../utils/formatters";
import { mensajeDeError } from "../utils/errores";

/*
 * Catálogo de evento.
 *
 * Un local de evento vende sin llevar inventario: interesa registrar qué se
 * vendió, no cuánto queda. Para eso hace falta, una vez, generar desde el
 * catálogo normal una versión sin variantes y con precio propio.
 *
 * La pantalla es esa tarea y nada más. Vender en el evento es el punto de venta
 * de siempre: se escanea el código y aparece el precio, sin preguntar talle.
 */

/*
 * Cada precio de evento se arma con tres cosas: sobre qué precio del producto
 * original se calcula, cómo, y con qué número.
 *
 * Son dos reglas independientes porque en el evento los dos precios no guardan
 * la relación que tienen en el local. El caso que lo motivó: el mayorista de
 * evento es el mayorista del local tal cual, y el minorista de evento es ese
 * mismo mayorista más un fijo.
 */
const BASES = [
  { key: "minorista", label: "el minorista del local" },
  { key: "mayorista", label: "el mayorista del local" },
];
const MODOS = [
  { key: "igual",      label: "tal cual" },
  { key: "porcentaje", label: "± un %" },
  { key: "fijo",       label: "± un monto" },
];

/* Un control por cada precio. Repetirlo dos veces a mano sería garantizar que
   uno de los dos quede distinto cuando algo cambie. */
function ReglaPrecio({ titulo, valor, onChange }) {
  return (
    <div className="rounded-md border border-line bg-paper-100 p-3">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-600">{titulo}</p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="input w-auto py-1 text-sm" value={valor.base}
          onChange={(e) => onChange({ ...valor, base: e.target.value })}
          aria-label={`Sobre qué precio se calcula el ${titulo.toLowerCase()}`}
        >
          {BASES.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
        </select>
        <select
          className="input w-auto py-1 text-sm" value={valor.modo}
          onChange={(e) => onChange({ ...valor, modo: e.target.value })}
          aria-label={`Cómo se calcula el ${titulo.toLowerCase()}`}
        >
          {MODOS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
        {valor.modo !== "igual" && (
          <input
            className="input w-28 py-1 text-sm" type="number" step={valor.modo === "fijo" ? "1" : "0.1"}
            value={valor.valor}
            onChange={(e) => onChange({ ...valor, valor: e.target.value })}
            aria-label={`Valor del ${titulo.toLowerCase()}`}
          />
        )}
      </div>
      <p className="mt-1 text-xs text-ink-500">
        {valor.modo === "igual" && `Toma ${BASES.find((b) => b.key === valor.base)?.label} sin cambios.`}
        {valor.modo === "porcentaje" && `Negativo baja el precio: −20 es un 20% menos.`}
        {valor.modo === "fijo" && `Se suma al precio base. Negativo lo descuenta.`}
      </p>
    </div>
  );
}

export default function EventoPage() {
  const [datos, setDatos] = useState(null);
  const [generados, setGenerados] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");
  const [trabajando, setTrabajando] = useState(false);

  const [prefijo, setPrefijo] = useState("EVENTO");
  const [elegidos, setElegidos] = useState(() => new Set());
  const [busqueda, setBusqueda] = useState("");
  const [rMinorista, setRMinorista] = useState({ base: "minorista", modo: "igual", valor: 0 });
  const [rMayorista, setRMayorista] = useState({ base: "mayorista", modo: "igual", valor: 0 });
  const [reaplicando, setReaplicando] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true); setError("");
    try {
      const [c, g] = await Promise.all([fetchCandidatos(prefijo), fetchProductosFeria()]);
      setDatos(c);
      setGenerados(g);
    } catch (e) {
      setError(mensajeDeError(e, "No se pudo cargar el catálogo."));
    } finally {
      setCargando(false);
    }
  }, [prefijo]);

  useEffect(() => { cargar(); }, [cargar]);

  const pendientes = useMemo(
    () => (datos?.productos || []).filter((p) => !p.generado),
    [datos],
  );

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return pendientes;
    return pendientes.filter(
      (p) => p.titulo.toLowerCase().includes(q) || String(p.sku).toLowerCase().includes(q),
    );
  }, [pendientes, busqueda]);

  const alternar = (id) => setElegidos((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  /* Lo que va a salir por cada producto elegido, calculado en la pantalla para
     poder verlo ANTES de generar cincuenta productos con el precio equivocado. */
  const aplicar = (p, r) => {
    const partida = r.base === "mayorista" ? (p.precioMayorista || p.precioMinorista) : p.precioMinorista;
    const v = Number(r.valor) || 0;
    if (r.modo === "porcentaje") return Math.max(0, Math.round(partida * (1 + v / 100) * 100) / 100);
    if (r.modo === "fijo") return Math.max(0, Math.round((partida + v) * 100) / 100);
    return Math.round(partida * 100) / 100;
  };
  const previsualizar = (p) => ({
    minorista: aplicar(p, rMinorista),
    mayorista: aplicar(p, rMayorista),
  });
  const reglaParaApi = () => ({ minorista: rMinorista, mayorista: rMayorista });

  async function generar() {
    if (!elegidos.size) { setError("Elegí al menos un producto."); return; }
    setTrabajando(true); setError(""); setAviso("");
    try {
      const r = await generarFeria({
        productIds: [...elegidos],
        prefijo,
        precio: reglaParaApi(),
      });
      setAviso([r.mensaje, ...(r.avisos || [])].filter(Boolean).join(' · '));
      setElegidos(new Set());
    } catch (e) {
      setError(mensajeDeError(e, "No se pudieron generar los productos de evento."));
      setTrabajando(false);
      return;
    }
    setTrabajando(false);
    await cargar();
  }

  async function recalcular() {
    if (!generados.length) return;
    setReaplicando(true); setError(""); setAviso("");
    try {
      const r = await reaplicarPrecios({ productIds: generados.map((p) => p.id), precio: reglaParaApi() });
      setAviso([r.mensaje, ...(r.avisos || [])].filter(Boolean).join(" · "));
    } catch (e) {
      setError(mensajeDeError(e, "No se pudieron recalcular los precios."));
      setReaplicando(false);
      return;
    }
    setReaplicando(false);
    await cargar();
  }

  return (
    <div>
      <PageHeader
        title="Evento"
        subtitle="Productos que se venden sin llevar stock: sólo queda registrado qué se vendió"
        actions={
          <button className="btn-ghost" onClick={cargar} disabled={cargando}>
            <RefreshCw size={15} /> Actualizar
          </button>
        }
      />

      {/* Sin un local de evento cargado, generar el catálogo no sirve de nada: no hay
          dónde venderlo. Se dice antes de que la persona elija cincuenta
          productos y descubra al final que falta el lugar. */}
      {datos && !datos.hayPuestos && (
        <p className="mb-4 rounded-md border border-brass-500/40 bg-brass-50 px-3 py-2 text-sm text-brass-800">
          <AlertTriangle size={14} className="mr-1 inline" />
          Todavía no tenés ningún local de evento. Creá un local y ponele tipo <strong>Evento</strong> desde
          Empleados → Locales y depósitos; si no, estos productos no se van a poder vender en ningún lado.
        </p>
      )}

      {error  && <p className="mb-4 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}
      {aviso  && <p className="mb-4 rounded-md bg-teal-50 px-3 py-2 text-sm text-teal-600">{aviso}</p>}

      {cargando ? (
        <div className="card h-64 animate-pulse bg-paper-200/60" />
      ) : (
        <>
          <Card className="mb-5">
            <h3 className="mb-1 font-display text-base font-semibold text-ink-950">
              <Tag size={16} className="mr-1 inline text-ink-500" /> Generar catálogo de evento
            </h3>
            <p className="mb-4 text-xs text-ink-500">
              Cada producto elegido genera su versión de evento: una sola variante, sin color ni talle, con su
              propio código y su propio precio. El original no se toca.
            </p>

            <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="evento-prefijo">Prefijo del código</label>
                <input
                  id="evento-prefijo"
                  className="input font-mono uppercase"
                  value={prefijo}
                  maxLength={12}
                  onChange={(e) => setPrefijo(e.target.value)}
                />
                {/* Se recorta a tres para que el código quede legible y para que
                    todos los de evento empiecen igual. */}
                <p className="mt-1 text-xs text-ink-500">
                  Se usan los primeros 3 caracteres: <span className="font-mono">{(datos?.prefijo || "FER")}</span>
                </p>
              </div>
            </div>

            <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ReglaPrecio titulo="Precio minorista de evento" valor={rMinorista} onChange={setRMinorista} />
              <ReglaPrecio titulo="Precio mayorista de evento" valor={rMayorista} onChange={setRMayorista} />
            </div>

            {pendientes.length === 0 ? (
              <p className="rounded-md bg-paper-100 px-3 py-2 text-sm text-ink-600">
                Todos los productos del catálogo ya tienen su versión de evento.
              </p>
            ) : (
              <>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <input
                    className="input flex-1 py-1 text-sm"
                    placeholder="Buscar por título o SKU…"
                    value={busqueda}
                    onChange={(e) => setBusqueda(e.target.value)}
                  />
                  <button className="btn-ghost py-1 text-xs" onClick={() => setElegidos(new Set(visibles.map((p) => p.id)))}>
                    Elegir los {visibles.length} de la lista
                  </button>
                  {elegidos.size > 0 && (
                    <button className="btn-ghost py-1 text-xs" onClick={() => setElegidos(new Set())}>
                      Ninguno
                    </button>
                  )}
                </div>

                <div className="max-h-80 overflow-y-auto rounded-md border border-line">
                  <table className="w-full min-w-[520px] text-sm">
                    <thead className="sticky top-0 bg-paper-50">
                      <tr className="text-left text-xs uppercase tracking-wide text-ink-600">
                        <th className="px-3 py-2 font-medium"> </th>
                        <th className="px-3 py-2 font-medium">Producto</th>
                        <th className="px-3 py-2 font-medium">Código de evento</th>
                        <th className="px-3 py-2 text-right font-medium">Precios de evento</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibles.map((p) => (
                        <tr key={p.id} className="border-t border-line/60">
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              checked={elegidos.has(p.id)}
                              onChange={() => alternar(p.id)}
                              aria-label={`Generar la versión de evento de ${p.titulo}`}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <p className="text-ink-900">{p.titulo}</p>
                            <p className="font-mono text-xs text-ink-500">{p.sku}</p>
                          </td>
                          <td className="px-3 py-2 font-mono text-xs text-brass-800">{p.skuFeria}</td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            <p className="text-ink-900">{formatCurrency(previsualizar(p).minorista)}</p>
                            <p className="text-xs text-ink-500">
                              may. {formatCurrency(previsualizar(p).mayorista)}
                            </p>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="mt-3 flex items-center justify-between gap-3">
                  <p className="text-xs text-ink-500">
                    {elegidos.size} elegido{elegidos.size === 1 ? "" : "s"} de {pendientes.length} sin generar
                  </p>
                  <button className="btn-accent" onClick={generar} disabled={trabajando || !elegidos.size}>
                    {trabajando ? "Generando…" : `Generar ${elegidos.size || ""} producto${elegidos.size === 1 ? "" : "s"}`}
                  </button>
                </div>
              </>
            )}
          </Card>

          <Card className="p-0">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
              <h3 className="font-display text-base font-semibold text-ink-950">
                <Store size={16} className="mr-1 inline text-ink-500" /> Catálogo de evento
                <span className="ml-2 text-sm font-normal text-ink-500">{generados.length} producto(s)</span>
              </h3>
              {/*
                * Recalcular los ya generados.
                *
                * Generar es idempotente —si no, un segundo lote duplicaría el
                * catálogo— así que sin esto, cambiar de lista de precios
                * obligaba a borrar todo y volver a generar.
                */}
              {generados.length > 0 && (
                <button className="btn-ghost py-1 text-xs" onClick={recalcular} disabled={reaplicando}>
                  {reaplicando ? "Recalculando…" : "Aplicar estas reglas a los ya generados"}
                </button>
              )}
            </div>

            {generados.length === 0 ? (
              <EmptyState
                icon={Store}
                title="Todavía no generaste productos de evento"
                description="Elegí arriba los del catálogo normal que vendés en el evento."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-600">
                      <th className="px-4 py-3 font-medium">Producto</th>
                      <th className="px-4 py-3 font-medium">Código</th>
                      <th className="px-4 py-3 text-right font-medium">Minorista</th>
                      <th className="px-4 py-3 text-right font-medium">Mayorista</th>
                      <th className="px-4 py-3 text-right font-medium">Stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {generados.map((p) => (
                      <tr key={p.id} className="border-b border-line last:border-0">
                        <td className="px-4 py-3 text-ink-900">{p.titulo}</td>
                        <td className="px-4 py-3 font-mono text-xs text-brass-800">{p.sku}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-ink-900">{formatCurrency(p.precio)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-ink-700">{formatCurrency(p.precioMayorista)}</td>
                        {/* No es "0": es que no se lleva la cuenta, y decirlo así
                            evita que alguien salga a reponer lo que no falta. */}
                        <td className="px-4 py-3 text-right text-xs text-ink-500">sin control</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <p className="mt-4 flex items-start gap-2 text-xs text-ink-500">
            <Check size={14} className="mt-0.5 shrink-0" />
            En el local de evento se escanea el código y aparece el precio: no pregunta talle ni color, no descuenta stock
            y no avisa faltantes. Estos productos no entran al depósito, no piden reposición y no se publican en
            Mercado Libre.
          </p>
        </>
      )}
    </div>
  );
}
