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
  'ML_BARRIDO', 'JUMPSELLER_BARRIDO', 'ARCA_DELEGACIONES',
  'JUMPSELLER_PEDIDOS', 'COLA_RESCATE', 'PAGO_VENCIMIENTO',
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
  for (const quien of ['JUMPSELLER_PEDIDOS', 'COLA_RESCATE', 'PAGO_VENCIMIENTO']) {
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

  tit('2. LAS VENTAS DE JUMPSELLER ENTRAN SOLAS');
  /*
   * Lo que esto cuida: `importarPedidos` existía desde siempre, pero el único
   * que la llamaba era el botón de la pantalla. Una venta de Jumpseller no
   * apartaba stock hasta que alguien se acordaba de apretarlo, y mientras tanto
   * la prenda se seguía ofreciendo en el mostrador y en Mercado Libre.
   */
  const jumpseller = require('../src/services/jumpsellerService');
  const { JumpsellerAccount } = require('../src/models');

  const importarReal = jumpseller.importarPedidos;
  const findAllReal = JumpsellerAccount.findAll;
  const llamadas = [];
  jumpseller.importarPedidos = async (businessId, opciones) => {
    llamadas.push({ businessId, ...opciones });
    return { importados: 2, repetidos: 5, sinStock: 1, conAvisos: 0, encontrados: 7, errores: [] };
  };
  JumpsellerAccount.findAll = async () => [{ businessId: 7 }, { businessId: 9 }];

  try {
    const r = await tareas.barrerPedidosJumpseller();
    chk('le pregunta a cada tienda conectada', [7, 9], llamadas.map((l) => l.businessId));
    chk('y suma lo que entró', [2, 2 * 2], [r.cuentas, r.importados]);
    /*
     * La ventana corta es a propósito: el barrido corre cada quince minutos, así
     * que dos días cubren de sobra una tienda que estuvo caída un rato sin
     * recorrer un año de órdenes en cada vuelta.
     */
    chk('con una ventana corta, no un año entero', true,
      llamadas.every((l) => l.dias > 0 && l.dias <= 7));
    chk('y con un tope', true, llamadas.every((l) => Number(l.tope) > 0));

    /* Una tienda que falla no puede dejar sin importar a la otra. */
    llamadas.length = 0;
    let vuelta = 0;
    jumpseller.importarPedidos = async (businessId) => {
      vuelta += 1;
      if (vuelta === 1) throw new Error('la clave de Jumpseller venció');
      llamadas.push({ businessId });
      return { importados: 1, sinStock: 0 };
    };
    const conFalla = await tareas.barrerPedidosJumpseller();
    chk('si una tienda falla, la otra se importa igual', [1, 1],
      [conFalla.fallaron, conFalla.importados]);
  } finally {
    jumpseller.importarPedidos = importarReal;
    JumpsellerAccount.findAll = findAllReal;
    prender(...INTERRUPTORES);
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  const db = require('../src/config/database');
  await db.close();
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
