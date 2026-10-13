const { Op, TableHints } = require('sequelize');
const db = require('../config/database');
const { Plan, Subscription, Business, Employee, BusinessCuit, BusinessLocation, Product, ProductVariant, Invoice } = require('../models');
const { PLANES, PLAN_POR_DEFECTO, DIAS_TRIAL, DIAS_GRACIA } = require('../config/planes');
const { log } = require('../utils/logger');

/*
 * Planes y suscripciones.
 *
 * Una regla que atraviesa todo el archivo: quedarse sin pagar NUNCA borra ni
 * esconde datos. La cuenta cae a modo lectura — se ve todo, no se puede
 * facturar, vender ni sincronizar. El día que paga vuelve a operar con lo que
 * ya tenía cargado.
 *
 * El estado se calcula contra el reloj cada vez que se consulta, en lugar de
 * depender de una tarea programada: si el cron falla o el servicio estuvo
 * caído, una cuenta vencida seguiría operando gratis.
 */

const diasDesde = (fecha, dias) => new Date(new Date(fecha).getTime() + dias * 24 * 60 * 60 * 1000);

class ErrorPlan extends Error {
  constructor(mensaje, status = 402, extra = {}) {
    super(mensaje);
    this.status = status;   // 402 Payment Required
    Object.assign(this, extra);
  }
}

/*
 * Copia el catálogo de config/planes.js a la base. Idempotente.
 *
 * Los planes que todavía nadie editó desde el backoffice se sincronizan con el
 * código: así, sumar una función a un plan o corregir un tope llega a las
 * cuentas existentes sin tocar la base a mano.
 *
 * En cuanto un operador edita un plan (`editadoEn`), el código deja de
 * pisarlo. Sería inaceptable que un deploy revirtiera un precio que alguien
 * cambió a propósito.
 */
async function sembrarPlanes() {
  let creados = 0, actualizados = 0;

  for (const p of PLANES) {
    const [fila, nuevo] = await Plan.findOrCreate({
      where: { codigo: p.codigo },
      defaults: { ...p, features: JSON.stringify(p.features) },
    });
    if (nuevo) { creados++; continue; }
    if (fila.editadoEn) continue;          // lo tocó una persona: se respeta

    const iguales =
      Number(fila.precioMensual ?? -1) === Number(p.precioMensual ?? -1) &&
      fila.maxCuits === (p.maxCuits ?? null) &&
      fila.maxEmpleados === (p.maxEmpleados ?? null) &&
      fila.maxLocales === (p.maxLocales ?? null) &&
      fila.maxSkus === (p.maxSkus ?? null) &&
      fila.maxComprobantes === (p.maxComprobantes ?? null) &&
      // El orden también se compara: al intercalar un plan nuevo, los que
      // vienen después corren un lugar y sin esto quedan empatados.
      fila.orden === (p.orden ?? 0) &&
      fila.nombre === p.nombre &&
      fila.soporte === (p.soporte ?? null) &&
      JSON.stringify(fila.features) === JSON.stringify(p.features);
    if (iguales) continue;

    await fila.update({ ...p, features: JSON.stringify(p.features) });
    actualizados++;
  }

  return { creados, actualizados };
}

/** Arranca la prueba de 14 días de una cuenta recién creada. */
async function iniciarTrial(businessId, opciones = {}) {
  const codigo = opciones.plan || PLAN_POR_DEFECTO;
  const plan = await Plan.findOne({ where: { codigo } });
  if (!plan) throw new ErrorPlan(`No existe el plan "${codigo}".`, 500);

  const ahora = new Date();
  return Subscription.create({
    businessId,
    planId: plan.id,
    estado: 'trial',
    trialInicio: ahora,
    trialFin: diasDesde(ahora, DIAS_TRIAL),
    ...(opciones.transaction ? {} : {}),
  }, opciones.transaction ? { transaction: opciones.transaction } : undefined);
}

/*
 * Estado real de la suscripción, resuelto contra la fecha de hoy.
 *
 * Devuelve siempre un objeto utilizable: una cuenta sin suscripción (creada
 * antes de que existieran los planes) se trata como trial arrancando hoy en
 * lugar de romper, así nadie queda encerrado fuera de su propia cuenta por
 * una migración.
 */
