const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const { Business, BusinessCuit, AccountChangeCode, Employee } = require('../models');
const { lookupCuit } = require('../services/arcaLookupService');
const { sendAccountChangeCode } = require('../services/emailService');
const { log, mask } = require('../utils/logger');
const identidad = require('../services/identityRegistry');
const { crearSesion, corteDeSesiones } = require('../utils/session');
const totp = require('../utils/totp');
const dosFactores = require('../services/dosFactoresService');
const { setAuthCookie } = require('../utils/authCookie');

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
      dobleFactor: {
        habilitado: Boolean(b.totpSecret),
        activadoEn: b.totpActivadoEn || null,
        codigosRestantes: dosFactores.codigosRestantes(b),
        // Una activación empezada y no terminada: la pantalla la ofrece para
        // retomarla en vez de arrancar de cero.
        pendiente: Boolean(b.totpPendiente) && !b.totpSecret,
      },
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
    /*
     * El negocio se lee ANTES de comprobar el email.
     *
     * Estaba al revés: `b.id` se usaba una línea antes del `const b`, o sea
     * dentro de su zona muerta temporal. No era un caso borde — reventaba con
     * ReferenceError siempre, así que cambiar el email de la cuenta nunca
     * funcionó y devolvía un 500 sin explicación.
     */
    const b = await Business.findByPk(req.auth.businessId);
    if (!b) return res.status(404).json({ message: 'No se encontró la cuenta.' });

    // Puede haberse registrado esa casilla entre el pedido y la confirmación.
    await identidad.exigirLibre(emailNuevo, { businessId: b.id });

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

    /*
     * Se cambia la contraseña y se cierran todas las sesiones abiertas.
     *
     * Menos ésta. Cerrar también la del que está cambiando la contraseña lo
     * echaría de la pantalla en la que está parado, y el que cambia su
     * contraseña por las dudas terminaría creyendo que rompió algo. Se le
     * emite una sesión nueva —posterior al corte— así que este dispositivo
     * sigue adentro y todos los demás quedan afuera en su próximo pedido.
     */
    const corte = corteDeSesiones();
    await b.update({ passwordHash: await bcrypt.hash(nueva, 10), sesionesDesde: corte });
    await registro.update({ usedAt: new Date() });

    setAuthCookie(res, crearSesion({ type: 'business', businessId: b.id }), req);

    log.info('cuenta', 'contraseña de la cuenta actualizada y sesiones cerradas');
    res.json({
      message: 'Contraseña actualizada. Se cerraron las sesiones abiertas en otros dispositivos.',
      sesionesCerradas: true,
    });
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

/*
 * POST /api/account/sesiones/cerrar
 *
 * El botón de pánico: saca a todo el mundo de todas las computadoras, dueño y
 * empleados, sin cambiarle la contraseña a nadie.
 *
 * Es distinto de cambiar la contraseña, que sólo cierra las sesiones que ESA
 * contraseña abrió. Acá el caso es otro: se perdió un teléfono con la sesión
 * abierta, quedó una computadora prendida en el local, se fue alguien que
 * sabía una clave. No hace falta obligar a todo el equipo a inventarse
 * contraseñas nuevas para volver a entrar — con que vuelvan a entrar alcanza.
 *
 * Pide la contraseña actual. Sin eso, cualquiera que agarre la máquina del
 * mostrador con la sesión abierta puede dejar al negocio entero afuera en el
 * medio de un sábado, que es un daño real y gratuito.
 */
const cerrarTodasLasSesiones = async (req, res, next) => {
  try {
    const b = await Business.findByPk(req.auth.businessId);
    const actual = String(req.body?.passwordActual || '');
    if (!actual || !(await bcrypt.compare(actual, b.passwordHash))) {
      return res.status(400).json({ message: 'La contraseña actual no es correcta.' });
    }

    /*
     * Un mismo instante para la cuenta y para todos los empleados: con dos
     * `new Date()` distintos, una sesión que arranca entre medio se salva.
     */
    const corte = corteDeSesiones();
    await b.update({ sesionesDesde: corte });
    const [empleados] = await Employee.update(
      { sesionesDesde: corte },
      { where: { businessId: b.id } },
    );

    /*
     * Menos la de acá: el que aprieta el botón se queda adentro. Echarlo
     * también lo dejaría afuera justo cuando está resolviendo un problema de
     * seguridad, y con la duda de si el botón funcionó o rompió algo.
     */
    setAuthCookie(res, crearSesion({ type: 'business', businessId: b.id }), req);

    log.info('cuenta', 'se cerraron todas las sesiones del negocio', { empleados });
    res.json({
      message: 'Listo. Se cerraron todas las sesiones abiertas, menos la de este dispositivo.',
      empleadosAfectados: empleados,
    });
  } catch (error) { next(error); }
};

/*
 * ── Segundo factor con app de autenticación ──────────────────────
 *
 * Tres pasos, y el orden importa:
 *
 *   1. `iniciar` genera un secreto PENDIENTE y lo devuelve para cargar en la
 *      app. Todavía no protege nada.
 *   2. `activar` exige un código correcto de ese secreto pendiente. Recién ahí
 *      pasa a ser el secreto real. Sin este paso, quien abre la pantalla y se
 *      distrae queda con el 2FA prendido y sin ninguna app cargada: afuera de
 *      su propia cuenta, sin forma de volver.
 *   3. `desactivar` pide contraseña Y código, por la misma razón por la que se
 *      pide algo más que la sesión para cualquier cambio de credenciales.
 */

