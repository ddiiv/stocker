import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, PackagePlus, RefreshCw, Check } from "lucide-react";
import { PageHeader, Card, EmptyState } from "../components/ui/Layout";
import StockTabs from "../components/stock/StockTabs";
import { http } from "../lib/http";
import { useAuth } from "../context/AuthContext";
import { canEdit } from "../utils/permissions";
import { mensajeDeError } from "../utils/errores";

/*
 * Lo que se vendió sin tenerlo cargado.
 *
 * Es la contracara de dejar vender con el stock en cero. En el mostrador la
 * prenda está en la mano del cliente y el sistema va atrás, así que frenar la
 * venta pierde la venta; pero permitirlo sin dejar rastro convierte el
 * inventario en ficción.
 *
 * Esta pantalla es ese rastro: cada negativo es una tarea concreta —contar eso
 * y cargarlo— y no un número raro que aparece en un listado.
 */
export default function StockARegularizarPage() {
  const { user } = useAuth();
  const puedeEditar = canEdit(user, "stock");

  const [filas, setFilas] = useState([]);
  const [resumen, setResumen] = useState({ total: 0, unidades: 0 });
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");
  const [ajustando, setAjustando] = useState(null);

  async function cargar() {
    setCargando(true); setError("");
    try {
      const { data } = await http.get("/stock/a-regularizar");
      setFilas(data.data || []);
      setResumen({ total: data.total || 0, unidades: data.unidades || 0 });
    } catch (e) {
      setError(mensajeDeError(e, "No se pudo cargar el listado."));
    }
    setCargando(false);
  }
  useEffect(() => { cargar(); }, []);

  /*
   * Regularizar es cargar lo que falta y volver a cero.
   *
   * Se pide la cantidad real contada en vez de sumar el faltante a ciegas: el
   * negativo dice cuánto se vendió de más, no cuánto hay hoy en el estante, y
   * son dos números distintos.
   */
  async function regularizar(f) {
    const txt = prompt(
      `${f.titulo} ${f.variante} (${f.sku}) en ${f.local}.\n\n`
      + `El sistema tiene ${f.stock}. ¿Cuántas unidades hay realmente en el local?`,
      String(f.faltan),
    );
    if (txt === null) return;
    const contadas = Number(txt);
    if (!Number.isInteger(contadas) || contadas < 0) {
      alert("Poné un número entero de unidades (0 o más).");
      return;
    }

    setAjustando(f.productVariantId + "-" + f.locationId);
    try {
      // `ajuste` fija el stock contado; ingreso/egreso lo mueven en delta. Acá
      // lo que se carga es el resultado de un conteo, así que va como ajuste.
      await http.patch(`/products/variants/${f.productVariantId}/stock`, {
        tipo: "ajuste",
        cantidad: contadas,
        locationId: f.locationId,
        motivo: `Regularización: se había vendido sin stock cargado (estaba en ${f.stock})`,
      });
      await cargar();
    } catch (e) {
      setError(mensajeDeError(e, "No se pudo regularizar."));
    }
    setAjustando(null);
  }

  return (
    <div>
      <PageHeader
        title="Stock"
        subtitle="Lo que se vendió sin tenerlo cargado y quedó en negativo"
        actions={
          <button className="btn-ghost" onClick={cargar} disabled={cargando}>
            <RefreshCw size={15} /> Actualizar
          </button>
        }
      />
      <StockTabs />

      {error && <p className="mb-4 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}

      {cargando ? (
        <div className="card h-40 animate-pulse bg-paper-200/60" />
      ) : filas.length === 0 ? (
        <EmptyState
          icon={Check}
          title="No hay nada para regularizar"
          description="Ningún artículo quedó en negativo: todo lo que se vendió estaba cargado."
        />
      ) : (
        <>
          <Card className="mb-4">
            <p className="flex items-start gap-2 text-sm text-brass-800">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>
                <strong>{resumen.total}</strong> artículo{resumen.total === 1 ? "" : "s"} con stock negativo,{" "}
                <strong>{resumen.unidades}</strong> unidad{resumen.unidades === 1 ? "" : "es"} sin cargar.
                Se vendieron y el sistema no las tenía. Contá lo que hay en el estante y cargalo:
                mientras tanto el inventario de esos artículos no sirve para decidir reposición.
              </span>
            </p>
          </Card>

          <Card className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-line bg-paper-100 text-left text-xs uppercase tracking-wide text-ink-600">
                    <th className="px-4 py-3 font-medium">Artículo</th>
                    <th className="px-4 py-3 font-medium">Local</th>
                    <th className="px-4 py-3 text-right font-medium">Sistema</th>
                    <th className="px-4 py-3 text-right font-medium">Sin cargar</th>
                    <th className="px-4 py-3 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {filas.map((f) => (
                    <tr key={`${f.productVariantId}-${f.locationId}`} className="border-b border-line last:border-0">
                      <td className="px-4 py-3">
                        <p className="text-ink-900">{f.titulo}</p>
                        <p className="text-xs text-ink-500">
                          {f.variante}{f.variante ? " · " : ""}<span className="font-mono">{f.sku}</span>
                        </p>
                      </td>
                      <td className="px-4 py-3 text-ink-700">{f.local}</td>
                      <td className="px-4 py-3 text-right font-medium text-brick-500">{f.stock}</td>
                      <td className="px-4 py-3 text-right text-ink-900">{f.faltan}</td>
                      <td className="px-4 py-3 text-right">
                        {puedeEditar && (
                          <button
                            className="btn-ghost px-2 py-1 text-xs"
                            disabled={ajustando === f.productVariantId + "-" + f.locationId}
                            onClick={() => regularizar(f)}
                          >
                            <PackagePlus size={13} /> Regularizar
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <p className="mt-3 text-xs text-ink-500">
            Si la mercadería está en otro local, lo que corresponde es{" "}
            <Link to="/stock/por-local" className="underline">transferirla</Link> en vez de cargarla de nuevo:
            cargarla dos veces infla el inventario.
          </p>
        </>
      )}
    </div>
  );
}
