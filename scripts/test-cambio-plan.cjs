/*
 * Cambio de plan al acreditar un pago.
 *
 * El checkout cobraba el precio del plan NUEVO y `acreditarPago` sólo extendía
 * el período: quien pagaba el Superior estando en el Pro seguía con los topes
 * del Pro. La regla que se prueba acá es la del dueño:
 *
 *   · SUBIR aplica en el momento.
 *   · BAJAR aplica al terminar el período ya pago (queda pendiente).
 *   · El mismo plan sólo extiende.
 *   · Un pago sin plan se comporta como antes: sólo extiende.
 *
 * Y que eso valga por TODOS los caminos que acreditan (backoffice, webhook de
 * Mercado Pago, "Ya pagué"), con las carreras: dos pagos a la vez, un pago
 * mientras rige la bajada, dos clics en "Acreditar".
 *
 * Todo en proceso, con req/res sintéticos y Mercado Pago simulado: no depende
 * de qué backend tenga el 3000 ni de la red. El negocio es de prueba, con datos
 * inventados, y se borra al terminar.
 *
 * Uso:  node scripts/test-cambio-plan.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const { Op } = require('sequelize');

let ok = 0;
let ko = 0;
const chk = (t, esperado, obtenido) => {
  const igual = JSON.stringify(esperado) === JSON.stringify(obtenido);
  console.log(`  ${igual ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${t}`);
  if (!igual) console.log(`      esperaba ${JSON.stringify(esperado)} · vino ${JSON.stringify(obtenido)}`);
  igual ? (ok += 1) : (ko += 1);
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const DIA = 24 * 60 * 60 * 1000;
const enDias = (n, desde = Date.now()) => new Date(desde + n * DIA);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
// Los motores redondean milisegundos distinto: se compara al segundo.
const mismoInstante = (a, b) => a != null && b != null && Math.abs(new Date(a) - new Date(b)) < 1000;

const CUIT = '20999888762';
const EMAIL = 'qa.cambioplan@stocker.test';

/* Handler de Express con req/res sintéticos. */
function llamar(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(p) { resolve({ status: this.statusCode, json: p }); },
    };
    Promise.resolve(handler(req, res, (e) => resolve({ status: e?.status || 500, json: { message: e?.message }, error: e })))
      .catch(reject);
  });
}

