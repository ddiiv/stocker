// El dígito verificador de un EAN-13, a partir de sus primeros 12 dígitos (mismo cálculo que el backend).
export function digitoEan(doce) {
  const suma = [...String(doce)].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return String((10 - (suma % 10)) % 10);
}

// El EAN-13 interno de una variante, a partir de su id (mismo cálculo que el backend, `ean13Interno`).
export function ean13Interno(id) {
  const doce = `20${String(id).padStart(10, "0")}`;
  return doce + digitoEan(doce);
}
