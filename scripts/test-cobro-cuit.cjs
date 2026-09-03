/*
 * A qué CUIT del negocio entra cada cobro.
 *
 * Una transferencia, un débito o un QR no pasan por el cajón: caen en la cuenta
 * de alguno de los CUIT del negocio. Con más de un CUIT —que es el caso que
 * esto viene a resolver— saber cuál cobró no es un detalle administrativo: es
 * lo que permite conciliar el extracto del banco contra las ventas, y lo que el
 * cliente necesita ver para transferir al lugar correcto.
 *
 * Lo que se comprueba acá:
 *
 *   · El medio marcado lo exige, y el que no lo está no lo pide ni lo guarda.
 *   · Un CUIT de OTRO negocio se rechaza. Es la defensa que importa: el id
 *     viene del navegador, y ese dato sale impreso en el ticket y en la
 *     factura.
 *   · El destinatario queda congelado en el cobro, así un comprobante ya
 *     emitido no cambia si mañana se corrige la razón social.
 *   · La factura se lleva su propia copia.
 *
 * Uso:  API=http://localhost:3000 node scripts/test-cobro-cuit.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const { Op } = require('sequelize');
const API = process.env.API || 'http://localhost:3000';
const {
  Business, BusinessLocation, BusinessCuit, PaymentMethod, Product, ProductVariant,
  Sale, SaleItem, SalePayment, Invoice, InvoiceItem,
} = require('../src/models');
const stock = require('../src/services/stockService');
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
  const local = await BusinessLocation.findOne({
    where: { businessId: negocio.id, tipo: 'local', activo: true },
  });

  // Un CUIT propio de prueba: el demo tiene uno solo y con uno la elección no
  // se ve. El caso que importa es el del negocio que factura con varios.
  await BusinessCuit.destroy({ where: { cuit: '30111111117' } });
  const cuitSecundario = await BusinessCuit.create({
    businessId: negocio.id, nombre: 'QA Segunda Razón Social',
    cuit: '30111111117', condicionIva: 'Responsable Inscripto', esPrincipal: false,
  });
  const cuitPrincipal = await BusinessCuit.findOne({
    where: { businessId: negocio.id, esPrincipal: true },
  });

  // El CUIT de otro negocio: el que NO se tiene que poder elegir.
  const cuitAjeno = await BusinessCuit.findOne({
    where: { businessId: { [Op.ne]: negocio.id } },
  });

  const efectivo = await PaymentMethod.create({
    businessId: negocio.id, nombre: 'QA Cuit Efectivo',
    esEfectivo: true, destinoCuit: false, ajustePct: 0, activo: true,
  });
  const transfer = await PaymentMethod.create({
    businessId: negocio.id, nombre: 'QA Cuit Transferencia',
    esEfectivo: false, destinoCuit: true, ajustePct: 0, activo: true,
  });

  const prod = await Product.create({
    businessId: negocio.id, sku: 'QA-CUIT', skuAgrupador: 'QA-CUIT', titulo: 'QA Cobro CUIT',
    precioMinorista: 1000, precioMayorista: 1000, costo: 300, activo: true,
  });
  const v = await ProductVariant.create({
    productId: prod.id, businessId: negocio.id, sku: 'QA-CUIT-1',
    variante1Nombre: 'Color', variante1Valor: 'Único', stock: 0, stockMinimo: 0,
  });
  await stock.mover({
    variantId: v.id, businessId: negocio.id, locationId: local.id,
    delta: 50, tipo: 'ingreso', motivo: 'QA cobro cuit',
  });

  const api = sesion();
  const entro = await api('POST', '/api/auth/login', { email: negocio.email, password: 'Demo2026!!' });
  if (entro.status !== 200) { console.log('No se pudo entrar:', entro.status); process.exit(1); }

  const creadas = [];
  const vender = async (pagos, extra = {}) => {
    const r = await api('POST', '/api/sales', {
      tipo: 'venta', estado: 'pagado', locationId: local.id,
      items: [{ productVariantId: v.id, cantidad: 1 }],
      pagos, ...extra,
    });
    if (r.json?.id) creadas.push(r.json.id);
    return r;
  };

  try {
    tit('1. EL MEDIO QUE CAE EN UNA CUENTA EXIGE DECIR EN CUÁL');
    const sinCuit = await vender([{ paymentMethodId: transfer.id, monto: 1000 }]);
    chk('sin CUIT, la venta se rechaza', 400, sinCuit.status);
    chk('y dice qué falta', true, /elegí a qué cuit/i.test(sinCuit.json?.message || ''));

    const conCuit = await vender([
      { paymentMethodId: transfer.id, monto: 1000, businessCuitId: cuitSecundario.id },
    ]);
    chk('con CUIT, entra', 201, conCuit.status);

    const pagoGuardado = await SalePayment.findOne({ where: { saleId: conCuit.json.id } });
    chk('queda anotado el id, para conciliar', cuitSecundario.id, pagoGuardado.businessCuitId);
    chk('y la copia del CUIT y del nombre, para el comprobante',
      ['30111111117', 'QA Segunda Razón Social'],
      [pagoGuardado.destinoCuit, pagoGuardado.destinoNombre]);

    tit('2. UN CUIT DE OTRO NEGOCIO NO SE PUEDE ELEGIR');
    /*
     * El id viene del navegador y termina impreso en el ticket y en la factura.
     * Sin este filtro, cualquiera con la sesión abierta podría emitir
     * comprobantes que nombran a un tercero como destinatario del cobro.
     */
    if (cuitAjeno) {
      const ajeno = await vender([
        { paymentMethodId: transfer.id, monto: 1000, businessCuitId: cuitAjeno.id },
      ]);
      chk('un CUIT ajeno se rechaza', 400, ajeno.status);
      chk('sin decir de quién es', false, new RegExp(cuitAjeno.cuit).test(ajeno.json?.message || ''));
    } else {
      console.log('  (no hay otro negocio cargado: se saltea)');
    }

    const inventado = await vender([
      { paymentMethodId: transfer.id, monto: 1000, businessCuitId: 99999999 },
    ]);
    chk('un id que no existe se rechaza', 400, inventado.status);

    tit('3. EL EFECTIVO NO PREGUNTA NI GUARDA NADA');
    /*
     * Va al cajón: no tiene a qué cuenta caer. Y si alguien manda un CUIT igual,
     * no se guarda: anotar un destinatario que el medio no tiene sería inventar
     * un dato que después sale impreso.
     */
    const enEfectivo = await vender([
      { paymentMethodId: efectivo.id, monto: 1000, businessCuitId: cuitPrincipal.id },
    ]);
    chk('el efectivo entra sin pedir CUIT', 201, enEfectivo.status);
    const pagoEfectivo = await SalePayment.findOne({ where: { saleId: enEfectivo.json.id } });
    chk('y no guarda destinatario aunque se lo manden',
      [null, null], [pagoEfectivo.businessCuitId, pagoEfectivo.destinoCuit]);

    tit('4. PAGO DIVIDIDO: CADA MITAD A DONDE VA');
    const dividido = await api('POST', '/api/sales', {
      tipo: 'venta', estado: 'pagado', locationId: local.id,
      items: [{ productVariantId: v.id, cantidad: 2 }],
      pagos: [
        { paymentMethodId: efectivo.id, monto: 1200 },
        { paymentMethodId: transfer.id, monto: 800, businessCuitId: cuitSecundario.id },
      ],
    });
    if (dividido.json?.id) creadas.push(dividido.json.id);
    chk('la venta dividida entra', 201, dividido.status);
    const dosPagos = await SalePayment.findAll({
      where: { saleId: dividido.json.id }, order: [['id', 'ASC']],
    });
    chk('el efectivo va sin destinatario y la transferencia con el suyo',
      [null, '30111111117'], dosPagos.map((p) => p.destinoCuit));

    tit('5. LA FACTURA SE LLEVA SU PROPIA COPIA');
    /*
     * La factura es una foto: si mañana se corrige la razón social, el
     * comprobante ya emitido tiene que seguir diciendo lo que decía.
     */
    const factura = await api('POST', '/api/invoices', {
      saleId: conCuit.json.id, enviarEmail: false, enviarWhatsapp: false,
    });
    if (factura.status === 201 || factura.status === 200) {
      const guardada = await Invoice.findOne({ where: { saleId: conCuit.json.id } });
      chk('la factura anota a dónde entró el cobro', true,
        /30111111117/.test(guardada?.cobroDestino || ''));
      chk('con la razón social al lado', true,
        /QA Segunda Razón Social/.test(guardada?.cobroDestino || ''));
    } else {
      /*
       * Emitir de verdad depende de AFIP y de la delegación del negocio, que en
       * una máquina de desarrollo casi nunca está. Lo que sí es nuestro —cómo
       * se arma el texto que la factura guarda— se prueba igual, sobre la misma
       * función que usa el controlador.
       */
      console.log(`  (no se pudo emitir contra AFIP: ${factura.status} — se prueba el armado)`);
      const { destinatariosDe } = require('../src/services/pdfService');
      const pagosDeLaVenta = await SalePayment.findAll({ where: { saleId: conCuit.json.id } });
      const armado = destinatariosDe(pagosDeLaVenta);
      chk('el armado nombra el CUIT y la razón social',
        [{ cuit: '30111111117', nombre: 'QA Segunda Razón Social' }], armado);
    }

    /*
     * Dos cobros al mismo CUIT se nombran una sola vez, y uno sin destinatario
     * no aparece. Es lo que evita un ticket que repite tres veces el mismo
     * renglón, o que anuncia un destinatario vacío.
     */
    const { destinatariosDe: agrupar } = require('../src/services/pdfService');
    chk('dos cobros al mismo CUIT dan un solo renglón',
      [{ cuit: '30111111117', nombre: 'QA' }],
      agrupar([
        { destinoCuit: '30111111117', destinoNombre: 'QA' },
        { destinoCuit: '30111111117', destinoNombre: 'QA' },
      ]));
    chk('y los cobros sin destinatario no aparecen', [],
      agrupar([{ destinoCuit: null }, { destinoCuit: '' }, {}]));

    tit('6. EL DESTINATARIO QUEDA CONGELADO');
    /*
     * Se cambia la razón social DESPUÉS del cobro. El cobro ya emitido no puede
     * cambiar: un ticket que cambia de destinatario después de impreso no es un
     * ticket.
     */
    await cuitSecundario.update({ nombre: 'QA Razón Social Corregida' });
    const releido = await SalePayment.findByPk(pagoGuardado.id);
    chk('el cobro sigue nombrando lo que decía', 'QA Segunda Razón Social', releido.destinoNombre);
    await cuitSecundario.update({ nombre: 'QA Segunda Razón Social' });

    tit('7. LA REGLA VIVE EN UNA SOLA FUNCIÓN');
    // Es lo que impide que la pantalla y el servidor se separen.
    const err = await fallo(() => calcularPagos(
      [{ paymentMethodId: transfer.id, monto: 100 }], 100, negocio.id,
    ));
    chk('calcularPagos lo exige por su cuenta', true, /elegí a qué cuit/i.test(err || ''));

    const conDestino = await calcularPagos(
      [{ paymentMethodId: transfer.id, monto: 100, businessCuitId: cuitSecundario.id }],
      100, negocio.id,
    );
    chk('y lo devuelve congelado en la línea',
      ['30111111117', 'QA Segunda Razón Social'],
      [conDestino.lineas[0].destinoCuit, conDestino.lineas[0].destinoNombre]);

    tit('8. UN MEDIO EN EFECTIVO NO PUEDE PEDIR CUIT');
    /*
     * Son excluyentes: lo que va al cajón no cae en una cuenta bancaria. Se
     * frena al configurarlo, que es antes de que el POS empiece a preguntar
     * algo que no tiene respuesta.
     */
    const creado = await api('POST', '/api/payment-methods', {
      nombre: 'QA Cuit Contradictorio', esEfectivo: true, destinoCuit: true,
    });
    chk('marcando las dos, gana el efectivo', [true, false],
      [creado.json?.esEfectivo, creado.json?.destinoCuit]);
    if (creado.json?.id) await PaymentMethod.destroy({ where: { id: creado.json.id } });

    const pasarAEfectivo = await api('PUT', `/api/payment-methods/${transfer.id}`, { esEfectivo: true });
    chk('y pasar a efectivo le saca el destino', false, pasarAEfectivo.json?.destinoCuit);
    await transfer.update({ esEfectivo: false, destinoCuit: true });

  } finally {
    tit('Limpieza');
    for (const id of creadas) {
      await Invoice.findAll({ where: { saleId: id } }).then(async (fs) => {
        for (const f of fs) {
          await InvoiceItem.destroy({ where: { invoiceId: f.id } });
          await f.destroy();
        }
      });
      await SalePayment.destroy({ where: { saleId: id } });
      await SaleItem.destroy({ where: { saleId: id } });
      await Sale.destroy({ where: { id } });
    }
    await require('../src/models').StockMovement.destroy({ where: { productVariantId: v.id } });
    await require('../src/models').VariantStock.destroy({ where: { productVariantId: v.id } });
    await ProductVariant.destroy({ where: { id: v.id } });
    await Product.destroy({ where: { id: prod.id } });
    await PaymentMethod.destroy({ where: { id: [efectivo.id, transfer.id] } });
    await BusinessCuit.destroy({ where: { id: cuitSecundario.id } });
    chk('no quedan ventas de prueba', 0, (await Sale.findAll({ where: { id: creadas } })).length);
    chk('ni el CUIT de prueba', null, await BusinessCuit.findByPk(cuitSecundario.id));
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
