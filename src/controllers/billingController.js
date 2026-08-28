const sequelize = require('../config/database');
const { Plan, Subscription, SubscriptionPayment, Business, PlatformSetting } = require('../models');
const planService = require('../services/planService');
const mp = require('../services/mercadopagoService');
const { log } = require('../utils/logger');
const { sendAccountDeletionRequest } = require('../services/emailService');
const { generateSubscriptionReceiptPdf } = require('../services/pdfService');

/*
 * Suscripción del negocio a Stocker.
 *
 * Dos caminos de cobro, porque en Argentina conviven:
 *   · Mercado Pago  → link de pago o débito mensual. Se acredita solo.
 *   · Transferencia → el cliente transfiere y sube el comprobante. Lo aprueba
 *                     una persona desde el backoffice: una transferencia no
 *                     se acredita sola por más que el cliente diga que pagó.
 *
 * Nada de acá borra datos. Cuando la cuenta cae a lectura sigue todo cargado.
 */

const DATOS_TRANSFERENCIA = {
  titular: process.env.BANCO_TITULAR || 'Stocker',
  cbu:     process.env.BANCO_CBU     || null,
  alias:   process.env.BANCO_ALIAS   || null,
  cuit:    process.env.BANCO_CUIT    || null,
};

// GET /api/billing/planes — catálogo público para la pantalla de planes
/*
 * GET /api/billing/features
 *
 * El catálogo de funciones: qué existe, cómo se llama y para qué sirve.
 *
 * Va aparte de los planes y es público porque lo consumen dos pantallas
 * distintas —la de suscripción del cliente y la de planes del backoffice— y
 * las dos lo tenían escrito a mano. Cuando entraron Eventos, Depósito y
 * Reposición, ninguna de las dos se enteró: el backoffice mostraba nueve
 * funciones de doce y no había forma de tildar las que faltaban.
 */
const getFeatures = async (_req, res, next) => {
  try {
    const { CATALOGO_FEATURES } = require('../config/planes');
    res.json(CATALOGO_FEATURES);
  } catch (e) { next(e); }
};

const getPlanes = async (_req, res, next) => {
  try {
    const planes = await Plan.findAll({ where: { activo: true }, order: [['orden', 'ASC']] });
    res.json(planes.map((p) => ({
      codigo: p.codigo, nombre: p.nombre, descripcion: p.descripcion,
      precioMensual: p.precioMensual != null ? Number(p.precioMensual) : null,
      moneda: p.moneda, maxCuits: p.maxCuits, maxEmpleados: p.maxEmpleados,
      maxLocales: p.maxLocales, maxSkus: p.maxSkus, maxComprobantes: p.maxComprobantes,
      features: p.features, soporte: p.soporte,
      requiereCotizacion: p.requiereCotizacion,
    })));
  } catch (e) { next(e); }
};

// GET /api/billing/suscripcion — estado, uso y topes de la cuenta
const getSuscripcion = async (req, res, next) => {
  try {
    const [estado, uso] = await Promise.all([
      planService.estadoDe(req.auth.businessId),
      planService.usoDe(req.auth.businessId),
    ]);

    res.json({
      estado: estado.estado,
      soloLectura: estado.soloLectura,
      vence: estado.vence,
      diasRestantes: estado.diasRestantes,
      precio: estado.precio,
      precioLista: estado.precioLista,
      descuentoPct: estado.descuentoPct,
      descuentoNota: estado.suscripcion.descuentoNota,
      renovacionAutomatica: estado.renovacionAutomatica,
      bajaSolicitadaEn: estado.bajaSolicitadaEn,
      metodoPago: estado.suscripcion.metodoPago,
      proximoCobroEn: estado.suscripcion.proximoCobroEn,
      ultimoPagoEn: estado.suscripcion.ultimoPagoEn,
      plan: estado.plan && {
        codigo: estado.plan.codigo, nombre: estado.plan.nombre,
        features: estado.plan.features, requiereCotizacion: estado.plan.requiereCotizacion,
      },
      uso,
      // Para que la pantalla sepa qué formas de pago ofrecer.
      mediosDisponibles: {
        mercadopago: mp.estaConfigurado(),
        transferencia: Boolean(DATOS_TRANSFERENCIA.cbu || DATOS_TRANSFERENCIA.alias),
      },
      /*
       * Si quedó un cobro de Mercado Pago sin confirmar, la pantalla ofrece el
       * botón de verificar en vez de esperar un webhook que puede no llegar.
       *
       * Sólo de Mercado Pago: una transferencia pendiente no se puede consultar
       * en ningún lado, la confirma una persona contra el banco. Ofrecer
       * "verificar" ahí sería un botón que nunca puede funcionar.
       */
      pagoPendiente: await SubscriptionPayment.count({
        where: { businessId: req.auth.businessId, estado: 'pendiente', metodo: 'mercadopago' },
      }) > 0,
    });
  } catch (e) { next(e); }
};