// POST /api/account/2fa/iniciar  { passwordActual }
const iniciar2FA = async (req, res, next) => {
  try {
    const b = await Business.findByPk(req.auth.businessId);
    const actual = String(req.body?.passwordActual || '');
    if (!actual || !(await bcrypt.compare(actual, b.passwordHash))) {
      return res.status(400).json({ message: 'La contraseña actual no es correcta.' });
    }
    if (b.totpSecret) {
      return res.status(400).json({
        message: 'La verificación en dos pasos ya está activa. Desactivala primero si querés cargarla en otro teléfono.',
        codigo: 'TOTP_YA_ACTIVO',
      });
    }

    /*
     * Un secreto nuevo en cada intento, aunque hubiera uno pendiente.
     *
     * Si se reutilizara el pendiente, un secreto que quedó a la vista en una
     * pantalla abierta —o en el historial de alguien que empezó y no terminó—
     * seguiría siendo válido para siempre.
     */
    const secreto = totp.generarSecreto();
    await b.update({ totpPendiente: secreto });

    log.info('cuenta', 'activación de segundo factor iniciada');
    res.json({
      secreto,
      uri: totp.uriParaQr({ secreto, cuenta: b.email, emisor: 'Stocker' }),
      digitos: totp.DIGITOS,
      periodoSegundos: totp.PASO_SEG,
    });
  } catch (error) { next(error); }
};

// POST /api/account/2fa/activar  { code }
const activar2FA = async (req, res, next) => {
  try {
    const b = await Business.findByPk(req.auth.businessId);
    if (!b.totpPendiente) {
      return res.status(400).json({ message: 'No hay ninguna activación empezada. Empezá de nuevo.' });
    }

    const paso = totp.pasoValido(b.totpPendiente, req.body?.code);
    if (paso === null) {
      return res.status(400).json({
        message: 'Ese código no coincide. Fijate que el reloj del teléfono esté en hora y probá con el siguiente.',
        codigo: 'TOTP_INVALIDO',
      });
    }

    /*
     * Los códigos de recuperación se muestran UNA vez y no se guardan en
     * claro. Si se perdieran del lado del servidor no habría forma de
     * recuperarlos, que es exactamente lo que se busca: sirven para volver a
     * entrar sin el teléfono, así que guardarlos legibles los convierte en una
     * segunda contraseña esperando a que alguien lea la base.
     */
    const { planos, hashes } = dosFactores.generarCodigosDeRecuperacion();
    await b.update({
      totpSecret: b.totpPendiente,
      totpPendiente: null,
      totpActivadoEn: new Date(),
      totpUltimoPaso: paso,
      totpRecuperacion: JSON.stringify(hashes),
    });

    log.info('cuenta', 'segundo factor activado');
    res.json({
      message: 'Listo, la verificación en dos pasos quedó activa.',
      codigosDeRecuperacion: planos,
    });
  } catch (error) { next(error); }
};

// POST /api/account/2fa/desactivar  { passwordActual, code }
const desactivar2FA = async (req, res, next) => {
  try {
    const b = await Business.findByPk(req.auth.businessId);
    const actual = String(req.body?.passwordActual || '');
    if (!actual || !(await bcrypt.compare(actual, b.passwordHash))) {
      return res.status(400).json({ message: 'La contraseña actual no es correcta.' });
    }
    if (!b.totpSecret) {
      return res.status(400).json({ message: 'La verificación en dos pasos no está activa.' });
    }

    const r = await dosFactores.verificar(b, req.body?.code);
    if (!r.ok) {
      return res.status(400).json({
        message: r.motivo === 'repetido'
          ? 'Ese código ya se usó. Esperá a que la app muestre el siguiente.'
          : 'El código no es correcto. Podés usar uno de recuperación.',
        codigo: 'TOTP_INVALIDO',
      });
    }

    await b.update({
      totpSecret: null, totpPendiente: null, totpActivadoEn: null,
      totpUltimoPaso: null, totpRecuperacion: null,
    });

    log.info('cuenta', 'segundo factor desactivado');
    res.json({ message: 'La verificación en dos pasos quedó desactivada.' });
  } catch (error) { next(error); }
};

// POST /api/account/2fa/codigos  { passwordActual, code }
const regenerarCodigos2FA = async (req, res, next) => {
  try {
    const b = await Business.findByPk(req.auth.businessId);
    const actual = String(req.body?.passwordActual || '');
    if (!actual || !(await bcrypt.compare(actual, b.passwordHash))) {
      return res.status(400).json({ message: 'La contraseña actual no es correcta.' });
    }
    if (!b.totpSecret) {
      return res.status(400).json({ message: 'La verificación en dos pasos no está activa.' });
    }

    const r = await dosFactores.verificar(b, req.body?.code);
    if (!r.ok) {
      return res.status(400).json({ message: 'El código no es correcto.', codigo: 'TOTP_INVALIDO' });
    }

    /*
     * Los anteriores dejan de servir. Se regeneran cuando se perdieron o
     * quedaron a la vista: si los viejos siguieran valiendo, regenerarlos no
     * arreglaría nada.
     */
    const { planos, hashes } = dosFactores.generarCodigosDeRecuperacion();
    await b.update({ totpRecuperacion: JSON.stringify(hashes) });

    log.info('cuenta', 'códigos de recuperación regenerados');
    res.json({
      message: 'Códigos nuevos. Los anteriores dejaron de servir.',
      codigosDeRecuperacion: planos,
    });
  } catch (error) { next(error); }
};

module.exports = {
  obtener, actualizar, sincronizarConArca,
  iniciar2FA, activar2FA, desactivar2FA, regenerarCodigos2FA,
  solicitarCambioEmail, confirmarCambioEmail,
  solicitarCambioPassword, confirmarCambioPassword,
  cerrarTodasLasSesiones,
};
