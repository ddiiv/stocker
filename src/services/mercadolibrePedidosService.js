/*
 * Los pedidos de Mercado Libre entrando a Stocker.
 *
 * Hasta ahora la integración era de una sola dirección: se empujaba stock por
 * SKU y nada más. Ninguna venta de ML llegaba al sistema, así que Envíos del
 * Día no tenía de dónde sacar la jornada.
 *
 * ── Por qué webhook y no consultar cada tanto ─────────────────────
 *
 * Flex tiene reloj: el vendedor entrega el mismo día y no llegar al corte
 * golpea la reputación. Con una consulta cada quince minutos, un pedido que
 * entra a las 11:58 con corte a las 13 llega al depósito con quince minutos
 * menos, y eso a veces es la diferencia. Además se gastan llamadas contra el
 * límite de la API aunque no haya ventas.
 *
 * ── Cómo se defiende un endpoint que ML llama sin credenciales ────
 *
 * Mercado Libre no firma las notificaciones —no hay HMAC como el de Mercado
 * Pago—, así que la defensa no puede estar en creer lo que llega. Está en NO
 * creerle:
 *
 *   · La notificación sólo trae un id de recurso. Los datos se leen de la API
 *     de ML con NUESTRO token, así que una notificación falsa no puede
 *     inventar un pedido ni sus cantidades.
 *   · El `user_id` se busca entre las cuentas conectadas. Uno que no
 *     corresponda a ninguna se ignora, y nunca decide de qué negocio es la
 *     venta: eso sale de la cuenta encontrada.
 *   · Se contesta 200 aunque se ignore. Un 4xx hace que ML reintente hasta
 *     ocho veces por algo que nunca va a cambiar.
 *
 * Lo peor que logra una notificación falsa es hacernos consultar un pedido que
 * no existe, y eso ya está acotado por el límite de peticiones del endpoint.
 */

const axios = require('axios');
const { MercadoLibreAccount, PedidoPlataforma } = require('../models');
const ml = require('./mercadolibreService');
const cola = require('./colaVentasOnlineService');
const { log } = require('../utils/logger');

const ML_API = 'https://api.mercadolibre.com';

/*
 * Los tópicos que nos importan.
 *
 * `orders_v2` trae la venta; `shipments` trae cómo y cuándo se despacha. Son
 * dos notificaciones distintas para el mismo pedido y llegan en cualquier
 * orden: la del envío puede llegar antes que la de la orden.
 *
 * `flex-handshakes` avisa cuando el paquete se escanea por primera vez. No se
 * usa todavía; queda anotado porque es el que permitiría cerrar el despacho
 * solo, sin que nadie toque el botón.
 */
const TOPICOS = ['orders_v2', 'orders', 'shipments'];

/** El id que viene al final del `resource` de la notificación. */
function idDeRecurso(resource) {
  const m = String(resource || '').match(/\/(\d+)(?:\/|$)/);
  return m ? m[1] : null;
}

/*
 * De dónde sale el SKU de una línea de la orden.
 *
 * El mismo orden que usa la sincronización de stock, por la misma razón: es el
 * campo que el vendedor ve como "SKU" en el panel de ML, y si acá se mirara
 * otro, la venta descontaría un artículo distinto del que se publicó.
 */
function skuDeLinea(linea) {
  const it = linea?.item || {};
  const porAtributo = (it.variation_attributes || [])
    .find((a) => a.id === 'SELLER_SKU')?.value_name;
  return String(
    it.seller_sku || it.seller_custom_field || porAtributo || '',
  ).trim() || null;
}

/**
 * Trae una orden de ML y la deja en el formato que espera la cola.
 *
 * Las líneas sin SKU se dejan pasar con el nombre de la publicación como
 * referencia: la cola las va a marcar como desconocidas y el pedido va a
 * quedar parcial, que es exactamente lo que hay que ver. Descartarlas acá
 * escondería que se vendió algo que Stocker no sabe manejar.
 */
