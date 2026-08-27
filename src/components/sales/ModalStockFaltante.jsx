import { AlertTriangle, PackagePlus, Loader2 } from "lucide-react";
import Modal from "../ui/Modal";

/*
 * "Falta stock declarado": el aviso antes de cobrar.
 *
 * Aparece cuando la venta pide más unidades de las que el sistema tiene
 * cargadas en ese local. No es un error: en un local real la prenda está en la
 * percha aunque nadie haya cargado el remito todavía, y la persona que atiende
 * es la única que puede ver las dos cosas a la vez.
 *
 * Por eso el modal no decide: muestra exactamente qué falta y le pregunta.
 * Confirmar significa "la mercadería está, cargala": se da de alta la
 * diferencia y después la venta la descuenta. No confirmar no cancela nada —el
 * carrito queda como estaba— porque la salida natural es ir a contar y volver.
 *
 * El mismo componente se usa en el punto de venta, en Nueva venta y al cobrar
 * una venta fiada. Es la misma situación en las tres, y una sola pantalla es la
 * única forma de que diga lo mismo en las tres.
 */
export default function ModalStockFaltante({
  open,
  onClose,
  faltantes = [],
  puedeConfirmar = true,
  local = null,
  confirmando = false,
  onConfirmar,
  /* Qué va a pasar al confirmar. Cambia entre "cobrar" y "registrar". */
  accion = "cobrar",
}) {
  const totalAlta = faltantes.reduce((s, f) => s + (Number(f.falta) || 0), 0);
  const enOtros = faltantes.filter((f) => Number(f.enOtrosLocales) > 0);

  return (
    <Modal
      open={open}
      onClose={confirmando ? undefined : onClose}
      title="Falta stock declarado"
      width="max-w-xl"
    >
      <div className="flex items-start gap-3 rounded-md border border-brass-500/40 bg-brass-50 px-3 py-2.5">
        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-brass-700" />
        <p className="text-sm text-brass-800">
          {faltantes.length === 1
            ? "Hay un artículo con menos unidades cargadas de las que estás vendiendo"
            : `Hay ${faltantes.length} artículos con menos unidades cargadas de las que estás vendiendo`}
          {local ? <> en <strong>{local}</strong></> : null}.
        </p>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[420px] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-500">
              <th className="pb-2 font-medium">Artículo</th>
              <th className="pb-2 text-right font-medium">Cargadas</th>
              <th className="pb-2 text-right font-medium">Se venden</th>
              <th className="pb-2 text-right font-medium">Faltan</th>
            </tr>
          </thead>
          <tbody>
            {faltantes.map((f) => (
              <tr key={f.sku} className="border-b border-line last:border-0">
                <td className="py-2">
                  <p className="text-ink-900">{f.nombre || f.sku}</p>
                  <p className="mt-0.5"><span className="tag-chip">{f.sku}</span></p>
                </td>
                <td className="py-2 text-right tabular-nums text-ink-600">{f.hay}</td>
                <td className="py-2 text-right tabular-nums text-ink-900">{f.pide}</td>
                <td className="py-2 text-right tabular-nums font-semibold text-brick-500">{f.falta}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Que la mercadería esté en otra sucursal cambia la decisión: capaz no
          hay que dar nada de alta, hay que traerla. Conviene decirlo acá y no
          después de que la venta ya se hizo. */}
      {enOtros.length > 0 && (
        <p className="mt-3 text-xs text-ink-500">
          Ojo: {enOtros.length === 1
            ? <>hay <strong>{enOtros[0].enOtrosLocales}</strong> de {enOtros[0].nombre || enOtros[0].sku} en otros locales.</>
            : <>hay unidades de {enOtros.length} de estos artículos en otros locales.</>}
          {" "}Si en realidad están allá, lo que corresponde es transferirlas desde Stock.
        </p>
      )}

      {puedeConfirmar ? (
        <>
          <div className="mt-4 rounded-md border border-line bg-paper-100 px-3 py-3">
            <p className="flex items-start gap-2 text-sm text-ink-800">
              <PackagePlus size={16} className="mt-0.5 shrink-0 text-ink-600" />
              <span>
                Si confirmás, se dan de alta <strong>{totalAlta} unidad{totalAlta === 1 ? "" : "es"}</strong>{" "}
                y enseguida se descuentan con la venta. Queda registrado en Movimientos de stock a tu nombre.
              </span>
            </p>
            <p className="mt-2 text-xs text-ink-500">
              Confirmá sólo si la mercadería está y todavía no se cargó. Si no está, cancelá: el carrito queda como está.
            </p>
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={onClose} disabled={confirmando}>
              Cancelar
            </button>
            <button type="button" className="btn-accent" onClick={onConfirmar} disabled={confirmando}>
              {confirmando
                ? <><Loader2 size={15} className="animate-spin" /> Registrando…</>
                : <>Confirmar y {accion}</>}
            </button>
          </div>
        </>
      ) : (
        <>
          {/*
            * El negocio pidió que no se venda lo que no está cargado.
            *
            * Se dice quién lo decidió y dónde se cambia: sin eso, la cajera lee
            * "no se puede" y no tiene forma de saber si es una falla del
            * sistema o una regla de la casa.
            */}
          <div className="mt-4 rounded-md border border-line bg-paper-100 px-3 py-3">
            <p className="text-sm text-ink-800">
              Este negocio está configurado para <strong>no vender sin stock cargado</strong>, así que
              esta venta no se puede completar desde acá.
            </p>
            <p className="mt-2 text-xs text-ink-500">
              Cargá las unidades desde Stock —o transferilas si están en otro local— y volvé a cobrar.
              El dueño puede cambiar esta regla en la configuración del negocio.
            </p>
          </div>
          <div className="mt-5 flex justify-end">
            <button type="button" className="btn-primary" onClick={onClose}>Entendido</button>
          </div>
        </>
      )}
    </Modal>
  );
}
