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

const DIA_MS = 24 * 60 * 60 * 1000;

/*
 * Cuánto vale el link de pago de una diferencia de plan. La diferencia se
 * calcula con los días que quedan HOY; un link que se paga una semana después
 * cobraría días que ya pasaron con el plan viejo.
 */
const VIGENCIA_LINK_DIFERENCIA_MS = DIA_MS;

const fechaAr = (f) => new Date(f).toLocaleDateString('es-AR');

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
      maxSesiones: p.maxSesiones,
      features: p.features, soporte: p.soporte,
      requiereCotizacion: p.requiereCotizacion,
    })));
  } catch (e) { next(e); }
};

/*
 * El período en curso: desde cuándo y hasta cuándo rige lo que se está usando.
 *
 * `vence` sola dice cuándo termina, pero no qué cubre: quien pagó hace diez días
 * y ve "vence el 30" no sabe si eso es lo que pagó o lo anterior. En la prueba
 * el período es la prueba; con un plan pago, lo último que se acreditó.
 *
 * null si no hay un período que mostrar: un Enterprise facturado por fuera
 * puede estar activo sin fechas, y una cuenta en modo lectura ya no tiene uno
 * en curso (su `vence` ya pasó y la pantalla lo dice con el estado).
 */
function periodoActual({ estado, suscripcion: sub }) {
  const enPrueba = sub.estado === 'trial';
  const desde = enPrueba ? sub.trialInicio : sub.periodoInicio;
  const hasta = enPrueba ? sub.trialFin : sub.periodoFin;
  if (estado === 'lectura' || estado === 'cancelada' || !desde || !hasta) return null;
  return { desde, hasta, tipo: enPrueba ? 'prueba' : 'pago' };
}

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
      periodo: periodoActual(estado),
      plan: estado.plan && {
        codigo: estado.plan.codigo, nombre: estado.plan.nombre,
        features: estado.plan.features, requiereCotizacion: estado.plan.requiereCotizacion,
      },
      // Bajada ya paga que rige al terminar el período del plan actual.
      planPendiente: estado.planPendiente && {
        codigo: estado.planPendiente.codigo, nombre: estado.planPendiente.nombre,
        desde: estado.planPendienteDesde,
      },
      /*
       * El débito automático y su monto: la pantalla tiene que poder decir
       * "tu débito pasa a $X" al cambiar de plan, y no ofrecer dar de alta
       * otro débito encima del que ya cobra.
       */
      debito: planService.debitoActivo(estado.suscripcion)
        ? {
            activo: true,
            monto: estado.suscripcion.debitoMonto != null ? Number(estado.suscripcion.debitoMonto) : null,
            pendienteDesde: estado.suscripcion.debitoPendienteDesde,
          }
        : { activo: false },
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
      // La elección de empleados y la marca de revisión son del backoffice.
      attributes: { exclude: ['empleadosSuspender', 'aRevisar'] },
      // Con el nombre del plan: desde que el pago cambia el plan, "qué pagué"
      // incluye a qué plan corresponde cada cobro.
      include: [{ model: Plan, as: 'plan', attributes: ['codigo', 'nombre'] }],
      order: [['fecha', 'DESC']],
      limit: 50,
    });
    // El link de una diferencia vence (ver crearCheckout): no se ofrece un
    // botón de "Pagar" que lleva a un link vencido.
    const ahora = Date.now();
    res.json(pagos.map((p) => {
      const j = p.toJSON();
      if (j.concepto === 'diferencia' && j.estado === 'pendiente' &&
          ahora - new Date(j.fecha).getTime() > VIGENCIA_LINK_DIFERENCIA_MS) {
        j.linkPago = null;
      }
      return j;
    }));
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
 * Qué plan está pagando el cliente. Devuelve { plan } o { rechazo }.
 *
 * Sin elegir, paga el plan con el que va a SEGUIR: si ya tiene una bajada paga
 * esperando, "renovar" es pagar ese plan y no el caro que está por dejar. Si
 * no, tocar "Pagar o renovar" le cancelaría la bajada sin que lo pidiera.
 *
 * Lo comparte el checkout de Mercado Pago con el aviso de transferencia: los
 * dos dejan una fila con el plan elegido, y esa fila es la que decide qué plan
 * se aplica cuando el pago se acredita.
 */
