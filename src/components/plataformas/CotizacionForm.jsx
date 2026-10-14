import { useState } from "react";
import { Loader2, Send, Check, MessageCircle, Info } from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { pedirCotizacion } from "../../services/plataformasService";
import { mensajeDeError } from "../../utils/errores";
import {
  puedePedirCotizacion, validarCotizacion, DETALLE_MINIMO, ESTADOS_COTIZACION, TIPOS_COTIZACION,
} from "../../utils/plataformas";
import { formatDate } from "../../utils/formatters";

/*
 * Pedir la cotización de un desarrollo a medida.
 *
 * Es un trabajo por única vez que hace el equipo de Stocker: el formulario no
 * contrata nada, deja el pedido para que alguien lo lea y escriba. Se guarda
 * en Stocker antes de avisar por mail, así que "Recibimos tu pedido" es
 * verdad aunque el correo esté caído.
 *
 * El botón de WhatsApp es un enlace con el texto ya escrito (decisión del
 * dueño): aparece sólo si el equipo configuró el número.
 *
 * `plataforma` es la fila de GET /api/plataformas: si el plan no incluye
 * conectar lo que se cotiza, se dice antes de pedir — el desarrollo se puede
 * cotizar en cualquier plan, pero para usarlo hace falta el que lo incluye.
 */
export default function CotizacionForm({ tipo, plataforma, whatsapp, ultima, placeholder, onEnviada }) {
  const { user } = useAuth();
  const [detalle, setDetalle] = useState("");
  const [contactoNombre, setContactoNombre] = useState("");
  const [contactoEmail, setContactoEmail] = useState("");
  const [contactoTelefono, setContactoTelefono] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState("");
  const [enviada, setEnviada] = useState(null);

  const puede = puedePedirCotizacion(user);
  const faltaDetalle = detalle.trim().length < DETALLE_MINIMO;
  const sinPlan = plataforma && !plataforma.incluida;

  async function enviar(e) {
    e.preventDefault();
    const problema = validarCotizacion({ detalle, contactoEmail });
    if (problema) { setError(problema); return; }
    setEnviando(true);
    setError("");
    try {
      const r = await pedirCotizacion({
        tipo, detalle: detalle.trim(),
        contactoNombre: contactoNombre.trim() || undefined,
        contactoEmail: contactoEmail.trim() || undefined,
        contactoTelefono: contactoTelefono.trim() || undefined,
      });
      setEnviada(r);
      setDetalle("");
      onEnviada?.(r.cotizacion);
    } catch (err) {
      setError(mensajeDeError(err, "No se pudo mandar el pedido. Probá de nuevo en un rato."));
    } finally {
      setEnviando(false);
    }
  }

  const avisoPlan = sinPlan && (
    <p className="flex items-start gap-2 rounded-md bg-brass-50 px-3 py-2 text-xs text-brass-800">
      <Info size={14} className="mt-0.5 shrink-0" />
      <span>
        Cotizarlo se puede en cualquier plan. Para conectarlo a Stocker hace falta el{" "}
        <strong>{plataforma.desde?.nombre || "plan que lo incluye"}</strong> o uno superior.
      </span>
    </p>
  );

  if (enviada) {
    return (
      <div className="space-y-3 text-center">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-teal-50 text-teal-600">
          <Check size={22} />
        </div>
        <p className="font-display text-base font-semibold text-ink-950">Pedido #{enviada.cotizacion?.id} recibido</p>
        <p className="text-sm text-ink-600">{enviada.mensaje}</p>
        {enviada.whatsapp && (
          <a href={enviada.whatsapp} target="_blank" rel="noopener noreferrer" className="btn-ghost inline-flex border border-line">
            <MessageCircle size={15} /> Seguir por WhatsApp
          </a>
        )}
      </div>
    );
  }

  if (!puede) {
    return (
      <div className="space-y-3">
        {avisoPlan}
        <p className="text-sm text-ink-600">
          La cotización la pide el dueño del negocio o alguien con permiso para editar Plataformas.
          Avisales si querés {tipo === "tienda_propia" ? "conectar la tienda online" : "un portal para tus clientes mayoristas"}.
        </p>
        {ultima && <EstadoDelPedido ultima={ultima} />}
      </div>
    );
  }

  return (
    <form onSubmit={enviar} className="space-y-4">
      {avisoPlan}
      {ultima && <EstadoDelPedido ultima={ultima} />}
      {error && <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500" role="alert">{error}</p>}

      <div>
        <label className="label" htmlFor={`cot-detalle-${tipo}`}>Contanos qué necesitás</label>
        <textarea
          id={`cot-detalle-${tipo}`}
          className="input min-h-[120px]"
          maxLength={4000}
          placeholder={placeholder}
          value={detalle}
          onChange={(e) => setDetalle(e.target.value)}
          aria-required="true"
        />
        <p className={`mt-1 text-xs ${detalle && faltaDetalle ? "text-brass-800" : "text-ink-500"}`}>
          {detalle && faltaDetalle
            ? `Un poco más: ${DETALLE_MINIMO - detalle.trim().length} caracteres para poder cotizarlo sin volver a preguntarte.`
            : "Cuanto más concreto, mejor sale el presupuesto."}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <div>
          <label className="label" htmlFor={`cot-nombre-${tipo}`}>Quién atiende</label>
          <input id={`cot-nombre-${tipo}`} className="input" maxLength={150} value={contactoNombre}
            onChange={(e) => setContactoNombre(e.target.value)} placeholder="Opcional" />
        </div>
        <div>
          <label className="label" htmlFor={`cot-email-${tipo}`}>Email</label>
          <input id={`cot-email-${tipo}`} type="email" className="input" maxLength={150} value={contactoEmail}
            onChange={(e) => setContactoEmail(e.target.value)} placeholder="Opcional" />
        </div>
        <div>
          <label className="label" htmlFor={`cot-tel-${tipo}`}>Teléfono</label>
          <input id={`cot-tel-${tipo}`} className="input" maxLength={40} value={contactoTelefono}
            onChange={(e) => setContactoTelefono(e.target.value)} placeholder="Opcional" />
        </div>
      </div>
      <p className="-mt-2 text-xs text-ink-500">Lo que dejes vacío lo completamos con los datos de tu cuenta.</p>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <p className="text-xs text-ink-500">
          Es un trabajo por única vez: te pasamos el presupuesto antes de empezar y no se cobra nada por pedirlo.
        </p>
        <div className="flex flex-wrap gap-2">
          {whatsapp && (
            <a href={whatsapp} target="_blank" rel="noopener noreferrer" className="btn-ghost border border-line">
              <MessageCircle size={15} /> Escribir por WhatsApp
            </a>
          )}
          <button className="btn-accent shrink-0" disabled={enviando || faltaDetalle}>
            {enviando ? <><Loader2 size={15} className="animate-spin" /> Enviando…</> : <><Send size={15} /> Pedir cotización</>}
          </button>
        </div>
      </div>
    </form>
  );
}

function EstadoDelPedido({ ultima }) {
  return (
    <p className="rounded-md border border-line bg-paper-100 px-3 py-2 text-xs text-ink-700">
      Tu último pedido ({TIPOS_COTIZACION[ultima.tipo] || ultima.tipoTexto}, #{ultima.id}, del {formatDate(ultima.creadaEn)}):{" "}
      <strong>{ESTADOS_COTIZACION[ultima.estado] || ultima.estado}</strong>.
    </p>
  );
}
