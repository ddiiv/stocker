/*
 * Historial de cambios de precio (GET /api/products/precios-historial[/:id]).
 *
 * Lo que se prueba: cada camino que escribe precio o costo deja su registro
 * (masivo, manual de producto y de variante, variantes masivo, Excel) con el
 * antes y el después correctos; lo que no cambia, la vista previa y lo que no
 * toca precios no dejan nada; el historial de un negocio no lo ve otro; los
 * permisos; la paginación y los filtros.
 *
 * Uso:  API=http://localhost:3000 node scripts/test-precios-historial.cjs
 * (con el runner seguro: scripts de test sólo contra una base descartable)
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const ExcelJS = require('exceljs');
const API = process.env.API || 'http://localhost:3000';
const { Business, Product, ProductVariant, Role, Employee, PrecioCambio, PrecioCambioDetalle } = require('../src/models');
const sesiones = require('../src/services/sesionesService');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

// Una pausa por pedido: el limitador de ráfagas corta a más de 60 en 2 segundos.
async function api(auth, metodo, ruta, cuerpo) {
  await new Promise((r) => setTimeout(r, 60));
  const r = await fetch(`${API}/api${ruta}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...auth },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
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
    nombreNegocio: `QA Historial ${SUF}`, ownerNombre: 'QA', ownerApellido: 'Hist',
    cuit: `2${String(SUF).slice(-10)}`, email: `qa.hist.${SUF}@stocker.test`, passwordHash: 'x',
  });
  const reqFalso = { headers: { 'user-agent': 'qa-historial' }, ip: '127.0.0.1' };
  const bearer = (tok) => ({ Authorization: `Bearer ${tok}` });
  const tokOtro = bearer(await sesiones.abrir(reqFalso, { type: 'business', businessId: otro.id }));

  const roles = [];
  const empleados = [];
  const empleado = async (nombre, permisos) => {
    const cargo = await Role.create({ businessId: negocio.id, nombre: `QA hist ${nombre} ${SUF}`, permisos });
    const emp = await Employee.create({
      businessId: negocio.id, roleId: cargo.id, dni: `${SUF}`.slice(-7) + nombre.length, nombre, apellido: 'Hist',
      email: `qa.hist.${nombre}.${SUF}@stocker.test`, passwordHash: 'x', activo: true,
    });
    roles.push(cargo.id); empleados.push(emp.id);
    return { emp, auth: bearer(await sesiones.abrir(reqFalso, { type: 'employee', businessId: negocio.id, employeeId: emp.id, roleId: cargo.id })) };
  };
  const ver = await empleado('Ver', { stock: 'ver' });
  const editor = await empleado('Editor', { stock: 'editar' });
  const sinStock = await empleado('Ventas', { ventas: 'ver' });

  const CAT = `QA-Hist-${SUF}`;
  const crear = (businessId, sku, extra = {}) => Product.create({
    businessId, sku, skuAgrupador: sku, titulo: `QA ${sku}`, categoria: CAT,
    precioMinorista: 1000, precioMayorista: 800, costo: 400, activo: true, ...extra,
  });
  const pP = await crear(negocio.id, `QH-P-${SUF}`);
  const pQ = await crear(negocio.id, `QH-Q-${SUF}`, { categoria: `QA-Hist-Q-${SUF}` });
  const pX = await crear(otro.id, `QH-X-${SUF}`);
  const vProp = await ProductVariant.create({ productId: pP.id, businessId: negocio.id, sku: `QH-P-${SUF}-P`, variante1Valor: 'XL', precioMinorista: 1500, stock: 0 });
  const vHer = await ProductVariant.create({ productId: pP.id, businessId: negocio.id, sku: `QH-P-${SUF}-H`, variante1Valor: 'M', stock: 0 });
  const ids = { p: [pP.id, pQ.id, pX.id], v: [vProp.id, vHer.id] };

  const lista = (auth, q = '') => api(auth, 'GET', `/products/precios-historial${q}`);
  const delP = async (q = '') => (await lista(duenio, `?productoId=${pP.id}${q}`)).json;
  const ultimo = async () => {
    const l = await delP();
    return (await api(duenio, 'GET', `/products/precios-historial/${l.cambios[0].id}`)).json;
  };
  const num = (x) => (x === null ? null : Number(x));
  const fila = (d) => d.detalle.map((f) => [f.variantId, f.campo, f.antes, f.despues]);

  try {
    tit('1. Sin cambios todavía');
    chk('el producto no tiene historial', 0, (await delP()).total);

    tit('2. MASIVO por porcentaje: vista previa no registra, aplicar sí');
    const base = { precio: 'minorista', base: 'mismo', modo: 'porcentaje', valor: 10, redondeo: 1, categorias: [CAT] };
    await api(duenio, 'POST', '/products/precios-porcentaje', { ...base, aplicar: false });
    chk('la vista previa no deja registro', 0, (await delP()).total);
    const r = await api(duenio, 'POST', '/products/precios-porcentaje', { ...base, aplicar: true });
    chk('aplicar 200 (1 producto, 1 variante con precio propio)', [200, 1, 1], [r.status, r.json.productos, r.json.variantes]);
    let l = await delP();
    chk('un registro masivo', [1, 'masivo', 2], [l.total, l.cambios[0].origen, l.cambios[0].filas]);
    chk('lo hizo el dueño (id null) y tiene nombre', [null, true], [l.cambios[0].usuario.id, !!l.cambios[0].usuario.nombre]);
    const rs = l.cambios[0].resumen;
    chk('resumen con los parámetros y los conteos',
      ['minorista', 'mismo', 'porcentaje', 10, 1, [CAT], 1, 1],
      [rs.precio, rs.base, rs.modo, rs.valor, rs.redondeo, rs.categorias, rs.productos, rs.variantes]);
    let d = await ultimo();
    chk('detalle: producto 1000 → 1100 y variante propia 1500 → 1650; la que hereda no figura',
      [[null, 'precioMinorista', 1000, 1100], [vProp.id, 'precioMinorista', 1500, 1650]], fila(d));
    chk('detalle trae los nombres', [`QA QH-P-${SUF}`, null, 'XL'], [d.detalle[0].productoNombre, d.detalle[0].varianteNombre, d.detalle[1].varianteNombre]);
    chk('detalle con la forma pedida', ['id', 'fecha', 'origen', 'usuario', 'resumen', 'detalle'], Object.keys(d));

    tit('3. MASIVO que hace volver a heredar: antes = lo guardado, después = null');
    // Base mayorista (800) +37,5 % = 1100: el producto ya está ahí y la variante propia (1650) queda igual al producto.
    const bm = { ...base, base: 'mayorista', valor: 37.5, aplicar: true };
    await api(duenio, 'POST', '/products/precios-porcentaje', bm);
    d = await ultimo();
    chk('sólo la variante: 1650 → null; el producto (sin diferencia) no figura', [2, [[vProp.id, 'precioMinorista', 1650, null]]], [(await delP()).total, fila(d)]);
    await api(duenio, 'POST', '/products/precios-porcentaje', bm);
    chk('repetirlo (ya no hay diferencia) no registra', 2, (await delP()).total);

    tit('4. MANUAL de producto');
    let m = await api(duenio, 'PUT', `/products/${pP.id}`, { precioMinorista: 1200 });
    chk('PUT 200', 200, m.status);
    d = await ultimo();
    chk('manual: 1100 → 1200', ['manual', [[null, 'precioMinorista', 1100, 1200]]], [d.origen, fila(d)]);
    await api(duenio, 'PUT', `/products/${pP.id}`, { precioMinorista: 1200 });
    await api(duenio, 'PUT', `/products/${pP.id}`, { precioMinorista: '1200.00', titulo: `QA nuevo título ${SUF}` });
    chk('el mismo precio (aun como texto) y un cambio de título no registran', 3, (await delP()).total);
    await api(editor.auth, 'PUT', `/products/${pP.id}`, { costo: 450, precioMayorista: 900 });
    d = await ultimo();
    chk('costo y mayorista en un solo registro, hecho por el empleado',
      [['costo', 400, 450], ['precioMayorista', 800, 900]], d.detalle.map((f) => [f.campo, f.antes, f.despues]).sort());
    chk('   usuario = el empleado', [editor.emp.id, 'Editor Hist'], [d.usuario.id, d.usuario.nombre]);

    tit('5. MANUAL de variante');
    await api(duenio, 'PUT', `/products/variants/${vHer.id}`, { precioMinorista: 1900 });
    d = await ultimo();
    chk('hereda → 1900 (antes null)', [[vHer.id, 'precioMinorista', null, 1900]], fila(d));
    await api(duenio, 'PUT', `/products/variants/${vHer.id}`, { precioMinorista: null });
    d = await ultimo();
    chk('1900 → vuelve a heredar (después null)', [[vHer.id, 'precioMinorista', 1900, null]], fila(d));
    const antesTotal = (await delP()).total;
    await api(duenio, 'PUT', `/products/variants/${vHer.id}`, { precioMinorista: null, variante1Valor: 'M' });
    chk('null sobre null no registra', antesTotal, (await delP()).total);

    tit('6. VARIANTES masivo');
    const mv = await api(duenio, 'POST', '/products/precios-masivo', {
      items: [{ variantId: vProp.id, precioMayorista: 700, costo: null }, { variantId: vHer.id, precioMinorista: null }],
    });
    chk('200 con 2 aplicadas', [200, 2], [mv.status, mv.json.aplicadas]);
    d = await ultimo();
    chk('sólo lo que cambió: mayorista null → 700 (costo null y minorista null ya estaban)',
      ['variantes', [[vProp.id, 'precioMayorista', null, 700]]], [d.origen, fila(d)]);
    chk('resumen con conteos', [0, 1], [d.resumen.productos, d.resumen.variantes]);

    tit('7. EXCEL');
    const importar = async (filas) => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Precios');
      for (const f of filas) ws.addRow(f);
      const form = new FormData();
      form.append('file', new Blob([Buffer.from(await wb.xlsx.writeBuffer())], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'p.xlsx');
      const res = await fetch(`${API}/api/products/import`, { method: 'POST', headers: duenio, body: form });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    const cab = ['SKU Padre', 'Precio Minorista', 'SKU Variante', 'Variante 1 Valor', 'Precio Minorista Variante'];
    const antesExcel = (await delP()).total;
    const im = await importar([cab, [pP.sku, 2000, vHer.sku, 'M', 2600]]);
    chk('importa 200 (1 producto, 1 variante)', [200, 1, 1], [im.status, im.json?.productsUpdated, im.json?.variantsUpdated]);
    l = await delP();
    chk('un registro más, de origen excel, con producto y variante',
      [antesExcel + 1, 'excel', 2], [l.total, l.cambios[0].origen, l.cambios[0].filas]);
    d = await ultimo();
    chk('detalle: 1200 → 2000 y variante null → 2600',
      [[null, 'precioMinorista', 1200, 2000], [vHer.id, 'precioMinorista', null, 2600]], fila(d));
    chk('resumen excel', [1, 1], [d.resumen.productos, d.resumen.variantes]);
    await importar([cab, [pP.sku, 2000, vHer.sku, 'M', 2600]]);
    chk('importar lo mismo otra vez no registra', antesExcel + 1, (await delP()).total);

    tit('8. LISTA: paginación y filtros');
    const todos = (await delP('&limite=50')).cambios;
    chk('del más nuevo al más viejo', true, todos.every((c, i) => i === 0 || todos[i - 1].id > c.id));
    const p1 = (await delP('&limite=2&pagina=1')), p2 = (await delP('&limite=2&pagina=2'));
    chk('página de 2, total igual al completo', [2, todos.length], [p1.cambios.length, p1.total]);
    chk('la página 2 sigue a la 1', [todos[2].id, todos[3].id], p2.cambios.map((c) => c.id));
    chk('limite 500 se acota a 50 como máximo', true, (await delP('&limite=500')).cambios.length <= 50);
    const porOrigen = (await delP('&origen=manual')).cambios;
    chk('filtro por origen', true, porOrigen.length > 0 && porOrigen.every((c) => c.origen === 'manual'));
    chk('origen inválido → 400', 400, (await lista(duenio, '?origen=cualquiera')).status);
    chk('productoId inválido → 400', 400, (await lista(duenio, '?productoId=abc')).status);
    chk('filtro por producto: otro producto no tiene nada', 0, (await lista(duenio, `?productoId=${pQ.id}`)).json.total);

    tit('9. OTRO NEGOCIO');
    chk('no ve el historial ajeno', [200, 0], [(await lista(tokOtro)).status, (await lista(tokOtro)).json.total]);
    chk('ni filtrando por el producto ajeno', 0, (await lista(tokOtro, `?productoId=${pP.id}`)).json.total);
    chk('el detalle ajeno → 404', 404, (await api(tokOtro, 'GET', `/products/precios-historial/${todos[0].id}`)).status);
    await api(tokOtro, 'PUT', `/products/${pX.id}`, { precioMinorista: 1300 });
    const propio = (await lista(tokOtro)).json;
    chk('el cambio propio sí lo ve', [1, 'manual'], [propio.total, propio.cambios[0]?.origen]);
    chk('y el primer negocio no lo ve', false, (await delP('&limite=50')).cambios.some((c) => c.id === propio.cambios[0].id));
    chk('detalle inexistente → 404', 404, (await api(duenio, 'GET', '/products/precios-historial/99999999')).status);

    tit('10. PERMISOS');
    chk('stock "ver" lee la lista y el detalle', [200, 200], [(await lista(ver.auth)).status, (await api(ver.auth, 'GET', `/products/precios-historial/${todos[0].id}`)).status]);
    chk('sin permiso de stock → 403', [403, 403], [(await lista(sinStock.auth)).status, (await api(sinStock.auth, 'GET', `/products/precios-historial/${todos[0].id}`)).status]);
    chk('sin sesión → 401', 401, (await lista({})).status);
  } finally {
    // Sólo lo creado acá, por id exacto.
    const cabeceras = (await PrecioCambioDetalle.findAll({ where: { productId: ids.p }, attributes: ['precioCambioId'], raw: true }))
      .map((f) => f.precioCambioId);
    await PrecioCambioDetalle.destroy({ where: { precioCambioId: cabeceras } });
    await PrecioCambio.destroy({ where: { id: cabeceras } });
    await ProductVariant.destroy({ where: { productId: ids.p } });
    await Product.destroy({ where: { id: ids.p } });
    await Employee.destroy({ where: { id: empleados } });
    await Role.destroy({ where: { id: roles } });
    await Business.destroy({ where: { id: otro.id } });
  }

  console.log(`\nPasaron ${ok}, fallaron ${ko}`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('vino error:', e.message, e.stack?.split('\n')[1]); process.exit(1); });