async function estadoDe(businessId) {
  let sub = await Subscription.findOne({
    where: { businessId },
    include: [{ model: Plan, as: 'plan' }],
  });

  if (!sub) {
    await iniciarTrial(businessId);
    sub = await Subscription.findOne({
      where: { businessId },
      include: [{ model: Plan, as: 'plan' }],
    });
  }

  const ahora = new Date();

  // Una bajada de plan ya paga rige desde que llega su fecha, aunque nadie
  // haya tocado nada: es la "renovación" al plan que el cliente eligió.
  if (await aplicarPlanPendiente(sub, ahora)) {
    sub = await Subscription.findOne({
      where: { businessId },
      include: [{ model: Plan, as: 'plan' }],
    });
  }
  const planPendiente = sub.planPendienteId ? await Plan.findByPk(sub.planPendienteId) : null;

  let estado = sub.estado;
  let vence  = null;

  if (estado === 'trial') {
    vence = sub.trialFin;
    if (sub.trialFin && ahora > sub.trialFin) estado = 'lectura';
  } else if (estado === 'activa' || estado === 'morosa') {
    vence = sub.periodoFin;
    if (sub.periodoFin) {
      if (ahora > diasDesde(sub.periodoFin, DIAS_GRACIA)) estado = 'lectura';
      else if (ahora > sub.periodoFin) estado = 'morosa';
      else estado = 'activa';
    }
  }

  // Enterprise cotizado a mano puede quedar en 'activa' sin período: es una
  // cuenta facturada por fuera y no se le corta el servicio por reloj.
  const puedeOperar = estado === 'trial' || estado === 'activa' || estado === 'morosa';
  const diasRestantes = vence
    ? Math.ceil((new Date(vence) - ahora) / (24 * 60 * 60 * 1000))
    : null;

  return {
    suscripcion: sub,
    plan: sub.plan,
    estado,
    soloLectura: !puedeOperar,
    vence,
    diasRestantes,
    ...precioDeSuscripcion(sub),
    renovacionAutomatica: sub.renovacionAutomatica !== false,
    bajaSolicitadaEn: sub.bajaSolicitadaEn,
    // La bajada ya paga que todavía no rige. La pantalla la tiene que mostrar:
    // si no, el cliente paga el plan barato, sigue viendo el caro y no sabe
    // si el cambio se hizo.
    planPendiente,
    planPendienteDesde: planPendiente ? sub.planPendienteDesde : null,
  };
}

/*
 * Precio efectivo de una suscripción.
 *
 * Orden de precedencia: el precio cerrado con este cliente gana sobre el de
 * lista, y el descuento comercial se aplica encima. Se devuelven los tres
 * números porque la pantalla tiene que poder mostrar de dónde sale el total:
 * un importe con descuento y sin explicación genera un llamado a soporte.
 */
function precioDeSuscripcion(sub) {
  const lista = sub.precioAcordado != null ? Number(sub.precioAcordado)
              : sub.plan?.precioMensual != null ? Number(sub.plan.precioMensual)
              : null;
  if (lista == null) return { precioLista: null, descuentoPct: 0, precio: null };

  const pct = Math.min(100, Math.max(0, Number(sub.descuentoPct) || 0));
  const precio = Math.round(lista * (1 - pct / 100) * 100) / 100;
  return { precioLista: lista, descuentoPct: pct, precio };
}

/** ¿El plan del negocio incluye esta función? */
async function tieneFeature(businessId, clave) {
  const { plan, soloLectura } = await estadoDe(businessId);
  if (soloLectura) return false;
  if (plan?.features?.[clave]) return true;
  return heredaFeature(await Business.findByPk(businessId, { attributes: ['id', 'featuresHeredadas'] }), clave);
}

/*
 * Si el negocio conserva una función que su plan no incluye.
 *
 * Pasa cuando una función que era libre se mete en un plan: el que ya la venía
 * usando no puede quedarse afuera de sus propios datos por un cambio de
 * catálogo. La lista se llena una sola vez, al poner la puerta.
 */
function heredaFeature(negocio, clave) {
  if (!negocio?.featuresHeredadas) return false;
  return String(negocio.featuresHeredadas).split(',').map((x) => x.trim()).includes(clave);
}

