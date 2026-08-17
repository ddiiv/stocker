const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const { Business, BusinessCuit, AccountChangeCode } = require('../models');
const { lookupCuit } = require('../services/arcaLookupService');
const { sendAccountChangeCode } = require('../services/emailService');
const { log, mask } = require('../utils/logger');
const identidad = require('../services/identityRegistry');

/*
 * Cuenta del dueño.
 *
 * Los datos comunes (nombre, teléfono, nombre del negocio) se editan directo.
 * El email y la contraseña no: son las dos llaves de acceso, y cambiarlas sin
 * confirmar deja la puerta abierta a que alguien con la sesión robada se
 * apropie de la cuenta. Por eso ambos piden un código enviado por mail.
 *
 * Para el email el código va a la casilla NUEVA: además de confirmar que es el
 * dueño, prueba que esa casilla existe y la controla. Si fuera al mail viejo,
 * un tipeo mal escrito dejaría la cuenta con un email al que nadie llega.
 *
 * Para la contraseña se pide además la actual: el código llega al mail, y si
 * alguien tomó la sesión pero no la casilla, la contraseña actual lo frena.
 */

const VIGENCIA_MIN = 15;
const MAX_INTENTOS = 4;

const generarCodigo = () => String(Math.floor(100000 + Math.random() * 900000));

/*
 * Canales de confirmación disponibles.
 *
 * Hoy sólo email. La estructura queda lista para sumar teléfono como segundo
 * factor: el modelo ya guarda `canal` y `destino`, así que agregar SMS o
 * WhatsApp es implementar el envío y habilitarlo acá, sin tocar el esquema
 * ni el flujo de verificación.
 */
