import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  TrendingUp, TrendingDown, Minus, Trophy, Snowflake, AlertTriangle, Layers, Calendar, Store, Shapes,
} from "lucide-react";
import { PageHeader, Card } from "../components/ui/Layout";
import MetricsTabs from "../components/dashboard/MetricsTabs";
import { http } from "../lib/http";
import { formatCurrency } from "../utils/formatters";
import { mensajeDeError } from "../utils/errores";

/*
 * Análisis del negocio.
 *
 * Cuatro preguntas, en el orden en que un dueño las hace:
 *   ¿cómo vengo?          resumen contra el período anterior
 *   ¿mes a mes?           la serie, con media móvil y tendencia
 *   ¿qué me sostiene?     los que más facturan, y el ABC
 *   ¿qué me está costando? capital dormido y ventas bajo el costo
 *
 * Los números vienen agregados de la base: la pantalla no suma nada, sólo
 * elige cómo mostrarlo. Eso es lo que hace que el panel cueste lo mismo con un
 * mes de historia que con cinco años.
 */

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const nombreMes = (m) => {
  const [a, mm] = String(m).split("-");
  return `${MESES[Number(mm) - 1] || mm} ${a.slice(2)}`;
};

/* Variación con su signo y su color. El gris del "sin dato" importa: no es
   un 0%, es que no hay contra qué comparar. */
function Variacion({ valor, sufijo = "" }) {
  if (valor === null || valor === undefined) return <span className="text-ink-400">—</span>;
  const Icono = valor > 0 ? TrendingUp : valor < 0 ? TrendingDown : Minus;
  const color = valor > 0 ? "text-teal-600" : valor < 0 ? "text-brick-500" : "text-ink-500";
  return (
    <span className={`inline-flex items-center gap-0.5 ${color}`}>
      <Icono size={13} />{valor > 0 ? "+" : ""}{valor}%{sufijo}
    </span>
  );
}

