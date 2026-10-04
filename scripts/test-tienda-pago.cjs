/*
 * La puerta del pago: que no se despache lo que no se cobró.
 *
 * La tienda minorista aparta la prenda y cobra después —transferencia a 48 h,
 * Pago Fácil a 72 h—, así que un pedido puede entrar debiendo plata. Lo que esta
 * suite cuida son las tres cosas que pueden salir mal con eso:
 *
 *   1. Que el depósito despache mercadería impaga. La puerta tiene que estar
 *      DENTRO de `despachar` y no sólo en el filtro de la lista: las rutas de
 *      despachar toman el id del cuerpo y nunca pasan por `delDia`.
 *   2. Que el filtro nuevo congele Mercado Libre y Jumpseller. Sus pedidos no
 *      informan pago y tienen la columna en NULL: si el filtro compara contra
 *      'pagado' en vez de preguntar por NULL, la pantalla del depósito queda
 *      vacía para todos y los envíos con reloj se pierden ese día.
 *   3. Que un pedido impago quede invisible. Retiene stock —lo publicable es
 *      stock - reservado— así que tiene que aparecer en su propia pestaña, o
 *      nadie se entera de que esa prenda está secuestrada.
 *
 * Los pedidos entran por la cola de verdad, no armados a mano: un pedido sin
 * reserva real lo rechaza `despachar` por su cuenta y la prueba pasaría por el
 * motivo equivocado. Corre en proceso, sin HTTP, para no depender de qué backend
 * tenga el 3000.
 */

require('dotenv').config({ path: __dirname + '/../.env' });

const { Op } = require('sequelize');
const db = require('../src/config/database');
const {
  Business, ProductVariant, VariantStock, PedidoPlataforma, PedidoPlataformaItem,
} = require('../src/models');
const envios = require('../src/services/enviosDelDiaService');
const cola = require('../src/services/colaVentasOnlineService');
const { variantesPublicables, cantidadesPublicables } = require('../src/services/stockPublicableService');
const { localesQueAbastecenOnline } = require('../src/services/stockService');

