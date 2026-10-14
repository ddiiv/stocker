import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Globe, AlertTriangle, KeyRound } from "lucide-react";
import { PageHeader, Card } from "../../components/ui/Layout";
import EstadoPlataforma from "../../components/plataformas/EstadoPlataforma";
import CotizacionForm from "../../components/plataformas/CotizacionForm";
import { fetchPlataformas } from "../../services/plataformasService";
import { mensajeDeError } from "../../utils/errores";
import { haceCuanto, fechaYHora } from "../../utils/cuenta";
import { plataforma, avisoDeUso, ultimaCotizacion } from "../../utils/plataformas";
import { esAdministradorTotal } from "../../utils/permissions";
import { useAuth } from "../../context/AuthContext";

/*
 * Plataformas → Tienda propia.
 *
 * Una página de venta online hecha a medida que habla con Stocker con una
 * credencial de máquina (origen 'tienda'). La credencial la emite el equipo
 * de Stocker desde el backoffice (decisión del dueño): acá el cliente ve si
 * está conectada y cuándo se usó por última vez, nunca el token.
 *
 * Una tienda por negocio, como hoy: emitir una credencial nueva apaga la
 * anterior.
 */
const QUE_HACE = [
  "Tu página muestra el catálogo, los precios y el stock que Stocker tiene para vender online (los locales que abastecen la venta web, menos el margen de seguridad).",
  "Cada venta de la página entra a Stocker y aparta la mercadería en el momento, por la misma cola que Mercado Libre y Jumpseller: dos canales nunca venden la última unidad.",
  "Los cobros que registra la página y los despachos que hacés en Stocker quedan unidos al mismo pedido, y la página se entera de cada cambio.",
];

const COMO_PEDIRLA = [
  "Pedí la conexión con el formulario de abajo (o por WhatsApp, si aparece el botón). Contanos quién te hace o te va a hacer la página.",
  "Te escribimos para ver el alcance. Si la página ya existe, se conecta; si no, te pasamos el presupuesto para hacerla.",
  "Al conectarla, el equipo de Stocker le entrega la credencial y la guía técnica a quien programa la página. Desde ese momento la ves acá como conectada.",
];

export default function TiendaPropiaPage() {
  const { user } = useAuth();
  const [estado, setEstado] = useState(null);
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(true);

  async function cargar() {
    setCargando(true);
    setError("");
    try {
      setEstado(await fetchPlataformas());
    } catch (e) {
      setError(mensajeDeError(e, "No se pudo leer el estado de la tienda."));
    } finally {
      setCargando(false);
    }
  }
  useEffect(() => { cargar(); }, []);

  const p = plataforma(estado, "tienda");
  const aviso = avisoDeUso(p);
  const duenio = esAdministradorTotal(user);

  return (
    <div>
      <PageHeader title="Tienda propia" subtitle="Tu página de venta online, conectada a Stocker." />

      {error && <p className="mb-4 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500" role="alert">{error}</p>}

      {cargando && !estado ? (
        <div className="card h-40 animate-pulse bg-paper-200/60" />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-5">
            <Card>
              <div className="flex items-start justify-between gap-3">
                <h3 className="flex items-center gap-2 font-display text-base font-semibold text-ink-950">
                  <Globe size={17} className="text-brass-700" /> Estado
                </h3>
                {p && <EstadoPlataforma plataforma={p} />}
              </div>
              {p?.conectada ? (
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-ink-500">Conectada desde</dt>
                  <dd className="text-ink-900">{fechaYHora(p.detalle?.conectadaDesde)}</dd>
                  <dt className="text-ink-500">Último uso</dt>
                  <dd className="text-ink-900">{p.detalle?.ultimoUso ? haceCuanto(p.detalle.ultimoUso) : "Todavía no"}</dd>
                </dl>
              ) : (
                <p className="mt-2 text-sm text-ink-600">Tu negocio no tiene una tienda propia conectada.</p>
              )}

              {p?.estado === "fuera_de_plan" && (
                <p className="mt-3 flex items-start gap-2 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-700" role="alert">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                  <span>
                    Tu plan no incluye la tienda propia: Stocker está rechazando lo que manda tu página.
                    {" "}{duenio
                      ? <>Pasá al {p.desde?.nombre || "plan que la incluye"} desde <Link className="underline" to="/cuenta/suscripcion">Suscripción</Link>.</>
                      : <>Avisale al dueño del negocio.</>}
                  </span>
                </p>
              )}
              {aviso && p?.estado === "conectada" && (
                <p className="mt-3 flex items-start gap-2 rounded-md bg-brass-50 px-3 py-2 text-sm text-brass-800">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" /> <span>{aviso}</span>
                </p>
              )}

              {p?.conectada && (
                <p className="mt-3 flex items-start gap-2 text-xs text-ink-500">
                  <KeyRound size={14} className="mt-0.5 shrink-0" />
                  <span>
                    La credencial no se muestra: la tiene quien programa tu página. Si se perdió o cambió quien te
                    hace la página, <Link className="underline" to="/soporte">escribinos</Link> y emitimos otra (la
                    anterior deja de servir en el momento).
                  </span>
                </p>
              )}
            </Card>

            <Card>
              <h3 className="mb-2 font-display text-base font-semibold text-ink-950">Qué hace la integración</h3>
              <ul className="space-y-2 text-sm text-ink-600">
                {QUE_HACE.map((t) => <li key={t}>· {t}</li>)}
              </ul>
              <p className="mt-3 text-xs text-ink-500">
                Cómo habla la página con Stocker, paso a paso, está en el <Link className="underline" to="/plataformas">Resumen</Link>.
              </p>
            </Card>
          </div>

          {!p?.conectada && (
            <Card>
              <h3 className="mb-2 font-display text-base font-semibold text-ink-950">Cómo pedirla</h3>
              <ol className="mb-4 space-y-2 text-sm text-ink-600">
                {COMO_PEDIRLA.map((t, i) => <li key={t}>{i + 1}. {t}</li>)}
              </ol>
              <CotizacionForm
                tipo="tienda_propia"
                plataforma={p}
                whatsapp={estado?.whatsapp?.tienda_propia}
                ultima={ultimaCotizacion(estado, "tienda_propia")}
                placeholder={"Ej: tenemos una tienda en WordPress que nos hizo un programador y queremos que tome el stock de Stocker.\nO: no tenemos página y queremos una."}
                onEnviada={cargar}
              />
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
