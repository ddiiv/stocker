/*
 * La ingesta de pedidos de Mercado Libre.
 *
 * Hasta ahora la integración era de una sola dirección: se empujaba stock por
 * SKU y ninguna venta de ML llegaba al sistema. Sin esto, Envíos del Día no
 * tiene de dónde sacar la jornada.
 *
 * Se prueba contra respuestas simuladas de la API de ML. No es por comodidad:
 * pegarle a la API real haría que la suite dependa de que haya ventas ese día,
 * del límite de peticiones y de la cuenta conectada. Lo que importa comprobar
 * —el mapeo de SKU, el orden en que llegan las notificaciones, la idempotencia
 * y las defensas— no necesita a ML del otro lado.
 *
 * Uso:  node scripts/test-ml-webhook.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const Module = require('module');

/*
 * Se intercepta axios ANTES de cargar los servicios, igual que en las suites de
 * ARCA: así se prueba la función que corre en producción y no una gemela.
 */
const RESPUESTAS = new Map();
const PEDIDOS_HECHOS = [];
const originalLoad = Module._load;
Module._load = function (pedido) {
  if (pedido === 'axios') {
    return {
      get: async (url) => {
        PEDIDOS_HECHOS.push(url);
        for (const [patron, data] of RESPUESTAS) {
          if (url.includes(patron)) return { data };
        }
        const e = new Error(`404 simulado para ${url}`);
        e.response = { status: 404 };
        throw e;
      },
      post: async () => ({ data: {} }),
    };
  }
  return originalLoad.apply(this, arguments);
};

const { Op } = require('sequelize');
const {
  Business, BusinessLocation, Product, ProductVariant, VariantStock, StockMovement,
  MercadoLibreAccount, PedidoPlataforma, PedidoPlataformaItem,
} = require('../src/models');
const stock = require('../src/services/stockService');
const mlPedidos = require('../src/services/mercadolibrePedidosService');
const ml = require('../src/services/mercadolibreService');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const ML_USER = '999000111';