async function planAPagar({ suscripcion, plan: planActual, planPendiente }, codigo) {
  const continua = planPendiente || planActual;
  let plan = continua;
  if (codigo && codigo !== continua?.codigo) {
    plan = codigo === planActual?.codigo
      ? planActual
      : await Plan.findOne({ where: { codigo, activo: true } });
    if (!plan) return { rechazo: { status: 400, cuerpo: { message: 'Ese plan no existe.' } } };
  }
  if (plan?.requiereCotizacion && suscripcion.precioAcordado == null) {
    return { rechazo: { status: 409, cuerpo: {
      motivo: 'cotizacion',
      message: 'El Plan Enterprise se cotiza según tu operación. Escribinos y armamos la propuesta.',
    } } };
  }
  /*
   * Con un precio cerrado a mano, el cambio de plan lo hace una persona.
   *
   * El precio acordado manda sobre el de CUALQUIER plan (ver precioDe), así que
   * dejarlo pasar era vender el Superior o el Enterprise al precio que se le
   * cerró a este cliente por el Pro. Antes daba igual porque el plan no se
   * aplicaba; ahora que se aplica, sería un agujero.
   */
  if (suscripcion.precioAcordado != null && plan && Number(plan.id) !== Number(planActual?.id)) {
    return { rechazo: { status: 409, cuerpo: {
      motivo: 'precio_acordado',
      message: 'Tu cuenta tiene un precio acordado con nosotros. Para cambiar de plan escribinos y lo ajustamos.',
    } } };
  }
  return { plan };
}

/*
 * Cuánto y por qué se cobra un plan, ANTES de cobrarlo. Devuelve { rechazo } o
 * la cotización: { estado, sub, plan, c, monto, bajaDePlan, vista }.
 *
 * Es una sola cuenta para todo: la pantalla la muestra en el modal de pago
 * (GET /billing/cotizacion), el checkout de Mercado Pago cobra ese monto y la
 * transferencia lo anota. Antes el modal calculaba el precio por su lado (y
 * mostraba el de lista aunque se cobrara con descuento) y la transferencia
 * aceptaba el importe que mandaba el navegador.
 */