// GET /api/billing/pagos — historial de cobros de la cuenta
const getPagos = async (req, res, next) => {
  try {
    const pagos = await SubscriptionPayment.findAll({
      where: { businessId: req.auth.businessId },
      order: [['fecha', 'DESC']],
      limit: 50,
    });
    res.json(pagos);
  } catch (e) { next(e); }
};

/** Precio a cobrar: el acordado gana sobre el de lista, y el descuento va encima. */
function precioDe(sub, plan) {
  const { precio } = planService.precioDeSuscripcion({
    precioAcordado: sub.precioAcordado,
    descuentoPct: sub.descuentoPct,
    plan,
  });
  if (precio == null || precio <= 0) {
    throw Object.assign(
      new Error('Este plan se cotiza a medida. Escribinos y te pasamos el precio para tu operación.'),
      { status: 409 }
    );
  }
  return precio;
}

/*
 * POST /api/billing/checkout  { plan?, modo? }
 *
 * Devuelve a dónde mandar al cliente a pagar. `modo`:
 *   unico      → link por un mes (default)
 *   recurrente → débito automático mensual
 */
const crearCheckout = async (req, res, next) => {
  try {
    const { suscripcion, plan: planActual } = await planService.estadoDe(req.auth.businessId);

    // Permite pagar directamente el plan al que se quiere pasar.
    let plan = planActual;
    if (req.body?.plan && req.body.plan !== planActual?.codigo) {
      plan = await Plan.findOne({ where: { codigo: req.body.plan, activo: true } });
      if (!plan) return res.status(400).json({ message: 'Ese plan no existe.' });
    }
    if (plan?.requiereCotizacion && suscripcion.precioAcordado == null) {
      return res.status(409).json({
        motivo: 'cotizacion',
        message: 'El Plan Enterprise se cotiza según tu operación. Escribinos y armamos la propuesta.',
      });
    }

    const monto = precioDe(suscripcion, plan);
    const negocio = await Business.findByPk(req.auth.businessId, { attributes: ['email'] });
    const modo = req.body?.modo === 'recurrente' ? 'recurrente' : 'unico';

    const creado = modo === 'recurrente'
      ? await mp.crearSuscripcionRecurrente({
          businessId: req.auth.businessId, subscriptionId: suscripcion.id,
          plan, monto, emailPagador: negocio.email,
        })
      : await mp.crearLinkDePago({
          businessId: req.auth.businessId, subscriptionId: suscripcion.id,
          plan, monto,
        });

    // Queda pendiente hasta que MP confirme. El webhook la busca por esta fila.
    await SubscriptionPayment.create({
      businessId: req.auth.businessId,
      subscriptionId: suscripcion.id,
      planId: plan.id,
      monto, estado: 'pendiente', metodo: 'mercadopago',
      linkPago: creado.initPoint,
      detalle: modo === 'recurrente' ? 'Alta de débito automático' : 'Pago de un período',
    });

    if (modo === 'recurrente') {
      await suscripcion.update({ metodoPago: 'mercadopago', proveedorRef: creado.id });
    }

    res.status(201).json({ url: creado.initPoint, modo, monto });
  } catch (e) { next(e); }
};

/*
 * POST /api/billing/transferencia  { comprobanteUrl?, detalle? }
 *
 * El cliente avisa que transfirió. NO acredita: deja el pago pendiente para
 * que alguien lo verifique contra el extracto bancario desde el backoffice.
 */
