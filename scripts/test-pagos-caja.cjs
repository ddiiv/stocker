/*
 * Pagos repartidos y arqueo de caja.
 *
 * Van juntos porque son la misma plata mirada dos veces: lo que el cajero
 * reparte entre medios de pago es exactamente lo que después tiene que
 * aparecer —o no— en el cajón al cerrar.
 *
 * Lo que cambió y por qué se prueba acá:
 *
 *   · El recargo de cada medio se aplica SIEMPRE, sobre el importe de su
 *     propia línea. Antes, con dos o más medios no se aplicaba ninguno: la
 *     intención era no castigar al que reparte, pero dividir el pago pasaba a
 *     ser la forma de esquivar el recargo.
 *
 *   · El cierre de caja explica la diferencia. Para eso el desglose ahora dice
 *     también CUÁNTAS ventas en efectivo entraron: "faltan $12.400" no es
 *     accionable, "faltan $12.400 de $210.000 en 14 ventas" sí.
 *
 * Uso:  API=http://localhost:3000 node scripts/test-pagos-caja.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const bcrypt = require('bcryptjs');
const API = process.env.API || 'http://localhost:3000';
const {
  Business, BusinessLocation, Product, ProductVariant, VariantStock,
  PaymentMethod, Employee, Role, Sale, SaleItem, SalePayment, StockMovement,
  CashShift, CashMovement,
} = require('../src/models');
const stock = require('../src/services/stockService');
const caja = require('../src/services/cashService');
const { calcularPagos } = require('../src/services/paymentService');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const fallo = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

function sesion() {
  let cookie = '';
  return async (m, ruta, cuerpo) => {
    const r = await fetch(`${API}${ruta}`, {
      method: m,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    const set = r.headers.getSetCookie?.() || [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    let json = null; try { json = JSON.parse(await r.text()); } catch { /* no json */ }
    return { status: r.status, json };
  };
}

