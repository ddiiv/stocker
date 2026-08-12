import { ScanLine } from "lucide-react";

/*
 * Estado del lector de código de barras.
 *
 * No hay nada que activar: la pantalla escucha siempre. Este cartel existe para
 * que el operador sepa en qué estado está sin tener que probar — antes de la
 * primera lectura dice que está esperando, y en cuanto reconoce una lectura
 * pasa a confirmar que el lector funciona.
 */
export default function ScannerStatus({ activo, lecturas, children }) {
  return (
    <div
      className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
        activo ? "bg-teal-50 text-teal-700" : "bg-paper-200 text-ink-600"
      }`}
    >
      <ScanLine size={16} className={activo ? "animate-pulse" : ""} />
      <span className="font-medium">
        {activo ? "Lector detectado" : "Listo — gatillá el lector"}
      </span>
      {lecturas > 0 && (
        <span className="ml-auto text-xs tabular-nums opacity-80">
          {lecturas} {lecturas === 1 ? "lectura" : "lecturas"}
        </span>
      )}
      {children}
    </div>
  );
}
