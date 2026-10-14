const { Op, TableHints } = require('sequelize');
const db = require('../config/database');
const { Plan, Subscription, Business, Employee, BusinessCuit, BusinessLocation, Product, ProductVariant, Invoice } = require('../models');
const { PLANES, PLAN_POR_DEFECTO, DIAS_TRIAL, DIAS_GRACIA } = require('../config/planes');
const { log } = require('../utils/logger');
// sesionesService lee el plan desde adentro de una función (estadoDe), no al
// cargar, así que requerirlo acá no arma un ciclo.
const sesionesService = require('./sesionesService');
const mp = require('./mercadopagoService');

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

const DIA = 24 * 60 * 60 * 1000;
const diasDesde = (fecha, dias) => new Date(new Date(fecha).getTime() + dias * DIA);

/*
 * Lo que dura un período pago, y la base del prorrateo: "la diferencia por los
 * días que quedan" es (precio nuevo − precio de ese tramo) × días / 30.
 */
const DIAS_PERIODO = 30;

/*
 * Cuánto puede faltar, en pesos, para dar por pagada una diferencia. El total
 * del prorrateo se redondea al peso: sin este margen, un cobro de $12.345 por
 * una diferencia de $12.345,40 no alcanzaría para subir de plan.
 */
const TOLERANCIA = 1;

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
      fila.maxSesiones === (p.maxSesiones ?? null) &&
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

  const [cuits, empleados, suspendidos, locales, skus, comprobantes, sesiones] = await Promise.all([
    BusinessCuit.count({ where: { businessId } }),
    Employee.count({ where: { businessId, activo: true } }),
    // Los que una bajada dejó afuera. No ocupan lugar (están inactivos), pero
    // la pantalla tiene que poder decir que existen y que vuelven al subir.
    Employee.count({ where: { businessId, activo: false, suspendidoPorPlan: true } }),
    BusinessLocation.count({ where: { businessId } }),
    // Las variantes se cuentan por el negocio de su producto padre: la tabla de
    // variantes no lleva businessId propio.
    ProductVariant.count({
      include: [{ model: Product, as: 'producto', attributes: [], where: { businessId }, required: true }],
    }),
    Invoice.count({ where: { businessId, createdAt: { [Op.gte]: desde } } }),
    // Sólo las del dueño: es lo único que el tope de sesiones limita.
    sesionesService.contarActivasDelDueno(businessId),
  ]);

  const medir = (usado, tope, extra = {}) => ({
    usado,
    tope: tope ?? null,
    disponible: tope == null ? null : Math.max(0, tope - usado),
    ...extra,
  });

  return {
    cuits:     medir(cuits, plan?.maxCuits),
    empleados: medir(empleados, plan?.maxEmpleados, { suspendidosPorPlan: suspendidos }),
    locales:   medir(locales, plan?.maxLocales),
    skus:      medir(skus, plan?.maxSkus),
    comprobantes: medir(comprobantes, plan?.maxComprobantes, {
      // La pantalla necesita poder decir "de este mes" y cuándo se reinicia.
      periodo: 'mes',
      desde,
      reinicia: new Date(desde.getFullYear(), desde.getMonth() + 1, 1),
    }),
    /*
     * Las sesiones del dueño abiertas ahora. No es un tope que frene un alta
     * (exigirCupo no lo mira): pasarlo cierra la sesión con menos actividad al
     * entrar. `modo` le dice a la pantalla si eso está prendido o si todavía
     * se mide en sombra.
     */
    sesiones: medir(sesiones, plan?.maxSesiones, {
      modo: sesionesService.modoLimite(),
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
 * Contra el reloj y no sólo con una tarea programada, por lo mismo que el
 * estado: si el cron no corre, la cuenta seguiría con los topes del plan caro
 * pagando el barato. (La tarea periódica igual la aplica: ver
 * aplicarBajadasVencidas.)
 *
 * La condición entera va en el WHERE y no sólo el id. Si entre que se leyó la
 * suscripción y se escribe se acreditó un pago que SUBIÓ de plan (y borró lo
 * pendiente), el UPDATE ya no encuentra la fila y no pisa la subida recién
 * pagada con la bajada vieja.
 *
 * Es el momento en que los empleados de más quedan suspendidos (decisión 19):
 * cuando la bajada RIGE, no cuando se paga. Va en la misma transacción que el
 * cambio de plan para que no quede uno sin lo otro, y sólo lo hace quien ganó
 * el UPDATE: dos consultas a la vez no suspenden dos veces.
 */
async function aplicarPlanPendiente(sub, ahora = new Date()) {
  if (!sub?.planPendienteId || !sub.planPendienteDesde) return false;
  if (new Date(sub.planPendienteDesde) > ahora) return false;

  const aplicada = await db.transaction(async (t) => {
    const [filas] = await Subscription.update(
      { planId: sub.planPendienteId, planPendienteId: null, planPendienteDesde: null, planPendienteSuspender: null },
      {
        where: {
          id: sub.id,
          planPendienteId: sub.planPendienteId,
          planPendienteDesde: { [Op.lte]: ahora },
        },
        transaction: t,
      },
    );
    if (!filas) return false;
    const plan = await Plan.findByPk(sub.planPendienteId, { transaction: t });
    await ajustarEmpleados(sub.businessId, plan, {
      suspender: leerLista(sub.planPendienteSuspender), transaction: t,
    });
    return true;
  });

  if (aplicada) {
    log.info('planes', 'rige la bajada de plan ya paga', { businessId: sub.businessId });
    // Decisión 20: el día que la bajada rige se vuelve a mirar el débito. Ya
    // tendría que estar en el precio nuevo (se puso al programarla); si aquella
    // vez Mercado Pago no contestó, es ahora.
    if (debitoActivo(sub)) programarSincronizacion(sub.id);
  }
  return aplicada;
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

/* ── Precio y prorrateo ───────────────────────────────────────── */

/** Precio mensual de un plan para ESTA cuenta: el acordado o el de lista, con su descuento. */
function precioPara(sub, plan) {
  if (!plan) return null;
  return precioDeSuscripcion({
    precioAcordado: sub.precioAcordado, descuentoPct: sub.descuentoPct, plan,
  }).precio;
}

/** ¿Hay un período pago corriendo? La prueba no cuenta: ahí se paga el plan entero. */
function periodoEnCurso(sub, ahora = new Date()) {
  return sub.estado !== 'trial' && sub.periodoFin != null && new Date(sub.periodoFin) > new Date(ahora);
}

/*
 * Lo pago, partido en el período que se está USANDO y lo que viene después
 * ya pago: { actual: { desde, hasta }, siguiente: { desde, hasta } | null }.
 *
 * Pagar antes del vencimiento suma lo nuevo después de lo que está corriendo
 * (acreditarPago: "pagar antes de tiempo no puede regalar días"). Si la
 * pantalla mostrara de periodoInicio a periodoFin, quien renueva el 20 un
 * período que vence el 30 vería como "actual" uno que empieza el 30, con el
 * día de hoy afuera; y con una bajada paga, el período del plan barato al lado
 * del plan caro que todavía rige. El corte (periodoSiguienteDesde) es dónde
 * termina lo que se usa y empieza lo pagado por adelantado.
 *
 * Cuando el corte ya pasó, lo que se usa es lo que se había pagado por
 * adelantado, hasta el fin de todo lo pago: no se guardan los cortes de varios
 * meses pagados juntos, así que dos meses por adelantado se ven como uno de
 * sesenta días una vez que empiezan. Es lo que cubre el pago, sin inventar.
 *
 * Una fila de antes de que existiera el corte puede tener periodoInicio en el
 * futuro (era el inicio de lo pagado por adelantado): ese inicio ES el corte,
 * y de cuándo empezó lo que se usa no hay dato: `desde` va en null en vez de
 * una fecha inventada.
 */
function partirPeriodo(sub, ahora = new Date()) {
  const t = new Date(ahora);
  const fin = sub.periodoFin ? new Date(sub.periodoFin) : null;
  let inicio = sub.periodoInicio ? new Date(sub.periodoInicio) : null;
  let corte = sub.periodoSiguienteDesde ? new Date(sub.periodoSiguienteDesde) : null;
  if (!corte && inicio && inicio > t) { corte = inicio; inicio = null; }
  // Un corte que no deja nada después no parte nada.
  if (corte && (!fin || corte >= fin)) corte = null;

  if (!corte) return { actual: { desde: inicio, hasta: fin }, siguiente: null };
  if (corte <= t) return { actual: { desde: corte, hasta: fin }, siguiente: null };
  return { actual: { desde: inicio, hasta: corte }, siguiente: { desde: corte, hasta: fin } };
}

const pesos = (n) => `$${Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 2 })}`;

/*
 * Qué significa pagar el plan `nuevo` hoy. No escribe nada: lo usan la
 * cotización que el cliente ve antes de pagar, la comparación del backoffice al
 * acreditar una transferencia y acreditarPago, así los tres dicen lo mismo.
 *
 *   alta        Sin período pago en curso (prueba, vencida): el plan entero, rige ya.
 *   renovacion  El plan con el que la cuenta sigue: el plan entero, 30 días más.
 *   subida      Un plan más alto con un período pago corriendo (decisión 18):
 *               SÓLO la diferencia por los días que quedan; rige ya y el
 *               vencimiento no se mueve.
 *   seguir      El plan actual cuando hay una bajada programada: la diferencia
 *               del tramo que se pagó con el plan bajo. Cancela la bajada.
 *   bajada      Un plan más bajo: el plan entero, rige al terminar lo ya pagado.
 *   cambio_pendiente  Otro plan más bajo con una bajada ya programada. Con una
 *               sola ranura no se puede representar Superior → Pro → Inicial, y
 *               antes la segunda pisaba el mes que se había pagado con la
 *               primera: se rechaza hasta que la primera rija.
 *
 * El prorrateo va por tramos porque, con una bajada programada, los días que
 * quedan no valen lo mismo: hasta la fecha de la bajada se pagaron al precio del
 * plan actual y desde ahí al del plan bajo. Cada tramo paga
 *     (precio del plan nuevo − precio del tramo) × días del tramo / 30
 * con los precios de HOY de esta cuenta: el acordado o el de lista, con su
 * descuento (un 20% de descuento achica la diferencia en la misma proporción).
 * Los días se cuentan enteros y hacia arriba —el día empezado cuenta entero,
 * como el "quedan N días" de la pantalla— y lo que se cobra es el total
 * redondeado al peso. Un tramo nunca resta: bajarle el precio a lo ya pagado
 * sería un reintegro.
 *
 * Los días regalados desde el backoffice (extender días) cuentan como pagos: se
 * regaló ese plan y no uno más caro, así que pasarlos al plan nuevo también
 * paga la diferencia. Varios meses pagados por adelantado, igual: pasar al
 * Superior trescientos días pagos del Inicial cuesta la diferencia de esos
 * trescientos días, no la de uno.
 */
function clasificarCambio({ sub, actual, pendiente = null, pendienteDesde = null, nuevo, ahora = new Date() }) {
  const enCurso = periodoEnCurso(sub, ahora);
  const continua = pendiente || actual;
  const r = {
    enCurso,
    precioNuevo: precioPara(sub, nuevo),
    precioContinua: precioPara(sub, continua),
    tramos: [],
    diferencia: 0,
  };
  if (!enCurso) return { ...r, tipo: 'alta', concepto: 'periodo' };
  if (Number(nuevo.id) === Number(continua?.id)) return { ...r, tipo: 'renovacion', concepto: 'periodo' };

  const seguir = Boolean(pendiente) && Number(nuevo.id) === Number(actual?.id);
  if (!seguir && sentidoDelCambio(actual, nuevo) !== 'sube') {
    return { ...r, tipo: pendiente ? 'cambio_pendiente' : 'bajada', concepto: 'periodo' };
  }

  const fin = new Date(sub.periodoFin);
  const total = Math.ceil((fin - new Date(ahora)) / DIA);
  const diasPendiente = pendiente && pendienteDesde
    ? Math.min(total, Math.max(0, Math.round((fin - new Date(pendienteDesde)) / DIA)))
    : 0;
  if (!seguir) {
    r.tramos.push({
      plan: actual, desde: new Date(ahora), hasta: pendiente ? new Date(pendienteDesde) : fin,
      dias: total - diasPendiente,
    });
  }
  if (pendiente) {
    r.tramos.push({ plan: pendiente, desde: new Date(pendienteDesde), hasta: fin, dias: diasPendiente });
  }
  for (const t of r.tramos) {
    t.precio = precioPara(sub, t.plan) ?? 0;
    t.importe = Math.max(0, ((r.precioNuevo ?? 0) - t.precio) * t.dias / DIAS_PERIODO);
    r.diferencia += t.importe;
  }
  return { ...r, tipo: seguir ? 'seguir' : 'subida', concepto: 'diferencia' };
}

/** Lo que se cobra por un cambio ya clasificado: el plan entero, o la diferencia al peso. */
function montoDe(clasificacion) {
  return clasificacion.concepto === 'diferencia'
    ? Math.round(clasificacion.diferencia)
    : clasificacion.precioNuevo;
}

/*
 * Cuántos días de un plan compra un importe.
 *
 * Es lo que se hace con un cobro que ya entró y no corresponde a lo que se le
 * cotizó (un link que se pagó cuando el período ya había vencido, dos pagos que
 * se cruzaron): ni regalarle el plan caro ni quedarse con la plata. Sin precio
 * (un plan a cotizar) no hay cuenta posible: el período entero, como siempre.
 */
function diasPorValor(importe, precio, siNoHayPrecio = DIAS_PERIODO) {
  if (!(Number(precio) > 0)) return siNoHayPrecio;
  return Math.max(0, Math.floor(DIAS_PERIODO * Number(importe) / Number(precio)));
}

/** Una lista de ids guardada como JSON. Lo que no se entiende es "nadie eligió". */
function leerLista(texto) {
  if (texto == null || texto === '') return null;
  if (Array.isArray(texto)) return texto.map(Number).filter(Number.isInteger);
  try {
    const v = JSON.parse(texto);
    return Array.isArray(v) ? v.map(Number).filter(Number.isInteger) : null;
  } catch { return null; }
}
const guardarLista = (lista) => (Array.isArray(lista) ? JSON.stringify(lista.map(Number)) : null);

/* ── Empleados y el tope de usuarios (decisión 19) ────────────── */

/*
 * En qué orden SE QUEDAN los empleados cuando no entran todos: primero el que
 * usó el sistema más recientemente, al final el que nunca entró; a igual
 * actividad, el más antiguo. Es el criterio cuando nadie eligió —una bajada que
 * hizo un operador desde el backoffice, o un pago que no trae la elección— y el
 * orden en que vuelven cuando la cuenta sube y no entran todos. Quien está
 * trabajando hoy es quien menos puede quedarse afuera mañana.
 */
function ordenDeUso(a, b) {
  const ua = a.ultimaConexion ? new Date(a.ultimaConexion).getTime() : -Infinity;
  const ub = b.ultimaConexion ? new Date(b.ultimaConexion).getTime() : -Infinity;
  if (ua !== ub) return ub > ua ? 1 : -1;
  const ca = new Date(a.createdAt || 0).getTime();
  const cb = new Date(b.createdAt || 0).getTime();
  return ca - cb || a.id - b.id;
}

const ATRIBUTOS_EMPLEADO = ['id', 'nombre', 'apellido', 'ultimaConexion', 'createdAt', 'activo', 'suspendidoPorPlan'];

/*
 * Deja a los empleados en uso dentro del tope de usuarios del plan que rige.
 *
 * Se llama cada vez que cambia el plan VIGENTE, nunca al pagar una bajada: el
 * período caro está pago y hasta su fecha la cuenta usa todo lo que pagó.
 *
 *   · Si sobran, quedan suspendidos por el plan (activo=false +
 *     suspendidoPorPlan): no pueden entrar ni operar, pero no se borra nada
 *     —la ficha, sus ventas, su historial—. Primero los que el dueño dejó
 *     afuera al pagar; si aun así sobran (dio de alta a alguien después de
 *     elegir), los de menos actividad. Sus sesiones se cierran con el mismo
 *     cierre de sesionesService que usa todo lo demás, con motivo 'plan', para
 *     que la lista de sesiones diga por qué.
 *   · Si sobra lugar, vuelven solos los suspendidos POR EL PLAN, en el mismo
 *     orden, hasta llenarlo. A los que el dueño desactivó a mano no se los toca:
 *     eso es una decisión suya, no del plan.
 */
async function ajustarEmpleados(businessId, plan, { suspender = null, transaction = null } = {}) {
  const tope = plan?.maxEmpleados == null ? null : Number(plan.maxEmpleados);
  const [activos, suspendidos] = await Promise.all([
    Employee.findAll({ where: { businessId, activo: true }, attributes: ATRIBUTOS_EMPLEADO, transaction }),
    Employee.findAll({
      where: { businessId, activo: false, suspendidoPorPlan: true }, attributes: ATRIBUTOS_EMPLEADO, transaction,
    }),
  ]);
  const resultado = { reactivados: [], suspendidos: [] };

  if (tope == null || activos.length < tope) {
    const lugar = tope == null ? suspendidos.length : tope - activos.length;
    resultado.reactivados = suspendidos.sort(ordenDeUso).slice(0, lugar).map((e) => e.id);
    if (resultado.reactivados.length) {
      await Employee.update(
        { activo: true, suspendidoPorPlan: false },
        { where: { businessId, id: resultado.reactivados, activo: false, suspendidoPorPlan: true }, transaction },
      );
    }
  } else if (activos.length > tope) {
    const elegidos = new Set(suspender || []);
    const afuera = activos.filter((e) => elegidos.has(e.id));
    const resto = activos.filter((e) => !elegidos.has(e.id)).sort(ordenDeUso);
    if (resto.length > tope) afuera.push(...resto.slice(tope));
    resultado.suspendidos = afuera.map((e) => e.id);
    if (resultado.suspendidos.length) {
      await Employee.update(
        { activo: false, suspendidoPorPlan: true },
        { where: { businessId, id: resultado.suspendidos, activo: true }, transaction },
      );
      await sesionesService.cerrar({
        businessId, tipo: 'employee', employeeId: resultado.suspendidos, motivo: 'plan', transaction,
      });
    }
  }

  if (resultado.reactivados.length || resultado.suspendidos.length) {
    log.info('planes', 'empleados ajustados al tope del plan', {
      businessId, reactivados: resultado.reactivados.length, suspendidos: resultado.suspendidos.length,
    });
  }
  return resultado;
}

const TOPES = [
  ['empleados', 'maxEmpleados'], ['locales', 'maxLocales'], ['cuits', 'maxCuits'],
  ['skus', 'maxSkus'], ['comprobantes', 'maxComprobantes'], ['sesiones', 'maxSesiones'],
];

/*
 * Cuánto se pasa la cuenta, con lo que tiene HOY, de cada tope de `plan`. Es el
 * aviso que el dueño ve antes de pagar una bajada (decisión 19).
 */
async function excesosPara(businessId, plan) {
  const uso = await usoDe(businessId);
  const excesos = [];
  for (const [recurso, campo] of TOPES) {
    if (plan?.[campo] == null) continue;
    const tope = Number(plan[campo]);
    const usado = Number(uso[recurso]?.usado || 0);
    if (usado > tope) excesos.push({ recurso, usado, tope, exceso: usado - tope });
  }
  return excesos;
}

/** Los empleados en uso, en el orden en que se quedarían, para que el dueño elija. */
async function empleadosParaElegir(businessId, plan) {
  const activos = (await Employee.findAll({
    where: { businessId, activo: true }, attributes: ATRIBUTOS_EMPLEADO,
  })).sort(ordenDeUso);
  const tope = plan?.maxEmpleados == null ? null : Number(plan.maxEmpleados);
  return {
    tope,
    lista: activos.map((e) => ({ id: e.id, nombre: e.nombre, apellido: e.apellido, ultimaConexion: e.ultimaConexion })),
    sugeridos: (tope == null ? activos : activos.slice(0, tope)).map((e) => e.id),
  };
}

/*
 * La elección del dueño: `conservar` son los ids que siguen en uso. Se valida
 * contra los empleados activos de ESTA cuenta y se devuelve como la lista de
 * los que quedan afuera, que es lo que se guarda con el pago: un empleado que
 * se dé de alta después de elegir no queda afuera por no estar en la lista.
 * `suspender` null = no hacía falta elegir, o no eligió.
 */
async function eleccionDeEmpleados(businessId, plan, conservar) {
  const tope = plan?.maxEmpleados == null ? null : Number(plan.maxEmpleados);
  if (conservar == null || tope == null) return { suspender: null };
  if (!Array.isArray(conservar)) return { error: 'La lista de empleados que siguen no es válida.' };
  const ids = [...new Set(conservar.map(Number))];
  if (ids.some((id) => !Number.isInteger(id))) return { error: 'La lista de empleados que siguen no es válida.' };

  const activos = await Employee.findAll({ where: { businessId, activo: true }, attributes: ['id'] });
  const deLaCuenta = new Set(activos.map((e) => e.id));
  if (ids.some((id) => !deLaCuenta.has(id))) {
    return { error: 'Alguno de los empleados elegidos no está activo en esta cuenta.' };
  }
  if (ids.length > tope) {
    return { error: `El ${plan.nombre} incluye hasta ${tope} usuario${tope === 1 ? '' : 's'}: elegí ${tope} como máximo.` };
  }
  if (activos.length <= tope) return { suspender: null };
  const quedan = new Set(ids);
  return { suspender: activos.map((e) => e.id).filter((id) => !quedan.has(id)) };
}

/* ── Débito automático de Mercado Pago (decisión 20) ───────────── */

/** ¿La cuenta tiene un débito automático que Stocker tiene que mantener al día? */
function debitoActivo(sub) {
  return sub?.metodoPago === 'mercadopago' && Boolean(sub.proveedorRef) && sub.renovacionAutomatica !== false;
}

/*
 * Pone el monto del débito automático en el precio del plan con el que la
 * cuenta SIGUE.
 *
 * Ese y no el vigente: cada débito paga el período que se agrega al final
 * (acreditarPago suma 30 días sobre el vencimiento), y ese período es del plan
 * con el que sigue. Con una bajada programada, el próximo débito ya paga el
 * primer mes del plan bajo: ponerle el monto nuevo recién el día que la bajada
 * rige sería cobrar ese mes al precio caro. Por eso se actualiza al cambiar de
 * plan —al subir, al programar una bajada, al cancelarla, cuando un operador
 * pone otro plan— y se vuelve a mirar el día que la bajada rige.
 *
 * Antes nadie lo tocaba: con débito del Inicial y un pago único del Superior, la
 * cuenta quedaba en el Superior pagando el Inicial todos los meses.
 *
 * Corre DESPUÉS del commit (es una llamada a Mercado Pago) y nunca tira. Si
 * Mercado Pago no contesta queda anotado desde cuándo (debitoPendienteDesde):
 * el backoffice lo muestra y la tarea periódica lo reintenta. No se compara
 * contra el precio de lista para "corregir" débitos solos: subirle el débito a
 * todos porque cambió la lista necesita el aviso que dicen los Términos.
 */
async function sincronizarDebito(subscriptionId) {
  const sub = await Subscription.findByPk(subscriptionId);
  if (!sub || !debitoActivo(sub)) return { estado: 'sin_debito' };
  const plan = await Plan.findByPk(sub.planPendienteId || sub.planId);
  const monto = precioPara(sub, plan);
  if (!(monto > 0)) {
    log.warn('billing', 'el plan con el que sigue no tiene precio: el débito automático no se toca', { businessId: sub.businessId });
    return { estado: 'sin_precio' };
  }
  if (sub.debitoMonto != null && Math.abs(Number(sub.debitoMonto) - monto) < 0.01 && !sub.debitoPendienteDesde) {
    return { estado: 'al_dia', monto };
  }
  try {
    await mp.actualizarMontoRecurrente(sub.proveedorRef, { monto, motivo: `Stocker — ${plan.nombre}` });
  } catch (e) {
    await Subscription.update(
      { debitoPendienteDesde: sub.debitoPendienteDesde || new Date() },
      { where: { id: sub.id } },
    );
    log.error('billing', 'no se pudo actualizar el monto del débito automático: queda para reintentar', {
      businessId: sub.businessId, motivo: e.message,
    });
    return { estado: 'fallo', monto };
  }
  await Subscription.update({ debitoMonto: monto, debitoPendienteDesde: null }, { where: { id: sub.id } });
  log.info('billing', 'débito automático puesto en el precio del plan con el que sigue', { businessId: sub.businessId });
  return { estado: 'actualizado', monto };
}

/*
 * Una sincronización por suscripción a la vez, en orden. Dos cambios seguidos
 * mandarían dos montos a Mercado Pago en paralelo y podría quedar el viejo si
 * su respuesta llega última; en fila, la segunda lee el estado que dejó la
 * primera y manda el monto de ahora.
 */
const sincronizando = new Map();
function programarSincronizacion(subscriptionId) {
  const anterior = sincronizando.get(subscriptionId) || Promise.resolve();
  const esta = anterior
    .then(() => sincronizarDebito(subscriptionId))
    .catch((e) => {
      log.error('billing', 'falló la sincronización del débito automático', { motivo: e.message });
      return { estado: 'error' };
    })
    .finally(() => { if (sincronizando.get(subscriptionId) === esta) sincronizando.delete(subscriptionId); });
  sincronizando.set(subscriptionId, esta);
  return esta;
}

/** Espera las sincronizaciones en curso. Para las pruebas y un apagado ordenado. */
async function esperarSincronizaciones() {
  while (sincronizando.size) await Promise.allSettled([...sincronizando.values()]);
}

/** Reintenta los débitos que Mercado Pago no aceptó. La llama la tarea periódica. */
async function reintentarDebitos({ subscriptionId } = {}) {
  // El filtro es para las pruebas: no tocar las cuentas de otros.
  const subs = await Subscription.findAll({
    where: { debitoPendienteDesde: { [Op.ne]: null }, ...(subscriptionId ? { id: subscriptionId } : {}) },
    attributes: ['id'],
  });
  const r = await Promise.all(subs.map((x) => programarSincronizacion(x.id)));
  return { pendientes: subs.length, actualizados: r.filter((x) => x?.estado === 'actualizado').length };
}

/*
 * Las bajadas que llegaron a su fecha y nadie aplicó todavía.
 *
 * estadoDe las aplica en la primera consulta de la cuenta, pero una cuenta que
 * nadie toca no consulta nada, y la decisión 19 pide que los empleados de más
 * queden afuera el día que la bajada rige —no cuando el dueño vuelva a entrar—.
 */
async function aplicarBajadasVencidas(ahora = new Date(), { businessId } = {}) {
  // El filtro es para las pruebas: no tocar las cuentas de otros.
  const subs = await Subscription.findAll({
    where: {
      planPendienteId: { [Op.ne]: null }, planPendienteDesde: { [Op.lte]: ahora },
      ...(businessId ? { businessId } : {}),
    },
  });
  let aplicadas = 0;
  for (const sub of subs) {
    if (await aplicarPlanPendiente(sub, ahora)) aplicadas += 1;
  }
  return { revisadas: subs.length, aplicadas };
}

/* ── Acreditar ────────────────────────────────────────────────── */

/*
 * Acredita un pago y aplica lo que se pagó.
 *
 * @param planId    el plan que se pagó. null = sólo extender: una cortesía del
 *                  backoffice, o un débito automático (su monto es el del plan
 *                  con el que la cuenta sigue, ver sincronizarDebito).
 * @param concepto  lo que se le cotizó al cliente: 'periodo' o 'diferencia'.
 *                  null = 'periodo' (las filas de antes del prorrateo).
 * @param monto     lo que entró de verdad. null = lo que corresponde: quien
 *                  llama ya lo comparó, o no hay importe (una prueba).
 * @param aceptado  un operador vio que el importe no coincide y decidió
 *                  acreditarlo igual: se aplica como si estuviera completo.
 * @param empleadosSuspender  la elección del dueño al pagar una bajada (ids que
 *                  quedan afuera). undefined = el pago no trae elección.
 *
 * Qué pasa sale de clasificarCambio con el estado de AHORA, no con el de cuando
 * se cotizó: entre las dos cosas pudo entrar otro pago. La regla, del dueño:
 *   · alta        Rige ya; 30 días desde hoy.
 *   · renovacion  30 días más sobre el vencimiento; el plan no cambia.
 *   · subida / seguir  Rige ya y el vencimiento NO se mueve (decisión 18). Si
 *                 lo que entró sobra —un pago del plan entero que se cruzó con
 *                 otro—, lo que sobra se convierte en días del plan nuevo.
 *   · bajada      Queda pendiente desde el fin de lo ya pagado y suma 30 días.
 * Cuando lo que entró no corresponde a eso (una diferencia que llega con el
 * período ya vencido, un pago que no alcanza para subir, una segunda bajada),
 * no se regala el plan ni se pierde la plata: se acredita por lo que vale en
 * días y la fila queda marcada (`revisar`) para que alguien la mire. Antes un
 * pago del Superior convertía en Superior todos los meses pagados por
 * adelantado al precio del Inicial.
 *
 * La suscripción se relee TRABADA, aunque quien llama ya la tenga en la mano.
 * Dos pagos que se acreditaban a la vez leían el mismo periodoFin y los dos
 * sumaban 30 días sobre él: el cliente pagaba dos meses y recibía uno. Con la
 * fila trabada el segundo espera y decide sobre lo que dejó el primero.
 */
async function acreditarPago(opciones, transaction = null) {
  if (!transaction) return db.transaction((t) => acreditarPago(opciones, t));
  const {
    subscription, planId = null, concepto = null, monto = null, aceptado = false,
    empleadosSuspender, desde = new Date(), dias = DIAS_PERIODO,
  } = opciones;

  const sub = await trabarSuscripcion(subscription.id, transaction);
  const planLeido = Number(sub.planId);
  const continuaAntes = Number(sub.planPendienteId || sub.planId);

  let vigenteId = sub.planId;
  let pendienteId = sub.planPendienteId || null;
  let pendienteDesde = pendienteId ? sub.planPendienteDesde : null;
  let suspenderPendiente = pendienteId ? leerLista(sub.planPendienteSuspender) : null;
  // La elección con la que se ajustan los empleados si cambia el plan vigente.
  let suspenderAhora = null;

  // Lo que ya tenía que regir, rige antes de comparar: si no, un pago llegado
  // después de la fecha se mediría contra un plan que la cuenta ya no tiene.
  if (pendienteId && pendienteDesde && new Date(pendienteDesde) <= desde) {
    vigenteId = pendienteId;
    suspenderAhora = suspenderPendiente;
    pendienteId = null;
    pendienteDesde = null;
    suspenderPendiente = null;
  }

  // Si todavía está en curso, lo nuevo se suma cuando termina lo anterior:
  // pagar antes de tiempo no puede regalar días.
  const finAnterior = sub.periodoFin && new Date(sub.periodoFin) > desde ? new Date(sub.periodoFin) : desde;
  let diasExtra = dias;
  let cubreDesde = finAnterior;
  let cambio = null;
  let tipo = null;
  let revisar = null;

  const nuevo = planId != null ? await Plan.findByPk(planId, { transaction }) : null;
  if (planId != null && !nuevo) {
    // Un plan borrado no puede dejar a nadie sin el mes que pagó: se acredita
    // el período y el plan queda como estaba.
    log.warn('planes', 'pago con un plan que ya no existe: sólo se extiende', { businessId: sub.businessId });
  } else if (nuevo) {
    const [actual, pendiente] = await Promise.all([
      Number(vigenteId) === Number(nuevo.id) ? nuevo : Plan.findByPk(vigenteId, { transaction }),
      !pendienteId ? null
        : Number(pendienteId) === Number(nuevo.id) ? nuevo : Plan.findByPk(pendienteId, { transaction }),
    ]);
    const c = clasificarCambio({ sub, actual, pendiente, pendienteDesde, nuevo, ahora: desde });
    tipo = c.tipo;

    const completo = aceptado || monto == null;
    const cotizoDiferencia = concepto === 'diferencia';
    // Lo que entró; o, si nadie dice otra cosa, lo que corresponde hoy.
    const pagado = completo
      ? Number((cotizoDiferencia ? montoDe(c) : c.precioNuevo) ?? 0)
      : Number(monto);
    // Lo que entró de verdad, aunque un operador haya dicho "acreditalo igual":
    // cuando el pago no puede cambiar el plan y se convierte en días, se
    // convierte lo que llegó al banco y no lo que se había cotizado.
    const entro = monto != null ? Number(monto) : pagado;
    // Se cotizó una diferencia y ahora no hay ninguna que pagar.
    const desfasado = !completo && cotizoDiferencia && c.concepto !== 'diferencia';

    switch (c.tipo) {
      case 'alta':
      case 'renovacion': {
        if (desfasado) {
          diasExtra = diasPorValor(pagado, c.precioNuevo);
          revisar = `Entró una diferencia de ${pesos(pagado)} cuando ya no correspondía ` +
            `(${c.tipo === 'alta' ? 'el período había vencido' : `el plan ya era el ${nuevo.nombre}`}): ` +
            `se acreditó como ${diasExtra} días del ${nuevo.nombre}.`;
        }
        if (c.tipo === 'alta') {
          // Sin período en curso no hay nada que esperar: rige ya, suba o baje.
          cambio = sentidoDelCambio(actual, nuevo);
          if (Number(vigenteId) !== Number(nuevo.id)) suspenderAhora = empleadosSuspender ?? null;
          vigenteId = nuevo.id;
          pendienteId = null;
          pendienteDesde = null;
          suspenderPendiente = null;
        } else {
          cambio = 'igual';
          // Renovar el plan de la bajada con otra elección: manda la última.
          if (pendienteId && empleadosSuspender !== undefined) suspenderPendiente = empleadosSuspender;
        }
        break;
      }
      case 'subida':
      case 'seguir': {
        cubreDesde = desde;
        if (pagado + TOLERANCIA >= c.diferencia) {
          vigenteId = nuevo.id;
          pendienteId = null;
          pendienteDesde = null;
          suspenderPendiente = null;
          suspenderAhora = null;
          // El vencimiento no se mueve; sólo lo que sobre de un pago del plan
          // entero (que se cruzó con otro) se vuelve días del plan nuevo.
          diasExtra = diasPorValor(Math.max(0, pagado - c.diferencia), c.precioNuevo, 0);
          cambio = c.tipo === 'seguir' ? 'sigue' : 'sube';
        } else {
          diasExtra = diasPorValor(pagado, c.precioContinua);
          revisar = `Entraron ${pesos(pagado)} y pasar al ${nuevo.nombre} los días que quedan cuesta ` +
            `${pesos(Math.round(c.diferencia))}: no se cambió el plan y se acreditaron ${diasExtra} días ` +
            'del plan con el que sigue.';
        }
        break;
      }
      case 'bajada': {
        if (desfasado) {
          diasExtra = diasPorValor(pagado, c.precioContinua);
          revisar = `Entró una diferencia para el ${nuevo.nombre} pero la cuenta ya tiene un plan más alto: ` +
            `se acreditaron ${diasExtra} días del plan con el que sigue.`;
        } else {
          pendienteId = nuevo.id;
          pendienteDesde = finAnterior;
          suspenderPendiente = empleadosSuspender ?? null;
          cambio = 'baja';
        }
        break;
      }
      default: {
        // cambio_pendiente: la cotización lo rechaza; llega sólo por un pago
        // que se cruzó con otro o por una fila de antes de esta regla.
        diasExtra = diasPorValor(entro, c.precioContinua);
        revisar = `Ya había un cambio al ${pendiente?.nombre || 'otro plan'} programado: el pago del ` +
          `${nuevo.nombre} no cambió el plan y se acreditó como ${diasExtra} días del plan con el que sigue.`;
      }
    }
  }

  const hasta = diasExtra > 0 ? diasDesde(finAnterior, diasExtra) : finAnterior;
  const extiende = diasExtra > 0 && tipo !== 'subida' && tipo !== 'seguir';

  /*
   * El período en uso no se mueve por pagar antes de tiempo: lo nuevo queda
   * como lo pagado por adelantado, después del corte (ver partirPeriodo). Antes
   * periodoInicio pasaba a ser el vencimiento viejo y la pantalla mostraba como
   * "período actual" uno que todavía no empezaba. Con el período ya vencido no
   * hay nada que partir: arranca hoy y un corte viejo no sobrevive.
   */
  let periodoSiguienteDesde = sub.periodoSiguienteDesde || null;
  // Un inicio desconocido (fila vieja, ver partirPeriodo) no pasa a ser hoy.
  let periodoInicio = sub.periodoInicio || (periodoSiguienteDesde ? null : desde);
  if (extiende) {
    if (finAnterior > desde) {
      const { actual } = partirPeriodo(sub, desde);
      periodoInicio = actual.desde;
      periodoSiguienteDesde = actual.hasta;
    } else {
      periodoInicio = finAnterior;
      periodoSiguienteDesde = null;
    }
  }

  await sub.update({
    estado: 'activa',
    periodoInicio,
    periodoSiguienteDesde,
    periodoFin: hasta,
    ultimoPagoEn: desde,
    proximoCobroEn: hasta,
    planId: vigenteId,
    planPendienteId: pendienteId,
    planPendienteDesde: pendienteDesde,
    planPendienteSuspender: pendienteId ? guardarLista(suspenderPendiente) : null,
  }, { transaction });

  // Cambió el plan que rige: los empleados se acomodan al tope nuevo ahora
  // (al subir vuelven los suspendidos; al bajar sin período en curso, se
  // suspenden los de más). Una bajada programada no toca a nadie todavía.
  if (Number(vigenteId) !== planLeido) {
    const planVigente = Number(vigenteId) === Number(nuevo?.id) ? nuevo : await Plan.findByPk(vigenteId, { transaction });
    await ajustarEmpleados(sub.businessId, planVigente, { suspender: suspenderAhora, transaction });
  }

  // Si cambió el plan con el que sigue, el débito automático se pone en su
  // precio cuando esto quede firme (decisión 20).
  if (Number(pendienteId || vigenteId) !== continuaAntes && debitoActivo(sub)) {
    transaction.afterCommit(() => { programarSincronizacion(sub.id); });
  }

  if (cambio === 'sube' || cambio === 'baja' || cambio === 'sigue') {
    log.info('planes', `pago acreditado con cambio de plan (${cambio})`, { businessId: sub.businessId });
  }
  if (revisar) log.warn('planes', 'pago acreditado que hay que revisar a mano', { businessId: sub.businessId });

  return {
    desde: cubreDesde,
    hasta,
    cambio,
    tipo,
    revisar,
    diasAcreditados: diasExtra,
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
  trialsPorVencer, precioDeSuscripcion, ErrorPlan, DIAS_TRIAL, DIAS_PERIODO, TOLERANCIA,
  // Prorrateo y cambio de plan
  precioPara, periodoEnCurso, partirPeriodo, clasificarCambio, montoDe, diasPorValor, leerLista, guardarLista,
  // Empleados de más al bajar (decisión 19)
  ajustarEmpleados, excesosPara, empleadosParaElegir, eleccionDeEmpleados, ordenDeUso,
  aplicarBajadasVencidas,
  // Débito automático (decisión 20)
  debitoActivo, sincronizarDebito, programarSincronizacion, esperarSincronizaciones, reintentarDebitos,
};