let ok = 0;
let ko = 0;
const chk = (t, esperado, obtenido) => {
  const igual = JSON.stringify(esperado) === JSON.stringify(obtenido);
  console.log(`  ${igual ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${t}`);
  if (!igual) console.log(`      esperaba ${JSON.stringify(esperado)} · vino ${JSON.stringify(obtenido)}`);
  igual ? (ok += 1) : (ko += 1);
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const QA = 'QA-PAGO-';
let restaurarStock = null;

(async () => {
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } })
    || await Business.findOne({ order: [['id', 'ASC']] });

  const limpiar = async () => {
    const filas = await PedidoPlataforma.findAll({
      where: { pedidoExterno: { [Op.like]: `${QA}%` } }, attributes: ['id'],
    });
    if (filas.length) {
      await PedidoPlataformaItem.destroy({ where: { pedidoId: filas.map((f) => f.id) } });
      await PedidoPlataforma.destroy({ where: { id: filas.map((f) => f.id) } });
    }
  };
  await limpiar();

  try {
    tit('0. QUÉ ESTADO DE PAGO LE TOCA A CADA CANAL');
    /*
     * El default de la tienda es pendiente: falla cerrado. Un paquete retenido
     * se destraba con un clic; uno despachado sin cobrar no vuelve.
     */
    chk('la tienda, sin que el mensaje diga nada, queda pendiente',
      'pendiente', cola.__estadoDePago('tienda', null));
    chk('y si dice que ya está pagado, pagado', 'pagado', cola.__estadoDePago('tienda', false));
    /*
     * Lo que sostiene todo lo demás: para los canales que no informan pago el
     * estado es NULL, no 'pendiente'. Si acá saliera 'pendiente', el depósito se
     * quedaría sin ver un solo pedido de Mercado Libre.
     */
    chk('Mercado Libre no informa pago: NULL, no pendiente',
      [null, null], [cola.__estadoDePago('mercadolibre', null), cola.__estadoDePago('jumpseller', true)]);

    /* Stock conocido, para que los pedidos aparten de verdad. */
    const locales = await localesQueAbastecenOnline(negocio.id);
    const variantes = await variantesPublicables(negocio.id, { soloActivas: true });
    const esperadas = locales.length ? await cantidadesPublicables(negocio.id, locales, variantes) : new Map();
    const variante = variantes.find((v) => Number(esperadas.get(v.id)?.cantidad || 0) > 0) || variantes[0];
    const fila = await VariantStock.findOne({
      where: { productVariantId: variante.id }, order: [['locationId', 'ASC']],
    });
    chk('la prueba arranca con una fila de stock para apartar', true, Boolean(fila));
    restaurarStock = { id: fila.id, stock: fila.stock, reservado: fila.reservado };
    await fila.update({ stock: 30, reservado: 0 });

    const entrar = async (sufijo, datos) => {
      const r = await cola.encolarYProcesar({
        businessId: negocio.id,
        pedidoExterno: `${QA}${sufijo}`,
        items: [{ sku: variante.sku, cantidad: 1 }],
        total: 1000,
        envio: { tipo: 'correo_argentino', despacharAntesDe: new Date().toISOString() },
        ...datos,
      });
      return r.pedido;
    };

    tit('1. EL PAGO SE ESCRIBE AL ENTRAR, NO DESPUÉS');
    /*
     * Dentro del mismo INSERT. Si se escribiera en un update posterior, entre el
     * INSERT y ese update el pedido ya está aceptado y sin marca de pago, y en
     * esa ventana el depósito lo ve despachable.
     */
    const impago = await entrar('001', {
      plataforma: 'tienda', pagoPendiente: true, pagoDetalle: 'Transferencia · vence mañana',
    });
    chk('entra apartado y pendiente de pago', ['aceptado', 'pendiente'],
      [impago.estado, impago.pagoEstado]);
    chk('con el texto para la persona, tal cual lo mandó la tienda',
      'Transferencia · vence mañana', impago.pagoDetalle);
    chk('y con el reloj propio de Stocker puesto', true, Boolean(impago.pagoVenceEn));

    const pagado = await entrar('002', { plataforma: 'tienda', pagoPendiente: false });
    chk('uno que ya venía cobrado entra pagado y sin reloj', ['pagado', null],
      [pagado.pagoEstado, pagado.pagoVenceEn ?? null]);

    const deMl = await entrar('003', { plataforma: 'mercadolibre' });
    chk('Mercado Libre entra sin estado de pago', null, deMl.pagoEstado ?? null);

    tit('2. LA PUERTA DEL DEPÓSITO');
    const vista = await envios.delDia(negocio.id, { filtro: 'para_enviar' });
    const enLaLista = (r, nro) => (r.paquetes || []).some((q) => (q.items || []).length >= 0
      && String(JSON.stringify(q)).includes(nro));
    chk('el impago no está en «para enviar»', false, enLaLista(vista, `${QA}001`));
    chk('el pagado sí', true, enLaLista(vista, `${QA}002`));
    chk('y el de Mercado Libre también: su pago en NULL no lo saca', true,
      enLaLista(vista, `${QA}003`));

    const soloImpagos = await envios.delDia(negocio.id, { filtro: 'sin_pagar' });
    chk('el impago aparece en «sin pagar», no invisible', true, enLaLista(soloImpagos, `${QA}001`));

    const despachar = async (p) => {
      try {
        await envios.despachar({ businessId: negocio.id, pedidoId: p.id, employeeId: null });
        return 'pasó';
      } catch (e) { return { status: e.status, codigo: e.codigo || null }; }
    };

    /*
     * La puerta va DENTRO de despachar. El filtro de la lista es una comodidad:
     * las rutas de despachar toman el id del cuerpo y nunca pasan por la lista,
     * así que alguien con el id —un reintento viejo, una pantalla abierta de
     * antes— despacharía mercadería impaga.
     */
    chk('despachar el impago por su id se corta con SIN_PAGAR',
      { status: 409, codigo: 'SIN_PAGAR' }, await despachar(impago));
    chk('y el mensaje trae el texto del pago, para que la pantalla diga por qué',
      true, await (async () => {
        try { await envios.despachar({ businessId: negocio.id, pedidoId: impago.id, employeeId: null }); return false; } catch (e) { return /Transferencia/.test(e.message); }
      })());
    chk('el pagado se despacha', 'pasó', await despachar(pagado));
    chk('y el de Mercado Libre también', 'pasó', await despachar(deMl));
  } finally {
    tit('Limpieza');
    await limpiar();
    if (restaurarStock) {
      await VariantStock.update(
        { stock: restaurarStock.stock, reservado: restaurarStock.reservado },
        { where: { id: restaurarStock.id } },
      );
    }
    chk('no queda nada de la prueba', 0,
      await PedidoPlataforma.count({ where: { pedidoExterno: { [Op.like]: `${QA}%` } } }));
    await db.close();
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
