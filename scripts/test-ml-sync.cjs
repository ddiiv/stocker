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
// Lo que simula el resto de ML: bulk, etiquetas de la cuenta, stock de user products y 409.
let bulkDisponible = true;
let etiquetasUsuario = [];
const stockUp = new Map();
const conflictos = new Map();
const relistados = [];
// Los reintentos por 409 esperan de verdad: acá, poco.
process.env.ML_ESPERA_CONFLICTO_MS = '20';

const originalLoad = Module._load;
Module._load = function (pedido) {
  if (pedido === 'axios') {
    /*
     * axios manda los parámetros en la config, no pegados a la URL: leerlos del
     * texto de la URL era mirar donde no están, y todas las respuestas salían
     * vacías sin que se notara.
     */
    const responder = async (metodo, url, cfg, cuerpo) => {
      LLAMADAS.push({ url, metodo, cuerpo, params: cfg?.params || {}, headers: cfg?.headers || {} });
      concurrentes += 1;
      picoConcurrencia = Math.max(picoConcurrencia, concurrentes);
      // Un poco de latencia: sin ella todo se resuelve en el mismo tick y la
      // concurrencia medida sería siempre 1, que no probaría nada.
      await new Promise((r) => setTimeout(r, 8));
      concurrentes -= 1;

      const params = cfg?.params || {};
      const error = (status, message) => {
        const e = new Error(message);
        e.response = { status, data: { message } };
        return e;
      };
      // Como ML: los atributos de las variaciones sólo vienen con include_attributes=all.
      const comoLoDevuelveMl = (p) => (params.include_attributes === 'all' ? p : {
        ...p, variations: (p.variations || []).map(({ attributes, ...resto }) => resto),
      });

      if (url.includes('/items/search')) {
        // Como ML: filtra por estado, y en modo scan pagina con scroll_id.
        const delEstado = publicaciones.filter((p) => !params.status || (p.status || 'active') === params.status);
        if (params.search_type === 'scan') {
          const desde = params.scroll_id ? Number(String(params.scroll_id).split(':')[1]) : 0;
          const tam = Math.min(Number(params.limit) || 50, 100);
          return { data: {
            results: delEstado.slice(desde, desde + tam).map((p) => p.id),
            scroll_id: `scroll:${desde + tam}`, paging: { total: delEstado.length },
          } };
        }
        const off = Number(params.offset) || 0;
        return { data: { results: delEstado.slice(off, off + 50).map((p) => p.id),
          paging: { total: delEstado.length } } };
      }
      if (/\/items\/bulk$/.test(url) && params.ids) {
        if (!bulkDisponible) throw error(404, 'resource not found');
        return { data: String(params.ids).split(',').map((id) => {
          const p = publicaciones.find((x) => x.id === id);
          return p ? { id, status_code: 200, body: comoLoDevuelveMl(p) } : { id, status_code: 404 };
        }) };
      }
      if (/\/items$/.test(url) && params.ids) {
        return { data: String(params.ids).split(',').map((id) => {
          const p = publicaciones.find((x) => x.id === id);
          return p ? { code: 200, body: comoLoDevuelveMl(p) } : { code: 404, body: null };
        }) };
      }
      if (url.includes('/user-products/')) {
        const up = (url.match(/\/user-products\/([^/]+)/) || [])[1];
        const reg = stockUp.get(up);
        if (metodo === 'get') {
          return { data: { locations: reg ? reg.locations : [] }, headers: { 'x-version': String(reg?.version ?? 1) } };
        }
        if (!reg || String(cfg?.headers?.['x-version']) !== String(reg.version)) throw error(409, 'Version mismatch');
        const loc = reg.locations.find((l) => l.type === 'selling_address');
        if (loc) loc.quantity = cuerpo.quantity;
        reg.version += 1;
        return { data: {} };
      }
      if (/\/users\/[^/]+$/.test(url)) return { data: { id: ML_USER, tags: etiquetasUsuario } };

      if (metodo === 'post' && /\/items\/[^/]+\/relist$/.test(url)) {
        // Como ML: republicar cierra la vieja y crea otra publicación, con otro id.
        const viejo = (url.match(/\/items\/([^/]+)\/relist$/) || [])[1];
        const pub = publicaciones.find((p) => p.id === viejo);
        if (!pub) throw error(404, 'item not found');
        if (pub.status !== 'closed') throw error(400, 'item is not closed');
        const nueva = {
          ...pub, id: `${viejo}-R`, status: 'active', sub_status: [],
          available_quantity: cuerpo.quantity ?? 0,
          permalink: `https://articulo.mercadolibre.com.ar/${viejo}-R-republicada-_JM`,
        };
        publicaciones.push(nueva);
        relistados.push({ id: viejo, cuerpo });
        return { data: nueva };
      }

      const item = (url.match(/\/items\/([^/?]+)/) || [])[1];
      if (item && fallar.has(item)) {
        const e = new Error('límite de peticiones');
        e.response = { status: 429, data: { message: 'too many requests' } };
        throw e;
      }
      if (item && metodo === 'put' && (conflictos.get(item) || 0) > 0) {
        conflictos.set(item, conflictos.get(item) - 1);
        throw error(409, 'item optimistic locking error: conflict');
      }
      /*
       * Un PUT que anda deja la publicación con el número nuevo.
       *
       * Sin esto el mock miente: por más que se mandara la corrección, la
       * siguiente lectura seguía devolviendo el valor viejo. Y como ML: con
       * stock, una pausada por falta de stock vuelve a activa; en cero, se pausa.
       */
      if (metodo === 'put' && item && cuerpo) {
        const pub = publicaciones.find((p) => p.id === item);
        if (pub) {
          if (cuerpo.available_quantity !== undefined) pub.available_quantity = cuerpo.available_quantity;
          for (const cv of cuerpo.variations || []) {
            const pv = (pub.variations || []).find((x) => String(x.id) === String(cv.id));
            if (pv && cv.available_quantity !== undefined) pv.available_quantity = cv.available_quantity;
          }
          const total = pub.variations?.length
            ? pub.variations.reduce((t, x) => t + (Number(x.available_quantity) || 0), 0)
            : Number(pub.available_quantity) || 0;
          const subs = pub.sub_status || [];
          if (pub.status === 'paused' && subs.includes('out_of_stock') && !subs.includes('paused_by_seller') && total > 0) {
            pub.status = 'active';
            pub.sub_status = [];
          } else if ((pub.status || 'active') === 'active' && total === 0) {
            pub.status = 'paused';
            pub.sub_status = ['out_of_stock'];
          }
        }
      }
      return { data: {} };
    };
    const cliente = {
      get:  (url, cfg) => responder('get', url, cfg),
      put:  (url, cuerpo, cfg) => responder('put', url, cfg, cuerpo),
      post: (url, cuerpo, cfg) => responder('post', url, cfg, cuerpo),
      create: () => cliente,
    };
    return cliente;
  }
  return originalLoad.apply(this, arguments);
};

