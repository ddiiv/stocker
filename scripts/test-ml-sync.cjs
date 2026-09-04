/*
 * La sincronización con un catálogo grande.
 *
 * Con 204 publicaciones apareció un MaxListenersExceededWarning en producción.
 * Es un aviso, no un error —la sincronización termina igual— pero señala lo que
 * de verdad estaba mal: doscientas peticiones en serie adentro de una sola
 * request HTTP, con el usuario esperando y sin timeout.
 *
 * Lo que se comprueba acá:
 *
 *   · Lo que ya coincide no se manda. Es el ahorro más grande: en una
 *     sincronización de rutina casi nada cambió.
 *   · Se puede sincronizar SOLO lo elegido, que es lo que hace que un catálogo
 *     grande deje de ser un problema.
 *   · Las peticiones salen de a varias y acotadas, nunca doscientas juntas.
 *   · Un error en una publicación no voltea a las demás.
 *
 * Se prueba contra una API simulada: pegarle a ML de verdad haría que la suite
 * dependa del catálogo del día y del límite de peticiones.
 *
 * Uso:  node scripts/test-ml-sync.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const Module = require('module');

const LLAMADAS = [];
let concurrentes = 0, picoConcurrencia = 0;
let publicaciones = [];
let fallar = new Set();

const originalLoad = Module._load;
Module._load = function (pedido) {
  if (pedido === 'axios') {
    /*
     * axios manda los parámetros en la config, no pegados a la URL: leerlos del
     * texto de la URL era mirar donde no están, y todas las respuestas salían
     * vacías sin que se notara.
     */
    const responder = async (metodo, url, cfg) => {
      LLAMADAS.push({ url, metodo });
      concurrentes += 1;
      picoConcurrencia = Math.max(picoConcurrencia, concurrentes);
      // Un poco de latencia: sin ella todo se resuelve en el mismo tick y la
      // concurrencia medida sería siempre 1, que no probaría nada.
      await new Promise((r) => setTimeout(r, 8));
      concurrentes -= 1;

      const params = cfg?.params || {};

      if (url.includes('/items/search')) {
        const off = Number(params.offset) || 0;
        return { data: { results: publicaciones.slice(off, off + 50).map((p) => p.id),
          paging: { total: publicaciones.length } } };
      }
      if (/\/items$/.test(url) && params.ids) {
        const ids = String(params.ids).split(',');
        return { data: ids.map((id) => ({ code: 200, body: publicaciones.find((p) => p.id === id) })) };
      }
      const item = (url.match(/\/items\/([^/?]+)/) || [])[1];
      if (item && fallar.has(item)) {
        const e = new Error('límite de peticiones');
        e.response = { status: 429, data: { message: 'too many requests' } };
        throw e;
      }
      return { data: {} };
    };
    const cliente = {
      get:  (url, cfg) => responder('get', url, cfg),
      put:  (url, cuerpo, cfg) => responder('put', url, cfg),
      post: (url, cuerpo, cfg) => responder('post', url, cfg),
      create: () => cliente,
    };
    return cliente;
  }
  return originalLoad.apply(this, arguments);
};

const { Op } = require('sequelize');
const {
  Business, BusinessLocation, Product, ProductVariant, VariantStock, StockMovement,
  MercadoLibreAccount, MercadoLibreLink,
} = require('../src/models');
const stock = require('../src/services/stockService');
const ml = require('../src/services/mercadolibreService');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const ML_USER = '888000222';
const CUANTAS = 204;   // el número exacto que disparó el aviso

