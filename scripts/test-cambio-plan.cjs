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
 * Segunda vuelta (decisiones 18, 19 y 20 del dueño y la revisión):
 *   13. Prorrateo: al subir con un período pago corriendo se cobra SÓLO la
 *       diferencia por los días que quedan y el vencimiento no se mueve.
 *   14. Transferencia: el importe lo pone Stocker y al acreditarla se compara.
 *   15. Bajar con empleados de más: el dueño elige quiénes siguen; los demás
 *       quedan suspendidos por el plan cuando la bajada RIGE.
 *   16. Débito automático: su monto sigue al plan con el que la cuenta sigue.
 * Algunas comprobaciones de la primera vuelta cambiaron porque la regla cambió
 * (están marcadas con "decisión 18" o con el hallazgo que las corrige).
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
    Business, Plan, Subscription, SubscriptionPayment, Employee, SesionCuenta, AuthAttempt,
  } = require('../src/models');
  const planService = require('../src/services/planService');
  const mp = require('../src/services/mercadopagoService');
  const sesiones = require('../src/services/sesionesService');
  const billing = require('../src/controllers/billingController');
  const backoffice = require('../src/controllers/backofficeController');
  const empleadosCtrl = require('../src/controllers/employeeController');
  const authCtrl = require('../src/controllers/authController');
  const { requireAuth } = require('../src/middleware/auth');

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
    // Los empleados de prueba por su email, aunque haya quedado un negocio a medias.
    await AuthAttempt.destroy({ where: { identificador: { [Op.like]: 'qa.cp.emp%@stocker.test' } } });
    await Employee.destroy({ where: { email: { [Op.like]: 'qa.cp.emp%@stocker.test' } } });
    for (const b of restos) {
      await SesionCuenta.destroy({ where: { businessId: b.id } });
      await Employee.destroy({ where: { businessId: b.id } });
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
      // Sin débito automático ni elección de empleados, salvo que la prueba los ponga.
      planPendienteSuspender: null, metodoPago: null, proveedorRef: null,
      debitoMonto: null, debitoPendienteDesde: null, renovacionAutomatica: true,
    }, { where: { id: sub.id } });
    await SubscriptionPayment.destroy({ where: { businessId: negocio.id } });
    return Subscription.findByPk(sub.id);
  }
  const leer = () => Subscription.findByPk(sub.id);

  const originales = {
    consultarPago: mp.consultarPago, firmaValida: mp.firmaValida, estaConfigurado: mp.estaConfigurado,
    buscarPagosDe: mp.buscarPagosDe, crearLinkDePago: mp.crearLinkDePago, planFindByPk: Plan.findByPk,
    actualizarMontoRecurrente: mp.actualizarMontoRecurrente,
    cancelarSuscripcionRecurrente: mp.cancelarSuscripcionRecurrente,
    crearSuscripcionRecurrente: mp.crearSuscripcionRecurrente,
  };
  /*
   * Mercado Pago simulado también para el débito: ninguna prueba le pega a la
   * API de verdad. Si algo intenta actualizar un débito sin que la prueba lo
   * espere, queda anotado igual y la comprobación lo ve.
   */
  const llamadasMp = [];
  let mpFalla = false;
  mp.actualizarMontoRecurrente = async (id, { monto } = {}) => {
    if (mpFalla) throw new Error('Mercado Pago no contesta (simulado)');
    llamadasMp.push({ id, monto: Number(monto) });
    return { id };
  };
  const cancelados = [];
  let cancelarFalla = false;
  mp.cancelarSuscripcionRecurrente = async (id) => {
    if (cancelarFalla) throw Object.assign(new Error('Mercado Pago no respondió.'), { status: 502 });
    cancelados.push(id);
    return {};
  };
  mp.crearSuscripcionRecurrente = async () => ({ id: 'QA-PREAP-NUEVO', initPoint: 'https://example.invalid/debito' });
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
    // Con un período pago corriendo, subir es pagar la diferencia (decisión 18).
    let r = await planService.acreditarPago({ subscription: s, planId: superior.id, concepto: 'diferencia' });
    s = await leer();
    chk('el plan ya es el Superior', superior.id, s.planId);
    chk('no queda nada pendiente', null, s.planPendienteId);
    chk('dice que subió', 'sube', r.cambio);
    // Decisión 18: antes sumaba 30 días y convertía en Superior lo pagado como Pro.
    chk('el vencimiento no se mueve (decisión 18)', true, mismoInstante(s.periodoFin, venciaPro));

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

    /*
     * Corregida por la revisión (hallazgo MEDIO): antes esto pasaba el
     * pendiente al Inicial desde la misma fecha, y el mes que se había pagado
     * con el Pro quedaba del Inicial. Con una sola ranura no se puede
     * representar Superior → Pro → Inicial: el checkout lo rechaza (13e) y si
     * igual llega un pago así, no pisa nada y se acredita por lo que vale.
     */
    tit('2c. Una segunda bajada no pisa la primera');
    s = await poner(superior);
    const fecha1 = s.periodoFin;
    await planService.acreditarPago({ subscription: s, planId: pro.id });
    const fin2c = (await leer()).periodoFin;
    r = await planService.acreditarPago({ subscription: await leer(), planId: inicial.id });
    s = await leer();
    chk('lo pendiente sigue siendo el Pro', pro.id, s.planPendienteId);
    chk('desde la fecha de la primera bajada', true, mismoInstante(s.planPendienteDesde, fecha1));
    chk('el Superior sigue vigente', superior.id, s.planId);
    chk('el pago se vuelve días del Pro y queda para revisar', [true, true], [
      mismoInstante(s.periodoFin, enDias(Math.floor(30 * Number(inicial.precioMensual) / Number(pro.precioMensual)), new Date(fin2c).getTime())),
      Boolean(r.revisar),
    ]);

    tit('2d. Renovar sin plan no cancela la bajada');
    await planService.acreditarPago({ subscription: s });
    s = await leer();
    chk('la bajada sigue en pie con su fecha', [pro.id, true], [s.planPendienteId, mismoInstante(s.planPendienteDesde, fecha1)]);

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
    // Hallazgo MEDIO: 1.234,50 no alcanza para el Superior; antes se aplicaba igual.
    let resp = await llamar(backoffice.aprobarPago, { params: { id: transf.id }, admin: ADMIN });
    chk('con un importe que no alcanza, primero pregunta (409)', [409, 'monto_no_coincide'], [resp.status, resp.json?.motivo]);
    resp = await llamar(backoffice.aprobarPago, { params: { id: transf.id }, admin: ADMIN, body: { aceptarDiferencia: true } });
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
    chk('10 pesos por el Inicial: pregunta antes (409)', 409, resp.status);
    // El operador ve en el banco el precio entero del Inicial.
    resp = await llamar(backoffice.aprobarPago, {
      params: { id: transfBaja.id }, admin: ADMIN, body: { montoRecibido: Number(inicial.precioMensual) },
    });
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

    // Con el Pro ya programado, el plan que se puede pagar es el Pro (13e: otro más bajo, no).
    resp = await llamar(billing.informarTransferencia, { auth, body: { plan: 'pro' } });
    fila = await SubscriptionPayment.findOne({ where: { businessId: negocio.id }, order: [['id', 'DESC']] });
    chk('la transferencia lleva el plan elegido', [201, pro.id, 'transferencia'], [resp.status, fila?.planId, fila?.metodo]);

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
    // Dos meses del mismo plan: con el prorrateo, subir ya no suma 30 días.
    s = await poner(pro);
    const venceCarrera = s.periodoFin;
    demorarPlanes(400);
    try {
      await Promise.all([
        planService.acreditarPago({ subscription: s, planId: pro.id }),
        planService.acreditarPago({ subscription: s, planId: pro.id }),
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
    // Una renovación: lo que se mide es que se acredite una sola vez.
    const doble = await SubscriptionPayment.create({
      businessId: negocio.id, subscriptionId: sub.id, planId: pro.id,
      monto: Number(pro.precioMensual), estado: 'pendiente', metodo: 'transferencia',
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
    // Una renovación: lo que se mide es que se acredite una sola vez.
    await SubscriptionPayment.create({
      businessId: negocio.id, subscriptionId: sub.id, planId: pro.id,
      monto: Number(pro.precioMensual), estado: 'pendiente', metodo: 'mercadopago',
    });
    mp.consultarPago = async (id) => cobro(String(id), Number(pro.precioMensual));
    mp.buscarPagosDe = async () => [cobro('QA-MP-6', Number(pro.precioMensual))];
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

    // ═════════════════════════════════════════════════════════════
    // Segunda vuelta
    // ═════════════════════════════════════════════════════════════
    const P = { ini: Number(inicial.precioMensual), pro: Number(pro.precioMensual), sup: Number(superior.precioMensual) };
    // La cuenta del prorrateo, escrita aparte de la del código para compararlas.
    const dif = (nuevo, viejo, dias) => (nuevo - viejo) * dias / 30;
    const cotizar = (plan) => llamar(billing.getCotizacion, { auth, query: { plan } });
    const ultimaFila = () => SubscriptionPayment.findOne({ where: { businessId: negocio.id }, order: [['id', 'DESC']] });
    let linkPedido = null;
    mp.crearLinkDePago = async (args) => { linkPedido = args; return { id: 'pref-qa', initPoint: 'https://example.invalid/pagar' }; };

    // ─────────────────────────────────────────────────────────────
    tit('13. PRORRATEO: AL SUBIR SE COBRA SÓLO LA DIFERENCIA (decisión 18)');
    s = await poner(pro, { vence: enDias(20) });
    const vence13 = s.periodoFin;
    const dif13 = Math.round(dif(P.sup, P.pro, 20));
    resp = await cotizar('superior');
    chk('cotiza una subida por diferencia', [200, 'subida', 'diferencia'], [resp.status, resp.json?.tipo, resp.json?.concepto]);
    chk('cobra (Superior − Pro) × 20 / 30, redondeado al peso', dif13, resp.json?.monto);
    chk('con el detalle: un tramo de 20 días del Pro', [1, 20, 'pro'], [
      resp.json?.detalle?.tramos?.length, resp.json?.detalle?.tramos?.[0]?.dias, resp.json?.detalle?.tramos?.[0]?.plan?.codigo,
    ]);
    chk('rige ya y el vencimiento no se mueve', [true, true], [
      Boolean(resp.json?.rige) && new Date(resp.json.rige) <= new Date(), mismoInstante(resp.json?.venceDespues, vence13),
    ]);

    await Subscription.update({ descuentoPct: 20 }, { where: { id: sub.id } });
    resp = await cotizar('superior');
    chk('con 20% de descuento la diferencia baja 20%', Math.round(dif(P.sup * 0.8, P.pro * 0.8, 20)), resp.json?.monto);
    // Hallazgo BAJO: el modal mostraba el precio de lista del plan elegido.
    chk('y el precio por mes que ve el modal es el del descuento', P.sup * 0.8, resp.json?.precioMensual);
    await Subscription.update({ descuentoPct: 0 }, { where: { id: sub.id } });

    resp = await llamar(billing.crearCheckout, { auth, body: { plan: 'superior' } });
    fila = await ultimaFila();
    chk('el checkout cobra la diferencia', [201, dif13, 'diferencia', dif13], [
      resp.status, Number(fila?.monto), fila?.concepto, Number(fila?.montoCotizado),
    ]);
    chk('el link de la diferencia vence en un día como mucho, y no después del período', true,
      Boolean(linkPedido?.venceEn) && new Date(linkPedido.venceEn) - Date.now() <= DIA + 5000 &&
      new Date(linkPedido.venceEn) <= new Date(vence13));
    resp = await llamar(billing.crearCheckout, { auth, body: { plan: 'superior', modo: 'recurrente' } });
    chk('una diferencia no se paga con débito mensual', [409, 'diferencia_unica'], [resp.status, resp.json?.motivo]);

    mp.consultarPago = async (id) => cobro(String(id), dif13);
    await webhook('QA-MP-13');
    s = await leer();
    chk('pagada la diferencia, rige el Superior', superior.id, s.planId);
    chk('y el vencimiento sigue donde estaba', true, mismoInstante(s.periodoFin, vence13));
    fila = await SubscriptionPayment.findOne({ where: { proveedorRef: 'QA-MP-13' } });
    chk('la fila cubre de hoy al vencimiento, sin nada para revisar', [true, true, null], [
      mismoInstante(fila?.periodoHasta, vence13), new Date(fila?.periodoDesde) <= new Date(), fila?.aRevisar,
    ]);

    tit('13b. Meses pagados por adelantado: subir los convierte, no los regala (hallazgo ALTO)');
    /*
     * El caso de la revisión: doce meses del Inicial y un solo pago del
     * Superior daban trece meses de Superior.
     */
    s = await poner(inicial, { vence: enDias(360) });
    let vence13b = s.periodoFin;
    const adelantado = Math.round(dif(P.sup, P.ini, 360));
    resp = await cotizar('superior');
    chk('pasar 360 días del Inicial al Superior cuesta la diferencia de los 360', adelantado, resp.json?.monto);
    r = await planService.acreditarPago({ subscription: s, planId: superior.id, concepto: 'periodo', monto: P.sup });
    s = await leer();
    chk('con un solo mes del Superior no sube', inicial.id, s.planId);
    chk('la plata no se pierde: vale días del Inicial', true,
      mismoInstante(s.periodoFin, enDias(Math.floor(30 * P.sup / P.ini), new Date(vence13b).getTime())));
    chk('y queda para revisar', true, Boolean(r.revisar));

    s = await poner(inicial, { vence: enDias(360) });
    vence13b = s.periodoFin;
    r = await planService.acreditarPago({ subscription: s, planId: superior.id, concepto: 'diferencia', monto: adelantado });
    s = await leer();
    chk('con la diferencia de los 360 días sí sube', [superior.id, 'sube'], [s.planId, r.cambio]);
    chk('y el vencimiento no se mueve', true, mismoInstante(s.periodoFin, vence13b));

    tit('13c. Sin período pago en curso se cobra el plan entero');
    await Subscription.update({
      estado: 'trial', trialFin: enDias(5), periodoInicio: null, periodoFin: null, planId: pro.id,
      planPendienteId: null, planPendienteDesde: null,
    }, { where: { id: sub.id } });
    resp = await cotizar('superior');
    chk('en la prueba: el plan entero, 30 días desde hoy', ['alta', 'periodo', P.sup, true], [
      resp.json?.tipo, resp.json?.concepto, resp.json?.monto, mismoInstante(resp.json?.venceDespues, enDias(30)),
    ]);
    s = await poner(pro, { vence: enDias(-2) });
    resp = await cotizar('superior');
    chk('vencida: el plan entero', ['alta', P.sup], [resp.json?.tipo, resp.json?.monto]);
    resp = await cotizar('inicial');
    chk('vencida, bajar también rige ya', ['alta', P.ini, true], [
      resp.json?.tipo, resp.json?.monto, Boolean(resp.json?.rige) && new Date(resp.json.rige) <= new Date(),
    ]);

    tit('13d. Con una bajada programada: seguir con el plan actual, o subir más');
    s = await poner(superior, { vence: enDias(40), pendiente: pro, pendienteDesde: enDias(10) });
    const vence13d = s.periodoFin;
    resp = await cotizar('superior');
    const seguir = Math.round(dif(P.sup, P.pro, 30));
    // Hallazgo BAJO: con una bajada programada no había forma de deshacerla.
    chk('seguir con el Superior: la diferencia del tramo pagado como Pro', ['seguir', 'diferencia', seguir], [
      resp.json?.tipo, resp.json?.concepto, resp.json?.monto,
    ]);
    r = await planService.acreditarPago({ subscription: s, planId: superior.id, concepto: 'diferencia', monto: seguir });
    s = await leer();
    chk('pagada, la bajada se cae y el vencimiento no se mueve', [superior.id, null, 'sigue', true], [
      s.planId, s.planPendienteId, r.cambio, mismoInstante(s.periodoFin, vence13d),
    ]);

    s = await poner(pro, { vence: enDias(40), pendiente: inicial, pendienteDesde: enDias(10) });
    resp = await cotizar('superior');
    chk('subir con una bajada programada: dos tramos, cada uno con su precio', [
      2, [10, 30], ['pro', 'inicial'], Math.round(dif(P.sup, P.pro, 10) + dif(P.sup, P.ini, 30)),
    ], [
      resp.json?.detalle?.tramos?.length, resp.json?.detalle?.tramos?.map((t) => t.dias),
      resp.json?.detalle?.tramos?.map((t) => t.plan.codigo), resp.json?.monto,
    ]);

    tit('13e. Una segunda bajada se rechaza antes de cobrar (hallazgo MEDIO)');
    s = await poner(superior, { vence: enDias(40), pendiente: pro, pendienteDesde: enDias(10) });
    resp = await llamar(billing.crearCheckout, { auth, body: { plan: 'inicial' } });
    chk('el checkout dice que ya hay un cambio programado', [409, 'cambio_pendiente'], [resp.status, resp.json?.motivo]);
    resp = await llamar(billing.informarTransferencia, { auth, body: { plan: 'inicial' } });
    chk('la transferencia también', [409, 'cambio_pendiente'], [resp.status, resp.json?.motivo]);
    chk('y no queda ninguna fila', 0, await SubscriptionPayment.count({ where: { businessId: negocio.id } }));
    resp = await cotizar('pro');
    chk('renovar el plan programado sí se puede', [200, 'renovacion', P.pro], [resp.status, resp.json?.tipo, resp.json?.monto]);

    tit('13f. CARRERA: dos diferencias pagadas a la vez');
    s = await poner(pro, { vence: enDias(20) });
    const vence13f = s.periodoFin;
    demorarPlanes(400);
    let dos;
    try {
      dos = await Promise.all([
        planService.acreditarPago({ subscription: s, planId: superior.id, concepto: 'diferencia', monto: dif13 }),
        planService.acreditarPago({ subscription: s, planId: superior.id, concepto: 'diferencia', monto: dif13 }),
      ]);
    } finally { sinDemora(); }
    s = await leer();
    chk('una sola sube', [superior.id, 1], [s.planId, dos.filter((x) => x.cambio === 'sube').length]);
    chk('la otra no se pierde ni se regala: vale días del Superior', true,
      mismoInstante(s.periodoFin, enDias(Math.floor(30 * dif13 / P.sup), new Date(vence13f).getTime())));
    chk('y queda para revisar', 1, dos.filter((x) => x.revisar).length);

    tit('13g. Una diferencia que llega con el período ya vencido');
    s = await poner(pro, { vence: enDias(-1) });
    r = await planService.acreditarPago({ subscription: s, planId: superior.id, concepto: 'diferencia', monto: dif13 });
    s = await leer();
    chk('rige el Superior, que es lo que pagó', superior.id, s.planId);
    chk('por los días que vale lo que entró, desde hoy (no un mes)', true,
      mismoInstante(s.periodoFin, enDias(Math.floor(30 * dif13 / P.sup))));
    chk('y queda para revisar', true, Boolean(r.revisar));

    tit('13h. Un pago del plan entero que se cruzó con una subida');
    s = await poner(pro, { vence: enDias(20) });
    const vence13h = s.periodoFin;
    r = await planService.acreditarPago({ subscription: s, planId: superior.id, concepto: 'periodo', monto: P.sup });
    s = await leer();
    chk('sube, y lo que sobra de la diferencia se vuelve días del Superior', [superior.id, true], [
      s.planId,
      mismoInstante(s.periodoFin, enDias(Math.floor(30 * (P.sup - dif(P.sup, P.pro, 20)) / P.sup), new Date(vence13h).getTime())),
    ]);

    // ─────────────────────────────────────────────────────────────
    tit('14. TRANSFERENCIA: EL IMPORTE LO PONE STOCKER Y SE COMPARA AL ACREDITAR (hallazgo MEDIO)');
    s = await poner(pro, { vence: enDias(20) });
    resp = await llamar(billing.informarTransferencia, { auth, body: { plan: 'superior', monto: P.ini } });
    fila = await ultimaFila();
    chk('el monto que manda el navegador se ignora', [201, dif13, 'diferencia', dif13], [
      resp.status, Number(fila?.monto), fila?.concepto, resp.json?.monto,
    ]);
    resp = await llamar(backoffice.aprobarPago, { params: { id: fila.id }, admin: ADMIN, body: { montoRecibido: P.ini } });
    s = await leer();
    chk('llegó el precio del Inicial: 409 con los dos números', [409, 'monto_no_coincide', dif13, P.ini], [
      resp.status, resp.json?.motivo, resp.json?.esperado, resp.json?.recibido,
    ]);
    chk('y no se tocó nada', [pro.id, 'pendiente'], [s.planId, (await SubscriptionPayment.findByPk(fila.id)).estado]);
    resp = await llamar(backoffice.aprobarPago, {
      params: { id: fila.id }, admin: ADMIN, body: { montoRecibido: P.ini, aceptarDiferencia: true },
    });
    s = await leer();
    const filaAceptada = await SubscriptionPayment.findByPk(fila.id);
    chk('si el operador lo acepta, se acredita y queda anotado quién', [200, superior.id, true], [
      resp.status, s.planId, /lo aceptó qa\.backoffice/.test(filaAceptada.aRevisar || ''),
    ]);
    chk('la fila guarda lo que entró y lo que se había cotizado', [P.ini, dif13], [
      Number(filaAceptada.monto), Number(filaAceptada.montoCotizado),
    ]);

    s = await poner(pro, { vence: enDias(20) });
    await llamar(billing.informarTransferencia, { auth, body: { plan: 'superior' } });
    fila = await ultimaFila();
    resp = await llamar(backoffice.aprobarPago, { params: { id: fila.id }, admin: ADMIN, body: { montoRecibido: dif13 } });
    s = await leer();
    chk('con el importe justo no pregunta', [200, superior.id, null], [resp.status, s.planId, resp.json?.revisar]);

    s = await poner(superior, { vence: enDias(20) });
    await llamar(billing.informarTransferencia, { auth, body: { plan: 'inicial' } });
    fila = await ultimaFila();
    resp = await llamar(backoffice.aprobarPago, { params: { id: fila.id }, admin: ADMIN, body: { montoRecibido: P.ini - 5000 } });
    chk('una bajada con menos que el plan entero también pregunta', [409, P.ini], [resp.status, resp.json?.esperado]);

    resp = await llamar(backoffice.verCuenta, { params: { id: negocio.id }, admin: ADMIN });
    const pendienteBo = resp.json?.pagos?.find((p) => p.id === fila.id);
    chk('la ficha muestra al lado del importe lo que corresponde hoy', [P.ini, 'bajada'], [
      pendienteBo?.corresponde?.esperado, pendienteBo?.corresponde?.tipo,
    ]);

    tit('14b. "Acreditar igual" un pago que no puede cambiar el plan: días de lo que entró');
    /*
     * Una transferencia del Inicial que quedó de antes con el Pro ya programado
     * (la cotización de hoy la rechazaría). El operador ve en el banco $20.000
     * y la acredita igual: se convierte en días del plan con el que sigue POR
     * LO QUE ENTRÓ, no por lo que se había cotizado.
     */
    s = await poner(superior, { vence: enDias(20), pendiente: pro, pendienteDesde: enDias(20) });
    const vence14b = s.periodoFin;
    const vieja = await SubscriptionPayment.create({
      businessId: negocio.id, subscriptionId: sub.id, planId: inicial.id,
      monto: P.ini, estado: 'pendiente', metodo: 'transferencia',
    });
    resp = await llamar(backoffice.aprobarPago, { params: { id: vieja.id }, admin: ADMIN, body: { montoRecibido: 20000 } });
    chk('primero avisa que no se puede aplicar como cambio', [409, null], [resp.status, resp.json?.esperado]);
    resp = await llamar(backoffice.aprobarPago, {
      params: { id: vieja.id }, admin: ADMIN, body: { montoRecibido: 20000, aceptarDiferencia: true },
    });
    s = await leer();
    chk('acreditado igual: el plan y la bajada no cambian', [200, superior.id, pro.id], [resp.status, s.planId, s.planPendienteId]);
    chk('y suma los días que valen los $20.000 en el Pro', true,
      mismoInstante(s.periodoFin, enDias(Math.floor(30 * 20000 / P.pro), new Date(vence14b).getTime())));

    // ─────────────────────────────────────────────────────────────
    tit('15. BAJAR CON EMPLEADOS DE MÁS: EL DUEÑO ELIGE QUIÉNES SIGUEN (decisión 19)');
    const bcrypt = require('bcryptjs');
    const CLAVE_EMP = 'QaCambioPlan2026!';
    const hashEmp = await bcrypt.hash(CLAVE_EMP, 4);
    const topeIni = Number(inicial.maxEmpleados);
    const cuantos = topeIni + 2;
    const emps = [];
    for (let i = 1; i <= cuantos; i += 1) {
      // El 1 es el que entró más recientemente; el último, el que hace más que no entra.
      emps.push(await Employee.create({
        businessId: negocio.id, nombre: `QA${i}`, apellido: 'Empleado', email: `qa.cp.emp${i}@stocker.test`,
        dni: `${3000000 + i}`, passwordHash: hashEmp, ultimaConexion: enDias(-i),
      }));
    }
    const ids = (lista) => lista.map((e) => e.id).sort((a, b) => a - b);
    const leerEmpleados = () => Employee.findAll({ where: { businessId: negocio.id }, order: [['id', 'ASC']] });

    s = await poner(superior, { vence: enDias(20) });
    resp = await cotizar('inicial');
    const exEmp = resp.json?.excesos?.find((x) => x.recurso === 'empleados');
    chk('cotiza la bajada', ['bajada', 'periodo', P.ini], [resp.json?.tipo, resp.json?.concepto, resp.json?.monto]);
    chk('avisa cuánto se pasa de usuarios', [cuantos, topeIni, 2], [exEmp?.usado, exEmp?.tope, exEmp?.exceso]);
    chk('y propone que sigan los de actividad más reciente', ids(emps.slice(0, topeIni)), [...(resp.json?.empleados?.sugeridos || [])].sort((a, b) => a - b));

    // El dueño elige otros: los que hace más que no entran.
    const quedan = emps.slice(cuantos - topeIni);
    const afuera = emps.slice(0, cuantos - topeIni);
    resp = await llamar(billing.crearCheckout, { auth, body: { plan: 'inicial', conservar: emps.slice(0, topeIni + 1).map((e) => e.id) } });
    chk('elegir más que el tope da 400', 400, resp.status);
    resp = await llamar(billing.crearCheckout, { auth, body: { plan: 'inicial', conservar: [quedan[0].id, 999999999] } });
    chk('elegir a alguien que no es de la cuenta da 400', 400, resp.status);
    resp = await llamar(billing.crearCheckout, { auth, body: { plan: 'inicial', conservar: quedan.map((e) => e.id) } });
    fila = await ultimaFila();
    chk('la elección viaja con el pago', [201, ids(afuera)], [resp.status, [...(JSON.parse(fila?.empleadosSuspender || '[]'))].sort((a, b) => a - b)]);

    const reqEmp = { headers: { 'user-agent': 'QA cambio de plan' }, ip: '203.0.113.50' };
    const tokens = {};
    for (const e of emps) {
      tokens[e.id] = await sesiones.abrir(reqEmp, { type: 'employee', businessId: negocio.id, employeeId: e.id, roleId: null, permisos: {} });
    }

    mp.consultarPago = async (id) => cobro(String(id), P.ini);
    await webhook('QA-MP-15');
    s = await leer();
    chk('pagada, la bajada queda programada', [superior.id, inicial.id], [s.planId, s.planPendienteId]);
    chk('nadie queda suspendido al pagar: el Superior está pago', cuantos,
      await Employee.count({ where: { businessId: negocio.id, activo: true } }));

    await Subscription.update({ planPendienteDesde: enDias(-0.001) }, { where: { id: sub.id } });
    await planService.estadoDe(negocio.id);
    let todos = await leerEmpleados();
    chk('rige: siguen los que eligió el dueño', ids(quedan), ids(todos.filter((e) => e.activo)));
    chk('los demás quedan suspendidos por el plan, no borrados', ids(afuera),
      ids(todos.filter((e) => !e.activo && e.suspendidoPorPlan)));
    chk('sus sesiones se cerraron, con motivo "plan"', afuera.length, await SesionCuenta.count({
      where: { businessId: negocio.id, employeeId: afuera.map((e) => e.id), motivoCierre: 'plan' },
    }));
    chk('las de los que siguen, abiertas', quedan.length, await SesionCuenta.count({
      where: { businessId: negocio.id, employeeId: quedan.map((e) => e.id), cerradaEn: null },
    }));

    const pasar = (token) => new Promise((resolve) => {
      const req = {
        headers: { authorization: `Bearer ${token}`, 'user-agent': 'QA' }, cookies: {},
        method: 'GET', path: '/products', ip: '203.0.113.50', body: {}, params: {}, query: {},
      };
      const res = {
        statusCode: 200, status(c) { this.statusCode = c; return this; },
        json(p) { resolve({ status: this.statusCode, json: p }); }, cookie() {}, getHeader() {}, setHeader() {},
      };
      requireAuth(req, res, (e) => resolve(e ? { status: 500, json: { message: e.message } } : { status: 'paso' }));
    });
    resp = await pasar(tokens[afuera[0].id]);
    chk('el suspendido queda afuera con un motivo claro', [401, 'SESION_SUSPENDIDA_PLAN'], [resp.status, resp.json?.codigo]);
    resp = await pasar(tokens[quedan[0].id]);
    chk('el que sigue, sigue', 'paso', resp.status);

    const entrar = (email, password) => llamar(authCtrl.employeeLogin, {
      body: { email, password }, headers: { 'user-agent': 'QA' }, ip: '203.0.113.51', cookies: {},
    });
    resp = await entrar(afuera[0].email, CLAVE_EMP);
    chk('su login se rechaza diciendo por qué', [403, 'EMPLEADO_SUSPENDIDO_PLAN'], [resp.status, resp.json?.codigo]);
    resp = await entrar(afuera[0].email, 'otra-clave-cualquiera');
    chk('sin la contraseña no se le dice nada', [401, undefined], [resp.status, resp.json?.codigo]);

    const uso15 = await planService.usoDe(negocio.id);
    chk('el tope cuenta sólo a los que siguen, y la pantalla sabe de los suspendidos', [topeIni, afuera.length], [
      uso15.empleados.usado, uso15.empleados.suspendidosPorPlan,
    ]);
    resp = await llamar(empleadosCtrl.getEmployees, { auth });
    chk('la lista de Empleados los marca suspendidos por el plan', ids(afuera),
      ids((resp.json || []).filter((e) => e.suspendidoPorPlan)));

    resp = await llamar(empleadosCtrl.toggleActive, { auth, params: { id: afuera[0].id } });
    chk('activarlo sin lugar da 409', 409, resp.status);
    resp = await llamar(empleadosCtrl.updateEmployee, { auth, params: { id: afuera[0].id }, body: { activo: true } });
    chk('y por la edición tampoco (antes `activo: true` esquivaba el tope)', 409, resp.status);
    resp = await llamar(empleadosCtrl.updateEmployee, { auth, params: { id: afuera[0].id }, body: { activo: false, telefono: '1100000000' } });
    chk('editarlo reenviando el mismo estado no le borra la marca del plan', [200, false, true], [
      resp.status, resp.json?.activo, resp.json?.suspendidoPorPlan,
    ]);

    // Libera un lugar apagando a mano a uno que seguía, y usa a un suspendido.
    resp = await llamar(empleadosCtrl.toggleActive, { auth, params: { id: quedan[0].id } });
    chk('el dueño apaga a uno a mano', [200, false, false], [resp.status, resp.json?.activo, resp.json?.suspendidoPorPlan]);
    resp = await llamar(empleadosCtrl.toggleActive, { auth, params: { id: afuera[0].id } });
    chk('y en ese lugar vuelve a usar a un suspendido', [200, true, false], [resp.status, resp.json?.activo, resp.json?.suspendidoPorPlan]);

    // Sube de plan: vuelven solos los suspendidos por el plan.
    s = await leer();
    resp = await cotizar('superior');
    await planService.acreditarPago({ subscription: s, planId: superior.id, concepto: 'diferencia', monto: resp.json?.monto });
    todos = await leerEmpleados();
    chk('al subir vuelven solos los suspendidos por el plan', ids(afuera), ids(todos.filter((e) => afuera.some((a) => a.id === e.id) && e.activo)));
    chk('el que el dueño apagó a mano sigue apagado', [false, false], [
      todos.find((e) => e.id === quedan[0].id)?.activo, todos.find((e) => e.id === quedan[0].id)?.suspendidoPorPlan,
    ]);

    tit('15b. Una bajada que hace un operador: siguen los de actividad más reciente');
    await Employee.update({ activo: true, suspendidoPorPlan: false }, { where: { businessId: negocio.id } });
    // requireAuth anotó la conexión de los que pasaron arriba: se vuelve al orden de la prueba.
    for (const [i, e] of emps.entries()) await Employee.update({ ultimaConexion: enDias(-(i + 1)) }, { where: { id: e.id } });
    resp = await llamar(backoffice.editarSuscripcion, { params: { id: negocio.id }, admin: ADMIN, body: { plan: 'inicial' } });
    todos = await leerEmpleados();
    chk('rige ya, con los de actividad más reciente', [200, ids(emps.slice(0, topeIni))], [resp.status, ids(todos.filter((e) => e.activo))]);
    chk('y el resto suspendido por el plan', ids(emps.slice(topeIni)), ids(todos.filter((e) => e.suspendidoPorPlan)));

    tit('15c. La tarea periódica aplica la bajada aunque nadie entre a la cuenta');
    await Employee.update({ activo: true, suspendidoPorPlan: false }, { where: { businessId: negocio.id } });
    s = await poner(superior, { vence: enDias(29), pendiente: inicial, pendienteDesde: enDias(-0.001) });
    const barrido = await planService.aplicarBajadasVencidas(new Date(), { businessId: negocio.id });
    s = await leer();
    chk('la aplicó', [1, inicial.id, null], [barrido.aplicadas, s.planId, s.planPendienteId]);
    chk('y dejó a los empleados dentro del tope', topeIni, await Employee.count({ where: { businessId: negocio.id, activo: true } }));

    tit('15e. El día que rige, el que queda afuera ya no entra aunque nadie la haya aplicado');
    await Employee.update({ activo: true, suspendidoPorPlan: false }, { where: { businessId: negocio.id } });
    s = await poner(superior, { vence: enDias(29), pendiente: inicial, pendienteDesde: enDias(-0.001) });
    await Subscription.update({ planPendienteSuspender: JSON.stringify(afuera.map((e) => e.id)) }, { where: { id: sub.id } });
    resp = await entrar(afuera[0].email, CLAVE_EMP);
    chk('su login aplica la bajada primero y lo rechaza', [403, 'EMPLEADO_SUSPENDIDO_PLAN'], [resp.status, resp.json?.codigo]);
    chk('con la elección que había hecho el dueño', ids(quedan), ids((await leerEmpleados()).filter((e) => e.activo)));

    tit('15d. CARRERA: varias consultas a la vez el día que rige la bajada');
    await Employee.update({ activo: true, suspendidoPorPlan: false }, { where: { businessId: negocio.id } });
    s = await poner(superior, { vence: enDias(29), pendiente: inicial, pendienteDesde: enDias(-0.001) });
    const aplicaciones = await Promise.all([
      planService.aplicarPlanPendiente(s), planService.aplicarPlanPendiente(s), planService.aplicarPlanPendiente(s),
    ]);
    chk('la aplica una sola', 1, aplicaciones.filter(Boolean).length);
    chk('con los empleados dentro del tope', [topeIni, cuantos - topeIni], [
      await Employee.count({ where: { businessId: negocio.id, activo: true } }),
      await Employee.count({ where: { businessId: negocio.id, suspendidoPorPlan: true } }),
    ]);
    await Employee.update({ activo: true, suspendidoPorPlan: false }, { where: { businessId: negocio.id } });

    // ─────────────────────────────────────────────────────────────
    tit('16. DÉBITO AUTOMÁTICO: SU MONTO SIGUE AL PLAN CON EL QUE LA CUENTA SIGUE (decisión 20)');
    const conDebito = async (plan, opciones) => {
      await poner(plan, opciones);
      await Subscription.update({
        metodoPago: 'mercadopago', proveedorRef: 'QA-PREAP-1', renovacionAutomatica: true,
        debitoMonto: Number(plan.precioMensual), debitoPendienteDesde: null,
      }, { where: { id: sub.id } });
      llamadasMp.length = 0;
      return leer();
    };

    s = await conDebito(inicial, { vence: enDias(20) });
    resp = await cotizar('superior');
    chk('la cotización avisa que el débito pasa al precio nuevo', [true, P.ini, P.sup], [
      resp.json?.debito?.activo, resp.json?.debito?.montoActual, resp.json?.debito?.montoNuevo,
    ]);
    chk('y no ofrece dar de alta otro débito', false, resp.json?.medios?.debitoAutomatico);
    const dif16 = resp.json?.monto;
    await llamar(billing.crearCheckout, { auth, body: { plan: 'superior' } });
    mp.consultarPago = async (id) => cobro(String(id), dif16);
    await webhook('QA-MP-16');
    await planService.esperarSincronizaciones();
    s = await leer();
    chk('al subir, Mercado Pago recibe el precio del Superior', [[{ id: 'QA-PREAP-1', monto: P.sup }], P.sup], [
      llamadasMp, Number(s.debitoMonto),
    ]);

    tit('16b. Hallazgo ALTO: un débito con el monto viejo no pasa callado');
    llamadasMp.length = 0;
    mp.consultarPago = async (id) => cobro(String(id), P.ini);
    await webhook('QA-MP-16b');
    await planService.esperarSincronizaciones();
    const filaDebito16 = await SubscriptionPayment.findOne({ where: { proveedorRef: 'QA-MP-16b' } });
    s = await leer();
    chk('se acredita (la plata entró) y el plan no cambia', [true, superior.id], [Boolean(filaDebito16), s.planId]);
    chk('pero queda marcado para el backoffice', true, /sin un pedido que coincida/.test(filaDebito16?.aRevisar || ''));
    chk('y se le vuelve a mandar el monto a Mercado Pago', [P.sup], llamadasMp.map((x) => x.monto));

    tit('16c. Al programar una bajada, el próximo débito ya es del plan bajo');
    s = await conDebito(superior, { vence: enDias(20) });
    await llamar(billing.crearCheckout, { auth, body: { plan: 'pro' } });
    mp.consultarPago = async (id) => cobro(String(id), P.pro);
    await webhook('QA-MP-16c');
    await planService.esperarSincronizaciones();
    s = await leer();
    chk('la bajada queda programada', [superior.id, pro.id], [s.planId, s.planPendienteId]);
    chk('y el débito pasa al Pro ya: el próximo paga el primer mes del Pro', [P.pro], llamadasMp.map((x) => x.monto));

    llamadasMp.length = 0;
    await Subscription.update({ planPendienteDesde: enDias(-0.001) }, { where: { id: sub.id } });
    await planService.estadoDe(negocio.id);
    await planService.esperarSincronizaciones();
    chk('el día que rige ya estaba al día: no se manda de nuevo', 0, llamadasMp.length);

    s = await conDebito(superior, { vence: enDias(20), pendiente: pro, pendienteDesde: enDias(-0.001) });
    await planService.estadoDe(negocio.id);
    await planService.esperarSincronizaciones();
    chk('si no estaba al día, se actualiza el día que la bajada rige', [P.pro], llamadasMp.map((x) => x.monto));

    tit('16d. Si Mercado Pago no contesta, se reintenta');
    s = await conDebito(pro, { vence: enDias(20) });
    mpFalla = true;
    try {
      await planService.acreditarPago({ subscription: s, planId: superior.id, concepto: 'diferencia' });
      await planService.esperarSincronizaciones();
    } finally { mpFalla = false; }
    s = await leer();
    chk('queda anotado desde cuándo falta', [true, P.pro], [Boolean(s.debitoPendienteDesde), Number(s.debitoMonto)]);
    const reintento = await planService.reintentarDebitos({ subscriptionId: sub.id });
    s = await leer();
    chk('la tarea periódica lo reintenta y queda al día', [1, P.sup, null], [reintento.actualizados, Number(s.debitoMonto), s.debitoPendienteDesde]);

    tit('16e. Un débito nuevo reemplaza al anterior');
    s = await conDebito(pro, { vence: enDias(20) });
    cancelados.length = 0;
    resp = await llamar(billing.crearCheckout, { auth, body: { plan: 'pro', modo: 'recurrente' } });
    s = await leer();
    chk('se cancela el viejo antes de dar de alta el nuevo', [201, ['QA-PREAP-1'], 'QA-PREAP-NUEVO', P.pro], [
      resp.status, cancelados, s.proveedorRef, Number(s.debitoMonto),
    ]);
    s = await conDebito(pro, { vence: enDias(20) });
    cancelarFalla = true;
    try {
      resp = await llamar(billing.crearCheckout, { auth, body: { plan: 'pro', modo: 'recurrente' } });
    } finally { cancelarFalla = false; }
    s = await leer();
    chk('si no se puede cancelar el viejo, no se crea otro', [502, 'QA-PREAP-1'], [resp.status, s.proveedorRef]);

    tit('16f. Otros caminos que cambian lo que se cobra');
    s = await conDebito(pro, { vence: enDias(20) });
    resp = await llamar(billing.informarTransferencia, { auth, body: { plan: 'superior' } });
    s = await leer();
    chk('transferir una diferencia no le saca el débito a la cuenta', 'mercadopago', s.metodoPago);

    s = await conDebito(pro, { vence: enDias(20) });
    resp = await llamar(backoffice.editarSuscripcion, { params: { id: negocio.id }, admin: ADMIN, body: { plan: 'superior' } });
    await planService.esperarSincronizaciones();
    chk('un plan puesto a mano en el backoffice también mueve el débito', [200, [P.sup]], [resp.status, llamadasMp.map((x) => x.monto)]);

    s = await conDebito(pro, { vence: enDias(20) });
    cancelados.length = 0;
    resp = await llamar(billing.cambiarRenovacion, { auth, body: { activa: false } });
    s = await leer();
    chk('cancelar la suscripción cancela el débito y lo olvida', [['QA-PREAP-1'], null, null], [cancelados, s.proveedorRef, s.debitoMonto]);
    resp = await llamar(billing.getSuscripcion, { auth });
    chk('getSuscripcion dice que ya no hay débito', false, resp.json?.debito?.activo);

    tit('16g. CARRERA: dos cambios seguidos le mandan a Mercado Pago el monto de AHORA');
    /*
     * La primera actualización tarda (Mercado Pago lento) y mientras tanto el
     * plan vuelve a cambiar. Sin la fila de sincronizaciones, las dos leían la
     * suscripción a la vez y la lenta llegaba última: Mercado Pago y la base
     * quedaban con el monto del plan de antes. La simulación anota cada monto
     * cuando Mercado Pago TERMINA de procesarlo, que es el que queda.
     */
    s = await conDebito(pro, { vence: enDias(20) });
    await Subscription.update({ debitoMonto: null }, { where: { id: sub.id } });
    const mpRapido = mp.actualizarMontoRecurrente;
    const procesados = [];
    let arrancoLaLenta = false;
    mp.actualizarMontoRecurrente = async (id, { monto } = {}) => {
      const lenta = !arrancoLaLenta;
      arrancoLaLenta = true;
      if (lenta) await dormir(400);
      procesados.push(Number(monto));
      return { id };
    };
    let carrera;
    try {
      await Subscription.update({ planId: superior.id }, { where: { id: sub.id } });
      const primera = planService.programarSincronizacion(sub.id);
      while (!arrancoLaLenta) await dormir(5);
      await Subscription.update({ planId: inicial.id }, { where: { id: sub.id } });
      const segunda = planService.programarSincronizacion(sub.id);
      carrera = await Promise.all([primera, segunda]);
    } finally { mp.actualizarMontoRecurrente = mpRapido; }
    s = await leer();
    chk('lo último que procesa Mercado Pago es el precio del Inicial', P.ini, procesados[procesados.length - 1]);
    chk('y la base dice lo mismo', [P.ini, null], [Number(s.debitoMonto), s.debitoPendienteDesde]);
    chk('las dos corrieron, una detrás de la otra', ['actualizado', 'actualizado'], carrera.map((x) => x?.estado));

    tit('16h. Lo que se le pide a Mercado Pago (simulado: no sale nada a la red)');
    /*
     * La forma del pedido, contra la documentación de Mercado Pago (Gestión de
     * suscripciones): el monto se cambia con PUT /preapproval/{id} y
     * auto_recurring.transaction_amount + currency_id. Y cada alta de débito
     * lleva su propia clave de idempotencia: con la clave fija por suscripción,
     * el alta que reemplaza a un débito cancelado recibía la respuesta guardada
     * del alta vieja (el mismo débito que se acababa de cancelar).
     */
    const fetchOriginal = global.fetch;
    const tokenOriginal = process.env.MP_ACCESS_TOKEN;
    const pedidos = [];
    global.fetch = async (url, op = {}) => {
      pedidos.push({ url: String(url), method: op.method, headers: op.headers || {}, body: op.body ? JSON.parse(op.body) : null });
      return { ok: true, status: 200, json: async () => ({ id: `QA-PREAP-${pedidos.length}`, init_point: 'https://example.invalid/debito' }) };
    };
    // Un token inventado: config() exige uno, y el fetch simulado no lo manda a ningún lado.
    process.env.MP_ACCESS_TOKEN = 'TEST-qa-token-inventado';
    try {
      await originales.actualizarMontoRecurrente('QA-PREAP-9', { monto: 123456, motivo: 'Stocker — Pro' });
      await originales.crearSuscripcionRecurrente({
        businessId: negocio.id, subscriptionId: sub.id, plan: pro, monto: P.pro, emailPagador: 'qa.pagador@stocker.test',
      });
      await dormir(5);
      await originales.crearSuscripcionRecurrente({
        businessId: negocio.id, subscriptionId: sub.id, plan: pro, monto: P.pro, emailPagador: 'qa.pagador@stocker.test',
      });
    } finally {
      global.fetch = fetchOriginal;
      if (tokenOriginal === undefined) delete process.env.MP_ACCESS_TOKEN; else process.env.MP_ACCESS_TOKEN = tokenOriginal;
    }
    chk('el monto va por PUT /preapproval/{id}', ['PUT', 'https://api.mercadopago.com/preapproval/QA-PREAP-9'], [
      pedidos[0]?.method, pedidos[0]?.url,
    ]);
    chk('con auto_recurring.transaction_amount y currency_id', { transaction_amount: 123456, currency_id: 'ARS' },
      pedidos[0]?.body?.auto_recurring);
    chk('y el nombre del plan, que es lo que ve el cliente en Mercado Pago', 'Stocker — Pro', pedidos[0]?.body?.reason);
    const claves = pedidos.slice(1).map((p) => p.headers['X-Idempotency-Key']);
    chk('dos altas de débito, dos claves de idempotencia distintas', [2, true], [
      claves.filter(Boolean).length, claves[0] !== claves[1],
    ]);

    // ─────────────────────────────────────────────────────────────
    tit('17. LO QUE VE EL CLIENTE');
    s = await poner(pro, { vence: enDias(20) });
    await llamar(billing.crearCheckout, { auth, body: { plan: 'superior' } });
    await SubscriptionPayment.update(
      { aRevisar: 'interno', empleadosSuspender: '[1]', fecha: enDias(-2) },
      { where: { businessId: negocio.id } },
    );
    resp = await llamar(billing.getPagos, { auth });
    const vistaPago = resp.json?.[0] || {};
    chk('la marca de revisión y la elección no salen al navegador', [false, false], ['aRevisar' in vistaPago, 'empleadosSuspender' in vistaPago]);
    chk('el link de una diferencia vencida no se ofrece', [null, 'diferencia'], [vistaPago.linkPago, vistaPago.concepto]);
  } finally {
    Object.assign(mp, {
      consultarPago: originales.consultarPago, firmaValida: originales.firmaValida,
      estaConfigurado: originales.estaConfigurado, buscarPagosDe: originales.buscarPagosDe,
      crearLinkDePago: originales.crearLinkDePago,
      actualizarMontoRecurrente: originales.actualizarMontoRecurrente,
      cancelarSuscripcionRecurrente: originales.cancelarSuscripcionRecurrente,
      crearSuscripcionRecurrente: originales.crearSuscripcionRecurrente,
    });
    sinDemora();
    await planService.esperarSincronizaciones().catch(() => {});
    SubscriptionPayment.create = createOriginal;
    await limpiar();
    await db.close();
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m`);
  console.log(`  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
