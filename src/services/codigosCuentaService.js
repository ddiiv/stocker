const { Op } = require('sequelize');
const { AccountChangeCode } = require('../models');
const { sendAccountChangeCode } = require('./emailService');
const { sendWhatsappMessage, whatsappConfigurado } = require('./whatsappService');
const { log, mask } = require('../utils/logger');

/*
 * Códigos de un solo uso para confirmar cosas sensibles de la cuenta.
 *
 * Vive en un servicio y no en el controlador porque lo usan dos caminos: la
 * pantalla de Mi cuenta —cambiar email, cambiar contraseña— y el login, cuando
 * el segundo factor es un código al mail o al teléfono. Escrito dos veces, el
 * día que se corrige la cuenta de intentos o el vencimiento en uno, el otro
 * queda viejo; y el que queda viejo suele ser el del login.
 */

const VIGENCIA_MIN = 15;
const MAX_INTENTOS = 4;

const generarCodigo = () => String(Math.floor(100000 + Math.random() * 900000));

/*
 * Canales disponibles.
 *
 * `disponible()` mira la configuración del servidor —no alcanza con que el
 * negocio quiera usar WhatsApp si las credenciales de Meta no están puestas—,
 * y `destinoDe` decide a dónde va. Ofrecer un canal que no puede entregar es
 * peor que no ofrecerlo: deja a la persona esperando un código que no va a
 * llegar, en la pantalla de entrar.
 */
const CANALES = {
  email: {
    disponible: () => true,
    destinoDe: (business, datos) => datos.emailNuevo || business.email,
    enmascarar: (destino) => mask.email(destino),
    enviar: async ({ destino, code, business }) => {
      await sendAccountChangeCode({
        to: destino,
        ownerName: business.ownerNombre,
        businessName: business.nombreNegocio,
        code,
        expiresInMinutes: VIGENCIA_MIN,
      });
    },
  },
  whatsapp: {
    disponible: () => whatsappConfigurado(),
    destinoDe: (business, datos) => datos.telefonoNuevo || business.ownerTelefono,
    // Se muestran los últimos cuatro dígitos: alcanza para reconocer el
    // teléfono propio y no publica el número entero en una pantalla pública.
    enmascarar: (destino) => {
      const d = String(destino || '').replace(/\D/g, '');
      return d.length > 4 ? `••••${d.slice(-4)}` : '••••';
    },
    enviar: async ({ destino, code, business }) => {
      /*
       * `sendWhatsappMessage` avisa el fallo devolviendo `{ok:false}`, no
       * tirando: sirve para un aviso de venta, que si no sale no rompe nada.
       * Acá no: si el código no salió, la persona se queda esperando en la
       * pantalla de entrar. Se convierte en error para que el pedido falle y
       * la pantalla pueda ofrecer otro canal.
       */
      const r = await sendWhatsappMessage({
        telefono: destino,
        mensaje: `Tu código de Stocker es ${code}. Vence en ${VIGENCIA_MIN} minutos. `
          + `Si no lo pediste vos, cambiá la contraseña de ${business.nombreNegocio}.`,
      });
      if (!r?.ok) {
        throw Object.assign(
          new Error('No se pudo enviar el WhatsApp. Probá con el código al mail.'),
          { status: 502 },
        );
      }
    },
  },
};

/** Los canales que este servidor puede entregar de verdad, para un negocio dado. */
function canalesUtilizables(business) {
  return Object.entries(CANALES)
    .filter(([, def]) => def.disponible() && Boolean(def.destinoDe(business, {})))
    .map(([nombre]) => nombre);
}

async function emitirCodigo({ business, tipo, datos = {}, canal = 'email' }) {
  const definicion = CANALES[canal];
  if (!definicion?.disponible()) {
    throw Object.assign(new Error(`El canal ${canal} no está disponible.`), { status: 400 });
  }
  const destino = definicion.destinoDe(business, datos);
  if (!destino) {
    throw Object.assign(new Error(`No hay a dónde mandar el código por ${canal}.`), { status: 400 });
  }

  // Un pedido nuevo invalida los anteriores del mismo tipo: si no, quedarían
  // varios códigos válidos a la vez y cualquiera serviría.
  await AccountChangeCode.update(
    { usedAt: new Date() },
    { where: { businessId: business.id, tipo, usedAt: null } }
  );

  const code = generarCodigo();
  await AccountChangeCode.create({
    businessId: business.id,
    tipo, canal, destino, code,
    payload: JSON.stringify(datos),
    attemptsLeft: MAX_INTENTOS,
    expiresAt: new Date(Date.now() + VIGENCIA_MIN * 60_000),
  });

  await definicion.enviar({ destino, code, business });
  log.info('cuenta', `código de ${tipo} enviado`, { canal, a: definicion.enmascarar(destino) });

  return { destino, canal, destinoEnmascarado: definicion.enmascarar(destino) };
}

async function validarCodigo({ businessId, tipo, code }) {
  const registro = await AccountChangeCode.findOne({
    where: { businessId, tipo, usedAt: null, expiresAt: { [Op.gt]: new Date() } },
    order: [['createdAt', 'DESC']],
  });
  if (!registro) {
    throw Object.assign(new Error('El código venció o no existe. Pedí uno nuevo.'), { status: 400 });
  }
  if (registro.attemptsLeft <= 0) {
    throw Object.assign(new Error('Se agotaron los intentos. Pedí un código nuevo.'), { status: 429 });
  }
  if (String(registro.code) !== String(code || '').trim()) {
    await registro.update({ attemptsLeft: registro.attemptsLeft - 1 });
    throw Object.assign(
      new Error(`Código incorrecto. Te quedan ${registro.attemptsLeft - 1} intentos.`),
      { status: 400 }
    );
  }
  return registro;
}

/**
 * Igual que `validarCodigo` pero sin tirar: para el login, donde un código
 * equivocado no es un error de programa sino una respuesta esperada.
 */
async function codigoEsValido({ businessId, tipo, code }) {
  try {
    const registro = await validarCodigo({ businessId, tipo, code });
    await registro.update({ usedAt: new Date() });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  CANALES, canalesUtilizables, emitirCodigo, validarCodigo, codigoEsValido,
  VIGENCIA_MIN, MAX_INTENTOS,
};