(async () => {
  const db = require('../src/config/database');
  const { ensureColumns } = require('../src/database/ensureColumns');
  const {
    Business, Plan, Subscription, SubscriptionPayment,
  } = require('../src/models');
  const planService = require('../src/services/planService');
  const mp = require('../src/services/mercadopagoService');
  const billing = require('../src/controllers/billingController');
  const backoffice = require('../src/controllers/backofficeController');

  // Las columnas nuevas llegan como al arrancar el servidor: por ensureColumns.
  await ensureColumns(db);

  /*
   * SQL Server y el UNIQUE de proveedorRef.
   *
   * En SQL Server una restricción UNIQUE admite UN SOLO NULL en toda la tabla
   * (Postgres, el de producción, admite cualquier cantidad). Toda fila
   * pendiente nace con proveedorRef NULL, así que en la base local alcanza con
   * que OTRO negocio tenga un cobro pendiente para que no se pueda crear
   * ninguno más. No es lo que se prueba acá: en SQL Server las filas de esta
   * suite nacen con una referencia de relleno única, que nunca coincide con la
   * de un cobro de Mercado Pago y por eso no cambia qué fila se elige.
   */
  const createOriginal = SubscriptionPayment.create;
  let relleno = 0;
  if (db.getDialect() === 'mssql') {
    SubscriptionPayment.create = function (valores, ...resto) {
      const v = valores?.proveedorRef == null
        ? { ...valores, proveedorRef: `QA-RELLENO-${process.pid}-${(relleno += 1)}` }
        : valores;
      return createOriginal.call(this, v, ...resto);
    };
  }

  async function limpiar() {
    const restos = await Business.findAll({ where: { [Op.or]: [{ email: EMAIL }, { cuit: CUIT }] } });
    for (const b of restos) {
      await SubscriptionPayment.destroy({ where: { businessId: b.id } });
      await Subscription.destroy({ where: { businessId: b.id } });
      await b.destroy();
    }
  }
  await limpiar();

  const negocio = await Business.create({
    nombreNegocio: 'QA Cambio de plan', ownerNombre: 'QA', ownerApellido: 'Planes',
    cuit: CUIT, email: EMAIL, passwordHash: 'x',
  });
  await planService.iniciarTrial(negocio.id, { plan: 'pro' });
  const sub = await Subscription.findOne({ where: { businessId: negocio.id } });

  const [inicial, pro, superior] = await Promise.all(
    ['inicial', 'pro', 'superior'].map((codigo) => Plan.findOne({ where: { codigo } })),
  );
  const ADMIN = { id: 0, rol: 'owner', email: 'qa.backoffice@stocker.test' };
  const auth = { businessId: negocio.id, type: 'business' };

  // Deja la suscripción en un estado conocido, sin pasar por la lógica probada.
  async function poner(plan, { vence = enDias(20), estado = 'activa', pendiente = null, pendienteDesde = null } = {}) {
    await Subscription.update({
      planId: plan.id, estado, periodoInicio: enDias(-10), periodoFin: vence,
      planPendienteId: pendiente?.id || null, planPendienteDesde: pendienteDesde,
      precioAcordado: null, descuentoPct: 0,
    }, { where: { id: sub.id } });
    await SubscriptionPayment.destroy({ where: { businessId: negocio.id } });
    return Subscription.findByPk(sub.id);
  }
  const leer = () => Subscription.findByPk(sub.id);

  const originales = {
    consultarPago: mp.consultarPago, firmaValida: mp.firmaValida, estaConfigurado: mp.estaConfigurado,
    buscarPagosDe: mp.buscarPagosDe, crearLinkDePago: mp.crearLinkDePago, planFindByPk: Plan.findByPk,
  };
  /*
   * Ensancha la ventana entre que acreditarPago lee la suscripción y la
   * escribe: la búsqueda del plan dentro de la transacción tarda `ms`. Sin
   * esto las carreras dependen de la suerte del planificador.
   */
  function demorarPlanes(ms) {
    Plan.findByPk = async function (...args) {
      if (args[1]?.transaction) await dormir(ms);
      return originales.planFindByPk.apply(this, args);
    };
  }
  const sinDemora = () => { Plan.findByPk = originales.planFindByPk; };

  try {
    // ─────────────────────────────────────────────────────────────
    tit('1. SUBIR APLICA EN EL MOMENTO');
    let s = await poner(pro);
    const venciaPro = s.periodoFin;
    let r = await planService.acreditarPago({ subscription: s, planId: superior.id });
    s = await leer();
    chk('el plan ya es el Superior', superior.id, s.planId);
    chk('no queda nada pendiente', null, s.planPendienteId);
    chk('dice que subió', 'sube', r.cambio);
    chk('el período se extiende desde el vencimiento anterior', true, mismoInstante(s.periodoFin, enDias(30, new Date(venciaPro).getTime())));

    let est = await planService.estadoDe(negocio.id);
    chk('estadoDe ve el Superior', 'superior', est.plan?.codigo);
    const uso = await planService.usoDe(negocio.id);
    chk('el tope de empleados ya es el del Superior', superior.maxEmpleados, uso.empleados.tope);
    chk('y el de locales', superior.maxLocales, uso.locales.tope);
    chk('y el de CUIT', superior.maxCuits, uso.cuits.tope);
    chk('y el de SKU', superior.maxSkus, uso.skus.tope);
    chk('y el de comprobantes', superior.maxComprobantes, uso.comprobantes.tope);
    const fSup = Object.keys(superior.features || {}).find((f) => superior.features[f] && !pro.features?.[f]);
    if (fSup) {
      chk(`y las funciones: "${fSup}" (del Superior, no del Pro) ya está`, true, await planService.tieneFeature(negocio.id, fSup));
    }

    // ─────────────────────────────────────────────────────────────
    tit('2. BAJAR ESPERA AL FIN DEL PERÍODO PAGO');
    s = await poner(superior);
    const venciaSup = s.periodoFin;
    r = await planService.acreditarPago({ subscription: s, planId: pro.id });
    s = await leer();
    chk('sigue en el Superior', superior.id, s.planId);
    chk('el Pro queda pendiente', pro.id, s.planPendienteId);
    chk('desde que termina lo pagado con el Superior', true, mismoInstante(s.planPendienteDesde, venciaSup));
    chk('dice que bajó', 'baja', r.cambio);
    chk('el período nuevo arranca ahí y dura 30 días', true, mismoInstante(s.periodoFin, enDias(30, new Date(venciaSup).getTime())));
    chk('el recibo de ese período es del Pro', pro.id, r.planDelPeriodo);

    est = await planService.estadoDe(negocio.id);
    chk('estadoDe todavía da el Superior', 'superior', est.plan?.codigo);
    chk('y avisa el Pro pendiente', 'pro', est.planPendiente?.codigo);
    chk('los topes siguen siendo los del Superior mientras tanto', superior.maxEmpleados,
      (await planService.usoDe(negocio.id)).empleados.tope);

    // Llega la fecha: se simula corriendo la fecha pendiente al pasado.
    await Subscription.update({ planPendienteDesde: enDias(-0.01) }, { where: { id: sub.id } });
    est = await planService.estadoDe(negocio.id);
    chk('llegada la fecha, estadoDe ya da el Pro', 'pro', est.plan?.codigo);
    chk('y no queda pendiente', null, est.planPendiente);
    chk('los topes pasan a ser los del Pro', pro.maxEmpleados, (await planService.usoDe(negocio.id)).empleados.tope);
    s = await leer();
    chk('quedó escrito en la base, no sólo en la respuesta', [pro.id, null], [s.planId, s.planPendienteId]);

    tit('2b. Bajar sin período pago en curso aplica ya');
    s = await poner(superior, { vence: enDias(-1), estado: 'activa' });   // vencida, en gracia
    r = await planService.acreditarPago({ subscription: s, planId: pro.id });
    s = await leer();
    chk('vencida: el Pro rige desde hoy', [pro.id, null], [s.planId, s.planPendienteId]);

    tit('2c. Una segunda bajada no corre la fecha');
    s = await poner(superior);
    const fecha1 = s.periodoFin;
    await planService.acreditarPago({ subscription: s, planId: pro.id });
    await planService.acreditarPago({ subscription: await leer(), planId: inicial.id });
    s = await leer();
    chk('pendiente pasa a ser el Inicial', inicial.id, s.planPendienteId);
    chk('desde la misma fecha que la primera bajada', true, mismoInstante(s.planPendienteDesde, fecha1));
    chk('el Superior sigue vigente', superior.id, s.planId);

    tit('2d. Renovar sin plan no cancela la bajada');
    await planService.acreditarPago({ subscription: s });
    s = await leer();
    chk('la bajada sigue en pie con su fecha', [inicial.id, true], [s.planPendienteId, mismoInstante(s.planPendienteDesde, fecha1)]);

    // ─────────────────────────────────────────────────────────────
    tit('3. EL MISMO PLAN SÓLO EXTIENDE');
    s = await poner(pro);
    const venceAntes = s.periodoFin;
    r = await planService.acreditarPago({ subscription: s, planId: pro.id });
    s = await leer();
    chk('sigue en el Pro', pro.id, s.planId);
    chk('dice igual', 'igual', r.cambio);
    chk('30 días más', true, mismoInstante(s.periodoFin, enDias(30, new Date(venceAntes).getTime())));

    // ─────────────────────────────────────────────────────────────
    tit('4. UN PAGO SIN PLAN SE COMPORTA COMO ANTES');
    s = await poner(pro);
    r = await planService.acreditarPago({ subscription: s });
    s = await leer();
    chk('no toca el plan', [pro.id, null, null], [s.planId, s.planPendienteId, r.cambio]);
    chk('sólo extiende', true, mismoInstante(s.periodoFin, enDias(30, new Date(venceAntes).getTime())));
    chk('y deja la cuenta activa', 'activa', s.estado);

    // ─────────────────────────────────────────────────────────────
    tit('5. BACKOFFICE: ACREDITAR UNA TRANSFERENCIA');
    s = await poner(pro);
    const transf = await SubscriptionPayment.create({
      businessId: negocio.id, subscriptionId: sub.id, planId: superior.id,
      monto: 1234.5, estado: 'pendiente', metodo: 'transferencia',
    });
    let resp = await llamar(backoffice.aprobarPago, { params: { id: transf.id }, admin: ADMIN });
    s = await leer();
    chk('responde 200', 200, resp.status);
    chk('aplica el plan del pago', superior.id, s.planId);
    chk('y lo dice', ['sube', 'superior'], [resp.json?.plan?.cambio, resp.json?.plan?.vigente?.codigo]);
    resp = await llamar(backoffice.aprobarPago, { params: { id: transf.id }, admin: ADMIN });
    chk('acreditarla otra vez da 409', 409, resp.status);

    tit('5b. Backoffice: una bajada por transferencia queda pendiente');
    s = await poner(superior);
    const transfBaja = await SubscriptionPayment.create({
      businessId: negocio.id, subscriptionId: sub.id, planId: inicial.id,
      monto: 10, estado: 'pendiente', metodo: 'transferencia',
    });
    resp = await llamar(backoffice.aprobarPago, { params: { id: transfBaja.id }, admin: ADMIN });
    s = await leer();
    chk('sigue en Superior con el Inicial pendiente', [superior.id, inicial.id], [s.planId, s.planPendienteId]);
    chk('y la respuesta lo dice', ['baja', 'inicial'], [resp.json?.plan?.cambio, resp.json?.plan?.pendiente?.codigo]);

    tit('5c. Backoffice: poner un plan a mano borra la bajada programada');
    resp = await llamar(backoffice.editarSuscripcion, {
      params: { id: negocio.id }, admin: ADMIN, body: { plan: 'pro' },
    });
    s = await leer();
    chk('queda en el Pro y sin pendiente', [200, pro.id, null], [resp.status, s.planId, s.planPendienteId]);

    tit('5d. Backoffice: extender días no cambia el plan');
    s = await poner(pro, { pendiente: inicial, pendienteDesde: enDias(20) });
    const venceExt = s.periodoFin;
    resp = await llamar(backoffice.editarSuscripcion, {
      params: { id: negocio.id }, admin: ADMIN, body: { extenderDias: 5 },
    });
    s = await leer();
    chk('5 días más', [200, true], [resp.status, mismoInstante(s.periodoFin, enDias(5, new Date(venceExt).getTime()))]);
    chk('el plan y la bajada siguen igual', [pro.id, inicial.id], [s.planId, s.planPendienteId]);

    // ─────────────────────────────────────────────────────────────
    tit('6. MERCADO PAGO: EL WEBHOOK APLICA EL PLAN DEL CHECKOUT');
    s = await poner(pro);
    const checkout = await SubscriptionPayment.create({
      businessId: negocio.id, subscriptionId: sub.id, planId: superior.id,
      monto: 178000, estado: 'pendiente', metodo: 'mercadopago', linkPago: 'https://example.invalid/pagar',
    });
    const cobro = (id, monto, fecha = new Date()) => ({
      id, estado: 'approved', monto, metodo: 'account_money', fecha: fecha.toISOString(),
      referencia: { businessId: negocio.id, subscriptionId: sub.id },
    });
    mp.firmaValida = () => true;
    mp.consultarPago = async (id) => cobro(String(id), 178000);
    const webhook = (id) => billing.webhookMercadoPago(
      { body: { type: 'payment', data: { id } }, query: {}, headers: {} },
      { status() { return this; }, json() { return this; } },
    );
    await webhook('QA-MP-1');
    s = await leer();
    chk('el plan es el Superior', superior.id, s.planId);
    const filaCheckout = await SubscriptionPayment.findByPk(checkout.id);
    chk('la fila del checkout queda aprobada con la referencia', ['aprobado', 'QA-MP-1'], [filaCheckout.estado, filaCheckout.proveedorRef]);
    chk('no se crea una fila de más', 1, await SubscriptionPayment.count({ where: { businessId: negocio.id } }));
    const venceWebhook = s.periodoFin;
    await webhook('QA-MP-1');
    s = await leer();
    chk('el mismo aviso otra vez no suma otro mes', true, mismoInstante(s.periodoFin, venceWebhook));

    tit('6b. Con dos links abiertos se acredita el que se pagó');
    s = await poner(pro);
    await SubscriptionPayment.create({
      businessId: negocio.id, subscriptionId: sub.id, planId: superior.id,
      monto: 178000, estado: 'pendiente', metodo: 'mercadopago', fecha: enDias(-0.02),
    });
    const linkPro = await SubscriptionPayment.create({
      businessId: negocio.id, subscriptionId: sub.id, planId: inicial.id,
      monto: 48400, estado: 'pendiente', metodo: 'mercadopago', fecha: enDias(-0.01),
    });
    await webhook('QA-MP-2');      // paga 178000: el del Superior, que es el más viejo
    s = await leer();
    chk('se aplica el Superior, no el link más nuevo', [superior.id, null], [s.planId, s.planPendienteId]);
    chk('el link del Inicial sigue pendiente', 'pendiente', (await SubscriptionPayment.findByPk(linkPro.id)).estado);

    tit('6c. Un débito sin pedido de cambio sólo extiende');
    s = await poner(superior, { pendiente: pro, pendienteDesde: enDias(20) });
    mp.consultarPago = async (id) => cobro(String(id), 999);
    await webhook('QA-MP-3');
    s = await leer();
    chk('plan y bajada intactos', [superior.id, pro.id], [s.planId, s.planPendienteId]);
    const filaDebito = await SubscriptionPayment.findOne({ where: { proveedorRef: 'QA-MP-3' } });
    chk('el cobro queda registrado con el plan de su período', [true, pro.id], [Boolean(filaDebito), filaDebito?.planId]);

    // ─────────────────────────────────────────────────────────────
    tit('7. "YA PAGUÉ": VARIOS COBROS, DEL MÁS VIEJO AL MÁS NUEVO');
    /*
     * Pagó primero el Superior y después el Inicial. En orden, la cuenta queda
     * en el Superior con el Inicial pendiente. Al revés (como los devuelve
     * Mercado Pago) quedaría en el Superior SIN la bajada que pagó último.
     */
    s = await poner(pro);
    await SubscriptionPayment.create({
      businessId: negocio.id, subscriptionId: sub.id, planId: superior.id,
      monto: 178000, estado: 'pendiente', metodo: 'mercadopago', fecha: enDias(-0.2),
    });
    await SubscriptionPayment.create({
      businessId: negocio.id, subscriptionId: sub.id, planId: inicial.id,
      monto: 48400, estado: 'pendiente', metodo: 'mercadopago', fecha: enDias(-0.1),
    });
    mp.estaConfigurado = () => true;
    mp.buscarPagosDe = async () => [
      cobro('QA-MP-5', 48400, enDias(-0.1)),       // el más nuevo primero, como MP
      cobro('QA-MP-4', 178000, enDias(-0.2)),
    ];
    resp = await llamar(billing.verificarPagos, { auth });
    s = await leer();
    chk('acredita los dos', [200, 2], [resp.status, resp.json?.acreditados]);
    chk('queda en el Superior con el Inicial pendiente', [superior.id, inicial.id], [s.planId, s.planPendienteId]);
    chk('el mensaje cuenta la bajada', true, /pasás al Plan Inicial/.test(resp.json?.message || ''));
    resp = await llamar(billing.verificarPagos, { auth });
    chk('tocarlo de nuevo no acredita nada', 0, resp.json?.acreditados);

    // ─────────────────────────────────────────────────────────────
    tit('8. CHECKOUT Y TRANSFERENCIA ANOTAN EL PLAN ELEGIDO');
    mp.crearLinkDePago = async () => ({ id: 'pref-qa', initPoint: 'https://example.invalid/pagar' });
    s = await poner(pro);
    resp = await llamar(billing.crearCheckout, { auth, body: { plan: 'superior' } });
    let fila = await SubscriptionPayment.findOne({ where: { businessId: negocio.id }, order: [['id', 'DESC']] });
    chk('checkout al Superior: la fila lleva el Superior', [201, superior.id], [resp.status, fila?.planId]);

    s = await poner(superior, { pendiente: pro, pendienteDesde: enDias(20) });
    resp = await llamar(billing.crearCheckout, { auth, body: {} });
    fila = await SubscriptionPayment.findOne({ where: { businessId: negocio.id }, order: [['id', 'DESC']] });
    chk('renovar con una bajada esperando paga el plan con el que sigue', pro.id, fila?.planId);

    resp = await llamar(billing.informarTransferencia, { auth, body: { plan: 'inicial' } });
    fila = await SubscriptionPayment.findOne({ where: { businessId: negocio.id }, order: [['id', 'DESC']] });
    chk('la transferencia lleva el plan elegido', [201, inicial.id, 'transferencia'], [resp.status, fila?.planId, fila?.metodo]);

    s = await poner(pro);
    await Subscription.update({ precioAcordado: 50000 }, { where: { id: sub.id } });
    resp = await llamar(billing.crearCheckout, { auth, body: { plan: 'superior' } });
    chk('con precio acordado, cambiar de plan solo no se puede', [409, 'precio_acordado'], [resp.status, resp.json?.motivo]);
    resp = await llamar(billing.informarTransferencia, { auth, body: { plan: 'superior' } });
    chk('tampoco por transferencia', [409, 'precio_acordado'], [resp.status, resp.json?.motivo]);
    resp = await llamar(billing.crearCheckout, { auth, body: {} });
    chk('pero renovar su plan al precio acordado sí', 201, resp.status);
    await Subscription.update({ precioAcordado: null }, { where: { id: sub.id } });

    resp = await llamar(billing.getSuscripcion, { auth });
    chk('getSuscripcion trae planPendiente (null si no hay)', true, 'planPendiente' in (resp.json || {}));

    // ─────────────────────────────────────────────────────────────
    tit('9. CARRERA: DOS PAGOS A LA VEZ');
    /*
     * Los dos leían el mismo periodoFin y sumaban 30 días sobre él: dos meses
     * pagos, uno acreditado. Con la fila trabada el segundo suma sobre el
     * primero.
     */
    s = await poner(pro);
    const venceCarrera = s.periodoFin;
    demorarPlanes(400);
    try {
      await Promise.all([
        planService.acreditarPago({ subscription: s, planId: superior.id }),
        planService.acreditarPago({ subscription: s, planId: superior.id }),
      ]);
    } finally { sinDemora(); }
    s = await leer();
    chk('dos pagos = 60 días', true, mismoInstante(s.periodoFin, enDias(60, new Date(venceCarrera).getTime())));

    tit('10. CARRERA: UN PAGO MIENTRAS RIGE LA BAJADA');
    /*
     * El Inicial tenía que regir desde hace un minuto y nadie lo aplicó
     * todavía. Entra un pago del Superior (sube) y, a la vez, una consulta que
     * aplicaría la bajada. La consulta lee antes de que el pago escriba, y
     * escribe después: si el UPDATE no lleva la condición entera, pisa la
     * subida recién pagada con la bajada vieja.
     */
    s = await poner(pro, { pendiente: inicial, pendienteDesde: enDias(-1 / 1440) });
    demorarPlanes(500);
    try {
      const pagoEnCurso = planService.acreditarPago({ subscription: s, planId: superior.id });
      await dormir(150);
      const consulta = planService.estadoDe(negocio.id);
      await Promise.all([pagoEnCurso, consulta]);
    } finally { sinDemora(); }
    s = await leer();
    chk('gana la subida pagada', [superior.id, null], [s.planId, s.planPendienteId]);

    tit('11. CARRERA: DOS CLICS EN "ACREDITAR"');
    s = await poner(pro);
    const venceClics = s.periodoFin;
    const doble = await SubscriptionPayment.create({
      businessId: negocio.id, subscriptionId: sub.id, planId: superior.id,
      monto: 178000, estado: 'pendiente', metodo: 'transferencia',
    });
    demorarPlanes(400);
    let clics;
    try {
      clics = await Promise.all([
        llamar(backoffice.aprobarPago, { params: { id: doble.id }, admin: ADMIN }),
        llamar(backoffice.aprobarPago, { params: { id: doble.id }, admin: ADMIN }),
      ]);
    } finally { sinDemora(); }
    s = await leer();
    chk('uno acredita y el otro da 409', [200, 409], clics.map((c) => c.status).sort());
    chk('un solo mes', true, mismoInstante(s.periodoFin, enDias(30, new Date(venceClics).getTime())));

    tit('12. CARRERA: EL WEBHOOK Y "YA PAGUÉ" CON EL MISMO COBRO');
    s = await poner(pro);
    const venceMp = s.periodoFin;
    await SubscriptionPayment.create({
      businessId: negocio.id, subscriptionId: sub.id, planId: superior.id,
      monto: 178000, estado: 'pendiente', metodo: 'mercadopago',
    });
    mp.consultarPago = async (id) => cobro(String(id), 178000);
    mp.buscarPagosDe = async () => [cobro('QA-MP-6', 178000)];
    demorarPlanes(400);
    let ambos;
    try {
      ambos = await Promise.all([
        webhook('QA-MP-6').then(() => 'ok', (e) => e.message),
        llamar(billing.verificarPagos, { auth }),
      ]);
    } finally { sinDemora(); }
    s = await leer();
    chk('"Ya pagué" contesta bien (no un 500)', 200, ambos[1].status);
    chk('un solo mes', true, mismoInstante(s.periodoFin, enDias(30, new Date(venceMp).getTime())));
    chk('una sola fila aprobada', 1, await SubscriptionPayment.count({
      where: { businessId: negocio.id, proveedorRef: 'QA-MP-6', estado: 'aprobado' },
    }));
  } finally {
    Object.assign(mp, {
      consultarPago: originales.consultarPago, firmaValida: originales.firmaValida,
      estaConfigurado: originales.estaConfigurado, buscarPagosDe: originales.buscarPagosDe,
      crearLinkDePago: originales.crearLinkDePago,
    });
    sinDemora();
    SubscriptionPayment.create = createOriginal;
    await limpiar();
    await db.close();
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m`);
  console.log(`  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
