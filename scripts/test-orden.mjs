/*
 * Orden de variantes. Chico pero fácil de arruinar: alfabéticamente los talles
 * salen "L, M, S, XL" y nadie acomoda una góndola así.
 */
import { ordenarVariantes, compararTalles } from '../src/utils/ordenVariantes.js';

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  ✓ ${t}`); ok++; }
  else { console.log(`  ✗ ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n${t}`);
const v = (color, talle, sku = `${color}-${talle}`) => ({ variante1Valor: color, variante2Valor: talle, sku });
const talles = (arr, crit = 'talle') => ordenarVariantes(arr, crit).map((x) => x.variante2Valor);
const colores = (arr, crit) => ordenarVariantes(arr, crit).map((x) => `${x.variante1Valor}/${x.variante2Valor}`);

tit('1. ESCALA DE TALLES');
chk('el orden de la góndola, no el alfabético',
  ['XS','S','M','L','XL','XXL'],
  talles([v('R','L'), v('R','XS'), v('R','XXL'), v('R','M'), v('R','S'), v('R','XL')]));
chk('2XL y XXL son el mismo talle', ['L','XXL','2XL'].length, talles([v('R','2XL'), v('R','XXL'), v('R','L')]).length);
chk('numéricos por valor, no por texto',
  ['4','6','16','38','100'],
  talles([v('R','38'), v('R','100'), v('R','4'), v('R','16'), v('R','6')]));
chk('los de escala van antes que los numéricos',
  ['M','42'], talles([v('R','42'), v('R','M')]));
chk('lo desconocido va al final, alfabético',
  ['S','Bebé','Junior'], talles([v('R','Junior'), v('R','S'), v('R','Bebé')]));

tit('2. CRITERIO');
chk('por talle: agrupa por talle y desempata por color',
  ['Azul/S','Rojo/S','Azul/M','Rojo/M'],
  colores([v('Rojo','M'), v('Azul','S'), v('Rojo','S'), v('Azul','M')], 'talle'));
chk('por color: agrupa por color y adentro respeta la escala',
  ['Azul/S','Azul/M','Rojo/S','Rojo/M'],
  colores([v('Rojo','M'), v('Azul','S'), v('Rojo','S'), v('Azul','M')], 'color'));

tit('3. ESTABILIDAD');
const mismos = [v('Rojo','M','B'), v('Rojo','M','A'), v('Rojo','M','C')];
chk('mismo color y talle: desempata el SKU', ['A','B','C'],
  ordenarVariantes(mismos, 'talle').map((x) => x.sku));
chk('no muta el arreglo original', 'B', mismos[0].sku);

tit('4. DATOS INCOMPLETOS');
chk('sin talle no explota', 2, ordenarVariantes([v('Rojo', null), v('Azul', null)], 'talle').length);
chk('sin color tampoco', 2, ordenarVariantes([v(null,'M'), v(null,'S')], 'color').length);
chk('mayúsculas y minúsculas son el mismo talle', 0, compararTalles('xl', 'XL'));
chk('espacios de más no cambian el orden', 0, compararTalles(' M ', 'M'));

console.log(`\n─────────────────────────────\n  Pasaron: ${ok}   Fallaron: ${ko}`);
process.exit(ko ? 1 : 0);