(async () => {
  // El token no se renueva contra ML: se le da uno vigente.
  ml.tokenValido = async () => 'TOKEN-QA';

  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  const local = await BusinessLocation.findOne({
    where: { businessId: negocio.id, tipo: 'local', abasteceOnline: true, activo: true },
  });

  const limpiar = async () => {
    const p = await PedidoPlataforma.findAll({ where: { pedidoExterno: { [Op.like]: '77%' } } });
    await PedidoPlataformaItem.destroy({ where: { pedidoId: p.map((x) => x.id) } });
    await PedidoPlataforma.destroy({ where: { id: p.map((x) => x.id) } });
  };
  await limpiar();
  await MercadoLibreAccount.destroy({ where: { mlUserId: ML_USER } });
  await ProductVariant.destroy({ where: { sku: { [Op.like]: 'QA-ML-%' } } });
  await Product.destroy({ where: { sku: 'QA-ML' } });

  const prod = await Product.create({
    businessId: negocio.id, sku: 'QA-ML', skuAgrupador: 'QA-ML', titulo: 'QA Buzo',
    precioMinorista: 5000, precioMayorista: 5000, costo: 2000, activo: true,
  });
  const v = await ProductVariant.create({
    productId: prod.id, businessId: negocio.id, sku: 'QA-ML-1',
    variante1Nombre: 'Talle', variante1Valor: 'M', stock: 0, stockMinimo: 0,
  });
  await stock.mover({ variantId: v.id, businessId: negocio.id, locationId: local.id,
    delta: 20, tipo: 'ingreso', motivo: 'QA ml webhook' });

  /*
   * La cuenta conectada. Es lo que traduce el `user_id` de la notificación a un
   * negocio: sin ella, la notificación se ignora.
   */
  const cuenta = await MercadoLibreAccount.create({
    businessId: negocio.id, mlUserId: ML_USER, nickname: 'QA_VENDEDOR',
    accessToken: 'TOKEN-QA', refreshToken: 'REFRESH-QA',
    tokenExpiraEn: new Date(Date.now() + 5 * 3600 * 1000),
  });

  const estante = () => stock.stockEn(v.id, local.id);
  const apartado = async () => {
    const f = await VariantStock.findOne({ where: { productVariantId: v.id, locationId: local.id } });
    return Number(f?.reservado) || 0;
  };

  const orden = (id, extra = {}) => ({
    id: Number(id), status: 'paid', total_amount: 10000,
    buyer: { first_name: 'Ana', last_name: 'Gómez', nickname: 'ANAG', email: 'ana@test.local' },
    order_items: [{ quantity: 2, unit_price: 5000, item: { id: 'MLA123', seller_sku: 'QA-ML-1' } }],
    shipping: { id: 4400001 },
    ...extra,
  });

  const envio = (extra = {}) => ({
    id: 4400001, order_id: 77000001, status: 'ready_to_ship',
    logistic_type: 'self_service',
    shipping_option: { estimated_handling_limit: { date: new Date(Date.now() + 3 * 3600e3).toISOString() } },
    ...extra,
  });

  try {
    tit('1. UNA VENTA DE ML ENTRA Y APARTA STOCK');
    RESPUESTAS.set('/orders/77000001', orden(77000001));
    RESPUESTAS.set('/shipments/4400001', envio());

    const antes = await estante();
    const r1 = await mlPedidos.procesarNotificacion({
      topic: 'orders_v2', resource: '/orders/77000001', userId: ML_USER,
    });
    chk('la orden se encola', 'encolada', r1.accion);
    chk('y queda aceptada', 'aceptado', r1.estado);
    chk('el estante NO baja', antes, await estante());
    chk('pero se apartan 2', 2, await apartado());

    const pedido = await PedidoPlataforma.findByPk(r1.pedidoId);
    chk('con el comprador de ML', 'Ana Gómez', pedido.compradorNombre);
    chk('y el envío completado desde la orden', ['4400001', 'flex'],
      [pedido.envioId, pedido.envioTipo]);
    chk('con la hora de corte', true, Boolean(pedido.despacharAntesDe));

    tit('2. ML NOTIFICA MUCHAS VECES LA MISMA VENTA');
    /*
     * Manda una notificación por cada cambio —el pago, el envío, el feedback— y
     * todas traen el mismo id de orden. Sin idempotencia, cada cambio apartaría
     * el stock otra vez.
     */
    const r2 = await mlPedidos.procesarNotificacion({
      topic: 'orders_v2', resource: '/orders/77000001', userId: ML_USER,
    });
    chk('la segunda se reconoce como repetida', 'repetida', r2.accion);
    chk('y no aparta de nuevo', 2, await apartado());

    tit('3. EL ENVÍO PUEDE LLEGAR ANTES QUE LA ORDEN');
    /*
     * Las dos notificaciones son independientes y llegan en cualquier orden.
     * Con el envío primero, el pedido todavía no existe: no hay nada que
     * actualizar y la orden lo va a traer cuando llegue.
     */
    RESPUESTAS.set('/shipments/4400002', envio({ id: 4400002, order_id: 77000002 }));
    const r3 = await mlPedidos.procesarNotificacion({
      topic: 'shipments', resource: '/shipments/4400002', userId: ML_USER,
    });
    chk('se ignora sin romper', 'ignorada', r3.accion);
    chk('diciendo por qué', true, /todavía no llegó la orden/.test(r3.motivo || ''));

    RESPUESTAS.set('/orders/77000002', orden(77000002, {
      shipping: { id: 4400002 },
      order_items: [{ quantity: 1, unit_price: 5000, item: { id: 'MLA9', seller_sku: 'QA-ML-1' } }],
    }));
    const r4 = await mlPedidos.procesarNotificacion({
      topic: 'orders_v2', resource: '/orders/77000002', userId: ML_USER,
    });
    chk('y cuando llega la orden, entra completa', 'encolada', r4.accion);
    const p2 = await PedidoPlataforma.findByPk(r4.pedidoId);
    chk('con su envío', ['4400002', 'flex'], [p2.envioId, p2.envioTipo]);

    tit('4. EL ENVÍO QUE LLEGA DESPUÉS COMPLETA AL PEDIDO');
    await p2.update({ envioTipo: null, despacharAntesDe: null });
    RESPUESTAS.set('/shipments/4400002', envio({
      id: 4400002, order_id: 77000002, logistic_type: 'xd_drop_off',
    }));
    const r5 = await mlPedidos.procesarNotificacion({
      topic: 'shipments', resource: '/shipments/4400002', userId: ML_USER,
    });
    chk('el envío actualiza el pedido', 'envio_actualizado', r5.accion);
    chk('con el tipo traducido', 'colecta', r5.tipo);

    tit('5. UNA ORDEN CANCELADA NO APARTA NADA');
    /*
     * Apartar stock para una venta que ya no existe deja mercadería
     * comprometida sin nada que la libere.
     */
    RESPUESTAS.set('/orders/77000003', orden(77000003, { status: 'cancelled' }));
    const apartadoAntes = await apartado();
    const r6 = await mlPedidos.procesarNotificacion({
      topic: 'orders_v2', resource: '/orders/77000003', userId: ML_USER,
    });
    chk('se ignora', 'ignorada', r6.accion);
    chk('diciendo que está cancelada', true, /cancelada/.test(r6.motivo || ''));
    chk('sin apartar nada', apartadoAntes, await apartado());

    tit('6. UNA LÍNEA SIN SKU NO SE ESCONDE');
    /*
     * Descartarla acá ocultaría que se vendió algo que Stocker no sabe manejar.
     * Entra marcada, el pedido queda parcial, y alguien tiene que darla de alta
     * o cancelar la venta.
     */
    RESPUESTAS.set('/orders/77000004', orden(77000004, {
      shipping: { id: 4400004 },
      order_items: [
        { quantity: 1, unit_price: 5000, item: { id: 'MLA9', seller_sku: 'QA-ML-1' } },
        { quantity: 1, unit_price: 3000, item: { id: 'MLA77' } },
      ],
    }));
    RESPUESTAS.set('/shipments/4400004', envio({ id: 4400004, order_id: 77000004 }));
    const r7 = await mlPedidos.procesarNotificacion({
      topic: 'orders_v2', resource: '/orders/77000004', userId: ML_USER,
    });
    chk('el pedido entra', 'encolada', r7.accion);
    chk('y queda parcial', 'parcial', r7.estado);
    const items4 = await PedidoPlataformaItem.findAll({ where: { pedidoId: r7.pedidoId } });
    chk('la línea sin SKU queda con una referencia rastreable', true,
      items4.some((i) => /^SIN-SKU:MLA77$/.test(i.sku)));

    tit('7. DE DÓNDE SALE EL SKU');
    // El mismo orden que usa la sincronización de stock: si acá se mirara otro
    // campo, la venta descontaría un artículo distinto del que se publicó.
    chk('seller_sku primero', 'A',
      mlPedidos.__skuDeLinea({ item: { seller_sku: 'A', seller_custom_field: 'B' } }));
    chk('después seller_custom_field', 'B',
      mlPedidos.__skuDeLinea({ item: { seller_custom_field: 'B' } }));
    chk('y por último el atributo SELLER_SKU', 'C',
      mlPedidos.__skuDeLinea({ item: { variation_attributes: [{ id: 'SELLER_SKU', value_name: 'C' }] } }));
    chk('sin nada, null', null, mlPedidos.__skuDeLinea({ item: {} }));

    tit('8. LOS TIPOS DE ENVÍO SE TRADUCEN');
    chk('self_service es Flex', 'flex', mlPedidos.__tipoDeEnvio({ logistic_type: 'self_service' }));
    chk('xd_drop_off es colecta', 'colecta', mlPedidos.__tipoDeEnvio({ logistic_type: 'xd_drop_off' }));
    chk('fulfillment es Full', 'full', mlPedidos.__tipoDeEnvio({ logistic_type: 'fulfillment' }));
    chk('uno desconocido pasa tal cual', 'otra_cosa',
      mlPedidos.__tipoDeEnvio({ logistic_type: 'otra_cosa' }));

    tit('9. LAS DEFENSAS');
    /*
     * ML no firma las notificaciones. Lo que las hace inofensivas es que sólo
     * se toma el id del recurso y los datos se leen de la API con nuestro
     * token: una notificación falsa no puede inventar un pedido ni cantidades.
     */
    const ajena = await mlPedidos.procesarNotificacion({
      topic: 'orders_v2', resource: '/orders/77000001', userId: '111222333',
    });
    chk('un vendedor sin cuenta conectada se ignora', true, Boolean(ajena.ignorado));
    chk('sin decir nada del pedido', true, /no hay cuenta conectada/.test(ajena.ignorado || ''));

    const raro = await mlPedidos.procesarNotificacion({
      topic: 'items', resource: '/items/MLA1', userId: ML_USER,
    });
    chk('un tópico que no usamos se ignora', true, Boolean(raro.ignorado));

    const sinId = await mlPedidos.procesarNotificacion({
      topic: 'orders_v2', resource: '/orders/', userId: ML_USER,
    });
    chk('un recurso sin id se ignora', true, Boolean(sinId.ignorado));

    /*
     * Y lo que más importa: el negocio NUNCA sale de la notificación. Aunque
     * venga uno en el cuerpo, se usa el de la cuenta encontrada por user_id.
     */
    const otroNegocio = await Business.findOne({ where: { id: { [Op.ne]: negocio.id } } });
    if (otroNegocio) {
      RESPUESTAS.set('/orders/77000005', orden(77000005, { shipping: null }));
      const r9 = await mlPedidos.procesarNotificacion({
        topic: 'orders_v2', resource: '/orders/77000005', userId: ML_USER,
        businessId: otroNegocio.id,   // se manda a propósito: tiene que ignorarse
      });
      const p9 = await PedidoPlataforma.findByPk(r9.pedidoId);
      chk('el negocio sale de la cuenta, no del cuerpo', negocio.id, p9.businessId);
    }

  } finally {
    tit('Limpieza');
    await limpiar();
    await MercadoLibreAccount.destroy({ where: { mlUserId: ML_USER } });
    await StockMovement.destroy({ where: { productVariantId: v.id } });
    await VariantStock.destroy({ where: { productVariantId: v.id } });
    await ProductVariant.destroy({ where: { id: v.id } });
    await Product.destroy({ where: { id: prod.id } });
    chk('no queda la cuenta de prueba', 0,
      await MercadoLibreAccount.count({ where: { mlUserId: ML_USER } }));
    chk('ni sus pedidos', 0,
      await PedidoPlataforma.count({ where: { pedidoExterno: { [Op.like]: '77%' } } }));
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
