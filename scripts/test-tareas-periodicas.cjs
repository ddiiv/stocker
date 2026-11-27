/*
 * El reloj: que arranque cuando tiene que arrancar, y que llame a todo.
 *
 * De este reloj cuelgan seis tareas y cada una tiene su propio interruptor, pero
 * el reloj es uno solo. La forma de romperlo es silenciosa: la decisión de
 * arrancarlo miraba nada más los tres barridos originales, así que apagar el
 * barrido de stock también apagaba —sin decir nada— la importación de ventas de
 * Jumpseller, el rescate de los pedidos que quedaron sin procesar y la liberación
 * de la mercadería de los pagos vencidos. Tres cosas que tocan stock y que nadie
 * relacionaría con haber apagado un barrido de stock.
 *
 * No llama a ninguna tienda ni a AFIP: reemplaza los servicios por espías.
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

/* El arranque imprime: se silencia para que la salida de la prueba se lea. */
const callado = (fn) => {
  const real = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = real; }
};

const INTERRUPTORES = [
  'ML_BARRIDO', 'ARCA_DELEGACIONES',
  'COLA_RESCATE', 'PAGO_VENCIMIENTO',
  // Las bajadas de plan que llegaron a su fecha y los débitos a reintentar.
  'PLANES_BARRIDO',
];
const prender = (...cuales) => {
  for (const k of INTERRUPTORES) process.env[k] = cuales.includes(k) ? 'on' : 'off';
};

(async () => {
  const tareas = require('../src/services/tareasPeriodicasService');

  tit('1. CUÁNDO ARRANCA EL RELOJ');
  /*
   * El caso que estaba roto: todo lo viejo apagado, pero las tareas nuevas
   * prendidas. El reloj TIENE que arrancar igual.
   */
  for (const quien of ['COLA_RESCATE', 'PAGO_VENCIMIENTO', 'PLANES_BARRIDO']) {
    prender(quien);
    const arrancó = callado(() => tareas.arrancar());
    tareas.parar();
    chk(`arranca con sólo ${quien} prendido`, true, arrancó);
  }

  prender('ARCA_DELEGACIONES');
  const soloArca = callado(() => tareas.arrancar());
  tareas.parar();
  chk('arranca para las delegaciones aunque no haya ninguna tienda', true, soloArca);

  prender();
  const nada = callado(() => tareas.arrancar());
  tareas.parar();
  chk('y NO arranca si está todo apagado', false, nada);

console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  const db = require('../src/config/database');
  await db.close();
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