/** Primer instante del mes corriente, en hora local. */
function inicioDelMes(ahora = new Date()) {
  return new Date(ahora.getFullYear(), ahora.getMonth(), 1, 0, 0, 0, 0);
}

/*
 * Uso actual contra los topes del plan.
 *
 * Los topes acumulativos cuentan lo que hay, no lo que se creó: un empleado
 * dado de baja no ocupa lugar, si no bastaría con rotar gente para quedarse
 * sin cupo para siempre. Los SKUs siguen el mismo criterio — borrar un
 * producto libera espacio, porque es espacio de verdad.
 *
 * Los comprobantes son otra cosa: se cuentan sólo los del mes corriente y
 * arrancan de cero el día 1. Miden consumo, no capacidad.
 */
async function usoDe(businessId) {
  const { plan } = await estadoDe(businessId);
  const desde = inicioDelMes();

  const [cuits, empleados, locales, skus, comprobantes] = await Promise.all([
    BusinessCuit.count({ where: { businessId } }),
    Employee.count({ where: { businessId, activo: true } }),
    BusinessLocation.count({ where: { businessId } }),
    // Las variantes se cuentan por el negocio de su producto padre: la tabla de
    // variantes no lleva businessId propio.
    ProductVariant.count({
      include: [{ model: Product, as: 'producto', attributes: [], where: { businessId }, required: true }],
    }),
    Invoice.count({ where: { businessId, createdAt: { [Op.gte]: desde } } }),
  ]);

  const medir = (usado, tope, extra = {}) => ({
    usado,
    tope: tope ?? null,
    disponible: tope == null ? null : Math.max(0, tope - usado),
    ...extra,
  });

  return {
    cuits:     medir(cuits, plan?.maxCuits),
    empleados: medir(empleados, plan?.maxEmpleados),
    locales:   medir(locales, plan?.maxLocales),
    skus:      medir(skus, plan?.maxSkus),
    comprobantes: medir(comprobantes, plan?.maxComprobantes, {
      // La pantalla necesita poder decir "de este mes" y cuándo se reinicia.
      periodo: 'mes',
      desde,
      reinicia: new Date(desde.getFullYear(), desde.getMonth() + 1, 1),
    }),
  };
}

const ETIQUETA = {
  cuits:     { que: 'CUITs',     verbo: 'agregar otro CUIT' },
  empleados: { que: 'empleados', verbo: 'dar de alta otro empleado' },
  locales:   { que: 'locales',   verbo: 'crear otro local' },
  skus:      { que: 'SKUs',      verbo: 'cargar más productos' },
  comprobantes: {
    que: 'comprobantes por mes',
    verbo: 'seguir facturando este mes',
    // Un tope por período se resuelve esperando o subiendo de plan; decir sólo
    // "pasá a un plan superior" sería mentirle a quien está a dos días del 1.
    porPeriodo: true,
  },
};

/**
 * Lanza si el negocio ya llegó al tope de ese recurso.
 *
 * Se llama ANTES de crear, no después: crear y borrar dejaría huecos de id.
 *
 * @param {number} cantidad cuántas unidades se van a dar de alta. Un producto
 *   con doce variantes consume doce SKUs de golpe; validar de uno en uno lo
 *   dejaría pasar y el negocio terminaría por encima del tope.
 */
async function exigirCupo(businessId, recurso, cantidad = 1) {
  const uso = await usoDe(businessId);
  const dato = uso[recurso];
  if (!dato || dato.tope == null) return;      // sin tope: Enterprise
  if (dato.usado + cantidad <= dato.tope) return;

  const { plan } = await estadoDe(businessId);
  const e = ETIQUETA[recurso];

  const cierre = e.porPeriodo
    ? `Para ${e.verbo} hay que pasar a un plan superior. El contador se reinicia el ` +
      `${dato.reinicia ? new Date(dato.reinicia).toLocaleDateString('es-AR') : '1 del mes que viene'}.`
    : `Para ${e.verbo} hay que pasar a un plan superior.`;

  throw new ErrorPlan(
    `El ${plan?.nombre || 'plan actual'} incluye hasta ${dato.tope.toLocaleString('es-AR')} ${e.que}. ` + cierre,
    409,
    { recurso, tope: dato.tope, usado: dato.usado, planActual: plan?.codigo }
  );
}

