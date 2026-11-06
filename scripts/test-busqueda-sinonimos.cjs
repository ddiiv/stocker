/*
 * La búsqueda del asistente con las palabras de la gente: sinónimos de género y
 * de tipo de prenda, y plurales en -es. Sin base ni servidor: compara texto.
 *
 * Uso:  node scripts/test-busqueda-sinonimos.cjs
 */
const { __coincide: coincide } = require('../src/services/asistenteService');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};

// Como textoProducto en buscarProductos: título, categoría, género y SKU.
const cairo = 'Cairo Remera Cuello Redondo Hombre Remeras Hombre ISUCAIREM';
const loan = 'Loan Pantalon Recto Pantalones Hombre ISULOAPAN';
const cruze = 'Cruze Crop Top Espalda Cruzada Top Mujer ISUCRUREM';
const montero = 'Montero Campera Camperas Unisex ISUMONCAM';
const box = 'Box Pantalon Niño Pantalones Niños ISUBOXPAN';
const flex = 'Flex Bermuda Rustica Con Bolsillo Bermudas Hombre ISUFLEB';

chk('remeras de caballero → remera de hombre', true, coincide('remeras de caballero', cairo));
chk('remería hombre → remera', true, coincide('remeria hombre', cairo));
chk('pantalones (plural en -es) → pantalón', true, coincide('pantalones', loan));
chk('mujeres → Mujer', true, coincide('tops para mujeres', cruze));
chk('top de dama → Top de Mujer', true, coincide('tops de dama', cruze));
chk('musculosa no es top', false, coincide('musculosa', cruze));
chk('campera de hombre → lo Unisex también', true, coincide('campera hombre', montero));
chk('campera de mujer → lo Unisex también', true, coincide('camperas de mujer', montero));
chk('pantalón para nena → Niños', true, coincide('pantalon para nena', box));
chk('bermuda de caballero → Bermudas de Hombre', true, coincide('bermudas caballero', flex));
chk('short no es bermuda', false, coincide('short', flex));
chk('remera no es musculosa ni top', false, coincide('remera', cruze));
chk('buzo / hoodie → Campera no (no es lo mismo)', false, coincide('hoodie', montero));
chk('remeras de dama no trae la de hombre', false, coincide('remeras dama', cairo));
chk('unisex no trae lo que es sólo de hombre', false, coincide('unisex', cairo));
chk('chupín no es sinónimo de pantalón', false, coincide('chupin', loan));
chk('una palabra que no está no inventa', false, coincide('heladera', cairo));
// Lo que encontraron el revisor y el evaluador.
chk('hombre no encuentra "Malena" (sinónimo por palabra entera)', false, coincide('hombre', 'Malena Vestido Vestidos Mujer'));
chk('legging no encuentra "Calzado"', false, coincide('legging', 'Zapatilla Calzado Unisex'));
chk('dama no encuentra el color "Damasco"', false, coincide('mujer', 'Remera Lisa Remeras Hombre Damasco'));
chk('hombres (plural) también trae lo Unisex', true, coincide('camperas hombres', montero));
chk('nenes → Niños', true, coincide('pantalones para nenes', box));
chk('chicos → Niños', true, coincide('remeras para chicos', 'Kids Remera Termica Niño Remeras Niños'));
chk('bebes sigue encontrando "Bebés"', true, coincide('bebe', 'Body Manga Larga Bebés'));
chk('verde sigue encontrando "Verdes"', true, coincide('verde', 'Remera Verdes'));
chk('pares no encuentra "Parka"', false, coincide('pares', 'Parka Nieve Camperas Mujer'));
chk('playera no es remera', false, coincide('remera', 'Ojota Playera Calzado Unisex'));
chk('canguro no es buzo', false, coincide('buzo', 'Riñonera Canguro Accesorios Unisex'));

console.log(`\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m\n`);
process.exit(ko ? 1 : 0);