async function cotizacionPara(businessId, codigo) {
  const estado = await planService.estadoDe(businessId);
  const sub = estado.suscripcion;
  const { plan, rechazo } = await planAPagar(estado, codigo);
  if (rechazo) return { rechazo };

  const ahora = new Date();
  const c = planService.clasificarCambio({
    sub, actual: estado.plan, pendiente: estado.planPendiente,
    pendienteDesde: estado.planPendienteDesde, nuevo: plan, ahora,
  });
  if (c.tipo === 'cambio_pendiente') {
    return { rechazo: { status: 409, cuerpo: {
      motivo: 'cambio_pendiente',
      message: `Ya tenés programado el paso al ${estado.planPendiente.nombre} desde el ` +
        `${fechaAr(estado.planPendienteDesde)}. Cuando rija vas a poder pasar al ${plan.nombre}. ` +
        `Si preferís quedarte con el ${estado.plan.nombre}, elegí «Seguir con este plan».`,
    } } };
  }

  // precioDe corta con 409 si el plan elegido no tiene precio (se cotiza).
  const precioMensual = precioDe(sub, plan);
  const monto = c.concepto === 'diferencia' ? planService.montoDe(c) : precioMensual;
  if (c.concepto === 'diferencia' && !(monto >= 1)) {
    // Sólo pasa si un operador dejó un plan más alto al mismo precio que otro.
    return { rechazo: { status: 409, cuerpo: {
      motivo: 'sin_diferencia',
      message: 'Este cambio no tiene diferencia para cobrar. Escribinos y lo aplicamos.',
    } } };
  }

  // Al bajar (programado, o ya si no hay período en curso) se avisa cuánto se
  // pasa de cada tope y se elige quiénes siguen (decisión 19).
  const bajaDePlan = c.tipo === 'bajada' ||
    (c.tipo === 'alta' && planService.sentidoDelCambio(estado.plan, plan) === 'baja');
  const excesos = bajaDePlan ? await planService.excesosPara(businessId, plan) : [];
  const empleados = excesos.some((x) => x.recurso === 'empleados')
    ? await planService.empleadosParaElegir(businessId, plan)
    : null;

  const fin = sub.periodoFin ? new Date(sub.periodoFin) : null;
  const masUnPeriodo = (desde) => new Date(new Date(desde).getTime() + planService.DIAS_PERIODO * DIA_MS);
  const venceDespues = {
    alta: masUnPeriodo(ahora),
    renovacion: masUnPeriodo(c.enCurso ? fin : ahora),
    subida: fin,
    seguir: fin,
    bajada: fin && masUnPeriodo(fin),
  }[c.tipo];

  const debitoActivo = planService.debitoActivo(sub);
  const vista = {
    plan: { codigo: plan.codigo, nombre: plan.nombre },
    planActual: estado.plan && { codigo: estado.plan.codigo, nombre: estado.plan.nombre },
    planPendiente: estado.planPendiente && {
      codigo: estado.planPendiente.codigo, nombre: estado.planPendiente.nombre, desde: estado.planPendienteDesde,
    },
    tipo: c.tipo,
    concepto: c.concepto,
    monto,
    // El precio por mes del plan elegido para esta cuenta, con su descuento.
    precioMensual,
    descuentoPct: Number(sub.descuentoPct) || 0,
    detalle: c.concepto === 'diferencia' ? {
      diasPeriodo: planService.DIAS_PERIODO,
      tramos: c.tramos.map((t) => ({
        plan: { codigo: t.plan.codigo, nombre: t.plan.nombre },
        desde: t.desde, hasta: t.hasta, dias: t.dias,
        precioMensual: t.precio,
        importe: Math.round(t.importe * 100) / 100,
      })),
      total: Math.round(c.diferencia * 100) / 100,
    } : null,
    // Desde cuándo rige el plan elegido: ya, al vencimiento, o null si es el
    // mismo con el que la cuenta sigue.
    rige: c.tipo === 'renovacion' ? null : c.tipo === 'bajada' ? fin : ahora,
    venceDespues,
    debito: debitoActivo
      ? { activo: true, montoActual: sub.debitoMonto != null ? Number(sub.debitoMonto) : null, montoNuevo: c.precioNuevo }
      : { activo: false },
    excesos,
    empleados,
    medios: {
      mercadopago: mp.estaConfigurado(),
      // La diferencia se paga una vez; un débito mensual de la diferencia no
      // tiene sentido. Y con un débito andando, otro encima cobraría doble.
      debitoAutomatico: mp.estaConfigurado() && c.concepto === 'periodo' && !debitoActivo,
      transferencia: Boolean(DATOS_TRANSFERENCIA.cbu || DATOS_TRANSFERENCIA.alias),
    },
  };
  return { estado, sub, plan, c, monto, bajaDePlan, vista };
}

/** Lo que dice el renglón del pago, para el cliente y para el backoffice. */
function detalleDelPago({ c, plan, modo }) {
  if (c.tipo === 'seguir') return `Diferencia para seguir con el ${plan.nombre}`;
  if (c.concepto === 'diferencia') {
    const dias = c.tramos.reduce((a, t) => a + t.dias, 0);
    return `Diferencia para pasar al ${plan.nombre} (${dias} día${dias === 1 ? '' : 's'})`;
  }
  return modo === 'recurrente' ? 'Alta de débito automático' : 'Pago de un período';
}