/*
 * Hacia dónde va un cambio de plan: 'sube', 'baja' o 'igual'.
 *
 * Se compara por `orden`, que es la escalera comercial (Inicial, Pro, Superior,
 * Enterprise), y no por precio: el Enterprise no tiene precio de lista y un
 * precio acordado puede dejar a un plan grande más barato que uno chico. Dos
 * planes distintos con el mismo orden cuentan como bajada: esperan al fin del
 * período, que es el lado en el que no se regala nada.
 */
function sentidoDelCambio(actual, nuevo) {
  if (!actual || !nuevo || Number(actual.id) === Number(nuevo.id)) return 'igual';
  return (Number(nuevo.orden) || 0) > (Number(actual.orden) || 0) ? 'sube' : 'baja';
}

/*
 * Aplica la bajada de plan ya paga si llegó su fecha. Devuelve si la aplicó.
 *
 * Contra el reloj y no con una tarea programada, por lo mismo que el estado:
 * si el cron no corre, la cuenta seguiría con los topes del plan caro pagando
 * el barato.
 *
 * La condición entera va en el WHERE y no sólo el id. Si entre que se leyó la
 * suscripción y se escribe se acreditó un pago que SUBIÓ de plan (y borró lo
 * pendiente), el UPDATE ya no encuentra la fila y no pisa la subida recién
 * pagada con la bajada vieja.
 */
async function aplicarPlanPendiente(sub, ahora = new Date()) {
  if (!sub?.planPendienteId || !sub.planPendienteDesde) return false;
  if (new Date(sub.planPendienteDesde) > ahora) return false;

  const [filas] = await Subscription.update(
    { planId: sub.planPendienteId, planPendienteId: null, planPendienteDesde: null },
    {
      where: {
        id: sub.id,
        planPendienteId: sub.planPendienteId,
        planPendienteDesde: { [Op.lte]: ahora },
      },
    },
  );
  if (filas > 0) log.info('planes', 'rige la bajada de plan ya paga', { businessId: sub.businessId });
  return filas > 0;
}

/*
 * Opciones para leer una fila TRABADA hasta el fin de la transacción.
 *
 * `lock: UPDATE` es el SELECT ... FOR UPDATE de Postgres (producción), pero el
 * dialecto de SQL Server de Sequelize lo ignora en silencio (no declara soporte
 * de lock): en la base local no trababa nada y la carrera de dos pagos pasaba
 * igual. Allá hace falta el hint UPDLOCK, que retiene el bloqueo hasta el
 * COMMIT. Se mandan los dos porque cada motor ignora la opción del otro.
 */
const trabada = (transaction) => ({
  transaction, lock: transaction.LOCK.UPDATE, tableHint: TableHints.UPDLOCK,
});

/** La suscripción trabada hasta que termine la transacción. */
function trabarSuscripcion(id, transaction) {
  return Subscription.findByPk(id, trabada(transaction));
}

/*
 * Acredita un pago: deja la cuenta activa N días más y aplica el plan pagado.
 *
 * @param {number|null} planId  el plan que se pagó. `null` = sólo extender, como
 *   antes de que el pago llevara plan: una cortesía del backoffice, o un débito
 *   automático que no corresponde a ningún pedido de cambio.
 *
 * Antes esto sólo extendía el período: el checkout cobraba el precio del plan
 * nuevo y la cuenta seguía con los topes del viejo. La regla, del dueño:
 *   · SUBIR aplica en el momento. Pagó el plan más caro; hacerlo esperar al
 *     vencimiento sería cobrarle algo que no se le da.
 *   · BAJAR aplica al terminar el período ya pago con el plan caro. Queda en
 *     planPendienteId y lo aplica `aplicarPlanPendiente` cuando llega la fecha.
 *     Si no hay período pago en curso (prueba, vencida) la fecha es hoy.
 *   · El mismo plan sólo extiende. Si había una bajada esperando se cae: el
 *     último plan que el cliente eligió y pagó es el que manda.
 *
 * La suscripción se relee TRABADA, aunque quien llama ya la tenga en la mano.
 * Dos pagos que se acreditaban a la vez leían el mismo periodoFin y los dos
 * sumaban 30 días sobre él: el cliente pagaba dos meses y recibía uno. Con la
 * fila trabada el segundo espera y suma sobre lo que dejó el primero, y lo
 * mismo con el plan: nadie decide sobre un plan que otro ya cambió.
 */
