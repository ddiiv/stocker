import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDownRight, ArrowUpRight, Scale, RotateCcw, Search, X } from "lucide-react";
import { fetchStockMovements } from "../services/productService";
import { fetchEmployees, fetchPos } from "../services/employeeService";
import { PageHeader, Card, EmptyState } from "../components/ui/Layout";
import StockTabs from "../components/stock/StockTabs";
import { FiltroPeriodo, ResumenFiltro, DatoResumen, GrupoFiltro, OpcionFiltro } from "../components/ui/Filtros";
import { PERIODOS, rangoDe, etiquetaDe } from "../utils/periodos";
import { Boxes } from "lucide-react";

/*
 * Libro de movimientos de stock.
 *
 * Responde una sola pregunta, la que aparece cuando falta mercadería: quién
 * tocó qué, cuánto, en qué local y a qué hora. El historial que hay dentro de
 * cada variante responde lo contrario —qué pasó con este producto— y sirve
 * cuando ya se sabe dónde mirar.
 *
 * Es de sólo lectura a propósito. Un registro que se puede editar desde la
 * misma pantalla que audita no sirve para auditar.
 */

const TIPOS = [
  { value: "",            label: "Todos" },
  { value: "ingreso",     label: "Ingresos",  icon: ArrowUpRight,   color: "text-teal-600" },
  { value: "egreso",      label: "Egresos",   icon: ArrowDownRight, color: "text-brick-500" },
  { value: "ajuste",      label: "Ajustes",   icon: Scale,          color: "text-brass-600" },
  { value: "devolucion",  label: "Devoluc.",  icon: RotateCcw,      color: "text-teal-600" },
];

const ICONO = Object.fromEntries(TIPOS.filter((t) => t.value).map((t) => [t.value, t]));

function fechaHora(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return {
    dia:  d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "2-digit" }),
    // 24 horas: "07:16 p. m." ocupa el doble y en un registro que se lee en
    // columna obliga a traducir mentalmente cada fila.
    hora: d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false }),
  };
}

