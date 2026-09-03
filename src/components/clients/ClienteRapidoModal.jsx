import { useEffect, useRef, useState } from "react";
import { Loader2, Check, AlertTriangle, UserPlus } from "lucide-react";
import Modal from "../ui/Modal";
import { lookupCuit, createClient, buscarClientePorCuit } from "../../services/clientService";
import { mensajeDeError } from "../../utils/errores";

/*
 * Alta de cliente en el mostrador, sin salir del cobro.
 *
 * El caso es concreto: la venta está armada, el cliente pide factura o quiere
 * quedar en la cuenta, y no está cargado. Hasta ahora la única salida era irse
 * a Clientes —perdiendo el carrito, porque el punto de venta se desmonta al
 * navegar— cargarlo entero y volver a escanear todo.
 *
 * Por eso esto es un modal y no una pantalla: montado adentro del punto de
 * venta, el carrito ni se entera.
 *
 * ── Lo mínimo, y el resto que lo traiga ARCA ───────────────────────
 *
 * Se piden tres cosas: CUIT, email y celular. El nombre, el apellido y el
 * domicilio los trae el padrón, que además es la fuente que vale para
 * facturar. Pedirle al cajero que tipee una razón social con el cliente
 * enfrente es pedirle que la escriba mal.
 *
 * Si ARCA no contesta —se cae, o el CUIT no está en el padrón— igual se puede
 * guardar escribiendo el nombre a mano. Un alta que depende de que un servicio
 * externo esté vivo es un alta que va a fallar justo el día de más venta.
 */

const VACIO = { cuit: "", nombre: "", apellido: "", direccion: "", email: "", telefono: "" };

