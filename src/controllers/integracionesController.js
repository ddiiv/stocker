/*
 * Lo que un sistema de afuera puede hacer, y lo que el dueño hace con él.
 *
 * Son dos públicos distintos en un mismo archivo: `recibirPedido` la llama
 * ISUWAYA con su credencial de máquina; el resto lo usa el dueño desde la
 * pantalla de integraciones, con su sesión.
 */

const integraciones = require('../services/integracionesService');
const solicitudes = require('../services/solicitudMayoristaService');
const { abrirSobre } = require('../utils/sobreMovimiento');

/*
 * POST /api/integraciones/:origen/pedidos
 *
 * El negocio sale de la credencial y nunca del cuerpo. El código de respuesta
 * distingue el alta del reenvío: 201 es "lo tomé por primera vez", 200 es "ya
 * lo tenía". El origen reintenta sobre cualquier cosa que no sea 2xx, así que
 * un pedido repetido tiene que contestar 200 y no un error.
 */
const recibirPedido = async (req, res, next) => {
  try {
    const { businessId, origen } = req.integracion;
    const r = await solicitudes.recibir({
      businessId, origen, cuerpo: abrirSobre(req.body, 'venta'),
    });

    res.status(r.creada ? 201 : 200).json({
      ok: true,
      id: r.solicitud.id,
      pedidoExterno: r.solicitud.pedidoExterno,
      estado: r.solicitud.estado,
      creada: r.creada,
      repetido: r.repetido,
      // Una entrega vieja que llegó tarde: se descartó a propósito.
      ignorado: r.ignorado,
      /*
       * El pedido cambió después de que acá se revisó. El origen no puede
       * arreglarlo solo, pero tiene que poder mostrarlo en su panel en vez de
       * creer que el cambio se aplicó.
       */
      cambioTardio: r.cambioTardio,
    });
  } catch (e) { next(e); }
};

/*
 * GET /api/integraciones/:origen/pedidos/resoluciones?desde=&limite=
 *
 * Lo que pasó con los pedidos que mandó: aceptados —con el número de venta— y
 * rechazados con su motivo. El que pregunta manda hasta dónde ya leyó y se
 * lleva el cursor para la próxima vuelta.
 *
 * Pregunta el origen en vez de avisar Stocker porque el origen ya tiene un
 * reloj y reintentos escritos, y porque si se cae no se pierde nada: cuando
 * vuelve, pregunta desde donde quedó.
 */
const resolucionesDePedidos = async (req, res, next) => {
  try {
    const { businessId, origen } = req.integracion;
    res.json(await solicitudes.resoluciones({
      businessId, origen, desde: req.query.desde || null, limite: req.query.limite,
    }));
  } catch (e) { next(e); }
};

/*
 * GET /api/integraciones/:origen/precios?desde=
 *
 * El precio mayorista de cada SKU. Existe para que haya UNA lista: el catálogo
 * del portal salió de una exportación y desde ese día los precios viven por
 * separado, así que el cliente arma el pedido con un número y la venta se
 * registra con otro.
 */
const preciosPorSku = async (req, res, next) => {
  try {
    const precios = require('../services/preciosIntegracionService');
    res.json(await precios.precios({
      businessId: req.integracion.businessId,
      desde: req.query.desde || null,
    }));
  } catch (e) { next(e); }
};

/*
 * ══ La tienda minorista ══════════════════════════════════════════
 *
 * Pregunta catálogo y stock; no los calcula. Las dos rutas devuelven la MISMA
 * cantidad publicable que se les manda a Mercado Libre y a Jumpseller: el que
 * decide qué se publica es uno solo.
 */

/* GET /api/integraciones/tienda/catalogo */
const catalogoTienda = async (req, res, next) => {
  try {
    const tienda = require('../services/tiendaService');
    res.json(await tienda.catalogo({ businessId: req.integracion.businessId }));
  } catch (e) { next(e); }
};

