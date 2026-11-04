/*
 * El rechazo por cantidad de filas ocurre ANTES de cargar el libro entero.
 *
 * `npm start` arranca con tope de heap (512 MB). Un .xlsx de 7 MB con 120.000
 * filas, que entra en el límite de subida de 10 MB, no tiene que tirar abajo el
 * proceso: tiene que dar el 413 sin cargarse. No necesita base ni servidor.
 *
 * Uso:  node --max-old-space-size=512 scripts/test-import-memoria.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { MAX_FILAS, rechazarSiDesborda } = require('../src/services/productExcelService');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}  (esperado ${a}, obtuve ${b})`); ko++; }
};

// Armado en streaming (si no, armar el archivo ya gasta lo que se quiere probar).
async function planilla(filas) {
  const archivo = path.join(os.tmpdir(), `test-import-memoria-${process.pid}-${filas}.xlsx`);
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: archivo });
  const ws = wb.addWorksheet('Productos');
  ws.addRow(['SKU Padre', 'Título', 'Precio Minorista', 'SKU Variante']).commit();
  for (let i = 0; i < filas; i++) ws.addRow([`P-${i}`, `Producto ${i}`, 100 + i, `P-${i}-U`]).commit();
  await ws.commit(); await wb.commit();
  const buffer = fs.readFileSync(archivo);
  fs.unlinkSync(archivo);
  return buffer;
}

const rechazo = async (buffer) => {
  try { await rechazarSiDesborda(buffer); return null; } catch (e) { return e; }
};

(async () => {
  const grande = await planilla(120000);
  const antes = process.memoryUsage().heapUsed;
  const e = await rechazo(grande);
  const usadoMB = Math.round((process.memoryUsage().heapUsed - antes) / 1e6);
  chk('120.000 filas: se rechaza con 413', 413, e?.status);
  chk('con el código que lee la pantalla', 'ARCHIVO_MUY_GRANDE', e?.detalles?.codigo);
  chk('y diciendo el máximo', MAX_FILAS, e?.detalles?.maximo);
  chk('sin cargar el libro (menos de 100 MB de heap)', true, usadoMB < 100);

  chk('un archivo con el tope justo pasa', null, (await rechazo(await planilla(MAX_FILAS)))?.status ?? null);
  chk('y uno al doble del tope también (el conteo fino viene después)', null,
    (await rechazo(await planilla(MAX_FILAS * 2 - 1)))?.status ?? null);
  chk('lo que no es un xlsx no lo decide esta red: sigue al load', null, (await rechazo(Buffer.from('no soy un xlsx')))?.status ?? null);

  console.log(`\n\x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
