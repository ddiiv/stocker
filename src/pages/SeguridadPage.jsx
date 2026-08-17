import { useEffect, useState } from "react";
import { RefreshCw, ShieldCheck, ShieldAlert, Copy, Check, Ban } from "lucide-react";
import * as api from "../lib/api";
import { mensajeDe } from "../lib/http";
import { fechaHora, numero } from "../lib/formato";
import { Card, PageHead, Aviso, Cargando, Vacio, Tabla } from "../components/ui";

/*
 * Estado de las defensas de borde.
 *
 * Lo que se busca acá es que el modo silencioso de fallar deje de ser posible:
 * la variable de IPs quedó sin cargar, el panel siguió abierto a internet, y
 * nadie se enteró. En pantalla y en el arranque del servidor, no pasa
 * inadvertido.
 *
 * La lista de sospechosos es lo único que se mira de rutina: quién insiste,
 * contra cuántas cuentas y desde cuándo.
 */

const VARIABLES = [
  {
    clave: "BACKOFFICE_IPS",
    que: "Desde qué IPs se puede abrir este panel. Acepta direcciones sueltas y CIDR, separadas por coma.",
    ejemplo: "200.45.12.34, 2803:9800:1234::/48",
  },
];

export default function SeguridadPage() {
  const [datos, setDatos] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");
  const [copiada, setCopiada] = useState("");

  async function cargar() {
    setCargando(true); setError("");
    try { setDatos(await api.getSeguridad()); }
    catch (e) { setError(mensajeDe(e, "No se pudo consultar el estado de seguridad.")); }
    finally { setCargando(false); }
  }
  useEffect(() => { cargar(); }, []);

  function copiar(texto, clave) {
    navigator.clipboard?.writeText(texto).then(() => {
      setCopiada(clave);
      setTimeout(() => setCopiada(""), 1500);
    });
  }

  if (cargando) return <Cargando />;

  const ips = datos?.backofficePorIp;
  const abierto = ips && !ips.activa;

  return (
    <div>
      <PageHead
        titulo="Seguridad"
        bajada="Qué está protegiendo el borde de la plataforma"
        acciones={
          <button className="btn-ghost btn-sm" onClick={cargar}>
            <RefreshCw size={13} /> Actualizar
          </button>
        }
      />

      <Aviso tono="error" onCerrar={() => setError("")}>{error}</Aviso>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ── Acceso al panel ────────────────────────────── */}
        <Card className={`p-4 lg:col-span-2 ${abierto ? "stripe-crit" : ""}`}>
          <p className="eyebrow">Acceso a este panel</p>
          <p className="mt-1 flex items-center gap-2 text-lg font-semibold">
            {abierto ? (
              <><ShieldAlert size={18} className="text-crit" /> Abierto a internet</>
            ) : (
              <><ShieldCheck size={18} className="text-ok" /> Restringido por IP</>
            )}
          </p>

          {abierto ? (
            <p className="mt-3 rounded-[3px] border border-crit/40 bg-crit-bg px-3 py-2 text-sm text-crit">
              Cualquiera que conozca la URL puede llegar al login. El segundo factor
              lo sostiene, pero la restricción por IP saca a casi todo internet de la
              ecuación antes de que llegue a probar una contraseña. Cargá{" "}
              <span className="font-mono">{ips?.variable}</span> en el servicio backend.
            </p>
          ) : (
            <p className="mt-3 text-sm text-dim">
              {ips.cantidad} regla{ips.cantidad === 1 ? "" : "s"} configurada
              {ips.cantidad === 1 ? "" : "s"}. Las direcciones no se muestran acá:
              viven sólo en la variable de entorno.
            </p>
          )}

          <p className="mt-4 border-t border-line pt-3 text-xs text-faint">
            Una IP doméstica cambia. Si la conexión se reinicia y la IP se mueve, el
            acceso se corta hasta actualizar la variable — es el costo de esto, y la
            razón de que el segundo factor siga siendo obligatorio.
          </p>
        </Card>

        {/* ── Bloqueo por fuerza bruta ───────────────────── */}
        <Card className="p-4">
          <p className="eyebrow">Fuerza bruta</p>
          <p className="mt-1 flex items-center gap-2 text-lg font-semibold">
            <ShieldCheck size={18} className="text-ok" /> Activo
          </p>
          <dl className="mt-3 space-y-1.5 border-t border-line pt-3 text-sm">
            <Fila k="Fallos por IP" v={datos.bloqueo.topePorIp} />
            <Fila k="Fallos por cuenta" v={datos.bloqueo.topePorCuenta} />
            <Fila k="Ventana" v={`${datos.bloqueo.ventanaMin} min`} />
          </dl>
          <p className="mt-3 text-xs text-faint">
            Se mide en los dos ejes: una IP probando muchas cuentas, y muchas IPs
            contra una sola cuenta. Sólo por IP, un ataque repartido con proxies no
            se detecta.
          </p>
        </Card>
      </div>

      {/* ── Intentos fallidos ──────────────────────────────── */}
      <div className="mb-3 mt-8 flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold">Intentos fallidos</h2>
        <span className="font-mono text-xs text-faint">
          {numero(datos.fallosUltimasHoras)} en las últimas 24 h
        </span>
      </div>

      <Card className="p-0">
        {datos.sospechosos.length === 0 ? (
          <Vacio>Ningún intento fallido en las últimas 24 horas.</Vacio>
        ) : (
          <Tabla
            cabeceras={[
              "IP", { texto: "Intentos", align: "right" },
              { texto: "Cuentas", align: "right" }, "Contra", "Último",
            ]}
            min="min-w-[640px]"
          >
            {datos.sospechosos.map((s) => (
              <tr key={s.ip} className={`border-b border-line2 last:border-0 ${s.bloqueada ? "stripe-crit" : ""}`}>
                <td className="td font-mono text-xs">
                  {s.ip}
                  {s.bloqueada && (
                    <span className="ml-2 inline-flex items-center gap-1 text-[11px] text-crit">
                      <Ban size={11} /> pasó el tope
                    </span>
                  )}
                </td>
                <td className="td text-right tabular">{s.intentos}</td>
                <td className="td text-right tabular">{s.cuentas}</td>
                <td className="td text-dim">
                  {s.tipos.map((t) => ({
                    business: "dueños", employee: "empleados",
                    platform: "backoffice", reset: "recuperación",
                  }[t] || t)).join(", ")}
                </td>
                <td className="td text-dim">{fechaHora(s.ultimo)}</td>
              </tr>
            ))}
          </Tabla>
        )}
      </Card>

      <p className="mt-3 text-xs text-faint">
        Se guardan 7 días y se purgan al arrancar el servidor. Un puñado de fallos
        de una IP conocida es alguien que se olvidó la contraseña; decenas contra
        muchas cuentas distintas es otra cosa.
      </p>

      {/* ── Variables ──────────────────────────────────────── */}
      <h2 className="mb-3 mt-8 text-lg font-semibold">Variables de entorno</h2>
      <Card className="divide-y divide-line2 p-0">
        {VARIABLES.map((v) => (
          <div key={v.clave} className="p-4">
            <button
              onClick={() => copiar(v.clave, v.clave)}
              className="inline-flex items-center gap-1.5 font-mono text-sm text-brass hover:underline"
              title="Copiar el nombre"
            >
              {v.clave}
              {copiada === v.clave ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
            </button>
            <p className="mt-1 text-sm text-dim">{v.que}</p>
            <p className="mt-0.5 font-mono text-xs text-faint">{v.ejemplo}</p>
          </div>
        ))}
      </Card>

      <p className="mt-4 text-xs text-faint">
        Las otras defensas —ráfagas, tamaño de cuerpo, filtros de forma y CORS— no
        se configuran: van fijas en el código, porque un valor mal puesto ahí abre
        un agujero sin que nadie lo note.
      </p>
    </div>
  );
}

function Fila({ k, v }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-faint">{k}</dt>
      <dd className="tabular text-dim">{v}</dd>
    </div>
  );
}