/*
 * GET /api/integraciones/tienda/stock?skus=A,B,C
 *
 * La consulta del carrito y del checkout: se pregunta por lo que el cliente
 * tiene en la mano, no por el catálogo entero.
 */
const stockTienda = async (req, res, next) => {
  try {
    const tienda = require('../services/tiendaService');
    const crudo = req.query.skus;
    const skus = Array.isArray(crudo) ? crudo : String(crudo || '').split(',');
    res.json(await tienda.stockDeSkus({ businessId: req.integracion.businessId, skus }));
  } catch (e) { next(e); }
};

/*
 * POST /api/integraciones/tienda/pedidos
 *
 * Entra por la misma cola que la venta online de las otras plataformas: aparta
 * en orden de llegada y es idempotente por el número de pedido de la tienda.
 * Dos canales no pueden llevarse la misma última unidad.
 */
const pedidoDeTienda = async (req, res, next) => {
  try {
    const cola = require('../services/colaVentasOnlineService');
    const datos = abrirSobre(req.body, 'venta');
    const r = await cola.encolarYProcesar({
      businessId: req.integracion.businessId,
      plataforma: 'tienda',
      pedidoExterno: datos.pedidoExterno,
      items: datos.items,
      comprador: datos.comprador,
      total: datos.total ?? null,
      // Con qué sale y hasta cuándo hay para despacharlo: es lo que arma la
      // jornada del depósito. Sin esto el paquete entra sin reloj.
      envio: datos.envio ?? null,
      /*
       * El pago. La tienda aparta antes de cobrar, así que un pedido puede
       * entrar debiendo plata y el depósito no tiene que despacharlo hasta que
       * esté cobrado. Si el mensaje no dice nada, la cola lo toma como
       * pendiente: falla cerrado.
       */
      pagoPendiente: datos.pagoPendiente ?? null,
      pagoDetalle: datos.pagoDetalle ?? null,
      pagoVenceEn: datos.pagoVenceEn ?? null,
    });
    /*
     * El código lo decide el ESTADO primero, y recién después si es un reenvío.
     *
     * 201 lo tomé ahora · 200 ya lo tenía y está resuelto · 409 no hay stock ·
     * 202 lo tengo pero todavía no lo resolví.
     *
     * El orden importa por dos casos que antes contestaban mal. Un reenvío que
     * ahora se rechaza por falta de stock daba 200, y la tienda se quedaba
     * creyendo que estaba apartado. Y un pedido que quedó 'pendiente' —el
     * primer intento commiteó la fila y se murió antes de apartar— también daba
     * 200: la plataforma lo sacaba de su cola y el pedido quedaba sin una sola
     * unidad reservada. El 202 dice las dos cosas que hacen falta: lo tengo
     * guardado, no lo resuelvas de nuevo, y todavía no hay nada apartado.
     */
    const estado = r.pedido?.estado;
    const codigo = estado === 'rechazado' ? 409
      : estado === 'pendiente' ? 202
      : r.repetido ? 200 : 201;
    res.status(codigo).json({
      pedidoExterno: r.pedido?.pedidoExterno,
      estado,
      motivo: r.pedido?.motivo || null,
      repetido: Boolean(r.repetido),
    });
  } catch (e) { next(e); }
};

/* POST /api/integraciones/tienda/pedidos/:pedidoExterno/cancelar — libera la reserva. */
const cancelarPedidoDeTienda = async (req, res, next) => {
  try {
    const cola = require('../services/colaVentasOnlineService');
    const { PedidoPlataforma } = require('../models');
    /*
     * La tienda cancela por SU número de pedido: el id interno de la cola no
     * lo conoce ni tiene por qué. Se busca acá, acotado al negocio de la
     * credencial, que es lo que impide cancelar el pedido de otro.
     */
    const pedido = await PedidoPlataforma.findOne({
      where: {
        businessId: req.integracion.businessId,
        plataforma: 'tienda',
        pedidoExterno: String(req.params.pedidoExterno || '').trim(),
      },
    });
    if (!pedido) return res.status(404).json({ message: 'Ese pedido no está en la cola.' });
    const datos = abrirSobre(req.body, 'cancelacion');
    res.json(await cola.cancelarPorPlataforma(pedido.id, datos.motivo || 'Cancelado en la tienda'));
  } catch (e) { next(e); }
};

