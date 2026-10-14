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
const { FEATURE_POR_ORIGEN } = require('../config/plataformas');
const { log } = require('../utils/logger');

function tokenDe(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return '';
}

/*
 * ¿El plan del negocio incluye esta conexión?
 *
 * Tienda propia y portal mayorista son funciones del plan (desde el Pro). La
 * credencial dice QUIÉN golpea; esto dice si el negocio tiene contratado que
 * ese alguien entre.
 *
 * El negocio que ya tenía la credencial viva el día que se puso esta puerta la
 * conserva aunque su plan no la incluya: está anotado en `featuresHeredadas`
 * (ver ensureColumns.heredarConexionesPropias). Sin eso, el despliegue le
 * cortaba el puente a quien ya estaba vendiendo por él.
 *
 * Mira sólo el PLAN, no si la cuenta está al día. Qué hace una cuenta en modo
 * lectura con los pedidos que siguen llegando de su tienda o de su portal es
 * una decisión comercial que todavía no está tomada; hasta entonces el puente
 * sigue como estaba.
 *
 * Devuelve el cuerpo del 402, o null si puede pasar.
 */
async function rechazoPorPlan(integracion) {
  const clave = FEATURE_POR_ORIGEN[integracion.origen];
  // Un origen sin función asociada no tiene puerta de plan.
  if (!clave) return null;

  // Se requieren acá y no arriba: planService carga los modelos y medio
  // sistema, y este archivo lo requiere el router al arrancar.
  const { estadoDe, heredaFeature } = require('../services/planService');
  const { Business } = require('../models');

  const { plan } = await estadoDe(integracion.businessId);
  if (plan?.features?.[clave]) return null;

  const negocio = await Business.findByPk(integracion.businessId, {
    attributes: ['id', 'featuresHeredadas'],
  });
  if (heredaFeature(negocio, clave)) return null;

  // El plan que la trae se busca en la base y no se escribe acá: si el
  // equipo la suma a otro plan desde el backoffice, el mensaje lo sigue.
  const { planMinimoPara } = require('../services/plataformasService');
  const desde = await planMinimoPara(clave);
  return {
    motivo: 'plan',
    feature: clave,
    message: 'El plan de Stocker de este negocio no incluye esta conexión.'
      + (desde ? ` Se habilita desde el ${desde.nombre}.` : ''),
  };
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

      /*
       * 402 y no 401: la credencial es buena, lo que falta es el plan. Quien
       * mantiene la página tiene que poder distinguir "me equivoqué de token"
       * de "el negocio tiene que cambiar de plan", y a esta altura ya probó
       * que tiene la credencial, así que decírselo no le regala nada.
       */
      const rechazo = await rechazoPorPlan(integracion);
      if (rechazo) {
        log.warn('integracion', 'el plan del negocio no incluye la conexión', {
          origen: integracion.origen, negocio: integracion.businessId,
        });
        return res.status(402).json(rechazo);
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

module.exports = { requireIntegracion, rechazoPorPlan };