export default function AnalisisPage() {
  const hoy = new Date();
  const haceUnAnio = new Date(hoy); haceUnAnio.setMonth(haceUnAnio.getMonth() - 12);
  const iso = (d) => d.toISOString().slice(0, 10);

  const [desde, setDesde] = useState(iso(haceUnAnio));
  const [hasta, setHasta] = useState(iso(hoy));
  const [datos, setDatos] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let vivo = true;
    setCargando(true); setError("");
    http.get("/metrics/panel", { params: { desde, hasta } })
      .then(({ data }) => { if (vivo) setDatos(data); })
      .catch((e) => { if (vivo) setError(mensajeDeError(e, "No se pudo cargar el análisis.")); })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [desde, hasta]);

  /*
   * Con un rango de doce meses justos, "el período anterior" y "el mismo
   * período del año pasado" son el mismo rango, y mostrar las dos variaciones
   * repite el número.
   */
  const interanualEsRedundante =
    datos?.resumen?.comparado?.desde === datos?.resumen?.interanual?.desde;

  const maxMes = useMemo(
    () => Math.max(1, ...(datos?.serieMensual || []).map((m) => m.facturado)),
    [datos],
  );

  return (
    <div>
      <PageHeader
        title="Análisis del negocio"
        subtitle="Cómo viene el negocio mes a mes, qué lo sostiene y qué le está costando plata"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Calendar size={15} className="text-ink-500" />
            <input type="date" className="input w-auto py-1 text-sm" value={desde} onChange={(e) => setDesde(e.target.value)} />
            <span className="text-ink-500">→</span>
            <input type="date" className="input w-auto py-1 text-sm" value={hasta} onChange={(e) => setHasta(e.target.value)} />
          </div>
        }
      />

      <MetricsTabs />

      {error && <p className="mb-4 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}
      {cargando && <div className="card h-64 animate-pulse bg-paper-200/60" />}

      {!cargando && datos && (
        <>
          {/* ── Resumen, siempre contra el período anterior ── */}
          <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: "Facturado", valor: formatCurrency(datos.resumen.facturado), var: datos.resumen.comparado.variacionFacturado, inter: datos.resumen.interanual.variacionFacturado, pie: `${datos.resumen.tickets} ventas` },
              { label: "Margen bruto", valor: formatCurrency(datos.resumen.margen), var: datos.resumen.comparado.variacionMargen, inter: datos.resumen.interanual.variacionMargen, pie: `${datos.resumen.margenPct}% sobre lo facturado` },
              { label: "Ticket promedio", valor: formatCurrency(datos.resumen.ticketPromedio), var: null, inter: null, pie: `${datos.resumen.unidadesPorTicket} artículos por venta` },
              { label: "Unidades vendidas", valor: datos.resumen.unidades.toLocaleString("es-AR"), var: datos.resumen.comparado.variacionTickets, inter: datos.resumen.interanual.variacionTickets, pie: "ventas cobradas" },
            ].map((k) => (
              <Card key={k.label}>
                <p className="text-xs uppercase tracking-wide text-ink-600">{k.label}</p>
                <p className="mt-2 font-display text-2xl font-semibold text-ink-950">{k.valor}</p>
                <p className="mt-1 text-xs text-ink-500">
                  <Variacion valor={k.var} />{" "}
                  <span className="text-ink-400">
                    {interanualEsRedundante ? "vs. año pasado" : "vs. período anterior"} · {k.pie}
                  </span>
                </p>
                {/* La interanual va aparte y etiquetada: en un comercio de
                    temporada es la que dice si el negocio mejoró, porque la
                    otra compara contra una estación distinta.

                    Salvo que el rango sea de un año justo: ahí "el período
                    anterior" ES el año pasado y las dos líneas dirían el mismo
                    número, que confunde más de lo que aporta. */}
                {!interanualEsRedundante && k.inter !== null && k.inter !== undefined && (
                  <p className="mt-0.5 text-xs text-ink-400">
                    <Variacion valor={k.inter} /> vs. año pasado
                  </p>
                )}
              </Card>
            ))}
          </div>

          {/* ── Serie mensual ── */}
          <Card className="mb-5">
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-display text-base font-semibold text-ink-950">Mes a mes</h3>
              {datos.tendencia && (
                <p className="text-xs text-ink-500">
                  Tendencia: <strong className={datos.tendencia.direccion === "sube" ? "text-teal-600" : "text-brick-500"}>
                    {datos.tendencia.direccion}
                  </strong>{" "}
                  {formatCurrency(datos.tendencia.pendienteMensual)}/mes
                  {/* R² bajo = la recta no explica los datos. Decirlo evita leer
                      una tendencia donde sólo hay estacionalidad. */}
                  {datos.tendencia.r2 !== null && datos.tendencia.r2 < 0.3 && (
                    <span className="text-brass-800"> · dato flojo (R² {datos.tendencia.r2}): el mes a mes manda más que la tendencia</span>
                  )}
                </p>
              )}
            </div>

            {datos.periodo.incluyeMesEnCurso && (
              <p className="mb-2 rounded-md bg-brass-50 px-2 py-1.5 text-xs text-brass-800">
                El último mes está en curso: sus comparaciones son contra meses completos y se leen
                peor de lo que son.
              </p>
            )}

            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-600">
                    <th className="py-2 font-medium">Mes</th>
                    <th className="py-2 font-medium">Facturado</th>
                    <th className="py-2 text-right font-medium">Margen</th>
                    <th className="py-2 text-right font-medium">%</th>
                    <th className="py-2 text-right font-medium">Ventas</th>
                    <th className="py-2 text-right font-medium">Ticket</th>
                    <th className="py-2 text-right font-medium">vs. mes ant.</th>
                    <th className="py-2 text-right font-medium">vs. año pas.</th>
                  </tr>
                </thead>
                <tbody>
                  {datos.serieMensual.map((m) => (
                    <tr key={m.mes} className="border-b border-line last:border-0">
                      <td className="py-2 whitespace-nowrap text-ink-900">
                        {nombreMes(m.mes)}
                        {/* Sin esta marca, un mes a medio andar parece una caída. */}
                        {m.parcial && <span className="ml-1 text-xs text-brass-800">en curso</span>}
                      </td>
                      <td className="py-2">
                        {/* La barra hace legible la estacionalidad de un vistazo,
                            que en una columna de números se pierde. */}
                        <div className="flex items-center gap-2">
                          <div className="h-2 w-24 shrink-0 overflow-hidden rounded-full bg-paper-200">
                            <div className="h-full rounded-full bg-teal-600" style={{ width: `${(m.facturado / maxMes) * 100}%` }} />
                          </div>
                          <span className="whitespace-nowrap text-ink-900">{formatCurrency(m.facturado)}</span>
                        </div>
                      </td>
                      <td className="py-2 text-right whitespace-nowrap text-ink-700">{formatCurrency(m.margen)}</td>
                      <td className="py-2 text-right text-ink-500">{m.margenPct}%</td>
                      <td className="py-2 text-right text-ink-700">{m.tickets}</td>
                      <td className="py-2 text-right whitespace-nowrap text-ink-500">{formatCurrency(m.ticketPromedio)}</td>
                      <td className="py-2 text-right whitespace-nowrap"><Variacion valor={m.variacionPct} /></td>
                      <td className="py-2 text-right whitespace-nowrap">
                        <Variacion valor={m.interanual?.variacionPct ?? null} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="grid gap-5 lg:grid-cols-2">
            {/* ── Los que sostienen el negocio ── */}
            <Card>
              <h3 className="mb-1 font-display text-base font-semibold text-ink-950">
                <Trophy size={16} className="mr-1 inline text-brass-700" /> Los que más facturan
              </h3>
              <p className="mb-3 text-xs text-ink-500">
                Por facturación y no por unidades: vender 200 medias no es vender 20 camperas.
              </p>
              <Tabla
                filas={datos.tops.masVendidos}
                columnas={[
                  { k: "titulo", h: "Producto" },
                  { k: "unidades", h: "Unid.", align: "right" },
                  { k: "facturado", h: "Facturado", align: "right", money: true },
                  { k: "margenPct", h: "Margen", align: "right", suf: "%" },
                ]}
              />
            </Card>

            {/* ── Capital dormido ── */}
            <Card>
              <h3 className="mb-1 font-display text-base font-semibold text-ink-950">
                <Snowflake size={16} className="mr-1 inline text-ink-500" /> Capital dormido
              </h3>
              <p className="mb-3 text-xs text-ink-500">
                Lo que menos se mueve entre lo que sí tenés en stock. Ordenado por rotación
                —cuántas veces se vendió el stock que hay—: cuanto más bajo, más plata parada.
              </p>
              <Tabla
                filas={datos.tops.menosVendidos}
                columnas={[
                  { k: "titulo", h: "Producto" },
                  { k: "stock", h: "Stock", align: "right" },
                  { k: "capitalInmovilizado", h: "Capital", align: "right", money: true },
                  { k: "rotacion", h: "Rot.", align: "right" },
                ]}
              />
            </Card>
          </div>

          {/* ── Pérdida ── */}
          <Card className="mt-5">
            <h3 className="mb-1 font-display text-base font-semibold text-ink-950">
              <AlertTriangle size={16} className="mr-1 inline text-brick-500" /> Vendido por debajo del costo
            </h3>
            {datos.tops.conPerdida.length === 0 ? (
              <p className="text-sm text-ink-500">
                Nada se vendió a pérdida en este período. Acá aparecen los productos cuyo precio de venta
                quedó por debajo del costo: descuentos que se pasaron de rosca, precios sin actualizar
                después de una suba del proveedor, o un costo mal cargado.
              </p>
            ) : (
              <Tabla
                filas={datos.tops.conPerdida}
                columnas={[
                  { k: "titulo", h: "Producto" },
                  { k: "unidades", h: "Unid.", align: "right" },
                  { k: "facturado", h: "Facturado", align: "right", money: true },
                  { k: "margen", h: "Pérdida", align: "right", money: true, rojo: true },
                ]}
              />
            )}
          </Card>

          {/* ── Por local y por categoría ── */}
          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <Card>
              <h3 className="mb-1 font-display text-base font-semibold text-ink-950">
                <Store size={16} className="mr-1 inline text-ink-500" /> Por local
              </h3>
              <p className="mb-3 text-xs text-ink-500">
                Mirá el margen y no sólo la facturación: un local que vende mucho con margen flaco
                puede estar rematando.
              </p>
              <Tabla
                filas={datos.porLocal}
                columnas={[
                  { k: "nombre", h: "Local" },
                  { k: "facturado", h: "Facturado", align: "right", money: true },
                  { k: "margenPct", h: "Margen", align: "right", suf: "%" },
                  { k: "ticketPromedio", h: "Ticket", align: "right", money: true },
                  { k: "participacionPct", h: "Part.", align: "right", suf: "%" },
                ]}
              />
            </Card>

            <Card>
              <h3 className="mb-1 font-display text-base font-semibold text-ink-950">
                <Shapes size={16} className="mr-1 inline text-ink-500" /> Por categoría
              </h3>
              <p className="mb-3 text-xs text-ink-500">
                De qué vive el negocio. Casi nunca coincide con lo que uno cree que vende.
              </p>
              <Tabla
                filas={datos.porCategoria}
                columnas={[
                  { k: "nombre", h: "Categoría" },
                  { k: "facturado", h: "Facturado", align: "right", money: true },
                  { k: "margenPct", h: "Margen", align: "right", suf: "%" },
                  { k: "unidades", h: "Unid.", align: "right" },
                  { k: "participacionPct", h: "Part.", align: "right", suf: "%" },
                ]}
              />
            </Card>
          </div>

          {/* ── ABC ── */}
          <Card className="mt-5">
            <h3 className="mb-1 font-display text-base font-semibold text-ink-950">
              <Layers size={16} className="mr-1 inline text-ink-500" /> Clasificación ABC
            </h3>
            <p className="mb-3 text-xs text-ink-500">
              <strong>A</strong> ({datos.abc.resumen.A}) hacen el 80% de la facturación: no pueden faltar nunca.{" "}
              <strong>B</strong> ({datos.abc.resumen.B}) el 15% siguiente.{" "}
              <strong>C</strong> ({datos.abc.resumen.C}) la cola larga: ocupan lugar y capital para lo que aportan.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-sm">
                <tbody>
                  {datos.abc.productos.map((p) => (
                    <tr key={p.agrupador} className="border-b border-line last:border-0">
                      <td className="py-2 w-8">
                        <span className={`badge ${p.clase === "A" ? "badge-ok" : p.clase === "B" ? "badge-low" : "badge-out"}`}>{p.clase}</span>
                      </td>
                      <td className="py-2 text-ink-900">{p.titulo}</td>
                      <td className="py-2 text-right whitespace-nowrap text-ink-700">{formatCurrency(p.facturado)}</td>
                      <td className="py-2 text-right text-ink-500">{p.participacionPct}%</td>
                      <td className="py-2 text-right text-xs text-ink-400">acum. {p.acumuladoPct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <p className="mt-4 text-xs text-ink-500">
            El margen usa el costo del día de cada venta, no el de hoy: una suba del proveedor no
            reescribe los meses anteriores. ¿Falta stock de algo que más factura?{" "}
            <Link to="/stock/por-local" className="underline">Mirá el stock por local</Link>.
          </p>
        </>
      )}
    </div>
  );
}

/* Tabla chica y repetida: los tops comparten forma y sólo cambian columnas. */
function Tabla({ filas, columnas }) {
  if (!filas?.length) return <p className="py-6 text-center text-sm text-ink-500">Sin datos en el período.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[380px] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-600">
            {columnas.map((c) => (
              <th key={c.k} className={`py-2 font-medium ${c.align === "right" ? "text-right" : ""}`}>{c.h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filas.map((f, i) => (
            <tr key={f.agrupador || i} className="border-b border-line last:border-0">
              {columnas.map((c) => {
                const v = f[c.k];
                return (
                  <td key={c.k} className={`py-2 whitespace-nowrap ${c.align === "right" ? "text-right" : ""} ${c.rojo ? "text-brick-500" : "text-ink-700"}`}>
                    {c.money ? formatCurrency(v) : v}{c.suf || ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
