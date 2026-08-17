import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Search, RefreshCw, AlertTriangle } from "lucide-react";
import * as api from "../lib/api";
import { mensajeDe } from "../lib/http";
import { plata, fecha } from "../lib/formato";
import { Card, PageHead, Aviso, Cargando, Vacio, Tabla, Estado } from "../components/ui";

const FILTROS = [
  { valor: "",          texto: "Todas" },
  { valor: "trial",     texto: "En prueba" },
  { valor: "activa",    texto: "Al día" },
  { valor: "morosa",    texto: "Vencidas" },
  { valor: "lectura",   texto: "Sólo lectura" },
];

export default function CuentasPage() {
  const [params, setParams] = useSearchParams();
  const estado = params.get("estado") || "";

  const [buscar, setBuscar] = useState(params.get("buscar") || "");
  const [cuentas, setCuentas] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");

  async function cargar() {
    setCargando(true); setError("");
    try {
      const r = await api.getCuentas({ buscar: buscar || undefined, estado: estado || undefined });
      setCuentas(r.cuentas || []);
    } catch (e) {
      setError(mensajeDe(e, "No se pudieron cargar las cuentas."));
    } finally { setCargando(false); }
  }

  useEffect(() => { cargar(); /* eslint-disable-next-line */ }, [estado]);

  function aplicarBusqueda(e) {
    e.preventDefault();
    const p = new URLSearchParams(params);
    buscar ? p.set("buscar", buscar) : p.delete("buscar");
    setParams(p);
    cargar();
  }

  return (
    <div>
      <PageHead
        titulo="Cuentas"
        bajada={`${cuentas.length} negocio${cuentas.length === 1 ? "" : "s"}`}
        acciones={
          <button className="btn-ghost btn-sm" onClick={cargar}>
            <RefreshCw size={13} /> Actualizar
          </button>
        }
      />

      <Aviso tono="error" onCerrar={() => setError("")}>{error}</Aviso>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <form onSubmit={aplicarBusqueda} className="flex flex-1 items-center gap-2 sm:max-w-sm">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
            <input
              className="input pl-8"
              placeholder="Negocio, email o CUIT…"
              value={buscar}
              onChange={(e) => setBuscar(e.target.value)}
            />
          </div>
          <button className="btn-ghost btn-sm">Buscar</button>
        </form>

        <div className="flex flex-wrap gap-1">
          {FILTROS.map((f) => (
            <button
              key={f.valor}
              onClick={() => {
                const p = new URLSearchParams(params);
                f.valor ? p.set("estado", f.valor) : p.delete("estado");
                setParams(p);
              }}
              className={`rounded-[3px] px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors ${
                estado === f.valor ? "bg-brass text-deep" : "text-dim hover:text-text"
              }`}
            >
              {f.texto}
            </button>
          ))}
        </div>
      </div>

      <Card className="p-0">
        {cargando ? (
          <Cargando />
        ) : cuentas.length === 0 ? (
          <Vacio>No hay cuentas que coincidan con ese filtro.</Vacio>
        ) : (
          <Tabla cabeceras={[
            "Negocio", "Plan", "Estado", "Vence",
            { texto: "Mensual", align: "right" }, "",
          ]}>
            {cuentas.map((c) => {
              // Una baja pedida manda sobre todo lo demás: es lo único de esta
              // tabla que caduca si nadie la mira.
              const urgente = Boolean(c.bajaSolicitadaEn);
              const porVencer = c.diasRestantes != null && c.diasRestantes <= 3;
              return (
                <tr
                  key={c.id}
                  className={`border-b border-line2 last:border-0 hover:bg-surface2/60 ${
                    urgente ? "stripe-crit" : porVencer ? "stripe-warn" : ""
                  }`}
                >
                  <td className="td">
                    <Link to={`/cuentas/${c.id}`} className="font-medium text-text hover:text-brass">
                      {c.nombreNegocio}
                    </Link>
                    <p className="text-xs text-faint">{c.email} · CUIT {c.cuit}</p>
                    {urgente && (
                      <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-crit">
                        <AlertTriangle size={11} /> Pidió la baja
                      </p>
                    )}
                  </td>
                  <td className="td text-dim">{c.planNombre || "—"}</td>
                  <td className="td"><Estado valor={c.estado} /></td>
                  <td className="td text-dim">
                    {fecha(c.vence)}
                    {c.diasRestantes != null && (
                      <span className={`block text-xs ${porVencer ? "text-warn" : "text-faint"}`}>
                        {c.diasRestantes >= 0 ? `${c.diasRestantes} días` : "vencido"}
                      </span>
                    )}
                  </td>
                  <td className="td text-right tabular">
                    {plata(c.precio)}
                    {c.descuentoPct > 0 && (
                      <span className="block text-xs text-ok">−{c.descuentoPct}%</span>
                    )}
                  </td>
                  <td className="td text-right">
                    <Link to={`/cuentas/${c.id}`} className="btn-ghost btn-sm">Abrir</Link>
                  </td>
                </tr>
              );
            })}
          </Tabla>
        )}
      </Card>
    </div>
  );
}