const CANALES = {
  email: {
    disponible: () => true,
    destinoDe: (business, datos) => datos.emailNuevo || business.email,
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
  // sms / whatsapp: pendientes. Al implementarlos, `disponible` debe mirar que
  // el negocio tenga teléfono verificado antes de ofrecerlos.
};

async function emitirCodigo({ business, tipo, datos = {}, canal = 'email' }) {
  const definicion = CANALES[canal];
  if (!definicion?.disponible()) {
    throw Object.assign(new Error(`El canal ${canal} no está disponible.`), { status: 400 });
  }

  // Un pedido nuevo invalida los anteriores del mismo tipo: si no, quedarían
  // varios códigos válidos a la vez y cualquiera serviría.
  await AccountChangeCode.update(
    { usedAt: new Date() },
    { where: { businessId: business.id, tipo, usedAt: null } }
  );

  const code = generarCodigo();
  const destino = definicion.destinoDe(business, datos);

  await AccountChangeCode.create({
    businessId: business.id,
    tipo, canal, destino, code,
    payload: JSON.stringify(datos),
    attemptsLeft: MAX_INTENTOS,
    expiresAt: new Date(Date.now() + VIGENCIA_MIN * 60_000),
  });

  await definicion.enviar({ destino, code, business });
  log.info('cuenta', `código de cambio de ${tipo} enviado`, { canal, a: mask.email(destino) });

  return { destino, canal };
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

const sinPassword = (b) => { const { passwordHash, ...safe } = b.toJSON(); return safe; };

// GET /api/account
const obtener = async (req, res, next) => {
  try {
    const b = await Business.findByPk(req.auth.businessId);
    if (!b) return res.status(404).json({ message: 'Cuenta no encontrada.' });
    res.json({
      ...sinPassword(b),
      // El frontend lo usa para mostrar el 2FA como "próximamente" sin tener
      // que conocer qué canales existen del lado del servidor.
      canales: Object.keys(CANALES),
      dobleFactor: { habilitado: false, canalesDisponibles: [] },
    });
  } catch (error) { next(error); }
};

// PUT /api/account — datos que no son credenciales
const actualizar = async (req, res, next) => {
  try {
    const b = await Business.findByPk(req.auth.businessId);
    if (!b) return res.status(404).json({ message: 'Cuenta no encontrada.' });

    /*
     * Lista blanca corta a propósito. Quedan afuera:
     *
     *   · email y contraseña → tienen su flujo con código de confirmación.
     *   · cuit → identifica fiscalmente a la cuenta. Cambiarlo sería otra
     *     cuenta, y dejaría facturas ya emitidas a nombre del CUIT anterior.
     *   · ownerNombre / ownerApellido / condicionIva → salen del padrón de
     *     ARCA, no los escribe el usuario. Si difirieran de lo que AFIP tiene
     *     registrado, los comprobantes saldrían con datos que no validan.
     */
    const permitidos = ['nombreNegocio', 'ownerTelefono', 'telefono'];
    const patch = {};
    for (const campo of permitidos) {
      if (req.body?.[campo] !== undefined) patch[campo] = String(req.body[campo]).trim();
    }
    if (patch.nombreNegocio === '') return res.status(400).json({ message: 'El nombre del negocio no puede quedar vacío.' });

    if (req.body?.cuit !== undefined && String(req.body.cuit).replace(/\D/g, '') !== String(b.cuit).replace(/\D/g, '')) {
      return res.status(400).json({
        message: 'El CUIT no se puede cambiar: identifica fiscalmente a la cuenta y las facturas ya emitidas quedaron a su nombre.',
      });
    }

    await b.update(patch);
    res.json(sinPassword(b));
  } catch (error) { next(error); }
};

// POST /api/account/email/solicitar  { emailNuevo }
const solicitarCambioEmail = async (req, res, next) => {
  try {
    const emailNuevo = String(req.body?.emailNuevo || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNuevo)) {
      return res.status(400).json({ message: 'Ingresá un email válido.' });
    }

    const b = await Business.findByPk(req.auth.businessId);
    if (emailNuevo === String(b.email).toLowerCase()) {
      return res.status(400).json({ message: 'Ese ya es tu email actual.' });
    }
    // No alcanza con mirar `businesses`: el email tampoco puede ser el de un
    // empleado de cualquier negocio ni el de un operador de la plataforma.
    await identidad.exigirLibre(emailNuevo, { businessId: b.id });

    const { destino } = await emitirCodigo({ business: b, tipo: 'email', datos: { emailNuevo } });
    res.json({
      message: `Te mandamos un código a ${destino}. Revisá esa casilla para confirmar el cambio.`,
      expiraEnMinutos: VIGENCIA_MIN,
    });
  } catch (error) { next(error); }
};

// POST /api/account/email/confirmar  { code }
const confirmarCambioEmail = async (req, res, next) => {
  try {
    const registro = await validarCodigo({
      businessId: req.auth.businessId, tipo: 'email', code: req.body?.code,
    });
    const { emailNuevo } = JSON.parse(registro.payload || '{}');
    if (!emailNuevo) {
      return res.status(400).json({ message: 'El pedido perdió el email nuevo. Empezá de nuevo.' });
    }
    // Puede haberse registrado esa casilla entre el pedido y la confirmación.
    // No alcanza con mirar `businesses`: el email tampoco puede ser el de un
    // empleado de cualquier negocio ni el de un operador de la plataforma.
    await identidad.exigirLibre(emailNuevo, { businessId: b.id });

    const b = await Business.findByPk(req.auth.businessId);
    await b.update({ email: emailNuevo });
    await registro.update({ usedAt: new Date() });

    log.info('cuenta', 'email de la cuenta actualizado', { a: mask.email(emailNuevo) });
    res.json({ message: 'Listo, tu email quedó actualizado.', email: emailNuevo });
  } catch (error) { next(error); }
};

// POST /api/account/password/solicitar  { passwordActual }
const solicitarCambioPassword = async (req, res, next) => {
  try {
    const b = await Business.findByPk(req.auth.businessId);
    const actual = String(req.body?.passwordActual || '');
    if (!actual || !(await bcrypt.compare(actual, b.passwordHash))) {
      return res.status(400).json({ message: 'La contraseña actual no es correcta.' });
    }

    const { destino } = await emitirCodigo({ business: b, tipo: 'password' });
    res.json({
      message: `Te mandamos un código a ${destino} para confirmar el cambio.`,
      expiraEnMinutos: VIGENCIA_MIN,
    });
  } catch (error) { next(error); }
};

// POST /api/account/password/confirmar  { code, passwordNueva }
// La fortaleza de passwordNueva la valida validatePasswordBody en la ruta.
const confirmarCambioPassword = async (req, res, next) => {
  try {
    const registro = await validarCodigo({
      businessId: req.auth.businessId, tipo: 'password', code: req.body?.code,
    });

    const b = await Business.findByPk(req.auth.businessId);
    const nueva = String(req.body?.passwordNueva || '');
    if (await bcrypt.compare(nueva, b.passwordHash)) {
      return res.status(400).json({ message: 'La contraseña nueva tiene que ser distinta de la actual.' });
    }

    await b.update({ passwordHash: await bcrypt.hash(nueva, 10) });
    await registro.update({ usedAt: new Date() });

    log.info('cuenta', 'contraseña de la cuenta actualizada');
    res.json({ message: 'Contraseña actualizada.' });
  } catch (error) { next(error); }
};

/*
 * POST /api/account/sincronizar-arca
 *
 * Trae del padrón el nombre, apellido y condición frente a ARCA del CUIT de la
 * cuenta. Son datos que tiene AFIP, no el usuario: dejarlos escribir a mano
 * llevaría a emitir comprobantes con un titular que no coincide con el CUIT.
 *
 * También actualiza el CUIT principal de facturación, que es el mismo.
 */
const sincronizarConArca = async (req, res, next) => {
  try {
    const b = await Business.findByPk(req.auth.businessId);
    const cuit = String(b.cuit || '').replace(/\D/g, '');
    if (cuit.length !== 11) {
      return res.status(400).json({ message: 'La cuenta no tiene un CUIT válido cargado.' });
    }

    const datos = await lookupCuit(cuit);
    if (!datos?.valido) {
      return res.status(400).json({ message: 'El CUIT de la cuenta no pasa la validación del dígito verificador.' });
    }
    if (datos.source !== 'afip') {
      return res.status(502).json({
        message: 'No se pudo consultar el padrón de ARCA en este momento. Probá de nuevo en unos minutos.',
      });
    }

    const patch = { arcaSyncEn: new Date() };
    if (datos.condicionIva) patch.condicionIva = datos.condicionIva;
    // Persona física: apellido y nombre por separado. Jurídica: la razón
    // social entera va en el nombre, porque no tiene apellido.
    if (datos.apellido) {
      patch.ownerApellido = datos.apellido;
      if (datos.nombre) patch.ownerNombre = datos.nombre;
    } else if (datos.razonSocial) {
      patch.ownerNombre = datos.razonSocial;
      patch.ownerApellido = '';
    }
    await b.update(patch);

    // El CUIT principal de facturación es el mismo: se mantiene alineado para
    // que el emisor de las facturas no quede con datos viejos.
    const principal = await BusinessCuit.findOne({ where: { businessId: b.id, cuit: b.cuit } });
    if (principal) {
      await principal.update({
        condicionIva: datos.condicionIva || principal.condicionIva,
        domicilio: datos.domicilio || principal.domicilio,
      });
    }

    log.info('cuenta', 'datos sincronizados con el padrón de ARCA', { cuit: mask.cuit(cuit) });
    res.json({ ...sinPassword(await Business.findByPk(b.id)), message: 'Datos actualizados desde ARCA.' });
  } catch (error) { next(error); }
};

module.exports = {
  obtener, actualizar, sincronizarConArca,
  solicitarCambioEmail, confirmarCambioEmail,
  solicitarCambioPassword, confirmarCambioPassword,
};
