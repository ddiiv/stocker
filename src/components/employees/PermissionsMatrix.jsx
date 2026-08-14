import { ShieldCheck } from "lucide-react";
import { PERM_MODULES, NIVELES } from "../../utils/permissions";

/*
 * Matriz de permisos de un cargo.
 *
 * Los módulos salen de utils/permissions.js, que refleja el catálogo del
 * backend. Antes la lista estaba escrita a mano en dos componentes distintos,
 * y así fue como `cotizaciones` terminó apareciendo acá sin que ninguna ruta
 * la exigiera.
 *
 * El acceso total del dueño no figura: no es un permiso que se conceda, es la
 * condición de ser dueño de la cuenta. Por eso no se puede dar ni quitar.
 */
export default function PermissionsMatrix({ permisos, onChange }) {
  return (
    <div>
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-paper-100 text-left text-xs uppercase tracking-wide text-ink-600">
              <th className="px-3 py-2 font-medium">Sección</th>
              {NIVELES.map((l) => (
                <th key={l.value} className="px-3 py-2 text-center font-medium" title={l.ayuda}>
                  {l.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERM_MODULES.map((m) => (
              <tr key={m.key} className="border-b border-line last:border-0 align-top">
                <td className="px-3 py-2.5">
                  <p className="text-ink-900">{m.label}</p>
                  <p className="mt-0.5 text-xs leading-snug text-ink-500">{m.descripcion}</p>
                </td>
                {NIVELES.map((l) => (
                  <td key={l.value} className="px-3 py-2.5 text-center">
                    <input
                      type="radio"
                      name={`perm-${m.key}`}
                      checked={(permisos?.[m.key] || "ninguno") === l.value}
                      onChange={() => onChange(m.key, l.value)}
                      className="h-3.5 w-3.5 accent-brass-500"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-2 flex items-start gap-1.5 text-xs text-ink-500">
        <ShieldCheck size={13} className="mt-0.5 shrink-0" />
        El acceso total lo tiene sólo el dueño de la cuenta y no se puede asignar
        a un cargo.
      </p>
    </div>
  );
}