export default function ClienteRapidoModal({ open, onClose, onCreado }) {
  const [form, setForm] = useState(VACIO);
  const [padron, setPadron] = useState(null);   // { loading } | { data } | { error }
  /*
   * El cliente que ya tiene ese CUIT, si lo hay.
   *
   * Dos fichas con el mismo CUIT son la misma persona cargada dos veces, y eso
   * se paga después: la cuenta corriente repartida entre las dos y el histórico
   * de compras partido al medio.
   */
  const [repetido, setRepetido] = useState(null);
  const [bloqueados, setBloqueados] = useState([]);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState("");
  const debounce = useRef(null);

  useEffect(() => {
    if (!open) return;
    setForm(VACIO); setPadron(null); setBloqueados([]); setError("");
  }, [open]);

  useEffect(() => () => clearTimeout(debounce.current), []);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const esBloqueado = (k) => bloqueados.includes(k);

  function cambiarCuit(valor) {
    set("cuit", valor);
    setPadron(null);
    setBloqueados([]);
    setRepetido(null);
    clearTimeout(debounce.current);
    const limpio = valor.replace(/[^0-9]/g, "");
    if (limpio.length !== 11) return;

    // Medio segundo: el cajero todavía está tipeando los últimos dígitos y no
    // tiene sentido pegarle a ARCA una vez por tecla.
    debounce.current = setTimeout(async () => {
      setPadron({ loading: true });

      /*
       * Antes que nada: ¿este cliente ya está cargado?
       *
       * Si el CUIT ya existe en el negocio, cargarlo de nuevo parte en dos la
       * cuenta corriente y el histórico de compras de la misma persona. Se
       * avisa acá y se ofrece elegir el que ya estaba, en vez de dejar que
       * termine de escribir la ficha entera para que el servidor la rechace.
       */
      const yaEsta = await buscarClientePorCuit(limpio).catch(() => null);
      if (yaEsta?.existe) {
        setRepetido(yaEsta.cliente);
        setPadron(null);
        return;
      }
      const data = await lookupCuit(limpio);
      if (!data)          return setPadron({ error: "No se pudo consultar ARCA. Podés cargarlo a mano." });
      if (!data.valido)   return setPadron({ error: "Ese CUIT no es válido: revisá los números." });
      setPadron({ data });

      /*
       * Lo que viene de AFIP pisa y se bloquea; lo que viene de la heurística
       * local sólo rellena lo que esté vacío. La diferencia importa: uno es el
       * padrón y el otro es una deducción por el prefijo del CUIT.
       */
      const deAfip = data.source === "afip";
      const lock = deAfip ? (data.lockedFields || []) : [];
      setBloqueados(lock);

      setForm((f) => {
        const n = { ...f };
        const poner = (k, v) => {
          if (v == null || v === "") return;
          if (deAfip && lock.includes(k)) n[k] = v;
          else if (!f[k]) n[k] = v;
        };
        if (data.razonSocial) {
          if (data.tipoPersona === "juridica") {
            poner("nombre", data.razonSocial);
            if (deAfip && lock.includes("apellido")) n.apellido = "";
          } else if (data.apellido || data.nombre) {
            poner("apellido", data.apellido);
            poner("nombre", data.nombre);
          } else {
            const [ape, ...resto] = data.razonSocial.split(/[,\s]+/).filter(Boolean);
            if (resto.length) poner("apellido", ape);
            poner("nombre", resto.length ? resto.join(" ") : ape);
          }
        }
        if (data.domicilio) poner("direccion", data.domicilio);
        if (data.dniInferido) n.dni = data.dniInferido;
        return n;
      });
    }, 500);
  }

  /*
   * Qué hace falta para guardar.
   *
   * El nombre, y nada más: es lo único que el servidor exige y lo único sin lo
   * cual el cliente no se distingue de otro. El CUIT no es obligatorio a
   * propósito —hay clientes de mostrador sin CUIT— pero si se escribió, tiene
   * que estar completo.
   */
  const cuitLimpio = String(form.cuit || "").replace(/\D/g, "");
  const cuitIncompleto = cuitLimpio.length > 0 && cuitLimpio.length !== 11;
  // Con el CUIT ya usado no se guarda: sería la misma persona dos veces.
  const puedeGuardar = Boolean(form.nombre.trim()) && !cuitIncompleto && !repetido && !guardando;

  async function guardar() {
    setGuardando(true); setError("");
    try {
      const cliente = await createClient({
        nombre: form.nombre.trim(),
        apellido: form.apellido.trim() || null,
        cuit: cuitLimpio || null,
        dni: form.dni || null,
        email: form.email.trim() || null,
        telefono: form.telefono.trim() || null,
        direccion: form.direccion.trim() || null,
      });
      onCreado?.(cliente);
      onClose?.();
    } catch (e) {
      setError(mensajeDeError(e, "No se pudo guardar el cliente."));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Modal open={open} onClose={guardando ? undefined : onClose} title="Cliente nuevo" width="max-w-md">
      <p className="mb-4 text-xs text-ink-500">
        Con el CUIT alcanza: el nombre y el domicilio los trae ARCA. El email y el celular
        son para mandarle la factura.
      </p>

      {error && <p className="mb-3 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}

      <div className="space-y-3">
        <div>
          <label className="label" htmlFor="cr-cuit">CUIT</label>
          <input
            id="cr-cuit" className="input" inputMode="numeric" autoFocus
            placeholder="30712345678"
            value={form.cuit}
            onChange={(e) => cambiarCuit(e.target.value)}
          />
          {cuitIncompleto && (
            <p className="mt-1 text-xs text-brick-500">Un CUIT tiene 11 números; van {cuitLimpio.length}.</p>
          )}
          {padron?.loading && (
            <p className="mt-1 flex items-center gap-1 text-xs text-ink-500">
              <Loader2 size={12} className="animate-spin" /> Consultando ARCA…
            </p>
          )}
          {padron?.error && (
            <p className="mt-1 flex items-start gap-1 text-xs text-brass-800">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {padron.error}
            </p>
          )}
          {padron?.data?.valido && !repetido && (
            <p className="mt-1 flex items-start gap-1 text-xs text-teal-600">
              <Check size={12} className="mt-0.5 shrink-0" />
              {padron.data.source === "afip"
                ? "Datos traídos del padrón de ARCA."
                : "CUIT válido, pero el padrón no respondió: revisá el nombre."}
            </p>
          )}

          {/*
            * Ya está cargado: se ofrece elegirlo en vez de duplicarlo.
            *
            * El botón es la mitad que importa. Un cartel que sólo dice "ya
            * existe" deja a la persona cerrando el modal y buscándolo a mano
            * con el cliente esperando enfrente.
            */}
          {repetido && (
            <div className="mt-2 rounded-md bg-brass-50 px-3 py-2 text-xs text-brass-800">
              <p className="flex items-start gap-1">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                <span>
                  Ya tenés un cliente con este CUIT:{" "}
                  <strong>{`${repetido.nombre || ""} ${repetido.apellido || ""}`.trim()}</strong>.
                </span>
              </p>
              <button
                type="button"
                className="btn-ghost mt-1.5 px-2 py-1 text-xs"
                onClick={() => { onCreado?.(repetido); onClose?.(); }}
              >
                Usar ese cliente
              </button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label" htmlFor="cr-nombre">Nombre *</label>
            <input
              id="cr-nombre" className="input" value={form.nombre}
              disabled={esBloqueado("nombre")}
              onChange={(e) => set("nombre", e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="cr-apellido">Apellido</label>
            <input
              id="cr-apellido" className="input" value={form.apellido}
              disabled={esBloqueado("apellido")}
              onChange={(e) => set("apellido", e.target.value)}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label" htmlFor="cr-email">Email</label>
            <input
              id="cr-email" className="input" type="email" placeholder="para la factura"
              value={form.email} onChange={(e) => set("email", e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="cr-tel">Celular</label>
            <input
              id="cr-tel" className="input" type="tel" placeholder="11 5555 5555"
              value={form.telefono} onChange={(e) => set("telefono", e.target.value)}
            />
          </div>
        </div>

        {form.direccion && (
          <div>
            <label className="label" htmlFor="cr-dir">Domicilio</label>
            <input
              id="cr-dir" className="input" value={form.direccion}
              disabled={esBloqueado("direccion")}
              onChange={(e) => set("direccion", e.target.value)}
            />
          </div>
        )}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onClose} disabled={guardando}>Cancelar</button>
        <button type="button" className="btn-accent" onClick={guardar} disabled={!puedeGuardar}>
          {guardando
            ? <><Loader2 size={15} className="animate-spin" /> Guardando…</>
            : <><UserPlus size={15} /> Guardar y usar en esta venta</>}
        </button>
      </div>
    </Modal>
  );
}
