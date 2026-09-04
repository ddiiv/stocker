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
let BUSCADOR = [];
const PEDIDOS_HECHOS = [];
const originalLoad = Module._load;
Module._load = function (pedido) {
  if (pedido === 'axios') {
    /*
     * `create` incluido: el servicio de ML arma su propio cliente con agente y
     * timeout propios al cargarse, y sin esto el módulo revienta al importarse
     * —con la suite entera cayéndose sin llegar a correr una sola prueba.
     */
    const cliente = {
      get: async (url, cfg) => {
        PEDIDOS_HECHOS.push(url);
        // El buscador de órdenes: lo usa la importación de ventas anteriores.
        if (url.includes('/orders/search')) {
          const off = Number(cfg?.params?.offset) || 0;
          return { data: { results: BUSCADOR.slice(off, off + 50), paging: { total: BUSCADOR.length } } };
        }
        for (const [patron, data] of RESPUESTAS) {
          if (url.includes(patron)) return { data };
        }
        const e = new Error(`404 simulado para ${url}`);
        e.response = { status: 404 };
        throw e;
      },
      put: async () => ({ data: {} }),
      post: async () => ({ data: {} }),
      create: () => cliente,
    };
    return cliente;
  }
  return originalLoad.apply(this, arguments);
};

const { Op } = require('sequelize');
const {
  Business, BusinessLocation, Product, ProductVariant, VariantStock, StockMovement,
  MercadoLibreAccount, PedidoPlataforma, PedidoPlataformaItem, PackComponente,
} = require('../src/models');
const stock = require('../src/services/stockService');
const packService = require('../src/services/packService');
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
  const packsViejos = await ProductVariant.findAll({ where: { sku: { [Op.like]: 'QA-MLPACK%' } } });
  await PackComponente.destroy({ where: { packVariantId: packsViejos.map((x) => x.id) } });
  await ProductVariant.destroy({ where: { id: packsViejos.map((x) => x.id) } });
  await ProductVariant.destroy({ where: { sku: { [Op.like]: 'QA-ML-%' } } });
  await Product.destroy({ where: { sku: ['QA-ML', 'QA-MLPACK'] } });

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

  /*
   * Un pack sobre el mismo producto.
   *
   * Es el caso que se reporta como roto: en Mercado Libre se publica el SKU del
   * pack, y lo que tiene que bajar del estante son las 3 unidades de la
   * variante, no un pack —que no tiene stock propio—.
   */
  const prodPack = await Product.create({
    businessId: negocio.id, sku: 'QA-MLPACK', skuAgrupador: 'QA-MLPACK',
    titulo: 'QA Pack x3 Buzo', precioMinorista: 15000, precioMayorista: 15000,
    costo: 6000, activo: true,
  });
  const pack = await ProductVariant.create({
    productId: prodPack.id, businessId: negocio.id, sku: 'QA-MLPACK-M',
    variante1Nombre: 'Talle', variante1Valor: 'M', esPack: true,
    stock: 0, stockMinimo: 0,
  });
  await packService.definirComponentes(pack.id, negocio.id, [
    { componenteVariantId: v.id, cantidad: 3 },
  ]);

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

    tit('10. TRAER LAS VENTAS ANTERIORES A CONFIGURAR EL WEBHOOK');
    /*
     * El webhook sólo avisa de lo que pasa DESDE que se tildaron los tópicos.
     * Las ventas de la semana pasada nunca generaron una notificación para
     * nosotros, así que por ese camino no llegan nunca.
     */
    const vieja = (id, estadoEnvio) => {
      // La clave del mock tiene que ser el id del ENVÍO, que es lo que se pide,
      // y no el de la orden: con el de la orden la consulta cae en el 404
      // simulado, `yaSalio` queda en falso y la prueba mide otra cosa.
      const envioId = 44 + id;
      RESPUESTAS.set(`/shipments/${envioId}`, envio({ id: envioId, order_id: id, status: estadoEnvio }));
      return orden(id, { shipping: { id: envioId }, date_created: '2026-08-28T10:00:00.000Z',
        order_items: [{ quantity: 1, unit_price: 5000, item: { id: 'MLA1', seller_sku: 'QA-ML-1' } }] });
    };

    BUSCADOR = [
      vieja(77000010, 'ready_to_ship'),   // todavía hay que despacharla
      vieja(77000011, 'delivered'),       // ya llegó: no se toca
      vieja(77000012, 'shipped'),         // ya salió: no se toca
      { ...vieja(77000013, 'ready_to_ship'), status: 'cancelled' },
    ];

    const apartadoAntesImport = await apartado();
    const imp = await mlPedidos.importarPedidos(negocio.id, { dias: 14 });

    chk('encuentra las cuatro', 4, imp.encontrados);
    chk('importa sólo la que falta despachar', 1, imp.importados);
    chk('saltea las dos que ya salieron', 2, imp.yaDespachados);
    chk('y la cancelada', 1, imp.cancelados);

    /*
     * Lo que importa de verdad: apartar stock para una venta cuya mercadería ya
     * salió restaría del inventario algo que físicamente no está, y ese
     * faltante inventado después aparece como un pedido que no se puede
     * despachar.
     */
    chk('aparta sólo por la que falta despachar', apartadoAntesImport + 1, await apartado());

    const importada = await PedidoPlataforma.findOne({
      where: { pedidoExterno: '77000010' },
    });
    chk('la importada queda lista para despachar', 'aceptado', importada.estado);
    chk('con su envío', 'flex', importada.envioTipo);
    chk('las que ya salieron no se cargaron', 0,
      await PedidoPlataforma.count({ where: { pedidoExterno: ['77000011', '77000012', '77000013'] } }));

    tit('11. IMPORTAR DOS VECES NO APARTA DOS VECES');
    // Se corre de nuevo porque uno la corre de nuevo: no está claro si anduvo,
    // o se cambia el rango de días y se vuelve a apretar.
    const trasPrimera = await apartado();
    const imp2 = await mlPedidos.importarPedidos(negocio.id, { dias: 14 });
    chk('la segunda vez las reconoce', 1, imp2.repetidos);
    chk('sin importar ninguna nueva', 0, imp2.importados);
    chk('y sin apartar de nuevo', trasPrimera, await apartado());

  } finally {
    tit('12. UNA VENTA DE UN PACK POR MERCADO LIBRE');
    /*
     * Lo que se publica en ML es el SKU del pack. Lo que tiene que bajar del
     * estante son las unidades de la variante que lleva adentro: un pack no
     * tiene stock propio, así que si la cola no lo reconociera, el pedido
     * entraría "parcial" con el SKU marcado como desconocido y no se apartaría
     * nada. La venta ocurriría igual y el inventario nunca se enteraría.
     */
    const antesPack = await estante();
    const apartadoAntes = await apartado();

    RESPUESTAS.set('/orders/77000012', orden(77000012, {
      order_items: [{ quantity: 2, unit_price: 15000,
        item: { id: 'MLAPACK', seller_sku: 'QA-MLPACK-M' } }],
      shipping: { id: 4400012 },
    }));
    RESPUESTAS.set('/shipments/4400012', envio({ id: 4400012, order_id: 77000012 }));

    const rPack = await mlPedidos.procesarNotificacion({
      topic: 'orders_v2', resource: '/orders/77000012', userId: ML_USER,
    });
    chk('la venta del pack se acepta', 'aceptado', rPack.estado);
    chk('el SKU del pack no queda como desconocido', 0,
      (rPack.desconocidos || []).length);
    // 2 packs × 3 unidades = 6 apartadas de la VARIANTE, no del pack.
    chk('aparta las unidades de la variante', apartadoAntes + 6, await apartado());
    chk('sin tocar el estante todavía', antesPack, await estante());
    chk('y el pack no tiene reserva propia', 0,
      Number((await VariantStock.findOne({
        where: { productVariantId: pack.id, locationId: local.id },
      }))?.reservado) || 0);

    /*
     * Y en la jornada del depósito tiene que verse que es un pack, con lo que
     * hay que poner adentro de la caja: quien arma no puede adivinar que
     * "QA-MLPACK-M" son tres buzos talle M.
     */
    const envios = require('../src/services/enviosDelDiaService');
    const jornada = await envios.delDia(negocio.id, { filtro: 'todos', diasAdelante: 30 });
    const paquete = jornada.paquetes.find(
      (pq) => pq.ventas.some((vt) => vt.pedidoExterno === '77000012'),
    );
    chk('el paquete aparece en Envíos del Día', true, !!paquete);
    const linea = paquete?.items?.[0];
    chk('la línea está marcada como pack', true, linea?.esPack);
    chk('y dice qué lleva adentro', 'QA-ML-1', linea?.componentes?.[0]?.sku);
    chk('con las unidades ya multiplicadas', 6, linea?.componentes?.[0]?.cantidad);
    // Y por SKU de variante: el modelo y los dos atributos con su nombre.
    chk('la línea trae el modelo', 'QA Pack x3 Buzo', linea?.titulo);
    chk('y el atributo con su nombre', ['Talle', 'M'],
      [linea?.variante1Nombre, linea?.variante1Valor]);
    chk('el componente también', ['Talle', 'M'],
      [linea?.componentes?.[0]?.variante1Nombre, linea?.componentes?.[0]?.variante1Valor]);

    tit('Limpieza');
    await limpiar();
    await MercadoLibreAccount.destroy({ where: { mlUserId: ML_USER } });
    // El pack primero: sus componentes apuntan a la variante.
    await PackComponente.destroy({ where: { packVariantId: pack.id } });
    await VariantStock.destroy({ where: { productVariantId: pack.id } });
    await ProductVariant.destroy({ where: { id: pack.id } });
    await Product.destroy({ where: { id: prodPack.id } });
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
