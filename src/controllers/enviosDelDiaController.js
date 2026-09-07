/*
 * Envíos del Día, por HTTP.
 *
 *   GET  /api/envios/del-dia       → la jornada: paquetes + consolidado de picking
 *   GET  /api/envios/del-dia/pdf   → la misma jornada en A4, para llevar al depósito
 *   POST /api/envios/:id/despachar → el paquete salió: la reserva se hace egreso
 *   POST /api/envios/:id/faltante  → no se encontró la mercadería
 *
 * El negocio SIEMPRE sale de la sesión, nunca del pedido: si viniera de afuera,
 * cualquiera con una cuenta podría leer los envíos —y los datos del comprador—
 * de otro negocio.
 */

const { Op } = require('sequelize');
const envios = require('../services/enviosDelDiaService');
const { generarPickingPdf } = require('../services/pickingPdfService');
const mlPedidos = require('../services/mercadolibrePedidosService');
const {
  Business, BusinessLocation, MercadoLibreAccount, PedidoPlataforma,
} = require('../models');

const getDelDia = async (req, res, next) => {
  try {
    const jornada = await envios.delDia(req.auth.businessId, {
      fecha: req.query.fecha || null,
      locationId: req.query.locationId ? Number(req.query.locationId) : null,
      envioTipo: req.query.envioTipo || null,
      incluirDespachados: req.query.incluirDespachados === '1',
      // Cuántos días hacia adelante: 0 es sólo hoy. El servicio lo acota a 30.
      diasAdelante: req.query.diasAdelante ? Number(req.query.diasAdelante) : 0,
      filtro: req.query.filtro || null,
    });
    res.json(jornada);
  } catch (e) { next(e); }
};

/*
 * La jornada impresa.
 *
 * Va en A4 y no en ticket: esto se lleva en la mano por el depósito, se apoya
 * en una mesa y se tacha con birome. Un rollo térmico de 80mm no entra en una
 * tablilla y se borra con el calor de la camioneta.
 */
const getPdf = async (req, res, next) => {
  try {
    const jornada = await envios.delDia(req.auth.businessId, {
      fecha: req.query.fecha || null,
      locationId: req.query.locationId ? Number(req.query.locationId) : null,
      envioTipo: req.query.envioTipo || null,
      incluirDespachados: req.query.incluirDespachados === '1',
      // Cuántos días hacia adelante: 0 es sólo hoy. El servicio lo acota a 30.
      diasAdelante: req.query.diasAdelante ? Number(req.query.diasAdelante) : 0,
      filtro: req.query.filtro || null,
    });

    const negocio = await Business.findByPk(req.auth.businessId, {
      attributes: ['id', 'nombreNegocio'],
    });
    const local = req.query.locationId
      ? await BusinessLocation.findOne({
        where: { id: Number(req.query.locationId), businessId: req.auth.businessId },
        attributes: ['id', 'nombre'],
      })
      : null;

    const pdf = await generarPickingPdf(jornada, {
      nombreNegocio: negocio?.nombreNegocio || 'Stocker',
      local: local?.nombre || null,
    });

    /*
     * Se sirve desde memoria y no desde disco: en Railway el filesystem es
     * efímero y un archivo escrito hace dos deploys ya no está. Es lo mismo que
     * hace la lista de precios de evento.
     */
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `inline; filename="picking-${new Date(jornada.fecha).toISOString().slice(0, 10)}.pdf"`);
    // Para que la pantalla pueda decir cuántos paquetes trae sin abrirlo.
    res.setHeader('X-Paquetes', String(jornada.resumen.paquetes));
    res.setHeader('X-Unidades', String(jornada.resumen.unidades));
    res.send(pdf);
  } catch (e) { next(e); }
};

const postDespachar = async (req, res, next) => {
  try {
    const r = await envios.despachar({
      pedidoId: Number(req.params.id),
      businessId: req.auth.businessId,
      employeeId: req.auth.employeeId || null,
    });
    res.json({
      ok: true,
      repetido: r.repetido,
      unidades: r.movidas,
      ventas: r.ventas,
      mensaje: r.repetido
        ? 'Este paquete ya estaba despachado.'
        : `Paquete despachado: salieron ${r.movidas} unidad(es) del stock`
          + (r.ventas > 1 ? `, de ${r.ventas} ventas que van en el mismo envío.` : '.'),
    });
  } catch (e) { next(e); }
};

