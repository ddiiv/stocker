const { Op } = require('sequelize');
const { Plan, Subscription, Business, Employee, BusinessCuit, BusinessLocation, Product, ProductVariant, Invoice } = require('../models');
const { PLANES, PLAN_POR_DEFECTO, DIAS_TRIAL, DIAS_GRACIA } = require('../config/planes');

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
  return Boolean(plan?.features?.[clave]);
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

/** Registra un pago acreditado y deja la cuenta activa por 30 días más. */
async function acreditarPago({ subscription, desde = new Date(), dias = 30 }, transaction = null) {
  // Si todavía está en curso, el período nuevo arranca cuando termina el
  // anterior: pagar antes de tiempo no puede regalar días.
  const base = subscription.periodoFin && new Date(subscription.periodoFin) > desde
    ? new Date(subscription.periodoFin)
    : desde;
  const hasta = diasDesde(base, dias);

  await subscription.update({
    estado: 'activa',
    periodoInicio: base,
    periodoFin: hasta,
    ultimoPagoEn: desde,
    proximoCobroEn: hasta,
  }, transaction ? { transaction } : undefined);

  return { desde: base, hasta };
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
  sembrarPlanes, iniciarTrial, estadoDe, tieneFeature, usoDe, exigirCupo,
  acreditarPago, trialsPorVencer, precioDeSuscripcion, ErrorPlan, DIAS_TRIAL,
};
