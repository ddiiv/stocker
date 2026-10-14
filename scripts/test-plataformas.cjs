/*
 * Plataformas: el estado de cada conexión, la puerta de plan de las rutas de
 * máquina y el pedido de cotización de un desarrollo a medida.
 *
 * Lo que cuida, en el orden en que importa:
 *
 *   1. Que la puerta de plan NO le corte el puente a quien ya lo tenía andando
 *      (decisión 10 del dueño). Es el error caro: un portal mayorista que
 *      empieza a rebotar pedidos el día del despliegue.
 *   2. Que el estado que ve el cliente no lleve NINGÚN token: ni el de las
 *      credenciales de máquina (ni su hash, ni la pista), ni los de Mercado
 *      Libre, ni la clave de Jumpseller.
 *   3. Que la cotización se guarde aunque el mail falle o se cuelgue, y que
 *      sólo la puedan pedir el dueño y los cargos con integraciones en edición.
 *
 * Corre en proceso, con el router real en un puerto efímero (no el 3000) y el
 * correo simulado: no sale ningún mail. Los negocios son descartables y se
 * borran al terminar; lo global que toca (la marca de la herencia y la lista
 * heredada de los negocios con credencial viva) se deja como estaba.
 */

require('dotenv').config({ path: __dirname + '/../.env' });

/*
 * El correo, simulado ANTES de cargar nada: emailService arma su transporte
 * con nodemailer.createTransport la primera vez que manda, y para entonces ya
 * tiene que ser éste. Sin credencial no intentaría mandar, así que se le pone
 * una de mentira: con el transporte simulado no se usa para nada.
 */
if (!process.env.MAIL_PASSNOREPLY && !process.env.MAIL_PASS) process.env.MAIL_PASS = 'qa-sin-envio';
const nodemailer = require('nodemailer');
const correoSimulado = { enviados: [], falla: null };
nodemailer.createTransport = () => ({
  sendMail: async (m) => {
    if (correoSimulado.falla) throw new Error(correoSimulado.falla);
    correoSimulado.enviados.push(m);
    return { messageId: `qa-${correoSimulado.enviados.length}` };
  },
});

const express = require('express');
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
const enDias = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const SUF = `${process.pid}${Date.now().toString(36)}`;
const PATRON = 'qa.plat.%@stocker.test';
const CUITS = Array.from({ length: 16 }, (_, i) => `209996664${String(i + 1).padStart(2, '0')}`);
const DETALLE = 'Vendemos por mayor a unos cuarenta locales del interior y hoy tomamos los pedidos por WhatsApp.';

let base = null;
async function api(token, metodo, ruta, json) {
  const opciones = { method: metodo, headers: { 'user-agent': 'qa-plataformas' } };
  if (token) opciones.headers.authorization = `Bearer ${token}`;
  if (json) {
    opciones.headers['content-type'] = 'application/json';
    opciones.body = JSON.stringify(json);
  }
  const r = await fetch(`${base}/api${ruta}`, opciones);
  const texto = await r.text();
  let cuerpo = null;
  try { cuerpo = JSON.parse(texto); } catch { cuerpo = texto; }
  return { status: r.status, json: cuerpo, crudo: texto };
}