const postFaltante = async (req, res, next) => {
  try {
    const pedido = await envios.marcarFaltante({
      pedidoId: Number(req.params.id),
      businessId: req.auth.businessId,
      nota: req.body?.nota || null,
      employeeId: req.auth.employeeId || null,
    });
    res.json({
      ok: true,
      pedido,
      /*
       * Se dice explícitamente que el stock no se tocó. Quien marca el faltante
       * necesita saber que el sistema sigue creyendo que la prenda está: si no,
       * asume que quedó ajustado y nadie hace el recuento.
       */
      mensaje: 'Quedó marcado como faltante. El stock no se modificó: '
        + 'la mercadería nunca salió, así que la diferencia se resuelve con un recuento.',
    });
  } catch (e) { next(e); }
};

/*
 * POST /api/envios/despachar-varios
 *
 * Body: { pedidoIds: [1, 2, 3] }
 *
 * Con quince cajas armadas, tocar quince botones y esperar quince respuestas es
 * la mitad del tiempo de cerrar la jornada.
 *
 * Se contesta 200 aunque alguno falle, con la lista de cuáles: un 500 haría
 * pensar que no salió ninguno cuando en realidad salieron catorce, y rehacerlos
 * todos descontaría stock de nuevo.
 */
const postDespacharVarios = async (req, res, next) => {
  try {
    const r = await envios.despacharVarios({
      pedidoIds: Array.isArray(req.body?.pedidoIds) ? req.body.pedidoIds : [],
      businessId: req.auth.businessId,
      employeeId: req.auth.employeeId || null,
    });

    const salieron = r.despachados.filter((d) => !d.repetido).length;
    const repetidos = r.despachados.filter((d) => d.repetido).length;
    const partes = [];
    if (salieron) partes.push(`${salieron} paquete(s) despachado(s), ${r.unidades} unidad(es)`);
    if (repetidos) partes.push(`${repetidos} ya estaba(n) despachado(s)`);
    if (r.fallaron.length) partes.push(`${r.fallaron.length} no se pudo(ieron)`);

    return res.json({
      ok: r.fallaron.length === 0,
      ...r,
      mensaje: partes.join(' · ') || 'No había nada para despachar.',
    });
  } catch (e) { return next(e); }
};

/*
 * GET /api/envios/etiquetas?envioIds=1,2,3
 *
 * Las etiquetas de despacho de Mercado Libre, en un PDF.
 *
 * Los ids se comprueban contra los pedidos DE ESTE NEGOCIO antes de pedírselos
 * a ML. El token es nuestro: sin ese filtro, mandar el id de envío de otro
 * vendedor de la misma cuenta imprimiría una etiqueta que no corresponde, y con
 * los datos del comprador adentro.
 */
const getEtiquetas = async (req, res, next) => {
  try {
    const pedidos = String(req.query.envioIds || '')
      .split(',').map((x) => x.trim()).filter(Boolean);
    if (!pedidos.length) {
      return res.status(400).json({ message: 'Elegí al menos un envío.' });
    }

    const cuenta = await MercadoLibreAccount.findOne({
      where: { businessId: req.auth.businessId },
    });
    if (!cuenta?.refreshToken) {
      return res.status(409).json({
        message: 'No hay ninguna cuenta de Mercado Libre conectada. Conectala en Integraciones.',
      });
    }

    const propios = await PedidoPlataforma.findAll({
      where: {
        businessId: req.auth.businessId,
        plataforma: 'mercadolibre',
        envioId: { [Op.in]: pedidos },
      },
      attributes: ['envioId'],
    });
    const ids = [...new Set(propios.map((p) => p.envioId).filter(Boolean))];
    if (!ids.length) {
      return res.status(404).json({
        message: 'Ninguno de esos envíos es de este negocio.',
      });
    }

    const pdf = await mlPedidos.traerEtiquetas(cuenta, ids);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `inline; filename="etiquetas-${ids.length}.pdf"`);
    // Para que la pantalla pueda avisar si alguno quedó afuera sin abrir el PDF.
    res.setHeader('X-Etiquetas', String(ids.length));
    return res.send(pdf);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ message: e.message });
    return next(e);
  }
};

module.exports = {
  getDelDia, getPdf, postDespachar, postDespacharVarios, postFaltante, getEtiquetas,
};