const informarTransferencia = async (req, res, next) => {
  try {
    const { suscripcion, plan } = await planService.estadoDe(req.auth.businessId);
    const monto = req.body?.monto != null ? Number(req.body.monto) : precioDe(suscripcion, plan);

    const pago = await SubscriptionPayment.create({
      businessId: req.auth.businessId,
      subscriptionId: suscripcion.id,
      planId: plan?.id || null,
      monto, estado: 'pendiente', metodo: 'transferencia',
      comprobanteUrl: req.body?.comprobanteUrl || null,
      detalle: req.body?.detalle || null,
    });
    await suscripcion.update({ metodoPago: 'transferencia' });

    res.status(201).json({
      pago,
      datosTransferencia: DATOS_TRANSFERENCIA,
      message: 'Recibimos el aviso. Apenas confirmemos la transferencia se activa la cuenta.',
    });
  } catch (e) { next(e); }
};

// GET /api/billing/transferencia — a qué cuenta transferir
const getDatosTransferencia = async (_req, res) => res.json(DATOS_TRANSFERENCIA);

/*
 * POST /api/billing/webhook/mercadopago
 *
 * Público a la fuerza: lo llama Mercado Pago. Por eso nunca se cree lo que
 * dice el cuerpo — se valida la firma y después se consulta el pago a la API
 * de MP. El aviso sólo sirve como "andá a fijarte", no como "cobrá".
 */
const webhookMercadoPago = async (req, res) => {
  // Se responde 200 enseguida y siempre: si MP no recibe el OK reintenta, y un
  // error nuestro terminaría en una cola de reintentos creciente.
  res.status(200).json({ recibido: true });

  const t = await sequelize.transaction();
  try {
    const dataId = req.body?.data?.id || req.query?.['data.id'];
    const tipo   = req.body?.type || req.query?.type;
    if (!dataId || (tipo && tipo !== 'payment')) { await t.rollback(); return; }

    const firma = mp.firmaValida({
      signature: req.headers['x-signature'],
      requestId: req.headers['x-request-id'],
      dataId,
    });
    if (firma === false) {
      log.warn('billing', 'webhook de Mercado Pago con firma inválida, se descarta');
      await t.rollback();
      return;
    }
    if (firma === null) {
      log.warn('billing', 'MP_WEBHOOK_SECRET sin configurar: el webhook no se puede verificar');
    }

    const pago = await mp.consultarPago(dataId);
    if (pago.estado !== 'approved') { await t.rollback(); return; }

    // Idempotencia: MP reenvía el mismo aviso varias veces por diseño.
    const yaEsta = await SubscriptionPayment.findOne({
      where: { proveedorRef: pago.id }, transaction: t,
    });
    if (yaEsta && yaEsta.estado === 'aprobado') { await t.rollback(); return; }

    const businessId = pago.referencia?.businessId;
    const sub = businessId
      ? await Subscription.findOne({ where: { businessId }, transaction: t })
      : null;
    if (!sub) {
      log.warn('billing', 'pago de Mercado Pago sin cuenta asociada', { pago: pago.id });
      await t.rollback();
      return;
    }

    const { desde, hasta } = await planService.acreditarPago({ subscription: sub }, t);

    if (yaEsta) {
      await yaEsta.update({
        estado: 'aprobado', periodoDesde: desde, periodoHasta: hasta, fecha: new Date(),
      }, { transaction: t });
    } else {
      await SubscriptionPayment.create({
        businessId: sub.businessId, subscriptionId: sub.id, planId: sub.planId,
        monto: pago.monto, estado: 'aprobado', metodo: 'mercadopago',
        proveedorRef: pago.id, periodoDesde: desde, periodoHasta: hasta,
      }, { transaction: t });
    }

    await t.commit();
    log.info('billing', 'suscripción acreditada por Mercado Pago', { businessId: sub.businessId });
  } catch (e) {
    await t.rollback().catch(() => {});
    log.error('billing', 'no se pudo procesar el webhook de Mercado Pago', { error: e.message });
  }
};

