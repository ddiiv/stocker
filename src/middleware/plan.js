const { estadoDe } = require('../services/planService');

/*
 * Control de plan y suscripción.
 *
 * Dos cosas distintas que suelen confundirse:
 *
 *   requireFeature(clave)  → esta función no está en el plan contratado.
 *                            Se resuelve pagando más (upgrade).
 *   exigirOperativa        → el plan está bien pero la cuenta no está al día.
 *                            Se resuelve pagando lo que debe.
 *
 * Los dos responden 402 con `motivo`, para que el frontend muestre "mejorá tu
 * plan" o "regularizá el pago" y no un error genérico.
 *
 * Regla que no se negocia: sin pagar la cuenta pasa a LECTURA, nunca a
 * borrado ni a datos ocultos. Los GET siguen andando; lo que se corta es
 * facturar, vender y sincronizar. El cliente siempre puede sacar sus datos.
 */

// Métodos que sólo leen. Nunca se bloquean por falta de pago.
const SOLO_LECTURA = new Set(['GET', 'HEAD', 'OPTIONS']);

/** La cuenta tiene que estar en condiciones de operar (trial, activa o morosa). */
const exigirOperativa = async (req, res, next) => {
  try {
    if (SOLO_LECTURA.has(req.method)) return next();

    const { estado, soloLectura, plan } = await estadoDe(req.auth.businessId);
    if (!soloLectura) return next();

    return res.status(402).json({
      motivo: 'suscripcion',
      estado,
      plan: plan?.codigo || null,
      message: estado === 'lectura'
        ? 'La prueba terminó y la cuenta quedó en modo lectura. Tus datos están intactos: activá la suscripción y volvés a operar al instante.'
        : 'La suscripción está cancelada. Reactivala para volver a operar.',
    });
  } catch (e) { next(e); }
};

/**
 * La función pedida tiene que estar incluida en el plan.
 * @param {string} clave  una de config/planes.js → FEATURES
 */
const requireFeature = (clave) => async (req, res, next) => {
  try {
    const { plan, soloLectura, estado } = await estadoDe(req.auth.businessId);

    // Sin pagar no se habilita nada, ni siquiera lo que el plan incluye.
    if (soloLectura && !SOLO_LECTURA.has(req.method)) {
      return res.status(402).json({
        motivo: 'suscripcion', estado, plan: plan?.codigo || null,
        message: 'La cuenta está en modo lectura. Activá la suscripción para usar esta función.',
      });
    }

    if (plan?.features?.[clave]) return next();

    return res.status(402).json({
      motivo: 'plan',
      feature: clave,
      plan: plan?.codigo || null,
      message: `Esta función no está incluida en el ${plan?.nombre || 'plan actual'}.`,
    });
  } catch (e) { next(e); }
};

/*
 * Rutas que nunca se bloquean por falta de pago.
 *
 * Son las que el cliente necesita justamente cuando la cuenta está en lectura:
 * entrar, ver su cuenta, y sobre todo pagar. Bloquear /billing sería encerrarlo
 * afuera de la única pantalla que le devuelve el servicio.
 *
 * Antes esto no hacía falta declararlo: el candado se montaba con un r.use() a
 * mitad del archivo de rutas y sólo alcanzaba a lo registrado más abajo. Pero
 * ese r.use corría ANTES del requireAuth de cada ruta, así que leía un
 * req.auth que todavía no existía y dejaba pasar todo. El candado nunca se
 * cerró. Ahora corre dentro de requireAuth —el único lugar donde req.auth ya
 * está— y la lista de exentas pasa a ser explícita.
 */
const EXENTAS = ['/auth', '/account', '/billing', '/backoffice', '/public'];

const estaExenta = (ruta) => EXENTAS.some((p) => ruta === p || ruta.startsWith(p + '/'));

/**
 * El candado, para llamar desde requireAuth con req.auth ya cargado.
 * @returns {object|null} el cuerpo del 402, o null si puede seguir.
 */
async function motivoDeBloqueo(req) {
  if (SOLO_LECTURA.has(req.method)) return null;
  if (estaExenta(req.path)) return null;
  if (!req.auth?.businessId) return null;

  const { estado, soloLectura, plan } = await estadoDe(req.auth.businessId);
  if (!soloLectura) return null;

  return {
    motivo: 'suscripcion',
    estado,
    plan: plan?.codigo || null,
    message: estado === 'lectura'
      ? 'La prueba terminó y la cuenta quedó en modo lectura. Tus datos están intactos: activá la suscripción y volvés a operar al instante.'
      : 'La suscripción está cancelada. Reactivala para volver a operar.',
  };
}

module.exports = { exigirOperativa, requireFeature, SOLO_LECTURA, motivoDeBloqueo, EXENTAS };
