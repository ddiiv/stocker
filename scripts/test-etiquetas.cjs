/*
 * Etiquetas: que se puedan leer.
 *
 * Una etiqueta que "se ve bien" y no escanea es peor que ninguna: el empleado
 * la pega, la góndola queda cargada y el problema aparece semanas después en la
 * caja. Por eso la prueba no mira el dibujo, genera el PDF, lo rasteriza a los
 * 203 dpi de una impresora térmica y lo lee con un decodificador real.
 *
 * Uso:  node scripts/test-etiquetas.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { generarEtiquetas, __patron, __encabezadoDe } = require('../src/services/labelService');

let ok = 0, ko = 0;
const chk = (t, esperado, obtuvo) => {
  const a = JSON.stringify(esperado), b = JSON.stringify(obtuvo);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const prod = (modelo, categoria, titulo) => ({ modelo, categoria, titulo });
const vari = (sku, color, talle, codigoBarras = null) =>
  ({ sku, codigoBarras, variante1Valor: color, variante2Valor: talle });

(async () => {
  tit('1. ENCABEZADO');
  chk('modelo, categoría y color', ['BOSTON', 'Buzos', 'Crema'],
    __encabezadoDe(prod('BOSTON', 'Buzos'), vari('X', 'Crema', 'L')));
  chk('sin modelo usa el título', ['Buzo Canguro', 'Buzos', 'Crema'],
    __encabezadoDe(prod(null, 'Buzos', 'Buzo Canguro'), vari('X', 'Crema', 'L')));
  chk('sin color no deja huecos', ['BOSTON', 'Buzos'],
    __encabezadoDe(prod('BOSTON', 'Buzos'), vari('X', null, 'L')));

  tit('2. CANTIDADES');
  const contar = (items) => { const { total } = generarEtiquetas(items); return total; };
  chk('una por unidad de stock', 19, contar([
    { producto: prod('A', 'B'), variante: vari('S1', 'Rojo', 'S'), cantidad: 5 },
    { producto: prod('A', 'B'), variante: vari('S2', 'Rojo', 'M'), cantidad: 4 },
    { producto: prod('A', 'B'), variante: vari('S3', 'Rojo', 'L'), cantidad: 0 },
    { producto: prod('A', 'B'), variante: vari('S4', 'Rojo', 'XL'), cantidad: 10 },
  ]));
  const tirar = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  chk('todo en cero avisa', true,
    /cantidades están en cero/.test(tirar(() => contar([{ producto: prod('A','B'), variante: vari('S','R','M'), cantidad: 0 }])) || ''));
  chk('un lote enorme se frena', true,
    /máximo por PDF/.test(tirar(() => contar([{ producto: prod('A','B'), variante: vari('S','R','M'), cantidad: 99999 }])) || ''));
  chk('cantidades negativas no restan', 3, contar([
    { producto: prod('A','B'), variante: vari('S1','R','M'), cantidad: 3 },
    { producto: prod('A','B'), variante: vari('S2','R','L'), cantidad: -5 },
  ]));

  tit('3. QUÉ VA EN LAS BARRAS');
  chk('sin código propio, el SKU', 200, __patron('ISUBOSBUZCRE2XL').modulos);
  chk('el patrón alterna barra y espacio', true, __patron('ABC').anchos.length % 2 === 1);

  // ── Lo que decide todo: ¿se lee? ──
  tit('4. LECTURA A 203 DPI (impresora térmica)');
  let pdftoppm = true;
  try { execFileSync('which', ['pdftoppm'], { stdio: 'ignore' }); } catch { pdftoppm = false; }
  if (!pdftoppm) {
    console.log('  \x1b[33m—\x1b[0m sin pdftoppm: se omite la lectura real');
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etq-'));
    /*
     * SKU cortos y largos. El largo es el caso difícil: cuantos más caracteres,
     * más angosto el módulo, y hay un punto donde deja de leerse. Si esta
     * prueba falla con un SKU nuevo, el SKU es demasiado largo para 50 mm.
     */
    const casos = [
      vari('ISUBOSBUZCRE2XL', 'Crema', '2XL'),
      vari('BA-010-BEIGEM', 'Beige', 'M'),
      vari('AB1', 'Rojo', 'S'),
      vari('CON-EAN', 'Verde', 'L', '7791234567898'),
    ];
    const { doc } = generarEtiquetas(casos.map((v) => ({ producto: prod('MOD', 'Cat'), variante: v, cantidad: 1 })));
    const archivo = path.join(dir, 'e.pdf');
    await new Promise((res) => { const w = fs.createWriteStream(archivo); doc.pipe(w); doc.end(); w.on('finish', res); });
    execFileSync('pdftoppm', ['-r', '203', '-png', archivo, path.join(dir, 'p')]);

    const { readBarcodes } = await import('/home/ddiiv/Desktop/repo/front/stocker/node_modules/zxing-wasm/dist/es/reader/index.js');
    for (let i = 0; i < casos.length; i++) {
      const png = fs.readFileSync(path.join(dir, `p-${i + 1}.png`));
      const r = await readBarcodes(new Blob([png]), { tryHarder: true, formats: ['Code128'] });
      const esperado = casos[i].codigoBarras || casos[i].sku;
      chk(`lee "${esperado}"`, esperado, r[0]?.text || '(no leyó)');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  tit('5. CÓDIGOS QUE NO ENTRAN LEGIBLES');
  /*
   * El límite medido: 16 caracteres leen, 17 ya no. Generar igual una etiqueta
   * de 22 caracteres es fabricar un problema que aparece en la caja, no acá.
   */
  const largo = [{ producto: prod('M','C'), variante: vari('ISUHENREMBLANCOXXL2026','Blanco','XXL'), cantidad: 1 }];
  chk('un SKU de 22 frena la generación', true, /no entran legibles/.test(tirar(() => contar(largo)) || ''));
  chk('y dice cuál es', true, /ISUHENREMBLANCOXXL2026/.test(tirar(() => contar(largo)) || ''));
  chk('16 caracteres pasan', 1, contar([{ producto: prod('M','C'), variante: vari('ABCDEFGHIJKLM123','R','M'), cantidad: 1 }]));
  chk('17 no', true, /no entran legibles/.test(tirar(() => contar([{ producto: prod('M','C'), variante: vari('ABCDEFGHIJKLMN123','R','M'), cantidad: 1 }])) || ''));
  chk('un EAN de 13 dígitos entra holgado', 1,
    contar([{ producto: prod('M','C'), variante: vari('X','R','M','7791234567898'), cantidad: 1 }]));

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})();
