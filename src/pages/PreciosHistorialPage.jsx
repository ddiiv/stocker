import { Fragment, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { History, X } from "lucide-react";
import { fetchPreciosHistorial, fetchPreciosHistorialDetalle } from "../services/productService";
import { PageHeader, Card, EmptyState } from "../components/ui/Layout";
import StockTabs from "../components/stock/StockTabs";
import { formatCurrency } from "../utils/formatters";

/*
 * Historial de cambios de precio. De sólo lectura: cada fila es una operación
 * (no un precio suelto) y al abrirla se ven los precios de antes y después.
 */

const ORIGENES = {
  masivo: "Cambio en masa",
  manual: "Edición manual",
  excel: "Importación Excel",
  variantes: "Precio por variantes",
  feria: "Precios de feria",
};
const CAMPOS = { precioMinorista: "Minorista", precioMayorista: "Mayorista", costo: "Costo" };
const LIMITE = 20;

// La misma frase que muestra el diálogo de «Cambiar precios en masa».
function resumenDe(c) {
  const r = c.resumen || {};
  if (c.origen !== "masivo") return `${c.filas} ${c.filas === 1 ? "precio cambiado" : "precios cambiados"}`;
  const nombre = r.precio === "minorista" ? "Minorista" : "Mayorista";
  const baseTxt = r.base === "mismo" ? `${nombre} actual` : r.base === "mayorista" ? "mayorista" : "costo";
  const n = Number(r.valor) || 0;
  const monto = r.modo === "porcentaje" ? `${Math.abs(n).toLocaleString("es-AR")} %` : `$ ${Math.abs(n).toLocaleString("es-AR")}`;
  const cuenta = `${r.base === "mismo" ? "" : `${nombre} = `}${baseTxt} ${n < 0 ? "−" : "+"} ${monto}`;
  const cats = r.categorias?.length ? `, categorías: ${r.categorias.join(" · ")}` : "";
  return `${cuenta}, redondeo $${r.redondeo}${cats} · ${r.productos} productos y ${r.variantes} variantes`;
}

function fechaHora(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "2-digit" })} ${d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

function diferencia(antes, despues) {
  const a = Number(antes), d = Number(despues);
  if (!Number.isFinite(a) || !Number.isFinite(d) || a === 0) return "—";
  const p = ((d - a) / a) * 100;
  return `${p > 0 ? "+" : ""}${p.toLocaleString("es-AR", { maximumFractionDigits: 1 })} %`;
}

function Detalle({ id }) {
  const [det, setDet] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let vigente = true;
    fetchPreciosHistorialDetalle(id)
      .then((d) => { if (vigente) setDet(d); })
      .catch((e) => { if (vigente) setError(e.response?.data?.message || "No se pudo cargar el detalle."); });
    return () => { vigente = false; };
  }, [id]);

  if (error) return <p role="alert" className="text-sm text-brick-500">{error}</p>;
  if (!det) return <p className="text-sm text-ink-500" role="status">Cargando detalle…</p>;
  if (!det.detalle?.length) return <p className="text-sm text-ink-600">Esta operación no guardó el detalle de los precios.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Precios antes y después de esta operación</caption>
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-ink-600">
            <th scope="col" className="px-2 py-1.5 font-medium">Producto</th>
            <th scope="col" className="px-2 py-1.5 font-medium">Variante</th>
            <th scope="col" className="px-2 py-1.5 font-medium">Precio</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">Antes</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">Después</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">Diferencia</th>
          </tr>
        </thead>
        <tbody>
          {det.detalle.map((f, i) => (
            <tr key={i} className="border-t border-line">
              <td className="px-2 py-1.5">{f.productoNombre || "—"}</td>
              <td className="px-2 py-1.5 text-ink-600">{f.varianteNombre || "—"}</td>
              <td className="px-2 py-1.5">{CAMPOS[f.campo] || f.campo}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(f.antes)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(f.despues)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{diferencia(f.antes, f.despues)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function PreciosHistorialPage() {
  const [params, setParams] = useSearchParams();
  const productoId = params.get("producto") || "";
  const [origen, setOrigen] = useState("");
  const [page, setPage] = useState(1);
  const [datos, setDatos] = useState({ cambios: [], total: 0 });
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");
  const [abierto, setAbierto] = useState(null);

  useEffect(() => {
    let vigente = true;
    setCargando(true); setError(""); setAbierto(null);
    fetchPreciosHistorial({ pagina: page, limite: LIMITE, productoId, origen })
      .then((d) => { if (vigente) setDatos(d); })
      .catch((e) => { if (vigente) setError(e.response?.data?.message || "No se pudo cargar el historial de precios."); })
      .finally(() => { if (vigente) setCargando(false); });
    return () => { vigente = false; };
  }, [page, productoId, origen]);

  const paginas = Math.max(1, Math.ceil((datos.total || 0) / LIMITE));

  return (
    <div>
      <PageHeader title="Stock" subtitle="Historial de cambios de precio" />
      <StockTabs />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label htmlFor="ph-origen" className="text-xs text-ink-600">Origen</label>
        <select id="ph-origen" className="input w-auto py-1.5 text-xs" value={origen}
          onChange={(e) => { setOrigen(e.target.value); setPage(1); }}>
          <option value="">Todos</option>
          {Object.entries(ORIGENES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {productoId && (
          <button className="btn-ghost text-xs" onClick={() => { setParams({}); setPage(1); }}>
            <X size={13} /> Quitar filtro por producto
          </button>
        )}
      </div>

      {error && <p role="alert" className="mb-4 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}

      <Card className="p-0">
        {cargando ? (
          <div className="h-64 animate-pulse bg-paper-200/40" role="status" aria-label="Cargando" />
        ) : datos.cambios.length === 0 ? (
          <EmptyState icon={History} title="Sin cambios de precio"
            description={origen || productoId ? "Ningún cambio con estos filtros." : "Acá queda registrado cada cambio de precio, con quién lo hizo."} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Cambios de precio, del más reciente al más antiguo</caption>
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-600">
                  <th scope="col" className="px-4 py-2.5 font-medium">Cuándo</th>
                  <th scope="col" className="px-2 py-2.5 font-medium">Quién</th>
                  <th scope="col" className="px-2 py-2.5 font-medium">Origen</th>
                  <th scope="col" className="px-2 py-2.5 font-medium">Resumen</th>
                  <th scope="col" className="px-4 py-2.5 font-medium"><span className="sr-only">Detalle</span></th>
                </tr>
              </thead>
              <tbody>
                {datos.cambios.map((c) => (
                  <Fragment key={c.id}>
                    <tr className="border-b border-line align-top last:border-0">
                      <td className="whitespace-nowrap px-4 py-2.5 text-ink-700">{fechaHora(c.fecha)}</td>
                      <td className="whitespace-nowrap px-2 py-2.5 text-ink-700">{c.usuario?.nombre || "—"}</td>
                      <td className="whitespace-nowrap px-2 py-2.5">{ORIGENES[c.origen] || c.origen}</td>
                      <td className="px-2 py-2.5 text-ink-600">{resumenDe(c)}</td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right">
                        <button className="btn-ghost text-xs" aria-expanded={abierto === c.id}
                          onClick={() => setAbierto(abierto === c.id ? null : c.id)}>
                          {abierto === c.id ? "Ocultar detalle" : "Ver detalle"}
                        </button>
                      </td>
                    </tr>
                    {abierto === c.id && (
                      <tr className="border-b border-line bg-paper-200/30">
                        <td colSpan={5} className="px-4 py-3"><Detalle id={c.id} /></td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {paginas > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <p className="text-ink-600">Página {page} de {paginas} · {datos.total} cambios</p>
          <div className="flex gap-2">
            <button className="btn-ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Anterior</button>
            <button className="btn-ghost" disabled={page >= paginas} onClick={() => setPage((p) => p + 1)}>Siguiente</button>
          </div>
        </div>
      )}
    </div>
  );
}
