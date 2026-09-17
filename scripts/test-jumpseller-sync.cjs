/*
 * Jumpseller: sincronización de stock por SKU.
 *
 * Contra un simulador de su API, no contra la tienda real: la prueba tiene que
 * poder correr mil veces sin tocarle el stock a nadie y sin depender de que
 * Jumpseller esté arriba.
 *
 * El simulador se comporta como la API documentada: pagina de a 100, devuelve
 * [{ product: {...} }], las variantes traen su propio SKU y su stock, el PUT de
 * una variante va por su ruta y el de un producto pide nombre y precio, y el
 * límite de pedidos contesta 429.
 */

const Module = require('module');

const LLAMADAS = [];
let productos = [];
let ORDENES = [];
let fallar429 = new Set();
let claveValida = { login: 'LLAVE-QA', token: 'TOKEN-QA' };
// Como Jumpseller: más de `topeMock` pedidos en un segundo son 429.
let topeMock = 0;
const pegados = [];
let excedidos = 0;
process.env.JUMPSELLER_ESPERA_429_MS = '20';
// La demora del aviso por venta se lee al cargar el servicio: acá, casi nada.
process.env.ML_SYNC_DEMORA_MS = '120';
/*
 * Sin freno de ritmo salvo donde se lo prueba (sección 10): si no, cada
 * sección esperaría de verdad el segundo que el freno impone y la suite
 * tardaría minutos en medir cosas que no tienen que ver con el ritmo.
 */
process.env.JUMPSELLER_POR_SEGUNDO = '1000';
process.env.JUMPSELLER_POR_MINUTO = '100000';

const originalLoad = Module._load;
Module._load = function (pedido) {
  if (pedido === 'axios') {
    const responder = async (metodo, url, cfg, cuerpo) => {
      const params = cfg?.params || {};
      LLAMADAS.push({ url, metodo, params, cuerpo, auth: cfg?.auth });
      if (topeMock) {
        const ahora = Date.now();
        while (pegados.length && ahora - pegados[0] > 1000) pegados.shift();
        pegados.push(ahora);
        if (pegados.length > topeMock) {
          excedidos += 1;
          const e = new Error('Rate Limit Exceeded');
          e.response = { status: 429, data: { message: 'Rate Limit Exceeded' }, headers: {} };
          throw e;
        }
      }
      await new Promise((r) => setTimeout(r, 4));

      const error = (status, data) => {
        const e = new Error(typeof data === 'string' ? data : (data?.message || 'error'));
        e.response = { status, data };
        throw e;
      };
      // La clave va como usuario y contraseña, igual que en la API real.
      const auth = cfg?.auth || {};
      if (auth.username !== claveValida.login || auth.password !== claveValida.token) {
        error(401, { message: 'Invalid credentials' });
      }

      if (url.endsWith('/products/count.json')) return { data: { count: productos.length } };

      if (url.endsWith('/orders.json') && metodo === 'get') {
        const limite = Math.min(Number(params.limit) || 50, 100);
        const desde = ((Number(params.page) || 1) - 1) * limite;
        return { data: ORDENES.slice(desde, desde + limite).map((o) => ({ order: o })) };
      }
      if (url.endsWith('/products.json') && metodo === 'get') {
        const limite = Math.min(Number(params.limit) || 50, 100);
        const desde = ((Number(params.page) || 1) - 1) * limite;
        return { data: productos.slice(desde, desde + limite).map((p) => ({ product: p })) };
      }

      const variante = url.match(/\/products\/(\d+)\/variants\/(\d+)\.json$/);
      if (variante && metodo === 'put') {
        const [, pid, vid] = variante;
        if (fallar429.has(`v${vid}`)) {
          fallar429.delete(`v${vid}`);
          error(429, { message: 'Rate Limit Exceeded' });
        }
        const p = productos.find((x) => String(x.id) === pid);
        const v = (p?.variants || []).find((x) => String(x.id) === vid);
        if (!v) error(404, { message: 'Variant not found' });
        if (cuerpo?.variant?.stock !== undefined) v.stock = cuerpo.variant.stock;
        return { data: { variant: v } };
      }

      const producto = url.match(/\/products\/(\d+)\.json$/);
      if (producto && metodo === 'get') {
        const p = productos.find((x) => String(x.id) === producto[1]);
        if (!p) error(404, { message: 'Product not found' });
        return { data: { product: { id: p.id, name: p.name, price: p.price } } };
      }
      if (producto && metodo === 'put') {
        const p = productos.find((x) => String(x.id) === producto[1]);
        if (!p) error(404, { message: 'Product not found' });
        // Como la API: el cuerpo va bajo "product" y pide nombre y precio.
        if (!cuerpo?.product) error(422, { message: 'Missing product' });
        if (!cuerpo.product.name || cuerpo.product.price === undefined) {
          error(422, { message: 'name and price are required' });
        }
        if (cuerpo.product.stock !== undefined) p.stock = cuerpo.product.stock;
        // La API guarda lo que venga en el cuerpo: si mandan un precio viejo, lo pisa.
        if (cuerpo.product.name !== undefined) p.name = cuerpo.product.name;
        if (cuerpo.product.price !== undefined) p.price = cuerpo.product.price;
        return { data: { product: p } };
      }
      return { data: {} };
    };
    const cliente = {
      get: (url, cfg) => responder('get', url, cfg),
      put: (url, cuerpo, cfg) => responder('put', url, cfg, cuerpo),
      post: (url, cuerpo, cfg) => responder('post', url, cfg, cuerpo),
      create: () => cliente,
    };
    return cliente;
  }
  return originalLoad.apply(this, arguments);
};

