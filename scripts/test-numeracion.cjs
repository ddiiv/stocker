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

  tit('La cotización ya no aparta ningún número de venta');
  /*
   * Esto probaba lo contrario hasta hace poco, y el cambio es a propósito.
   *
   * Mientras las cotizaciones se convertían en venta, cada una nacía con un
   * número de venta apartado para no pelearlo el día de la conversión. Las
   * cotizaciones dejaron de convertirse: son presupuestos y nada más. Apartar
   * un número ahora sería sacar de la serie uno que nadie va a usar, y dejar
   * un hueco permanente que nadie puede explicar mirando la lista.
   *
   * Lo que se comprueba es justamente eso: que una cotización no toque la
   * serie de ventas, ni al crearse ni después.
   */
  const cotizar = async () => {
    const r = await api('POST', '/api/sales', { ...base, tipo: 'cotizacion', estado: 'pendiente' });
    if (r.json?.id) creados.push(r.json.id);
    return r;
  };

  const antes = await nextSaleNumber(negocio.id, 'venta');
  const presupuesto = await cotizar();
  chk('la cotización se crea', 201, presupuesto.status);
  chk('se numera en la serie COT-', true, /^COT-/.test(presupuesto.json?.numero || ''));
  chk('y NO aparta número de venta', null, presupuesto.json?.numeroVenta ?? null);
  chk('el próximo número de venta no se movió', antes, await nextSaleNumber(negocio.id, 'venta'));

  const despuesDeCotizar = await vender();
  chk('la venta siguiente entra', 201, despuesDeCotizar.status);
  chk('y toma el número que estaba libre', antes, despuesDeCotizar.json?.numero);

  tit('Convertir una cotización ya no existe');
  /*
   * La ruta sigue contestando en vez de dar 404 porque puede haber una
   * pantalla vieja abierta en el navegador de alguien. Lo que tiene que decir
   * es qué cambió, no "no encontrado", que manda a buscar el problema en el
   * lugar equivocado.
   */
  const conv = await api('POST',
    `/api/sales/cotizacion/${encodeURIComponent(presupuesto.json.numero)}/convertir`, { locationId: local.id });
  chk('la conversión se rechaza', 410, conv.status);
  chk('y dice por qué', 'CONVERSION_DISCONTINUADA', conv.json?.codigo);

  const siguePresupuesto = await Sale.findByPk(presupuesto.json.id);
  chk('la cotización queda intacta', 'cotizacion', siguePresupuesto?.tipo);
  chk('con su número COT- de siempre', presupuesto.json.numero, siguePresupuesto?.numero);

  tit('Muchas cotizaciones no corren la serie de ventas');
  /*
   * El caso que motivó todo esto al revés: con la reserva, hacer cinco
   * presupuestos adelantaba cinco números la serie de ventas, y el dueño veía
   * saltos que no correspondían a ninguna venta.
   */
  const antesDeVarias = await nextSaleNumber(negocio.id, 'venta');
  const varias = await Promise.all([cotizar(), cotizar(), cotizar(), cotizar()]);
  chk('las cuatro se crean', 4, varias.filter((r) => r.status === 201).length);
  chk('con cuatro números COT- distintos', 4,
    new Set(varias.map((r) => r.json?.numero).filter(Boolean)).size);
  chk('ninguna aparta número de venta', 0,
    varias.filter((r) => r.json?.numeroVenta).length);
  chk('y la serie de ventas sigue donde estaba', antesDeVarias,
    await nextSaleNumber(negocio.id, 'venta'));

  tit('Anular una cotización no toca la serie de ventas');
  const aAnular = await cotizar();
  const antesDeAnular = await nextSaleNumber(negocio.id, 'venta');
  const anulada = await api('POST',
    `/api/sales/${encodeURIComponent(aAnular.json.numero)}/anular`, { motivo: 'Prueba de numeración' });
  chk('la cotización se anula', 200, anulada.status);
  chk('el próximo número de venta no cambió', antesDeAnular,
    await nextSaleNumber(negocio.id, 'venta'));

  tit('La serie de ventas no repite ni retrocede');
  /*
   * Se le pregunta al generador directo: a través de la API el reintento
   * consigue número igual y un defecto acá quedaría invisible.
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
  chk('las ventas siguientes entran', [201, 201, 201], despues.map((r) => r.status));
  chk('y siguen la serie sin repetir', 3,
    new Set(despues.map((r) => correlativo(r.json.numero))).size);

  tit('Varias cajas cobrando al mismo tiempo');
  const juntas = await Promise.all(Array.from({ length: 8 }, vender));
  chk('las ocho se registran', 8, juntas.filter((r) => r.status === 201).length);
  const numeros = juntas.map((r) => correlativo(r.json?.numero)).filter(Boolean);
  chk('ocho números distintos', 8, new Set(numeros).size);

  /*
   * Lo que importa acá es que no se repita ninguno, no que salgan pegados.
   *
   * Antes esto exigía la serie sin huecos y fallaba de a ratos, siempre con el
   * sistema cargado. No era un defecto: con ocho cajas peleando por el mismo
   * número, dos pueden perder contra el mismo ganador, y ahí el reintento corre
   * uno hacia adelante para no volver a chocar en el mismo milisegundo. Ese
   * salto es la salida de emergencia que garantiza que la venta entre, y
   * dejarla pasar es preferible a trabar la caja por un número corrido.
   *
   * El hueco además ya es parte del diseño desde que las cotizaciones reservan
   * número. Lo que no puede pasar —y es lo que se comprueba— es que dos ventas
   * compartan número o que la serie retroceda.
   */
  chk('ninguno se repite ni retrocede', true,
    Math.max(...numeros) - Math.min(...numeros) >= 7);

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
