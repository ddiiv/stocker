/*
 * Dar de baja un producto libera su SKU.
 *
 * La baja deja la fila (las ventas la siguen nombrando), pero el SKU es único
 * en el negocio: volver a cargar un producto igual —mismo SKU padre, mismo
 * agrupador— decía "ya tenés un producto con ese SKU" por uno que ya no se
 * veía en ningún lado. Ahora la baja renombra los SKU del producto y de sus
 * variantes a "-BAJA<id>", y una corrección de arranque hace lo mismo con lo
 * que se había dado de baja antes.
 *
 * Va por HTTP contra el router real en un puerto efímero, con la cuenta demo.
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

(async () => {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const db = require('../src/config/database');
  const { ensureColumns, aplicarRellenos, RELLENOS } = require('../src/database/ensureColumns');
  await ensureColumns(db);
  const { Business, Product, ProductVariant } = require('../src/models');
  const { codigoDeBaja } = require('../src/utils/codigoDeBaja');
  const { errorHandler } = require('../src/middleware/errorHandler');

  const app = express();
  app.set('trust proxy', 1);
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api', require('../src/routes'));
  app.use(errorHandler);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const IP = `10.80.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  let cookie = '';
  const pedir = async (metodo, ruta, cuerpo) => {
    const r = await fetch(base + ruta, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': IP, ...(cookie ? { Cookie: cookie } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    const sesion = (r.headers.getSetCookie?.() || []).find((c) => c.startsWith('stockerToken='));
    if (sesion) cookie = sesion.split(';')[0];
    let json = null;
    try { json = await r.json(); } catch { /* sin cuerpo */ }
    return { status: r.status, json };
  };

  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  const SKU = 'QA-BAJA-SKU';
  const producto = {
    titulo: 'QA Baja SKU', sku: SKU, skuAgrupador: SKU,
    precioMinorista: 1000, precioMayorista: 900, costo: 500,
    variantes: { Color: ['Negro'], Talle: ['M', 'L'] },
  };
  const ids = [];
  const variantesDe = async (id) => (await ProductVariant.findAll({ where: { productId: id }, order: [['id', 'ASC']] })).map((v) => v.sku);

  try {
    chk('entra la cuenta demo', 200, (await pedir('POST', '/auth/login', { email: negocio.email, password: 'Demo2026!!' })).status);

    tit('1. CARGAR, DAR DE BAJA Y VOLVER A CARGAR EL MISMO PRODUCTO');
    const primero = await pedir('POST', '/products', producto);
    chk('se carga', 201, primero.status);
    ids.push(primero.json?.id);
    const skusOriginales = await variantesDe(primero.json.id);
    chk('con sus dos variantes', 2, skusOriginales.length);

    chk('se da de baja', 204, (await pedir('DELETE', `/products/${primero.json.id}`)).status);
    const dadoDeBaja = await Product.findByPk(primero.json.id);
    chk('queda inactivo y con el SKU liberado', [false, `${SKU}-BAJA${dadoDeBaja.id}`], [dadoDeBaja.activo, dadoDeBaja.sku]);
    chk('sus variantes también liberan el suyo', true,
      (await variantesDe(primero.json.id)).every((s) => /-BAJA\d+$/.test(s)));

    const segundo = await pedir('POST', '/products', producto);
    chk('el mismo producto se vuelve a cargar', [201, SKU], [segundo.status, segundo.json?.sku]);
    ids.push(segundo.json?.id);
    chk('y sus variantes salen con los mismos SKU de antes (no numerados)', skusOriginales, await variantesDe(segundo.json.id));

    tit('2. DAR DE BAJA DOS VECES NO ALARGA EL CÓDIGO');
    chk('ya renombrado, queda igual', 'X-BAJA7', codigoDeBaja('X-BAJA7', 7, 80));
    chk('un SKU largo se recorta para que entre', 80, codigoDeBaja('A'.repeat(90), 123, 80).length);

    tit('3. LO QUE SE HABÍA DADO DE BAJA ANTES DE ESTE ARREGLO');
    // Como quedaba antes: inactivo y con su SKU ocupando el código.
    const viejo = await Product.create({
      businessId: negocio.id, sku: 'QA-BAJA-VIEJO', skuAgrupador: 'QA-BAJA-VIEJO', titulo: 'QA viejo',
      precioMinorista: 1, precioMayorista: 1, costo: 1, activo: false,
    });
    ids.push(viejo.id);
    const varViejo = await ProductVariant.create({
      productId: viejo.id, businessId: negocio.id, sku: 'QA-BAJA-VIEJO-NEGM', stock: 0, stockMinimo: 0,
    });
    const relleno = RELLENOS.find((r) => r.marca === 'relleno:skus-de-baja');
    chk('la corrección de arranque existe', true, Boolean(relleno));
    // Sin la marca, para poder correrla de nuevo en una base donde ya corrió.
    await aplicarRellenos(db, [], [{ ...relleno, marca: undefined, reintentable: true }]);
    chk('libera el SKU del producto', `QA-BAJA-VIEJO-BAJA${viejo.id}`, (await Product.findByPk(viejo.id)).sku);
    chk('y el de su variante', `QA-BAJA-VIEJO-NEGM-BAJA${varViejo.id}`, (await ProductVariant.findByPk(varViejo.id)).sku);
    chk('no toca los productos activos', SKU, (await Product.findByPk(segundo.json.id)).sku);
  } finally {
    for (const id of ids.filter(Boolean)) {
      await ProductVariant.destroy({ where: { productId: id } });
      await Product.destroy({ where: { id } });
    }
    server.close();
    await db.close().catch(() => {});
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
