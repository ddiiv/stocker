/*
 * Lo que la pantalla de Configuración de la cuenta le pide al backend y que
 * antes no estaba.
 *
 *   1. El período en curso de la suscripción (GET /api/billing/suscripcion →
 *      `periodo`). Sólo venía `vence`: la pantalla podía decir cuándo termina
 *      pero no qué cubre.
 *   2. La versión de los Términos vigente al lado de la aceptada
 *      (GET /api/account → `terminosVigente`), y que sea UNA sola: la misma
 *      que el registro graba en la cuenta.
 *
 * Todo en proceso, con req/res sintéticos: no depende de qué backend tenga el
 * 3000. El negocio es de prueba, con datos inventados, y se borra al terminar.
 *
 * Uso:  node scripts/test-configuracion-cuenta.cjs
 */
// El SQL de cada consulta tapa el resultado. Si se quiere verlo, LOG_LEVEL=debug.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
require('dotenv').config({ path: __dirname + '/../.env' });

const fs = require('node:fs');
const path = require('node:path');
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
const enDias = (n) => new Date(Date.now() + n * DIA);
// Los motores redondean milisegundos distinto: se compara al segundo.
const mismoInstante = (a, b) => a != null && b != null && Math.abs(new Date(a) - new Date(b)) < 1000;

const CUIT = '20999777852';
const EMAIL = 'qa.configuracion@stocker.test';

function llamar(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(p) { resolve({ status: this.statusCode, json: p }); },
    };
    Promise.resolve(handler(req, res, (e) => resolve({ status: 500, json: { message: e?.message }, error: e })))
      .catch(reject);
  });
}