(async () => {
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  const local = await BusinessLocation.findOne({ where: { businessId: negocio.id, tipo: 'local', activo: true } });
  const rol = await Role.findOne({ where: { businessId: negocio.id, nombre: 'Administrador' } })
    || await Role.findOne({ where: { businessId: negocio.id } });

  // Efectivo sin ajuste y transferencia con 5% de recargo: el caso del pedido.
  const efectivo = await PaymentMethod.create({
    businessId: negocio.id, nombre: 'QA Efectivo', tipo: 'efectivo',
    esEfectivo: true, ajustePct: 0, activo: true,
  });
  const transfer = await PaymentMethod.create({
    businessId: negocio.id, nombre: 'QA Transferencia', tipo: 'transferencia',
    esEfectivo: false, ajustePct: 5, activo: true,
  });
  const debito = await PaymentMethod.create({
    businessId: negocio.id, nombre: 'QA Débito', tipo: 'tarjeta',
    esEfectivo: false, ajustePct: -2, activo: true,
  });

  const prod = await Product.create({
    businessId: negocio.id, sku: 'QA-PAG', skuAgrupador: 'QA-PAG', titulo: 'QA Pagos',
    precioMinorista: 1000, precioMayorista: 1000, costo: 400, activo: true,
  });
  const v = await ProductVariant.create({
    productId: prod.id, businessId: negocio.id, sku: 'QA-PAG-1',
    variante1Nombre: 'Color', variante1Valor: 'Único', stock: 0, stockMinimo: 0, activo: true,
  });

  const emp = await Employee.create({
    businessId: negocio.id, roleId: rol.id, locationId: local.id, dni: '99660001',
    nombre: 'QA', apellido: 'Caja', email: 'qa.caja@stocker.test',
    passwordHash: await bcrypt.hash('QaCaja2026!', 10), activo: true,
  });

  const creadas = [];
  let turno = null;

  try {
    await stock.mover({
      variantId: v.id, businessId: negocio.id, locationId: local.id,
      delta: 200, tipo: 'ingreso', motivo: 'QA pagos',
    });

    // ─────────────────────────────────────────────────────────────
    tit('1. EL RECARGO CORRE POR CUENTA DE SU PROPIO MEDIO');
    /*
     * El ejemplo del pedido: venta de 1000, 300 por transferencia con 5%.
     * El recargo se calcula sobre 300, no sobre 1000.
     */
    const r = await calcularPagos([
      { paymentMethodId: efectivo.id, monto: 700 },
      { paymentMethodId: transfer.id, monto: 300 },
    ], 1000, negocio.id);

    chk('los netos suman el total', 1000, r.lineas.reduce((s, l) => s + l.monto, 0));
    chk('el efectivo no lleva ajuste', 0, r.lineas[0].ajusteMonto);
    chk('la transferencia lleva su 5%', 15, r.lineas[1].ajusteMonto);
    chk('sobre SU importe, no sobre el total', 315, r.lineas[1].montoFinal);
    chk('el recargo total es 15', 15, r.recargoPagos);
    chk('y se cobran 1015', 1015, r.totalCobrado);

    // ─────────────────────────────────────────────────────────────
    tit('2. ANTES ESTO DABA CERO');
    /*
     * La regla vieja anulaba los ajustes con 2+ medios. Se deja explícito para
     * que nadie la reponga por error creyendo que "repartir no lleva recargo".
     */
    chk('repartir ya no esquiva el recargo', true, r.recargoPagos > 0);

    const solo = await calcularPagos([{ paymentMethodId: transfer.id, monto: 1000 }], 1000, negocio.id);
    chk('y sola cuesta lo mismo proporcionalmente', 50, solo.recargoPagos);

    // ─────────────────────────────────────────────────────────────
    tit('3. VARIOS MEDIOS, CADA UNO CON LO SUYO');
    const tres = await calcularPagos([
      { paymentMethodId: efectivo.id, monto: 500 },
      { paymentMethodId: transfer.id, monto: 300 },
      { paymentMethodId: debito.id,   monto: 200 },
    ], 1000, negocio.id);
    chk('efectivo sin ajuste', 0, tres.lineas[0].ajusteMonto);
    chk('transferencia +5% de 300', 15, tres.lineas[1].ajusteMonto);
    chk('débito −2% de 200', -4, tres.lineas[2].ajusteMonto);
    chk('el neto sigue siendo el total', 1000, tres.lineas.reduce((s, l) => s + l.monto, 0));
    chk('y se cobran 1011', 1011, tres.totalCobrado);

    // ─────────────────────────────────────────────────────────────
    tit('4. EL AJUSTE ESCRITO A MANO GANA');
    const manual = await calcularPagos([
      { paymentMethodId: efectivo.id, monto: 700 },
      { paymentMethodId: transfer.id, monto: 300, ajustePct: 0 },
    ], 1000, negocio.id);
    chk('un cero explícito saca el recargo', 0, manual.recargoPagos);
    chk('y se cobra el neto', 1000, manual.totalCobrado);

    // ─────────────────────────────────────────────────────────────
    tit('5. LO QUE TIENE QUE SUMAR ES EL NETO');
    const corto = await fallo(() => calcularPagos([
      { paymentMethodId: efectivo.id, monto: 700 },
      { paymentMethodId: transfer.id, monto: 200 },
    ], 1000, negocio.id));
    chk('si falta, se rechaza', true, /Faltan/.test(corto || ''));

    /*
     * El recargo NO cubre mercadería.
     *
     * 700 + 285.71 con 5% da 1000 de cobro, pero cubre 985.71 de mercadería.
     * Aceptarlo dejaría la venta con un total que nadie puede reconstruir.
     */
    const conRecargo = await fallo(() => calcularPagos([
      { paymentMethodId: efectivo.id, monto: 700 },
      { paymentMethodId: transfer.id, monto: 285.71 },
    ], 1000, negocio.id));
    chk('el recargo no tapa el faltante', true, /Faltan/.test(conRecargo || ''));

    // ─────────────────────────────────────────────────────────────
    tit('6. LA VENTA GUARDA LO QUE SE COBRÓ');
    const api = sesion();
    const login = await api('POST', '/api/auth/employee-login',
      { email: 'qa.caja@stocker.test', password: 'QaCaja2026!' });
    chk('la empleada entra', 200, login.status);

    const abierto = await api('POST', '/api/cash/abrir', { montoInicial: 5000 });
    chk('abre su turno con 5000', 201, abierto.status);
    turno = await CashShift.findOne({ where: { employeeId: emp.id, estado: 'abierto' } });

    const venta = await api('POST', '/api/sales', {
      tipo: 'venta', estado: 'pagado', locationId: local.id,
      items: [{ productVariantId: v.id, cantidad: 1}],
      pagos: [
        { paymentMethodId: efectivo.id, monto: 700 },
        { paymentMethodId: transfer.id, monto: 300 },
      ],
    });
    if (venta.json?.id) creadas.push(venta.json.id);
    chk('la venta entra', 201, venta.status);
    /*
     * Se comparan como números y no como texto.
     *
     * Postgres devuelve los DECIMAL como string ("1000.00") y SQL Server como
     * número (1000). Comparar el texto haría que esta prueba pasara en un
     * motor y fallara en el otro, que es la peor clase de prueba.
     */
    chk('el total de mercadería es 1000', 1000, Number(venta.json?.total));
    chk('el recargo queda aparte', 15, Number(venta.json?.recargoPagos));
    chk('y lo cobrado es 1015', 1015, Number(venta.json?.totalCobrado));

    // ─────────────────────────────────────────────────────────────
    tit('7. LA CAJA CUENTA SÓLO EL EFECTIVO');
    const estado = await caja.estadoDeTurno(turno);
    chk('entraron 700 en efectivo', 700, estado.desglose.efectivoVentas);
    chk('de una sola venta', 1, estado.desglose.ventasEnEfectivo);
    chk('la transferencia no entra al cajón', true, estado.desglose.efectivoVentas < 1015);
    chk('el esperado es 5000 + 700', 5700, estado.desglose.montoEsperado);

    // ─────────────────────────────────────────────────────────────
    tit('8. UN RETIRO BAJA LO ESPERADO');
    await api('POST', '/api/cash/movimientos', { tipo: 'retiro', monto: 200, motivo: 'QA retiro' });
    const conRetiro = await caja.estadoDeTurno(await CashShift.findByPk(turno.id));
    chk('el retiro se descuenta', 200, conRetiro.desglose.retiros);
    chk('y el esperado baja a 5500', 5500, conRetiro.desglose.montoEsperado);

    // ─────────────────────────────────────────────────────────────
    tit('9. EL CIERRE EXPLICA LA DIFERENCIA');
    const cierre = await api('POST', '/api/cash/cerrar', {
      montoDeclarado: 5400, notaCierre: 'QA',
    });
    chk('el cierre entra', 200, cierre.status);
    chk('faltan 100', -100, cierre.json?.diferencia);
    chk('y lo marca como descuadre', true, cierre.json?.descuadre);

    /*
     * El desglose viaja en la respuesta.
     *
     * Sin esto la pantalla sólo puede decir "faltan $100", que no le sirve a
     * nadie para ir a buscar dónde está.
     */
    const d = cierre.json?.desglose;
    chk('dice con cuánto se abrió', 5000, d?.montoInicial);
    chk('cuánto entró en efectivo', 700, d?.efectivoVentas);
    chk('en cuántas ventas', 1, d?.ventasEnEfectivo);
    chk('cuánto se retiró', 200, d?.retiros);
    chk('y a cuánto tenía que llegar', 5500, d?.montoEsperado);

    const cerrado = await CashShift.findByPk(turno.id);
    chk('el turno queda cerrado', 'cerrado', cerrado.estado);
    chk('con la diferencia congelada', -100, Number(cerrado.diferencia));
    turno = null;
  } finally {
    tit('Limpieza');
    if (turno) {
      await CashMovement.destroy({ where: { cashShiftId: turno.id } });
      await CashShift.destroy({ where: { id: turno.id } });
    } else {
      const t = await CashShift.findOne({ where: { employeeId: emp.id } });
      if (t) { await CashMovement.destroy({ where: { cashShiftId: t.id } }); await CashShift.destroy({ where: { id: t.id } }); }
    }
    for (const id of creadas) {
      await SalePayment.destroy({ where: { saleId: id } });
      await SaleItem.destroy({ where: { saleId: id } });
      await Sale.destroy({ where: { id } });
    }
    await StockMovement.destroy({ where: { productVariantId: v.id } });
    await VariantStock.destroy({ where: { productVariantId: v.id } });
    await ProductVariant.destroy({ where: { id: v.id } });
    await Product.destroy({ where: { id: prod.id } });
    await Employee.destroy({ where: { id: emp.id } });
    await PaymentMethod.destroy({ where: { id: [efectivo.id, transfer.id, debito.id] } });
    chk('no quedan medios de pago de prueba', 0,
      await PaymentMethod.count({ where: { id: [efectivo.id, transfer.id, debito.id] } }));
  }

  console.log(`\n\x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
