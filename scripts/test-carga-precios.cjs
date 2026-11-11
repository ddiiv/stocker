/*
 * Carga: el cambio masivo de precios con un catálogo grande.
 *
 * 5.000 productos y 20.000 variantes (15.000 con precio propio: más de eso pasa
 * el tope de 20.000 cambios por vez). Mide la vista previa y el aplicar, y
 * verifica CADA fila contra el cálculo hecho acá (mismo resultado exacto que el
 * UPDATE fila por fila de antes) y, si existe el historial, que quedaron las
 * 20.000 filas de detalle.
 *
 * Uso: con el runner seguro (base descartable):  correr-stocker-tests.sh carga-precios
 * Tamaño: CARGA_PRODUCTOS (5000) y CARGA_VARIANTES_POR_PRODUCTO (4).
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const API = process.env.API || 'http://localhost:3000';
const M = require('../src/models');
const { Business, Product, ProductVariant } = M;
const sesiones = require('../src/services/sesionesService');

const N = Number(process.env.CARGA_PRODUCTOS) || 5000;
const POR = Number(process.env.CARGA_VARIANTES_POR_PRODUCTO) || 4;

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};

const tandas = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));
// +10 % sobre el precio, redondeo 1 (igual que preciosPorcentaje).
const mas10 = (p) => Math.ceil(Math.round(p * 110) / 100);

(async () => {
  const SUF = Date.now();
  const negocio = await Business.create({
    nombreNegocio: `QA Carga Precios ${SUF}`, ownerNombre: 'QA', ownerApellido: 'Carga',
    cuit: `2${String(SUF).slice(-10)}`, email: `qa.carga.precios.${SUF}@stocker.test`, passwordHash: 'x',
  });
  const tok = await sesiones.abrir({ headers: { 'user-agent': 'qa-carga' }, ip: '127.0.0.1' }, { type: 'business', businessId: negocio.id });
  const llamar = async (cuerpo) => {
    const t0 = Date.now();
    const r = await fetch(`${API}/api/products/precios-porcentaje`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify(cuerpo),
    });
    const json = await r.json().catch(() => null);
    return { status: r.status, json, ms: Date.now() - t0 };
  };

  let tiempos = '';
  try {
    const cat = `QA-Carga-${SUF}`;
    const t0 = Date.now();
    const prods = [];
    for (let i = 0; i < N; i++) {
      prods.push({ businessId: negocio.id, sku: `QC${SUF}-${i}`, skuAgrupador: `QC${SUF}-${i}`, titulo: `QA carga ${i}`, categoria: cat,
        precioMinorista: 1000 + (i % 97) * 10, precioMayorista: 800, costo: 400, activo: true });
    }
    const creados = [];
    for (const t of tandas(prods, 1000)) creados.push(...await Product.bulkCreate(t, { returning: true }));
    const vars = [];
    const nuevoDelPadre = new Map();   // sku de variante -> precio nuevo de su producto
    creados.forEach((p, i) => {
      for (let k = 0; k < POR; k++) {
        nuevoDelPadre.set(`QC${SUF}-${i}-${k}`, mas10(1000 + (i % 97) * 10));
        vars.push({ productId: p.id, businessId: negocio.id, sku: `QC${SUF}-${i}-${k}`, stock: 0,
          // la última de cada producto hereda; el resto tiene precio propio
          precioMinorista: k === POR - 1 ? null : 1500 + ((i + k) % 53) * 10 });
      }
    });
    for (const t of tandas(vars, 2000)) await ProductVariant.bulkCreate(t);
    console.log(`  datos: ${N} productos, ${vars.length} variantes (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

    const base = { precio: 'minorista', base: 'mismo', modo: 'porcentaje', valor: 10, redondeo: 1, categorias: [cat] };
    const prev = await llamar({ ...base, aplicar: false });
    chk('vista previa 200', 200, prev.status);
    const propias = vars.filter((v) => v.precioMinorista !== null).length;
    chk('cuenta productos y variantes', [N, propias], [prev.json?.productos, prev.json?.variantes]);

    const ap = await llamar({ ...base, aplicar: true });
    chk('aplicar 200', 200, ap.status);
    chk('cuenta productos y variantes', [N, propias], [ap.json?.productos, ap.json?.variantes]);
    tiempos = `vista previa ${prev.ms} ms, aplicar ${ap.ms} ms`;

    // Cada fila, contra el cálculo de acá.
    const dbP = await Product.findAll({ where: { businessId: negocio.id }, attributes: ['id', 'precioMinorista', 'precioMayorista', 'costo'], raw: true });
    const porP = new Map(dbP.map((p) => [p.id, p]));
    let malP = 0;
    creados.forEach((p, i) => {
      const f = porP.get(p.id);
      if (Number(f.precioMinorista) !== mas10(1000 + (i % 97) * 10) || Number(f.precioMayorista) !== 800 || Number(f.costo) !== 400) malP++;
    });
    chk('todos los productos con el precio esperado, sin tocar mayorista ni costo', 0, malP);

    const dbV = await ProductVariant.findAll({ where: { businessId: negocio.id }, attributes: ['sku', 'precioMinorista'], raw: true });
    const porSku = new Map(dbV.map((v) => [v.sku, v.precioMinorista]));
    let malV = 0;
    vars.forEach((v) => {
      const f = porSku.get(v.sku);
      let esperado = v.precioMinorista === null ? null : mas10(v.precioMinorista);
      // Si queda igual al precio nuevo del producto, vuelve a heredar.
      if (esperado === nuevoDelPadre.get(v.sku)) esperado = null;
      if ((f === null ? null : Number(f)) !== esperado) malV++;
    });
    chk('todas las variantes con el precio esperado (las que heredan siguen en null)', 0, malV);

    if (M.PrecioCambioDetalle) {
      const cab = await M.PrecioCambio.findAll({ where: { businessId: negocio.id }, raw: true });
      chk('una cabecera de historial', [1, 'masivo'], [cab.length, cab[0]?.origen]);
      const filas = await M.PrecioCambioDetalle.count({ where: { precioCambioId: cab.map((c) => c.id) } });
      chk('una fila de historial por cada cambio', N + propias, filas);
    }
  } finally {
    // Sólo lo creado acá: por el negocio propio.
    if (M.PrecioCambio) {
      const cab = (await M.PrecioCambio.findAll({ where: { businessId: negocio.id }, attributes: ['id'], raw: true })).map((c) => c.id);
      if (cab.length) await M.PrecioCambioDetalle.destroy({ where: { precioCambioId: cab } });
      await M.PrecioCambio.destroy({ where: { businessId: negocio.id } });
    }
    await ProductVariant.destroy({ where: { businessId: negocio.id } });
    await Product.destroy({ where: { businessId: negocio.id } });
    await Business.destroy({ where: { id: negocio.id } });
  }

  console.log(`\nPasaron ${ok}, fallaron ${ko} — tiempos con ${N} productos: ${tiempos}`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('vino error:', e.message, e.stack?.split('\n')[1]); process.exit(1); });
