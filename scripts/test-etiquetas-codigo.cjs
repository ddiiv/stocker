/*
 * Qué va en las barras de las etiquetas, y que la caja lo encuentre.
 *
 * El lector de la caja lee bien un EAN-13 y mal un SKU largo en barras. Cada
 * negocio elige el tipo en la pantalla de Etiquetas. Lo que no se puede romper:
 * escanear el código nuevo tiene que llevar a la prenda con su SKU, que es con
 * lo que trabaja el punto de venta.
 *
 * Va por HTTP contra el router real en un puerto efímero, con la cuenta demo.
 * Lo que toca (el tipo del negocio y el código de dos variantes) se deja como
 * estaba, por id exacto.
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
  const { Business, Product, ProductVariant } = require('../src/models');
  const { ean13Interno } = require('../src/services/labelService');

  const app = express();
  app.set('trust proxy', 1);
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api', require('../src/routes'));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const IP = `10.79.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const pedir = async (metodo, ruta, { cuerpo, token } = {}) => {
    const r = await fetch(base + ruta, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': IP, ...(token ? { Cookie: `stockerToken=${token}` } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    const sesion = (r.headers.getSetCookie?.() || []).find((c) => c.startsWith('stockerToken='));
    const tipo = r.headers.get('content-type') || '';
    return {
      status: r.status, tipo,
      json: tipo.includes('json') ? await r.json().catch(() => null) : null,
      token: sesion ? sesion.split(';')[0].slice('stockerToken='.length) : null,
    };
  };

  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  const tipoAntes = negocio.etiquetaCodigo;
  // Dos variantes activas de la demo sin código de barras: a una se le asigna, a la otra no debe.
  const sinCodigo = await ProductVariant.findAll({
    where: { businessId: negocio.id, activo: true, codigoBarras: null },
    include: [{ model: Product, as: 'producto', where: { businessId: negocio.id, activo: true }, required: true }],
    order: [['id', 'ASC']], limit: 2,
  });
  const [conEan, conSku] = sinCodigo;
  const tocadas = sinCodigo.map((v) => v.id);

  try {
    if (!conEan || !conSku) throw new Error('La demo necesita dos variantes activas sin código de barras.');
    await negocio.update({ etiquetaCodigo: null });
    const { token } = await pedir('POST', '/auth/login', { cuerpo: { email: negocio.email, password: 'Demo2026!!' } });

    tit('1. EL TIPO SE ELIGE POR NEGOCIO');
    chk('sin elegir, EAN-13', 'ean13', (await pedir('GET', '/products/etiquetas/ajustes', { token })).json?.tipo);
    chk('uno que no existe se rechaza', 400,
      (await pedir('PUT', '/products/etiquetas/ajustes', { token, cuerpo: { tipo: 'qr' } })).status);
    await pedir('PUT', '/products/etiquetas/ajustes', { token, cuerpo: { tipo: 'numero12' } });
    chk('se guarda', 'numero12', (await pedir('GET', '/products/etiquetas/ajustes', { token })).json?.tipo);
    await pedir('PUT', '/products/etiquetas/ajustes', { token, cuerpo: { tipo: 'ean13' } });

    tit('2. CON EAN-13, LA VARIANTE SIN CÓDIGO RECIBE EL SUYO');
    const pdf = await pedir('POST', '/products/etiquetas', { token, cuerpo: { items: [{ variantId: conEan.id, cantidad: 1 }] } });
    chk('sale el PDF', [200, true], [pdf.status, pdf.tipo.includes('pdf')]);
    await conEan.reload();
    chk('y queda guardado su EAN-13 interno', ean13Interno(conEan.id), conEan.codigoBarras);

    tit('3. LA CAJA LLEGA A LA PRENDA CON SU SKU');
    const porEan = await pedir('GET', `/products/scan/${conEan.codigoBarras}`, { token });
    chk('escaneando el EAN-13', [200, conEan.sku], [porEan.status, porEan.json?.sku]);
    const porDoce = await pedir('GET', `/products/scan/${conEan.codigoBarras.slice(0, 12)}`, { token });
    chk('escaneando el número de 12 dígitos', [200, conEan.sku], [porDoce.status, porDoce.json?.sku]);
    chk('y el SKU sigue sirviendo', conEan.sku, (await pedir('GET', `/products/scan/${encodeURIComponent(conEan.sku)}`, { token })).json?.sku);
    chk('un número de 12 dígitos que no es de ninguna prenda no inventa nada', 404,
      (await pedir('GET', '/products/scan/999999999999', { token })).status);

    tit('4. CON SKU NO SE ASIGNA NADA');
    await pedir('PUT', '/products/etiquetas/ajustes', { token, cuerpo: { tipo: 'sku' } });
    const pdfSku = await pedir('POST', '/products/etiquetas', { token, cuerpo: { items: [{ variantId: conSku.id, cantidad: 1 }] } });
    chk('sale el PDF', 200, pdfSku.status);
    await conSku.reload();
    chk('y la variante sigue sin código propio', null, conSku.codigoBarras);
  } finally {
    await ProductVariant.update({ codigoBarras: null }, { where: { id: tocadas } });
    await Business.update({ etiquetaCodigo: tipoAntes ?? null }, { where: { id: negocio.id } });
    server.close();
    await db.close().catch(() => {});
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
