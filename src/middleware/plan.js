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

module.exports = { exigirOperativa, requireFeature, SOLO_LECTURA };
