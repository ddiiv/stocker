import { PERMISSION_MODULES } from "../../data/seedTeam";

const LEVELS = [
  { value: "ninguno", label: "Sin acceso" },
  { value: "ver", label: "Solo ver" },
  { value: "editar", label: "Ver y editar" },
];

export default function PermissionsMatrix({ permisos, onChange }) {
  return (
    <div className="overflow-x-auto rounded-md border border-line">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line bg-paper-100 text-left text-xs uppercase tracking-wide text-ink-600">
            <th className="px-3 py-2 font-medium">Módulo</th>
            {LEVELS.map((l) => (
              <th key={l.value} className="px-3 py-2 text-center font-medium">
                {l.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {PERMISSION_MODULES.map((m) => (
            <tr key={m.key} className="border-b border-line last:border-0">
              <td className="px-3 py-2.5 text-ink-900">{m.label}</td>
              {LEVELS.map((l) => (
                <td key={l.value} className="px-3 py-2.5 text-center">
                  <input
                    type="radio"
                    name={`perm-${m.key}`}
                    checked={permisos[m.key] === l.value}
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
  );
}