const { Op } = require('sequelize');
const {
  Business, BusinessLocation, Product, ProductVariant, VariantStock, StockMovement,
  JumpsellerAccount, PedidoPlataforma, PedidoPlataformaItem,
} = require('../src/models');
const stock = require('../src/services/stockService');
const jumpseller = require('../src/services/jumpsellerService');
const tareas = require('../src/services/tareasPeriodicasService');
const aviso = require('../src/services/avisoStockService');
const trabajos = require('../src/services/trabajosService');
const ml = require('../src/services/mercadolibreService');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

(async () => {
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  const local = await BusinessLocation.findOne({
    where: { businessId: negocio.id, tipo: 'local', abasteceOnline: true, activo: true },
  });

  const limpiar = async () => {
    const viejas = await ProductVariant.findAll({ where: { sku: { [Op.like]: 'QA-JS-%' } } });
    const ids = viejas.map((v) => v.id);
    if (ids.length) {
      await StockMovement.destroy({ where: { productVariantId: ids } });
      await VariantStock.destroy({ where: { productVariantId: ids } });
      await ProductVariant.destroy({ where: { id: ids } });
    }
    await Product.destroy({ where: { businessId: negocio.id, sku: { [Op.like]: 'QA-JS%' } } });
    await JumpsellerAccount.destroy({ where: { businessId: negocio.id } });
    // Las ventas que trajo la importación de prueba.
    const pedidos = await PedidoPlataforma.findAll({
      where: { businessId: negocio.id, plataforma: 'jumpseller', pedidoExterno: { [Op.like]: 'QA5%' } },
    });
    if (pedidos.length) {
      await PedidoPlataformaItem.destroy({ where: { pedidoId: pedidos.map((x) => x.id) } });
      await PedidoPlataforma.destroy({ where: { id: pedidos.map((x) => x.id) } });
    }
  };
  await limpiar();

  const prod = await Product.create({
    businessId: negocio.id, sku: 'QA-JS', skuAgrupador: 'QA-JS', titulo: 'QA Jumpseller',
    precioMinorista: 100, precioMayorista: 100, costo: 40, activo: true,
  });
  /*
   * Cargar el stock de prueba no tiene que avisarle a la tienda: el aviso por
   * venta se prueba aparte, y si acá dispara, una sincronización de fondo entra
   * en el medio de las otras secciones y las deja midiendo otra cosa.
   */
  const avisoReal = ml.marcarParaSync;
  ml.marcarParaSync = () => {};

  const variantes = [];
  for (const [sku, cantidad] of [['QA-JS-1', 10], ['QA-JS-2', 7], ['QA-JS-3', 5], ['QA-JS-4', 3], ['QA-JS-5', 9]]) {
    const v = await ProductVariant.create({
      productId: prod.id, businessId: negocio.id, sku,
      variante1Nombre: 'Talle', variante1Valor: sku.slice(-1), stock: 0, stockMinimo: 0,
    });
    await stock.mover({ variantId: v.id, businessId: negocio.id, locationId: local.id,
      delta: cantidad, tipo: 'ingreso', motivo: 'QA jumpseller' });
    variantes.push(v);
  }

  const tienda = () => ([
    // Un producto con variantes: el SKU y el stock viven en cada una.
    { id: 501, name: 'Remera QA', price: 100, status: 'available', permalink: 'https://tienda.test/remera',
      sku: 'QA-JS-PADRE', stock: 0, stock_unlimited: false, variants: [
        { id: 9001, sku: 'QA-JS-1', stock: 0, stock_unlimited: false, price: 100 },
        { id: 9002, sku: 'QA-JS-2', stock: 7, stock_unlimited: false, price: 100 },
        { id: 9003, sku: 'QA-JS-AJENO', stock: 1, stock_unlimited: false, price: 100 },
      ] },
    // Uno sin variantes: el stock es del producto.
    { id: 502, name: 'Buzo QA', price: 200, status: 'available', permalink: 'https://tienda.test/buzo',
      sku: 'QA-JS-3', stock: 0, stock_unlimited: false, variants: [] },
    // Stock ilimitado: la tienda no lleva la cuenta.
    { id: 503, name: 'Gift card QA', price: 500, status: 'available', sku: 'QA-JS-4',
      stock: 0, stock_unlimited: true, variants: [] },
    // El mismo SKU repetido. La deshabilitada tiene el id más chico a propósito:
    // si no se mirara el estado, sería la que gana.
    { id: 504, name: 'Pantalón QA viejo', price: 300, status: 'disabled', sku: 'QA-JS-5',
      stock: 99, stock_unlimited: false, variants: [] },
    { id: 505, name: 'Pantalón QA', price: 300, status: 'available', sku: 'QA-JS-5',
      stock: 0, stock_unlimited: false, variants: [] },
  ]);
  const reset = () => { LLAMADAS.length = 0; };
  const puts = () => LLAMADAS.filter((l) => l.metodo === 'put').length;

  try {
    tit('1. CONECTAR: LA CLAVE SE GUARDA SÓLO SI ANDA');
    productos = tienda();
    const mala = await falla(() => jumpseller.conectar(negocio.id, { loginKey: 'X', authToken: 'Y' }));
    chk('una clave que Jumpseller rechaza no se guarda', [401, 0],
      [mala?.status, await JumpsellerAccount.count({ where: { businessId: negocio.id } })]);
    chk('y el mensaje dice qué revisar', true, /Login Key/.test(mala?.message || ''));
    const sinClave = await falla(() => jumpseller.conectar(negocio.id, { loginKey: '', authToken: '' }));
    chk('sin clave ni token, tampoco', 400, sinClave?.status);

    const conectada = await jumpseller.conectar(negocio.id, {
      loginKey: claveValida.login, authToken: claveValida.token, tienda: 'tienda.test',
    });
    chk('con la clave buena queda conectada y dice cuántos productos hay', [true, 5],
      [conectada.conectado, conectada.productos]);
    const est = await jumpseller.estado(negocio.id);
    chk('el estado no devuelve la clave', [true, 'tienda.test', undefined, undefined],
      [est.conectado, est.tienda, est.loginKey, est.authToken]);

    tit('2. SE PIDEN TODOS LOS PRODUCTOS, DE A 100');
    productos = tienda();
    for (let i = 0; i < 100; i++) {
      productos.push({ id: 700 + i, name: `Relleno ${i}`, price: 10, status: 'available',
        sku: `QA-JS-RELLENO-${i}`, stock: 1, stock_unlimited: false, variants: [] });
    }
    reset();
    const lista = await jumpseller.listarProductos(await JumpsellerAccount.findOne({ where: { businessId: negocio.id } }));
    chk('trae los 105', 105, lista.length);
    const paginas = LLAMADAS.filter((l) => l.url.endsWith('/products.json'));
    chk('en dos páginas de 100', [2, 100, 1, 2], [paginas.length, paginas[0].params.limit, paginas[0].params.page, paginas[1].params.page]);
    chk('pidiendo las variantes', true, String(paginas[0].params.fields).includes('variants'));

    tit('3. SE CRUZA POR SKU Y SÓLO SE MANDA LO QUE CAMBIÓ');
    productos = tienda();
    reset();
    const previa = await jumpseller.sincronizarStock(negocio.id, { simular: true });
    const fila = (sku) => previa.resultados.find((r) => r.sku === sku);
    chk('la variante de la tienda se cruza con el SKU de Stocker', [501, 9001, 'pendiente'],
      [fila('QA-JS-1')?.productId, fila('QA-JS-1')?.variantId, fila('QA-JS-1')?.estado]);
    chk('lo que ya coincide no tiene nada que hacer', 'sin-cambios', fila('QA-JS-2')?.estado);
    chk('un producto sin variantes se cruza por el SKU del producto', [502, null],
      [fila('QA-JS-3')?.productId, fila('QA-JS-3')?.variantId]);
    chk('el stock ilimitado no se pisa', ['no-sincronizable', true],
      [fila('QA-JS-4')?.estado, /ilimitado/.test(fila('QA-JS-4')?.motivo || '')]);
    chk('con el SKU repetido se usa la que está a la venta, no la deshabilitada', [505, 1, 504],
      [fila('QA-JS-5')?.productId, fila('QA-JS-5')?.otras?.length, fila('QA-JS-5')?.otras?.[0]?.productId]);
    chk('la simulación no escribe nada', 0, puts());

    tit('4. MANDAR EL STOCK');
    productos = tienda();
    reset();
    const envio = await jumpseller.sincronizarStock(negocio.id, { simular: false });
    const puestos = (sku) => productos.flatMap((p) => (p.variants?.length ? p.variants : [p]))
      .find((x) => x.sku === sku)?.stock;
    chk('la variante queda con el stock de Stocker', 10, puestos('QA-JS-1'));
    chk('y el producto sin variantes también', 5, puestos('QA-JS-3'));
    chk('a la variante se le manda sólo el stock', [{ variant: { stock: 10 } }],
      LLAMADAS.filter((l) => l.metodo === 'put' && l.url.includes('/variants/9001')).map((l) => l.cuerpo));
    chk('al producto se le mandan nombre y precio, que la API pide',
      [{ product: { name: 'Buzo QA', price: 200, stock: 5 } }],
      LLAMADAS.filter((l) => l.metodo === 'put' && l.url.endsWith('/products/502.json')).map((l) => l.cuerpo));
    chk('la deshabilitada con el SKU repetido no se toca', 0,
      LLAMADAS.filter((l) => l.metodo === 'put' && l.url.endsWith('/products/504.json')).length);
    chk('el ilimitado no recibe ningún PUT', 0,
      LLAMADAS.filter((l) => l.metodo === 'put' && l.url.endsWith('/products/503.json')).length);
    chk('el resumen cuenta lo hecho', [3, 1, 1], [envio.resumen.actualizados, envio.resumen.sinCambios, envio.resumen.noSincronizables]);
    chk('queda anotada la última sincronización', true,
      Boolean((await JumpsellerAccount.findOne({ where: { businessId: negocio.id } })).ultimaSync));

    tit('5. EL MARGEN DE SEGURIDAD TAMBIÉN VALE ACÁ');
    productos = tienda();
    await ProductVariant.update({ margenMl: 2 }, { where: { id: variantes[0].id } });
    const conMargen = await jumpseller.sincronizarStock(negocio.id, { simular: true, skus: ['QA-JS-1'] });
    chk('con 10 disponibles y margen 2, se publican 8', [8, 2],
      [conMargen.resultados[0]?.stockStocker, conMargen.resultados[0]?.margen]);
    await ProductVariant.update({ margenMl: 0 }, { where: { id: variantes[0].id } });

    tit('6. UN 429 SE REINTENTA Y UN ERROR NO VOLTEA AL RESTO');
    productos = tienda();
    fallar429 = new Set(['v9001']);
    reset();
    const conLimite = await jumpseller.sincronizarStock(negocio.id, { simular: false });
    chk('la que pegó el límite termina actualizada', 'actualizado',
      conLimite.resultados.find((r) => r.sku === 'QA-JS-1')?.estado);
    chk('se reintentó esa sola', 2, LLAMADAS.filter((l) => l.metodo === 'put' && l.url.includes('/variants/9001')).length);

    productos = tienda();
    productos = productos.filter((p) => p.id !== 502);
    productos.push({ id: 502, name: 'Buzo QA', price: 200, status: 'available', sku: 'QA-JS-3',
      stock: 0, stock_unlimited: false, variants: [], romper: true });
    claveValida = { login: 'LLAVE-QA', token: 'TOKEN-QA' };
    reset();

    tit('7. CADA VENTA LE AVISA A LA TIENDA');
    ml.marcarParaSync = avisoReal;   // de acá en adelante, el aviso real
    productos = tienda();
    // Deja el mapa de la tienda al día y sin nada pendiente.
    await jumpseller.sincronizarStock(negocio.id, { simular: false });
    const esperar = (ms) => new Promise((listo) => setTimeout(listo, ms));
    const enLaTienda = (sku) => productos.flatMap((p) => (p.variants?.length ? p.variants : [p]))
      .find((x) => x.sku === sku)?.stock;
    const listados = () => LLAMADAS.filter((l) => l.metodo === 'get' && l.url.endsWith('/products.json')).length;
    /*
     * Se anota cada sincronización con los SKU que le llegaron: contar sólo los
     * PUT no distingue una tanda de dos, que es justo lo que hay que probar.
     */
    const corridas = [];
    const ventanas = [];
    const sincronizarReal = jumpseller.sincronizarStock;
    jumpseller.sincronizarStock = async (bid, opciones = {}) => {
      if (opciones.skus) corridas.push([...opciones.skus]);
      const desde = Date.now();
      try {
        return await sincronizarReal(bid, opciones);
      } finally {
        if (opciones.skus) ventanas.push([desde, Date.now()]);
      }
    };

    reset();
    await stock.mover({ variantId: variantes[2].id, businessId: negocio.id, locationId: local.id,
      delta: 2, tipo: 'ingreso', motivo: 'QA venta' });
    await esperar(500);
    chk('un movimiento de stock llega solo a la tienda', 7, enLaTienda('QA-JS-3'));
    chk('y no hace falta volver a listar el catálogo', 0, listados());

    // Dos movimientos seguidos son UNA sola tanda, como una venta de dos artículos.
    reset();
    corridas.length = 0;
    await stock.mover({ variantId: variantes[0].id, businessId: negocio.id, locationId: local.id,
      delta: 1, tipo: 'ingreso', motivo: 'QA venta' });
    await stock.mover({ variantId: variantes[2].id, businessId: negocio.id, locationId: local.id,
      delta: 1, tipo: 'ingreso', motivo: 'QA venta' });
    await esperar(500);
    chk('los dos SKU van en la misma tanda', [11, 8], [enLaTienda('QA-JS-1'), enLaTienda('QA-JS-3')]);
    chk('en UNA sola sincronización, no una por artículo', [1, [['QA-JS-1', 'QA-JS-3']]],
      [corridas.length, corridas.map((c) => c.slice().sort())]);

    // Un SKU que la tienda todavía no tenía obliga a listar de nuevo.
    reset();
    const nuevaVariante = await ProductVariant.create({
      productId: prod.id, businessId: negocio.id, sku: 'QA-JS-6',
      variante1Nombre: 'Talle', variante1Valor: '6', stock: 0, stockMinimo: 0,
    });
    productos.push({ id: 506, name: 'Nuevo QA', price: 50, status: 'available', sku: 'QA-JS-6',
      stock: 0, stock_unlimited: false, variants: [] });
    await stock.mover({ variantId: nuevaVariante.id, businessId: negocio.id, locationId: local.id,
      delta: 4, tipo: 'ingreso', motivo: 'QA venta' });
    await esperar(500);
    chk('un SKU que no estaba en el mapa lo vuelve a pedir', [1, 4], [listados(), enLaTienda('QA-JS-6')]);

    // El dueño cambia el precio en su panel: la venta no se lo puede pisar.
    reset();
    productos.find((p) => p.id === 502).price = 150;
    await stock.mover({ variantId: variantes[2].id, businessId: negocio.id, locationId: local.id,
      delta: 1, tipo: 'ingreso', motivo: 'QA venta' });
    await esperar(500);
    chk('el precio que puso el dueño queda como está', 150, productos.find((p) => p.id === 502).price);
    chk('y el stock igual se actualiza', 9, enLaTienda('QA-JS-3'));

    // Un SKU que la tienda no tiene no puede hacer que cada venta liste el catálogo.
    const soloLocal = await ProductVariant.create({
      productId: prod.id, businessId: negocio.id, sku: 'QA-JS-SOLO-LOCAL',
      variante1Nombre: 'Talle', variante1Valor: 'L', stock: 0, stockMinimo: 0,
    });
    await stock.mover({ variantId: soloLocal.id, businessId: negocio.id, locationId: local.id,
      delta: 1, tipo: 'ingreso', motivo: 'QA venta' });
    await esperar(500);
    reset();
    await stock.mover({ variantId: soloLocal.id, businessId: negocio.id, locationId: local.id,
      delta: 1, tipo: 'ingreso', motivo: 'QA venta' });
    await esperar(500);
    chk('un artículo que no está en la tienda no vuelve a pedir el catálogo', 0, listados());

    // Dos tandas a la vez no pueden pisarse: la segunda espera a la primera.
    reset();
    corridas.length = 0;
    ventanas.length = 0;
    aviso.marcar(negocio.id, 'QA-JS-1');
    const primera = aviso.correrPendiente(negocio.id);
    aviso.marcar(negocio.id, 'QA-JS-3');
    const segunda = aviso.correrPendiente(negocio.id);
    await Promise.all([primera, segunda]);
    chk('las dos tandas salieron', 2, ventanas.length);
    chk('pero una después de la otra, sin encimarse', true,
      ventanas.length === 2 && ventanas[1][0] >= ventanas[0][1]);

    // Una sincronización de un SKU no borra el error que dejó el barrido.
    const cuentaJs = await JumpsellerAccount.findOne({ where: { businessId: negocio.id } });
    await cuentaJs.update({ ultimoError: 'error del barrido anterior' });
    await jumpseller.sincronizarStock(negocio.id, { simular: false, skus: ['QA-JS-1'] });
    await cuentaJs.reload();
    chk('una corrida de un SKU no borra el error de la tienda', 'error del barrido anterior', cuentaJs.ultimoError);
    await jumpseller.sincronizarStock(negocio.id, { simular: false });
    await cuentaJs.reload();
    chk('pero una pasada completa sin errores sí lo limpia', null, cuentaJs.ultimoError);

    // Sin tienda conectada no se avisa a nadie, y la venta sigue igual.
    const guardada = await JumpsellerAccount.findOne({ where: { businessId: negocio.id } });
    await guardada.update({ syncActiva: false });
    reset();
    await stock.mover({ variantId: variantes[2].id, businessId: negocio.id, locationId: local.id,
      delta: 1, tipo: 'ingreso', motivo: 'QA venta' });
    await esperar(500);
    chk('con la sincronización apagada no se le manda nada', 0, puts());
    await guardada.update({ syncActiva: true });

    jumpseller.sincronizarStock = sincronizarReal;

    tit('8. EL BARRIDO PERIÓDICO SINCRONIZA LA TIENDA SOLO');
    productos = tienda();
    reset();
    const barrido = await tareas.barrerStockJumpseller();
    chk('toma la tienda conectada y manda lo que hizo falta', [1, true], [barrido.cuentas, barrido.actualizados >= 0]);
    const segundo = await tareas.barrerStockJumpseller();
    chk('y en la segunda pasada ya no hay nada que mandar', 0, segundo.actualizados);

    tit('9. UNA SINCRONIZACIÓN GRANDE CORRE EN SEGUNDO PLANO');
    productos = tienda();
    // Con muchos productos, mandar todo adentro del pedido HTTP lo hacía caer.
    for (let i = 0; i < 120; i++) {
      productos.push({ id: 900 + i, name: `Grande ${i}`, price: 10, status: 'available',
        sku: `QA-JS-G-${i}`, stock: 0, stock_unlimited: false, variants: [] });
    }
    const grandes = [];
    // Cargar 120 artículos no tiene que ir avisando de a uno: lo que se mide
    // acá es la sincronización grande, no el aviso por venta.
    const avisoDeAntes = ml.marcarParaSync;
    ml.marcarParaSync = () => {};
    for (let i = 0; i < 120; i++) {
      const v = await ProductVariant.create({
        productId: prod.id, businessId: negocio.id, sku: `QA-JS-G-${i}`,
        variante1Nombre: 'Talle', variante1Valor: `G${i}`, stock: 0, stockMinimo: 0,
      });
      await stock.mover({ variantId: v.id, businessId: negocio.id, locationId: local.id,
        delta: 2, tipo: 'ingreso', motivo: 'QA grande' });
      grandes.push(v);
    }
    ml.marcarParaSync = avisoDeAntes;

    const clave = `jumpseller:${negocio.id}`;
    const avances = [];
    reset();
    const arranque = trabajos.iniciar(clave, (avisar) => jumpseller.sincronizarStock(negocio.id, {
      simular: false,
      onProgreso: (a) => { avances.push(a); avisar(a); },
    }));
    chk('el pedido contesta en el acto que arrancó', 'corriendo', arranque.estado);
    const otro = trabajos.iniciar(clave, () => { throw new Error('no debería arrancar otro'); });
    chk('y un segundo pedido no arranca otra igual', arranque.id, otro.id);

    const terminado = await trabajos.esperar(clave, { tope: 120000 });
    chk('termina bien', 'listo', terminado.estado);
    chk('y mandó todo lo que había que mandar', 123, terminado.resultado?.resumen?.actualizados);
    chk('fue contando el avance', true,
      avances.length > 1 && avances[avances.length - 1].hechos === avances[avances.length - 1].total);
    chk('la pantalla puede leer cómo viene', ['listo', 123],
      [trabajos.estado(clave).estado, trabajos.estado(clave).resultado?.resumen?.actualizados]);

    productos = tienda();
    const cortado = await jumpseller.sincronizarStock(negocio.id, { simular: true, maxFilas: 2 });
    chk('el detalle no vuelve entero: sería una respuesta impresentable', [2, true],
      [cortado.resultados.length, cortado.truncado]);
    chk('pero las cuentas son de todo', 5,
      Object.values(cortado.resumen).reduce((t, n) => t + n, 0));

    await ProductVariant.destroy({ where: { id: grandes.map((v) => v.id) } });

    tit('10. NO SE LE PEGA A LA TIENDA MÁS RÁPIDO DE LO QUE ACEPTA');
    productos = tienda();
    for (let i = 0; i < 20; i++) {
      productos.push({ id: 800 + i, name: `Ritmo ${i}`, price: 10, status: 'available',
        sku: `QA-JS-R-${i}`, stock: 0, stock_unlimited: false, variants: [] });
    }
    const delRitmo = [];
    const avisoDeAntes2 = ml.marcarParaSync;
    ml.marcarParaSync = () => {};
    for (let i = 0; i < 20; i++) {
      const v = await ProductVariant.create({
        productId: prod.id, businessId: negocio.id, sku: `QA-JS-R-${i}`,
        variante1Nombre: 'Talle', variante1Valor: `R${i}`, stock: 0, stockMinimo: 0,
      });
      await stock.mover({ variantId: v.id, businessId: negocio.id, locationId: local.id,
        delta: 3, tipo: 'ingreso', motivo: 'QA ritmo' });
      delRitmo.push(v);
    }
    ml.marcarParaSync = avisoDeAntes2;

    // La tienda acepta 6 por segundo; Stocker se queda en 4.
    topeMock = 6;
    excedidos = 0;
    pegados.length = 0;
    process.env.JUMPSELLER_POR_SEGUNDO = '4';
    reset();
    const desde = Date.now();
    const conRitmo = await jumpseller.sincronizarStock(negocio.id, { simular: false });
    const tardo = Date.now() - desde;
    chk('la tienda nunca contesta que se pasó del límite', 0, excedidos);
    chk('y se mandó todo igual', 23, conRitmo.resumen.actualizados);
    chk('tardando lo que tiene que tardar', true, tardo >= 3000);
    process.env.JUMPSELLER_POR_SEGUNDO = '1000';
    topeMock = 0;
    await ProductVariant.destroy({ where: { id: delRitmo.map((v) => v.id) } });

    tit('11. TRAER LAS VENTAS ANTERIORES');
    /*
     * Lo mismo que en Mercado Libre: entra lo PAGADO y sin despachar. Una venta
     * ya despachada no se toca —apartarle stock restaría mercadería que ya no
     * está— y el alta va por la cola de ventas online, que es la que aparta.
     */
    const venta = (id, productos2, extra = {}) => ({
      id, total: 100, created_at: new Date().toISOString(),
      customer: { name: 'Ana', surname: 'Pérez', email: 'ana@qa.test' },
      products: productos2, ...extra,
    });
    ORDENES = [
      venta('QA5001', [{ id: 1, variant_id: 11, sku: 'QA-JS-1', qty: 1, price: 100, name: 'Remera QA' }]),
      venta('QA5002', [{ id: 2, variant_id: 12, sku: '', qty: 1, price: 50, name: 'Sin SKU' }]),
      venta('QA5003', []),
    ];
    reset();
    const traida = await jumpseller.importarPedidos(negocio.id, { dias: 30 });
    const pedidoOrders = LLAMADAS.find((l) => l.url.endsWith('/orders.json'));
    chk('le pide a la tienda sólo las pagadas y sin despachar',
      ['paid', 'unfulfilled', 'customDate'],
      [pedidoOrders?.params?.['status_filters[]'], pedidoOrders?.params?.fulfillment_filters,
        pedidoOrders?.params?.dateFilter]);
    chk('y con el rango de fechas puesto', true,
      /^\d{4}-\d{2}-\d{2}$/.test(pedidoOrders?.params?.initialDate || ''));
    chk('encuentra las tres ventas', 3, traida.encontrados);
    chk('las dos con líneas quedan registradas', 2, traida.importados);
    chk('la que trae una línea sin SKU se cuenta aparte', 1, traida.sinSku);
    chk('pero queda registrada igual, para que no se pierda', 1,
      await PedidoPlataforma.count({ where: { businessId: negocio.id, pedidoExterno: 'QA5002' } }));
    chk('la venta sin líneas no se importa y se cuenta', [1, 0],
      [traida.sinLineas,
        await PedidoPlataforma.count({ where: { businessId: negocio.id, pedidoExterno: 'QA5003' } })]);
    chk('la del SKU conocido aparta stock', 'QA-JS-1', (await PedidoPlataformaItem.findOne({
      where: { pedidoId: (await PedidoPlataforma.findOne({ where: { businessId: negocio.id, pedidoExterno: 'QA5001' } })).id },
    })).sku);

    const deNuevo = await jumpseller.importarPedidos(negocio.id, { dias: 30 });
    chk('importar de nuevo no duplica', [0, 2], [deNuevo.importados, deNuevo.repetidos]);

    const unAno = await jumpseller.importarPedidos(negocio.id, { dias: 900 });
    chk('pedir más de un año se acota a 365 días', 365, unAno.dias);

    ORDENES = ['QA5010', 'QA5011', 'QA5012', 'QA5013'].map((id) => venta(id,
      [{ id: 9, variant_id: 99, sku: 'QA-JS-2', qty: 1, price: 10, name: 'Otra' }]));
    const cortada = await jumpseller.importarPedidos(negocio.id, { dias: 30, tope: 2 });
    chk('con un tope chico trae sólo eso y avisa', [2, true], [cortada.encontrados, cortada.truncado]);
    ORDENES = [];

    tit('12. SIN TIENDA CONECTADA, NO SE SINCRONIZA');
    await JumpsellerAccount.destroy({ where: { businessId: negocio.id } });
    const sinCuenta = await falla(() => jumpseller.sincronizarStock(negocio.id, { simular: true }));
    chk('avisa que falta conectar la tienda', [400, true],
      [sinCuenta?.status, /Jumpseller/.test(sinCuenta?.message || '')]);
  } finally {
    tit('Limpieza');
    await limpiar();
    chk('no queda nada de la prueba', [0, 0],
      [await ProductVariant.count({ where: { sku: { [Op.like]: 'QA-JS-%' } } }),
        await JumpsellerAccount.count({ where: { businessId: negocio.id } })]);
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
