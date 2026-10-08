/*
 * La leyenda de la Ley 27.743 en la factura.
 *
 * Desde 2024 hay que mostrarle al consumidor final cuánto de lo que pagó es
 * impuesto. En una factura B el precio va con el IVA adentro, así que sin esta
 * leyenda el comprador ve un número y nada más.
 *
 * Va SÓLO en la B: la A es entre responsables inscriptos y ya lleva el IVA en su
 * propio renglón, y la C la emite un monotributista, que no factura IVA — poner
 * ahí "IVA contenido: $0" sería afirmar algo falso sobre el precio.
 *
 * Se prueba contra la función con un `doc` espía: no hace falta generar el PDF ni
 * tener herramientas para leerlo, y la prueba dice qué texto se dibujó.
 */

require('dotenv').config({ path: __dirname + '/../.env' });

let ok = 0;
let ko = 0;
const chk = (t, esperado, obtenido) => {
  const igual = JSON.stringify(esperado) === JSON.stringify(obtenido);
  console.log(`  ${igual ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${t}`);
  if (!igual) console.log(`      esperaba ${JSON.stringify(esperado)} · vino ${JSON.stringify(obtenido)}`);
  igual ? (ok += 1) : (ko += 1);
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/* Un `doc` que sólo anota lo que le piden dibujar. */
function espia() {
  const textos = [];
  const doc = {
    page: { width: 595 },
    save() { return doc; }, restore() { return doc; },
    rect() { return doc; }, roundedRect() { return doc; },
    lineWidth() { return doc; }, strokeColor() { return doc; },
    stroke() { return doc; }, fill() { return doc; }, fillColor() { return doc; },
    font() { return doc; }, fontSize() { return doc; },
    text(t) { textos.push(String(t)); return doc; },
  };
  return { doc, textos };
}

(async () => {
  const { __drawTransparenciaFiscal: dibujar } = require('../src/services/pdfService');

  tit('1. EN QUÉ COMPROBANTES VA');
  for (const [tipo, deberia] of [['B', true], ['A', false], ['C', false]]) {
    const { doc, textos } = espia();
    const yFinal = dibujar(doc, 100, { tipo, iva: 15133.71 });
    const salio = textos.some((t) => /27\.743/.test(t));
    chk(`${tipo}: ${deberia ? 'lleva' : 'NO lleva'} la leyenda`, deberia, salio);
    chk(`   y ${deberia ? 'ocupa lugar' : 'no mueve nada'}`, deberia, yFinal > 100);
  }
  // Minúscula también, por si el tipo viene de la base sin normalizar.
  const { doc: d2, textos: t2 } = espia();
  dibujar(d2, 100, { tipo: 'b', iva: 100 });
  chk('acepta el tipo en minúscula', true, t2.some((t) => /27\.743/.test(t)));

  tit('2. QUÉ DICE');
  const { doc, textos } = espia();
  dibujar(doc, 100, { tipo: 'B', iva: 15133.71 });
  chk('nombra el régimen y la ley', true,
    textos.some((t) => /Transparencia Fiscal al Consumidor/.test(t) && /27\.743/.test(t)));
  chk('muestra el IVA contenido con centavos', true,
    textos.some((t) => /15\.133,71/.test(t)));
  chk('y los otros impuestos indirectos en cero', true,
    textos.some((t) => /Otros Impuestos Nacionales Indirectos/.test(t))
      && textos.some((t) => /0,00/.test(t)));

  /*
   * Sin IVA cargado el recuadro sale igual, con cero: la ley pide informarlo, y
   * un comprobante sin la leyenda es peor que uno que informa cero.
   */
  const { doc: d3, textos: t3 } = espia();
  dibujar(d3, 100, { tipo: 'B', iva: 0 });
  chk('con IVA en cero la leyenda sale igual', true, t3.some((t) => /27\.743/.test(t)));

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
