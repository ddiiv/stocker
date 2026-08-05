import { Check, X } from "lucide-react";
import { PASSWORD_RULES, evaluatePassword } from "../../utils/passwordPolicy";

/**
 * Muestra un checklist en vivo de las reglas de fortaleza que cumple/no cumple
 * la contraseña actual. Se usa debajo de un input de password.
 */
export default function PasswordStrength({ password, className = "" }) {
  const { passed } = evaluatePassword(password);
  const passedKeys = new Set(passed.map((p) => p.key));

  return (
    <ul className={`mt-2 grid grid-cols-1 gap-1 text-xs sm:grid-cols-2 ${className}`}>
      {PASSWORD_RULES.map((r) => {
        const ok = passedKeys.has(r.key);
        return (
          <li key={r.key} className={`flex items-center gap-1.5 ${ok ? "text-teal-600" : "text-ink-500"}`}>
            {ok ? <Check size={12} strokeWidth={3} /> : <X size={12} strokeWidth={2.5} />}
            <span>{r.label}</span>
          </li>
        );
      })}
    </ul>
  );
}
