/*
 * Lo que el portal mayorista (ISUWAYA) lee de acá para armarse solo.
 *
 * El catálogo, para que los productos se carguen y actualicen desde Stocker
 * y no a mano en cada servicio; los locales y el stock de uno, para mirar al
 * revisar un pedido. Con la credencial de origen 'isuwaya'.
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
  const db = require('../src/config/database');
  const { Business, BusinessLocation, Product, ProductVariant, VariantStock, IntegracionExterna } = require('../src/models');
  const integraciones = require('../src/services/integracionesService');
  const { errorHandler } = require('../src/middleware/errorHandler');

  const app = express();
  app.use(express.json());
  app.use('/api', require('../src/routes'));
  app.use(errorHandler);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/integraciones/isuwaya`;

  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  // Directo y no con emitir(): emitir anula la credencial activa, y en desarrollo esa es la del portal local.
  const token = require('crypto').randomBytes(24).toString('base64url');
  const integracion = await IntegracionExterna.create({
    businessId: negocio.id, origen: 'isuwaya', nombre: 'QA portal catálogo',
    tokenHash: integraciones.__hash(token), pista: token.slice(-6), activa: true,
  });
  const pedir = async (ruta, conToken = true) => {
    const r = await fetch(base + ruta, { headers: conToken ? { Authorization: `Bearer ${token}` } : {} });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  try {
    tit('1. SIN CREDENCIAL NO SE LEE NADA');
    chk('catálogo sin token: 401', 401, (await pedir('/catalogo', false)).status);
    chk('stock sin token: 401', 401, (await pedir('/stock?local=1', false)).status);

    tit('2. EL CATÁLOGO, PARA QUE EL PORTAL SE ARME SOLO');
    const cat = await pedir('/catalogo');
    const productos = cat.json?.productos || [];
    chk('responde con productos', [200, true], [cat.status, productos.length > 0]);
    chk('cada uno con su agrupador, título y variantes con SKU, color, talle y precio mayorista', true,
      productos.every((p) => p.skuAgrupador && p.titulo && p.variantes.length
        && p.variantes.every((v) => v.sku && 'color' in v && 'talle' in v && 'precioMayorista' in v)));
    chk('y con categoría, modelo y género (lo que traía la planilla)', true,
      productos.every((p) => 'categoria' in p && 'modelo' in p && 'genero' in p));
    const activos = await Product.count({ where: { businessId: negocio.id, activo: true } });
    chk(`no trae más productos de los activos del negocio (${activos})`, true, productos.length <= activos);

    tit('3. LOS LOCALES Y EL STOCK DE UNO');
    const loc = await pedir('/locales');
    const propios = await BusinessLocation.findAll({ where: { businessId: negocio.id, activo: true }, order: [['id', 'ASC']] });
    chk('los locales activos del negocio', propios.map((l) => [l.id, l.nombre]), (loc.json?.locales || []).map((l) => [l.id, l.nombre]));

    const palermo = propios.find((l) => l.tipo === 'local');
    const st = await pedir(`/stock?local=${palermo.id}`);
    const filas = await VariantStock.findAll({
      where: { businessId: negocio.id, locationId: palermo.id },
      include: [{ model: ProductVariant, as: 'variante', attributes: ['sku'] }],
    });
    const esperado = Object.fromEntries(filas.filter((f) => f.variante?.sku)
      .map((f) => [f.variante.sku, Math.max(0, Number(f.stock) - Number(f.reservado || 0))]));
    const ordenado = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
    chk(`el stock de ${palermo.nombre}: lo libre de cada SKU`, [200, ordenado(esperado)],
      [st.status, ordenado(Object.fromEntries((st.json?.stock || []).map((x) => [x.sku, x.cantidad])))]);
    chk('con la fecha para la próxima vuelta', true, Boolean(st.json?.generadoEn));

    const ajeno = await BusinessLocation.findOne({ where: { businessId: { [require('sequelize').Op.ne]: negocio.id } } });
    if (ajeno) chk('el local de otro negocio: 404', 404, (await pedir(`/stock?local=${ajeno.id}`)).status);
    chk('sin local: 400', 400, (await pedir('/stock')).status);
  } finally {
    await IntegracionExterna.destroy({ where: { id: integracion.id } });
    server.close();
    await db.close().catch(() => {});
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
