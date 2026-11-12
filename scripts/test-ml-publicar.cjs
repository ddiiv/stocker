/*
 * Publicar en Mercado Libre en tanda: el precio "al revés", las fotos por color,
 * el cuerpo de cada ítem y la tanda (saltear lo ya publicado, reintentar 429).
 *
 * Todo con servidores falsos y sin base: no toca Mercado Libre ni la tienda.
 *
 * Uso:  DATABASE_URL=postgres://nadie@127.0.0.1:1/no_conectar node scripts/test-ml-publicar.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const s = require('../src/services/mercadolibrePublicarService');

let ok = 0;
let ko = 0;
const chk = (t, esperado, obtenido) => {
  const igual = JSON.stringify(esperado) === JSON.stringify(obtenido);
  console.log(`  ${igual ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${t}`);
  if (!igual) console.log(`      esperaba ${JSON.stringify(esperado)} · vino ${JSON.stringify(obtenido)}`);
  igual ? (ok += 1) : (ko += 1);
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const P = s.PARAMETROS_POR_DEFECTO;
const sinEspera = async () => {};

(async () => {
  tit('Precio: lo que queda después de lo que cobra ML');
  const barato = s.precioMl(5000, P);       // neto 11500 → 13609 sin envío; /0,95 = 14325 < umbral
  chk('bajo el umbral: sin envío ni cuotas', [false, false], [barato.llevaEnvio, barato.llevaCuotas]);
  chk('bajo el umbral: neto = costo × 2 + packing', 11500, barato.neto);
  chk('bajo el umbral: con el descuento y la comisión queda el neto', true, barato.leQueda >= barato.neto - 0.01 && barato.leQueda < barato.neto + 15);
  chk('publicado en pesos enteros', true, Number.isInteger(barato.publicado));
  chk('con descuento = publicado × 0,95', Math.round(barato.publicado * 0.95 * 100) / 100, barato.conDescuento);
  const caro = s.precioMl(20000, P);        // neto 41500 → sobre el umbral
  chk('sobre el umbral: envío gratis y cuotas', [true, true], [caro.llevaEnvio, caro.llevaCuotas]);
  chk('sobre el umbral: el precio paga envío, impuestos y cuotas y queda el neto', true, caro.leQueda >= caro.neto - 0.01 && caro.leQueda < caro.neto + 15);
  chk('sobre el umbral: base = (neto + envío + impuestos) / (1 − 0,155 − 0,085) / 0,95', Math.ceil((41500 + 7000 + 2000) / 0.76 / 0.95), caro.publicado);
  const sinExtra = s.precioMl(5000, { ...P, extraPct: 0 });
  chk('sin extra, publicado = descuento', sinExtra.publicado, sinExtra.conDescuento);
  // Borde: comisión 50 %, sin extra, multiplicador 1, packing 0 → publicadoSinEnvio = 2 × costo.
  const B = { ...P, multiplicador: 1, packing: 0, comisionPct: 50, extraPct: 0, umbral: 1000 };
  chk('un peso bajo el umbral no lleva envío', false, s.precioMl(499, B).llevaEnvio);
  chk('justo en el umbral sí lleva (ML lo obliga "desde" ese precio)', [true, true], [s.precioMl(500, B).llevaEnvio, s.precioMl(500, B).publicado >= 1000]);
  chk('el borde del dueño: costo 12495 da 33000 y lleva envío', true, s.precioMl(12495, P).llevaEnvio);
  chk('el costo 0 no rompe la cuenta', true, Number.isFinite(s.precioMl(0, P).publicado));

  tit('Parámetros');
  chk('valores por defecto del dueño', [2, 1500, 15.5, 8.5, 7000, 2000, 33000, 5], [P.multiplicador, P.packing, P.comisionPct, P.cuotasPct, P.envioGratis, P.impuestos, P.umbral, P.extraPct]);
  const mal = (c) => { try { s.validarParametros(c); return 'aceptó'; } catch (e) { return e.status; } };
  chk('un porcentaje de 100 se rechaza', 400, mal({ comisionPct: 100 }));
  chk('comisión + cuotas ≥ 100 se rechaza', 400, mal({ comisionPct: 60, cuotasPct: 40 }));
  chk('una tienda que no es https se rechaza', 400, mal({ tiendaUrl: 'http://x.com' }));
  chk('unas fotos que no son https se rechazan', 400, mal({ fotosUrl: 'http://fotos.x.com' }));
  chk('las fotos quedan sin barra final; vacías se aceptan', ['https://fotos.x.com', 'aceptó'], [s.validarParametros({ fotosUrl: 'https://fotos.x.com/' }).fotosUrl, mal({ fotosUrl: '' })]);
  chk('texto en un número se rechaza', 400, mal({ packing: 'mucho' }));
  chk('los de fábrica pasan', 'aceptó', mal({}));

  tit('Fotos por color');
  const tienda = 'https://tienda.test';
  const cdn = 'https://fotos.test';
  const detalle = {
    sku: 'REM',
    exhibicion: [{ clave: 'gen1', color: null }, { clave: 'neg0', color: 'negro' }],
    colores: [
      { clave: 'negro', fotos: [{ clave: 'neg1' }, { clave: 'neg2' }] },
      { clave: 'blanco', fotos: [{ clave: 'bla1' }] },
      { clave: 'rojo', fotos: [] },
    ],
    variantes: [
      { sku: 'REM-N-S', color: 'negro' }, { sku: 'REM-B-S', color: 'blanco' },
      { sku: 'REM-R-S', color: 'rojo' }, { sku: 'REM-X-S', color: null },
    ],
  };
  const f = new Map(s.fotosPorColor(detalle, cdn));
  const u = (c) => `${cdn}/${c}-1200.jpg`;
  chk('propias (la exhibición de su color primero)', [u('neg0'), u('neg1'), u('neg2')], f.get('REM-N-S'));
  chk('propias de otro color: sólo las de él', [u('bla1')], f.get('REM-B-S'));
  chk('sin propias: las generales', [u('gen1')], f.get('REM-R-S'));
  chk('sin color: las generales', [u('gen1')], f.get('REM-X-S'));
  chk('nunca las de otro color', false, f.get('REM-R-S').some((x) => /neg|bla/.test(x)));
  const sinNada = new Map(s.fotosPorColor({ ...detalle, exhibicion: [] }, cdn));
  chk('sin propias ni generales: ninguna', [], sinNada.get('REM-R-S'));

  tit('Índice de la tienda (con la tienda falsa)');
  s.__limpiarCache();
  let pedidosTienda = 0;
  const httpTienda = { get: async (url) => {
    pedidosTienda += 1;
    if (url.endsWith('/v1/productos-slugs')) return { data: [{ slug: 'remera' }, { slug: 'rota' }] };
    if (url.endsWith('/v1/productos/remera')) return { data: detalle };
    throw new Error('timeout');
  } };
  const indice = await s.indiceDeFotos(tienda, cdn, { http: httpTienda, esperar: sinEspera });
  chk('lee los productos que responden', [4, 1], [indice.porSku.size, indice.fallidos]);
  chk('con huecos no se guarda en la caché: la segunda vez vuelve a leer', 6, (await s.indiceDeFotos(tienda, cdn, { http: httpTienda, esperar: sinEspera }), pedidosTienda));
  // 429 de la API de la tienda (límite por IP): se espera y se reintenta, y el índice sale completo.
  s.__limpiarCache();
  let bloqueos = 0;
  const httpLimitada = { get: async (url) => {
    if (url.endsWith('/v1/productos/remera') && bloqueos < 2) { bloqueos += 1; throw Object.assign(new Error('429'), { response: { status: 429, headers: { 'retry-after': '1' } } }); }
    if (url.endsWith('/v1/productos-slugs')) return { data: [{ slug: 'remera' }] };
    return { data: detalle };
  } };
  const completo = await s.indiceDeFotos(tienda, cdn, { http: httpLimitada, esperar: sinEspera });
  chk('un 429 de la tienda se reintenta: sin fallidos', [4, 0], [completo.porSku.size, completo.fallidos]);
  let lecturas = 0;
  const httpBuena = { get: async (url) => { lecturas += 1; return { data: url.endsWith('/v1/productos-slugs') ? [{ slug: 'remera' }] : detalle }; } };
  await s.indiceDeFotos(tienda, cdn, { http: httpBuena, esperar: sinEspera });
  chk('completo sí se guarda en la caché', 0, lecturas);

  tit('La publicación modelo, leída de una ML falsa');
  const mlFalso = (extra = {}) => ({ get: async (url) => {
    if (url.includes('/items/MLA1')) {
      return { data: {
        id: 'MLA1', seller_id: 77, title: 'Remera modelo', category_id: 'MLA109042', listing_type_id: 'gold_pro',
        tags: ['3x_campaign'], shipping: { mode: 'me2', logistic_type: 'xd_drop_off', free_shipping: false, dimensions: '1x1x1,1' },
        sale_terms: [{ id: 'WARRANTY_TYPE', value_id: '2230280', value_name: 'Garantía del vendedor' }, { id: 'INSTALLMENTS_CAMPAIGN', value_name: '3x_campaign' }],
        attributes: [
          { id: 'PACKAGE_WEIGHT', value_name: '300 g' }, { id: 'FILTRABLE_GENDER', value_name: 'Hombre' }, { id: 'IS_TOM_BRAND', value_name: 'No' },
          { id: 'BRAND', value_name: 'Isuwaya' }, { id: 'GENDER', value_id: '339665', value_name: 'Hombre' },
          { id: 'COLOR', value_name: 'Verde' }, { id: 'SELLER_SKU', value_name: 'VIEJO' }, { id: 'SIZE', value_name: 'M' },
          { id: 'GTIN', value_name: '123' }, { id: 'MODEL', value_name: null }, { id: 'SIZE_GRID_ID', value_name: '555' },
        ],
        ...extra,
      } };
    }
    if (url.includes('/catalog/charts/555')) {
      return { data: { id: 555, names: { MLA: 'Guía remeras' }, rows: ['S', 'M', 'L'].map((t, i) => ({ id: `555:${i + 1}`, attributes: [{ id: 'SIZE', values: [{ name: t }] }] })) } };
    }
    if (url.includes('/categories/')) return { data: { max_pictures_per_item_var: 3 } };
    throw new Error(`pedido inesperado ${url}`);
  } });
  const modelo = await s.leerModelo('MLA1', { headers: {}, http: mlFalso(), mlUserId: '77' });
  chk('copia categoría, tipo, tag de cuotas y fotos máximas', ['MLA109042', 'gold_pro', true, 3], [modelo.categoriaId, modelo.tipo, modelo.tresCuotas, modelo.maxFotos]);
  chk('no copia lo propio de cada variante ni lo vacío', ['BRAND', 'GENDER'], modelo.atributos.map((a) => a.id));
  chk('de las condiciones de venta copia sólo la garantía (la campaña de cuotas la pone ML)', ['WARRANTY_TYPE'], modelo.saleTerms.map((t) => t.id));
  chk('guía: talle → fila', { S: '555:1', M: '555:2', L: '555:3' }, modelo.guia.filas);
  let ajena = 'aceptó';
  try { await s.leerModelo('MLA1', { headers: {}, http: mlFalso(), mlUserId: '99' }); } catch (e) { ajena = e.status; }
  chk('una publicación de otra cuenta se rechaza', 400, ajena);

  tit('Vista previa y cuerpo del ítem');
  const datos = new Map([['REM', {
    titulo: 'Remera Lisa', descripcion: '<p>Algodón</p>', costo: 5000,
    variantes: [
      { sku: 'REM-N-S', color: 'negro', talle: 'S', stock: 4, costo: null },
      { sku: 'REM-N-M', color: 'negro', talle: 'M', stock: 0, costo: null },
      { sku: 'REM-B-S', color: 'blanco', talle: 'S', stock: 2, costo: 0 },
      { sku: 'REM-B-XXL', color: 'blanco', talle: 'XXL', stock: 2, costo: null },
      { sku: 'REM-R-S', color: 'rojo', talle: 'S', stock: 1, costo: null },
      { sku: 'REM-N-L', color: 'negro', talle: 'L', stock: 3, costo: 20000 },
      { sku: 'REM-N-m', color: 'negro', talle: ' m ', stock: 3, costo: null },
    ],
  }], ['SINCOSTO', { titulo: 'Sin costo', costo: 0, variantes: [{ sku: 'SC-1', color: 'negro', talle: 'S', stock: 1, costo: null }] }]]);
  const fotos = new Map(indice.porSku);
  fotos.set('SC-1', [u('neg1')]);
  fotos.set('REM-B-XXL', [u('bla1')]);
  fotos.set('REM-N-M', [u('neg1')]);
  fotos.set('REM-R-S', []); // la tienda no tiene fotos para este
  fotos.set('REM-N-m', [u('neg1')]);
  fotos.set('REM-N-L', [u('neg1'), u('neg2'), u('neg0'), u('gen1')]);
  const publicados = new Map([['REM-B-S', { mlItemId: 'MLA9', permalink: 'https://ml/MLA9' }]]);
  const vista = s.armarVista({
    productos: [{ skuAgrupador: 'REM', extra: 10 }, { skuAgrupador: 'SINCOSTO' }, { skuAgrupador: 'FANTASMA' }],
    datos, parametros: P, modelo, fotos, publicados,
  });
  const rem = vista[0];
  const por = Object.fromEntries(rem.variantes.map((v) => [v.sku, v]));
  const codigos = (sku) => por[sku].problemas.map((p) => p.codigo);
  chk('extra elegido para el producto', 10, rem.extraPct);
  chk('el título propuesto es el de Stocker', 'Remera Lisa', rem.familyName);
  chk('la descripción va en texto plano', 'Algodón', rem.descripcion);
  chk('variante completa: publicable', true, por['REM-N-S'].publicable);
  chk('usa el costo del producto si la variante no tiene', 5000, por['REM-N-S'].costo);
  chk('el costo propio de la variante manda', 20000, por['REM-N-L'].costo);
  chk('sin stock se publica igual (queda pausada): no es un problema', [[], true], [codigos('REM-N-M'), por['REM-N-M'].publicable]);
  chk('costo 0 en la variante cae al del producto', 5000, por['REM-B-S'].costo);
  chk('ya publicada: se saltea y dice dónde está', ['MLA9', false], [por['REM-B-S'].yaPublicada.itemId, por['REM-B-S'].publicable]);
  chk('talle fuera de la guía', ['TALLE_FUERA_DE_GUIA'], codigos('REM-B-XXL'));
  chk('sin fotos', ['SIN_FOTOS'], codigos('REM-R-S'));
  chk('fila de la guía por talle', '555:3', por['REM-N-L'].filaGuia);
  chk('fotos hasta el máximo de la categoría', 3, por['REM-N-L'].fotos.length);
  chk('producto sin costo: la variante no se publica', ['SIN_COSTO'], vista[1].variantes[0].problemas.map((p) => p.codigo));
  chk('producto que no existe', ['PRODUCTO_NO_ENCONTRADO'], vista[2].problemas.map((p) => p.codigo));
  chk('cuenta lo publicable (con la que no tiene stock)', 4, rem.publicables);
  chk('sin stock va con una unidad fantasma', 1, s.armarItem({ modelo, producto: rem, variante: por['REM-N-M'] }).available_quantity);
  chk('el talle se manda como lo escribe la guía', ['M', 'M'], [por['REM-N-m'].talleGuia, s.armarItem({ modelo, producto: rem, variante: por['REM-N-m'] }).attributes.find((a) => a.id === 'SIZE').value_name]);
  // Sobre el umbral el precio cuenta 3 cuotas: un modelo Clásica, o Premium sin el tag, no las da.
  const vistaCon = (m) => s.armarVista({ productos: [{ skuAgrupador: 'REM' }], datos, parametros: P, modelo: m, fotos, publicados: new Map() })[0].variantes.find((x) => x.sku === 'REM-N-L');
  chk('modelo Clásica sobre el umbral: bloquea', ['MODELO_SIN_3_CUOTAS'], vistaCon({ ...modelo, tipo: 'gold_special' }).problemas.map((x) => x.codigo));
  chk('modelo Premium sin el tag: bloquea', ['MODELO_SIN_3_CUOTAS'], vistaCon({ ...modelo, tresCuotas: false }).problemas.map((x) => x.codigo));
  chk('modelo Premium con el tag: publicable', true, vistaCon(modelo).publicable);

  // El género y la guía se copian del modelo (acá, de Hombre): con un producto de otro público ML rechaza por el título.
  const conGenero = (genero) => s.armarVista({ productos: [{ skuAgrupador: 'REM' }], datos: new Map([['REM', { ...datos.get('REM'), genero }]]), parametros: P, modelo, fotos, publicados: new Map() })[0];
  chk('el modelo trae su género', 'Hombre', modelo.genero);
  chk('producto de mujer con modelo de hombre: no se publica nada y dice por qué', [['GENERO_DISTINTO'], 0], [conGenero('Mujer').problemas.map((x) => x.codigo), conGenero('Mujer').publicables]);
  chk('producto de niños con modelo de hombre: tampoco', ['GENERO_DISTINTO'], conGenero('Niños').problemas.map((x) => x.codigo));
  chk('mismo género: se publica', [[], true], [conGenero('Hombre').problemas, conGenero('Hombre').publicables > 0]);
  chk('unisex con modelo de hombre: se publica, con aviso', [[], true], [conGenero('Unisex').problemas, conGenero('Unisex').avisos.some((a) => /unisex/.test(a))]);
  chk('sin género cargado en Stocker: no se frena', [], conGenero(null).problemas);

  // Un producto que ya tiene publicación: las variantes que faltan se suman a ESA (su family_name y su ficha), no al modelo elegido.
  const suya = { ...modelo, itemId: 'MLA9', familyName: 'ISU Remera Lisa Hombre Algodón', precio: 19999, link: 'https://ml/MLA9', categoriaId: 'MLA_SUYA', atributos: [{ id: 'BRAND', value_name: 'ISU' }] };
  const conPropia = (propio) => s.armarVista({ productos: [{ skuAgrupador: 'REM', familyName: 'Otro título' }], datos, parametros: P, modelo, propios: new Map([['REM', propio]]), fotos, publicados })[0];
  const sumada = conPropia(suya);
  chk('usa el título de la publicación que ya tiene, no el elegido', 'ISU Remera Lisa Hombre Algodón', sumada.familyName);
  chk('dice a cuál se suma', ['MLA9', 19999, true], [sumada.existente.itemId, sumada.existente.precio, sumada.avisos.some((a) => /ya tiene publicación/.test(a))]);
  const nueva = s.armarItem({ modelo: suya, producto: sumada, variante: sumada.variantes.find((v) => v.sku === 'REM-N-S') });
  chk('la variante nueva va con la categoría y la ficha de la existente', ['ISU Remera Lisa Hombre Algodón', 'MLA_SUYA', 'ISU'], [nueva.family_name, nueva.category_id, nueva.attributes.find((a) => a.id === 'BRAND').value_name]);
  chk('la que ya estaba publicada sigue salteada', false, sumada.variantes.find((v) => v.sku === 'REM-B-S').publicable);
  chk('publicación del formato viejo (sin family_name): no abre otra', [['PUBLICACION_EXISTENTE'], 0], [conPropia({ ...suya, familyName: null }).problemas.map((x) => x.codigo), conPropia({ ...suya, familyName: null }).publicables]);
  chk('si no se pudo leer la existente: tampoco, y lo dice', ['PUBLICACION_EXISTENTE'], conPropia({ error: 'ML 500' }).problemas.map((x) => x.codigo));
  chk('sin publicación propia: sigue con el modelo elegido', [null, 'Otro título'], [conPropia(undefined).existente, conPropia(undefined).familyName]);

  const item = s.armarItem({ modelo, producto: rem, variante: por['REM-N-S'] });
  chk('family_name y sin title ni variations', [true, false, false], [item.family_name === 'Remera Lisa', 'title' in item, 'variations' in item]);
  chk('SELLER_SKU de Stocker', 'REM-N-S', item.attributes.find((a) => a.id === 'SELLER_SKU').value_name);
  chk('SIZE_GRID_ID y fila del talle', ['555', '555:1'], [item.attributes.find((a) => a.id === 'SIZE_GRID_ID').value_name, item.attributes.find((a) => a.id === 'SIZE_GRID_ROW_ID').value_name]);
  chk('color y talle de la variante, no los del modelo', ['negro', 'S'], [item.attributes.find((a) => a.id === 'COLOR').value_name, item.attributes.find((a) => a.id === 'SIZE').value_name]);
  chk('ficha técnica copiada', 'Isuwaya', item.attributes.find((a) => a.id === 'BRAND').value_name);
  chk('categoría, garantía y stock', ['MLA109042', 'WARRANTY_TYPE', 4], [item.category_id, item.sale_terms[0].id, item.available_quantity]);
  chk('fotos de su color', [u('neg0'), u('neg1'), u('neg2')], item.pictures.map((x) => x.source));
  chk('descripción en texto plano', { plain_text: 'Algodón' }, item.description);
  chk('el tipo de logística del modelo no se manda (lo asigna ML)', ['me2', undefined], [item.shipping.mode, item.shipping.logistic_type]);
  chk('bajo el umbral: Clásica, sin tag ni envío gratis', ['gold_special', undefined, false], [item.listing_type_id, item.tags, item.shipping.free_shipping]);
  const itemCaro = s.armarItem({ modelo, producto: rem, variante: por['REM-N-L'] });
  chk('sobre el umbral: tipo del modelo, tag de 3 cuotas y envío gratis', ['gold_pro', ['3x_campaign'], true], [itemCaro.listing_type_id, itemCaro.tags, itemCaro.shipping.free_shipping]);
  chk('precio publicado del ítem', por['REM-N-S'].precio.publicado, item.price);

  tit('La tanda');
  const mkItems = (skus) => skus.map((sku) => ({ sku, payload: { ...itemCaro, attributes: [{ id: 'SELLER_SKU', value_name: sku }] } }));
  let n = 0;
  const posts = [];
  const http = { post: async (url, cuerpo) => {
    posts.push(cuerpo.attributes[0].value_name);
    n += 1;
    return { data: { id: `MLA${100 + n}`, permalink: `https://ml/MLA${100 + n}` } };
  } };
  const avances = [];
  const r1 = await s.publicarItems({
    items: mkItems(['A', 'B', 'C']), publicados: new Set(['B']), http, headers: {}, esperar: sinEspera, onProgreso: (a) => avances.push(a.hechos),
  });
  chk('el SKU ya publicado no se manda', ['A', 'C'], posts);
  chk('queda como salteada', 'salteada', r1.porSku.B.estado);
  chk('las otras: item id y link', ['MLA101', 'https://ml/MLA102'], [r1.porSku.A.itemId, r1.porSku.C.link]);
  chk('el avance se va contando', [0, 1, 2, 3], avances);

  // Sin stock: se crea con una unidad y enseguida se pasa a 0 (queda pausada).
  const puts = [];
  const httpF = { post: async () => ({ data: { id: 'MLA900' } }), put: async (url, c) => { puts.push([url.split('/').pop(), c]); return { data: {} }; } };
  const rF = await s.publicarItems({ items: [{ ...mkItems(['F'])[0], fantasma: true }, mkItems(['G'])[0]], publicados: new Set(), http: httpF, headers: {}, esperar: sinEspera });
  chk('la fantasma se pasa a 0 apenas se crea, y sólo ella', [['MLA900', { available_quantity: 0 }]], puts);
  chk('queda marcada como pausada', [true, undefined], [rF.porSku.F.pausada, rF.porSku.G.pausada]);
  const httpFalla = { post: async () => ({ data: { id: 'MLA901' } }), put: async () => { throw Object.assign(new Error('500'), { response: { status: 500, data: { message: 'caído' } } }); } };
  const rFalla0 = await s.publicarItems({ items: [{ ...mkItems(['H'])[0], fantasma: true }], publicados: new Set(), http: httpFalla, headers: {}, esperar: sinEspera });
  chk('si no se pudo pasar a 0, queda avisado para pausarla a mano', [true, undefined], [/Pausala a mano/.test((rFalla0.porSku.H.avisos || []).join(' ')), rFalla0.porSku.H.pausada]);
  const creados = [];
  await s.publicarItems({ items: mkItems(['N1', 'N2']), publicados: new Set(), http, headers: {}, esperar: sinEspera, alCrear: async (c) => { creados.push(c.sku); if (c.sku === 'N2') throw new Error('base caída'); } });
  chk('cada ítem creado se guarda (alCrear)', ['N1', 'N2'], creados);
  const rFalla = await s.publicarItems({ items: mkItems(['N2']), publicados: new Set(), http, headers: {}, esperar: sinEspera, alCrear: async () => { throw new Error('base caída'); } });
  chk('si no se puede guardar el vínculo, igual queda publicada y se avisa', ['publicada', true], [rFalla.porSku.N2.estado, /vinculalo a mano/.test(rFalla.porSku.N2.avisos.join(' '))]);
  posts.length = 0;
  await s.publicarItems({ items: mkItems(['A', 'A']), publicados: new Set(), http, headers: {}, esperar: sinEspera });
  chk('el mismo SKU dos veces en una tanda se manda una sola', ['A'], posts);

  // El descuento propio: se pone al crear si el extra llega al 5 %, y no a la pausada.
  const promos = [];
  const httpD = { post: async (url, c) => {
    if (url.includes('/seller-promotions/')) { promos.push([url.split('/items/')[1].split('?')[0], c.deal_price, c.promotion_type, c.finish_date > c.start_date]); return { data: {} }; }
    return { data: { id: `MLA${url.length}${promos.length}` } };
  }, put: async () => ({ data: {} }) };
  const conD = (sku, extra) => ({ ...mkItems([sku])[0], payload: { ...mkItems([sku])[0].payload, price: 20001 }, ...extra });
  const guardados = [];
  const rD = await s.publicarItems({
    items: [conD('D1', { descuentoPct: 5 }), conD('D2', { descuentoPct: 5, fantasma: true }), conD('D3', { descuentoPct: 3 }), conD('D4', {})],
    publicados: new Set(), http: httpD, headers: {}, esperar: sinEspera, alCrear: async (c) => { guardados.push([c.sku, c.descuentoPct, !!c.descuentoHasta]); },
  });
  chk('descuento sólo a la activa con extra de 5 % o más, redondeado para abajo', [[rD.porSku.D1.itemId, 19000, 'PRICE_DISCOUNT', true]], promos);
  chk('se guarda cuál lleva descuento (la pausada también, para cuando se active)', [['D1', 5, true], ['D2', 5, false], ['D3', null, false], ['D4', null, false]], guardados);
  const httpDFalla = { post: async (url) => { if (url.includes('/seller-promotions/')) throw Object.assign(new Error('400'), { response: { status: 400, data: { message: 'buyer_discount_not_in_range' } } }); return { data: { id: 'MLA77' } }; } };
  const rDF = await s.publicarItems({ items: [conD('D5', { descuentoPct: 10 })], publicados: new Set(), http: httpDFalla, headers: {}, esperar: sinEspera });
  chk('si ML rechaza el descuento, queda publicada y avisado', ['publicada', true], [rDF.porSku.D5.estado, /no aceptó el descuento/.test(rDF.porSku.D5.avisos.join(' '))]);

  // La renovación: sólo a las activas; si ML la rechaza, se reintenta al día siguiente. (Los vínculos y el token, falsos.)
  const { MercadoLibreLink } = require('../src/models');
  const mlSrv = require('../src/services/mercadolibreService');
  const [findAllReal, tokenReal] = [MercadoLibreLink.findAll, mlSrv.tokenValido];
  const mkLink = (id) => ({ mlItemId: id, descuentoPct: 10, cambios: null, async update(c) { this.cambios = c; } });
  const links = [mkLink('MLA1'), mkLink('MLA2'), mkLink('MLA3')];
  MercadoLibreLink.findAll = async () => links;
  mlSrv.tokenValido = async () => 't';
  const ahora = new Date('2026-11-11T15:00:00Z');
  const renovadas = [];
  const httpR = {
    get: async () => ({ data: [
      { code: 200, body: { id: 'MLA1', price: 900, original_price: 1000, status: 'active' } },
      { code: 200, body: { id: 'MLA2', price: 1000, status: 'paused' } },
      { code: 200, body: { id: 'MLA3', price: 1000, status: 'active' } },
    ] }),
    post: async (url, c) => {
      if (url.includes('MLA3')) throw Object.assign(new Error('400'), { response: { status: 400, data: { message: 'no' } } });
      renovadas.push([c.deal_price, c.start_date, c.finish_date]); return { data: {} };
    },
  };
  const rR = await s.renovarDescuentos({ businessId: 1 }, { http: httpR, esperar: sinEspera, ahora });
  MercadoLibreLink.findAll = findAllReal; mlSrv.tokenValido = tokenReal;
  chk('renueva la activa sobre el precio sin descuento, por 13 días', [[900, '2026-11-11T00:00:00', '2026-11-24T00:00:00']], renovadas);
  chk('cuenta renovadas y fallidas', { renovados: 1, fallaron: 1 }, rR);
  chk('la pausada no se toca; la rechazada se reintenta mañana', [true, null, '2026-11-12T15:00:00.000Z'], [links[0].cambios.descuentoHasta > ahora, links[1].cambios, links[2].cambios.descuentoHasta.toISOString()]);

  let intentos = 0;
  const esperas = [];
  const http429 = { post: async () => {
    intentos += 1;
    if (intentos <= 2) throw Object.assign(new Error('429'), { response: { status: 429, headers: {}, data: { message: 'too_many_requests' } } });
    return { data: { id: 'MLA500' } };
  } };
  const r2 = await s.publicarItems({ items: mkItems(['Z']), publicados: new Set(), http: http429, headers: {}, esperar: async (ms) => { esperas.push(ms); } });
  chk('reintenta ante 429 y termina publicando', ['publicada', 3, 2], [r2.porSku.Z.estado, intentos, esperas.length]);
  chk('la espera crece', true, esperas[1] > esperas[0]);

  const siempre429 = { post: async () => { throw Object.assign(new Error('429'), { response: { status: 429, headers: {}, data: { message: 'too_many_requests' } } }); } };
  const r3 = await s.publicarItems({ items: mkItems(['Z']), publicados: new Set(), http: siempre429, headers: {}, esperar: sinEspera });
  chk('si el 429 no cede, queda el error', ['error', true], [r3.porSku.Z.estado, /429/.test(r3.porSku.Z.error)]);

  const httpError = { post: async (url, c) => {
    if (c.attributes[0].value_name === 'MAL') {
      throw Object.assign(new Error('400'), { response: { status: 400, data: { message: 'Validation error', cause: [{ code: 'item.attributes.missing_required', message: 'Attribute [GENDER] is required' }] } } });
    }
    return { data: { id: 'MLA7' } };
  } };
  const r4 = await s.publicarItems({ items: mkItems(['MAL', 'BIEN']), publicados: new Set(), http: httpError, headers: {}, esperar: sinEspera });
  chk('el error de ML sale textual y no frena al resto', ['error', 'publicada'], [r4.porSku.MAL.estado, r4.porSku.BIEN.estado]);
  chk('con la causa de ML', true, r4.porSku.MAL.error.includes('Attribute [GENDER] is required'));

  tit('Tag de 3 cuotas rechazado');
  const cuerpos = [];
  const httpTag = { post: async (url, c) => {
    cuerpos.push(c.tags || null);
    throw Object.assign(new Error('400'), { response: { status: 400, data: { message: 'invalid tags', cause: [{ message: 'tag 3x_campaign not allowed' }] } } });
  } };
  const conTag = (sku) => ({ sku, payload: { ...itemCaro, attributes: [{ id: 'SELLER_SKU', value_name: sku }] } });
  const r5 = await s.publicarItems({ items: [conTag('T1'), conTag('T2')], publicados: new Set(), http: httpTag, headers: {}, esperar: sinEspera });
  chk('si ML rechaza el tag no se publica sin él (saldría con 6 cuotas): error tal cual', ['error', true], [r5.porSku.T1.estado, /3x_campaign/.test(r5.porSku.T1.error)]);
  chk('un solo pedido por variante, con el tag', [['3x_campaign'], ['3x_campaign']], cuerpos);

  // Con el tag pedido, si ML no dejó las 3 cuotas se avisa; si las dejó, no.
  const httpSin = { post: async () => ({ data: { id: 'MLA700', tags: [] } }) };
  const httpCon = { post: async () => ({ data: { id: 'MLA701', sale_terms: [{ id: 'INSTALLMENTS_CAMPAIGN', value_name: '3x_campaign' }] } }) };
  const r6 = await s.publicarItems({ items: [conTag('Q1')], publicados: new Set(), http: httpSin, headers: {}, esperar: sinEspera });
  const r7 = await s.publicarItems({ items: [conTag('Q2')], publicados: new Set(), http: httpCon, headers: {}, esperar: sinEspera });
  chk('publicada sin las 3 cuotas: avisa; con ellas: nada', [true, undefined], [/3 cuotas/.test(r6.porSku.Q1.avisos?.[0] || ''), r7.porSku.Q2.avisos]);

  tit('Validar');
  const httpVal = { post: async (url, c) => {
    chk('valida contra /items/validate', true, url.endsWith('/items/validate'));
    if (c.attributes[0].value_name === 'MAL') {
      throw Object.assign(new Error('400'), { response: { status: 400, data: { message: 'Validation error', cause: [{ type: 'error', message: 'SIZE_GRID_ROW_ID invalido' }] } } });
    }
    return { data: {} };
  } };
  const v = await s.validarItems({ items: mkItems(['OK', 'MAL']), http: httpVal, headers: {}, esperar: sinEspera });
  chk('ok y error con el texto de ML', [true, false, true], [v.porSku.OK.ok, v.porSku.MAL.ok, v.porSku.MAL.errores[0].includes('SIZE_GRID_ROW_ID invalido')]);

  console.log(`\nPasaron ${ok} de ${ok + ko}`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