(async () => {
  ml.tokenValido = async () => 'TOKEN-QA';

  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  const local = await BusinessLocation.findOne({
    where: { businessId: negocio.id, tipo: 'local', abasteceOnline: true, activo: true },
  });

  await MercadoLibreAccount.destroy({ where: { mlUserId: ML_USER } });
  await ProductVariant.destroy({ where: { sku: { [Op.like]: 'QA-SYNC-%' } } });
  await Product.destroy({ where: { sku: 'QA-SYNC' } });

  const prod = await Product.create({
    businessId: negocio.id, sku: 'QA-SYNC', skuAgrupador: 'QA-SYNC', titulo: 'QA Sync',
    precioMinorista: 100, precioMayorista: 100, costo: 40, activo: true,
  });

  /*
   * 204 variantes con stock, y 204 publicaciones que las espejan. La mitad ya
   * coincide: es el caso real de una sincronización de rutina, donde casi nada
   * cambió.
   */
  const variantes = [];
  for (let i = 0; i < CUANTAS; i++) {
    const v = await ProductVariant.create({
      productId: prod.id, businessId: negocio.id, sku: `QA-SYNC-${i}`,
      variante1Nombre: 'N', variante1Valor: String(i), stock: 0, stockMinimo: 0,
    });
    await stock.mover({ variantId: v.id, businessId: negocio.id, locationId: local.id,
      delta: 10, tipo: 'ingreso', motivo: 'QA sync' });
    variantes.push(v);
  }
  publicaciones = variantes.map((v, i) => ({
    id: `MLA${1000 + i}`, title: `Pub ${i}`, seller_custom_field: v.sku,
    // La mitad ya está en 10; la otra mitad en 0 y hay que actualizarla.
    available_quantity: i % 2 === 0 ? 10 : 0,
    status: 'active', variations: [], attributes: [],
  }));

  await MercadoLibreAccount.create({
    businessId: negocio.id, mlUserId: ML_USER, nickname: 'QA_SYNC',
    accessToken: 'T', refreshToken: 'R', tokenExpiraEn: new Date(Date.now() + 5 * 3600e3),
  });

  const puts = () => LLAMADAS.filter((l) => l.metodo === 'put').length;
  const reset = () => { LLAMADAS.length = 0; picoConcurrencia = 0; concurrentes = 0; };

  try {
    tit('1. LO QUE YA COINCIDE NO SE MANDA');
    /*
     * El ahorro más grande de todos. Mandar doscientas peticiones para escribir
     * el mismo número que ya estaba gasta el límite de la API en no hacer nada.
     */
    reset();
    const r1 = await ml.sincronizarStock(negocio.id, { simular: false });
    chk('la mitad quedó sin cambios', CUANTAS / 2, r1.resumen.sinCambios);
    chk('y sólo se mandó la otra mitad', CUANTAS / 2, r1.resumen.actualizados);
    chk('una petición PUT por cada una que cambió', CUANTAS / 2, puts());

    tit('2. NADA QUE MANDAR ES CERO PETICIONES');
    // Corriendo dos veces seguidas, la segunda no tiene nada que hacer... salvo
    // que ML siga diciendo lo viejo. Se actualiza el espejo para simular que sí
    // se guardó.
    publicaciones = publicaciones.map((p) => ({ ...p, available_quantity: 10 }));
    reset();
    const r2 = await ml.sincronizarStock(negocio.id, { simular: false });
    chk('todo coincide', CUANTAS, r2.resumen.sinCambios);
    chk('y no se manda ni una', 0, puts());

    tit('3. SINCRONIZAR SOLO LO ELEGIDO');
    /*
     * Es lo que hace que un catálogo grande deje de ser un problema: casi nunca
     * hace falta barrer las doscientas.
     */
    publicaciones = publicaciones.map((p) => ({ ...p, available_quantity: 0 }));
    const tres = ['QA-SYNC-1', 'QA-SYNC-2', 'QA-SYNC-3'];
    reset();
    const r3 = await ml.sincronizarStock(negocio.id, { simular: false, skus: tres });
    chk('se actualizan las tres', 3, r3.resumen.actualizados);
    chk('y se mandan tres peticiones, no doscientas', 3, puts());
    chk('el detalle sólo trae las elegidas', 3, r3.resultados.length);

    tit('4. LAS PETICIONES SALEN DE A VARIAS Y ACOTADAS');
    /*
     * De a una son doscientas idas y vueltas en serie. Todas juntas es como se
     * llega al 429 y a que ML rechace la mitad. El techo lo pone el agente.
     */
    publicaciones = publicaciones.map((p) => ({ ...p, available_quantity: 0 }));
    reset();
    await ml.sincronizarStock(negocio.id, { simular: false });
    chk('salieron varias a la vez', true, picoConcurrencia > 1);
    chk('pero nunca doscientas juntas', true, picoConcurrencia <= 8);

    tit('5. UNA QUE FALLA NO VOLTEA A LAS DEMÁS');
    /*
     * Con un `Promise.all` sin capturar, un 429 en la publicación 30 abortaba
     * las 174 restantes y dejaba media sincronización hecha sin saber cuál.
     */
    publicaciones = publicaciones.map((p) => ({ ...p, available_quantity: 0 }));
    fallar = new Set(['MLA1005', 'MLA1010']);
    reset();
    const r5 = await ml.sincronizarStock(negocio.id, { simular: false });
    chk('las dos que fallan se reportan', 2, r5.resumen.errores);
    chk('y el resto se actualiza igual', CUANTAS - 2, r5.resumen.actualizados);
    chk('el error dice qué pasó', true,
      /límite de peticiones|too many/i.test(r5.resultados.find((x) => x.estado === 'error')?.error || ''));
    fallar = new Set();

    tit('6. LA SIMULACIÓN NO ESCRIBE NADA');
    publicaciones = publicaciones.map((p) => ({ ...p, available_quantity: 0 }));
    reset();
    const r6 = await ml.sincronizarStock(negocio.id, { simular: true });
    chk('cuenta lo que haría', CUANTAS, r6.resumen.pendientes);
    chk('sin mandar ninguna', 0, puts());

    tit('7. SE PUBLICA LO DISPONIBLE, NO LO QUE HAY EN EL ESTANTE');
    /*
     * Una unidad apartada para un pedido online sigue en el estante pero no se
     * puede volver a vender: publicarla sería ofrecer dos veces la misma prenda.
     */
    await stock.reservar(variantes[0].id, local.id, negocio.id, 4);
    publicaciones = publicaciones.map((p) => ({ ...p, available_quantity: 0 }));
    reset();
    const r7 = await ml.sincronizarStock(negocio.id, { simular: true, skus: ['QA-SYNC-0'] });
    chk('con 10 en el estante y 4 apartadas, se publican 6', 6, r7.resultados[0]?.stockStocker);
    await stock.liberarReserva(variantes[0].id, local.id, negocio.id, 4);

  } finally {
    tit('Limpieza');
    const ids = variantes.map((v) => v.id);
    await MercadoLibreLink.destroy({ where: { businessId: negocio.id, sku: { [Op.like]: 'QA-SYNC-%' } } });
    await StockMovement.destroy({ where: { productVariantId: ids } });
    await VariantStock.destroy({ where: { productVariantId: ids } });
    await ProductVariant.destroy({ where: { id: ids } });
    await Product.destroy({ where: { id: prod.id } });
    await MercadoLibreAccount.destroy({ where: { mlUserId: ML_USER } });
    chk('no quedan variantes de prueba', 0,
      await ProductVariant.count({ where: { sku: { [Op.like]: 'QA-SYNC-%' } } }));
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