async function acreditarPago({ subscription, planId = null, desde = new Date(), dias = 30 }, transaction = null) {
  if (!transaction) {
    return db.transaction((t) => acreditarPago({ subscription, planId, desde, dias }, t));
  }

  const sub = await trabarSuscripcion(subscription.id, transaction);

  // Si todavía está en curso, el período nuevo arranca cuando termina el
  // anterior: pagar antes de tiempo no puede regalar días.
  const base = sub.periodoFin && new Date(sub.periodoFin) > desde
    ? new Date(sub.periodoFin)
    : desde;
  const hasta = diasDesde(base, dias);

  let vigenteId = sub.planId;
  let pendienteId = sub.planPendienteId || null;
  let pendienteDesde = pendienteId ? sub.planPendienteDesde : null;

  // Lo que ya tenía que regir, rige antes de comparar: si no, un pago llegado
  // después de la fecha se mediría contra un plan que la cuenta ya no tiene.
  if (pendienteId && pendienteDesde && new Date(pendienteDesde) <= desde) {
    vigenteId = pendienteId;
    pendienteId = null;
    pendienteDesde = null;
  }

  let cambio = null;
  const nuevo = planId != null ? await Plan.findByPk(planId, { transaction }) : null;
  if (planId != null && !nuevo) {
    // Un plan borrado no puede dejar a nadie sin el mes que pagó: se acredita
    // el período y el plan queda como estaba.
    log.warn('planes', 'pago con un plan que ya no existe: sólo se extiende', { businessId: sub.businessId });
  } else if (nuevo) {
    const actual = Number(vigenteId) === Number(nuevo.id)
      ? nuevo
      : await Plan.findByPk(vigenteId, { transaction });
    cambio = sentidoDelCambio(actual, nuevo);

    if (cambio === 'sube') {
      vigenteId = nuevo.id;
      pendienteId = null;
      pendienteDesde = null;
    } else if (cambio === 'igual') {
      pendienteId = null;
      pendienteDesde = null;
    } else {
      // Si ya había otra bajada esperando, la fecha no se corre: el período
      // pagado con el plan caro termina donde terminaba.
      pendienteDesde = pendienteId ? pendienteDesde : base;
      pendienteId = nuevo.id;
      if (new Date(pendienteDesde) <= desde) {
        vigenteId = nuevo.id;
        pendienteId = null;
        pendienteDesde = null;
      }
    }
  }

  await sub.update({
    estado: 'activa',
    periodoInicio: base,
    periodoFin: hasta,
    ultimoPagoEn: desde,
    proximoCobroEn: hasta,
    planId: vigenteId,
    planPendienteId: pendienteId,
    planPendienteDesde: pendienteDesde,
  }, { transaction });

  if (cambio === 'sube' || cambio === 'baja') {
    log.info('planes', `pago acreditado con cambio de plan (${cambio})`, { businessId: sub.businessId });
  }

  return {
    desde: base,
    hasta,
    cambio,
    planId: vigenteId,
    planPendienteId: pendienteId,
    planPendienteDesde: pendienteDesde,
    // El plan con el que arranca el período recién pagado: lo que dice el
    // recibo de un cobro que no vino de ningún pedido de cambio.
    planDelPeriodo: pendienteId || vigenteId,
  };
}

/** Cuentas cuyo trial vence en los próximos N días (para los avisos). */
async function trialsPorVencer(dias = 2) {
  const ahora = new Date();
  return Subscription.findAll({
    where: {
      estado: 'trial',
      trialFin: { [Op.gt]: ahora, [Op.lte]: diasDesde(ahora, dias) },
    },
    include: [{ model: Business, attributes: ['id', 'nombreNegocio', 'email'] }],
  });
}

module.exports = {
  sembrarPlanes, iniciarTrial, estadoDe, tieneFeature, heredaFeature, usoDe, exigirCupo,
  acreditarPago, aplicarPlanPendiente, trabarSuscripcion, trabada, sentidoDelCambio,
  trialsPorVencer, precioDeSuscripcion, ErrorPlan, DIAS_TRIAL,
};
