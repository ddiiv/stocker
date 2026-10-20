/*
 * Las listas de categorías y géneros que se eligen al cargar un producto.
 *
 * Se cargan una vez en Stock → Variantes y después se eligen de un desplegable,
 * en vez de escribirlas en cada producto. La primera vez arrancan con las que
 * ya usan los productos del negocio; después mandan las guardadas. La limpieza
 * es la misma que la de los valores de una variante: sin vacíos y sin
 * repetidos aunque cambien las mayúsculas o los acentos.
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
  await require('../src/database/ensureColumns').ensureColumns(db);
  const { Business, Product } = require('../src/models');

  const app = express();
  app.set('trust proxy', 1);
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api', require('../src/routes'));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const IP = `10.79.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
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
  const antes = { categorias: negocio.categorias, generos: negocio.generos };
  const prod = await Product.create({
    businessId: negocio.id, sku: 'QA-LISTAS', skuAgrupador: 'QA-LISTAS', titulo: 'QA Listas',
    precioMinorista: 1, precioMayorista: 1, costo: 1, categoria: 'QA Categoría Única', genero: 'QA Género',
  });

  try {
    await negocio.update({ categorias: null, generos: null });
    chk('entra la cuenta demo', 200, (await pedir('POST', '/auth/login', { email: negocio.email, password: 'Demo2026!!' })).status);

    tit('1. LA PRIMERA VEZ, LAS QUE YA USAN LOS PRODUCTOS');
    const inicial = (await pedir('GET', '/catalogo/listas')).json;
    chk('trae la categoría de un producto', true, inicial?.categorias?.includes('QA Categoría Única'));
    chk('y su género', true, inicial?.generos?.includes('QA Género'));
    chk('sin vacíos', false, inicial?.categorias?.some((c) => !String(c).trim()));

    tit('2. SE GUARDAN LIMPIAS');
    const guardado = await pedir('PUT', '/catalogo/listas', { categorias: [' Remeras', 'remeras', 'Buzos', '', 'BUZOS '] });
    chk('sin espacios, sin vacíos y sin repetidos (queda la primera forma)', [200, ['Remeras', 'Buzos']],
      [guardado.status, guardado.json?.categorias]);
    chk('lo guardado manda: ya no aparecen las de los productos', false,
      (await pedir('GET', '/catalogo/listas')).json?.categorias?.includes('QA Categoría Única'));
    chk('mandar sólo una lista no toca la otra', [['Remeras', 'Buzos'], ['Mujer', 'Hombre']],
      ((r) => [r?.categorias, r?.generos])((await pedir('PUT', '/catalogo/listas', { generos: ['Mujer', 'Hombre'] })).json));
    chk('"Mujér" es el mismo género que "Mujer"', ['Mujer'],
      (await pedir('PUT', '/catalogo/listas', { generos: ['Mujer', 'Mujér'] })).json?.generos);

    tit('3. SE BUSCA POR CATEGORÍA Y POR GÉNERO');
    const ids = async (q) => ((await pedir('GET', `/products?${q}`)).json?.data || []).map((p) => p.id);
    chk('escribiendo la categoría en el buscador', true, (await ids('search=categor%C3%ADa%20%C3%BAnica')).includes(prod.id));
    chk('escribiendo el género', true, (await ids(`search=${encodeURIComponent('QA Género')}`)).includes(prod.id));
    chk('con el filtro de categoría', true, (await ids(`categoria=${encodeURIComponent('QA Categoría Única')}`)).includes(prod.id));
    chk('y el de género deja afuera a otro género', false, (await ids('genero=Otro')).includes(prod.id));

    tit('4. LO QUE NO SE ACEPTA');
    chk('algo que no es una lista', 400, (await pedir('PUT', '/catalogo/listas', { categorias: 'Remeras' })).status);
    chk('un género de más de 40 caracteres (el largo del campo del producto)', 400,
      (await pedir('PUT', '/catalogo/listas', { generos: ['x'.repeat(41)] })).status);
  } finally {
    await Business.update(antes, { where: { id: negocio.id } });
    await prod.destroy();
    server.close();
    await db.close().catch(() => {});
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