// GET /api/billing/cotizacion?plan=pro — lo que se cobraría, antes de cobrar.
const getCotizacion = async (req, res, next) => {
  try {
    const q = await cotizacionPara(req.auth.businessId, req.query?.plan);
    if (q.rechazo) return res.status(q.rechazo.status).json(q.rechazo.cuerpo);
    res.json(q.vista);
  } catch (e) { next(e); }
};

/*
 * POST /api/billing/checkout  { plan?, modo?, conservar? }
 *
 * Devuelve a dónde mandar al cliente a pagar. `modo`:
 *   unico      → link de pago (default)
 *   recurrente → débito automático mensual
 * `conservar`: al bajar a un plan con menos usuarios, los empleados que siguen.
 *
 * Cobra exactamente la cotización: el plan entero o, al subir con un período
 * pago corriendo, sólo la diferencia por los días que quedan (decisión 18).
 */
const crearCheckout = async (req, res, next) => {
  try {
    const q = await cotizacionPara(req.auth.businessId, req.body?.plan);
    if (q.rechazo) return res.status(q.rechazo.status).json(q.rechazo.cuerpo);
    const { sub, plan, c, monto } = q;
    const modo = req.body?.modo === 'recurrente' ? 'recurrente' : 'unico';

    if (modo === 'recurrente' && c.concepto === 'diferencia') {
      return res.status(409).json({
        motivo: 'diferencia_unica',
        message: 'La diferencia se paga una sola vez. Si tenés débito automático, pasa solo al precio del plan nuevo.',
      });
    }
    const eleccion = await planService.eleccionDeEmpleados(
      req.auth.businessId, plan, q.bajaDePlan ? req.body?.conservar : null,
    );
    if (eleccion.error) return res.status(400).json({ message: eleccion.error });

    const negocio = await Business.findByPk(req.auth.businessId, { attributes: ['email'] });

    let creado;
    if (modo === 'recurrente') {
      /*
       * Un débito nuevo reemplaza al anterior. Antes se daba de alta otro
       * encima y el viejo seguía cobrando: dos débitos por mes. Si Mercado
       * Pago no deja cancelar el anterior, no se crea el nuevo.
       */
      if (sub.metodoPago === 'mercadopago' && sub.proveedorRef) {
        await mp.cancelarSuscripcionRecurrente(sub.proveedorRef);
        await sub.update({ proveedorRef: null, debitoMonto: null, debitoPendienteDesde: null });
      }
      creado = await mp.crearSuscripcionRecurrente({
        businessId: req.auth.businessId, subscriptionId: sub.id,
        plan, monto, emailPagador: negocio.email,
      });
    } else {
      creado = await mp.crearLinkDePago({
        businessId: req.auth.businessId, subscriptionId: sub.id,
        plan, monto,
        descripcion: c.concepto === 'diferencia' ? `Stocker — ${detalleDelPago({ c, plan, modo })}` : undefined,
        // La diferencia vale por los días que quedan HOY: el link vence en un
        // día, y nunca después del período que viene a completar.
        venceEn: c.concepto === 'diferencia'
          ? new Date(Math.min(new Date(sub.periodoFin).getTime(), Date.now() + VIGENCIA_LINK_DIFERENCIA_MS))
          : null,
      });
    }

    // Queda pendiente hasta que MP confirme. El webhook la busca por esta fila,
    // y de acá salen el plan, el concepto y la elección que se aplican al
    // acreditar.
    await SubscriptionPayment.create({
      businessId: req.auth.businessId,
      subscriptionId: sub.id,
      planId: plan.id,
      monto, montoCotizado: monto, concepto: c.concepto,
      empleadosSuspender: planService.guardarLista(eleccion.suspender),
      estado: 'pendiente', metodo: 'mercadopago',
      linkPago: creado.initPoint,
      detalle: detalleDelPago({ c, plan, modo }),
    });

    if (modo === 'recurrente') {
      await sub.update({
        metodoPago: 'mercadopago', proveedorRef: creado.id,
        // Lo que el débito nuevo tiene cargado: el precio del plan que se paga.
        debitoMonto: monto, debitoPendienteDesde: null,
      });
    }

    res.status(201).json({ url: creado.initPoint, modo, monto, concepto: c.concepto });
  } catch (e) { next(e); }
};

