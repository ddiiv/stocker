/*
 * Reportar un problema.
 *
 * El pedido de ayuda tiene que salir desde adentro del sistema y no desde el
 * mail del dueño: así llega con el contexto puesto —qué negocio, qué plan, en
 * qué pantalla estaba— en vez de un "no me anda" que arranca con dos idas y
 * vueltas antes de poder mirar nada.
 */

const { Business, Subscription, Plan, Employee } = require('../models');
const { sendReporteProblema } = require('../services/emailService');
const { CASILLAS } = require('../config/correo');
const { esAdministradorTotal } = require('../middleware/auth');

const TIPOS = ['bug', 'duda', 'facturacion', 'sugerencia', 'otro'];

// POST /api/soporte/reporte
const reportar = async (req, res, next) => {
  try {
    const asunto  = String(req.body?.asunto || '').trim();
    const detalle = String(req.body?.detalle || '').trim();
    const tipo    = TIPOS.includes(req.body?.tipo) ? req.body.tipo : 'otro';

    if (asunto.length < 4) {
      return res.status(400).json({ message: 'Poné un asunto de al menos 4 caracteres.' });
    }
    /*
     * Un mínimo de detalle, porque un reporte de tres palabras no se puede
     * atender: obliga a escribir pidiendo lo mismo que se podría haber puesto.
     */
    if (detalle.length < 20) {
      return res.status(400).json({
        message: 'Contá un poco más: qué estabas haciendo, qué esperabas que pasara y qué pasó. Con eso se puede mirar sin volver a preguntarte.',
      });
    }

    const negocio = await Business.findByPk(req.auth.businessId, {
      attributes: ['id', 'nombreNegocio', 'cuit', 'email'],
    });
    if (!negocio) return res.status(404).json({ message: 'Negocio no encontrado.' });

    /*
     * Quién reporta y a qué dirección se le contesta.
     *
     * Si lo manda un empleado, la respuesta va a su casilla y no a la del
     * negocio: el que tiene el problema adelante es él.
     */
    let quien = negocio.nombreNegocio;
    let email = negocio.email;
    if (req.auth.employeeId) {
      const emp = await Employee.findByPk(req.auth.employeeId, {
        attributes: ['nombre', 'apellido', 'email'],
      });
      if (emp) {
        quien = `${emp.nombre} ${emp.apellido || ''}`.trim();
        email = emp.email || negocio.email;
      }
    }

    const sub = await Subscription.findOne({
      where: { businessId: negocio.id },
      include: [{ model: Plan, as: 'plan', attributes: ['nombre'] }],
    });

    const r = await sendReporteProblema({
      negocio: negocio.toJSON(),
      quien, email, tipo, asunto, detalle,
      contexto: {
        plan: sub?.plan?.nombre || sub?.estado || null,
        // Los manda la pantalla: dónde estaba parado y con qué navegador.
        pantalla: String(req.body?.pantalla || '').slice(0, 200) || null,
        navegador: String(req.headers['user-agent'] || '').slice(0, 200) || null,
      },
    });

    if (!r?.enviado) {
      /*
       * Sin correo configurado no se puede fingir que salió: se devuelve la
       * casilla para que la persona escriba a mano en vez de quedarse
       * esperando una respuesta que nunca se pidió.
       */
      return res.status(503).json({
        message: `No se pudo enviar el reporte desde el sistema. Escribinos a ${CASILLAS.soporte} y lo vemos igual.`,
        soporte: CASILLAS.soporte,
      });
    }

    res.status(201).json({
      ok: true,
      soporte: CASILLAS.soporte,
      mensaje: `Reporte enviado a ${CASILLAS.soporte}. Te respondemos a ${email}.`,
    });
  } catch (e) { next(e); }
};

/*
 * GET /api/soporte/info
 *
 * A dónde escribir, y si el envío desde el sistema está disponible. La
 * pantalla lo usa para no ofrecer un formulario que no va a poder mandar nada.
 */
const info = async (req, res, next) => {
  try {
    const { estado } = require('../config/correo');
    const e = estado();
    res.json({
      soporte: CASILLAS.soporte,
      envioDisponible: e.configurado,
      // Sólo el dueño ve el diagnóstico del correo: a un empleado no le sirve
      // y expone cómo está configurada la cuenta.
      ...(esAdministradorTotal(req.auth) ? { diagnostico: { dominioCoincide: e.dominioCoincide, avisos: e.avisos } } : {}),
    });
  } catch (e) { next(e); }
};

module.exports = { reportar, info, TIPOS };
