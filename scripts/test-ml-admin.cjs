/*
 * Administrar las publicaciones y calcular precios: los problemas por grupo, la
 * búsqueda del precio con el umbral de envío, el neto con el extra, el límite
 * del 60 %, el corte del renombre y que no se escriba en una publicación ajena.
 *
 * Todo con una Mercado Libre y modelos falsos: sin base ni red.
 *
 * Uso:  DATABASE_URL=postgres://nadie@127.0.0.1:1/no_conectar node scripts/test-ml-admin.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const { MercadoLibreAccount, MercadoLibreLink } = require('../src/models');
const ml = require('../src/services/mercadolibreService');
const pub = require('../src/services/mercadolibrePublicarService');
const stockService = require('../src/services/stockService');
const publicables = require('../src/services/stockPublicableService');
const a = require('../src/services/mercadolibreAdminService');

let ok = 0;
let ko = 0;
const chk = (t, esperado, obtenido) => {
  const igual = JSON.stringify(esperado) === JSON.stringify(obtenido);
  console.log(`  ${igual ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${t}`);
  if (!igual) console.log(`      esperaba ${JSON.stringify(esperado)} · vino ${JSON.stringify(obtenido)}`);
  igual ? (ok += 1) : (ko += 1);
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const errorMl = (status, message) => Object.assign(new Error(String(status)), { response: { status, data: { message } } });
const P = pub.PARAMETROS_POR_DEFECTO;

// ── La Mercado Libre falsa ───────────────────────────────────────
const producto = { id: 10, titulo: 'Remera Lisa', skuAgrupador: 'REM', costo: 5000 };
const variante = (id, sku, color, talle, costo = null) => ({ id, sku, costo, producto, variante1Nombre: 'Color', variante1Valor: color, variante2Nombre: 'Talle', variante2Valor: talle });
const stocker = [variante(1, 'N-S', 'Negro', 'S'), variante(2, 'N-M', 'Negro', 'M'), variante(3, 'N-L', 'Negro', 'L')];
const mkItem = (id, sku, color, talle, extra = {}) => ({
  id, seller_id: 77, family_name: 'Remera Lisa', category_id: 'MLA109042', listing_type_id: 'gold_special', status: 'active', condition: 'new',
  price: 20000, available_quantity: 4, shipping: { mode: 'me2', logistic_type: 'xd_drop_off', free_shipping: false },
  attributes: [{ id: 'COLOR', value_name: color }, { id: 'SIZE', value_name: talle }, { id: 'SELLER_SKU', value_name: sku }], ...extra,
});
let items;
const reiniciar = () => {
  items = {
    MLA1: mkItem('MLA1', 'N-S', 'Negro', 'S'), MLA2: mkItem('MLA2', 'N-M', 'Negro', 'M'), MLA3: mkItem('MLA3', 'N-L', 'Negro', 'L'),
    MLA999: mkItem('MLA999', 'N-S', 'Negro', 'S', { seller_id: 1 }),
  };
};
reiniciar();
const escrituras = [];
let links = [];
const linkCambios = [];
let rechazarPut = () => null;

// Comisión 15 %, costo fijo por tramo bajo 33000, envío 7000.
const costoFijo = (precio) => (precio < 15000 ? 1000 : precio < 33000 ? 2000 : 0);
const precios = (query, cuotas = 0) => {
  const pct = 15 + cuotas;
  const fijo = costoFijo(query.price);
  return { listing_type_id: query.listing_type_id, sale_fee_amount: Math.round((query.price * pct / 100 + fijo) * 100) / 100,
    sale_fee_details: { percentage_fee: pct, meli_percentage_fee: 15, financing_add_on_fee: cuotas, fixed_fee: fijo } };
};
const consultas = [];
const httpFalso = {
  get: async (url, o = {}) => {
    if (url.endsWith('/items')) return { data: o.params.ids.split(',').map((id) => ({ code: 200, body: items[id] })) };
    if (url.includes('/listing_prices')) { consultas.push(o.params); return { data: precios(o.params, o.params.tags ? 8 : 0) }; }
    if (url.includes('/shipping_options/free')) { consultas.push(o.params); return { data: { coverage: { all_country: { list_cost: 7000, currency_id: 'ARS' } } } }; }
    if (url.includes('/categories/')) return { data: { settings: { max_title_length: 30 } } };
    throw new Error(`pedido inesperado ${url}`);
  },
  put: async (url, cuerpo) => {
    const id = url.split('/items/')[1].split(/[/?]/)[0];
    escrituras.push([id, cuerpo]);
    const e = rechazarPut(id, cuerpo);
    if (e) throw e;
    return { data: {} };
  },
  post: async (url, cuerpo) => { escrituras.push([url, cuerpo]); return { data: {} }; },
};

Object.assign(ml.httpML, httpFalso);
ml.tokenValido = async () => 't';
ml.traerItems = async (ids) => ids.map((id) => items[id]).filter(Boolean);
ml.destinosDeLaCuenta = async () => ({
  publicaciones: Object.values(items),
  porSku: new Map([['N-S', { mlItemId: 'MLA1' }], ['N-M', { mlItemId: 'MLA2' }], ['N-L', { mlItemId: 'MLA3' }]]),
});
MercadoLibreAccount.findOne = async () => ({ businessId: 1, mlUserId: '77', publicarConfig: null });
MercadoLibreLink.findAll = async () => links;
MercadoLibreLink.update = async (cambios, { where }) => { linkCambios.push([where.businessId, where.mlItemId, cambios]); };
stockService.localesQueAbastecenOnline = async () => [{ id: 1 }];
publicables.variantesPublicables = async () => stocker;
publicables.cantidadesPublicables = async () => new Map([[1, { cantidad: 4 }], [2, { cantidad: 4 }], [3, { cantidad: 4 }]]);

(async () => {
  tit('Mis publicaciones: grupos y problemas');
  let l = await a.listar(1, { fresco: true });
  chk('una familia, sin la publicación de otro vendedor', [1, ['MLA1', 'MLA2', 'MLA3']], [l.total, l.grupos[0].variantes.map((v) => v.itemId)]);
  chk('todo bien: sin problemas', [], l.grupos[0].problemas);
  items.MLA2 = mkItem('MLA2', 'N-M', 'Negro mate', 'M', { status: 'paused', available_quantity: 0 });
  items.MLA4 = mkItem('MLA4', 'N-S', 'Negro', 'S', { listing_type_id: 'gold_pro' });
  items.MLA5 = mkItem('MLA5', 'OTRO', 'Negro', 'L', { family_name: null, title: 'Suelta' });
  l = await a.listar(1, { fresco: true });
  const fam = l.grupos.find((g) => g.familyName);
  chk('color repartido, pausada con stock y stock distinto', ['COLOR_REPARTIDO', 'PAUSADA_CON_STOCK', 'STOCK_DISTINTO'], fam.problemas.map((p) => p.codigo));
  chk('mismo color y talle con otro tipo de publicación no es repetida', false, fam.problemas.some((p) => p.codigo === 'REPETIDA'));
  chk('el modelo viejo es su propio grupo y está sin vincular', [['SIN_VINCULAR'], 'clasico'], [l.grupos.find((g) => !g.familyName).problemas.map((p) => p.codigo), l.grupos.find((g) => !g.familyName).modelo]);
  items.MLA4.listing_type_id = 'gold_special';
  l = await a.listar(1, { fresco: true });
  chk('con el mismo tipo sí es repetida', ['MLA1', 'MLA4'], l.grupos.find((g) => g.familyName).problemas.find((p) => p.codigo === 'REPETIDA').itemIds);
  chk('filtro por texto y paginado', [1, 'Suelta', 2], await a.listar(1, { buscar: 'suel', porPagina: 1 }).then(async (r) => [r.total, r.grupos[0].nombre, (await a.listar(1, { porPagina: 1 })).paginas]));
  reiniciar();

  tit('Ninguna escritura en una publicación ajena');
  escrituras.length = 0;
  const intentos = [
    () => a.guardarDescripcion(1, { itemIds: ['MLA1', 'MLA999'], texto: 'x' }),
    () => a.renombrar(1, { itemIds: ['MLA999'], nombre: 'x' }),
    () => a.cambiarEstado(1, { itemIds: ['MLA1', 'MLA999'], estado: 'paused' }),
    () => a.cambiarEstado(1, { itemIds: ['MLA999'], estado: 'active' }),
    () => a.unificarColores(1, { itemIds: ['MLA1', 'MLA999'] }),
    () => a.prepararPrecios(1, { cambios: [{ itemId: 'MLA1', precio: 20000 }, { itemId: 'MLA999', precio: 20000, confirmado: true }] }),
    () => a.calcular(1, { itemId: 'MLA999', precio: 100 }),
    () => a.leerDescripcion(1, 'MLA999'),
    () => a.cambiarEstado(1, { itemIds: ['MLA123456'], estado: 'paused' }),
  ];
  const estados = [];
  for (const f of intentos) estados.push((await falla(f))?.status);
  chk('todas responden 403', intentos.map(() => 403), estados);
  chk('y no se escribió nada, ni en las propias del mismo pedido', [], escrituras);
  chk('un id con forma rara es 400', 400, (await falla(() => a.cambiarEstado(1, { itemIds: ['MLA1/../x'], estado: 'paused' }))).status);

  tit('Descripción y pausa');
  rechazarPut = (id) => (id === 'MLA2' ? errorMl(400, 'item.description.type.invalid') : null);
  const d = await a.guardarDescripcion(1, { itemIds: ['MLA1', 'MLA2', 'MLA3'], texto: 'Talle < 40 >\r\nAlgodón' });
  chk('un error no frena al resto y sale textual', [2, 1, 'ML 400: item.description.type.invalid'], [d.cambiadas, d.fallaron, d.resultados[1].error]);
  chk('texto plano tal cual lo escribió', 'Talle < 40 >\nAlgodón', escrituras[0][1].plain_text);

  const deMl = a.conMotivo(Object.assign(new Error('x'), { isAxiosError: true, config: { method: 'get', url: 'https://api.mercadolibre.com/items/bulk?ids=MLA1' }, response: { status: 429, data: { message: 'too_many_requests' } } }));
  chk('un rechazo de ML sale con el pedido y su texto, no como error interno', [502, true], [deMl.status, /GET \/items\/bulk\). ML 429: too_many_requests/.test(deMl.message)]);
  const propio = new Error('bug');
  chk('un error que no es de ML queda como estaba', [propio, undefined], [a.conMotivo(propio), propio.status]);

  tit('Renombrar: se corta en el primer error');
  escrituras.length = 0;
  const n = await a.renombrar(1, { itemIds: ['MLA1', 'MLA2', 'MLA3'], nombre: 'Remera  Nueva' });
  chk('después del error no se manda nada más', ['MLA1', 'MLA2'], escrituras.map((e) => e[0]));
  chk('se manda family_name', { family_name: 'Remera Nueva' }, escrituras[0][1]);
  chk('estado por ítem', ['cambiada', 'error', 'no-intentada'], n.resultados.map((r) => r.estado));
  chk('cuántas quedaron cambiadas y cuántas no', [true, 1, 2], [n.cortado, n.cambiadas, n.sinCambiar]);
  rechazarPut = () => null;
  escrituras.length = 0;
  chk('el grupo a medias se rechaza', 400, (await falla(() => a.renombrar(1, { itemIds: ['MLA1', 'MLA2'], nombre: 'Corto' }))).status);
  chk('más largo que lo que admite la categoría', true, /admite 30/.test((await falla(() => a.renombrar(1, { itemIds: ['MLA1', 'MLA2', 'MLA3'], nombre: 'x'.repeat(31) }))).message));
  chk('ninguno de los dos escribió', [], escrituras);

  tit('Unificar colores');
  items.MLA3.attributes[0] = { id: 'COLOR', value_name: 'Negro mate' };
  escrituras.length = 0;
  const u = await a.unificarColores(1, { itemIds: ['MLA1', 'MLA2', 'MLA3'] });
  chk('sólo al que se desvió, y sólo el atributo COLOR', [[['MLA3', { attributes: [{ id: 'COLOR', value_name: 'Negro' }] }]], 1, 0], [escrituras, u.unificados, u.fallaron]);
  reiniciar();

  tit('El costo de un precio');
  const base = { item: items.MLA1, params: P, pesoGramos: 300, mlUserId: '77', headers: {}, http: httpFalso };
  consultas.length = 0;
  const x = await a.cotizar({ ...base, precio: 20000, extraPct: 10 });
  chk('el neto se calcula sobre el precio con el descuento', [18000, 2700, 2000, 13300], [x.precioConDescuento, x.cargoVender, x.costoFijo, x.leQueda]);
  chk('a ML se le pregunta por el precio con descuento, con peso y logística', [18000, 300, 'xd_drop_off', 'me2'], [consultas[0].price, consultas[0].billable_weight, consultas[0].logistic_type, consultas[0].shipping_mode]);
  const y = await a.cotizar({ ...base, item: { ...items.MLA1, tags: ['3x_campaign'], listing_type_id: 'gold_pro' }, precio: 40000 });
  chk('sobre el umbral con cuotas: cargo, cuotas, envío e impuestos', [6000, 3200, 7000, 2000, 21800], [y.cargoVender, y.costoCuotas, y.envio, y.impuestos, y.leQueda]);
  const mudo = await falla(() => a.cotizar({ ...base, precio: 20000, http: { get: async () => ({ data: {} }) } }));
  chk('si ML no trae el cargo no se estima con los porcentajes fijos', [502, true], [mudo.status, /No se pudo calcular/.test(mudo.message)]);
  const caido = await falla(() => a.cotizar({ ...base, precio: 20000, http: { get: async () => { throw errorMl(500, 'caído'); } } }));
  chk('si ML falla, sale su error', true, /ML 500: caído/.test(caido.message));
  const sinCuotas = await falla(() => a.cotizar({ ...base, item: { ...items.MLA1, tags: ['3x_campaign'] }, precio: 20000, http: { get: async (u, o) => ({ data: precios(o.params, 0) }) } }));
  chk('con campaña y sin costo de cuotas: no se calcula', true, /cuotas/.test(sinCuotas.message));
  const conTermino = async (extra, value_name) => {
    consultas.length = 0;
    const e = await falla(() => a.cotizar({ ...base, item: { ...items.MLA1, ...extra, sale_terms: [{ id: 'INSTALLMENTS_CAMPAIGN', value_name }] }, precio: 20000 }));
    return e ? e.status : consultas[0].tags;
  };
  chk('con otra campaña en tags no se suma la de 3 cuotas', '12x_campaign', await conTermino({ tags: ['12x_campaign'] }, '12x_campaign'));
  chk('el término que dice 3x cotiza 3 cuotas', '3x_campaign', await conTermino({}, '3x_campaign'));
  chk('el término de otra campaña, sin tag: no se calcula', [502, 502], [await conTermino({}, '9x_campaign'), await conTermino({ listing_type_id: 'gold_pro' }, undefined)]);
  const sinEnvio = await falla(() => a.cotizar({ ...base, precio: 40000, http: { get: async (u, o) => (u.includes('shipping') ? { data: {} } : { data: precios(o.params) }) } }));
  chk('sin costo de envío: no se calcula', true, /envío/.test(sinEnvio.message));

  tit('La búsqueda del precio, con el umbral y los tramos');
  // La cuenta a mano de la ML falsa, para comparar con la búsqueda barriendo peso por peso.
  const neto = (precio, e) => {
    const c = e ? pub.precioConDescuento(precio, e) : precio;
    return Math.round((c - precios({ price: c }).sale_fee_amount - (precio >= P.umbral ? 7000 + P.impuestos : 0)) * 100) / 100;
  };
  const minimo = (obj, e) => { for (let p = 1; ; p++) if (neto(p, e) >= obj) return p; };
  for (const [nombre, objetivo, e] of [
    ['bajo el umbral', 11500, 0], ['bajo el umbral con extra 5', 11500, 5], ['lo que ya no entra bajo el umbral', 28000, 0],
    ['entre el neto de arriba y el de abajo del umbral: gana el de abajo', 25000, 0], ['lejos arriba, con extra 30', 80000, 30], ['apenas cruza con extra', 24500, 5],
  ]) {
    const evaluar = (precio) => a.cotizar({ ...base, precio, extraPct: e });
    const r = await a.buscarPrecio({ objetivo, extraPct: e, umbral: P.umbral, evaluar });
    chk(`${nombre}: el mínimo (${minimo(objetivo, e)}), verificado y con tope`, [minimo(objetivo, e), true, true], [r.desglose.precio, r.desglose.leQueda >= objetivo, r.consultas <= 31]);
  }
  // Costo fijo que sube cerca del umbral: justo debajo no alcanza, pero más abajo sí.
  const escalon = async (precio) => {
    const fijo = precio < 30000 ? 1330 : precio < 33000 ? 4550 : 0;
    return { precio, costoFijo: fijo, leQueda: precio * 0.85 - fijo - (precio >= 33000 ? 9000 : 0), pendiente: 0.85 };
  };
  const bajo = await a.buscarPrecio({ objetivo: 23500, umbral: 33000, evaluar: escalon });
  chk('tramo caro justo bajo el umbral: busca debajo antes de pasar arriba', [29212, true], [bajo.desglose.precio, bajo.minimoExacto]);
  const sinEnvioArriba = async (precio) => { const r = await escalon(precio); return precio < 33000 ? r : { ...r, leQueda: precio * 0.85 }; };
  const corto = await a.buscarPrecio({ objetivo: 23500, umbral: 33000, evaluar: sinEnvioArriba, tope: 2 });
  chk('si no llegó a mirar el tramo de abajo, no dice que es el mínimo', [33000, false], [corto.desglose.precio, corto.minimoExacto]);
  let veces = 0;
  const cambia = await falla(() => a.buscarPrecio({ objetivo: 10000, umbral: P.umbral, evaluar: async (precio, o) => { veces += 1; return { precio, leQueda: precio * 0.8 - (o?.fresco ? 500 : 0), pendiente: 0.8 }; } }));
  chk('si al verificar ML cobra otra cosa, no se devuelve el precio', 502, cambia?.status);
  const imposible = await falla(() => a.buscarPrecio({ objetivo: 10000, umbral: P.umbral, evaluar: async (precio) => ({ precio, leQueda: 0, pendiente: 0.8 }) }));
  chk('si no se llega, corta en el tope', 502, imposible?.status);
  const porDefecto = await a.calcular(1, { itemId: 'MLA1' });
  chk('por defecto busca costo × multiplicador + packing y da la ganancia', [11500, true, Math.round((porDefecto.desglose.leQueda - 5000) * 100), false], [porDefecto.objetivo, porDefecto.desglose.leQueda >= 11500, Math.round(porDefecto.desglose.ganancia * 100), porDefecto.desglose.bajoPiso]);
  links = [{ mlItemId: 'MLA1', sku: 'N-S', descuentoPct: 10 }];
  const conExtra = await a.calcular(1, { itemId: 'MLA1', precio: 20000 });
  chk('el extra sale del descuento de la publicación', [10, 18000], [conExtra.extraPct, conExtra.desglose.precioConDescuento]);

  links = [];
  items.MLA1.price = 16000; items.MLA1.original_price = 20000;
  const hoy = await a.calcular(1, { itemId: 'MLA1', precio: 20000 });
  chk('al precio de hoy con un descuento ajeno, queda según lo que se cobra', [20000, 16000, 11600], [hoy.desglose.precio, hoy.desglose.precioConDescuento, hoy.desglose.leQueda]);
  chk('otro precio u otro extra: se calcula lo pedido', [21000, 20000], [(await a.calcular(1, { itemId: 'MLA1', precio: 21000 })).desglose.precioConDescuento, (await a.calcular(1, { itemId: 'MLA1', precio: 20000, extraPct: 0 })).desglose.precioConDescuento]);
  reiniciar();

  tit('Precios en tanda: el límite del 60 % y el descuento');
  links = [{ mlItemId: 'MLA1', sku: 'N-S', descuentoPct: 10 }];
  const rechazo = async (precio, confirmado) => (await falla(() => a.prepararPrecios(1, { cambios: [{ itemId: 'MLA1', precio, confirmado }] })))?.detalles?.rechazados?.[0];
  chk('+60 % justo pasa', undefined, await rechazo(32000));
  chk('-60 % justo pasa', undefined, await rechazo(8000));
  chk('más de +60 % pide confirmación', true, (await rechazo(32001))?.requiereConfirmacion);
  chk('más de -60 % pide confirmación', true, (await rechazo(7999))?.requiereConfirmacion);
  chk('confirmado pasa', undefined, await rechazo(100000, true));
  chk('confirmado "de texto" no vale', true, Boolean(await rechazo(100000, 'true')));
  chk('0 o negativo no pasa ni confirmado', [false, false], [(await rechazo(0, true)).requiereConfirmacion, (await rechazo(-5, true)).requiereConfirmacion]);
  chk('un texto no es un precio', true, Boolean(await rechazo('20000', true)));
  items.MLA1.price = 10000; items.MLA1.original_price = 20000;
  chk('se compara contra el precio de lista, no el rebajado', undefined, await rechazo(25000));
  reiniciar();
  escrituras.length = 0;
  chk('con uno rechazado no se aplica ninguno', [400, []], [(await falla(() => a.prepararPrecios(1, { cambios: [{ itemId: 'MLA1', precio: 21000 }, { itemId: 'MLA2', precio: 1 }] }))).status, escrituras]);
  const plan = await a.prepararPrecios(1, { cambios: [{ itemId: 'MLA1', precio: 21000 }, { itemId: 'MLA2', precio: 22000 }] });
  linkCambios.length = 0;
  rechazarPut = (id) => (id === 'MLA2' ? errorMl(400, 'price is not modifiable alone') : null);
  const ap = await a.aplicarPrecios(plan, { esperar: async () => {} });
  chk('el PUT lleva sólo el precio', [['MLA1', { price: 21000 }], ['MLA2', { price: 22000 }]], escrituras);
  chk('error textual por ítem', [1, 1, 'ML 400: price is not modifiable alone'], [ap.cambiados, ap.fallaron, ap.porItem.MLA2.error]);
  chk('sólo el que cambió queda para reponer el descuento, y del negocio', [[1, 'MLA1', { descuentoHasta: null }]], linkCambios);
  linkCambios.length = 0;
  rechazarPut = () => errorMl(503, 'x');
  await a.aplicarPrecios(plan, { esperar: async () => {} });
  chk('con un 5xx no se sabe si entró: se repone igual', ['MLA1', 'MLA2'], linkCambios.map((c) => c[1]));
  rechazarPut = () => null;
  const vp = await a.vistaPreviaPrecios(1, { cambios: [{ itemId: 'MLA1' }, { itemId: 'MLA2', precio: 8000 }] });
  chk('vista previa: sugiere desde el objetivo, con el extra del ítem', [true, 10, true], [vp.filas[0].sugerido, vp.filas[0].extraPct, vp.filas[0].despues.leQueda >= 11500]);
  chk('marca el que queda bajo costo + packing; -60 % justo no pide confirmación', [false, true, false], [vp.filas[0].despues.bajoPiso, vp.filas[1].despues.bajoPiso, vp.filas[1].requiereConfirmacion]);
  chk('trae lo que queda hoy', 15000, vp.filas[1].antes.leQueda);

  console.log(`\nPasaron ${ok} de ${ok + ko}`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