/*
 * POST /api/billing/verificar
 *
 * "Ya pagué": consulta a Mercado Pago los pagos de esta suscripción y acredita
 * los aprobados que todavía no estaban registrados.
 *
 * Es la red de contención del webhook, y el único camino que funciona en
 * desarrollo: Mercado Pago no puede avisar a localhost. Sin esto, la plata
 * quedaba cobrada y la cuenta sin activar, con el cliente mirando una pantalla
 * que le seguía pidiendo pagar.
 *
 * Idempotente: `proveedorRef` es único, así que un pago ya acreditado no se
 * cuenta dos veces por más veces que se toque el botón.
 */
const verificarPagos = async (req, res, next) => {
  if (!mp.estaConfigurado()) {
    return res.status(503).json({ message: 'Mercado Pago no está configurado en este entorno.' });
  }

  const t = await sequelize.transaction();
  try {
    const { suscripcion } = await planService.estadoDe(req.auth.businessId);

    const pagos = await mp.buscarPagosDe({
      businessId: req.auth.businessId,
      subscriptionId: suscripcion.id,
    });
    const aprobados = pagos.filter((p) => p.estado === 'approved');

    let acreditados = 0;
    let hasta = null;

    for (const pago of aprobados) {
      const yaEsta = await SubscriptionPayment.findOne({
        where: { proveedorRef: pago.id }, transaction: t,
      });
      if (yaEsta?.estado === 'aprobado') continue;

      const periodo = await planService.acreditarPago({ subscription: suscripcion }, t);
      hasta = periodo.hasta;

      if (yaEsta) {
        await yaEsta.update({
          estado: 'aprobado', periodoDesde: periodo.desde, periodoHasta: periodo.hasta,
        }, { transaction: t });
      } else {
        /*
         * Se reutiliza la fila pendiente que dejó el checkout en vez de crear
         * otra: si no, quedaría una pendiente para siempre al lado de la
         * aprobada, y el cliente vería dos cobros por un pago.
         */
        const pendiente = await SubscriptionPayment.findOne({
          where: { subscriptionId: suscripcion.id, estado: 'pendiente', metodo: 'mercadopago' },
          order: [['fecha', 'DESC']],
          transaction: t,
        });

        if (pendiente) {
          await pendiente.update({
            estado: 'aprobado', proveedorRef: pago.id, monto: pago.monto,
            periodoDesde: periodo.desde, periodoHasta: periodo.hasta, fecha: pago.fecha || new Date(),
          }, { transaction: t });
        } else {
          await SubscriptionPayment.create({
            businessId: req.auth.businessId,
            subscriptionId: suscripcion.id,
            planId: suscripcion.planId,
            monto: pago.monto, estado: 'aprobado', metodo: 'mercadopago',
            proveedorRef: pago.id,
            periodoDesde: periodo.desde, periodoHasta: periodo.hasta,
            fecha: pago.fecha || new Date(),
          }, { transaction: t });
        }
      }
      acreditados++;
    }

    await t.commit();

    if (acreditados > 0) {
      log.info('billing', 'pago acreditado al verificar a mano', { businessId: req.auth.businessId, acreditados });
      return res.json({
        acreditados,
        vence: hasta,
        message: `Listo, encontramos el pago. Tu cuenta queda activa hasta el ${new Date(hasta).toLocaleDateString('es-AR')}.`,
      });
    }

    const pendientesEnMp = pagos.filter((p) => p.estado === 'pending' || p.estado === 'in_process').length;
    res.json({
      acreditados: 0,
      message: pendientesEnMp
        ? 'Mercado Pago todavía está procesando el pago. Probá de nuevo en unos minutos.'
        : 'Todavía no nos figura ningún pago aprobado. Si acabás de pagar, esperá un momento y volvé a probar.',
    });
  } catch (e) { await t.rollback().catch(() => {}); next(e); }
};

/*
 * POST /api/billing/renovacion  { activa: boolean }
 *
 * Cancelar la suscripción es apagar la renovación, no cortar el servicio: la
 * cuenta sigue operando hasta que termine el período ya pagado. Cobrar un mes
 * y sacarlo el mismo día sería quedarse con plata por un servicio no prestado.
 */
