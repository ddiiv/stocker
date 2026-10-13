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