/*
 * POST /api/billing/transferencia  { plan?, conservar?, comprobanteUrl?, detalle? }
 *
 * El cliente avisa que transfirió. NO acredita: deja el pago pendiente para
 * que alguien lo verifique contra el extracto bancario desde el backoffice.
 *
 * Lleva el plan elegido igual que el checkout, y el importe lo pone Stocker
 * con la misma cotización. Antes se aceptaba el `monto` que mandaba el
 * navegador: {plan:'superior', monto: 48400} dejaba una fila del Superior al
 * precio del Inicial, el operador veía que llegaron 48.400 y acreditaba. Lo que
 * entró de verdad se compara al acreditar (backoffice aprobarPago).
 */
const informarTransferencia = async (req, res, next) => {
  try {
    const q = await cotizacionPara(req.auth.businessId, req.body?.plan);
    if (q.rechazo) return res.status(q.rechazo.status).json(q.rechazo.cuerpo);
    const { sub, plan, c, monto } = q;

    const eleccion = await planService.eleccionDeEmpleados(
      req.auth.businessId, plan, q.bajaDePlan ? req.body?.conservar : null,
    );
    if (eleccion.error) return res.status(400).json({ message: eleccion.error });

    const pago = await SubscriptionPayment.create({
      businessId: req.auth.businessId,
      subscriptionId: sub.id,
      planId: plan.id,
      monto, montoCotizado: monto, concepto: c.concepto,
      empleadosSuspender: planService.guardarLista(eleccion.suspender),
      estado: 'pendiente', metodo: 'transferencia',
      comprobanteUrl: req.body?.comprobanteUrl || null,
      detalle: String(req.body?.detalle || '').slice(0, 500) || detalleDelPago({ c, plan, modo: 'unico' }),
    });
    // Con un débito automático andando, una transferencia suelta (la
    // diferencia de una subida) no cambia cómo se cobra todos los meses: si se
    // pisara el método, el débito dejaría de seguir al plan.
    if (!planService.debitoActivo(sub)) await sub.update({ metodoPago: 'transferencia' });

    res.status(201).json({
      pago: { id: pago.id, monto, concepto: c.concepto, plan: plan.codigo, estado: pago.estado },
      monto,
      datosTransferencia: DATOS_TRANSFERENCIA,
      message: 'Recibimos el aviso. Apenas confirmemos la transferencia se activa la cuenta.',
    });
  } catch (e) { next(e); }
};

// GET /api/billing/transferencia — a qué cuenta transferir
const getDatosTransferencia = async (_req, res) => res.json(DATOS_TRANSFERENCIA);

/*
 * La fila del checkout que corresponde a un cobro de Mercado Pago, o null.
 *
 * Se reconoce por el IMPORTE: Mercado Pago cobra exactamente lo que se le pidió
 * en la preferencia, y es lo único que la fila y el cobro tienen en común. Antes
 * se tomaba la pendiente más nueva, fuera cual fuera: con un link del Superior y
 * otro del Pro abiertos, pagar el del Superior acreditaba el Pro. Un cobro que
 * no coincide con ninguna (un débito automático del mes) no trae pedido de
 * cambio de plan, y así se lo trata.
 */