async function traerOrden(cuenta, ordenId) {
  const token = await ml.tokenValido(cuenta);
  const { data } = await axios.get(`${ML_API}/orders/${ordenId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const comprador = data.buyer || {};
  return {
    ordenCruda: data,
    payload: {
      businessId: cuenta.businessId,
      plataforma: 'mercadolibre',
      pedidoExterno: String(data.id),
      total: Number(data.total_amount) || null,
      comprador: {
        nombre: [comprador.first_name, comprador.last_name].filter(Boolean).join(' ').trim()
          || comprador.nickname || null,
        documento: comprador.billing_info?.doc_number || null,
        email: comprador.email || null,
      },
      items: (data.order_items || []).map((l) => ({
        sku: skuDeLinea(l) || `SIN-SKU:${l.item?.id || 's/id'}`,
        cantidad: Number(l.quantity) || 0,
        precioUnitario: Number(l.unit_price) || null,
      })).filter((i) => i.cantidad > 0),
    },
    envioId: data.shipping?.id ? String(data.shipping.id) : null,
    /*
     * Una orden cancelada en ML no puede entrar a la cola: apartaría stock
     * para una venta que ya no existe.
     */
    cancelada: ['cancelled', 'invalid'].includes(data.status),
  };
}

/*
 * Qué tipo de envío es, en nuestras palabras.
 *
 * `self_service` es Flex: lo despacha el propio vendedor y tiene corte
 * horario. El resto se distingue igual porque la jornada del depósito incluye
 * todo lo que sale hoy, no sólo Flex.
 */
function tipoDeEnvio(envio) {
  const l = String(envio?.logistic_type || '').toLowerCase();
  if (l === 'self_service') return 'flex';
  if (l === 'xd_drop_off' || l === 'drop_off') return 'colecta';
  if (l === 'fulfillment') return 'full';
  if (l === 'cross_docking') return 'cross_docking';
  return l || null;
}

/**
 * Trae un envío y lo deja en los campos que usa Envíos del Día.
 *
 * La hora de corte sale de `estimated_handling_limit`, que es hasta cuándo el
 * vendedor tiene para despachar — no de la fecha estimada de entrega, que es
 * otra cosa y llega días después.
 */
async function traerEnvio(cuenta, envioId) {
  const token = await ml.tokenValido(cuenta);
  const { data } = await axios.get(`${ML_API}/shipments/${envioId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const limite = data.shipping_option?.estimated_handling_limit?.date
    || data.estimated_handling_limit?.date
    || null;

  return {
    envioId: String(data.id),
    envioTipo: tipoDeEnvio(data),
    // Las notificaciones y las fechas de ML vienen en UTC; se guarda como Date
    // y cada pantalla la muestra en la hora de acá.
    despacharAntesDe: limite ? new Date(limite) : null,
    estadoMl: data.status || null,
    ordenExterna: data.order_id ? String(data.order_id) : null,
  };
}

/**
 * Una notificación de Mercado Libre.
 *
 * Devuelve qué se hizo, para poder registrarlo sin tener que adivinar mirando
 * la base después.
 */
async function procesarNotificacion({ topic, resource, userId }) {
  const tema = String(topic || '');
  if (!TOPICOS.includes(tema)) {
    /*
     * El mensaje dice qué falta, no sólo que sobra.
     *
     * Recibir `items` o `stock-locations` y ninguna de pedidos significa una
     * cosa muy concreta: la URL de notificaciones está bien —ML nos está
     * llegando— pero en el panel se tildaron los tópicos equivocados. Un log
     * que sólo dice "tópico que no usamos" deja a quien lo lee sin saber que
     * el problema es de dos casillas, y buscándolo en el código.
     */
    return {
      ignorado: `tópico que no usamos. Para que entren los pedidos hay que tildar `
        + `"orders_v2" y "shipments" en el panel de la aplicación de Mercado Libre`,
      tema,
    };
  }

  const id = idDeRecurso(resource);
  if (!id) return { ignorado: 'el recurso no trae id', tema };

  /*
   * De qué negocio es. Sale de la cuenta conectada, NUNCA de la notificación:
   * si el negocio viniera de afuera, cualquiera podría meterle pedidos a otro.
   */
  const cuenta = await MercadoLibreAccount.findOne({
    where: { mlUserId: String(userId) },
  });
  if (!cuenta) return { ignorado: 'no hay cuenta conectada para ese vendedor', tema };

  if (tema === 'shipments') return actualizarEnvio(cuenta, id);
  return ingresarOrden(cuenta, id);
}

/** La venta: entra a la cola, que es la que aparta el stock. */
async function ingresarOrden(cuenta, ordenId) {
  const { payload, envioId, cancelada } = await traerOrden(cuenta, ordenId);

  if (cancelada) {
    log.info('ml-pedidos', 'orden cancelada en ML: no se encola', { negocio: cuenta.businessId });
    return { accion: 'ignorada', motivo: 'la orden está cancelada en Mercado Libre' };
  }
  if (!payload.items.length) {
    return { accion: 'ignorada', motivo: 'la orden no trae artículos' };
  }

  /*
   * `encolarYProcesar` es idempotente por (negocio, plataforma, pedidoExterno).
   * Hace falta: ML manda una notificación por cada cambio de la venta —el pago,
   * el envío, el feedback— y todas traen el mismo id de orden. Sin eso, cada
   * cambio apartaría el stock de nuevo.
   */
  const { pedido, repetido } = await cola.encolarYProcesar(payload);

  /*
   * El envío se completa acá si la orden ya lo trae. Si no, va a llegar su
   * propia notificación: las dos pueden venir en cualquier orden y el pedido
   * tiene que quedar bien en los dos casos.
   */
  if (envioId && !pedido.envioId) {
    try {
      const envio = await traerEnvio(cuenta, envioId);
      await pedido.update({
        envioId: envio.envioId,
        envioTipo: envio.envioTipo,
        despacharAntesDe: envio.despacharAntesDe,
        estadoEnvioMl: envio.estadoMl,
      });
    } catch (e) {
      // Que no se pueda leer el envío no invalida la venta: el pedido ya está
      // encolado y con el stock apartado, que es lo que no se puede perder.
      log.warn('ml-pedidos', 'no se pudo leer el envío de la orden', {
        negocio: cuenta.businessId, motivo: e.message,
      });
    }
  }

  log.info('ml-pedidos', 'orden de Mercado Libre procesada', {
    negocio: cuenta.businessId, estado: pedido.estado, repetido,
  });
  return { accion: repetido ? 'repetida' : 'encolada', estado: pedido.estado, pedidoId: pedido.id };
}

/** El envío: completa cómo y cuándo se despacha el pedido que ya entró. */
async function actualizarEnvio(cuenta, envioId) {
  const envio = await traerEnvio(cuenta, envioId);

  /*
   * Se busca por el número de orden y no por el de envío: la notificación del
   * envío puede llegar ANTES que la de la orden, y ahí el pedido todavía no
   * existe. En ese caso no hay nada que actualizar y la orden va a traer el
   * envío cuando llegue.
   */
  const pedido = envio.ordenExterna
    ? await PedidoPlataforma.findOne({
      where: {
        businessId: cuenta.businessId,
        plataforma: 'mercadolibre',
        pedidoExterno: envio.ordenExterna,
      },
    })
    : null;

  if (!pedido) {
    return { accion: 'ignorada', motivo: 'todavía no llegó la orden de ese envío' };
  }

  await pedido.update({
    envioId: envio.envioId,
    envioTipo: envio.envioTipo,
    despacharAntesDe: envio.despacharAntesDe,
    estadoEnvioMl: envio.estadoMl,
  });

  log.info('ml-pedidos', 'envío actualizado', {
    negocio: cuenta.businessId, tipo: envio.envioTipo,
  });
  return { accion: 'envio_actualizado', tipo: envio.envioTipo, pedidoId: pedido.id };
}

/*
 * ── Traer las ventas que ya pasaron ──────────────────────────────
 *
 * El webhook sólo avisa de lo que ocurre DESDE que se tildaron los tópicos.
 * Las ventas anteriores nunca generaron una notificación para nosotros, así que
 * por ese camino no van a llegar nunca: hay que ir a buscarlas.
 *
 * Es la misma puerta que el webhook —`encolarYProcesar`, idempotente por
 * (negocio, plataforma, id de orden)—, así que se puede correr las veces que
 * haga falta sin apartar stock dos veces, y sin pisar lo que ya entró.
 *
 * ── Lo que NO se importa, y por qué ──────────────────────────────
 *
 * Los pedidos que ya se despacharon o se cancelaron se saltean. No es por
 * prolijidad: apartar stock para una venta cuya mercadería ya salió del local
 * restaría del inventario algo que físicamente no está, y ese faltante
 * inventado después aparece como un pedido que no se puede despachar.
 *
 * Se cuentan y se informan igual. Un salteo silencioso deja a quien importa
 * creyendo que trajo todo.
 */
async function importarPedidos(businessId, { desde = null, dias = 7, tope = 200 } = {}) {
  const cuenta = await MercadoLibreAccount.findOne({ where: { businessId } });
  if (!cuenta) {
    const e = new Error('No hay una cuenta de Mercado Libre conectada.');
    e.status = 400;
    throw e;
  }

  const cuantosDias = Math.max(1, Math.min(Number(dias) || 7, 60));
  const desdeFecha = desde ? new Date(desde) : new Date(Date.now() - cuantosDias * 86400000);
  if (Number.isNaN(desdeFecha.getTime())) {
    const e = new Error('La fecha desde la que importar no es válida.');
    e.status = 400;
    throw e;
  }

  const token = await ml.tokenValido(cuenta);
  const limite = Math.max(1, Math.min(Number(tope) || 200, 500));

  /*
   * Se pide de a 50, que es el máximo del buscador de ML, y se corta al llegar
   * al tope. Sin tope, un vendedor con miles de ventas del último mes tendría
   * una importación de minutos adentro de una sola request.
   */
  const ordenes = [];
  for (let offset = 0; offset < limite; offset += 50) {
    const { data } = await axios.get(`${ML_API}/orders/search`, {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        seller: cuenta.mlUserId,
        'order.date_created.from': desdeFecha.toISOString(),
        sort: 'date_desc',
        offset,
        limit: Math.min(50, limite - offset),
      },
    });
    const lote = data.results || [];
    ordenes.push(...lote);
    if (lote.length < 50 || ordenes.length >= (data.paging?.total || 0)) break;
  }

  const resumen = {
    encontrados: ordenes.length,
    importados: 0,
    repetidos: 0,
    yaDespachados: 0,
    cancelados: 0,
    sinStock: 0,
    conAvisos: 0,
    errores: [],
    desde: desdeFecha,
  };

  for (const orden of ordenes) {
    try {
      if (['cancelled', 'invalid'].includes(orden.status)) { resumen.cancelados += 1; continue; }

      /*
       * El estado del envío decide si vale la pena traerlo. Se mira ANTES de
       * encolar: encolar es lo que aparta el stock, y apartarlo para algo que
       * ya salió es inventar un faltante.
       */
      let yaSalio = false;
      let envio = null;
      if (orden.shipping?.id) {
        try {
          envio = await traerEnvio(cuenta, String(orden.shipping.id));
          yaSalio = ['shipped', 'delivered', 'not_delivered', 'cancelled'].includes(envio.estadoMl);
        } catch {
          // Sin poder leer el envío se sigue: la venta importa más que saber
          // cómo se despacha, y el dato lo va a traer su notificación.
        }
      }
      if (yaSalio) { resumen.yaDespachados += 1; continue; }

      const r = await ingresarOrdenImportada(cuenta, orden, envio);
      if (r.repetido) resumen.repetidos += 1;
      else if (r.estado === 'rechazado') resumen.sinStock += 1;
      else {
        resumen.importados += 1;
        if (r.estado === 'parcial') resumen.conAvisos += 1;
      }
    } catch (e) {
      // Una orden que falla no voltea la importación: se anota y se sigue.
      resumen.errores.push({ orden: String(orden.id), motivo: (e.message || '').slice(0, 200) });
    }
  }

  log.info('ml-pedidos', 'importación de ventas anteriores', {
    negocio: businessId,
    encontrados: resumen.encontrados,
    importados: resumen.importados,
    salteados: resumen.yaDespachados + resumen.cancelados,
  });
  return resumen;
}

/*
 * Encola una orden que ya viene leída, sin volver a pedírsela a ML.
 *
 * El buscador de órdenes devuelve el pedido completo, así que pedirlo de nuevo
 * de a uno serían doscientas peticiones de más contra el límite de la API para
 * conseguir lo que ya se tiene.
 */
async function ingresarOrdenImportada(cuenta, orden, envioYaLeido = null) {
  const comprador = orden.buyer || {};
  const payload = {
    businessId: cuenta.businessId,
    plataforma: 'mercadolibre',
    pedidoExterno: String(orden.id),
    total: Number(orden.total_amount) || null,
    comprador: {
      nombre: [comprador.first_name, comprador.last_name].filter(Boolean).join(' ').trim()
        || comprador.nickname || null,
      documento: comprador.billing_info?.doc_number || null,
      email: comprador.email || null,
    },
    items: (orden.order_items || []).map((l) => ({
      sku: skuDeLinea(l) || `SIN-SKU:${l.item?.id || 's/id'}`,
      cantidad: Number(l.quantity) || 0,
      precioUnitario: Number(l.unit_price) || null,
    })).filter((i) => i.cantidad > 0),
  };
  if (!payload.items.length) return { repetido: false, estado: 'ignorada' };

  const { pedido, repetido } = await cola.encolarYProcesar(payload);

  const envio = envioYaLeido
    || (orden.shipping?.id ? await traerEnvio(cuenta, String(orden.shipping.id)).catch(() => null) : null);
  if (envio && !pedido.envioId) {
    await pedido.update({
      envioId: envio.envioId,
      envioTipo: envio.envioTipo,
      despacharAntesDe: envio.despacharAntesDe,
      estadoEnvioMl: envio.estadoMl,
    });
  }

  return { repetido, estado: pedido.estado, pedidoId: pedido.id };
}

module.exports = {
  procesarNotificacion, traerOrden, traerEnvio, importarPedidos,
  __skuDeLinea: skuDeLinea, __tipoDeEnvio: tipoDeEnvio, __idDeRecurso: idDeRecurso, TOPICOS,
};
