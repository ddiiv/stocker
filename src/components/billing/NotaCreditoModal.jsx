import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Undo2 } from "lucide-react";
import Modal from "../ui/Modal";
import { emitirNotaDeCredito, fetchSaldoDeNotas } from "../../services/invoiceService";
import { formatCurrency } from "../../utils/formatters";
import { mensajeDeError } from "../../utils/errores";

/*
 * Emitir una nota de crédito contra una factura.
 *
 * Una factura con CAE no se borra ni se corrige: existe en AFIP y va a seguir
 * existiendo. La nota es OTRO comprobante, con su propio CAE, que la compensa.
 * Por eso el modal lo dice en lugar de preguntar "¿anular?": lo que se está
 * por hacer no es deshacer, es emitir.
 *
 * ── Por qué se muestra lo que queda ──────────────────────────────
 *
 * Una factura puede tener varias notas parciales. AFIP no controla que no se
 * pasen del total —dos notas por el total salen las dos bien y quedan las dos
 * autorizadas—, así que el tope lo controla el servidor; acá se muestra para
 * que no se llegue al rechazo por sorpresa.
 */
export default function NotaCreditoModal({ open, factura, onClose, onEmitida }) {
  const [saldo, setSaldo] = useState(null);
  const [motivo, setMotivo] = useState("");
  const [parcial, setParcial] = useState(false);
  const [importe, setImporte] = useState("");
  const [emitiendo, setEmitiendo] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || !factura) return;
    setSaldo(null); setMotivo(""); setParcial(false); setImporte(""); setError("");
    fetchSaldoDeNotas(factura.id)
      .then(setSaldo)
      .catch((e) => setError(mensajeDeError(e, "No se pudo ver cuánto queda por acreditar.")));
  }, [open, factura]);

  const disponible = Number(saldo?.disponible ?? 0);
  const montoPedido = parcial ? Number(importe) : disponible;
  const seVaDeRango = parcial && (!Number.isFinite(montoPedido) || montoPedido <= 0 || montoPedido - disponible > 0.01);

  async function emitir() {
    setEmitiendo(true); setError("");
    try {
      const nota = await emitirNotaDeCredito(factura.id, {
        motivo,
        total: parcial ? montoPedido : null,
      });
      onEmitida?.(nota);
      onClose?.();
    } catch (e) {
      setError(mensajeDeError(e, "No se pudo emitir la nota de crédito."));
    } finally { setEmitiendo(false); }
  }

  if (!factura) return null;

  return (
    <Modal open={open} onClose={emitiendo ? undefined : onClose} title="Emitir nota de crédito" width="max-w-lg">
      <div className="space-y-4 px-5 py-4">
        <div className="rounded-md border border-line bg-paper-100 px-3 py-2 text-sm">
          <p className="text-ink-900">
            Factura <span className="font-mono">{factura.numero}</span> · {factura.clienteNombre}
          </p>
          <p className="text-ink-600">
            {formatCurrency(factura.total)}
            {factura.cae && <> · CAE <span className="font-mono text-xs">{factura.cae}</span></>}
          </p>
        </div>

        {/*
          * Lo que se está por hacer, dicho sin vueltas: la factura no
          * desaparece. Es la diferencia entre "anular" —que es lo que la gente
          * espera de un botón así— y lo que realmente pasa.
          */}
        <p className="flex items-start gap-2 text-sm text-ink-700">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-brass-600" />
          <span>
            La factura sigue existiendo en ARCA y no se puede borrar. Lo que se emite es un
            comprobante nuevo, con su propio CAE, que la compensa.
          </span>
        </p>

        {saldo && saldo.acreditado > 0 && (
          <div className="rounded-md border border-brass-500 bg-brass-50 px-3 py-2 text-sm text-ink-900">
            Esta factura ya tiene notas por {formatCurrency(saldo.acreditado)} de {formatCurrency(saldo.total)}.
            Queda <strong>{formatCurrency(disponible)}</strong>.
          </div>
        )}

        <label className="block">
          <span className="label">Motivo</span>
          <textarea
            className="input min-h-16 w-full"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="Devolución de mercadería, error en el importe, cliente equivocado…"
          />
          <span className="mt-1 block text-xs text-ink-500">
            Queda impreso en el comprobante: es lo que le explica la devolución al cliente.
          </span>
        </label>

        <div>
          <label className="flex items-center gap-2 text-sm text-ink-800">
            <input type="checkbox" checked={parcial} onChange={(e) => setParcial(e.target.checked)} />
            Acreditar sólo una parte
          </label>
          {parcial ? (
            <div className="mt-2">
              <input
                type="number" min="0" step="0.01"
                className="input w-44"
                value={importe}
                onChange={(e) => setImporte(e.target.value)}
                placeholder={String(disponible)}
              />
              <span className="ml-2 text-xs text-ink-500">como máximo {formatCurrency(disponible)}</span>
            </div>
          ) : (
            <p className="mt-1 text-xs text-ink-500">
              Se acredita todo lo que queda: {saldo ? formatCurrency(disponible) : "…"}.
            </p>
          )}
        </div>

        {error && (
          <div className="rounded-md border border-brick-500 bg-brick-50 px-3 py-2 text-sm text-brick-700">{error}</div>
        )}

        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <button className="btn-ghost" onClick={onClose} disabled={emitiendo}>Cancelar</button>
          <button
            className="btn-accent"
            disabled={emitiendo || !motivo.trim() || !saldo || disponible <= 0 || seVaDeRango}
            onClick={emitir}
          >
            {emitiendo ? <Loader2 size={15} className="animate-spin" /> : <Undo2 size={15} />}
            Emitir por {saldo ? formatCurrency(parcial ? (Number(importe) || 0) : disponible) : "…"}
          </button>
        </div>
        {seVaDeRango && (
          <p className="text-right text-xs text-brick-700">
            El importe tiene que ser mayor a cero y no pasar de {formatCurrency(disponible)}.
          </p>
        )}
      </div>
    </Modal>
  );
}