export default function StockMovementsPage() {
  const [periodo, setPeriodo] = useState(PERIODOS[2].value);   // arranca en el mes en curso
  const [tipo, setTipo] = useState("");
  const [quien, setQuien] = useState("");
  const [donde, setDonde] = useState("");
  const [texto, setTexto] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [page, setPage] = useState(1);

  const [datos, setDatos] = useState({ data: [], total: 0, resumen: {} });
  const [empleados, setEmpleados] = useState([]);
  const [locales, setLocales] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");

  // Los combos de quién y dónde se traen una vez: no cambian mientras se filtra.
  useEffect(() => {
    Promise.all([fetchEmployees().catch(() => []), fetchPos().catch(() => [])])
      .then(([e, l]) => { setEmpleados(e || []); setLocales(l || []); });
  }, []);

  // La búsqueda por texto espera a que se deje de escribir: sin esto sale un
  // pedido por tecla y llegan desordenados.
  useEffect(() => {
    const t = setTimeout(() => { setBusqueda(texto); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [texto]);

  const rango = useMemo(() => rangoDe(periodo), [periodo]);

  useEffect(() => {
    let vigente = true;
    setCargando(true); setError("");
    fetchStockMovements({
      desde: rango.desde, hasta: rango.hasta,
      tipo, employeeId: quien, locationId: donde, q: busqueda,
      page, limit: 50,
    })
      .then((d) => { if (vigente) setDatos(d); })
      .catch((e) => { if (vigente) setError(e.response?.data?.message || "No se pudieron cargar los movimientos."); })
      .finally(() => { if (vigente) setCargando(false); });
    return () => { vigente = false; };
  }, [rango, tipo, quien, donde, busqueda, page]);

  // Cambiar cualquier filtro vuelve a la primera página: quedarse en la 4 de un
  // resultado que ahora tiene 2 muestra una tabla vacía sin motivo aparente.
  useEffect(() => { setPage(1); }, [periodo, tipo, quien, donde]);

  const { resumen } = datos;
  const hayFiltro = tipo || quien || donde || busqueda || periodo !== PERIODOS[2].value;
  const paginas = Math.max(1, Math.ceil((datos.total || 0) / 50));

  function limpiar() {
    setPeriodo(PERIODOS[2].value); setTipo(""); setQuien(""); setDonde("");
    setTexto(""); setBusqueda(""); setPage(1);
  }

  return (
    <div>
      <PageHeader title="Stock" subtitle="Quién movió stock, cuánto, dónde y cuándo" />
      <StockTabs />

      {/* Filtros */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <FiltroPeriodo valor={periodo} onChange={setPeriodo} />

        <GrupoFiltro>
          {TIPOS.map((t) => (
            <OpcionFiltro key={t.value} activa={tipo === t.value} onClick={() => setTipo(t.value)}>
              {t.label}
            </OpcionFiltro>
          ))}
        </GrupoFiltro>

        <select className="input w-auto py-1.5 text-xs" value={quien} onChange={(e) => setQuien(e.target.value)}>
          <option value="">Cualquiera</option>
          {/* El dueño no es un empleado: sus movimientos quedan sin empleado
              asociado, así que necesita su propia opción. */}
          <option value="dueno">Sólo el dueño</option>
          {empleados.map((e) => (
            <option key={e.id} value={e.id}>{e.nombre} {e.apellido}</option>
          ))}
        </select>

        <select className="input w-auto py-1.5 text-xs" value={donde} onChange={(e) => setDonde(e.target.value)}>
          <option value="">Cualquier local</option>
          {locales.map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
          <option value="sin">Sin local asignado</option>
        </select>

        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-500" />
          <input
            className="input w-56 py-1.5 pl-8 text-xs"
            placeholder="Producto, SKU, código o motivo"
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
          />
        </div>

        {hayFiltro && (
          <button className="btn-ghost text-xs" onClick={limpiar}><X size={13} /> Limpiar</button>
        )}
      </div>

      {/* Totales del filtro completo, no de la página */}
      <ResumenFiltro>
        <DatoResumen rotulo="Movimientos" valor={resumen.movimientos ?? 0} destacado
          nota={etiquetaDe(periodo)} />
        <DatoResumen rotulo="Entró"
          valor={<span className="text-teal-600">+{resumen.unidadesIngreso ?? 0}</span>} nota="unidades" />
        <DatoResumen rotulo="Salió"
          valor={<span className="text-brick-500">−{resumen.unidadesEgreso ?? 0}</span>} nota="unidades" />
        <DatoResumen rotulo="Neto" destacado
          valor={<span className={(resumen.neto ?? 0) < 0 ? "text-brick-500" : "text-teal-600"}>
            {(resumen.neto ?? 0) > 0 ? "+" : ""}{resumen.neto ?? 0}
          </span>} nota="unidades" />
        {/* El ajuste fija el stock en vez de sumarlo o restarlo, así que no
            entra en el neto. Se muestra aparte para que no desaparezca. */}
        {!!resumen.ajustes && (
          <DatoResumen rotulo="Ajustado a" valor={resumen.ajustes} nota="fijado por conteo, fuera del neto" />
        )}
      </ResumenFiltro>

      {error && <p className="mb-4 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}

      <Card className="p-0">
        {cargando ? (
          <div className="h-64 animate-pulse bg-paper-200/40" />
        ) : datos.data.length === 0 ? (
          <EmptyState
            icon={Boxes}
            title={hayFiltro ? "Ningún movimiento con estos filtros" : `Sin movimientos ${etiquetaDe(periodo).toLowerCase()}`}
            description={hayFiltro
              ? "Probá ampliar el período o quitar algún filtro."
              : "Acá se registra cada ingreso, egreso y ajuste, con su responsable."}
            action={hayFiltro ? <button className="btn-ghost" onClick={limpiar}>Limpiar filtros</button> : null}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-600">
                  <th className="px-4 py-2.5 font-medium">Cuándo</th>
                  <th className="px-2 py-2.5 font-medium">Movimiento</th>
                  <th className="px-2 py-2.5 font-medium">Producto</th>
                  <th className="px-2 py-2.5 font-medium">Quién</th>
                  <th className="px-2 py-2.5 font-medium">Dónde</th>
                  <th className="px-2 py-2.5 font-medium">Motivo</th>
                  <th className="px-4 py-2.5 text-right font-medium">Stock</th>
                </tr>
              </thead>
              <tbody>
                {datos.data.map((m) => {
                  const t = ICONO[m.tipo] || {};
                  const Icon = t.icon;
                  const { dia, hora } = fechaHora(m.fechaMovimiento);
                  const variante = [m.variante?.variante1Valor, m.variante?.variante2Valor].filter(Boolean).join(" · ");
                  return (
                    <tr key={m.id} className="border-b border-line last:border-0 align-top">
                      <td className="whitespace-nowrap px-4 py-2.5 text-ink-700">
                        {dia} <span className="text-xs text-ink-500">{hora}</span>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2.5">
                        <span className={`flex items-center gap-1 font-medium ${t.color || "text-ink-700"}`}>
                          {Icon && <Icon size={14} />}
                          {m.tipo === "ajuste"
                            ? `Fijado en ${m.cantidad}`
                            : `${m.tipo === "egreso" ? "−" : "+"}${m.cantidad}`}
                        </span>
                        <span className="text-xs text-ink-500">{t.label || m.tipo}</span>
                      </td>
                      <td className="px-2 py-2.5">
                        {/* El SKU agrupador enlaza al producto: desde una línea
                            sospechosa se llega a su historial completo. */}
                        <Link to={`/stock/${m.variante?.producto?.skuAgrupador || ""}`}
                          className="text-ink-900 hover:underline">
                          {m.variante?.producto?.titulo || "—"}
                        </Link>
                        <p className="text-xs text-ink-500">
                          <span className="tag-chip">{m.variante?.sku}</span>
                          {variante && <span className="ml-1">{variante}</span>}
                        </p>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2.5 text-ink-700">
                        {m.empleado ? `${m.empleado.nombre} ${m.empleado.apellido}` : <span className="text-ink-500">Dueño</span>}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2.5 text-ink-700">
                        {m.local?.nombre || <span className="text-ink-400">—</span>}
                      </td>
                      <td className="px-2 py-2.5 text-ink-600">{m.motivo || <span className="text-ink-400">—</span>}</td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">
                        <span className="text-xs text-ink-500">{m.stockAnterior} →</span>{" "}
                        <span className="font-display font-semibold text-ink-900">{m.stockNuevo}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {paginas > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <p className="text-ink-600">Página {page} de {paginas} · {datos.total} movimientos</p>
          <div className="flex gap-2">
            <button className="btn-ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Anterior</button>
            <button className="btn-ghost" disabled={page >= paginas} onClick={() => setPage((p) => p + 1)}>Siguiente</button>
          </div>
        </div>
      )}
    </div>
  );
}