/*
 * GET /api/integraciones/tienda/pedidos/resoluciones?desde=&limite=
 *
 * Qué pasó con los pedidos DESPUÉS de la respuesta del POST: que el depósito
 * despachó y con qué seguimiento, que no encontró la prenda, que se canceló. Es
 * con lo que la tienda le manda el mail al comprador.
 *
 * Sin `desde` no devuelve historia: una tienda que pregunta por primera vez no
 * tiene que enterarse de seis meses de cambios y mandar un mail por cada uno. Se
 * lleva el cursor y desde la próxima vuelta ve lo nuevo.
 */
const resolucionesDeTienda = async (req, res, next) => {
  try {
    const tienda = require('../services/tiendaService');
    res.json(await tienda.resoluciones({
      businessId: req.integracion.businessId,
      plataforma: 'tienda',
      desde: req.query.desde || null,
      limite: req.query.limite,
    }));
  } catch (e) { next(e); }
};

/*
 * POST /api/integraciones/tienda/pedidos/:pedidoExterno/envio
 *
 * El número de la etiqueta, y de paso el tipo y el corte si recién ahora se
 * saben. Es ruta propia y no parte del cobro por dos razones: un pedido con pago
 * al retirar nunca manda un cobro y entonces nunca podría mandar su etiqueta, y
 * el cobro está documentado como una sola vez por pedido mientras la etiqueta se
 * puede corregir.
 *
 * Escribir el mismo valor dos veces no hace nada: la tienda puede reintentar.
 */
const envioDeTienda = async (req, res, next) => {
  try {
    const { PedidoPlataforma } = require('../models');
    const { abrirSobre } = require('../utils/sobreMovimiento');
    const datos = abrirSobre(req.body, 'envio');
    const pedido = await PedidoPlataforma.findOne({
      where: {
        businessId: req.integracion.businessId,
        plataforma: 'tienda',
        pedidoExterno: String(req.params.pedidoExterno || '').trim(),
      },
    });
    if (!pedido) return res.status(404).json({ message: 'Ese pedido no está en la cola.' });

    const recortar = (v, largo) => (v == null ? null : String(v).slice(0, largo));
    const cambios = {};
    if (datos.seguimiento != null) cambios.seguimiento = recortar(datos.seguimiento, 60);
    if (datos.tipo != null) cambios.envioTipo = recortar(datos.tipo, 30);
    if (datos.despacharAntesDe != null) {
      const d = new Date(datos.despacharAntesDe);
      if (!Number.isNaN(d.getTime())) cambios.despacharAntesDe = d;
    }
    if (!Object.keys(cambios).length) {
      return res.status(400).json({ message: 'No vino nada que guardar: mandá seguimiento, tipo o despacharAntesDe.' });
    }
    /*
     * La novedad va en el mismo update: así la tienda puede enterarse por el feed
     * de que la etiqueta quedó cargada, sin tener que acordarse de que la mandó.
     */
    await pedido.update({ ...cambios, novedadEn: new Date() });

    res.json({
      pedidoExterno: pedido.pedidoExterno,
      seguimiento: pedido.seguimiento || null,
      envioTipo: pedido.envioTipo || null,
      despacharAntesDe: pedido.despacharAntesDe || null,
    });
  } catch (e) { next(e); }
};

