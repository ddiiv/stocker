/*
 * La puerta por la que entra un sistema de afuera.
 *
 * Deja `req.integracion = { businessId, origen, id }` y nada más. En
 * particular NO deja un `req.auth`: lo que entra por acá no es una persona, no
 * tiene permisos y no puede llegar a ninguna ruta pensada para el navegador.
 *
 * ── El negocio sale de la credencial, nunca del cuerpo ───────────
 *
 * Es la regla que Stocker ya escribió para Mercado Libre. Si el negocio
 * viniera en el pedido, una credencial cualquiera podría escribir ventas,
 * stock y cuenta corriente en la cuenta de otro cliente de Stocker.
 */

const integraciones = require('../services/integracionesService');
const { log } = require('../utils/logger');

function tokenDe(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return '';
}

/** Exige una credencial válida. Opcionalmente, de un origen en particular. */
function requireIntegracion(origen = null) {
  return async (req, res, next) => {
    try {
      const integracion = await integraciones.verificar(tokenDe(req));
      /*
       * Un solo mensaje para todos los casos.
       *
       * Token ausente, token inválido, credencial desactivada y origen
       * equivocado contestan igual: distinguirlos le dice a quien prueba
       * cuál de las cuatro cosas acertó.
       */
      if (!integracion || (origen && integracion.origen !== origen)) {
        log.warn('integracion', 'credencial rechazada', {
          origen: origen || 'cualquiera',
          ip: req.ip,
        });
        return res.status(401).json({ message: 'Credencial inválida.' });
      }
      req.integracion = {
        id: integracion.id,
        businessId: integracion.businessId,
        origen: integracion.origen,
      };
      return next();
    } catch (e) { return next(e); }
  };
}

module.exports = { requireIntegracion };