(async () => {
  const db = require('../src/config/database');
  const { ensureColumns } = require('../src/database/ensureColumns');
  const { Business, Plan, Subscription } = require('../src/models');
  const planService = require('../src/services/planService');
  const billing = require('../src/controllers/billingController');
  const cuenta = require('../src/controllers/accountController');
  const { TERMINOS_VERSION } = require('../src/config/terminos');

  await ensureColumns(db);

  async function limpiar() {
    const restos = await Business.findAll({ where: { [Op.or]: [{ email: EMAIL }, { cuit: CUIT }] } });
    for (const b of restos) {
      await Subscription.destroy({ where: { businessId: b.id } });
      await b.destroy();
    }
  }
  await limpiar();

  const negocio = await Business.create({
    nombreNegocio: 'QA Configuración', ownerNombre: 'QA', ownerApellido: 'Cuenta',
    cuit: CUIT, email: EMAIL, passwordHash: 'x',
    terminosVersion: '2025-01', terminosAceptadosEn: enDias(-40),
  });
  await planService.iniciarTrial(negocio.id, { plan: 'pro' });
  const sub = await Subscription.findOne({ where: { businessId: negocio.id } });
  const req = { auth: { businessId: negocio.id, type: 'business' } };
  const suscripcion = () => llamar(billing.getSuscripcion, req).then((r) => r.json);

  try {
    tit('1. EL PERÍODO EN CURSO');

    /*
     * Una prueba con un período pago viejo encima: la cuenta que pagó, se fue
     * y el equipo le dio otra prueba desde el backoffice. Sin esas fechas
     * viejas, tomar las del plan pago "si hay" pasaría igual y no se vería.
     */
    await Subscription.update(
      { periodoInicio: enDias(-100), periodoFin: enDias(-70) },
      { where: { id: sub.id } },
    );
    let s = await suscripcion();
    chk('en la prueba, el período es la prueba', 'prueba', s.periodo?.tipo);
    chk('  arranca cuando arrancó la prueba', true, mismoInstante(s.periodo?.desde, sub.trialInicio));
    chk('  y termina cuando vence', true, mismoInstante(s.periodo?.hasta, sub.trialFin));

    const inicio = enDias(-10);
    const fin = enDias(20);
    await Subscription.update(
      { estado: 'activa', periodoInicio: inicio, periodoFin: fin },
      { where: { id: sub.id } },
    );
    s = await suscripcion();
    chk('con un plan pago, es lo último que se acreditó', 'pago', s.periodo?.tipo);
    chk('  desde el inicio del período pago', true, mismoInstante(s.periodo?.desde, inicio));
    chk('  hasta su fin, que es el mismo `vence`', true,
      mismoInstante(s.periodo?.hasta, fin) && mismoInstante(s.vence, fin));

    // Vencido pero dentro de la gracia: el período que se está debiendo.
    await Subscription.update(
      { periodoInicio: enDias(-32), periodoFin: enDias(-2) },
      { where: { id: sub.id } },
    );
    s = await suscripcion();
    chk('morosa: se sigue mostrando el período que venció', ['morosa', 'pago'], [s.estado, s.periodo?.tipo]);

    await Subscription.update(
      { periodoInicio: enDias(-90), periodoFin: enDias(-60) },
      { where: { id: sub.id } },
    );
    s = await suscripcion();
    chk('en modo lectura no hay período en curso', ['lectura', null], [s.estado, s.periodo]);

    const enterprise = await Plan.findOne({ where: { codigo: 'enterprise' } });
    await Subscription.update(
      { estado: 'activa', planId: enterprise.id, periodoInicio: null, periodoFin: null },
      { where: { id: sub.id } },
    );
    s = await suscripcion();
    chk('Enterprise facturado por fuera, sin fechas: sin período y sin romper', ['activa', null],
      [s.estado, s.periodo]);

    /*
     * Lo de arriba escribe las fechas a mano. Acá se llega al estado por
     * acreditarPago, que es por donde llega de verdad: pagar antes del
     * vencimiento (renovar, bajar de plan, días regalados) suma lo nuevo
     * DESPUÉS de lo que está corriendo, y el período que se está usando no
     * puede saltar a uno que todavía no empezó.
     */
    tit('1b. DESPUÉS DE PAGAR ANTES DE TIEMPO (por acreditarPago)');
    const [inicialP, proP, superiorP] = await Promise.all(
      ['inicial', 'pro', 'superior'].map((codigo) => Plan.findOne({ where: { codigo } })),
    );
    const poner = async (plan, { inicio = enDias(-20), fin = enDias(10), siguiente = null } = {}) => {
      await Subscription.update({
        estado: 'activa', planId: plan.id, periodoInicio: inicio, periodoFin: fin,
        periodoSiguienteDesde: siguiente,
        planPendienteId: null, planPendienteDesde: null, planPendienteSuspender: null,
        precioAcordado: null, descuentoPct: 0, metodoPago: null, proveedorRef: null,
      }, { where: { id: sub.id } });
      return Subscription.findByPk(sub.id);
    };
    const masDias = (f, n) => new Date(new Date(f).getTime() + n * DIA);
    // Hoy adentro del período que la pantalla llama "actual".
    const hoyAdentro = (p) => Boolean(p) && (!p.desde || new Date(p.desde) <= new Date())
      && new Date() < new Date(p.hasta);
    const igualA = (p, desde, hasta) => Boolean(p)
      && (desde === null ? p.desde == null : mismoInstante(p.desde, desde)) && mismoInstante(p.hasta, hasta);

    const ini = enDias(-20);
    const fin10 = enDias(10);

    let antes = await poner(proP, { inicio: ini, fin: fin10 });
    await planService.acreditarPago({ subscription: antes, planId: proP.id });
    s = await suscripcion();
    chk('renovar 10 días antes: hoy sigue adentro del "período actual"', true, hoyAdentro(s.periodo));
    chk('  el actual es el que se está usando (del inicio al vencimiento viejo)', true,
      igualA(s.periodo, ini, fin10));
    chk('  lo recién pagado va aparte, como el siguiente', true,
      igualA(s.periodo?.siguiente, fin10, masDias(fin10, 30)));
    chk('  y `vence` es el fin de todo lo pago', true, mismoInstante(s.vence, masDias(fin10, 30)));

    // Un segundo mes por adelantado: el actual sigue siendo el mismo.
    await planService.acreditarPago({ subscription: await Subscription.findByPk(sub.id), planId: proP.id });
    s = await suscripcion();
    chk('dos meses por adelantado: el actual no se mueve', true, igualA(s.periodo, ini, fin10));
    chk('  y el siguiente cubre los dos', true, igualA(s.periodo?.siguiente, fin10, masDias(fin10, 60)));

    /*
     * Pasó el corte: lo pagado por adelantado es lo que se usa ahora. Pagar de
     * nuevo antes de tiempo deja como actual ESE tramo y no el primero.
     */
    antes = await poner(proP, { inicio: enDias(-50), siguiente: enDias(-20), fin: fin10 });
    s = await suscripcion();
    chk('pasado el corte, el actual es lo que se había pagado por adelantado', true,
      igualA(s.periodo, enDias(-20), fin10) && !s.periodo?.siguiente);
    await planService.acreditarPago({ subscription: antes, planId: proP.id });
    s = await suscripcion();
    chk('  y pagar otra vez antes de tiempo lo deja como actual', true, igualA(s.periodo, enDias(-20), fin10));
    chk('  con lo nuevo como siguiente', true, igualA(s.periodo?.siguiente, fin10, masDias(fin10, 30)));

    /*
     * La bajada ya paga: el plan caro sigue rigiendo hasta el vencimiento, y
     * el período actual tiene que ser el SUYO, no el del plan barato.
     */
    antes = await poner(superiorP, { inicio: ini, fin: fin10 });
    await planService.acreditarPago({ subscription: antes, planId: inicialP.id });
    s = await suscripcion();
    chk('bajada paga: sigue el Superior', ['superior', 'inicial'], [s.plan?.codigo, s.planPendiente?.codigo]);
    chk('  el actual es el del Superior (hoy adentro)', true, igualA(s.periodo, ini, fin10) && hoyAdentro(s.periodo));
    chk('  el siguiente es el del Inicial y arranca cuando rige la bajada', true,
      igualA(s.periodo?.siguiente, fin10, masDias(fin10, 30))
      && mismoInstante(s.periodo?.siguiente?.desde, s.planPendiente?.desde));

    // Subir no mueve el vencimiento (decisión 18): no hay siguiente.
    antes = await poner(proP, { inicio: ini, fin: fin10 });
    await planService.acreditarPago({ subscription: antes, planId: superiorP.id, concepto: 'diferencia' });
    s = await suscripcion();
    chk('subida: plan nuevo, mismo período, sin siguiente', ['superior', true, null],
      [s.plan?.codigo, igualA(s.periodo, ini, fin10), s.periodo?.siguiente ?? null]);

    // Días regalados desde el backoffice: entran después, como un pago.
    antes = await poner(proP, { inicio: ini, fin: fin10 });
    await planService.acreditarPago({ subscription: antes, dias: 15 });
    s = await suscripcion();
    chk('días regalados: el actual no se mueve y lo regalado es el siguiente', [true, true],
      [igualA(s.periodo, ini, fin10), igualA(s.periodo?.siguiente, fin10, masDias(fin10, 15))]);

    /*
     * Pagar con el período ya vencido (en la gracia): arranca hoy, y un corte
     * que había quedado de antes no puede sobrevivir.
     */
    antes = await poner(proP, { inicio: enDias(-32), siguiente: enDias(-12), fin: enDias(-2) });
    await planService.acreditarPago({ subscription: antes, planId: proP.id });
    s = await suscripcion();
    chk('pagar vencido: el período arranca hoy y no hay siguiente', [true, true, null],
      [mismoInstante(s.periodo?.desde, new Date()) || Math.abs(new Date(s.periodo?.desde) - Date.now()) < 5000,
        hoyAdentro(s.periodo), s.periodo?.siguiente ?? null]);

    /*
     * Una fila que dejó el código anterior: el inicio guardado es el de lo
     * pagado por adelantado, en el futuro. No se sabe cuándo empezó el que se
     * usa, pero sí cuándo termina: se dice eso y no un período que no empezó.
     */
    antes = await poner(proP, { inicio: fin10, fin: masDias(fin10, 30) });
    s = await suscripcion();
    chk('fila vieja con el inicio en el futuro: el actual termina donde empieza lo pago', true,
      igualA(s.periodo, null, fin10) && hoyAdentro(s.periodo));
    chk('  y lo pago es el siguiente', true, igualA(s.periodo?.siguiente, fin10, masDias(fin10, 30)));
    await planService.acreditarPago({ subscription: antes, planId: proP.id });
    s = await suscripcion();
    chk('  pagar otra vez sobre esa fila no inventa un inicio', true,
      igualA(s.periodo, null, fin10) && igualA(s.periodo?.siguiente, fin10, masDias(fin10, 60)));
    // Subir no toca el período: el inicio desconocido tampoco pasa a ser hoy.
    await planService.acreditarPago({
      subscription: await Subscription.findByPk(sub.id), planId: superiorP.id, concepto: 'diferencia',
    });
    s = await suscripcion();
    chk('  ni subir de plan sobre esa fila', ['superior', true],
      [s.plan?.codigo, igualA(s.periodo, null, fin10) && igualA(s.periodo?.siguiente, fin10, masDias(fin10, 60))]);

    // El paso del tiempo, sin esperar: la misma fila mirada otro día.
    const partir = (fila, dia) => planService.partirPeriodo(fila, enDias(dia));
    const fila = { periodoInicio: enDias(-20), periodoSiguienteDesde: enDias(10), periodoFin: enDias(40) };
    let p = partir(fila, 0);
    chk('mirada hoy: actual hasta el corte y siguiente desde ahí', true,
      igualA(p.actual, enDias(-20), enDias(10)) && igualA(p.siguiente, enDias(10), enDias(40)));
    p = partir(fila, 15);
    chk('mirada pasado el corte: lo adelantado es el actual y no hay siguiente', [true, null],
      [igualA(p.actual, enDias(10), enDias(40)), p.siguiente]);
    p = partir({ ...fila, periodoSiguienteDesde: enDias(40) }, 0);
    chk('un corte que no deja nada después no parte nada', [true, null],
      [igualA(p.actual, enDias(-20), enDias(40)), p.siguiente]);

    tit('2. EL MEDIDOR DE SESIONES QUE USA LA PANTALLA');
    const pro = await Plan.findOne({ where: { codigo: 'pro' } });
    await Subscription.update(
      { planId: pro.id, periodoInicio: inicio, periodoFin: fin },
      { where: { id: sub.id } },
    );
    s = await suscripcion();
    chk('uso.sesiones trae el tope del plan', pro.maxSesiones == null ? null : Number(pro.maxSesiones),
      s.uso?.sesiones?.tope);
    chk('y el modo del límite, para decir si se aplica o se mide', true,
      ['sombra', 'activo', 'off'].includes(s.uso?.sesiones?.modo));

    tit('3. LOS TÉRMINOS: ACEPTADA Y VIGENTE');
    const r = await llamar(cuenta.obtener, req);
    chk('GET /account responde', 200, r.status);
    chk('trae la versión que aceptó la cuenta', '2025-01', r.json.terminosVersion);
    chk('y cuándo', true, mismoInstante(r.json.terminosAceptadosEn, negocio.terminosAceptadosEn));
    chk('trae la vigente, la de src/config/terminos.js', TERMINOS_VERSION, r.json.terminosVigente);
    chk('la IP de la aceptación sigue sin salir', false, 'terminosIp' in r.json);

    /*
     * Una sola versión. El registro la graba y Configuración la compara: si el
     * registro tuviera su propia copia, subir una y no la otra haría que la
     * pantalla le diga "estás al día" a una cuenta que aceptó otro texto.
     */
    const fuenteRegistro = fs.readFileSync(
      path.join(__dirname, '../src/controllers/authController.js'), 'utf8',
    );
    chk('el registro no tiene una versión escrita a mano', false,
      /TERMINOS_VERSION\s*=\s*['"`]/.test(fuenteRegistro));
    chk('la toma de src/config/terminos.js', true,
      /require\(['"]\.\.\/config\/terminos['"]\)/.test(fuenteRegistro));
  } finally {
    await limpiar();
    await db.close().catch(() => {});
  }

  console.log(`\n  Pasaron: ${ok}   Fallaron: ${ko}`);
  process.exit(ko ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
