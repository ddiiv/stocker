// El dígito verificador de un EAN-13, a partir de sus primeros 12 dígitos (mismo cálculo que el backend).
export function digitoEan(doce) {
  const suma = [...String(doce)].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return String((10 - (suma % 10)) % 10);
}
