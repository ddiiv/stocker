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
  const base = { precio: 'minorista', base: 'mismo', modo: 'porcentaje', valor: 10, redondeo: 1, aplicar: false };
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
    const r3 = await llamar(duenio, { ...base, valor: 3.5, redondeo: 100, categorias: [`QA-Cat-B-${SUF}`], aplicar: true });
    chk('1000 +3,5% redondeado a 100 = 1100', 1100, r3.json.muestra[0].despues);
    const r3b = await llamar(duenio, { ...base, valor: -10, redondeo: 1000, categorias: [`QA-Cat-B-${SUF}`], aplicar: false });
    chk('1100 -10% = 990, redondeado hacia arriba a 1000', 1000, r3b.json.muestra[0].despues);
    const r3c = await llamar(duenio, { ...base, valor: -1, redondeo: 1000, categorias: [`QA-Cat-B-${SUF}`], aplicar: false });
    chk('bajando, el redondeo nunca sube el precio (1100 -1% daría 2000: no cambia)', 0, r3c.json.productos);

    tit('4. SIN CATEGORÍAS = todo el negocio, y no toca otros');
    await llamar(duenio, { ...base, valor: 100, redondeo: 1, aplicar: true });
    const e = await leer();
    chk('B se duplicó', 2200, Number(e.B.precioMinorista));
    chk('otro negocio sigue igual', 1000, Number(e.X.precioMinorista));

    tit('5. VALIDACIONES');
    const malos = [
      ['valor 0', { ...base, valor: 0 }], ['valor 201', { ...base, valor: 201 }],
      ['valor -51', { ...base, valor: -51 }], ['3 decimales', { ...base, valor: 1.234 }],
      ['valor texto', { ...base, valor: '10' }], ['redondeo 5', { ...base, redondeo: 5 }],
      ['sin aplicar', { ...base, aplicar: undefined }], ['categorias no lista', { ...base, categorias: 'x' }],
    ];
    for (const [n, c] of malos) {
      const r = await llamar(duenio, c);
      chk(`${n} → 400 con mensaje`, [400, true], [r.status, typeof r.json?.message === 'string']);
    }
    const extra = [
      ['minorista desde costo', { ...base, base: 'costo' }], ['mayorista desde mayorista', { ...base, precio: 'mayorista', base: 'mayorista' }],
      ['precio inválido', { ...base, precio: 'costo' }], ['modo inválido', { ...base, modo: 'x' }],
      ['porcentaje sobre base -1', { ...base, base: 'mayorista', valor: -1 }], ['porcentaje sobre base 501', { ...base, base: 'mayorista', valor: 501 }],
      ['importe sobre base negativo', { ...base, base: 'mayorista', modo: 'importe', valor: -5 }],
      ['importe 0', { ...base, modo: 'importe', valor: 0 }],
    ];
    for (const [n, c] of extra) chk(`${n} → 400`, 400, (await llamar(duenio, c)).status);
    const r404 = await llamar(duenio, { ...base, categorias: ['No existe'] });
    chk('categoría inexistente → 404', 404, r404.status);
    chk('categoría de otro negocio → 404', 404, (await llamar(duenio, { ...base, categorias: [`QA-Cat-X-${SUF}`] })).status);

    tit('6. PERMISO');
    chk('sin permiso de editar stock → 403', 403, (await llamar({ Authorization: `Bearer ${tokEmp}` }, base)).status);
    chk('sin sesión → 401', 401, (await llamar({}, base)).status);
    tit('7. MAYORISTA Y OTRAS BASES (producto N1 con variantes, N2 sin costo)');
    const CN = `QA-Cat-N-${SUF}`;
    const n1 = await crear(negocio.id, `QPN1-${SUF}`, CN);
    const n2 = await crear(negocio.id, `QPN2-${SUF}`, CN, { costo: 0 });
    const w1 = await ProductVariant.create({ productId: n1.id, businessId: negocio.id, sku: `QPN1-${SUF}-A`, precioMinorista: 1500, stock: 0 });
    const w2 = await ProductVariant.create({ productId: n1.id, businessId: negocio.id, sku: `QPN1-${SUF}-B`, stock: 0 });
    const w3 = await ProductVariant.create({ productId: n1.id, businessId: negocio.id, sku: `QPN1-${SUF}-C`, costo: 600, stock: 0 });
    ids.p.push(n1.id, n2.id); ids.v.push(w1.id, w2.id, w3.id);
    const g = async () => ({
      n1: await Product.findByPk(n1.id, { raw: true }), n2: await Product.findByPk(n2.id, { raw: true }),
      w1: await ProductVariant.findByPk(w1.id, { raw: true }), w2: await ProductVariant.findByPk(w2.id, { raw: true }),
      w3: await ProductVariant.findByPk(w3.id, { raw: true }),
    });
    const num = (x) => (x === null ? null : Number(x));
    const cN = { categorias: [CN], aplicar: true };

    let r = await llamar(duenio, { ...base, ...cN, precio: 'mayorista', valor: 10 });
    let x = await g();
    chk('mayorista mismo +10%: 2 productos, ninguna variante (heredan)', [2, 0], [r.json.productos, r.json.variantes]);
    chk('   mayorista 880, minorista y costo intactos', [880, 1000, 400], [num(x.n1.precioMayorista), num(x.n1.precioMinorista), num(x.n1.costo)]);

    r = await llamar(duenio, { ...base, ...cN, modo: 'importe', valor: 250 });
    x = await g();
    chk('minorista mismo +$250: 2 productos y la variante con precio propio', [2, 1], [r.json.productos, r.json.variantes]);
    chk('   producto 1250, variante propia 1750, la que hereda sigue null',
      [1250, 1750, null], [num(x.n1.precioMinorista), num(x.w1.precioMinorista), num(x.w2.precioMinorista)]);
    chk('   mayorista intacto', 880, num(x.n1.precioMayorista));

    r = await llamar(duenio, { ...base, ...cN, base: 'mayorista', valor: 50 });
    x = await g();
    chk('minorista desde mayorista +50%: 880 → 1320', [1320, 880], [num(x.n1.precioMinorista), r.json.muestra.find((m) => m.productoId === n1.id).base]);
    chk('   la variante que da igual al producto vuelve a heredar (null)', null, num(x.w1.precioMinorista));
    chk('   mayorista y costo intactos', [880, 400], [num(x.n1.precioMayorista), num(x.n1.costo)]);

    r = await llamar(duenio, { ...base, ...cN, precio: 'mayorista', base: 'costo', modo: 'importe', valor: 100 });
    x = await g();
    chk('mayorista desde costo +$100: sólo N1 (N2 no tiene costo y se saltea)', 1, r.json.productos);
    chk('   producto 500, variante con costo propio 700, la que hereda null',
      [500, 700, null], [num(x.n1.precioMayorista), num(x.w3.precioMayorista), num(x.w2.precioMayorista)]);
    chk('   N2 mayorista sigue en 880', 880, num(x.n2.precioMayorista));
    chk('   costo y minorista intactos', [400, 600, 1320], [num(x.n1.costo), num(x.w3.costo), num(x.n1.precioMinorista)]);

    r = await llamar(duenio, { ...base, ...cN, aplicar: false, modo: 'importe', valor: -5000 });
    chk('importe que dejaría ≤ 0: no cambia nada', [0, 0], [r.json.productos, r.json.variantes]);
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
