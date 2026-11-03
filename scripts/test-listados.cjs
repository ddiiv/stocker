/*
 * Los listados paginados y el panel, después de dejar de traer todo.
 *
 * Lo que se comprueba, y por qué importa:
 *
 *   · Stock pagina por SKU agrupador (porGrupo=1): un grupo con dos productos
 *     padre no queda partido entre páginas, y `total` cuenta grupos.
 *   · totalPages sale del límite que se aplicó: con limit=200 el servidor da
 *     100 y la cuenta de páginas tiene que usar 100.
 *   · La lista de ventas trae cuántos ítems tiene cada venta, sin los ítems ni
 *     los pagos completos.
 *   · El panel, agregado en la base, cuenta la venta nueva en la facturación,
 *     en el top de variantes y en la serie histórica (ventas y unidades).
 *
 * Va por HTTP contra el router real en un puerto efímero, con la cuenta demo.
 * Lo que crea se borra por id exacto al final.
 *
 * Uso:  node scripts/test-listados.cjs
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
  await require('../src/database/ensureColumns').ensureColumns(db);
  const { Business, Product, ProductVariant, Sale, SaleItem } = require('../src/models');

  const app = express();
  app.set('trust proxy', 1);
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api', require('../src/routes'));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const IP = `10.78.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
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
  const SUF = `${process.pid}${Date.now().toString(36)}`.toUpperCase();
  const creados = { productos: [], variantes: [], ventas: [] };

  /*
   * Tres grupos. El primero tiene dos productos padre cuyos títulos quedan en
   * los extremos ("a" y "z"): paginando por producto, el grupo se partía.
   */
  const producto = async (agrupador, letra) => {
    const p = await Product.create({
      businessId: negocio.id, sku: `QA-LST-${SUF}-${letra}`, skuAgrupador: `QA-LST-${SUF}-${agrupador}`,
      titulo: `QA Listado ${letra}`, precioMinorista: 100, precioMayorista: 80, costo: 40,
    });
    creados.productos.push(p.id);
    const v = await ProductVariant.create({
      productId: p.id, businessId: negocio.id, sku: `QA-LST-${SUF}-${letra}-V`, stock: 5, stockMinimo: 0, activo: true,
    });
    creados.variantes.push(v.id);
    return { p, v };
  };

  try {
    await producto('G1', 'a');
    await producto('G1', 'z');
    await producto('G2', 'b');
    const { v: vendida } = await producto('G3', 'c');

    chk('entra la cuenta demo', 200, (await pedir('POST', '/auth/login', { email: negocio.email, password: 'Demo2026!!' })).status);

    tit('1. STOCK PAGINA POR GRUPO');
    const q = `search=QA-LST-${SUF}&porGrupo=1&limit=1`;
    const p1 = (await pedir('GET', `/products?${q}&page=1`)).json;
    chk('total cuenta grupos, no productos', [3, 3], [p1?.total, p1?.totalPages]);
    chk('la página 1 trae el grupo entero, con sus dos productos', ['QA Listado a', 'QA Listado z'],
      (p1?.data || []).map((p) => p.titulo));
    const p2 = (await pedir('GET', `/products?${q}&page=2`)).json;
    chk('la 2 sigue con el siguiente grupo', ['QA Listado b'], (p2?.data || []).map((p) => p.titulo));
    chk('las variantes vienen con cada producto', 1, p2?.data?.[0]?.productVariants?.length);
    const p4 = (await pedir('GET', `/products?${q}&page=4`)).json;
    chk('pasada la última, vacío', [0, 3], [p4?.data?.length, p4?.total]);

    tit('2. totalPages CON EL LÍMITE APLICADO');
    const sinGrupo = (await pedir('GET', `/products?search=QA-LST-${SUF}&limit=3`)).json;
    chk('4 productos de a 3 son 2 páginas', [4, 2, 3], [sinGrupo?.total, sinGrupo?.totalPages, sinGrupo?.data?.length]);
    const tope = (await pedir('GET', '/products?limit=200')).json;
    chk('limit=200 se aplica como 100, y las páginas se cuentan con 100', Math.ceil(tope?.total / 100), tope?.totalPages);
    const raro = (await pedir('GET', `/products?search=QA-LST-${SUF}&limit=nada&page=nada`)).json;
    chk('un límite que no es número cae al de siempre', [4, 1, 1], [raro?.data?.length, raro?.page, raro?.totalPages]);

    tit('3. EL PANEL Y LA LISTA DE VENTAS');
    const dashAntes = (await pedir('GET', '/dashboard?rangeDays=30')).json;
    // Trescientas unidades: así entra seguro en el top de diez, haya lo que haya en la cuenta demo.
    const venta = await Sale.create({
      businessId: negocio.id, numero: `QA-LST-${SUF}`, tipo: 'venta', estado: 'pagado',
      fecha: new Date().toISOString().slice(0, 10), total: 300, totalCobrado: 300, condicionPago: 'contado',
      saldoPendiente: 0, stockDescontado: true,
    });
    creados.ventas.push(venta.id);
    await SaleItem.create({ saleId: venta.id, productVariantId: vendida.id, sku: vendida.sku, titulo: 'QA Listado c', cantidad: 200, precioUnitario: 1, subtotal: 200 });
    await SaleItem.create({ saleId: venta.id, productVariantId: vendida.id, sku: vendida.sku, titulo: 'QA Listado c', cantidad: 100, precioUnitario: 1, subtotal: 100 });

    const lista = (await pedir('GET', '/sales?limit=5')).json;
    const fila = (lista?.data || []).find((s) => s.id === venta.id);
    chk('la venta está en la lista, con la cantidad de ítems', 2, fila?.cantidadItems);
    chk('sin los ítems ni los pagos completos', [false, false], [fila ? 'items' in fila : null, fila ? 'pagos' in fila : null]);
    chk('totalPages de ventas con el límite aplicado', Math.ceil(lista?.total / 5), lista?.totalPages);

    const dash = (await pedir('GET', '/dashboard?rangeDays=30')).json;
    chk('la facturación y la cantidad suman la venta', [dashAntes.revenue + 300, dashAntes.salesCount + 1],
      [dash?.revenue, dash?.salesCount]);
    chk('el costo suma 300 unidades a 40', dashAntes.cogs + 12000, dash?.cogs);
    const top = (dash?.topVariants || []).find((v) => v.sku === vendida.sku);
    chk('la variante suma sus dos líneas en el top', top ? [300, 300, 'QA Listado c'] : 'no está en el top',
      top ? [top.unidades, top.facturado, top.titulo] : 'no está en el top');
    const suma = (serie, campo) => (serie || []).reduce((n, m) => n + m[campo], 0);
    chk('la serie histórica suma una venta y 300 unidades',
      [suma(dashAntes.serieMensual, 'ventas') + 1, suma(dashAntes.serieMensual, 'unidades') + 300],
      [suma(dash?.serieMensual, 'ventas'), suma(dash?.serieMensual, 'unidades')]);
    chk('y el año la misma', suma(dash?.serieMensual, 'unidades'), suma(dash?.serieAnual, 'unidades'));
  } finally {
    tit('Limpieza');
    await SaleItem.destroy({ where: { saleId: creados.ventas } });
    await Sale.destroy({ where: { id: creados.ventas } });
    await ProductVariant.destroy({ where: { id: creados.variantes } });
    await Product.destroy({ where: { id: creados.productos } });
    chk('no queda nada de la prueba', [0, 0], [
      await Product.count({ where: { id: creados.productos } }), await Sale.count({ where: { id: creados.ventas } }),
    ]);
    server.close();
  }

  console.log(`\n${ok} bien, ${ko} mal`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
