/*
 * Ajuste de precios por porcentaje (POST /api/products/precios-porcentaje).
 *
 * Es plata: la vista previa no puede escribir, el aplicar no puede tocar
 * mayorista, costo, variantes que heredan ni otros negocios.
 *
 * Uso:  API=http://localhost:3000 node scripts/test-precios-porcentaje.cjs
 * (con el runner seguro: scripts de test sólo contra una base descartable)
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const API = process.env.API || 'http://localhost:3000';
const { Business, Product, ProductVariant, Role, Employee } = require('../src/models');
const sesiones = require('../src/services/sesionesService');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

async function llamar(auth, cuerpo) {
  const r = await fetch(`${API}/api/products/precios-porcentaje`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify(cuerpo),
  });
  let json = null; try { json = await r.json(); } catch { /* sin cuerpo */ }
  return { status: r.status, json };
}

(async () => {
  const SUF = Date.now();
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'demo@stocker.app', password: 'Demo2026!!' }),
  });
  const duenio = { Cookie: login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };

  const otro = await Business.create({
    nombreNegocio: `QA Porcentaje ${SUF}`, ownerNombre: 'QA', ownerApellido: 'Pct',
    cuit: `2${String(SUF).slice(-10)}`, email: `qa.pct.${SUF}@stocker.test`, passwordHash: 'x',
  });
  const reqFalso = { headers: { 'user-agent': 'qa-porcentaje' }, ip: '127.0.0.1' };
  const cargo = await Role.create({ businessId: negocio.id, nombre: `QA pct ${SUF}`, permisos: { stock: 'ver' } });
  const emp = await Employee.create({
    businessId: negocio.id, roleId: cargo.id, dni: `${SUF}`.slice(-8), nombre: 'Emp', apellido: 'Pct',
    email: `qa.pct.emp.${SUF}@stocker.test`, passwordHash: 'x', activo: true,
  });
  const tokEmp = await sesiones.abrir(reqFalso, { type: 'employee', businessId: negocio.id, employeeId: emp.id, roleId: cargo.id });

  const crear = (businessId, sku, categoria, extra = {}) => Product.create({
    businessId, sku, skuAgrupador: sku, titulo: `QA ${sku}`, categoria,
    precioMinorista: 1000, precioMayorista: 800, costo: 400, activo: true, ...extra,
  });
  const pA = await crear(negocio.id, `QPA-${SUF}`, `QA-Cat-A-${SUF}`);
  const pB = await crear(negocio.id, `QPB-${SUF}`, `QA-Cat-B-${SUF}`);
  const pAjeno = await crear(otro.id, `QPX-${SUF}`, `QA-Cat-X-${SUF}`);
  const pSinPrecio = await crear(negocio.id, `QPS-${SUF}`, `QA-Cat-A-${SUF}`, { precioMinorista: 0 });
  const vProp = await ProductVariant.create({ productId: pA.id, businessId: negocio.id, sku: `QPA-${SUF}-P`, precioMinorista: 1500, precioMayorista: 1200, costo: 600, stock: 0 });
  const vHer = await ProductVariant.create({ productId: pA.id, businessId: negocio.id, sku: `QPA-${SUF}-H`, precioMinorista: null, stock: 0 });
  const ids = { p: [pA.id, pB.id, pAjeno.id, pSinPrecio.id], v: [vProp.id, vHer.id] };
  const leer = async () => ({
    A: await Product.findByPk(pA.id, { raw: true }), B: await Product.findByPk(pB.id, { raw: true }),
    X: await Product.findByPk(pAjeno.id, { raw: true }), S: await Product.findByPk(pSinPrecio.id, { raw: true }),
    vp: await ProductVariant.findByPk(vProp.id, { raw: true }), vh: await ProductVariant.findByPk(vHer.id, { raw: true }),
  });
  const base = { porcentaje: 10, redondeo: 1, aplicar: false };
  const cat = [`QA-Cat-A-${SUF}`];

  try {
    tit('1. VISTA PREVIA: calcula y no escribe');
    const antes = await leer();
    const r1 = await llamar(duenio, { ...base, categorias: cat });
    chk('200', 200, r1.status);
    chk('1 producto con precio (A), el sin precio se saltea', 1, r1.json.productos);
    chk('1 variante con precio propio', 1, r1.json.variantes);
    chk('aplicado false', false, r1.json.aplicado);
    chk('muestra antes/despues', [1000, 1100], [r1.json.muestra[0].antes, r1.json.muestra[0].despues]);
    chk('la base no cambió', antes, await leer());

    tit('2. APLICAR: producto y variante propia suben; lo demás no');
    const r2 = await llamar(duenio, { ...base, categorias: cat, aplicar: true });
    chk('aplicado true', true, r2.json.aplicado);
    const d = await leer();
    chk('producto A +10%', 1100, Number(d.A.precioMinorista));
    chk('variante con precio propio +10%', 1650, Number(d.vp.precioMinorista));
    chk('variante que hereda sigue en null', null, d.vh.precioMinorista);
    chk('mayorista del producto intacto', 800, Number(d.A.precioMayorista));
    chk('costo del producto intacto', 400, Number(d.A.costo));
    chk('mayorista y costo de la variante intactos', [1200, 600], [Number(d.vp.precioMayorista), Number(d.vp.costo)]);
    chk('categoría B no se toca', 1000, Number(d.B.precioMinorista));
    chk('otro negocio no se toca', 1000, Number(d.X.precioMinorista));
    chk('producto sin precio sigue en 0', 0, Number(d.S.precioMinorista));

    tit('3. REDONDEO hacia arriba y baja');
    const r3 = await llamar(duenio, { porcentaje: 3.5, redondeo: 100, categorias: [`QA-Cat-B-${SUF}`], aplicar: true });
    chk('1000 +3,5% redondeado a 100 = 1100', 1100, r3.json.muestra[0].despues);
    const r3b = await llamar(duenio, { porcentaje: -10, redondeo: 1000, categorias: [`QA-Cat-B-${SUF}`], aplicar: false });
    chk('1100 -10% = 990, redondeado hacia arriba a 1000', 1000, r3b.json.muestra[0].despues);
    const r3c = await llamar(duenio, { porcentaje: -1, redondeo: 1000, categorias: [`QA-Cat-B-${SUF}`], aplicar: false });
    chk('bajando, el redondeo nunca sube el precio (1100 -1% daría 2000: no cambia)', 0, r3c.json.productos);

    tit('4. SIN CATEGORÍAS = todo el negocio, y no toca otros');
    await llamar(duenio, { porcentaje: 100, redondeo: 1, aplicar: true });
    const e = await leer();
    chk('B se duplicó', 2200, Number(e.B.precioMinorista));
    chk('otro negocio sigue igual', 1000, Number(e.X.precioMinorista));

    tit('5. VALIDACIONES');
    const malos = [
      ['porcentaje 0', { ...base, porcentaje: 0 }], ['porcentaje 201', { ...base, porcentaje: 201 }],
      ['porcentaje -51', { ...base, porcentaje: -51 }], ['3 decimales', { ...base, porcentaje: 1.234 }],
      ['porcentaje texto', { ...base, porcentaje: '10' }], ['redondeo 5', { ...base, redondeo: 5 }],
      ['sin aplicar', { porcentaje: 10, redondeo: 1 }], ['categorias no lista', { ...base, categorias: 'x' }],
    ];
    for (const [n, c] of malos) {
      const r = await llamar(duenio, c);
      chk(`${n} → 400 con mensaje`, [400, true], [r.status, typeof r.json?.message === 'string']);
    }
    const r404 = await llamar(duenio, { ...base, categorias: ['No existe'] });
    chk('categoría inexistente → 404', 404, r404.status);
    chk('categoría de otro negocio → 404', 404, (await llamar(duenio, { ...base, categorias: [`QA-Cat-X-${SUF}`] })).status);

    tit('6. PERMISO');
    chk('sin permiso de editar stock → 403', 403, (await llamar({ Authorization: `Bearer ${tokEmp}` }, base)).status);
    chk('sin sesión → 401', 401, (await llamar({}, base)).status);
  } finally {
    // Sólo lo creado acá, por id exacto.
    await ProductVariant.destroy({ where: { id: ids.v } });
    await Product.destroy({ where: { id: ids.p } });
    await Employee.destroy({ where: { id: emp.id } });
    await Role.destroy({ where: { id: cargo.id } });
    await Business.destroy({ where: { id: otro.id } });
  }

  console.log(`\nPasaron ${ok}, fallaron ${ko}`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('vino error:', e.message, e.stack?.split('\n')[1]); process.exit(1); });
