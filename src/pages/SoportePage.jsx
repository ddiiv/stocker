import { useEffect, useState } from "react";
import { LifeBuoy, Send, Loader2, Check, Mail } from "lucide-react";
import { PageHeader, Card } from "../components/ui/Layout";
import { http } from "../lib/http";
import { useAuth } from "../context/AuthContext";
import { mensajeDeError } from "../utils/errores";

/*
 * Reportar un problema.
 *
 * El pedido sale desde adentro del sistema y no desde el mail de la persona,
 * para que llegue con el contexto puesto: qué negocio, qué plan, en qué
 * pantalla estaba, con qué navegador. Un "no me anda" suelto arranca con dos
 * idas y vueltas antes de que se pueda mirar nada.
 *
 * Se pide algo de detalle a propósito. Es molesto en el momento y ahorra el
 * intercambio de después, que es más molesto todavía cuando el problema está
 * frenando la caja.
 */

const TIPOS = [
  { value: "bug", label: "Algo no funciona", ayuda: "Un error, una pantalla que no carga, un número que no cierra." },
  { value: "duda", label: "No sé cómo hacer algo", ayuda: "Sabés qué querés y no encontrás por dónde." },
  { value: "facturacion", label: "Facturación o ARCA", ayuda: "Comprobantes rechazados, CAE, puntos de venta." },
  { value: "sugerencia", label: "Sugerencia", ayuda: "Algo que te haría el día más fácil." },
  { value: "otro", label: "Otra cosa", ayuda: "" },
];

export default function SoportePage() {
  const { user } = useAuth();
  const [info, setInfo] = useState(null);
  const [tipo, setTipo] = useState("bug");
  const [asunto, setAsunto] = useState("");
  const [detalle, setDetalle] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState("");
  const [enviado, setEnviado] = useState(null);

  useEffect(() => {
    http.get("/soporte/info").then(({ data }) => setInfo(data)).catch(() => {});
  }, []);

  async function enviar(e) {
    e.preventDefault();
    setEnviando(true); setError(""); setEnviado(null);
    try {
      const { data } = await http.post("/soporte/reporte", {
        tipo, asunto: asunto.trim(), detalle: detalle.trim(),
        /*
         * De dónde vino. Se manda la pantalla anterior y no ésta: nadie
         * reporta un problema de la pantalla de reportar problemas.
         */
        pantalla: document.referrer && document.referrer.startsWith(window.location.origin)
          ? document.referrer.replace(window.location.origin, "")
          : "(entró directo a Soporte)",
      });
      setEnviado(data);
      setAsunto(""); setDetalle("");
    } catch (err) {
      setError(mensajeDeError(err, "No se pudo enviar el reporte."));
    }
    setEnviando(false);
  }

  const elegido = TIPOS.find((t) => t.value === tipo);
  const faltaDetalle = detalle.trim().length > 0 && detalle.trim().length < 20;

  return (
    <div>
      <PageHeader
        title="Soporte"
        subtitle="Contanos qué pasó y lo miramos"
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          {enviado ? (
            <div className="py-8 text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-teal-50 text-teal-600">
                <Check size={22} />
              </div>
              <p className="font-display text-base font-semibold text-ink-950">Reporte enviado</p>
              <p className="mt-1 text-sm text-ink-600">{enviado.mensaje}</p>
              <button className="btn-ghost mt-4" onClick={() => setEnviado(null)}>
                Reportar otra cosa
              </button>
            </div>
          ) : (
            <form onSubmit={enviar} className="space-y-4">
              {error && <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}

              <div>
                <label className="label">¿De qué se trata?</label>
                <div className="flex flex-wrap gap-1.5">
                  {TIPOS.map((t) => (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => setTipo(t.value)}
                      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                        tipo === t.value
                          ? "border-teal-600 bg-teal-600 text-paper-50"
                          : "border-line bg-paper-50 text-ink-700 hover:bg-paper-100"
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                {elegido?.ayuda && <p className="mt-1.5 text-xs text-ink-500">{elegido.ayuda}</p>}
              </div>

              <div>
                <label className="label">En una línea, ¿qué pasó?</label>
                <input
                  className="input"
                  maxLength={120}
                  placeholder="Ej: al cobrar con tarjeta me dice que falta el turno de caja"
                  value={asunto}
                  onChange={(e) => setAsunto(e.target.value)}
                  required
                />
              </div>

              <div>
                <label className="label">Contanos un poco más</label>
                <textarea
                  className="input min-h-[140px]"
                  maxLength={4000}
                  placeholder={"Qué estabas haciendo, qué esperabas que pasara y qué pasó.\nSi te tiró un mensaje de error, copialo tal cual."}
                  value={detalle}
                  onChange={(e) => setDetalle(e.target.value)}
                  required
                />
                <p className={`mt-1 text-xs ${faltaDetalle ? "text-brass-800" : "text-ink-500"}`}>
                  {faltaDetalle
                    ? `Un poco más: ${20 - detalle.trim().length} caracteres para poder mirarlo sin volver a preguntarte.`
                    : "Cuanto más concreto, menos idas y vueltas."}
                </p>
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
                <p className="text-xs text-ink-500">
                  Va con tu negocio, tu plan y la pantalla donde estabas. No hace falta que los escribas.
                </p>
                <button className="btn-accent shrink-0" disabled={enviando || faltaDetalle}>
                  {enviando ? <><Loader2 size={15} className="animate-spin" /> Enviando…</> : <><Send size={15} /> Enviar</>}
                </button>
              </div>
            </form>
          )}
        </Card>

        <div className="space-y-4">
          <Card>
            <h3 className="mb-2 font-display text-sm font-semibold text-ink-950">
              <LifeBuoy size={15} className="mr-1 inline text-brass-700" /> Cómo llega
            </h3>
            <p className="text-xs text-ink-600">
              Tu reporte va a <strong>{info?.soporte || "soporte"}</strong>, que la lee una persona.
              Te contestamos a{" "}
              <strong>{user?.email || user?.negocio?.email || "tu email"}</strong>.
            </p>
            <p className="mt-2 text-xs text-ink-500">
              Los correos automáticos —comprobantes, facturas, códigos— salen desde una casilla que
              no recibe respuestas. Para hablar con alguien, es acá.
            </p>
          </Card>

          {/* Sin correo configurado no se ofrece un formulario que no va a
              mandar nada: se da la dirección para escribir a mano. */}
          {info && !info.envioDisponible && (
            <Card className="border-brass-300 bg-brass-50/40">
              <p className="text-xs text-brass-800">
                <Mail size={14} className="mr-1 inline" />
                El envío desde el sistema no está disponible en este momento. Escribinos directo a{" "}
                <a href={`mailto:${info.soporte}`} className="underline">{info.soporte}</a>.
              </p>
            </Card>
          )}

          {/* Diagnóstico sólo para el dueño: a un empleado no le sirve. */}
          {info?.diagnostico?.avisos?.length > 0 && (
            <Card className="border-brick-500/30 bg-brick-50/40">
              <p className="mb-1 text-xs font-medium text-brick-500">Revisá la configuración del correo</p>
              <ul className="space-y-1 text-xs text-ink-600">
                {info.diagnostico.avisos.map((a) => <li key={a}>{a}</li>)}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