(async () => {
  const db = require('../src/config/database');
  const {
    Business, Subscription, Plan, Role, Employee, SesionCuenta, IntegracionExterna, PlatformSetting,
    MercadoLibreAccount, JumpsellerAccount, CotizacionDesarrollo, SolicitudMayorista,
  } = require('../src/models');
  const { ensureColumns, heredarConexionesPropias, MARCA_CONEXIONES_PROPIAS } = require('../src/database/ensureColumns');
  const planService = require('../src/services/planService');
  const plataformas = require('../src/services/plataformasService');
  const integraciones = require('../src/services/integracionesService');
  const sesiones = require('../src/services/sesionesService');
  const { PLANES, CATALOGO_FEATURES, FEATURES } = require('../src/config/planes');
  const { FEATURE_POR_ORIGEN, PLATAFORMAS } = require('../src/config/plataformas');
  const routes = require('../src/routes');
  const { errorHandler } = require('../src/middleware/errorHandler');

  await ensureColumns(db);
  // Tabla nueva: en una base que todavía no arrancó con este código, la crea.
  await CotizacionDesarrollo.sync();
  // Lo mismo que hace el arranque: los planes de la base reciben las claves nuevas.
  await planService.sembrarPlanes();

  async function limpiar() {
    const restos = await Business.findAll({
      where: { [Op.or]: [{ email: { [Op.like]: PATRON } }, { cuit: CUITS }] },
    });
    for (const b of restos) {
      await SesionCuenta.destroy({ where: { businessId: b.id } });
      await Employee.destroy({ where: { businessId: b.id } });
      await Role.destroy({ where: { businessId: b.id } });
      await IntegracionExterna.destroy({ where: { businessId: b.id } });
      await MercadoLibreAccount.destroy({ where: { businessId: b.id } });
      await JumpsellerAccount.destroy({ where: { businessId: b.id } });
      await CotizacionDesarrollo.destroy({ where: { businessId: b.id } });
      await SolicitudMayorista.destroy({ where: { businessId: b.id } });
      await Subscription.destroy({ where: { businessId: b.id } });
      await b.destroy();
    }
  }
  await limpiar();

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', routes);
  app.use(errorHandler);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;

  const planes = Object.fromEntries(
    (await Plan.findAll({ where: { codigo: ['inicial', 'pro', 'superior', 'enterprise'] } })).map((p) => [p.codigo, p]),
  );

  let n = 0;
  async function negocio(nombre, { plan = 'pro', estado = 'activa', heredadas = '' } = {}) {
    const cuit = CUITS[n]; n += 1;
    const b = await Business.create({
      nombreNegocio: `QA Plat ${nombre}`, ownerNombre: 'QA', ownerApellido: nombre,
      cuit, email: `qa.plat.${nombre.toLowerCase()}.${SUF}@stocker.test`, passwordHash: 'x',
      featuresHeredadas: heredadas,
    });
    await planService.iniciarTrial(b.id, { plan: 'pro' });
    if (estado === 'lectura') {
      await Subscription.update({ planId: planes[plan].id, estado: 'trial', trialFin: enDias(-2) }, { where: { businessId: b.id } });
    } else {
      await Subscription.update({
        planId: planes[plan].id, estado: 'activa', periodoInicio: enDias(-10), periodoFin: enDias(20),
      }, { where: { businessId: b.id } });
    }
    return b;
  }

  const reqFalso = { headers: { 'user-agent': 'qa-plataformas' }, ip: '127.0.0.1' };
  const tokDuenio = (b) => sesiones.abrir(reqFalso, { type: 'business', businessId: b.id });
  let dni = 0;
  async function tokEmpleado(b, permisos) {
    const cargo = await Role.create({ businessId: b.id, nombre: `QA ${JSON.stringify(permisos)}`.slice(0, 60), permisos });
    dni += 1;
    const emp = await Employee.create({
      businessId: b.id, roleId: cargo.id, dni: `3922233${dni}`, nombre: `Emp${dni}`, apellido: 'Plat',
      email: `qa.plat.emp${dni}.${SUF}@stocker.test`, passwordHash: 'x', activo: true,
    });
    return sesiones.abrir(reqFalso, { type: 'employee', businessId: b.id, employeeId: emp.id, roleId: cargo.id });
  }
  const por = (r, clave) => (r.plataformas || []).find((p) => p.clave === clave);

  /* Lo global que se toca en la sección 4, para dejarlo como estaba. */
  const marcaAntes = await PlatformSetting.findByPk(MARCA_CONEXIONES_PROPIAS);
  const marcaAntesValor = marcaAntes ? marcaAntes.toJSON() : null;
  const vivasAntes = await IntegracionExterna.findAll({
    where: { activa: true, origen: Object.keys(FEATURE_POR_ORIGEN) }, attributes: ['businessId'],
  });
  const heredadasAntes = await Business.findAll({
    where: { id: [...new Set(vivasAntes.map((v) => v.businessId))] }, attributes: ['id', 'featuresHeredadas'],
  });

  try {
    tit('1. EL CATÁLOGO: TIENDA PROPIA Y PORTAL MAYORISTA, DESDE EL PRO');
    const enSemilla = (codigo, clave) => PLANES.find((p) => p.codigo === codigo).features[clave];
    chk('el Inicial no trae ninguna de las dos (semilla)', [false, false],
      [enSemilla('inicial', FEATURES.TIENDA_PROPIA), enSemilla('inicial', FEATURES.PORTAL_MAYORISTA)]);
    chk('Pro, Superior y Enterprise traen las dos (semilla)', [true, true, true, true, true, true],
      ['pro', 'superior', 'enterprise'].flatMap((c) => [enSemilla(c, FEATURES.TIENDA_PROPIA), enSemilla(c, FEATURES.PORTAL_MAYORISTA)]));
    chk('   y la base, después de sembrar, dice lo mismo',
      [false, false, true, true, true, true, true, true],
      ['inicial', 'pro', 'superior', 'enterprise'].flatMap((c) => [
        Boolean(planes[c].features[FEATURES.TIENDA_PROPIA]), Boolean(planes[c].features[FEATURES.PORTAL_MAYORISTA]),
      ]));
    chk('las dos están en el catálogo que muestran el backoffice y la landing', [true, true],
      [FEATURES.TIENDA_PROPIA, FEATURES.PORTAL_MAYORISTA].map((c) => CATALOGO_FEATURES.some((f) => f.clave === c)));
    chk('cada origen de credencial abre su función', ['portalMayorista', 'tiendaPropia'],
      [FEATURE_POR_ORIGEN.isuwaya, FEATURE_POR_ORIGEN.tienda]);
    chk('las cuatro plataformas que existen, y ninguna más',
      ['mercadolibre', 'jumpseller', 'tienda', 'mayorista'], PLATAFORMAS.map((p) => p.clave));

    // Un plan editado a mano recibe la función nueva, pero un false escrito se respeta.
    const filaFalsa = (features) => ({
      codigo: 'qa', features, update(v) { this.features = v.features; return Promise.resolve(this); },
    });
    const editado = filaFalsa({ facturacion: true });
    await planService.completarFeaturesNuevas(editado, { features: { facturacion: false, tiendaPropia: true } });
    chk('un plan editado en el backoffice recibe la función que no existía', { facturacion: true, tiendaPropia: true }, editado.features);
    const conFalse = filaFalsa({ facturacion: true, tiendaPropia: false });
    await planService.completarFeaturesNuevas(conFalse, { features: { facturacion: true, tiendaPropia: true } });
    chk('   pero si el operador la puso en false, queda en false', false, conFalse.features.tiendaPropia);

    tit('2. EL ESTADO DE LAS PLATAFORMAS');
    const inicial = await negocio('Inicial', { plan: 'inicial' });
    const pro = await negocio('Pro', { plan: 'pro' });
    const heredado = await negocio('Heredado', { plan: 'inicial', heredadas: 'deposito,portalMayorista' });

    const eInicial = await plataformas.estadoDePlataformas(inicial.id);
    chk('Inicial sin nada: tienda y portal "requieren plan"', ['requiere_plan', 'requiere_plan'],
      [por(eInicial, 'tienda').estado, por(eInicial, 'mayorista').estado]);
    chk('   y dicen desde qué plan: el Pro (sale de la base)', ['Plan Pro', 'Plan Pro'],
      [por(eInicial, 'tienda').desde?.nombre, por(eInicial, 'mayorista').desde?.nombre]);
    chk('   Mercado Libre y Jumpseller también (el Inicial no trae ecommerce)', ['requiere_plan', 'requiere_plan'],
      [por(eInicial, 'mercadolibre').estado, por(eInicial, 'jumpseller').estado]);

    const ePro = await plataformas.estadoDePlataformas(pro.id);
    chk('Pro sin nada: todo "sin conectar"', ['sin_conectar', 'sin_conectar', 'sin_conectar', 'sin_conectar'],
      ['mercadolibre', 'jumpseller', 'tienda', 'mayorista'].map((c) => por(ePro, c).estado));

    // Credenciales y cuentas con secretos reconocibles, para buscarlos en la respuesta.
    const SECRETO_ML = `QA-ML-SECRETO-${SUF}`;
    const SECRETO_JS = `QA-JS-SECRETO-${SUF}`;
    await MercadoLibreAccount.create({
      businessId: pro.id, mlUserId: '1', nickname: 'QA-NICK', accessToken: `${SECRETO_ML}-acc`, refreshToken: `${SECRETO_ML}-ref`,
    });
    await JumpsellerAccount.create({
      businessId: pro.id, tienda: 'qa-tienda', loginKey: `${SECRETO_JS}-key`, authToken: `${SECRETO_JS}-tok`,
    });
    const { token: tokTiendaPro, integracion: credTiendaPro } = await integraciones.emitir({ businessId: pro.id, origen: 'tienda', nombre: 'QA' });
    const { token: tokPortalInicial } = await integraciones.emitir({ businessId: inicial.id, origen: 'isuwaya', nombre: 'QA' });
    const { token: tokPortalHeredado } = await integraciones.emitir({ businessId: heredado.id, origen: 'isuwaya', nombre: 'QA' });

    const ePro2 = await plataformas.estadoDePlataformas(pro.id);
    chk('con la credencial de tienda, el Pro la ve "conectada"', 'conectada', por(ePro2, 'tienda').estado);
    chk('   con cuándo se conectó (el último uso todavía no hubo)', [true, null],
      [Boolean(por(ePro2, 'tienda').detalle.conectadaDesde), por(ePro2, 'tienda').detalle.ultimoUso ?? null]);
    chk('Mercado Libre y Jumpseller "conectadas", con el nombre de la cuenta', ['conectada', 'QA-NICK', 'conectada', 'qa-tienda'],
      [por(ePro2, 'mercadolibre').estado, por(ePro2, 'mercadolibre').detalle.cuenta, por(ePro2, 'jumpseller').estado, por(ePro2, 'jumpseller').detalle.cuenta]);

    tit('2b. NINGÚN TOKEN EN LA RESPUESTA');
    const tokPro = await tokDuenio(pro);
    const rPro = await api(tokPro, 'GET', '/plataformas');
    chk('GET /plataformas del dueño → 200', 200, rPro.status);
    const credFila = await IntegracionExterna.findByPk(credTiendaPro.id);
    chk('no viaja el token de la credencial', false, rPro.crudo.includes(tokTiendaPro));
    chk('   ni su hash', false, rPro.crudo.includes(credFila.tokenHash));
    chk('   ni la pista (los últimos caracteres)', false, rPro.crudo.includes(credFila.pista));
    chk('   ni los tokens de Mercado Libre', false, rPro.crudo.includes(SECRETO_ML));
    chk('   ni la clave de Jumpseller', false, rPro.crudo.includes(SECRETO_JS));
    chk('   ni un campo que se llame token o hash', false, /token|hash|pista|loginKey|authToken/i.test(Object.keys(JSON.parse(rPro.crudo)).join() + JSON.stringify(rPro.json.plataformas.map((p) => Object.keys(p.detalle)))));

    tit('2c. QUIÉN VE EL ESTADO');
    const tokSoloVentas = await tokEmpleado(pro, { ventas: 'ver' });
    const tokSoloIntegr = await tokEmpleado(pro, { integraciones: 'ver' });
    const tokNada = await tokEmpleado(pro, { clientes: 'ver' });
    chk('un cargo con ventas (la bandeja mayorista) lo ve', 200, (await api(tokSoloVentas, 'GET', '/plataformas')).status);
    chk('un cargo con integraciones lo ve', 200, (await api(tokSoloIntegr, 'GET', '/plataformas')).status);
    chk('un cargo sin ninguno de los dos → 403', 403, (await api(tokNada, 'GET', '/plataformas')).status);
    chk('sin sesión → 401', 401, (await api(null, 'GET', '/plataformas')).status);
    const tokInicial = await tokDuenio(inicial);
    const rInicial = await api(tokInicial, 'GET', '/plataformas');
    chk('cada negocio ve lo suyo: el Inicial no ve la cuenta de ML del Pro', [false, false],
      [rInicial.crudo.includes('QA-NICK'), por(rInicial.json, 'mercadolibre').conectada]);
    chk('el Inicial con su portal conectado lo ve "fuera de plan" (está rebotando)', 'fuera_de_plan', por(rInicial.json, 'mayorista').estado);
    const eHeredado = await plataformas.estadoDePlataformas(heredado.id);
    chk('el que la heredó la ve "conectada", marcada como heredada', ['conectada', true, true],
      [por(eHeredado, 'mayorista').estado, por(eHeredado, 'mayorista').heredada, por(eHeredado, 'mayorista').incluida]);

    tit('3. LA PUERTA DE PLAN EN LAS RUTAS DE MÁQUINA');
    const rRebota = await api(tokPortalInicial, 'GET', '/integraciones/isuwaya/precios');
    chk('portal de un Inicial que no lo heredó → 402 motivo plan', [402, 'plan', 'portalMayorista'],
      [rRebota.status, rRebota.json?.motivo, rRebota.json?.feature]);
    chk('   y el mensaje dice desde qué plan', true, /Plan Pro/.test(rRebota.json?.message || ''));
    chk('   también al mandar un pedido (todas las rutas del origen)', 402,
      (await api(tokPortalInicial, 'POST', '/integraciones/isuwaya/pedidos', { pedidoExterno: 'QA-1' })).status);
    chk('el Inicial que HEREDÓ el portal sigue entrando', 200, (await api(tokPortalHeredado, 'GET', '/integraciones/isuwaya/precios')).status);
    chk('el Pro entra con su tienda', 200, (await api(tokTiendaPro, 'GET', '/integraciones/tienda/catalogo')).status);
    chk('un token que no existe sigue siendo 401 (no 402)', 401, (await api('qa-no-existe', 'GET', '/integraciones/isuwaya/precios')).status);
    chk('la credencial de tienda en una ruta del portal sigue siendo 401', 401, (await api(tokTiendaPro, 'GET', '/integraciones/isuwaya/precios')).status);
    // Bajar al Inicial corta la tienda del Pro (no la había heredado)…
    await Subscription.update({ planId: planes.inicial.id }, { where: { businessId: pro.id } });
    chk('si el Pro baja al Inicial, su tienda rebota (no la tenía heredada)', 402, (await api(tokTiendaPro, 'GET', '/integraciones/tienda/catalogo')).status);
    await Subscription.update({ planId: planes.pro.id }, { where: { businessId: pro.id } });
    chk('   y al volver al Pro entra de nuevo', 200, (await api(tokTiendaPro, 'GET', '/integraciones/tienda/catalogo')).status);

    tit('4. LA HERENCIA: QUIEN YA TENÍA EL PUENTE, LO CONSERVA');
    await PlatformSetting.destroy({ where: { clave: MARCA_CONEXIONES_PROPIAS } });
    const conTienda = await negocio('ConTienda', { plan: 'inicial', heredadas: '' });
    const conDeposito = await negocio('ConDeposito', { plan: 'inicial', heredadas: 'deposito' });
    const sinMirar = await negocio('SinMirar', { plan: 'inicial' });
    await Business.update({ featuresHeredadas: null }, { where: { id: sinMirar.id } });
    const revocada = await negocio('Revocada', { plan: 'inicial', heredadas: '' });
    const { token: tokConTienda } = await integraciones.emitir({ businessId: conTienda.id, origen: 'tienda' });
    await integraciones.emitir({ businessId: conDeposito.id, origen: 'isuwaya' });
    await integraciones.emitir({ businessId: sinMirar.id, origen: 'tienda' });
    const { integracion: credRevocada } = await integraciones.emitir({ businessId: revocada.id, origen: 'tienda' });
    await integraciones.revocar({ businessId: revocada.id, id: credRevocada.id });
    const herencia = async (b) => (await Business.findByPk(b.id, { attributes: ['featuresHeredadas'] })).featuresHeredadas;

    chk('antes de la foto, la tienda del Inicial rebota (control)', 402, (await api(tokConTienda, 'GET', '/integraciones/tienda/catalogo')).status);
    const r1 = await heredarConexionesPropias(db);
    chk('con un negocio que heredarFeaturesEnUso no miró, la foto no se cierra', [null, null, ''],
      [r1, await PlatformSetting.findByPk(MARCA_CONEXIONES_PROPIAS).then((m) => m && m.clave), await herencia(conTienda)]);
    chk('   y a ése no se le escribe nada (seguiría afuera de la otra foto)', null, await herencia(sinMirar));
    await Business.update({ featuresHeredadas: '' }, { where: { id: sinMirar.id } });
    const r2 = await heredarConexionesPropias(db);
    chk('la foto se saca y deja la marca', [true, true], [Array.isArray(r2), Boolean(await PlatformSetting.findByPk(MARCA_CONEXIONES_PROPIAS))]);
    chk('el Inicial con tienda la hereda', 'tiendaPropia', await herencia(conTienda));
    chk('   sin pisar lo que ya heredaba (depósito)', 'deposito,portalMayorista', await herencia(conDeposito));
    chk('   una credencial revocada no hereda nada', '', await herencia(revocada));
    chk('   el que hereda TAMBIÉN la tienda la suma (no se cambia por otra)', 'tiendaPropia', await herencia(sinMirar));
    chk('   el Pro también queda marcado (la conserva si un día baja)', 'tiendaPropia', await herencia(pro));
    chk('después de la foto, la tienda del Inicial entra', 200, (await api(tokConTienda, 'GET', '/integraciones/tienda/catalogo')).status);
    const despues = await negocio('Despues', { plan: 'inicial', heredadas: '' });
    const { token: tokDespues } = await integraciones.emitir({ businessId: despues.id, origen: 'isuwaya' });
    const r3 = await heredarConexionesPropias(db);
    chk('una credencial emitida DESPUÉS de la foto no hereda: corre una sola vez', [null, ''],
      [r3, await herencia(despues)]);
    chk('   y rebota hasta que el negocio pase al Pro', 402, (await api(tokDespues, 'GET', '/integraciones/isuwaya/precios')).status);

    tit('5. LA COTIZACIÓN: SE GUARDA AUNQUE EL MAIL FALLE');
    const auth = (b, extra = {}) => ({ businessId: b.id, type: 'business', ...extra });
    // Con try propio: si el error del mail se escapara, tiene que verse como
    // esta comprobación caída y no como la suite entera abortada.
    let r = null;
    let errorAlCrear = null;
    try {
      r = await plataformas.crearCotizacion(auth(inicial), { tipo: 'portal_mayorista', detalle: DETALLE },
        { enviar: async () => { throw new Error('SMTP caído (simulado)'); } });
    } catch (e) { errorAlCrear = e.message; }
    chk('con el mail tirando error, la cotización se crea igual', ['nueva', 'portal_mayorista', null],
      [r?.cotizacion?.estado, r?.cotizacion?.tipo, errorAlCrear]);
    if (r) await r._aviso;
    let fila = r ? await CotizacionDesarrollo.findByPk(r.cotizacion.id) : null;
    chk('   queda en la base, con el error del aviso anotado', [inicial.id, null, true],
      [fila?.businessId, fila?.avisoEnviadoEn ?? null, /SMTP caído/.test(fila?.avisoError || '')]);

    // El mail colgado se simula con una promesa que tarda 5 s: si el pedido
    // la esperara, la comprobación cae (y la suite no queda colgada).
    const t0 = Date.now();
    r = await plataformas.crearCotizacion(auth(inicial), { tipo: 'portal_mayorista', detalle: DETALLE },
      { enviar: () => esperar(5000).then(() => ({ enviado: false, motivo: 'colgado' })) });
    chk('con el mail colgado, contesta igual sin esperarlo', true, Date.now() - t0 < 2000);
    chk('   y la fila ya está', true, Boolean(await CotizacionDesarrollo.findByPk(r.cotizacion.id)));

    r = await plataformas.crearCotizacion(auth(inicial), { tipo: 'portal_mayorista', detalle: DETALLE },
      { enviar: async () => ({ enviado: false, motivo: 'correo no configurado' }) });
    await r._aviso;
    fila = await CotizacionDesarrollo.findByPk(r.cotizacion.id);
    chk('sin correo configurado: guardada, con el motivo', [true, 'correo no configurado'], [Boolean(fila), fila.avisoError]);

    // Por el router de verdad, con el emailService real y el transporte simulado tirando.
    correoSimulado.falla = 'Invalid login: 535 (simulado)';
    const antes = await CotizacionDesarrollo.count({ where: { businessId: pro.id } });
    const rHttp = await api(tokPro, 'POST', '/plataformas/cotizaciones', { tipo: 'portal_mayorista', detalle: DETALLE, businessId: inicial.id });
    chk('POST del dueño con el SMTP rechazando → 201', 201, rHttp.status);
    chk('   el negocio sale de la sesión, no del cuerpo', [antes + 1, pro.id],
      [await CotizacionDesarrollo.count({ where: { businessId: pro.id } }), (await CotizacionDesarrollo.findByPk(rHttp.json?.cotizacion?.id))?.businessId]);
    await esperar(300);
    chk('   y el error del correo quedó anotado en la fila', true,
      /535/.test((await CotizacionDesarrollo.findByPk(rHttp.json?.cotizacion?.id))?.avisoError || ''));
    correoSimulado.falla = null;

    tit('5b. QUIÉN PUEDE PEDIRLA');
    const tokIntegrEditar = await tokEmpleado(pro, { integraciones: 'editar' });
    const tokVentasEditar = await tokEmpleado(pro, { ventas: 'editar' });
    const cuenta0 = await CotizacionDesarrollo.count({ where: { businessId: pro.id } });
    chk('un cargo con integraciones sólo para ver → 403', 403,
      (await api(tokSoloIntegr, 'POST', '/plataformas/cotizaciones', { tipo: 'portal_mayorista', detalle: DETALLE })).status);
    chk('un cargo con ventas en edición → 403 (puede usar la bandeja, no contratar)', 403,
      (await api(tokVentasEditar, 'POST', '/plataformas/cotizaciones', { tipo: 'portal_mayorista', detalle: DETALLE })).status);
    chk('un cargo sin nada → 403', 403,
      (await api(tokNada, 'POST', '/plataformas/cotizaciones', { tipo: 'portal_mayorista', detalle: DETALLE })).status);
    chk('sin sesión → 401', 401, (await api(null, 'POST', '/plataformas/cotizaciones', { tipo: 'portal_mayorista', detalle: DETALLE })).status);
    chk('   y ninguno de esos dejó una fila', cuenta0, await CotizacionDesarrollo.count({ where: { businessId: pro.id } }));
    const rEmp = await api(tokIntegrEditar, 'POST', '/plataformas/cotizaciones', { tipo: 'tienda_propia', detalle: DETALLE });
    chk('un cargo con integraciones en edición → 201', 201, rEmp.status);
    chk('   y queda anotado qué empleado la pidió', true,
      Boolean((await CotizacionDesarrollo.findByPk(rEmp.json?.cotizacion?.id))?.pedidaPorEmployeeId));

    tit('5c. LO QUE SE VALIDA');
    chk('detalle de menos de 20 caracteres → 400', 400,
      (await api(tokPro, 'POST', '/plataformas/cotizaciones', { tipo: 'portal_mayorista', detalle: 'quiero un portal' })).status);
    chk('un tipo que no existe → 400', 400,
      (await api(tokPro, 'POST', '/plataformas/cotizaciones', { tipo: 'otra-cosa', detalle: DETALLE })).status);
    chk('un email de contacto mal escrito → 400', 400,
      (await api(tokPro, 'POST', '/plataformas/cotizaciones', { tipo: 'portal_mayorista', detalle: DETALLE, contactoEmail: 'no-es-un-mail' })).status);

    tit('5d. UNA CUENTA EN MODO LECTURA PUEDE PEDIRLA');
    const lectura = await negocio('Lectura', { plan: 'inicial', estado: 'lectura' });
    const tokLectura = await tokDuenio(lectura);
    chk('control: la cuenta está en lectura (otro POST → 402)', 402,
      (await api(tokLectura, 'POST', '/jumpseller/conectar', { loginKey: 'x', authToken: 'y' })).status);
    chk('pedir la cotización → 201', 201,
      (await api(tokLectura, 'POST', '/plataformas/cotizaciones', { tipo: 'portal_mayorista', detalle: DETALLE })).status);

    tit('5e. EL LÍMITE: CINCO POR HORA Y POR NEGOCIO');
    const tokHeredado = await tokDuenio(heredado);
    const seguidas = [];
    for (let i = 0; i < 6; i += 1) {
      seguidas.push((await api(tokHeredado, 'POST', '/plataformas/cotizaciones', { tipo: 'portal_mayorista', detalle: DETALLE })).status);
    }
    chk('las cinco primeras entran y la sexta → 429', [201, 201, 201, 201, 201, 429], seguidas);

    tit('5f. EL MAIL ESCAPA LO QUE ESCRIBIÓ EL CLIENTE');
    correoSimulado.enviados.length = 0;
    const malicioso = 'Queremos un portal <script>alert(1)</script> con <img src=x onerror=alert(2)> para los mayoristas';
    const rMail = await plataformas.crearCotizacion(auth(pro), { tipo: 'portal_mayorista', detalle: malicioso, contactoNombre: '<b>Jefa</b>' });
    await rMail._aviso;
    const mail = correoSimulado.enviados.at(-1);
    chk('salió un mail (simulado) a la casilla de cotizaciones', true, Boolean(mail?.to));
    chk('   el HTML no lleva el <script> ni el <img> crudos', [false, false, false],
      [/<script>/i.test(mail?.html || ''), /<img src=x/i.test(mail?.html || ''), /<b>Jefa<\/b>/.test(mail?.html || '')]);
    chk('   sino escapados', true, (mail?.html || '').includes('&lt;script&gt;'));
    chk('   y el aviso quedó como enviado en la fila', true, Boolean((await CotizacionDesarrollo.findByPk(rMail.cotizacion.id)).avisoEnviadoEn));
    chk('   el asunto dice que es una cotización y de quién', true, /COTIZACIÓN/.test(mail?.subject || '') && /QA Plat Pro/.test(mail?.subject || ''));

    tit('5g. LO QUE VE EL CLIENTE DE SU PEDIDO, Y EL WHATSAPP');
    await CotizacionDesarrollo.update({ notaInterna: 'QA-NOTA-INTERNA' }, { where: { id: rMail.cotizacion.id } });
    const rLista = await api(tokPro, 'GET', '/plataformas/cotizaciones');
    chk('el cliente ve sus pedidos con el estado', [200, true],
      [rLista.status, rLista.json?.cotizaciones?.some((c) => c.id === rMail.cotizacion.id && c.estado === 'nueva')]);
    chk('   pero no la nota interna ni el estado del mail', [false, false],
      [rLista.crudo.includes('QA-NOTA-INTERNA'), /avisoError|avisoEnviadoEn|notaInterna/.test(rLista.crudo)]);
    chk('   y no ve los de otro negocio', false, rLista.json.cotizaciones.some((c) => c.id === r.cotizacion.id));

    const whatsappAntes = process.env.COTIZACIONES_WHATSAPP;
    delete process.env.COTIZACIONES_WHATSAPP;
    chk('sin COTIZACIONES_WHATSAPP no hay botón', [null, null],
      [plataformas.enlaceWhatsapp({ tipo: 'portal_mayorista', nombreNegocio: 'X' }), (await plataformas.estadoDePlataformas(pro.id)).whatsapp.portal_mayorista]);
    process.env.COTIZACIONES_WHATSAPP = '+54 9 11 0000-1111';
    const wa = plataformas.enlaceWhatsapp({ tipo: 'portal_mayorista', nombreNegocio: 'QA Plat Pro', id: 77 });
    chk('con el número, un enlace wa.me con sólo dígitos', true, wa.startsWith('https://wa.me/5491100001111?text='));
    chk('   y el texto ya escrito, con el negocio y el número de pedido', true,
      decodeURIComponent(wa.split('text=')[1]).includes('QA Plat Pro') && decodeURIComponent(wa.split('text=')[1]).includes('#77'));
    chk('   la respuesta del POST lo trae', true,
      String((await api(tokPro, 'POST', '/plataformas/cotizaciones', { tipo: 'tienda_propia', detalle: DETALLE })).json?.whatsapp || '').startsWith('https://wa.me/'));
    if (whatsappAntes === undefined) delete process.env.COTIZACIONES_WHATSAPP;
    else process.env.COTIZACIONES_WHATSAPP = whatsappAntes;

    tit('6. EL BACKOFFICE');
    chk('listar sin sesión de admin → 401', 401, (await api(null, 'GET', '/backoffice/cotizaciones')).status);
    chk('cambiar el estado sin sesión → 401', 401, (await api(null, 'PATCH', `/backoffice/cotizaciones/${rMail.cotizacion.id}`, { estado: 'contactada' })).status);
    chk('   ni con la sesión del dueño del negocio → 403', 403, (await api(tokPro, 'PATCH', `/backoffice/cotizaciones/${rMail.cotizacion.id}`, { estado: 'contactada' })).status);
    chk('   ni listar con esa sesión → 403', 403, (await api(tokPro, 'GET', '/backoffice/cotizaciones')).status);
    const lista = await plataformas.listarParaBackoffice({});
    const enLista = lista.find((c) => c.id === rMail.cotizacion.id);
    chk('la lista trae el negocio, el tipo y el estado del aviso', ['QA Plat Pro', 'Portal de pedidos mayoristas a medida', true],
      [enLista?.negocio?.nombre, enLista?.tipoTexto, Boolean(enLista?.avisoEnviadoEn)]);
    const soloNuevas = await plataformas.listarParaBackoffice({ estado: 'nueva' });
    chk('   y se filtra por estado', true, soloNuevas.every((c) => c.estado === 'nueva'));
    const cambiada = await plataformas.actualizarDesdeBackoffice(rMail.cotizacion.id, { estado: 'contactada', notaInterna: 'Llamar el lunes' }, { email: 'qa.bo@stocker.test' });
    chk('cambiar el estado lo deja anotado con quién y cuándo', ['contactada', 'qa.bo@stocker.test', true, 'Llamar el lunes'],
      [cambiada.estado, cambiada.estadoCambiadoPor, Boolean(cambiada.estadoCambiadoEn), cambiada.notaInterna]);
    let codigo = null;
    try { await plataformas.actualizarDesdeBackoffice(rMail.cotizacion.id, { estado: 'inventado' }); } catch (e) { codigo = e.status; }
    chk('un estado que no existe → 400', 400, codigo);
    codigo = null;
    try { await plataformas.actualizarDesdeBackoffice(999999999, { estado: 'contactada' }); } catch (e) { codigo = e.status; }
    chk('una cotización que no existe → 404', 404, codigo);
    const rCliente = await api(tokPro, 'GET', '/plataformas/cotizaciones');
    chk('el cliente ve el estado nuevo', 'contactada', rCliente.json.cotizaciones.find((c) => c.id === rMail.cotizacion.id)?.estado);
  } catch (e) {
    ko += 1;
    console.error('\x1b[31mERROR\x1b[0m', e);
  } finally {
    await limpiar();
    // Lo global, como estaba.
    if (marcaAntesValor) await PlatformSetting.upsert(marcaAntesValor);
    else await PlatformSetting.destroy({ where: { clave: MARCA_CONEXIONES_PROPIAS } });
    for (const b of heredadasAntes) {
      await Business.update({ featuresHeredadas: b.featuresHeredadas }, { where: { id: b.id } });
    }
    server.close();
    console.log(`\n${ok} ok · ${ko} fallas`);
    await db.close().catch(() => {});
    process.exit(ko ? 1 : 0);
  }
})();
