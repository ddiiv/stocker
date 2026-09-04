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

const envios = require('../services/enviosDelDiaService');
const { generarPickingPdf } = require('../services/pickingPdfService');
const { Business, BusinessLocation } = require('../models');

const getDelDia = async (req, res, next) => {
  try {
    const jornada = await envios.delDia(req.auth.businessId, {
      fecha: req.query.fecha || null,
      locationId: req.query.locationId ? Number(req.query.locationId) : null,
      envioTipo: req.query.envioTipo || null,
      incluirDespachados: req.query.incluirDespachados === '1',
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
      mensaje: r.repetido
        ? 'Este paquete ya estaba despachado.'
        : `Paquete despachado: salieron ${r.movidas} unidad(es) del stock.`,
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

module.exports = { getDelDia, getPdf, postDespachar, postFaltante };
