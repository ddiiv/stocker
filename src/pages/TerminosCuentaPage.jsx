import { useEffect, useState } from "react";
import { FileText, ExternalLink } from "lucide-react";
import { fetchAccount } from "../services/accountService";
import { PageHeader, Card } from "../components/ui/Layout";
import CuentaTabs from "../components/cuenta/CuentaTabs";
import { fechaYHora, estadoDeTerminos } from "../utils/cuenta";
import useEnlacesLegales from "../hooks/useEnlacesLegales";

/*
 * Qué versión de los Términos aceptó la cuenta, cuándo, y cuál rige hoy.
 *
 * La versión aceptada y la fecha se guardan al registrarse (las pone el
 * servidor, no el navegador). La vigente sale del mismo lugar que usa el
 * registro (back: src/config/terminos.js), así que si dicen lo mismo, es la
 * misma. La IP desde la que se aceptaron no se muestra: no viaja al navegador.
 *
 * Los textos viven en la landing y se abren en otra pestaña: son públicos y
 * no hace falta salir de la cuenta para leerlos.
 */
export default function TerminosCuentaPage() {
  const [cuenta, setCuenta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const legales = useEnlacesLegales();

  useEffect(() => {
    fetchAccount()
      .then(setCuenta)
      .catch((e) => setError(e.response?.data?.message || "No se pudo cargar la cuenta"))
      .finally(() => setLoading(false));
  }, []);

  const estado = estadoDeTerminos(cuenta || {});

  return (
    <div>
      <PageHeader title="Términos y condiciones" subtitle="Lo que aceptó la cuenta y lo que rige hoy" />
      <CuentaTabs />

      {loading ? (
        <div className="card h-48 animate-pulse bg-paper-200/60" />
      ) : error ? (
        <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-2">
          <Card>
            <p className="mb-3 flex items-center gap-2 font-display text-base font-semibold text-ink-950">
              <FileText size={17} /> Términos y Condiciones
              {estado === "al-dia" && <span className="badge badge-ok">Al día</span>}
            </p>
            <dl className="space-y-2 text-sm">
              <div className="flex items-start justify-between gap-3">
                <dt className="text-ink-600">Versión aceptada</dt>
                <dd className="text-right text-ink-900">
                  {cuenta?.terminosVersion || <span className="text-ink-500">sin registro</span>}
                </dd>
              </div>
              <div className="flex items-start justify-between gap-3">
                <dt className="text-ink-600">Aceptada el</dt>
                <dd className="text-right text-ink-900">
                  {cuenta?.terminosAceptadosEn ? fechaYHora(cuenta.terminosAceptadosEn) : "—"}
                </dd>
              </div>
              <div className="flex items-start justify-between gap-3">
                <dt className="text-ink-600">Versión vigente</dt>
                <dd className="text-right text-ink-900">{cuenta?.terminosVigente || "—"}</dd>
              </div>
            </dl>

            {/*
              Se dice lo que pasó, sin pedir nada: aceptar de nuevo una
              versión nueva no es algo que esta pantalla ofrezca, y un botón
              de "Aceptar" acá sería una decisión de producto que no se tomó.
            */}
            {estado === "anterior" && (
              <p className="mt-3 rounded-md bg-brass-50 px-3 py-2 text-sm text-ink-900">
                Después de que aceptaste se publicó una versión nueva ({cuenta.terminosVigente}).
                Te recomendamos leerla.
              </p>
            )}
            {estado === "sin-registro" && (
              <p className="mt-3 rounded-md bg-paper-200 px-3 py-2 text-sm text-ink-700">
                Esta cuenta se creó antes de que guardáramos qué versión se aceptaba al
                registrarse, así que no tenemos ese dato.
              </p>
            )}

            {legales.terminos && (
              <a className="btn-accent mt-4" href={legales.terminos}
                target="_blank" rel="noopener noreferrer">
                Leer los Términos vigentes <ExternalLink size={14} />
              </a>
            )}
          </Card>

          <Card>
            <p className="mb-3 font-display text-base font-semibold text-ink-950">Otros textos</p>
            <ul className="divide-y divide-line text-sm">
              <EnlaceLegal href={legales.privacidad} texto="Política de Privacidad" />
              <EnlaceLegal href={legales.reembolsos} texto="Política de Reembolsos" />
              <EnlaceLegal href={legales.cookies} texto="Política de Cookies" />
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
}

// Sin dirección (ver utils/legales.js), el nombre solo: nunca un enlace inventado.
function EnlaceLegal({ href, texto }) {
  if (!href) return <li className="py-2.5 text-ink-700">{texto}</li>;
  return (
    <li>
      <a href={href} target="_blank" rel="noopener noreferrer"
        className="flex items-center justify-between gap-2 py-2.5 text-ink-700 hover:text-ink-950">
        {texto} <ExternalLink size={14} className="shrink-0 text-ink-400" />
        <span className="sr-only">(se abre en otra pestaña)</span>
      </a>
    </li>
  );
}
