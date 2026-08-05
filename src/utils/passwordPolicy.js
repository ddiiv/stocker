// Espejo de las reglas del backend (backend/src/utils/passwordPolicy.js).
// Mantener sincronizado.

export const PASSWORD_RULES = [
  { key: "length", label: "8 caracteres o más",  test: (p) => p.length >= 8 },
  { key: "upper",  label: "1 mayúscula",         test: (p) => /[A-ZÁÉÍÓÚÑ]/.test(p) },
  { key: "digits", label: "2 números",           test: (p) => (p.match(/\d/g) || []).length >= 2 },
  { key: "symbol", label: "1 símbolo especial",  test: (p) => /[^A-Za-z0-9ÁÉÍÓÚÑáéíóúñ]/.test(p) },
];

export function evaluatePassword(password) {
  const passed = [];
  const failed = [];
  for (const r of PASSWORD_RULES) {
    (r.test(String(password || "")) ? passed : failed).push(r);
  }
  return { valid: failed.length === 0, passed, failed };
}