const cambiarRenovacion = async (req, res, next) => {
  try {
    const activa = req.body?.activa !== false;
    const { suscripcion, vence } = await planService.estadoDe(req.auth.businessId);

    // Si había débito automático en Mercado Pago hay que darlo de baja allá
    // también, o el cobro sigue llegando aunque acá figure cancelado.
    if (!activa && suscripcion.metodoPago === 'mercadopago' && suscripcion.proveedorRef) {
      await mp.cancelarSuscripcionRecurrente(suscripcion.proveedorRef)
        .catch((e) => log.warn('billing', 'no se pudo cancelar el débito en Mercado Pago', { error: e.message }));
    }

    await suscripcion.update({
      renovacionAutomatica: activa,
      canceladaEn: activa ? null : new Date(),
    });

    res.json({
      renovacionAutomatica: activa,
      vence,
      message: activa
        ? 'La suscripción vuelve a renovarse automáticamente.'
        : vence
          ? `Listo. Podés seguir usando Stocker hasta el ${new Date(vence).toLocaleDateString('es-AR')}; después no se cobra de nuevo.`
          : 'Listo, no se va a renovar. Podés reactivarla cuando quieras.',
    });
  } catch (e) { next(e); }
};

/*
 * POST /api/billing/baja  { motivo? }
 *
 * Solicitud de baja de cuenta. No borra nada: deja el pedido registrado y
 * avisa por mail para que una persona lo procese. Un borrado automático de
 * todo el historial de facturación de un negocio, disparado por un clic, es
 * un daño que no se deshace.
 */
const solicitarBaja = async (req, res, next) => {
  try {
    const { suscripcion, plan } = await planService.estadoDe(req.auth.businessId);
    const negocio = await Business.findByPk(req.auth.businessId);
    const motivo = String(req.body?.motivo || '').slice(0, 500) || null;

    await suscripcion.update({ bajaSolicitadaEn: new Date(), bajaMotivo: motivo });

    await sendAccountDeletionRequest({ negocio: negocio.toJSON(), plan: plan?.nombre || null, motivo })
      .catch((e) => log.error('billing', 'no se pudo avisar la baja por mail', { error: e.message }));

    res.status(201).json({
      solicitadaEn: suscripcion.bajaSolicitadaEn,
      message: 'Recibimos tu pedido de baja. Te vamos a escribir para confirmarlo antes de borrar nada. ' +
               'Mientras tanto la cuenta sigue funcionando y podés exportar tus datos.',
    });
  } catch (e) { next(e); }
};

/** DELETE /api/billing/baja — se arrepintió */
const cancelarBaja = async (req, res, next) => {
  try {
    const { suscripcion } = await planService.estadoDe(req.auth.businessId);
    await suscripcion.update({ bajaSolicitadaEn: null, bajaMotivo: null });
    res.json({ message: 'Cancelamos el pedido de baja. Tu cuenta sigue como estaba.' });
  } catch (e) { next(e); }
};

/*
 * GET /api/billing/pagos/:id/recibo — comprobante en PDF
 *
 * No es una factura: Stocker factura aparte por ARCA. Es el comprobante del
 * cobro, que es lo que el cliente necesita para su propia contabilidad.
 */
const descargarRecibo = async (req, res, next) => {
  try {
    const pago = await SubscriptionPayment.findOne({
      where: { id: req.params.id, businessId: req.auth.businessId },
      include: [{ model: Plan, as: 'plan' }],
    });
    if (!pago) return res.status(404).json({ message: 'No encontramos ese pago.' });
    if (pago.estado !== 'aprobado') {
      return res.status(409).json({ message: 'Ese pago todavía no está acreditado, así que no tiene comprobante.' });
    }

    const negocio = await Business.findByPk(req.auth.businessId);
    const ruta = await generateSubscriptionReceiptPdf(pago.toJSON(), negocio.toJSON(), pago.plan?.toJSON() || null);
    res.download(require('path').resolve(ruta), `recibo-stocker-${pago.id}.pdf`);
  } catch (e) { next(e); }
};

module.exports = {
  getPlanes, getFeatures, getSuscripcion, getPagos, crearCheckout,
  informarTransferencia, getDatosTransferencia, webhookMercadoPago,
  cambiarRenovacion, solicitarBaja, cancelarBaja, descargarRecibo, verificarPagos,
};