async function filaDelCobro(sub, pagoMp, t) {
  const pendientes = await SubscriptionPayment.findAll({
    where: { subscriptionId: sub.id, estado: 'pendiente', metodo: 'mercadopago' },
    order: [['fecha', 'DESC'], ['id', 'DESC']],
    transaction: t,
  });
  return pendientes.find((f) => Math.abs(Number(f.monto) - Number(pagoMp.monto)) < 0.01) || null;
}

/*
 * Acredita un cobro aprobado de Mercado Pago. Devuelve el período, o null si ya
 * estaba acreditado.
 *
 * Es el camino del webhook y el de "Ya pagué", que antes eran dos copias que no
 * decían lo mismo: el webhook creaba una fila nueva con el plan VIEJO de la
 * suscripción y dejaba la del checkout pendiente para siempre. El plan sale de
 * la fila que dejó el checkout —lo que el dueño eligió y lo que se le cobró—,
 * nunca de Mercado Pago ni del navegador.
 *
 * La suscripción se traba ANTES de mirar si el cobro ya está: el webhook y
 * "Ya pagué" pueden llegar a la vez con el mismo cobro, y los dos veían "no
 * está" y los dos acreditaban. Trabada, el segundo espera y ve el primero.
 */
async function acreditarCobroMp(subscriptionId, pagoMp, t) {
  const sub = await planService.trabarSuscripcion(subscriptionId, t);

  const yaEsta = await SubscriptionPayment.findOne({
    where: { proveedorRef: pagoMp.id }, transaction: t,
  });
  if (yaEsta?.estado === 'aprobado') return null;

  const fila = yaEsta || await filaDelCobro(sub, pagoMp, t);
  // Con la fila: el plan, lo que se cotizó (plan entero o diferencia) y la
  // elección de empleados, y lo que cobró Mercado Pago, que es lo que entró.
  const periodo = await planService.acreditarPago({
    subscription: sub,
    planId: fila ? fila.planId : null,
    concepto: fila?.concepto || null,
    monto: fila ? pagoMp.monto : null,
    empleadosSuspender: fila ? (planService.leerLista(fila.empleadosSuspender) ?? undefined) : undefined,
  }, t);

  let revisar = periodo.revisar;
  if (!fila) {
    /*
     * Un cobro sin pedido: el débito automático del mes. Renueva el plan con el
     * que la cuenta sigue y su monto tiene que ser el de ese plan, porque
     * Stocker se lo pone en cada cambio (decisión 20). Si no coincide —Mercado
     * Pago no aceptó la actualización, o el débito es de antes de esto— se
     * acredita igual (la plata ya entró), queda marcado para el backoffice y
     * se fuerza a mandarle el monto de nuevo.
     */
    const planDelPeriodo = await Plan.findByPk(periodo.planDelPeriodo, { transaction: t });
    const esperado = planService.precioPara(sub, planDelPeriodo);
    if (esperado != null && Math.abs(Number(pagoMp.monto) - esperado) >= planService.TOLERANCIA) {
      revisar = `Mercado Pago cobró $${Number(pagoMp.monto).toLocaleString('es-AR')} sin un pedido que ` +
        `coincida y el ${planDelPeriodo?.nombre || 'plan'} sale $${esperado.toLocaleString('es-AR')}: ` +
        'se acreditó un período igual.';
      if (planService.debitoActivo(sub)) {
        await Subscription.update({ debitoPendienteDesde: new Date() }, { where: { id: sub.id }, transaction: t });
        t.afterCommit(() => { planService.programarSincronizacion(sub.id); });
      }
    }
  }

  const datos = {
    estado: 'aprobado', proveedorRef: pagoMp.id, monto: pagoMp.monto,
    periodoDesde: periodo.desde, periodoHasta: periodo.hasta,
    fecha: pagoMp.fecha ? new Date(pagoMp.fecha) : new Date(),
    aRevisar: revisar ? revisar.slice(0, 300) : null,
  };
  if (fila) {
    await fila.update(datos, { transaction: t });
  } else {
    await SubscriptionPayment.create({
      businessId: sub.businessId, subscriptionId: sub.id,
      planId: periodo.planDelPeriodo, metodo: 'mercadopago', ...datos,
    }, { transaction: t });
  }
  return periodo;
}

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

    const businessId = pago.referencia?.businessId;
    const sub = businessId
      ? await Subscription.findOne({ where: { businessId }, transaction: t })
      : null;
    if (!sub) {
      log.warn('billing', 'pago de Mercado Pago sin cuenta asociada', { pago: pago.id });
      await t.rollback();
      return;
    }

    // Idempotencia: MP reenvía el mismo aviso varias veces por diseño.
    const periodo = await acreditarCobroMp(sub.id, pago, t);
    if (!periodo) { await t.rollback(); return; }

    await t.commit();
    log.info('billing', 'suscripción acreditada por Mercado Pago', { businessId: sub.businessId });
  } catch (e) {
    await t.rollback().catch(() => {});
    log.error('billing', 'no se pudo procesar el webhook de Mercado Pago', { error: e.message });
  }
};

