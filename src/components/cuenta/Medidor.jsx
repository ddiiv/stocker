import { formatDate } from "../../utils/formatters";

/*
 * Uso contra el tope del plan. Sin tope no hay barra: no hay nada que llenar.
 *
 * Los comprobantes son un tope por mes, no acumulativo, y el medidor lo aclara
 * con la fecha de reinicio: ver "4.800 / 5000" sin saber que se reinicia el 1
 * suena a que la cuenta se está terminando para siempre.
 *
 * `avisarTope={false}` saca el "Llegaste al tope" cuando el tope no frena
 * nada: las sesiones del dueño no impiden entrar, cierran la de menos
 * actividad (o, en modo sombra, todavía ni eso), y decir "llegaste al tope"
 * haría pensar que el próximo ingreso va a ser rechazado. `nota` es una línea
 * de aclaración debajo de la barra.
 *
 * Vive acá y no en la pantalla de Suscripción porque lo usan dos: Suscripción
 * y Sesiones.
 */
export default function Medidor({ icono: Icono, rotulo, dato, nota, avisarTope = true }) {
  if (!dato) return null;
  const sinTope = dato.tope == null;
  const pct = sinTope ? 0 : Math.min(100, Math.round((dato.usado / Math.max(1, dato.tope)) * 100));
  const lleno = !sinTope && dato.usado >= dato.tope;
  // Rojo es "no podés seguir". Con un tope que no frena, estar justo en él
  // (3 de 3 dispositivos) es lo normal: rojo recién al pasarlo.
  const rojo = avisarTope ? lleno : !sinTope && dato.usado > dato.tope;
  // Amarillo desde el 80%: da margen para pasar de plan antes de quedarse
  // trabado en la mitad de una jornada de facturación.
  const cerca = !rojo && pct >= 80;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="flex min-w-0 items-center gap-1.5 text-ink-700"><Icono size={14} className="shrink-0" /> {rotulo}</span>
        {/* Sin cortar: en la columna angosta de Suscripción, "2 / 3" se partía en dos renglones. */}
        <span className="shrink-0 whitespace-nowrap tabular-nums text-ink-950">
          {dato.usado.toLocaleString("es-AR")}
          {sinTope ? "" : ` / ${dato.tope.toLocaleString("es-AR")}`}
        </span>
      </div>
      {sinTope ? (
        <p className="mt-1 text-xs text-ink-500">Sin límite</p>
      ) : (
        <>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-paper-200">
            <div
              className={`h-full rounded-full ${rojo ? "bg-brick-500" : cerca ? "bg-brass-400" : "bg-brass-500"}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          {dato.periodo === "mes" && (
            <p className="mt-1 text-[11px] text-ink-500">
              De este mes · vuelve a cero el {formatDate(dato.reinicia)}
            </p>
          )}
          {lleno && avisarTope && (
            <p className="mt-1 text-[11px] text-brick-500">
              Llegaste al tope del plan.
            </p>
          )}
          {nota && <p className="mt-1 text-[11px] text-ink-500">{nota}</p>}
        </>
      )}
    </div>
  );
}
