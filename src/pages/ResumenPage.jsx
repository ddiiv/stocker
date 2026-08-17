import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw, ArrowRight } from "lucide-react";
import * as api from "../lib/api";
import { mensajeDe } from "../lib/http";
import { plata, numero } from "../lib/formato";
import { Card, PageHead, Aviso, Cargando } from "../components/ui";

/*
 * Panel de entrada.
 *
 * Arriba, lo que hay que atender hoy: transferencias esperando y bajas
 * pedidas. Abajo, la foto del negocio. Ese orden es a propósito — el operador
 * abre esto para saber qué le toca hacer, no para mirar métricas.
 */
export default function ResumenPage() {
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(true);

  async function cargar() {
    setCargando(true); setError("");
    try { setDatos(await api.getResumen()); }
    catch (e) { setError(mensajeDe(e, "No se pudo cargar el panel.")); }
    finally { setCargando(false); }
  }
  useEffect(() => { cargar(); }, []);

  if (cargando) return <Cargando />;

  const pendientes = datos?.transferenciasPorAprobar || 0;
  const bajas = datos?.bajasPendientes || 0;
  const hayTareas = pendientes > 0 || bajas > 0;

  return (
    <div>
      <PageHead
        titulo="Panel"
        bajada="Estado de la plataforma"
        acciones={
          <button className="btn-ghost btn-sm" onClick={cargar}>
            <RefreshCw size={13} /> Actualizar
          </button>
        }
      />

      <Aviso tono="error" onCerrar={() => setError("")}>{error}</Aviso>

      {/* ── Pendientes ─────────────────────────────────────── */}
      {hayTareas ? (
        <div className="mb-6 grid gap-3 sm:grid-cols-2">
          {pendientes > 0 && (
            <Tarea
              tono="warn"
              cantidad={pendientes}
              texto={`transferencia${pendientes === 1 ? "" : "s"} esperando que la verifiques`}
              a="/cuentas?estado=lectura"
              cta="Ver cuentas"
            />
          )}
          {bajas > 0 && (
            <Tarea
              tono="crit"
              cantidad={bajas}
              texto={`cuenta${bajas === 1 ? "" : "s"} pidió la baja`}
              a="/cuentas"
              cta="Ver cuentas"
            />
          )}
        </div>
      ) : (
        <Card className="mb-6 px-4 py-3">
          <p className="text-sm text-dim">No hay nada pendiente de tu parte.</p>
        </Card>
      )}

      {/* ── Foto del negocio ───────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile rotulo="Cuentas" valor={numero(datos?.negocios)} nota="Negocios registrados" />
        <Tile
          rotulo="Facturación mensual"
          valor={plata(datos?.facturacionMensual)}
          nota="Sólo suscripciones al día"
          destacado
        />
        <Tile rotulo="Al día" valor={numero(datos?.porEstado?.activa || 0)} nota="Pagando" />
        <Tile
          rotulo="En prueba"
          valor={numero(datos?.porEstado?.trial || 0)}
          nota="Todavía sin cobrar"
        />
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Card className="p-4">
          <p className="eyebrow mb-3">Cuentas por estado</p>
          <Desglose datos={datos?.porEstado} etiquetas={{
            trial: "En prueba", activa: "Al día", morosa: "Vencidas",
            lectura: "Sólo lectura", cancelada: "Canceladas",
          }} />
        </Card>

        <Card className="p-4">
          <p className="eyebrow mb-3">Cuentas por plan</p>
          <Desglose datos={datos?.porPlan} etiquetas={{
            inicial: "Inicial", pro: "Pro", superior: "Superior",
            enterprise: "Enterprise", "sin-plan": "Sin plan",
          }} />
        </Card>
      </div>
    </div>
  );
}

function Tile({ rotulo, valor, nota, destacado }) {
  return (
    <Card className="p-4">
      <p className="eyebrow">{rotulo}</p>
      <p className={`mt-1.5 font-mono text-2xl font-semibold tabular ${destacado ? "text-brass" : ""}`}>
        {valor}
      </p>
      <p className="mt-0.5 text-xs text-faint">{nota}</p>
    </Card>
  );
}

function Tarea({ tono, cantidad, texto, a, cta }) {
  return (
    <Card className={`flex items-center gap-4 p-4 ${tono === "crit" ? "stripe-crit" : "stripe-warn"}`}>
      <span className={`font-mono text-2xl font-semibold ${tono === "crit" ? "text-crit" : "text-warn"}`}>
        {cantidad}
      </span>
      <p className="flex-1 text-sm text-text">{texto}</p>
      <Link to={a} className="btn-ghost btn-sm shrink-0">
        {cta} <ArrowRight size={13} />
      </Link>
    </Card>
  );
}

/* Barras proporcionales. Con pocos datos una tabla comunica mejor que un
   gráfico, y el ancho relativo ya deja ver el reparto. */
function Desglose({ datos, etiquetas }) {
  const filas = Object.entries(datos || {});
  if (!filas.length) return <p className="text-sm text-dim">Sin datos.</p>;
  const total = filas.reduce((s, [, n]) => s + n, 0) || 1;

  return (
    <div className="space-y-2.5">
      {filas.map(([clave, n]) => (
        <div key={clave}>
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-dim">{etiquetas[clave] || clave}</span>
            <span className="tabular text-text">{n}</span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface2">
            <div className="h-full rounded-full bg-brass" style={{ width: `${(n / total) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
