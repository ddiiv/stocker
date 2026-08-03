import { useEffect, useMemo, useState } from "react";

// Lista corta con los países que más usás. Ordenados por relevancia regional.
// `dial` es el código sin "+", `flag` es el emoji.
const COUNTRIES = [
  { code: "AR", dial: "54",  name: "Argentina",     flag: "🇦🇷" },
  { code: "UY", dial: "598", name: "Uruguay",       flag: "🇺🇾" },
  { code: "CL", dial: "56",  name: "Chile",         flag: "🇨🇱" },
  { code: "BR", dial: "55",  name: "Brasil",        flag: "🇧🇷" },
  { code: "PY", dial: "595", name: "Paraguay",      flag: "🇵🇾" },
  { code: "BO", dial: "591", name: "Bolivia",       flag: "🇧🇴" },
  { code: "PE", dial: "51",  name: "Perú",          flag: "🇵🇪" },
  { code: "CO", dial: "57",  name: "Colombia",      flag: "🇨🇴" },
  { code: "MX", dial: "52",  name: "México",        flag: "🇲🇽" },
  { code: "ES", dial: "34",  name: "España",        flag: "🇪🇸" },
  { code: "US", dial: "1",   name: "Estados Unidos",flag: "🇺🇸" },
  { code: "IT", dial: "39",  name: "Italia",        flag: "🇮🇹" },
];

// Dado un string que puede o no venir con "+dial", devuelve {dial, national}.
function splitPhone(value) {
  const s = String(value || "").trim();
  if (!s) return { dial: "54", national: "" };
  const withPlus = s.startsWith("+") ? s.slice(1) : s;
  const digits = withPlus.replace(/\D/g, "");
  // Match del código más largo que coincida al inicio (ordenados por longitud desc)
  const byLen = [...COUNTRIES].sort((a, b) => b.dial.length - a.dial.length);
  for (const c of byLen) {
    if (digits.startsWith(c.dial)) {
      return { dial: c.dial, national: digits.slice(c.dial.length) };
    }
  }
  return { dial: "54", national: digits };
}

/**
 * PhoneInput controlado que produce una única string en formato E.164 con "+" al frente
 * (ej. "+5491168515444"). El padre no necesita separar código de área y número.
 *
 * Props:
 *   - value: string (E.164 o vacío)
 *   - onChange: (nuevoValor:string) => void
 *   - name: opcional, para forms
 *   - placeholder: default "11 5551 2345"
 */
export default function PhoneInput({ value, onChange, name, placeholder = "11 5551 2345" }) {
  const initial = useMemo(() => splitPhone(value), []); // solo la primera vez
  const [dial, setDial] = useState(initial.dial);
  const [national, setNational] = useState(initial.national);

  // Si el valor externo cambia de golpe (ej. al abrir el modal con otro cliente), reflejarlo.
  useEffect(() => {
    const parsed = splitPhone(value);
    if (parsed.dial !== dial || parsed.national !== national) {
      setDial(parsed.dial);
      setNational(parsed.national);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function emit(nextDial, nextNational) {
    const digits = String(nextNational || "").replace(/\D/g, "");
    onChange?.(digits ? `+${nextDial}${digits}` : "");
  }

  return (
    <div className="flex gap-2">
      <select
        className="input w-40 shrink-0"
        value={dial}
        onChange={(e) => { const d = e.target.value; setDial(d); emit(d, national); }}
        aria-label="Código de país"
      >
        {COUNTRIES.map((c) => (
          <option key={c.code} value={c.dial}>{c.flag} +{c.dial} · {c.name}</option>
        ))}
      </select>
      <input
        className="input flex-1"
        type="tel"
        name={name}
        placeholder={placeholder}
        value={national}
        onChange={(e) => { const n = e.target.value; setNational(n); emit(dial, n); }}
      />
    </div>
  );
}
