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
const { Op } = require('sequelize');
const { MercadoLibreAccount, PedidoPlataforma } = require('../models');
const ml = require('./mercadolibreService');
const cola = require('./colaVentasOnlineService');
const enviosDelDia = require('./enviosDelDiaService');
const { log } = require('../utils/logger');

const ML_API = 'https://api.mercadolibre.com';

/*
 * ── El formato nuevo de /shipments ───────────────────────────────
 *
 * Desde el 12/10/2025 Mercado Libre exige `x-format-new: true` en TODOS los GET
 * de /shipments y dejó de devolver `order_id` y `external_reference` ahí. Sin
 * el header la respuesta todavía llega en el formato viejo —por eso las ventas
 * seguían entrando y el tipo de envío se leía bien— pero ya sin `order_id`, y
 * el aviso de cada cambio de envío buscaba su pedido por ese número: todos se
 * descartaban con "todavía no llegó la orden". Un envío tomaba su estado al
 * entrar la venta y nunca más se actualizaba.
 *
 * Fuente: developers.mercadolibre.com.ar/es_ar/envios, "Consultar envíos".
 */
const FORMATO_NUEVO = { 'x-format-new': 'true' };
const ESTADOS_ML_TERMINADOS = ['delivered', 'not_delivered', 'cancelled'];
// Sólo tiene sentido pedir el plazo de lo que todavía no salió: la
// documentación pide no consultar el SLA de envíos cancelados.
const ESTADOS_CON_PLAZO = ['pending', 'handling', 'ready_to_ship'];

/*
 * Los tópicos que nos importan.
 *
 * `orders_v2` trae la venta; `shipments` trae cómo y cuándo se despacha. Son
 * dos notificaciones distintas para el mismo pedido y llegan en cualquier
 * orden: la del envío puede llegar antes que la de la orden.
 *
 * `flex-handshakes` avisa cuando el cadete escanea el paquete por primera vez
 * en la app de Flex. En Flex ese escaneo es también lo que pone el envío en
 * `shipped` —imprimir la etiqueta NO: eso deja `ready_to_ship` con el
 * subestado `printed`—, así que el handshake y `shipped` dicen lo mismo por
 * dos caminos. Se escuchan los dos: si un aviso se pierde, el otro alcanza.
 *
 * (Esto decía antes que en Flex `shipped` llegaba al imprimir. Era falso, y
 * esa premisa es la que dejaba un Flex ya despachado en "Para enviar".)
 */
