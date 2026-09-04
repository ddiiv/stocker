/*
 * La lista de espera de venta online, por HTTP.
 *
 * Dos entradas distintas a propósito:
 *
 *   POST /api/online/pedidos   → encola Y procesa, y responde si se pudo
 *     descontar o no. Es lo que necesita quien integra y espera un sí o un no.
 *
 *   GET  /api/online/pedidos   → la lista, para mirarla. Lo que se rechazó es
 *     lo que más importa ahí: significa que una plataforma vendió algo que no
 *     teníamos.
 */

const cola = require('../services/colaVentasOnlineService');
const { PedidoPlataforma, PedidoPlataformaItem } = require('../models');

/*
 * El estado del pedido decide el código HTTP.
 *
 * Un rechazo por falta de stock es 409 y no 200: quien integra tiene que poder
 * distinguirlo sin leer el cuerpo, porque de eso depende que cancele la venta
 * en su plataforma antes de que salga el despacho.
 */
const CODIGO = { aceptado: 201, parcial: 200, rechazado: 409, pendiente: 202 };

const MENSAJE = {
  aceptado:  'Pedido aceptado: el stock quedó descontado.',
  parcial:   'Pedido aceptado en parte.',
  rechazado: 'No hay stock para despachar este pedido.',
  pendiente: 'Pedido encolado.',
};

const postPedido = async (req, res, next) => {
  try {
    const { pedido, repetido } = await cola.encolarYProcesar({
      businessId: req.auth.businessId,
      plataforma: req.body?.plataforma,
      pedidoExterno: req.body?.pedidoExterno,
      items: req.body?.items,
      comprador: req.body?.comprador || {},
      total: req.body?.total,
    });

    const estado = pedido.estado;
    res.status(CODIGO[estado] || 200).json({
      id: pedido.id,
      plataforma: pedido.plataforma,
      pedidoExterno: pedido.pedidoExterno,
      estado,
      /*
       * `repetido` no es un detalle: le dice a quien reintenta que este pedido
       * ya se había tomado, así que un 409 repetido no significa que el stock
       * se haya movido de nuevo.
       */
      repetido,
      motivo: pedido.motivo || null,
      mensaje: MENSAJE[estado] || null,
    });
  } catch (error) { next(error); }
};

const getPedidos = async (req, res, next) => {
  try {
    const where = { businessId: req.auth.businessId };
    if (req.query.estado) where.estado = String(req.query.estado);
    if (req.query.plataforma) where.plataforma = String(req.query.plataforma).toLowerCase();

    const pedidos = await PedidoPlataforma.findAll({
      where,
      include: [{ model: PedidoPlataformaItem, as: 'items' }],
      order: [['recibidoEn', 'DESC']],
      limit: Math.min(Number(req.query.limit) || 100, 200),
    });
    res.json(pedidos);
  } catch (error) { next(error); }
};

/*
 * Procesa lo que haya quedado pendiente.
 *
 * Existe porque un webhook puede haber encolado sin procesar —para responderle
 * rápido a la plataforma— y porque si algo falló a mitad de camino, la cola
 * tiene que poder retomarse sin esperar al pedido siguiente.
 */
const postProcesar = async (req, res, next) => {
  try {
    const r = await cola.procesarCola(req.auth.businessId, { tope: 50 });
    res.json({
      ...r,
      mensaje: r.procesados
        ? `${r.procesados} pedido(s) procesado(s): ${r.aceptados} aceptado(s), `
          + `${r.parciales} parcial(es), ${r.rechazados} rechazado(s).`
        : 'No había pedidos esperando.',
    });
  } catch (error) { next(error); }
};

/*
 * POST /api/online/pedidos/:id/reprocesar
 *
 * Vuelve a intentar las líneas que quedaron sin resolver porque su SKU no
 * existía cuando el pedido entró —el caso típico es un pack armado después—.
 *
 * El negocio sale de la sesión y se comprueba contra el pedido: sin eso,
 * cualquiera con una cuenta podría reprocesar —y apartar mercadería de— los
 * pedidos de otro negocio mandando un id cualquiera.
 */
const postReprocesar = async (req, res, next) => {
  try {
    const pedido = await PedidoPlataforma.findOne({
      where: { id: Number(req.params.id), businessId: req.auth.businessId },
      attributes: ['id', 'estado'],
    });
    if (!pedido) return res.status(404).json({ message: 'Ese pedido no existe en este negocio.' });

    const antes = pedido.estado;
    const r = await cola.reprocesar(pedido.id);
    const items = await PedidoPlataformaItem.findAll({
      where: { pedidoId: pedido.id }, attributes: ['productVariantId'],
    });
    const sinResolver = items.filter((i) => !i.productVariantId).length;

    return res.json({
      ok: true,
      estado: r?.estado || antes,
      sinResolver,
      mensaje: sinResolver === 0
        ? 'Listo: se apartó la mercadería de todas las líneas. Ya se puede despachar.'
        : `Quedan ${sinResolver} línea(s) sin resolver: ${r?.motivo || 'ese SKU no está en Stocker.'}`,
    });
  } catch (error) { return next(error); }
};

module.exports = { postPedido, getPedidos, postProcesar, postReprocesar };
