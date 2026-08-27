import { useCallback, useEffect, useMemo, useState } from "react";
import { Store, Tag, AlertTriangle, Check, RefreshCw } from "lucide-react";
import { PageHeader, Card, EmptyState } from "../components/ui/Layout";
import { fetchCandidatos, generarFeria, fetchProductosFeria } from "../services/feriaService";
import { formatCurrency } from "../utils/formatters";
import { mensajeDeError } from "../utils/errores";

/*
 * Catálogo de feria.
 *
 * Un puesto de feria vende sin llevar inventario: interesa registrar qué se
 * vendió, no cuánto queda. Para eso hace falta, una vez, generar desde el
 * catálogo normal una versión sin variantes y con precio propio.
 *
 * La pantalla es esa tarea y nada más. Vender en la feria es el punto de venta
 * de siempre: se escanea el código y aparece el precio, sin preguntar talle.
 */

const MODOS = [
  { key: "minorista", label: "Igual al minorista", ayuda: "El mismo precio que en el local." },
  { key: "mayorista", label: "Igual al mayorista", ayuda: "El precio por cantidad del local." },
  { key: "porcentaje", label: "Un porcentaje", ayuda: "Sobre el minorista o el mayorista." },
];

export default function FeriaPage() {
  const [datos, setDatos] = useState(null);
  const [generados, setGenerados] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");
  const [trabajando, setTrabajando] = useState(false);

  const [prefijo, setPrefijo] = useState("FERIA");
  const [elegidos, setElegidos] = useState(() => new Set());
  const [busqueda, setBusqueda] = useState("");
  const [modo, setModo] = useState("minorista");
  const [base, setBase] = useState("minorista");
  const [porcentaje, setPorcentaje] = useState(-20);

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
  const previsualizar = (p) => {
    const partida = base === "mayorista" ? (p.precioMayorista || p.precioMinorista) : p.precioMinorista;
    if (modo === "porcentaje") {
      const pct = Number(porcentaje) || 0;
      return Math.round(partida * (1 + pct / 100) * 100) / 100;
    }
    return modo === "mayorista" ? (p.precioMayorista || p.precioMinorista) : p.precioMinorista;
  };

  async function generar() {
    if (!elegidos.size) { setError("Elegí al menos un producto."); return; }
    setTrabajando(true); setError(""); setAviso("");
    try {
      const r = await generarFeria({
        productIds: [...elegidos],
        prefijo,
        precio: modo === "porcentaje" ? { modo: "porcentaje", base, porcentaje: Number(porcentaje) } : { modo, base: modo },
      });
      setAviso(r.mensaje);
      setElegidos(new Set());
    } catch (e) {
      setError(mensajeDeError(e, "No se pudieron generar los productos de feria."));
      setTrabajando(false);
      return;
    }
    setTrabajando(false);
    await cargar();
  }

  return (
    <div>
      <PageHeader
        title="Feria"
        subtitle="Productos que se venden sin llevar stock: sólo queda registrado qué se vendió"
        actions={
          <button className="btn-ghost" onClick={cargar} disabled={cargando}>
            <RefreshCw size={15} /> Actualizar
          </button>
        }
      />

      {/* Sin un puesto cargado, generar el catálogo no sirve de nada: no hay
          dónde venderlo. Se dice antes de que la persona elija cincuenta
          productos y descubra al final que falta el lugar. */}
      {datos && !datos.hayPuestos && (
        <p className="mb-4 rounded-md border border-brass-500/40 bg-brass-50 px-3 py-2 text-sm text-brass-800">
          <AlertTriangle size={14} className="mr-1 inline" />
          Todavía no tenés ningún puesto de feria. Creá un local y ponele tipo <strong>Feria</strong> desde
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
              <Tag size={16} className="mr-1 inline text-ink-500" /> Generar catálogo de feria
            </h3>
            <p className="mb-4 text-xs text-ink-500">
              Cada producto elegido genera su versión de feria: una sola variante, sin color ni talle, con su
              propio código y su propio precio. El original no se toca.
            </p>

            <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <label className="label" htmlFor="feria-prefijo">Prefijo del código</label>
                <input
                  id="feria-prefijo"
                  className="input font-mono uppercase"
                  value={prefijo}
                  maxLength={12}
                  onChange={(e) => setPrefijo(e.target.value)}
                />
                {/* Se recorta a tres para que el código quede legible y para que
                    todos los de feria empiecen igual. */}
                <p className="mt-1 text-xs text-ink-500">
                  Se usan los primeros 3 caracteres: <span className="font-mono">{(datos?.prefijo || "FER")}</span>
                </p>
              </div>

              <div>
                <label className="label" htmlFor="feria-modo">Precio de feria</label>
                <select id="feria-modo" className="input" value={modo} onChange={(e) => setModo(e.target.value)}>
                  {MODOS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                </select>
                <p className="mt-1 text-xs text-ink-500">{MODOS.find((m) => m.key === modo)?.ayuda}</p>
              </div>

              {modo === "porcentaje" && (
                <div>
                  <label className="label" htmlFor="feria-pct">Porcentaje sobre</label>
                  <div className="flex gap-2">
                    <select className="input w-auto" value={base} onChange={(e) => setBase(e.target.value)}>
                      <option value="minorista">Minorista</option>
                      <option value="mayorista">Mayorista</option>
                    </select>
                    <input
                      id="feria-pct" className="input" type="number" step="1" min="-100" max="1000"
                      value={porcentaje} onChange={(e) => setPorcentaje(e.target.value)}
                    />
                  </div>
                  <p className="mt-1 text-xs text-ink-500">Negativo baja el precio: −20 es un 20% menos.</p>
                </div>
              )}
            </div>

            {pendientes.length === 0 ? (
              <p className="rounded-md bg-paper-100 px-3 py-2 text-sm text-ink-600">
                Todos los productos del catálogo ya tienen su versión de feria.
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
                        <th className="px-3 py-2 font-medium">Código de feria</th>
                        <th className="px-3 py-2 text-right font-medium">Precio de feria</th>
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
                              aria-label={`Generar la versión de feria de ${p.titulo}`}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <p className="text-ink-900">{p.titulo}</p>
                            <p className="font-mono text-xs text-ink-500">{p.sku}</p>
                          </td>
                          <td className="px-3 py-2 font-mono text-xs text-brass-800">{p.skuFeria}</td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            <span className="text-ink-900">{formatCurrency(previsualizar(p))}</span>
                            <span className="ml-1 text-xs text-ink-400 line-through">
                              {formatCurrency(p.precioMinorista)}
                            </span>
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
            <div className="border-b border-line px-4 py-3">
              <h3 className="font-display text-base font-semibold text-ink-950">
                <Store size={16} className="mr-1 inline text-ink-500" /> Catálogo de feria
                <span className="ml-2 text-sm font-normal text-ink-500">{generados.length} producto(s)</span>
              </h3>
            </div>

            {generados.length === 0 ? (
              <EmptyState
                icon={Store}
                title="Todavía no generaste productos de feria"
                description="Elegí arriba los del catálogo normal que vendés en el puesto."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-600">
                      <th className="px-4 py-3 font-medium">Producto</th>
                      <th className="px-4 py-3 font-medium">Código</th>
                      <th className="px-4 py-3 text-right font-medium">Precio</th>
                      <th className="px-4 py-3 text-right font-medium">Stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {generados.map((p) => (
                      <tr key={p.id} className="border-b border-line last:border-0">
                        <td className="px-4 py-3 text-ink-900">{p.titulo}</td>
                        <td className="px-4 py-3 font-mono text-xs text-brass-800">{p.sku}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-ink-900">{formatCurrency(p.precio)}</td>
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
            En el puesto se escanea el código y aparece el precio: no pregunta talle ni color, no descuenta stock
            y no avisa faltantes. Estos productos no entran al depósito, no piden reposición y no se publican en
            MercadoLibre.
          </p>
        </>
      )}
    </div>
  );
}
