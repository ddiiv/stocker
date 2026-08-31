/*
 * Que la venta descuente del local correcto, con el empleado correcto.
 *
 * Contra la API real y no contra los servicios: lo que hay que probar es la
 * regla completa —quién vende, desde dónde, y qué pasa si eso no está claro—,
 * y esa regla vive en el controlador, no en el servicio de stock.
 *
 * Uso:  API=http://localhost:3000 node scripts/test-venta-local.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const API = process.env.API || 'http://localhost:3000';
const bcrypt = require('bcryptjs');
const {
  Business, BusinessLocation, Employee, Role, Product, ProductVariant,
  VariantStock, StockMovement, Sale, SaleItem, PaymentMethod, CashShift,
} = require('../src/models');
const stock = require('../src/services/stockService');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

// Cliente HTTP mínimo con cookies.
function sesion() {
  let cookie = '';
  return async (metodo, ruta, cuerpo) => {
    const r = await fetch(`${API}${ruta}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    const set = r.headers.getSetCookie?.() || [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const texto = await r.text();
    let json = null; try { json = JSON.parse(texto); } catch { /* no json */ }
    return { status: r.status, json, texto };
  };
}

(async () => {
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  const locales = await BusinessLocation.findAll({ where: { businessId: negocio.id, activo: true }, order: [['id', 'ASC']] });
  const [A, B] = locales;
  // Mismo resguardo que en test-alta-stock: sin dos locales de venta, el fallo
  // aparece cincuenta líneas después y no dice qué falta.
  if (!A || !B) {
    console.error(`\x1b[31m✖ Hacen falta DOS locales de tipo "local" en el demo, y hay ${locales.length}.\x1b[0m`);
    process.exit(1);
  }
  const metodo = await PaymentMethod.findOne({ where: { businessId: negocio.id } });

  const prod = await Product.create({
    businessId: negocio.id, sku: 'QA-VL', skuAgrupador: 'QA-VL', titulo: 'QA Venta por local',
    precioMinorista: 100, precioMayorista: 80, costo: 40, activo: true,
  });
  const v = await ProductVariant.create({
    productId: prod.id, businessId: negocio.id, sku: 'QA-VL-1',
    variante1Nombre: 'Color', variante1Valor: 'Rojo', stock: 0, stockMinimo: 0,
  });

  // Empleado con local (A) y empleado sin local, ambos con permiso de vender.
  const rol = await Role.findOne({ where: { businessId: negocio.id, nombre: 'Administrador' } })
    || await Role.findOne({ where: { businessId: negocio.id } });
  const pass = await bcrypt.hash('QaVenta2026!', 10);
  const conLocal = await Employee.create({
    businessId: negocio.id, roleId: rol.id, locationId: A.id, dni: '99000001',
    nombre: 'QA', apellido: 'ConLocal', email: 'qa.conlocal@stocker.test', passwordHash: pass, activo: true,
  });
  const sinLocal = await Employee.create({
    businessId: negocio.id, roleId: rol.id, locationId: null, dni: '99000002',
    nombre: 'QA', apellido: 'SinLocal', email: 'qa.sinlocal@stocker.test', passwordHash: pass, activo: true,
  });

  const enA = () => stock.stockEn(v.id, A.id);
  const enB = () => stock.stockEn(v.id, B.id);
  const item = { productVariantId: v.id, cantidad: 2, precioUnitario: 100 };
  const pago = (t) => [{ paymentMethodId: metodo.id, monto: t }];

  const creadas = [];
  try {
    // 8 en A y 8 en B.
    await stock.mover({ variantId: v.id, businessId: negocio.id, locationId: A.id, delta: 8, tipo: 'ingreso', motivo: 'QA' });
    await stock.mover({ variantId: v.id, businessId: negocio.id, locationId: B.id, delta: 8, tipo: 'ingreso', motivo: 'QA' });

    tit('1. EL DUEÑO TIENE QUE ELEGIR EL LOCAL');
    const dueno = sesion();
    await dueno('POST', '/api/auth/login', { email: 'demo@stocker.app', password: 'Demo2026!!' });
    const sinElegir = await dueno('POST', '/api/sales', { tipo: 'venta', estado: 'pagado', items: [item], pagos: pago(200) });
    chk('sin elegir local, la venta se rechaza', 400, sinElegir.status);
    chk('y dice por qué', true, /Elegí de qué local/.test(sinElegir.json?.message || ''));
    chk('no se movió stock de ningún local', [8, 8], [await enA(), await enB()]);

    tit('2. EL DUEÑO ELIGE: SALE DE ESE LOCAL');
    const enB1 = await dueno('POST', '/api/sales', { tipo: 'venta', estado: 'pagado', locationId: B.id, items: [item], pagos: pago(200) });
    chk('la venta entra', 201, enB1.status);
    if (enB1.json?.id) creadas.push(enB1.json.id);
    chk('bajó el local elegido',      6, await enB());
    chk('el otro local no se tocó',   8, await enA());

    tit('3. UN LOCAL AJENO SE RECHAZA');
    const otroNegocio = await BusinessLocation.findOne({ where: { businessId: { [require('sequelize').Op.ne]: negocio.id } } });
    if (otroNegocio) {
      const ajeno = await dueno('POST', '/api/sales', { tipo: 'venta', estado: 'pagado', locationId: otroNegocio.id, items: [item], pagos: pago(200) });
      chk('local de otro negocio, rechazado', 400, ajeno.status);
      chk('sin tocar stock', [8, 6], [await enA(), await enB()]);
    }

    tit('4. EL EMPLEADO VENDE EN SU LOCAL');
    const emp = sesion();
    const login = await emp('POST', '/api/auth/employee-login', { email: 'qa.conlocal@stocker.test', password: 'QaVenta2026!' });
    chk('el empleado entra', 200, login.status);

    // Sin turno de caja abierto el sistema no deja vender: se abre uno.
    const turno = await CashShift.create({
      businessId: negocio.id, employeeId: conLocal.id, locationId: A.id,
      abiertoEn: new Date(), montoInicial: 0, estado: 'abierto',
    });

    /*
     * Se manda a propósito el local B en el cuerpo. El servidor tiene que
     * ignorarlo y usar el del empleado: si un empleado pudiera elegir, podría
     * descontar del stock de otra sucursal desde su propia caja.
     */
    const ventaEmp = await emp('POST', '/api/sales', { tipo: 'venta', estado: 'pagado', locationId: B.id, items: [item], pagos: pago(200) });
    chk('la venta del empleado entra', 201, ventaEmp.status);
    if (ventaEmp.json?.id) creadas.push(ventaEmp.json.id);
    chk('salió de SU local, no del que pidió', 6, await enA());
    chk('el local B quedó igual',              6, await enB());
    await turno.destroy();

    tit('5. EMPLEADO SIN LOCAL: NO PUEDE VENDER');
    const emp2 = sesion();
    await emp2('POST', '/api/auth/employee-login', { email: 'qa.sinlocal@stocker.test', password: 'QaVenta2026!' });
    const turno2 = await CashShift.create({
      businessId: negocio.id, employeeId: sinLocal.id, locationId: null,
      abiertoEn: new Date(), montoInicial: 0, estado: 'abierto',
    });
    const sinL = await emp2('POST', '/api/sales', { tipo: 'venta', estado: 'pagado', items: [item], pagos: pago(200) });
    chk('se rechaza', 409, sinL.status);
    chk('y explica qué hacer', true, /local asignado/.test(sinL.json?.message || ''));
    chk('no movió stock', [6, 6], [await enA(), await enB()]);
    await turno2.destroy();

    tit('6. VENDER LO QUE NO HAY, SEGÚN LA POLÍTICA DEL NEGOCIO');
    /*
     * El mostrador manda, pero ya no en silencio.
     *
     * Hasta hace poco la venta pasaba igual y el local quedaba en negativo,
     * "a la vista" en Stock a regularizar. En la práctica nadie lo regularizaba
     * y el inventario se volvía ficción. Ahora se pregunta: si la persona
     * confirma que la mercadería está, se da de alta y después se descuenta,
     * así que el stock nunca pasa por negativo. El detalle fino de este
     * circuito está en test-alta-stock.cjs; acá se comprueba que el local
     * correcto es el que se mira y el que se toca.
     */
    await stock.mover({ variantId: v.id, businessId: negocio.id, locationId: A.id, fijar: 0, tipo: 'ajuste', motivo: 'QA' });

    await negocio.update({ ventaSinStock: 'permitir' });
    const pregunta = await dueno('POST', '/api/sales', { tipo: 'venta', estado: 'pagado', locationId: A.id, items: [item], pagos: pago(200) });
    chk('con "permitir" la venta pregunta antes', 409, pregunta.status);
    chk('con el código que la pantalla espera', 'SIN_STOCK', pregunta.json?.codigo);
    chk('ofreciendo dar de alta', true, pregunta.json?.puedeConfirmar);
    chk('nombra el local donde falta', A.nombre, pregunta.json?.local);
    chk('y avisa que hay en el otro', 6, pregunta.json?.faltantes?.[0]?.enOtrosLocales);
    chk('sin tocar nada mientras tanto', 0, await enA());

    const confirmada = await dueno('POST', '/api/sales', { tipo: 'venta', estado: 'pagado', locationId: A.id, items: [item], pagos: pago(200), confirmarAltaStock: true });
    chk('confirmando, la venta entra', 201, confirmada.status);
    chk('el local queda en cero, nunca en negativo', 0, await enA());
    chk('el stock de B quedó intacto', 6, await enB());

    // Y con la política estricta ni siquiera se ofrece.
    await negocio.update({ ventaSinStock: 'bloquear' });
    const falta = await dueno('POST', '/api/sales', { tipo: 'venta', estado: 'pagado', locationId: A.id, items: [item], pagos: pago(200) });
    chk('con "bloquear" la venta se frena', 409, falta.status);
    chk('nombra el local',   true, new RegExp(A.nombre).test(falta.json?.message || ''));
    chk('sin ofrecer confirmar', false, falta.json?.puedeConfirmar);
    chk('y dice que hay en otro lado', true, /en otros locales/.test(falta.json?.message || ''));
    await negocio.update({ ventaSinStock: 'permitir' });

    tit('7. LOS MOVIMIENTOS QUEDAN CON SU LOCAL Y SU EMPLEADO');
    const movs = await StockMovement.findAll({
      where: { productVariantId: v.id, tipo: 'egreso' },
      order: [['id', 'ASC']],
    });
    chk('hay tres egresos (las dos ventas y la confirmada)', 3, movs.length);
    chk('el primero, del local del dueño', B.id, movs[0]?.locationId);
    chk('el segundo, del local del empleado', A.id, movs[1]?.locationId);
    chk('y con el empleado que vendió', conLocal.id, movs[1]?.employeeId);

    tit('8. ETIQUETAS POR LO QUE ENTRÓ EN EL DÍA');
    /*
     * La cuenta tiene que dar lo que efectivamente se recibió, no la suma de
     * los ingresos. Cargar 15 y corregir −1 porque una vino fallada es haber
     * recibido 14: pidiendo 15 etiquetas sobra una, y eso se descubre recién
     * con el rollo impreso.
     */
    const hoy = new Date().toLocaleDateString('sv-SE');
    const ingresos = async () => {
      const r = await dueno('GET', `/api/stock/ingresos?fecha=${hoy}&locationId=${A.id}`);
      return r.json?.data?.find((x) => x.variantId === v.id)?.unidades ?? 0;
    };
    const cargar = (delta) => dueno('POST', '/api/stock/ajuste-masivo', {
      locationId: A.id, motivo: 'QA carga', items: [{ variantId: v.id, delta }],
    });

    const base = await ingresos();
    await cargar(15);
    chk('un ingreso suma',            base + 15, await ingresos());
    await cargar(-1);
    chk('una corrección resta',       base + 14, await ingresos());

    // Una venta del día no toca la cuenta: la prenda vendida también se etiquetó.
    const antesDeVender = await ingresos();
    const ventaDia = await dueno('POST', '/api/sales', {
      tipo: 'venta', estado: 'pagado', locationId: A.id,
      items: [{ productVariantId: v.id, cantidad: 1, precioUnitario: 100 }], pagos: pago(100),
    });
    if (ventaDia.json?.id) creadas.push(ventaDia.json.id);
    chk('una venta NO resta',         antesDeVender, await ingresos());

    /*
     * Corregir todo lo que entró saca la variante de la lista: no hay nada que
     * etiquetar, y ofrecer cero etiquetas es ruido.
     *
     * Se corrige contra el stock que hay en el local, no contra lo que entró:
     * parte de lo recibido pudo haberse vendido, y sacar más de lo que queda es
     * justamente lo que el sistema tiene que impedir.
     */
    const enElLocal = await stock.stockEn(v.id, A.id);
    const aCorregir = Math.min(enElLocal, antesDeVender - base);
    const corr = await cargar(-aCorregir);
    chk('la corrección entra', 200, corr.status);
    chk('descuenta lo corregido', antesDeVender - aCorregir, await ingresos());

    tit('9. LA INVARIANTE SIGUE EN PIE');
    const filas = await VariantStock.findAll({ where: { productVariantId: v.id } });
    const suma = filas.reduce((s, f) => s + f.stock, 0);
    const total = Number((await ProductVariant.findByPk(v.id)).stock);
    chk('suma de locales = total', suma, total);

  } finally {
    for (const id of creadas) {
      await SaleItem.destroy({ where: { saleId: id } });
      await Sale.destroy({ where: { id } });
    }
    await StockMovement.destroy({ where: { productVariantId: v.id } });
    await SaleItem.destroy({ where: { productVariantId: v.id } });
    await VariantStock.destroy({ where: { productVariantId: v.id } });
    await ProductVariant.destroy({ where: { id: v.id } });
    await Product.destroy({ where: { id: prod.id } });
    await Employee.destroy({ where: { id: [conLocal.id, sinLocal.id] } });
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
