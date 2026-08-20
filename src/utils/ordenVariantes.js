/*
 * Orden de las variantes de un producto.
 *
 * Ordenar alfabéticamente los talles da "L, M, S, XL, XXL", que no es ningún
 * orden: en una góndola y en una etiqueta van de menor a mayor. Y los talles
 * numéricos ("38", "40") ordenados como texto ponen el 100 antes del 38.
 *
 * Por eso hay una tabla de talles conocidos, y lo que no está en ella cae al
 * orden natural — numérico si es un número, alfabético si no.
 */

const ESCALA = [
  'XXXS', '3XS', 'XXS', '2XS', 'XS', 'S', 'M', 'L',
  'XL', 'XXL', '2XL', 'XXXL', '3XL', 'XXXXL', '4XL',
  'ÚNICO', 'UNICO', 'U',
];

const norm = (v) => String(v ?? '').trim().toUpperCase();

/** Posición en la escala; -1 si no es un talle conocido. */
function posicionTalle(valor) {
  const t = norm(valor);
  const i = ESCALA.indexOf(t);
  if (i !== -1) return i;
  // "2XL" y "XXL" son el mismo talle escrito distinto: se buscan como sinónimos.
  const sinonimo = t.match(/^(\d)X(S|L)$/);
  if (sinonimo) {
    const [, n, letra] = sinonimo;
    return ESCALA.indexOf(letra.repeat(Number(n)) + (letra === 'S' ? 'S' : 'L').replace(/.$/, letra));
  }
  return -1;
}

/*
 * Compara dos valores de talle.
 *
 * Primero la escala de letras, después los números, y al final el texto. Un
 * talle de la escala siempre va antes que uno numérico: mezclar "M" con "42" en
 * el mismo producto es raro, pero si pasa conviene un orden estable y no uno
 * que dependa de cuál se cargó primero.
 */
export function compararTalles(a, b) {
  const pa = posicionTalle(a), pb = posicionTalle(b);
  if (pa !== -1 && pb !== -1) return pa - pb;
  if (pa !== -1) return -1;
  if (pb !== -1) return 1;

  const na = Number(String(a).replace(',', '.')), nb = Number(String(b).replace(',', '.'));
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  if (Number.isFinite(na)) return -1;
  if (Number.isFinite(nb)) return 1;

  return norm(a).localeCompare(norm(b), 'es');
}

const compararTexto = (a, b) => norm(a).localeCompare(norm(b), 'es');

/*
 * Ordena variantes. `criterio` es "talle" o "color".
 *
 * El criterio elegido manda, y el otro desempata: ordenando por color, dentro
 * de cada color los talles quedan en su escala, que es como se acomoda una
 * pila de prendas. Sin el desempate, dos variantes del mismo color aparecerían
 * en el orden en que las devolvió la base, que cambia sin motivo aparente.
 */
export function ordenarVariantes(variantes, criterio = 'talle') {
  const copia = [...variantes];
  copia.sort((x, y) => {
    const talle = compararTalles(x.variante2Valor, y.variante2Valor);
    const color = compararTexto(x.variante1Valor, y.variante1Valor);
    const primero = criterio === 'color' ? color : talle;
    const segundo = criterio === 'color' ? talle : color;
    if (primero !== 0) return primero;
    if (segundo !== 0) return segundo;
    // Último desempate: el SKU. Garantiza un orden estable entre recargas.
    return compararTexto(x.sku, y.sku);
  });
  return copia;
}

export const CRITERIOS = [
  { value: 'talle', label: 'Por talle' },
  { value: 'color', label: 'Por color' },
];
