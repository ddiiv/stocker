/*
 * Que el número de comprobante nunca choque contra el índice único.
 *
 * Existe por un incidente en producción: convertir una cotización en venta
 * reescribe el `numero` de una fila que ya existía, así que un número recién
 * emitido queda sobre un id viejo. El generador leía "el último por id" y a
 * partir de esa conversión devolvía para siempre un número ya usado. No era
 * una carrera de dos cajas: era el punto de venta caído, todas las ventas
 * rebotando, hasta que alguien mirara la base.
 *
 * Por eso las dos primeras pruebas son sobre el orden de escritura y no sobre
 * concurrencia. La concurrencia va al final y es la que ya estaba cubierta.
 *
 * Uso:  API=http://localhost:3000 node scripts/test-numeracion.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const API = process.env.API || 'http://localhost:3000';
const { Business, BusinessLocation, ProductVariant, VariantStock, Sale, SaleItem } = require('../src/models');
const stock = require('../src/services/stockService');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

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

const correlativo = (numero) => Number(String(numero || '').split('-').pop());
const { nextSaleNumber } = require('../src/services/invoiceNumberService');

(async () => {
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } })
    || await Business.findOne({ order: [['id', 'ASC']] });
  const local = await BusinessLocation.findOne({ where: { businessId: negocio.id, tipo: 'local', activo: true } });

  // Una variante con stock de sobra en ese local: acá no se prueba stock.
  const existencias = await VariantStock.findAll({ where: { locationId: local.id }, limit: 500 });
  const conStock = existencias.find((e) => (e.stock ?? 0) >= 40);
  if (!conStock) { console.log('Sin variante con stock suficiente en', local.nombre); process.exit(1); }
  const variante = await ProductVariant.findByPk(conStock.productVariantId);

  const api = sesion();
  const login = await api('POST', '/api/auth/login', { email: negocio.email, password: 'Demo2026!!' });
  if (login.status !== 200) { console.log('No se pudo entrar como', negocio.email, login.status); process.exit(1); }

  const creados = [];
  const base = {
    locationId: local.id,
    items: [{ productVariantId: variante.id, cantidad: 1, precioUnitario: 1000 }],
    estado: 'pagado', medioPago: 'efectivo',
  };
  const vender = async () => {
    const r = await api('POST', '/api/sales', base);
    if (r.json?.id) creados.push(r.json.id);
    return r;
  };

  tit('Una venta detrás de otra');
  const a = await vender();
  const b = await vender();
  chk('las dos entran', [201, 201], [a.status, b.status]);
  chk('el número avanza de a uno', 1, correlativo(b.json.numero) - correlativo(a.json.numero));

  tit('Cotización convertida en venta — el caso del incidente');
  /*
   * El orden importa: la cotización se crea ANTES que la venta y se convierte
   * DESPUÉS. Ése era el escenario que rompía la numeración, y sigue siendo el
   * que hay que cubrir.
   *
   * Lo que cambió es cómo se resuelve. Antes la conversión pedía número en ese
   * momento y quedaba con número alto sobre id bajo, que es lo que hacía
   * perder el hilo al generador. Ahora el número estaba apartado desde que se
   * hizo el presupuesto, así que la convertida queda con un número MÁS BAJO
   * que la venta del medio — y eso es correcto: es el que tenía guardado.
   */
  const cot = await api('POST', '/api/sales', { ...base, tipo: 'cotizacion', estado: 'pendiente' });
  if (cot.json?.id) creados.push(cot.json.id);
  chk('la cotización se crea', 201, cot.status);

  const entremedio = await vender();
  chk('una venta entremedio', 201, entremedio.status);

  const conv = await api('POST', `/api/sales/cotizacion/${encodeURIComponent(cot.json.numero)}/convertir`, { locationId: local.id });
  chk('la cotización se convierte', 200, conv.status);
  chk('conserva su id', cot.json.id, conv.json.id);
  chk('y estrena número de venta', true, /^V-/.test(conv.json.numero || ''));
  chk('usa el número que tenía apartado', cot.json.numeroVenta, conv.json.numero);
  chk('que es anterior al de la venta del medio', true,
    correlativo(conv.json.numero) < correlativo(entremedio.json.numero));

  /*
   * Acá, y sólo acá, existe el estado que rompía todo: número alto sobre id
   * bajo y nada todavía que lo tape. Se le pregunta al generador directamente,
   * porque a través de la API el reintento consigue número igual y el error
   * queda invisible. Con la lectura por id esta comprobación falla.
   */
  const proximo = await nextSaleNumber(negocio.id, 'venta');
  const usados = (await Sale.findAll({
    where: { businessId: negocio.id, tipo: 'venta' }, attributes: ['numero'],
  })).map((s) => s.numero);
  const mes = proximo.slice(0, proximo.lastIndexOf('-') + 1);
  const delMes = usados.filter((n) => n.startsWith(mes));
  chk('el generador no repite un número ya emitido', false, delMes.includes(proximo));
  chk('y entrega uno mayor que todos los del mes', true,
    delMes.every((n) => correlativo(n) < correlativo(proximo)));

  const despues = [await vender(), await vender(), await vender()];
  chk('las ventas siguientes NO rebotan', [201, 201, 201], despues.map((r) => r.status));
  chk('y siguen la serie sin repetir', 3,
    new Set(despues.map((r) => correlativo(r.json.numero))).size);
  chk('arrancan después de la convertida', true,
    correlativo(despues[0].json.numero) > correlativo(conv.json.numero));

  tit('La cotización aparta su número de venta');
  /*
   * Entre el presupuesto y la conversión pasan ventas. Sin reserva, la
   * conversión tenía que pedir número en ese momento y competir con ellas;
   * con reserva, el número estaba apartado desde el principio.
   *
   * La contracara es que un presupuesto que nunca se convierte deja un hueco
   * en la serie de ventas. Es deliberado: el número queda guardado por si se
   * convierte más adelante, y el correlativo fiscal es el de la factura, que
   * lleva su propia numeración.
   */
  const cotizar = async () => {
    const r = await api('POST', '/api/sales', { ...base, tipo: 'cotizacion', estado: 'pendiente' });
    if (r.json?.id) creados.push(r.json.id);
    return r;
  };

  const presupuesto = await cotizar();
  chk('la cotización se crea', 201, presupuesto.status);
  chk('se numera como cotización', true, /^COT-/.test(presupuesto.json?.numero || ''));
  chk('y aparta un número de venta', true, /^V-/.test(presupuesto.json?.numeroVenta || ''));
  const apartado = correlativo(presupuesto.json.numeroVenta);

  const enElMedio = [await vender(), await vender()];
  chk('las ventas de mientras tanto entran', [201, 201], enElMedio.map((r) => r.status));
  chk('y ninguna toma el número apartado', false,
    enElMedio.some((r) => correlativo(r.json.numero) === apartado));
  chk('van todas por encima de la reserva', true,
    enElMedio.every((r) => correlativo(r.json.numero) > apartado));

  const convertida = await api('POST',
    `/api/sales/cotizacion/${encodeURIComponent(presupuesto.json.numero)}/convertir`, { locationId: local.id });
  chk('la conversión entra', 200, convertida.status);
  chk('usa exactamente el número apartado', apartado, correlativo(convertida.json?.numero));
  chk('sobre la misma fila', presupuesto.json.id, convertida.json?.id);

  tit('Una cotización sin convertir tampoco cede su número');
  const sinConvertir = await cotizar();
  const quemado = correlativo(sinConvertir.json.numeroVenta);
  const posteriores = [await vender(), await vender()];
  chk('las ventas siguientes lo saltean', false,
    posteriores.some((r) => correlativo(r.json.numero) === quemado));

  // Y el generador tampoco lo entrega si se le pregunta directo.
  const proximoTrasReserva = await nextSaleNumber(negocio.id, 'venta');
  chk('el generador no lo ofrece', false, correlativo(proximoTrasReserva) === quemado);

  tit('Cotizaciones simultáneas: cada una con su reserva');
  const aLaVez = await Promise.all([cotizar(), cotizar(), cotizar(), cotizar()]);
  chk('las cuatro se crean', 4, aLaVez.filter((r) => r.status === 201).length);
  chk('con cuatro reservas distintas', 4,
    new Set(aLaVez.map((r) => r.json?.numeroVenta).filter(Boolean)).size);

  tit('Varias cajas cobrando al mismo tiempo');
  const juntas = await Promise.all(Array.from({ length: 8 }, vender));
  chk('las ocho se registran', 8, juntas.filter((r) => r.status === 201).length);
  const numeros = juntas.map((r) => correlativo(r.json?.numero)).filter(Boolean);
  chk('ocho números distintos', 8, new Set(numeros).size);
  chk('sin huecos en la serie', 7, Math.max(...numeros) - Math.min(...numeros));

  // Limpieza: esto corre contra el negocio de verdad.
  tit('Limpieza');
  for (const id of creados) {
    const venta = await Sale.findByPk(id);
    if (!venta) continue;
    const items = await SaleItem.findAll({ where: { saleId: id } });
    for (const it of items) {
      if (venta.stockDescontado && it.productVariantId) {
        await stock.mover({
          variantId: it.productVariantId, businessId: negocio.id, locationId: venta.locationId,
          delta: it.cantidad, tipo: 'ingreso', motivo: 'Limpieza test-numeracion',
          registrarMovimiento: false,
        }).catch(() => {});
      }
      await it.destroy();
    }
    await venta.destroy();
  }
  chk('no quedan ventas de prueba', 0,
    (await Sale.findAll({ where: { id: creados } })).length);

  console.log(`\n\x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