const TOPICOS = ['orders_v2', 'orders', 'shipments', 'flex-handshakes'];

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
/** Lo que Stocker necesita de una orden de ML, venga del aviso o del buscador. */
function payloadDeOrden(cuenta, orden) {
  const comprador = orden.buyer || {};
  return {
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
}

/*
 * ¿La orden está cancelada, o hay que tratarla como tal?
 *
 * `fraud_risk_detected` entra acá aunque la orden no diga `cancelled`: la
 * documentación dice que significa "no enviar" y que el vendedor tiene que
 * cancelarla. Para el depósito es exactamente lo mismo que una cancelación.
 */
function ordenCancelada(orden) {
  return ['cancelled', 'invalid'].includes(orden?.status)
    || (orden?.tags || []).includes('fraud_risk_detected');
}

/** El porqué, en palabras, para que el depósito sepa qué pasó sin abrir ML. */
function motivoDeCancelacion(orden) {
  if ((orden?.tags || []).includes('fraud_risk_detected')) {
    return 'Mercado Libre detectó riesgo de fraude: no se despacha';
  }
  const d = orden?.cancel_detail || {};
  const quien = { buyer: 'el comprador', seller: 'el vendedor', mercadolibre: 'Mercado Libre' }[
    String(d.requested_by || '').toLowerCase()];
  const texto = d.description || (quien ? `la pidió ${quien}` : null);
  return `Cancelada en Mercado Libre${texto ? `: ${texto}` : ''}`.slice(0, 480);
}

async function traerOrden(cuenta, ordenId) {
  const token = await ml.tokenValido(cuenta);
  const { data } = await axios.get(`${ML_API}/orders/${ordenId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return {
    ordenCruda: data,
    payload: payloadDeOrden(cuenta, data),
    envioId: data.shipping?.id ? String(data.shipping.id) : null,
    /*
     * Una orden cancelada no entra a la cola como venta: apartaría stock para
     * algo que ya no existe. Pero SÍ se registra —ver `registrarCancelacion`—:
     * descartarla sin rastro era lo que hacía que una cancelación no apareciera
     * en ninguna pestaña, y que una venta cancelada después de entrar dejara su
     * mercadería apartada para siempre.
     */
    cancelada: ordenCancelada(data),
    motivoCancelacion: motivoDeCancelacion(data),
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
  // Formato nuevo: `logistic.type`. Viejo: `logistic_type`. Se leen los dos
  // para no quedar ciegos el día que ML apague el viejo.
  const l = String(envio?.logistic?.type || envio?.logistic_type || '').toLowerCase();
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
async function traerEnvio(cuenta, envioId, { conPlazo = true } = {}) {
  const token = await ml.tokenValido(cuenta);
  const cabeceras = { Authorization: `Bearer ${token}`, ...FORMATO_NUEVO };
  const { data } = await axios.get(`${ML_API}/shipments/${envioId}`, { headers: cabeceras });

  const estadoMl = data.status || null;

  /*
   * El plazo de despacho sale del SLA.
   *
   * `estimated_handling_limit` está deprecado desde el 13/05/2025 y la
   * documentación dice que ese dato "sólo podrá ser consumido en el recurso de
   * SLA". Sin el plazo real, un envío caía en la jornada por el día en que
   * entró la venta y no por el día en que había que despacharlo. Se sigue
   * leyendo el campo viejo como respaldo, por si el SLA no contesta.
   */
  let limite = data.shipping_option?.estimated_handling_limit?.date
    || data.estimated_handling_limit?.date
    || null;
  if (conPlazo && ESTADOS_CON_PLAZO.includes(estadoMl)) {
    try {
      const { data: sla } = await axios.get(`${ML_API}/shipments/${envioId}/sla`, { headers: cabeceras });
      if (sla?.expected_date) limite = sla.expected_date;
    } catch {
      // Sin SLA se usa el respaldo: que falte el plazo no invalida el envío.
    }
  }

  return {
    envioId: String(data.id),
    envioTipo: tipoDeEnvio(data),
    // Las notificaciones y las fechas de ML vienen en UTC; se guarda como Date
    // y cada pantalla la muestra en la hora de acá.
    despacharAntesDe: limite ? new Date(limite) : null,
    estadoMl,
    subestadoMl: data.substatus || null,
    // Ya no viene en el formato nuevo. Se conserva por si llega del viejo, pero
    // nada depende de él: el pedido se busca por el número de envío.
    ordenExterna: data.order_id ? String(data.order_id) : null,
  };
}

/*
 * Qué órdenes viajan en un envío.
 *
 * Es el reemplazo documentado del `order_id` que /shipments dejó de devolver, y
 * pide su propio header. Hace falta cuando llega el aviso de un envío cuya
 * orden todavía no está en Stocker —porque su aviso se perdió, o porque llegó
 * después—: con esto se va a buscar la orden en vez de descartar el envío.
 */
async function ordenesDelEnvio(cuenta, envioId) {
  const token = await ml.tokenValido(cuenta);
  const { data } = await axios.get(`${ML_API}/shipments/${envioId}/orders`, {
    headers: { Authorization: `Bearer ${token}`, 'X-New-Domain': 'true' },
  });
  const lista = Array.isArray(data) ? data : (data?.orders || []);
  return [...new Set(lista.map((o) => String(o.order_id || o.id || '')).filter(Boolean))];
}

/**
 * Una notificación de Mercado Libre.
 *
 * Devuelve qué se hizo, para poder registrarlo sin tener que adivinar mirando
 * la base después.
 */
async function procesarNotificacion({ topic, resource, userId }) {
  const tema = String(topic || '');

  /*
   * Los de posventa —mensajes y reclamos— los atiende otro archivo.
   *
   * Se derivan acá y no en el controlador para que siga habiendo UNA sola
   * puerta de entrada de notificaciones de ML: el controlador no tiene por qué
   * saber qué tópico maneja quién, y la próxima que se agregue se engancha en
   * un solo lugar.
   */
  const postventa = require('./mercadolibrePostventaService');
  if (postventa.TOPICOS_POSTVENTA.includes(tema)) {
    return postventa.procesarNotificacion({ topic: tema, resource, userId });
  }

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
      ignorado: `tópico que no usamos. En el panel de la aplicación de Mercado Libre `
        + `hay que tildar "orders_v2" y "shipments" para los pedidos, y "messages" y `
        + `"claims" para los mensajes y reclamos de los compradores`,
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
  if (tema === 'flex-handshakes') return manejarFlexHandshake(cuenta, id);
  return ingresarOrden(cuenta, id);
}

/** La venta: entra a la cola, que es la que aparta el stock. */
async function ingresarOrden(cuenta, ordenId) {
  const {
    payload, envioId, cancelada, motivoCancelacion, ordenCruda,
  } = await traerOrden(cuenta, ordenId);

  if (cancelada) {
    const r = await registrarCancelacion(cuenta, ordenCruda);
    log.info('ml-pedidos', 'orden cancelada en Mercado Libre', {
      negocio: cuenta.businessId, accion: r.accion, liberadas: r.liberadas || 0,
    });
    return {
      accion: r.accion === 'cancelado' ? 'cancelada' : 'ignorada',
      motivo: motivoCancelacion,
      pedidoId: r.pedidoId || null,
    };
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
      await autoDespacharSiCorresponde(pedido, envio, cuenta);
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

/*
 * Una orden cancelada, en Stocker.
 *
 * Si la venta ya estaba, se cancela y se devuelve lo que tenía apartado. Si
 * nunca había entrado —se canceló antes de que llegara su aviso—, se registra
 * igual, ya cancelada y sin apartar nada: es lo que Mercado Libre muestra como
 * "Canceladas. No despachar", y el depósito tiene que verlo para no armar un
 * paquete que quizá ya tenía impreso.
 */
async function registrarCancelacion(cuenta, orden) {
  const payload = payloadDeOrden(cuenta, orden);
  const motivo = motivoDeCancelacion(orden);

  let pedido = await PedidoPlataforma.findOne({
    where: { businessId: cuenta.businessId, plataforma: 'mercadolibre', pedidoExterno: payload.pedidoExterno },
  });

  if (!pedido) {
    if (!payload.items.length) return { accion: 'ignorada' };
    // `encolar` la deja pendiente, sin apartar; la cancelación de abajo la
    // cierra. Si justo en el medio la cola llegara a procesarla, la
    // cancelación devuelve lo apartado: está trabada y es idempotente.
    ({ pedido } = await cola.encolar(payload));

    const envioId = orden.shipping?.id ? String(orden.shipping.id) : null;
    if (envioId) {
      try {
        const envio = await traerEnvio(cuenta, envioId, { conPlazo: false });
        await pedido.update({
          envioId: envio.envioId, envioTipo: envio.envioTipo,
          despacharAntesDe: envio.despacharAntesDe, estadoEnvioMl: envio.estadoMl,
        });
      } catch {
        // Sin el envío se registra igual: el número de venta alcanza para saber
        // qué no despachar.
      }
    }
  }

  return cola.cancelarPorPlataforma(pedido.id, motivo);
}

/*
 * Aplica lo que dice un envío a los pedidos que viajan en él.
 *
 * Varios pedidos, no uno: en un carrito de ML varias órdenes comparten el mismo
 * envío. Antes se buscaba UNA orden y el resto nunca se enteraba de que el
 * paquete había salido o se había cancelado.
 */
async function aplicarEnvio(cuenta, pedidos, envio) {
  const r = { actualizados: 0, cancelados: 0, despachados: 0 };
  for (const pedido of pedidos) {
    const plazoNuevo = envio.despacharAntesDe ? envio.despacharAntesDe.getTime() : null;
    const plazoViejo = pedido.despacharAntesDe ? new Date(pedido.despacharAntesDe).getTime() : null;
    const cambia = pedido.estadoEnvioMl !== envio.estadoMl
      || pedido.envioId !== envio.envioId
      || pedido.envioTipo !== envio.envioTipo
      || (plazoNuevo !== null && plazoNuevo !== plazoViejo);
    if (cambia) {
      await pedido.update({
        envioId: envio.envioId,
        envioTipo: envio.envioTipo,
        // Un plazo conocido no se pisa con uno vacío: que el SLA no conteste
        // una vez no tiene que borrar el que ya se sabía.
        despacharAntesDe: envio.despacharAntesDe || pedido.despacharAntesDe,
        estadoEnvioMl: envio.estadoMl,
      });
      r.actualizados += 1;
    }

    if (envio.estadoMl === 'cancelled') {
      if (pedido.estado !== 'cancelado') {
        const c = await cola.cancelarPorPlataforma(pedido.id, 'Envío cancelado en Mercado Libre');
        if (c.accion === 'cancelado') r.cancelados += 1;
      }
      continue;
    }
    if (pedido.estado === 'cancelado') continue;

    const d = await autoDespacharSiCorresponde(pedido, envio, cuenta);
    if (d?.despachado) r.despachados += 1;
  }
  return r;
}

/** El envío: completa cómo y cuándo se despacha lo que ya entró. */
async function actualizarEnvio(cuenta, envioId) {
  const envio = await traerEnvio(cuenta, envioId);
  const donde = { businessId: cuenta.businessId, plataforma: 'mercadolibre' };

  /*
   * Por número de ENVÍO, que es lo que guardamos al entrar la venta. Buscar
   * por `order_id` —como antes— dejó de funcionar cuando ML lo sacó de
   * /shipments.
   */
  let pedidos = await PedidoPlataforma.findAll({ where: { ...donde, envioId: envio.envioId } });
  if (!pedidos.length && envio.ordenExterna) {
    pedidos = await PedidoPlataforma.findAll({ where: { ...donde, pedidoExterno: envio.ordenExterna } });
  }

  /*
   * Ningún pedido tiene este envío: la venta no entró todavía, o su aviso se
   * perdió. En vez de descartarlo, se le pregunta a ML qué órdenes viajan acá
   * y se hacen entrar. Perder el aviso de la venta ya no significa perder la
   * venta.
   */
  if (!pedidos.length) {
    const ordenes = await ordenesDelEnvio(cuenta, envio.envioId).catch(() => []);
    for (const o of ordenes) {
      try { await ingresarOrden(cuenta, o); } catch (e) {
        log.warn('ml-pedidos', 'no se pudo traer una orden del envío', {
          negocio: cuenta.businessId, motivo: String(e.message).slice(0, 160),
        });
      }
    }
    if (ordenes.length) {
      pedidos = await PedidoPlataforma.findAll({ where: { ...donde, pedidoExterno: ordenes } });
    }
  }

  if (!pedidos.length) {
    return { accion: 'ignorada', motivo: 'ningún pedido de Stocker viaja en ese envío' };
  }

  const r = await aplicarEnvio(cuenta, pedidos, envio);
  log.info('ml-pedidos', 'envío actualizado', {
    negocio: cuenta.businessId, tipo: envio.envioTipo, estado: envio.estadoMl, pedidos: pedidos.length, ...r,
  });
  return { accion: 'envio_actualizado', tipo: envio.envioTipo, pedidoId: pedidos[0].id, pedidos: pedidos.length, ...r };
}

/*
 * ── El despacho solo, sin que nadie toque el botón ────────────────
 *
 * El depósito despacha del lado de Mercado Libre —imprime la etiqueta ahí, le
 * entrega el paquete al cadete— y no vuelve a Stocker a tocar "Despachar". El
 * resultado, antes de esto: el stock de esos envíos quedaba apartado para
 * siempre, porque el único lugar que lo descuenta es ese botón.
 *
 * Así que Stocker lo aprieta solo, apenas se entera por la propia Mercado
 * Libre de que el paquete salió de verdad:
 *
 *   · `shipped`, en cualquier tipo de envío. En Flex llega con el primer
 *     escaneo del cadete; en colecta y cross-docking, cuando el transportista
 *     lo recibe. Imprimir la etiqueta no lo produce: eso es `ready_to_ship`
 *     con subestado `printed`, y el paquete sigue en Envíos del Día.
 *   · El handshake de Flex (`flex-handshakes`): el mismo escaneo, por otro
 *     tópico. Si el aviso de `shipments` se pierde, éste alcanza.
 *   · `delivered`: si el comprador ya lo tiene, salió hace rato. Es la red de
 *     seguridad para cuando ninguno de los otros dos avisos llegó.
 *
 * La importación manual de ventas anteriores NO lo usa: ese backfill puede
 * traer de una decenas de pedidos de hasta dos meses, y descontar stock de
 * mercadería que quizá ya se ajustó a mano es un movimiento grande para
 * hacerlo sin que nadie lo vea venir. Esos entran marcados como "ML ya lo
 * despachó" y se confirman a mano. La reconciliación periódica sí lo usa:
 * mira sólo lo de los últimos días, y ahí dejar la reserva colgada es
 * justamente el error que tiene que corregir.
 */
async function autoDespacharSiCorresponde(pedido, envio, cuenta, origen = null) {
  if (!pedido?.envioId || pedido.estadoEnvio === 'despachado' || pedido.estado === 'cancelado') {
    return { despachado: false };
  }

  /*
   * ¿Salió de verdad? `shipped` o `delivered` — en Flex igual que en el resto.
   *
   * Antes Flex ignoraba `shipped` y esperaba el handshake del cadete o la
   * entrega, por una premisa equivocada: que en Flex ML marca `shipped` al
   * imprimir la etiqueta. La documentación dice otra cosa: imprimir deja el
   * envío en `ready_to_ship` con el subestado `printed`, y `shipped` llega con
   * el primer escaneo en la app de Flex. Con la premisa equivocada, un Flex que
   * ya había salido se quedaba en "Para enviar" hasta que el comprador lo
   * recibía — y si el aviso del handshake se perdía, para siempre.
   *
   * Lo que sigue en `ready_to_ship`, impreso o no, no se toca: está en el
   * estante o en la mesa de armado, y es justo lo que Envíos del Día tiene que
   * seguir mostrando.
   */
  const salioDeVerdad = origen === 'flex-handshake'
    || ['shipped', 'delivered'].includes(envio?.estadoMl);
  if (!salioDeVerdad) return { despachado: false };

  try {
    const r = await enviosDelDia.despachar({
      pedidoId: pedido.id, businessId: cuenta.businessId, employeeId: null,
    });
    if (!r.repetido) {
      log.info('ml-pedidos', 'despacho automático: Mercado Libre confirmó la salida', {
        negocio: cuenta.businessId, pedido: pedido.id, origen: origen || envio?.estadoMl,
        unidades: r.movidas, ventas: r.ventas,
      });
    }
    return { despachado: !r.repetido };
  } catch (e) {
    /*
     * No descontó, y hay que poder verlo: el paquete sigue en "Para enviar"
     * con el motivo que ya explica por qué (SKU sin apartar, reserva
     * perdida), así que no hace falta más que dejarlo en el log — no hay
     * notificación de ML que reintentar, porque la falla es nuestra, no de
     * la conexión.
     */
    log.warn('ml-pedidos', 'no se pudo despachar solo tras la confirmación de Mercado Libre', {
      negocio: cuenta.businessId, pedido: pedido.id, motivo: e.message, codigo: e.codigo || null,
    });
    return { despachado: false };
  }
}

/**
 * El handshake de Flex: el cadete escaneó el paquete al levantarlo.
 *
 * El recurso de la notificación es `/flex/sites/{site}/shipments/{id}/assignment/v1`
 * y no hace falta leerlo: que la notificación exista ya dice que el paquete
 * cambió de manos, que es la única pregunta que importa acá. Pedir ese
 * recurso sería gastar una llamada contra la API para algo que no se usa.
 */
async function manejarFlexHandshake(cuenta, shipmentId) {
  const pedido = await PedidoPlataforma.findOne({
    where: { businessId: cuenta.businessId, plataforma: 'mercadolibre', envioId: String(shipmentId) },
  });
  if (!pedido) {
    return { accion: 'ignorada', motivo: 'no hay ningún pedido con ese envío todavía' };
  }

  await autoDespacharSiCorresponde(pedido, { envioTipo: pedido.envioTipo }, cuenta, 'flex-handshake');
  return { accion: 'handshake_flex_procesado', pedidoId: pedido.id };
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
      if (ordenCancelada(orden)) {
        // Registrada, no salteada: ver `registrarCancelacion`.
        await registrarCancelacion(cuenta, orden);
        resumen.cancelados += 1;
        continue;
      }

      /*
       * El estado del envío decide si vale la pena traerlo.
       *
       * Sólo se saltea lo que TERMINÓ: entregado, cancelado o devuelto. Ahí no
       * hay nada que despachar y apartar stock sería inventar un faltante.
       *
       * `shipped` NO cuenta como terminado: la mercadería salió, pero el stock
       * de Stocker todavía no lo sabe. Entra como cualquier otra venta —aparta—
       * marcada como "ML ya lo despachó", para que alguien confirme el despacho
       * y la reserva se vuelva egreso. Acá no se despacha sola: ver
       * `autoDespacharSiCorresponde`, por qué la importación manual no lo hace.
       * Salteándola, la prenda figuraría en Stocker aunque ya esté en la casa
       * del comprador.
       *
       * (Esto decía antes que en Flex ML pone `shipped` al imprimir la
       * etiqueta. No es así: imprimir deja `ready_to_ship` con el subestado
       * `printed`, y `shipped` llega con el escaneo del cadete.)
       */
      let yaSalio = false;
      let envio = null;
      if (orden.shipping?.id) {
        try {
          envio = await traerEnvio(cuenta, String(orden.shipping.id));
          yaSalio = ['delivered', 'not_delivered', 'cancelled'].includes(envio.estadoMl);
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
async function ingresarOrdenImportada(cuenta, orden, envioYaLeido = null, { autoDespachar = false } = {}) {
  const payload = payloadDeOrden(cuenta, orden);
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
  /*
   * Si ML ya la dio por salida, la reserva recién hecha se vuelve egreso — pero
   * sólo si quien llama lo pide. La reconciliación sí (mira los últimos días);
   * la importación manual no: ver por qué en `autoDespacharSiCorresponde`.
   */
  if (envio && autoDespachar) await autoDespacharSiCorresponde(pedido, envio, cuenta);

  return { repetido, estado: pedido.estado, pedidoId: pedido.id };
}

/**
 * Las etiquetas de despacho, en un PDF.
 *
 * Es lo mismo que el botón "imprimir etiquetas" del panel de Mercado Libre,
 * pero desde acá: quien arma los paquetes ya está en Envíos del Día con la
 * lista en la mano, y mandarlo a otra pestaña a buscar los mismos envíos de a
 * uno es donde se va el tiempo de la jornada.
 *
 * ML devuelve UN solo PDF con todas las etiquetas pedidas, así que imprimir
 * veinte es una llamada y un botón, no veinte de cada cosa.
 *
 * @param {string[]} envioIds  ids de envío de ML. Quien llama ya comprobó que
 *                             son de este negocio: acá no hay forma de saberlo.
 * @returns {Promise<Buffer>}
 */
async function traerEtiquetas(cuenta, envioIds) {
  const ids = [...new Set((envioIds || []).map(String).filter(Boolean))];
  if (!ids.length) {
    const err = new Error('No hay ningún envío para imprimir.');
    err.status = 400;
    throw err;
  }

  const token = await ml.tokenValido(cuenta);
  try {
    const { data } = await axios.get(`${ML_API}/shipment_labels`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { shipment_ids: ids.join(','), response_type: 'pdf' },
      // Sin esto axios interpreta el PDF como texto y lo entrega corrupto: el
      // archivo baja, pesa lo que tiene que pesar y no abre.
      responseType: 'arraybuffer',
      timeout: 30000,
    });
    return Buffer.from(data);
  } catch (e) {
    /*
     * Los tres errores que se dan en la práctica, dichos con lo que hay que
     * hacer. El cuerpo de un error de ML viene como buffer por el
     * `responseType`, así que hay que volverlo texto antes de mirarlo.
     */
    const status = e.response?.status;
    let detalle = '';
    try { detalle = Buffer.from(e.response?.data || '').toString('utf8').slice(0, 300); } catch { /* sin detalle */ }

    if (status === 404) {
      const err = new Error(
        'Mercado Libre no tiene etiqueta para alguno de estos envíos. Suele pasar cuando '
        + 'todavía no está listo para despachar, o cuando el envío no lo maneja el vendedor.',
      );
      err.status = 409;
      throw err;
    }
    if (status === 403 || status === 401) {
      const err = new Error(
        'Mercado Libre rechazó la descarga por permisos. Volvé a autorizar la cuenta '
        + 'desde Integraciones.',
      );
      err.status = 403;
      throw err;
    }
    const err = new Error(`No se pudieron traer las etiquetas de Mercado Libre. ${detalle}`.trim());
    err.status = 502;
    throw err;
  }
}


/*
 * ══ La reconciliación con Mercado Libre ═══════════════════════════
 *
 * Los avisos de ML no son una fuente de la que se pueda depender sola. La
 * documentación lo dice: si no se contesta en 500 ms reintentan una hora y
 * después los descartan, y si ML desactiva un tópico por fallas, lo de ese
 * período se pierde. Con sólo los avisos, un envío cuyo aviso se perdió queda
 * como estaba para siempre — que es exactamente "está en Para enviar y ML ya lo
 * despachó".
 *
 * Esto le pregunta a ML directamente, en dos pasadas:
 *
 *   1. Lo abierto: cada venta que Stocker todavía cree en curso se vuelve a
 *      leer —orden y envío—. Es la única forma segura de enterarse de una
 *      cancelación: la documentación advierte que el buscador, consultado como
 *      vendedor, puede excluir las canceladas.
 *
 *   2. Lo nuevo: el buscador de órdenes, por fecha de última modificación,
 *      para lo que nunca llegó a entrar.
 *
 * Corre cada 15 minutos con el barrido y cada vez que se abre Envíos del Día.
 */
const RECONCILIAR_CADA_MS = 60 * 1000;     // lo normal: abrir la pantalla seguido no martilla a ML
const RECONCILIAR_FORZADO_MS = 10 * 1000;  // el botón: más corto, pero con freno igual
const TOPE_ABIERTOS = 150;
const DIAS_HACIA_ATRAS = 60;
const reconciliando = new Map();

async function reconciliarEnvios(businessId, { forzar = false } = {}) {
  const cuenta = await MercadoLibreAccount.findOne({ where: { businessId } });
  if (!cuenta || !cuenta.refreshToken) return { omitido: true, motivo: 'sin_cuenta' };

  const ultima = cuenta.ultimaSyncEnvios ? new Date(cuenta.ultimaSyncEnvios).getTime() : 0;
  const minimo = forzar ? RECONCILIAR_FORZADO_MS : RECONCILIAR_CADA_MS;
  if (ultima && Date.now() - ultima < minimo) {
    return { omitido: true, motivo: 'reciente', sincronizadoEn: new Date(ultima).toISOString() };
  }

  /*
   * Una por negocio a la vez. El barrido y dos pestañas abiertas pueden pedir
   * la reconciliación juntos; encimadas, le pedirían a ML lo mismo tres veces.
   * El que llega segundo espera el resultado del primero.
   */
  const enCurso = reconciliando.get(businessId);
  if (enCurso) return enCurso;
  const promesa = reconciliar(cuenta).finally(() => reconciliando.delete(businessId));
  reconciliando.set(businessId, promesa);
  return promesa;
}

async function reconciliar(cuenta) {
  // Si el token no sirve, no tiene sentido intentar ciento cincuenta veces:
  // se dice una y con lo que hay que hacer.
  try {
    await ml.tokenValido(cuenta);
  } catch (e) {
    const err = new Error(e.message);
    err.status = 502;
    throw err;
  }

  const cambios = { actualizados: 0, cancelados: 0, despachados: 0, nuevos: 0 };
  let errores = 0;
  const donde = { businessId: cuenta.businessId, plataforma: 'mercadolibre' };
  const desde = new Date(Date.now() - DIAS_HACIA_ATRAS * 86400000);

  // ── 1. Lo abierto ──────────────────────────────────────────────
  const abiertos = await PedidoPlataforma.findAll({
    where: {
      ...donde,
      estado: { [Op.in]: ['pendiente', 'aceptado', 'parcial'] },
      createdAt: { [Op.gte]: desde },
      [Op.or]: [
        { estadoEnvioMl: null },
        { estadoEnvioMl: { [Op.notIn]: ESTADOS_ML_TERMINADOS } },
      ],
    },
    order: [['createdAt', 'DESC']],
    limit: TOPE_ABIERTOS,
  });

  const enviosVistos = new Set();
  for (const pedido of abiertos) {
    try {
      const { envioId, cancelada, motivoCancelacion } = await traerOrden(cuenta, pedido.pedidoExterno);
      if (cancelada) {
        const c = await cola.cancelarPorPlataforma(pedido.id, motivoCancelacion);
        if (c.accion === 'cancelado') cambios.cancelados += 1;
        continue;
      }
      const idEnvio = pedido.envioId || envioId;
      // Un envío se lee una vez aunque viajen varias órdenes en él.
      if (!idEnvio || enviosVistos.has(idEnvio)) continue;
      enviosVistos.add(idEnvio);

      const envio = await traerEnvio(cuenta, idEnvio);
      const delEnvio = await PedidoPlataforma.findAll({ where: { ...donde, envioId: idEnvio } });
      const r = await aplicarEnvio(cuenta, delEnvio.length ? delEnvio : [pedido], envio);
      cambios.actualizados += r.actualizados;
      cambios.cancelados += r.cancelados;
      cambios.despachados += r.despachados;
    } catch (e) {
      errores += 1;
      log.warn('ml-reconciliacion', 'no se pudo revisar un pedido', {
        negocio: cuenta.businessId, pedido: pedido.id, motivo: String(e.message).slice(0, 160),
      });
    }
  }

  // ── 2. Lo nuevo ────────────────────────────────────────────────
  /*
   * Desde la última reconciliación, con dos horas de solape: el buscador
   * redondea a la hora y descarta minutos y segundos, así que sin solape se
   * pierde lo que cambió en el borde. Nunca más de siete días: lo más viejo es
   * trabajo de la importación manual, no de esto.
   */
  const ultima = cuenta.ultimaSyncEnvios ? new Date(cuenta.ultimaSyncEnvios).getTime() : Date.now() - 2 * 86400000;
  const desdeBusqueda = new Date(Math.max(ultima - 2 * 3600000, Date.now() - 7 * 86400000));
  try {
    const token = await ml.tokenValido(cuenta);
    for (let offset = 0; offset < 200; offset += 50) {
      const { data } = await axios.get(`${ML_API}/orders/search`, {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          seller: cuenta.mlUserId,
          'order.date_last_updated.from': desdeBusqueda.toISOString(),
          sort: 'date_desc',
          offset,
          limit: 50,
        },
      });
      const lote = data.results || [];
      for (const orden of lote) {
        try {
          const existe = await PedidoPlataforma.findOne({
            where: { ...donde, pedidoExterno: String(orden.id) }, attributes: ['id', 'estado'],
          });
          if (ordenCancelada(orden)) {
            if (existe?.estado === 'cancelado') continue;
            const c = await registrarCancelacion(cuenta, orden);
            if (c.accion === 'cancelado') {
              cambios.cancelados += 1;
              if (!existe) cambios.nuevos += 1;
            }
            continue;
          }
          // Lo que ya está se revisó arriba, con su orden y su envío.
          if (existe) continue;

          const envio = orden.shipping?.id
            ? await traerEnvio(cuenta, String(orden.shipping.id)).catch(() => null)
            : null;
          // Terminado antes de que Stocker lo viera: apartar ahora sería
          // inventar un faltante. Es el mismo criterio de la importación.
          if (envio && ESTADOS_ML_TERMINADOS.includes(envio.estadoMl)) continue;

          const r = await ingresarOrdenImportada(cuenta, orden, envio, { autoDespachar: true });
          if (!r.repetido && r.estado !== 'ignorada') cambios.nuevos += 1;
        } catch (e) {
          errores += 1;
          log.warn('ml-reconciliacion', 'no se pudo traer una orden nueva', {
            negocio: cuenta.businessId, motivo: String(e.message).slice(0, 160),
          });
        }
      }
      if (lote.length < 50) break;
    }
  } catch (e) {
    errores += 1;
    log.warn('ml-reconciliacion', 'el buscador de órdenes falló', {
      negocio: cuenta.businessId, motivo: String(e.message).slice(0, 160),
    });
  }

  const sincronizadoEn = new Date();
  await cuenta.update({ ultimaSyncEnvios: sincronizadoEn });

  if (Object.values(cambios).some(Boolean) || errores) {
    log.info('ml-reconciliacion', 'envíos reconciliados con Mercado Libre', {
      negocio: cuenta.businessId, revisados: abiertos.length, ...cambios, errores,
    });
  }
  return { omitido: false, sincronizadoEn: sincronizadoEn.toISOString(), cambios, errores };
}

module.exports = {
  procesarNotificacion, traerOrden, traerEnvio, importarPedidos, traerEtiquetas,
  __skuDeLinea: skuDeLinea, __tipoDeEnvio: tipoDeEnvio, __idDeRecurso: idDeRecurso, TOPICOS,
  reconciliarEnvios, registrarCancelacion, aplicarEnvio, ordenCancelada, ordenesDelEnvio,
};