/*
 * Cómo quedó el plan después de acreditar, en palabras para la pantalla.
 * Sin esto el cliente que pagó un cambio no sabe si se aplicó.
 */
function fraseDelPlan({ plan, planPendiente, planPendienteDesde }) {
  if (planPendiente) {
    return ` Seguís con el ${plan?.nombre || 'plan actual'} hasta el ` +
      `${new Date(planPendienteDesde).toLocaleDateString('es-AR')} y desde ahí pasás al ${planPendiente.nombre}.`;
  }
  return plan?.nombre ? ` Tu plan es el ${plan.nombre}.` : '';
}

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
    /*
     * Del más viejo al más nuevo. Mercado Pago los devuelve al revés, y con
     * dos cobros sin acreditar (un Superior y después un Pro) el orden decide
     * con qué plan queda la cuenta: tiene que ganar el último que pagó.
     */
    const aprobados = pagos
      .filter((p) => p.estado === 'approved')
      .sort((a, b) => new Date(a.fecha || 0) - new Date(b.fecha || 0));

    let acreditados = 0;
    let hasta = null;

    for (const pago of aprobados) {
      const periodo = await acreditarCobroMp(suscripcion.id, pago, t);
      if (!periodo) continue;
      hasta = periodo.hasta;
      acreditados++;
    }

    await t.commit();

    if (acreditados > 0) {
      log.info('billing', 'pago acreditado al verificar a mano', { businessId: req.auth.businessId, acreditados });
      const despues = await planService.estadoDe(req.auth.businessId);
      return res.json({
        acreditados,
        vence: hasta,
        message: `Listo, encontramos el pago. Tu cuenta queda activa hasta el ${new Date(hasta).toLocaleDateString('es-AR')}.` +
          fraseDelPlan(despues),
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
    let debitoCancelado = false;
    if (!activa && suscripcion.metodoPago === 'mercadopago' && suscripcion.proveedorRef) {
      debitoCancelado = await mp.cancelarSuscripcionRecurrente(suscripcion.proveedorRef)
        .then(() => true)
        .catch((e) => { log.warn('billing', 'no se pudo cancelar el débito en Mercado Pago', { error: e.message }); return false; });
    }

    await suscripcion.update({
      renovacionAutomatica: activa,
      canceladaEn: activa ? null : new Date(),
      // Cancelado allá, ya no hay débito que seguir: sin esto, reactivar la
      // renovación haría que Stocker le mande montos a un débito cancelado.
      ...(debitoCancelado ? { proveedorRef: null, debitoMonto: null, debitoPendienteDesde: null } : {}),
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
  getPlanes, getFeatures, getSuscripcion, getPagos, getCotizacion, crearCheckout,
  informarTransferencia, getDatosTransferencia, webhookMercadoPago,
  cambiarRenovacion, solicitarBaja, cancelarBaja, descargarRecibo, verificarPagos,
};
