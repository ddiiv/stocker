import { AlertCircle, Wallet } from "lucide-react";
import { formatCurrency } from "../../utils/formatters";

/*
 * Estado de la cuenta corriente del cliente al momento de fiarle.
 *
 * El backend rechaza la venta si el cliente no tiene cuenta habilitada o si se
 * pasa del límite. Mostrarlo acá no es duplicar la validación: es que el
 * vendedor lo sepa antes de cargar el carrito entero y no después, con el
 * cliente esperando en el mostrador.
 */
export default function AvisoCredito({ cliente, monto = 0 }) {
  if (!cliente) {
    return (
      <Aviso tono="error">
        Elegí un cliente registrado: no se puede fiar a consumidor final.
      </Aviso>
    );
  }

  if (!cliente.cuentaHabilitada) {
    return (
      <Aviso tono="error">
        {cliente.nombre} no tiene cuenta corriente habilitada. Se habilita desde{" "}
        Clientes → Cuentas corrientes.
      </Aviso>
    );
  }

  const debe       = Number(cliente.saldoCuenta || 0);
  const disponible = Number(cliente.limiteCredito || 0) - debe;
  const excede     = Number(monto) > disponible;

  return (
    <Aviso tono={excede ? "error" : "neutro"}>
      {excede
        ? `Esta venta se pasa del crédito disponible (${formatCurrency(disponible)}).`
        : `Crédito disponible ${formatCurrency(disponible)}${debe > 0 ? ` · ya debe ${formatCurrency(debe)}` : ""}.`}
    </Aviso>
  );
}

function Aviso({ tono, children }) {
  const Icono = tono === "error" ? AlertCircle : Wallet;
  return (
    <p className={`flex items-start gap-1.5 rounded-md px-3 py-2 text-xs ${
      tono === "error" ? "bg-brick-50 text-brick-700" : "bg-paper-100 text-ink-700"
    }`}>
      <Icono size={14} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** Si con este cliente y este importe la venta fiada va a ser aceptada. */
export function puedeFiar(cliente, monto) {
  if (!cliente?.cuentaHabilitada) return false;
  const disponible = Number(cliente.limiteCredito || 0) - Number(cliente.saldoCuenta || 0);
  return Number(monto) <= disponible;
}