/*
 * POST /api/integraciones/tienda/cobros
 *
 * { contrato: 1, tipo: "cobro", id: "isu:ISU-1042-C1",
 *   datos: { ventaId: "isu:ISU-1042", importe: 36000, medio: "mercadopago",
 *            operacion: "1234567890" } }
 *
 * ── El id de acá NO es el del pedido, y es fácil equivocarse ─────
 *
 * `abrirSobre` rellena `pedidoExterno` con el `id` del sobre sin prefijo, que
 * para un cobro es el id DEL COBRO ("ISU-1042-C1") y no el del pedido. Buscar el
 * pedido con eso daría 404 siempre, y el cobro no se registraría nunca. Por eso
 * acá el pedido sale de `datos.ventaId` —al que hay que sacarle el prefijo a
 * mano, porque abrirSobre no lo toca— y el movimiento sale del `id` del sobre.
 */
const cobroDeTienda = async (req, res, next) => {
  try {
    const cola = require('../services/colaVentasOnlineService');
    const { abrirSobre, sinPrefijo } = require('../utils/sobreMovimiento');
    const datos = abrirSobre(req.body, 'cobro');

    const r = await cola.registrarCobro({
      businessId: req.integracion.businessId,
      plataforma: 'tienda',
      // El id del movimiento, del sobre. Sin sobre, de `movimientoExterno`.
      movimientoExterno: sinPrefijo(req.body?.id ?? datos.movimientoExterno),
      // Y el pedido, del ventaId, con su prefijo quitado.
      pedidoExterno: sinPrefijo(datos.ventaId),
      importe: datos.importe,
      medio: datos.medio,
      operacion: datos.operacion ?? null,
      ocurrioEn: req.body?.ocurrioEn ?? null,
    });

    /*
     * 201 lo tomé ahora, 200 ya lo tenía. Nunca un 4xx cuando el cobro se
     * entendió: la tienda reintenta sobre todo lo que no sea 2xx, así que un 409
     * permanente sería plata que Stocker se niega a recordar para siempre. Si el
     * pedido estaba cancelado, la respuesta lo dice en `aplicado` y `motivo`.
     */
    res.status(r.repetido ? 200 : 201).json({
      movimientoExterno: r.cobro.movimientoExterno,
      pedidoExterno: r.pedido?.pedidoExterno ?? null,
      aplicado: Boolean(r.cobro.aplicado),
      // Lo que hay que mirar cuando `aplicado` viene en false.
      motivo: r.cobro.motivo || null,
      pagoEstado: r.pedido?.pagoEstado ?? null,
      cobrado: r.pedido?.cobrado ?? null,
      repetido: Boolean(r.repetido),
    });
  } catch (e) { next(e); }
};
/** GET /api/integraciones — las credenciales del negocio, sin los tokens. */
const listar = async (req, res, next) => {
  try {
    res.json({ integraciones: await integraciones.listar(req.auth.businessId) });
  } catch (e) { next(e); }
};

/*
 * POST /api/integraciones — emite una credencial nueva.
 *
 * El token viaja UNA sola vez, en esta respuesta. No se puede volver a ver: si
 * se pierde, se emite otra y la anterior deja de servir.
 */
const emitir = async (req, res, next) => {
  try {
    const { token, integracion } = await integraciones.emitir({
      businessId: req.auth.businessId,
      origen: req.body?.origen,
      nombre: req.body?.nombre || null,
    });
    res.status(201).json({
      token,
      aviso: 'Guardalo ahora: no se vuelve a mostrar.',
      integracion: {
        id: integracion.id, origen: integracion.origen, nombre: integracion.nombre,
        pista: integracion.pista, activa: integracion.activa,
      },
    });
  } catch (e) { next(e); }
};

/** DELETE /api/integraciones/:id — corta el puente. */
const revocar = async (req, res, next) => {
  try {
    res.json(await integraciones.revocar({
      businessId: req.auth.businessId,
      id: Number(req.params.id),
    }));
  } catch (e) { next(e); }
};

module.exports = {
  recibirPedido, resolucionesDePedidos, preciosPorSku, listar, emitir, revocar,
  catalogoTienda, stockTienda, pedidoDeTienda, cancelarPedidoDeTienda,
  resolucionesDeTienda, envioDeTienda, cobroDeTienda,
};