const { Op } = require('sequelize');
const {
  Business, BusinessLocation, Product, ProductVariant, PackComponente, VariantStock, StockMovement,
  MercadoLibreAccount, MercadoLibreLink,
} = require('../src/models');
const stock = require('../src/services/stockService');
const packService = require('../src/services/packService');
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
  const packsViejos = await ProductVariant.findAll({ where: { sku: { [Op.like]: 'QA-SYNCPACK%' } } });
  await PackComponente.destroy({ where: { packVariantId: packsViejos.map((x) => x.id) } });
  await ProductVariant.destroy({ where: { id: packsViejos.map((x) => x.id) } });
  await ProductVariant.destroy({ where: { sku: { [Op.like]: 'QA-SYNC-%' } } });
  await Product.destroy({ where: { sku: ['QA-SYNC', 'QA-SYNCPACK'] } });

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
  /*
   * Un pack publicado en ML.
   *
   * Es el caso reportado: la publicación lleva el SKU del pack, y lo que hay
   * que publicar no es el stock del pack —que no tiene— sino cuántos se pueden
   * armar con lo que haya de su componente. Con 10 unidades y 3 por pack, son
   * 3 packs.
   */
  const prodPack = await Product.create({
    businessId: negocio.id, sku: 'QA-SYNCPACK', skuAgrupador: 'QA-SYNCPACK',
    titulo: 'QA Sync pack', precioMinorista: 300, precioMayorista: 300, costo: 120,
    activo: true,
  });
  const pack = await ProductVariant.create({
    productId: prodPack.id, businessId: negocio.id, sku: 'QA-SYNCPACK-1',
    variante1Nombre: 'Pack', variante1Valor: '3 unidades', esPack: true,
    stock: 0, stockMinimo: 0,
  });
  await packService.definirComponentes(pack.id, negocio.id, [
    { componenteVariantId: variantes[0].id, cantidad: 3 },
  ]);

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
    tit('8. UN PACK PUBLICADO SE SINCRONIZA CON LO QUE SE PUEDE ARMAR');
    /*
     * Un pack no tiene fila en `variant_stocks`. Si la sincronización mirara
     * sólo esa tabla, cada pack publicado saldría con stock cero: dejaría de
     * venderse de un día para el otro y sin explicación visible.
     */
    reset();
    /*
     * La publicación del pack se agrega recién acá: sumarla al lote inicial
     * corría en uno los conteos exactos de los bloques de arriba, que son los
     * que miden cuántas peticiones salen.
     */
    publicaciones.push({
      id: 'MLAPACK', title: 'Pub pack', seller_custom_field: pack.sku,
      // Arranca en 0: la sincronización tiene que subirlo a lo que se puede armar.
      available_quantity: 0, status: 'active', variations: [], attributes: [],
    });
    const conPack = await ml.sincronizarStock(negocio.id, { simular: true, skus: [pack.sku] });
    const linea = (conPack.resultados || []).find((d) => d.sku === pack.sku);
    chk('el pack aparece en la sincronización', true, !!linea);
    // 10 unidades del componente, 3 por pack → 3 packs.
    chk('publica lo que se puede armar, no cero', 3, linea?.stockStocker);
    chk('y ML lo tenía en cero, así que hay que mandarlo', 'pendiente', linea?.estado);

    // Y si el componente baja, el pack baja con él sin que nadie lo recalcule.
    await stock.mover({ variantId: variantes[0].id, businessId: negocio.id,
      locationId: local.id, fijar: 4, tipo: 'ajuste', motivo: 'QA sync pack' });
    const conMenos = await ml.sincronizarStock(negocio.id, { simular: true, skus: [pack.sku] });
    chk('con 4 unidades se arma 1 solo', 1,
      (conMenos.resultados || []).find((d) => d.sku === pack.sku)?.stockStocker);
    await stock.mover({ variantId: variantes[0].id, businessId: negocio.id,
      locationId: local.id, fijar: 10, tipo: 'ajuste', motivo: 'QA sync pack' });

    tit('8b. EL MARGEN DE SEGURIDAD NO SE PUBLICA');
    /*
     * Lo que se vende rápido en el mostrador puede guardar unidades fuera de
     * ML: entre una venta en el local y la próxima sincronización, ML podría
     * vender la misma prenda dos veces.
     */
    await ProductVariant.update({ margenMl: 2 }, { where: { id: variantes[0].id } });
    const conMargen = await ml.sincronizarStock(negocio.id, { simular: true, skus: ['QA-SYNC-0'] });
    chk('con 10 disponibles y margen 2, se publican 8', 8, conMargen.resultados[0]?.stockStocker);
    chk('y la fila dice el margen', 2, conMargen.resultados[0]?.margenMl);
    await ProductVariant.update({ margenMl: 50 }, { where: { id: variantes[0].id } });
    const margenGrande = await ml.sincronizarStock(negocio.id, { simular: true, skus: ['QA-SYNC-0'] });
    chk('un margen mayor a lo que hay publica cero, no negativo', 0, margenGrande.resultados[0]?.stockStocker);
    await ProductVariant.update({ margenMl: 0 }, { where: { id: variantes[0].id } });

    await ProductVariant.update({ margenMl: 1 }, { where: { id: pack.id } });
    const packMargen = await ml.sincronizarStock(negocio.id, { simular: true, skus: [pack.sku] });
    chk('en un pack el margen son packs: 3 armables, margen 1, se publican 2', 2,
      (packMargen.resultados || []).find((d) => d.sku === pack.sku)?.stockStocker);
    const suelta = await ml.sincronizarStock(negocio.id, { simular: true, skus: ['QA-SYNC-0'] });
    chk('y el margen del pack no le quita nada a la prenda suelta', 10, suelta.resultados[0]?.stockStocker);
    await ProductVariant.update({ margenMl: 0 }, { where: { id: pack.id } });

    tit('9. LO QUE SE APARTA TAMBIÉN AVISA');
    /*
     * Lo publicado es `stock - reservado`, así que apartar unidades lo baja
     * igual que venderlas. Hasta ahora sólo avisaba `mover`, que toca `stock`:
     * entraba una venta de ML, se apartaban 3 unidades, lo disponible pasaba de
     * 10 a 7 y la publicación seguía ofreciendo 10. Por ahí se vende algo que
     * ya está comprometido.
     */
    const avisados = [];
    const original = ml.marcarParaSync;
    ml.marcarParaSync = (bid, sku) => { avisados.push(sku); return original(bid, sku); };
    try {
      await stock.reservar(variantes[1].id, local.id, negocio.id, 2);
      chk('apartar avisa a Mercado Libre', true, avisados.includes(variantes[1].sku));
      avisados.length = 0;
      await stock.liberarReserva(variantes[1].id, local.id, negocio.id, 2);
      chk('soltar la reserva también', true, avisados.includes(variantes[1].sku));

      /*
       * Despachar NO tiene que avisar: baja `stock` y `reservado` a la vez, así
       * que lo disponible no cambia. Un aviso ahí sería una llamada a ML para
       * mandar el mismo número que ya tenía.
       */
      avisados.length = 0;
      await stock.reservar(variantes[1].id, local.id, negocio.id, 1);
      avisados.length = 0;
      await stock.consumirReserva(variantes[1].id, local.id, negocio.id, 1, null,
        { motivo: 'QA sync', registrarMovimiento: false });
      chk('despachar no avisa: lo disponible no cambió', false,
        avisados.includes(variantes[1].sku));
    } finally {
      ml.marcarParaSync = original;
    }

    tit('10. UN COMPONENTE QUE SE MUEVE ARRASTRA A SUS PACKS');
    /*
     * Vender una remera suelta cambia cuántos packs se pueden armar, aunque el
     * SKU del pack no se haya tocado. Sin esto, la publicación del pack se
     * quedaba con el número viejo hasta que alguien sincronizara a mano, y
     * mientras tanto puede vender packs que ya no se pueden armar.
     */
    const expandidos = await ml.__conLosPacksQueLosUsan([variantes[0].sku], negocio.id);
    chk('a la tanda se le suma el pack que usa esa variante', true,
      expandidos.includes(pack.sku));
    chk('sin perder el SKU que la disparó', true, expandidos.includes(variantes[0].sku));
    const sinPacks = await ml.__conLosPacksQueLosUsan([variantes[5].sku], negocio.id);
    chk('una variante que no está en ningún pack no agrega nada', 1, sinPacks.length);

    tit('11. EL BARRIDO PERIÓDICO');
    /*
     * La red debajo del aviso inmediato: el aviso vive en memoria del proceso y
     * un deploy se lo lleva. El barrido compara y manda sólo lo que difiere.
     */
    const tareas = require('../src/services/tareasPeriodicasService');
    reset();
    // La publicación del pack quedó en 0 y en Stocker se pueden armar varios.
    const r = await tareas.barrerStockMl();
    chk('el barrido recorre las cuentas conectadas', true, r.cuentas >= 1);
    chk('y manda lo que estaba distinto', true, r.actualizados > 0);
    chk('sin errores', 0, r.fallaron);

    // Corriéndolo de nuevo ya no queda nada por mandar.
    reset();
    const r2 = await tareas.barrerStockMl();
    chk('un segundo barrido no manda nada', 0, r2.actualizados);
    chk('y no hace ni una petición de escritura', 0, puts());

    tit('12. PAUSADAS, UNA PUBLICACIÓN POR SKU, VARIACIONES, FULL Y LINKS');
    try {
      const extras = [];
      const original = ml.marcarParaSync;
      // Cargar el stock de prueba no dispara sincronizaciones sueltas en el medio.
      ml.marcarParaSync = () => {};
      try {
        for (const sku of ['QA-SYNC-P1', 'QA-SYNC-DUP', 'QA-SYNC-VA', 'QA-SYNC-VB', 'QA-SYNC-FULL',
          'QA-SYNC-FLEX', 'QA-SYNC-409', 'QA-SYNC-ATTR', 'QA-SYNC-UPX', 'QA-SYNC-REL']) {
          const v = await ProductVariant.create({
            productId: prod.id, businessId: negocio.id, sku,
            variante1Nombre: 'N', variante1Valor: sku, stock: 0, stockMinimo: 0,
          });
          await stock.mover({ variantId: v.id, businessId: negocio.id, locationId: local.id,
            delta: 10, tipo: 'ingreso', motivo: 'QA sync' });
          variantes.push(v);   // la limpieza de abajo las borra
          extras.push(sku);
        }
      } finally {
        ml.marcarParaSync = original;
      }

      const conSku = (valor) => [{ id: 'SELLER_SKU', value_name: valor }];
      publicaciones.push(
        { id: 'MLA9001', title: 'Pausada sin stock', status: 'paused', sub_status: ['out_of_stock'],
          listing_type_id: 'gold_special', available_quantity: 0, attributes: conSku('QA-SYNC-P1'), variations: [],
          permalink: 'https://articulo.mercadolibre.com.ar/MLA-9001-pausada-sin-stock-_JM' },
        { id: 'MLA9101', title: 'Repetida clásica', status: 'active', listing_type_id: 'gold_special',
          available_quantity: 5, attributes: conSku('QA-SYNC-DUP'), variations: [], sold_quantity: 50 },
        { id: 'MLA9102', title: 'Repetida premium', status: 'paused', sub_status: ['out_of_stock'],
          listing_type_id: 'gold_pro', available_quantity: 0, attributes: conSku('QA-SYNC-DUP'), variations: [] },
        { id: 'MLA9103', title: 'Repetida premium pausada por el vendedor', status: 'paused', sub_status: ['paused_by_seller'],
          listing_type_id: 'gold_pro', available_quantity: 0, attributes: conSku('QA-SYNC-DUP'), variations: [] },
        { id: 'MLA9201', title: 'Con variaciones', status: 'active', listing_type_id: 'gold_special',
          available_quantity: 3, attributes: [], variations: [
            { id: 11, available_quantity: 0, attributes: conSku('QA-SYNC-VA') },
            { id: 12, available_quantity: 0, attributes: conSku('QA-SYNC-VB') },
            { id: 13, available_quantity: 3, attributes: conSku('SKU-DE-OTRO-SISTEMA') },
          ] },
        { id: 'MLA9301', title: 'Full', status: 'active', listing_type_id: 'gold_pro', available_quantity: 7,
          attributes: conSku('QA-SYNC-FULL'), variations: [], shipping: { logistic_type: 'fulfillment' } },
        { id: 'MLA9401', title: 'Full y Flex', status: 'active', listing_type_id: 'gold_pro', available_quantity: 12,
          attributes: conSku('QA-SYNC-FLEX'), variations: [], user_product_id: 'MLAU777',
          shipping: { logistic_type: 'fulfillment', tags: ['self_service_in'] } },
        { id: 'MLA9501', title: 'Con conflicto', status: 'active', listing_type_id: 'gold_special',
          available_quantity: 0, attributes: conSku('QA-SYNC-409'), variations: [] },
        { id: 'MLA9601', title: 'SKU en el atributo', status: 'active', listing_type_id: 'gold_special',
          available_quantity: 0, seller_custom_field: 'dato-interno', attributes: conSku('QA-SYNC-ATTR'), variations: [] },
        { id: 'MLA9701', title: 'Finalizada', status: 'closed', listing_type_id: 'gold_pro', available_quantity: 0,
          attributes: conSku('QA-SYNC-P1'), variations: [] },
        // Dos publicaciones del mismo user product: ML las sincroniza sola.
        { id: 'MLA9801', title: 'Mismo producto A', status: 'active', listing_type_id: 'gold_special',
          available_quantity: 0, attributes: conSku('QA-SYNC-UPX'), variations: [], user_product_id: 'MLAU900' },
        { id: 'MLA9802', title: 'Mismo producto B', status: 'active', listing_type_id: 'gold_special',
          available_quantity: 5, attributes: conSku('QA-SYNC-UPX'), variations: [], user_product_id: 'MLAU900' },
        // El par catálogo / tradicional, ligado por item_relations.
        { id: 'MLA9901', title: 'Tradicional', status: 'active', listing_type_id: 'gold_special',
          available_quantity: 0, attributes: conSku('QA-SYNC-REL'), variations: [] },
        { id: 'MLA9902', title: 'De catálogo', status: 'active', listing_type_id: 'gold_special',
          available_quantity: 5, attributes: conSku('QA-SYNC-REL'), variations: [], catalog_listing: true,
          item_relations: [{ id: 'MLA9901' }] },
      );
      stockUp.set('MLAU777', { version: 7, locations: [{ type: 'selling_address', quantity: 2 }, { type: 'meli_facility', quantity: 10 }] });
      conflictos.set('MLA9501', 1);
      const putsA = (id) => LLAMADAS.filter((l) => l.metodo === 'put' && l.url.endsWith(`/items/${id}`)).length;
      const busquedas = () => LLAMADAS.filter((l) => l.url.includes('/items/search'));

      reset();
      const previa = await ml.sincronizarStock(negocio.id, { simular: true, skus: extras });
      const fila = (sku) => (previa.resultados || []).find((r) => r.sku === sku);
      chk('trae activas y pausadas, sin las finalizadas', publicaciones.filter((p) => p.status !== 'closed').length,
        previa.publicacionesEncontradas);
      chk('busca por estado: activas y pausadas', ['active', 'paused'], [...new Set(busquedas().map((l) => l.params.status))]);
      chk('con scan, no con offset', true, busquedas().every((l) => l.params.search_type === 'scan' && l.params.offset === undefined));
      chk('y pagina con scroll: más de 100 activas no entran en una página', true,
        busquedas().filter((l) => l.params.scroll_id).length >= 2);
      chk('pide los atributos de las variaciones', true,
        LLAMADAS.filter((l) => /\/items(\/bulk)?$/.test(l.url)).every((l) => l.params.include_attributes === 'all'));
      chk('una pausada sin stock entra en la sincronización', 'pendiente', fila('QA-SYNC-P1')?.estado);
      chk('y avisa que ML la reactiva', true, /reactiva/.test(fila('QA-SYNC-P1')?.aviso || ''));
      chk('el link es el permalink de ML', 'https://articulo.mercadolibre.com.ar/MLA-9001-pausada-sin-stock-_JM',
        fila('QA-SYNC-P1')?.permalink);
      const dup = fila('QA-SYNC-DUP');
      chk('con SKU repetido se asigna la de mejor exposición (Premium)', 'MLA9102', dup?.mlItemId);
      chk('las otras quedan a la vista, la pausada por el vendedor al final', ['MLA9101', 'MLA9103'],
        (dup?.otras || []).map((o) => o.mlItemId));
      chk('sin permalink, el link lleva el guión que ML necesita', 'https://articulo.mercadolibre.com.ar/MLA-9101',
        dup?.otras?.[0]?.permalink);
      chk('la previa avisa que la duplicada con stock se va a poner en 0', true,
        (dup?.otras || []).find((o) => o.mlItemId === 'MLA9101')?.seVaACero === true);
      chk('la que comparte stock con la asignada no se toca', undefined,
        ((fila('QA-SYNC-UPX')?.otras || [])[0] || {}).seVaACero);
      chk('ni la ligada por catálogo', [true, undefined],
        [((fila('QA-SYNC-REL')?.otras || [])[0] || {}).comparteStock,
          ((fila('QA-SYNC-REL')?.otras || [])[0] || {}).seVaACero]);
      chk('el resumen cuenta las duplicadas a poner en 0', 1, previa.resumen?.duplicadasACero);
      chk('el tipo de publicación se muestra con su nombre', 'Premium', dup?.tipoNombre);
      chk('el SKU de cada variación se lee de sus atributos', ['MLA9201', '11', 'MLA9201', '12'],
        [fila('QA-SYNC-VA')?.mlItemId, fila('QA-SYNC-VA')?.mlVariationId, fila('QA-SYNC-VB')?.mlItemId, fila('QA-SYNC-VB')?.mlVariationId]);
      chk('Full no se sincroniza y dice por qué', ['no-sincronizable', true],
        [fila('QA-SYNC-FULL')?.estado, /Full/.test(fila('QA-SYNC-FULL')?.motivo || '')]);
      chk('SELLER_SKU manda sobre seller_custom_field', 'MLA9601', fila('QA-SYNC-ATTR')?.mlItemId);
      chk('el resumen cuenta lo que no se puede sincronizar', 1, previa.resumen?.noSincronizables);
      chk('la simulación no escribe nada', 0, puts());

      reset();
      const envio = await ml.sincronizarStock(negocio.id, { simular: false, skus: extras });
      const filaE = (sku) => (envio.resultados || []).find((r) => r.sku === sku);
      chk('la pausada sin stock se actualiza', 'actualizado', filaE('QA-SYNC-P1')?.estado);
      chk('y ML la reactiva', 'active', publicaciones.find((p) => p.id === 'MLA9001').status);
      chk('la finalizada con el mismo SKU no se toca', 0, putsA('MLA9701'));
      // La asignada recibe el stock; la duplicada con stock, un cero. La que ya
      // estaba en cero (pausada por el vendedor) no se toca.
      chk('la asignada recibe stock y la duplicada un cero', [1, 1, 0], ['MLA9102', 'MLA9101', 'MLA9103'].map(putsA));
      const dupCero = publicaciones.find((p) => p.id === 'MLA9101');
      chk('la duplicada queda en 0 y ML la pausa', [0, 'paused', ['out_of_stock']],
        [dupCero.available_quantity, dupCero.status, dupCero.sub_status]);
      chk('y la fila lo dice', true,
        (filaE('QA-SYNC-DUP')?.otras || []).find((o) => o.mlItemId === 'MLA9101')?.enCero === true);
      chk('la que comparte user product sigue con su stock', 5,
        publicaciones.find((p) => p.id === 'MLA9802').available_quantity);
      chk('y la de catálogo también', 5, publicaciones.find((p) => p.id === 'MLA9902').available_quantity);
      chk('el resumen cuenta las que quedaron en cero', 1, envio.resumen?.duplicadasEnCero);
      const putVariaciones = LLAMADAS.filter((l) => l.metodo === 'put' && l.url.endsWith('/items/MLA9201'));
      chk('dos variaciones de la misma publicación van en un solo PUT', 1, putVariaciones.length);
      chk('con el id de todas, y stock sólo en las que cambian',
        [{ id: 11, available_quantity: 10 }, { id: 12, available_quantity: 10 }, { id: 13 }],
        putVariaciones[0]?.cuerpo?.variations);
      chk('Full no recibe ningún PUT', 0, putsA('MLA9301'));
      chk('Full + Flex escribe el stock de Flex con x-version', [10, 8],
        [stockUp.get('MLAU777').locations[0].quantity, stockUp.get('MLAU777').version]);
      chk('y no lo pisa por /items', 0, putsA('MLA9401'));
      chk('un 409 de ML se reintenta y termina bien', ['actualizado', 2], [filaE('QA-SYNC-409')?.estado, putsA('MLA9501')]);

      etiquetasUsuario = ['warehouse_management'];
      publicaciones.find((p) => p.id === 'MLA9601').available_quantity = 0;
      reset();
      const multi = await ml.sincronizarStock(negocio.id, { simular: false, skus: ['QA-SYNC-ATTR'] });
      chk('con multi-origen no se escribe por /items y se explica', ['no-sincronizable', 0, true],
        [multi.resultados[0]?.estado, puts(), /multi-origen/.test(multi.resultados[0]?.motivo || '')]);
      etiquetasUsuario = [];

      bulkDisponible = false;
      reset();
      const sinBulk = await ml.sincronizarStock(negocio.id, { simular: true, skus: ['QA-SYNC-DUP'] });
      chk('si /items/bulk no está, usa el multiget de siempre', 'MLA9102', sinBulk.resultados[0]?.mlItemId);
      bulkDisponible = true;
    } catch (e) {
      chk('la sección 12 no revienta', null, String(e?.stack || e));
    } finally {
      publicaciones = publicaciones.filter((p) => !/^MLA9\d{3}$/.test(p.id));
    }

    tit('13. CHECKLIST: QUÉ TIENE EL STOCK PUESTO EN ML Y QUÉ NO');
    const cobProd = await Product.create({
      businessId: negocio.id, sku: 'QA-COB', skuAgrupador: 'QA-COB', titulo: 'QA Cobertura',
      precioMinorista: 100, precioMayorista: 100, costo: 10, activo: true,
    });
    const cobVariantes = [];
    try {
      const atributoSku = (valor) => [{ id: 'SELLER_SKU', value_name: valor }];
      for (const sku of ['QA-COB-1', 'QA-COB-2', 'QA-COB-3']) {
        cobVariantes.push(await ProductVariant.create({
          productId: cobProd.id, businessId: negocio.id, sku,
          variante1Nombre: 'Talle', variante1Valor: sku.slice(-1), stock: 0, stockMinimo: 0,
        }));
      }
      publicaciones.push(
        { id: 'MLA8001', title: 'Publicada', status: 'active', listing_type_id: 'gold_special',
          available_quantity: 0, attributes: atributoSku('QA-COB-1'), variations: [] },
        { id: 'MLA8002', title: 'Vieja finalizada', status: 'closed', listing_type_id: 'gold_special',
          available_quantity: 0, attributes: atributoSku('QA-COB-2'), variations: [] },
      );

      reset();
      const cob = await ml.coberturaMl(negocio.id);
      const grupo = (cob.productos || []).find((p) => p.productId === cobProd.id);
      chk('el checklist también busca las finalizadas', true,
        LLAMADAS.some((l) => l.url.includes('/items/search') && l.params.status === 'closed'));
      chk('el producto padre aparece con sus variantes', 3, grupo?.total);
      chk('la publicada y la finalizada figuran en ML; la tercera no', [true, true, false],
        (grupo?.variantes || []).map((x) => x.enMl));
      chk('pero sólo se puede sincronizar la que está viva', [true, false, false],
        (grupo?.variantes || []).map((x) => x.sincronizable));
      chk('y la finalizada dice por qué no', true, /finalizada/.test((grupo?.variantes || [])[1]?.motivo || ''));
      chk('el producto queda a medias', 'parcial', grupo?.estado);
      chk('cuenta cuántas variantes están y cuántas faltan', [2, 1], [grupo?.enMl, grupo?.sinMl]);
      chk('cada variante publicada trae su link', true,
        String((grupo?.variantes || [])[0]?.permalink || '').includes('MLA-8001'));
      chk('lo que falta va primero', true,
        (cob.productos || []).findIndex((p) => p.estado === 'completo')
          >= (cob.productos || []).findIndex((p) => p.estado === 'parcial'));
      chk('el resumen cierra: las que están más las que faltan son todas', true,
        cob.resumen.variantes === cob.resumen.variantesEnMl + cob.resumen.variantesSinMl);
      chk('y la sincronización de siempre no busca finalizadas', false,
        (await (async () => {
          reset();
          await ml.sincronizarStock(negocio.id, { simular: true, skus: ['QA-COB-1'] });
          return LLAMADAS.some((l) => l.url.includes('/items/search') && l.params.status === 'closed');
        })()));
    } catch (e) {
      chk('la sección 13 no revienta', null, String(e?.stack || e));
    } finally {
      publicaciones = publicaciones.filter((p) => !/^MLA800\d$/.test(p.id));
      await ProductVariant.destroy({ where: { id: cobVariantes.map((v) => v.id) } });
      await Product.destroy({ where: { id: cobProd.id } });
    }

    tit('14. REPUBLICAR UNA PUBLICACIÓN FINALIZADA');
    const reVariantes = [];
    try {
      const atributoSku = (valor) => [{ id: 'SELLER_SKU', value_name: valor }];
      const original = ml.marcarParaSync;
      ml.marcarParaSync = () => {};
      try {
        for (const [sku, cantidad] of [['QA-SYNC-RE', 4], ['QA-SYNC-RE0', 0]]) {
          const v = await ProductVariant.create({
            productId: prod.id, businessId: negocio.id, sku,
            variante1Nombre: 'N', variante1Valor: sku, stock: 0, stockMinimo: 0,
          });
          if (cantidad) {
            await stock.mover({ variantId: v.id, businessId: negocio.id, locationId: local.id,
              delta: cantidad, tipo: 'ingreso', motivo: 'QA sync' });
          }
          reVariantes.push(v);
          variantes.push(v);
        }
      } finally {
        ml.marcarParaSync = original;
      }
      publicaciones.push(
        { id: 'MLA7001', title: 'Vieja para republicar', status: 'closed', listing_type_id: 'gold_special',
          price: 1000, available_quantity: 0, seller_id: ML_USER, attributes: atributoSku('QA-SYNC-RE'), variations: [] },
        { id: 'MLA7002', title: 'Activa', status: 'active', listing_type_id: 'gold_special',
          price: 1000, available_quantity: 1, seller_id: ML_USER, attributes: atributoSku('QA-SYNC-RE'), variations: [] },
        { id: 'MLA7003', title: 'De otro vendedor', status: 'closed', listing_type_id: 'gold_special',
          price: 1000, available_quantity: 0, seller_id: '999999', attributes: atributoSku('QA-SYNC-RE'), variations: [] },
        { id: 'MLA7004', title: 'Finalizada sin stock', status: 'closed', listing_type_id: 'gold_special',
          price: 1000, available_quantity: 0, seller_id: ML_USER, attributes: atributoSku('QA-SYNC-RE0'), variations: [] },
      );
      const falla = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

      const hecha = await ml.republicar(negocio.id, { mlItemId: 'MLA7001' });
      const mandado = relistados.find((x) => x.id === 'MLA7001')?.cuerpo;
      chk('republica con el stock que hay en Stocker', 4, mandado?.quantity);
      chk('y conserva precio y tipo de publicación', [1000, 'gold_special'],
        [mandado?.price, mandado?.listing_type_id]);
      chk('devuelve la publicación nueva, con otro id y su link', ['MLA7001-R', true],
        [hecha.mlItemId, String(hecha.permalink).includes('MLA7001-R')]);
      chk('una activa no se republica', 400, (await falla(() => ml.republicar(negocio.id, { mlItemId: 'MLA7002' })))?.status);
      chk('la de otro vendedor tampoco', 403, (await falla(() => ml.republicar(negocio.id, { mlItemId: 'MLA7003' })))?.status);
      chk('ni una sin stock en Stocker', 400, (await falla(() => ml.republicar(negocio.id, { mlItemId: 'MLA7004' })))?.status);
      chk('la que no existe da 404', 404, (await falla(() => ml.republicar(negocio.id, { mlItemId: 'MLA0000' })))?.status);
      chk('y la republicada ya se sincroniza como cualquier otra', 'MLA7001-R',
        (await ml.sincronizarStock(negocio.id, { simular: true, skus: ['QA-SYNC-RE'] })).resultados[0]?.mlItemId);
    } catch (e) {
      chk('la sección 14 no revienta', null, String(e?.stack || e));
    } finally {
      publicaciones = publicaciones.filter((p) => !/^MLA700\d/.test(p.id));
    }

    tit('Limpieza');
    const ids = variantes.map((v) => v.id);
    // El pack primero: su composición apunta a una de estas variantes.
    await PackComponente.destroy({ where: { packVariantId: pack.id } });
    await ProductVariant.destroy({ where: { id: pack.id } });
    await Product.destroy({ where: { id: prodPack.id } });
    await MercadoLibreLink.destroy({ where: { businessId: negocio.id, sku: { [Op.like]: 'QA-SYNC%' } } });
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
