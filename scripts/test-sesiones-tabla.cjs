/*
 * Las sesiones con tabla: el sid en el token, el límite del dueño por plan,
 * la lista de la cuenta y los cierres.
 *
 * Lo que se comprueba, y por qué importa:
 *
 *   · El login crea la fila y el token lleva su sid, que sobrevive a las
 *     renovaciones. Si el sid se perdiera al re-firmar, la sesión moriría en
 *     el segundo pedido.
 *   · Un token sin sid (de antes del despliegue) NO entra. Tampoco un token
 *     firmado que no es de sesión (el `state` del OAuth de Mercado Libre).
 *   · Un token cuya fila está cerrada NO entra, y el 401 dice por qué.
 *   · La última actividad se escribe como mucho una vez por minuto.
 *   · "Salir" cierra la fila, aunque el token ya esté vencido.
 *   · El límite (SESIONES_LIMITE=activo) cierra la sesión del dueño con MENOS
 *     ACTIVIDAD —no la más vieja—, la que entra nunca es la desplazada, y seis
 *     ingresos simultáneos no se pasan del tope.
 *   · En modo sombra no se cierra nada y queda la marca en el log.
 *   · Los empleados no tienen tope.
 *   · El dueño ve todas las sesiones del negocio; un empleado, sólo las suyas.
 *     Nadie ve ni cierra las de otro negocio.
 *   · Cambio de contraseña, olvidé mi contraseña, cerrar todas y cambiarle la
 *     contraseña a un empleado cierran las filas que corresponde, y sólo ésas.
 *   · La purga borra lo de más de 90 días y nada más.
 *   · El catálogo trae el tope de cada plan (decisión del dueño) y la semilla
 *     lo corrige en los planes que nadie editó.
 *
 * EN PROCESO: se llama al middleware y a los controladores con un req y un res
 * de mentira, como test-tienda.cjs. No depende del puerto 3000 ni de los
 * limitadores de pedidos, que frenarían una suite que entra decenas de veces.
 *
 * Corre sobre negocios y un plan propios y descartables.
 *
 * Uso:  node scripts/test-sesiones-tabla.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const {
  Business, Employee, Role, Subscription, Plan, SesionCuenta, AuthAttempt,
  AccountChangeCode, PasswordResetCode,
} = require('../src/models');
const planService = require('../src/services/planService');
const sesiones = require('../src/services/sesionesService');
const { requireAuth } = require('../src/middleware/auth');
const authCtrl = require('../src/controllers/authController');
const accountCtrl = require('../src/controllers/accountController');
const sesionesCtrl = require('../src/controllers/sesionesController');
const employeeCtrl = require('../src/controllers/employeeController');
const backofficeCtrl = require('../src/controllers/backofficeController');
const { signToken, verifyToken } = require('../src/utils/jwt');
const { renovarSesion, IDLE_MS } = require('../src/utils/session');
const { etiquetaDeDispositivo, normalizarIp } = require('../src/utils/dispositivo');
const { PLANES } = require('../src/config/planes');
const totp = require('../src/utils/totp');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/* ── Datos de prueba, inventados ───────────────────────────────── */

const PATRON = 'qa.sestabla.%@stocker.test';
const SUF = `${process.pid}${Date.now().toString(36)}`;
const EMAIL_A = `qa.sestabla.a.${SUF}@stocker.test`;
const EMAIL_B = `qa.sestabla.b.${SUF}@stocker.test`;
const EMAIL_EMP = `qa.sestabla.emp.${SUF}@stocker.test`;
const EMAIL_EMP2 = `qa.sestabla.emp2.${SUF}@stocker.test`;
const CUIT_A = '20999777661';
const CUIT_B = '20999777653';
const CLAVE = 'QaSesTabla2026!';
const CLAVE_NUEVA = 'QaSesTabla2026!otra';
const CLAVE_EMP = 'QaEmpTabla2026!';
const PLAN_QA = 'qa-sesiones';

const UA_CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const UA_SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/* ── req y res de mentira ──────────────────────────────────────── */

function armarReq({ token, cookie, body = {}, params = {}, ip = '203.0.113.7', ua = UA_CHROME_WIN, method = 'GET', path = '/account/sesiones' } = {}) {
  return {
    headers: { 'user-agent': ua, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    cookies: cookie ? { stockerToken: cookie } : {},
    body, params, query: {}, ip, method, path,
  };
}

function armarRes(resolve) {
  return {
    statusCode: 200,
    tokenNuevo: null,
    status(c) { this.statusCode = c; return this; },
    json(payload) { resolve({ status: this.statusCode, json: payload, token: this.tokenNuevo, res: this }); },
    send() { resolve({ status: this.statusCode, json: null, token: this.tokenNuevo, res: this }); },
    cookie(_nombre, valor) { this.tokenNuevo = valor; },
    clearCookie() { this.borro = true; },
    getHeader() { return undefined; },
    setHeader() {},
    removeHeader() {},
  };
}

// Un controlador suelto (login, logout): sin requireAuth delante.
function llamar(handler, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = armarReq(opts);
    if (opts.auth) req.auth = opts.auth;
    const res = armarRes(resolve);
    Promise.resolve(handler(req, res, (err) => (err ? reject(err) : resolve({ status: 'next' })))).catch(reject);
  });
}

// requireAuth y, si deja pasar, el controlador. Sin controlador devuelve 'paso'.
function conSesion(token, handler, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = armarReq({ token, ...opts });
    const res = armarRes(resolve);
    Promise.resolve(requireAuth(req, res, (err) => {
      if (err) return reject(err);
      if (!handler) return resolve({ status: 'paso', req, token: res.tokenNuevo });
      return Promise.resolve(handler(req, res, (e) => (e ? reject(e) : resolve({ status: 'next' })))).catch(reject);
    })).catch(reject);
  });
}

const entraDueno = (email, opts = {}) =>
  llamar(authCtrl.login, { ...opts, method: 'POST', path: '/auth/login', body: { email, password: CLAVE, ...(opts.body || {}) } });
const entraEmpleado = (email, opts = {}) =>
  llamar(authCtrl.employeeLogin, { method: 'POST', path: '/auth/employee-login', body: { email, password: CLAVE_EMP }, ...opts });

const sidDe = (token) => verifyToken(token).sid;
// El payload sin los campos que pone jsonwebtoken, para volver a firmarlo.
const sinSello = (token) => { const { iat, exp, nbf, ...resto } = verifyToken(token); return resto; };
const filaDe = (token) => SesionCuenta.findOne({ where: { sid: sidDe(token) } });
const pasa = async (token) => (await conSesion(token)).status;
const codigoDe = async (token) => (await conSesion(token)).json?.codigo;

/* ── Limpieza ──────────────────────────────────────────────────── */

async function limpiar() {
  await AuthAttempt.destroy({ where: { identificador: { [Op.like]: PATRON } } }).catch(() => {});
  const restos = await Business.findAll({
    where: { [Op.or]: [{ email: { [Op.like]: PATRON } }, { cuit: [CUIT_A, CUIT_B] }] },
  });
  for (const b of restos) {
    await SesionCuenta.destroy({ where: { businessId: b.id } });
    await AccountChangeCode.destroy({ where: { businessId: b.id } }).catch(() => {});
    await PasswordResetCode.destroy({ where: { businessId: b.id } }).catch(() => {});
    await Employee.destroy({ where: { businessId: b.id } });
    await Role.destroy({ where: { businessId: b.id } });
    await Subscription.destroy({ where: { businessId: b.id } });
    await b.destroy();
  }
  const plan = await Plan.findOne({ where: { codigo: PLAN_QA } });
  if (plan) {
    await Subscription.destroy({ where: { planId: plan.id } });
    await plan.destroy();
  }
}

/* ── El log, para ver la marca del modo sombra ─────────────────── */

const avisos = [];
const warnOriginal = console.warn;
console.warn = (...args) => { avisos.push(args.join(' ')); };

(async () => {
  await limpiar();
  const modoOriginal = process.env.SESIONES_LIMITE;

  // Un plan propio con tope 2: no depende de cómo estén editados los reales.
  const planQa = await Plan.create({
    codigo: PLAN_QA, nombre: 'QA Sesiones', precioMensual: null, maxSesiones: 2,
    features: {}, activo: false, orden: 99, editadoEn: new Date(),
  });

  const negocioA = await Business.create({
    nombreNegocio: 'QA Sesiones A', ownerNombre: 'Ana', ownerApellido: 'Prueba',
    cuit: CUIT_A, email: EMAIL_A, passwordHash: await bcrypt.hash(CLAVE, 10),
  });
  const negocioB = await Business.create({
    nombreNegocio: 'QA Sesiones B', ownerNombre: 'Beto', ownerApellido: 'Prueba',
    cuit: CUIT_B, email: EMAIL_B, passwordHash: await bcrypt.hash(CLAVE, 10),
  });
  await planService.iniciarTrial(negocioA.id, { plan: PLAN_QA });
  await planService.iniciarTrial(negocioB.id, { plan: PLAN_QA });

  const cargo = await Role.create({ businessId: negocioA.id, nombre: 'QA Cargo', permisos: { clientes: 'ver' } });
  const empleado = await Employee.create({
    businessId: negocioA.id, roleId: cargo.id, dni: '39111222', nombre: 'Emi', apellido: 'Prueba',
    email: EMAIL_EMP, passwordHash: await bcrypt.hash(CLAVE_EMP, 10), activo: true,
  });
  const empleado2 = await Employee.create({
    businessId: negocioA.id, roleId: cargo.id, dni: '39111223', nombre: 'Eva', apellido: 'Prueba',
    email: EMAIL_EMP2, passwordHash: await bcrypt.hash(CLAVE_EMP, 10), activo: true,
  });

  // Empezar cada bloque sin sesiones del negocio A.
  const vaciarA = () => SesionCuenta.destroy({ where: { businessId: negocioA.id } });
  const activasDelDueno = (id = negocioA.id) => sesiones.contarActivasDelDueno(id);

  try {
    tit('1. EL LOGIN ABRE UNA FILA Y EL TOKEN LLEVA SU SID');
    process.env.SESIONES_LIMITE = 'off';
    const login = await entraDueno(EMAIL_A, { ua: UA_SAFARI_IPHONE, ip: '::ffff:198.51.100.23' });
    chk('el dueño entra', 200, login.status);
    const payload = verifyToken(login.token);
    chk('el token lleva un sid', true, typeof payload.sid === 'string' && payload.sid.length === 36);
    const fila = await filaDe(login.token);
    chk('y existe su fila, del negocio y del dueño',
      [negocioA.id, 'business', null], [fila?.businessId, fila?.tipo, fila?.employeeId]);
    chk('con la IP sin el prefijo IPv6', '198.51.100.23', fila?.ip);
    chk('y el dispositivo legible', 'Safari · iPhone', fila?.dispositivo);
    chk('su vencimiento es el tope absoluto del token', payload.absExp * 1000, new Date(fila.venceEn).getTime());

    const paso = await conSesion(login.token);
    chk('requireAuth lo deja pasar', 'paso', paso.status);
    chk('y deja a mano la fila de la sesión', fila.id, paso.req?.sesion?.id);

    /*
     * La ventana deslizante re-firma el token en cada pedido. Si el sid se
     * perdiera ahí, la sesión moriría en el segundo pedido.
     */
    let renovado = login.token;
    for (let i = 0; i < 3; i++) renovado = renovarSesion(verifyToken(renovado));
    chk('el sid sobrevive a tres renovaciones', payload.sid, sidDe(renovado));
    chk('y el token renovado entra', 'paso', await pasa(renovado));
    const porCookie = await conSesion(null, null, { cookie: login.token });
    chk('por cookie, requireAuth renueva y el token nuevo lleva el mismo sid',
      payload.sid, porCookie.token ? sidDe(porCookie.token) : null);

    tit('2. UN TOKEN SIN SID NO ENTRA');
    // Así eran los tokens de antes del despliegue: firmados, vigentes, sin sid.
    const viejo = signToken(
      { type: 'business', businessId: negocioA.id, iniciada: Date.now(), absExp: Math.floor(Date.now() / 1000) + 3600 },
      { expiresIn: '30m' },
    );
    const conViejo = await conSesion(viejo);
    chk('un token sin sid da 401', 401, conViejo.status);
    chk('con el código de la sesión anterior', 'SESION_ANTERIOR', conViejo.json?.codigo);
    // Firmado con el mismo secreto, pero no es una sesión.
    const estadoMl = signToken({ tipo: 'ml_oauth', businessId: negocioA.id }, { expiresIn: '10m' });
    chk('el state del OAuth de Mercado Libre no sirve de credencial', 401, (await conSesion(estadoMl)).status);

    tit('3. UNA FILA CERRADA DEJA AFUERA A SU TOKEN');
    const cerrarConMotivo = async (token, motivo) => {
      await SesionCuenta.update({ cerradaEn: new Date(), motivoCierre: motivo }, { where: { sid: sidDe(token) } });
    };
    const s3a = (await entraDueno(EMAIL_A)).token;
    const s3b = (await entraDueno(EMAIL_A)).token;
    const s3c = (await entraDueno(EMAIL_A)).token;
    await cerrarConMotivo(s3a, 'remota');
    await cerrarConMotivo(s3b, 'limite');
    await cerrarConMotivo(s3c, 'password');
    chk('cerrada desde otro dispositivo: 401', 401, (await conSesion(s3a)).status);
    chk('y lo dice', 'SESION_CERRADA_REMOTA', await codigoDe(s3a));
    chk('desplazada por el límite del plan', 'SESION_DESPLAZADA', await codigoDe(s3b));
    chk('cerrada por cambio de contraseña', 'SESION_CERRADA', await codigoDe(s3c));
    chk('reintentar no la resucita', 401, (await conSesion(s3a)).status);

    const s3d = (await entraDueno(EMAIL_A)).token;
    await SesionCuenta.update({ venceEn: new Date(Date.now() - 1000) }, { where: { sid: sidDe(s3d) } });
    chk('una fila pasada de su tope absoluto tampoco entra', 401, (await conSesion(s3d)).status);

    /*
     * Un token que dijera ser de A con el sid de una sesión de B. No puede
     * pasar sin el secreto, pero si pasara, la fila tiene que contradecirlo.
     */
    const deB = (await entraDueno(EMAIL_B)).token;
    const cruzado = signToken(
      { type: 'business', businessId: negocioA.id, sid: sidDe(deB), iniciada: Date.now(), absExp: Math.floor(Date.now() / 1000) + 3600 },
      { expiresIn: '30m' },
    );
    chk('un sid de otro negocio no entra', 401, (await conSesion(cruzado)).status);

    tit('4. LA ÚLTIMA ACTIVIDAD SE ESCRIBE COMO MUCHO UNA VEZ POR MINUTO');
    await vaciarA();
    const s4 = (await entraDueno(EMAIL_A)).token;
    const antes = (await filaDe(s4)).ultimaActividadEn;
    await new Promise((r) => setTimeout(r, 30));
    await conSesion(s4);
    chk('un pedido dentro del minuto no la escribe',
      new Date(antes).getTime(), new Date((await filaDe(s4)).ultimaActividadEn).getTime());
    const haceDos = new Date(Date.now() - 2 * 60 * 1000);
    await SesionCuenta.update({ ultimaActividadEn: haceDos }, { where: { sid: sidDe(s4) } });
    await conSesion(s4);
    const despues = new Date((await filaDe(s4)).ultimaActividadEn).getTime();
    chk('pasado el minuto, sí', true, despues > haceDos.getTime() + 60 * 1000);

    tit('5. "SALIR" CIERRA LA FILA');
    const s5 = (await entraDueno(EMAIL_A)).token;
    const salida = await llamar(authCtrl.logout, { token: s5, method: 'POST', path: '/auth/logout' });
    chk('el logout contesta bien y borra la cookie', [200, true], [salida.status, Boolean(salida.res?.borro)]);
    const f5 = await filaDe(s5);
    chk('la fila queda cerrada por el usuario', [true, 'usuario'], [Boolean(f5.cerradaEn), f5.motivoCierre]);
    chk('y el token ya no entra', 401, (await conSesion(s5)).status);

    // Quien sale después de media hora quieto tiene el token vencido.
    const s5b = (await entraDueno(EMAIL_A)).token;
    const vencido = signToken(sinSello(s5b), { expiresIn: -10 });
    await llamar(authCtrl.logout, { token: vencido, method: 'POST', path: '/auth/logout' });
    chk('con el token vencido, también cierra', 'usuario', (await filaDe(s5b)).motivoCierre);

    // Con otra firma no: nadie cierra una sesión ajena inventando un token.
    const s5c = (await entraDueno(EMAIL_A)).token;
    const falso = jwt.sign(sinSello(s5c), 'otro-secreto-que-no-es-el-del-servidor-1234567890');
    await llamar(authCtrl.logout, { token: falso, method: 'POST', path: '/auth/logout' });
    chk('con un token de otra firma, no cierra nada', null, (await filaDe(s5c)).cerradaEn);

    tit('6. EL LÍMITE (activo): SE VA LA DE MENOS ACTIVIDAD, ENTRA LA NUEVA');
    process.env.SESIONES_LIMITE = 'activo';
    await vaciarA();
    const s6a = (await entraDueno(EMAIL_A)).token;
    const s6b = (await entraDueno(EMAIL_A)).token;
    /*
     * La primera es la más VIEJA pero la más activa; la segunda, la más nueva
     * pero quieta hace diez minutos. Tiene que irse la segunda: el límite es
     * por actividad, no por antigüedad. Si se fuera la más vieja, el dueño que
     * trabaja todo el día en la PC del local sería el echado cada vez que mira
     * algo en el celular.
     */
    await SesionCuenta.update({ ultimaActividadEn: new Date(Date.now() - 60 * 1000) }, { where: { sid: sidDe(s6a) } });
    await SesionCuenta.update({ ultimaActividadEn: new Date(Date.now() - 10 * 60 * 1000) }, { where: { sid: sidDe(s6b) } });
    chk('dos sesiones, en el tope', 2, await activasDelDueno());

    const tercera = await entraDueno(EMAIL_A);
    chk('la tercera entra: el límite no rechaza el login', 200, tercera.status);
    chk('siguen siendo dos', 2, await activasDelDueno());
    chk('se cerró la de menos actividad', 'limite', (await filaDe(s6b)).motivoCierre);
    chk('y no la más vieja', null, (await filaDe(s6a)).cerradaEn);
    chk('la que entró está abierta', null, (await filaDe(tercera.token)).cerradaEn);
    chk('la desplazada no entra y sabe por qué', 'SESION_DESPLAZADA', await codigoDe(s6b));
    chk('las otras dos trabajan', ['paso', 'paso'], [await pasa(s6a), await pasa(tercera.token)]);

    /*
     * Una sesión abandonada hace más de media hora no cuenta: su token ya
     * venció. Si contara, el dueño que olvidó una pestaña abierta ayer echaría
     * a su teléfono al entrar hoy desde la PC.
     */
    await SesionCuenta.update(
      { ultimaActividadEn: new Date(Date.now() - IDLE_MS - 5 * 60 * 1000) },
      { where: { sid: sidDe(s6a) } },
    );
    chk('una sesión quieta más de 30 min no cuenta', 1, await activasDelDueno());
    const cuarta = await entraDueno(EMAIL_A);
    chk('así que la cuarta entra sin desplazar a nadie', null, (await filaDe(tercera.token)).cerradaEn);
    chk('y quedan dos', 2, await activasDelDueno());
    chk('la cuarta trabaja', 'paso', await pasa(cuarta.token));

    tit('7. CON DOBLE FACTOR: EL CÓDIGO SE GASTA Y EL QUE ENTRA NO SE CAE');
    await vaciarA();
    const secreto = totp.generarSecreto();
    await negocioA.update({ totpSecret: secreto, totpActivadoEn: new Date(), totpUltimoPaso: null });
    const filasAntes = await SesionCuenta.count({ where: { businessId: negocioA.id } });
    const sinCodigo = await entraDueno(EMAIL_A);
    chk('sin código: 401 TOTP_REQUERIDO', [401, 'TOTP_REQUERIDO'], [sinCodigo.status, sinCodigo.json?.codigo]);
    chk('y no se abrió ninguna sesión', filasAntes, await SesionCuenta.count({ where: { businessId: negocioA.id } }));
    chk('ni salió token', null, sinCodigo.token);

    // Dos sesiones abiertas con códigos de pasos anteriores, para estar en el tope.
    const pasoAhora = Math.floor(Date.now() / 1000 / 30);
    const d7a = await entraDueno(EMAIL_A, { body: { code: totp.codigoPara(secreto, pasoAhora - 1) } });
    const d7b = await entraDueno(EMAIL_A, { body: { code: totp.codigoPara(secreto, pasoAhora) } });
    chk('entra con su código', [200, 200], [d7a.status, d7b.status]);
    await SesionCuenta.update({ ultimaActividadEn: new Date(Date.now() - 5 * 60 * 1000) }, { where: { sid: sidDe(d7a.token) } });
    const codigoNuevo = totp.codigoPara(secreto, pasoAhora + 1);
    const d7c = await entraDueno(EMAIL_A, { body: { code: codigoNuevo } });
    chk('con el tope lleno, el tercero entra', 200, d7c.status);
    chk('y es otra sesión la que se cierra', ['limite', null],
      [(await filaDe(d7a.token)).motivoCierre, (await filaDe(d7c.token)).cerradaEn]);
    const repetido = await entraDueno(EMAIL_A, { body: { code: codigoNuevo } });
    chk('el código quedó gastado: no sirve dos veces', [401, 'TOTP_REQUERIDO'], [repetido.status, repetido.json?.codigo]);
    await negocioA.update({ totpSecret: null, totpActivadoEn: null, totpUltimoPaso: null });

    tit('8. MODO SOMBRA: SE CUENTA, SE LOGUEA Y NO SE CIERRA NADA');
    process.env.SESIONES_LIMITE = 'sombra';
    await vaciarA();
    const s8a = (await entraDueno(EMAIL_A)).token;
    const s8b = (await entraDueno(EMAIL_A)).token;
    avisos.length = 0;
    const s8c = (await entraDueno(EMAIL_A)).token;
    chk('la tercera entra', 'paso', await pasa(s8c));
    chk('no se cerró ninguna', 3, await activasDelDueno());
    chk('las dos de antes siguen trabajando', ['paso', 'paso'], [await pasa(s8a), await pasa(s8b)]);
    chk('y queda la marca en el log', true, avisos.some((a) => /modo sombra/i.test(a)));

    delete process.env.SESIONES_LIMITE;
    chk('sin la variable, el modo es sombra', 'sombra', sesiones.modoLimite());
    process.env.SESIONES_LIMITE = 'on';
    chk('un valor que no se entiende también cae en sombra', 'sombra', sesiones.modoLimite());
    await entraDueno(EMAIL_A);
    chk('y no cierra nada', 4, await activasDelDueno());

    process.env.SESIONES_LIMITE = 'off';
    avisos.length = 0;
    await entraDueno(EMAIL_A);
    chk('con off ni se cuenta: no hay marca', false, avisos.some((a) => /modo sombra/i.test(a)));
    chk('ni se cierra nada', 5, await activasDelDueno());

    tit('9. SIN TOPE EN EL PLAN, NO SE CUENTA');
    process.env.SESIONES_LIMITE = 'activo';
    await planQa.update({ maxSesiones: null });
    await entraDueno(EMAIL_A);
    chk('con el tope en nulo, nadie se cae', 6, await activasDelDueno());
    await planQa.update({ maxSesiones: 2 });

    tit('10. SEIS INGRESOS A LA VEZ NO SE PASAN DEL TOPE');
    await vaciarA();
    /*
     * Directo al servicio y no por el login: sin bcrypt en el medio, los seis
     * llegan de verdad juntos a contar. Sin la fila del negocio trabada, los
     * seis ven lugar y entran los seis.
     */
    const req10 = { headers: { 'user-agent': UA_CHROME_WIN }, ip: '203.0.113.9' };
    const seis = await Promise.all(Array.from({ length: 6 }, () =>
      sesiones.abrir(req10, { type: 'business', businessId: negocioA.id })));
    chk('salen seis tokens', 6, seis.length);
    chk('pero quedan exactamente dos activas', 2, await activasDelDueno());
    chk('y las otras cuatro, cerradas por el límite', 4,
      await SesionCuenta.count({ where: { businessId: negocioA.id, motivoCierre: 'limite' } }));

    tit('11. LOS EMPLEADOS NO TIENEN TOPE');
    await vaciarA();
    const jefe11 = (await entraDueno(EMAIL_A)).token;
    const deEmp = [];
    for (let i = 0; i < 4; i++) deEmp.push((await entraEmpleado(EMAIL_EMP)).token);
    chk('cuatro sesiones del mismo empleado, abiertas', 4,
      await SesionCuenta.count({ where: { businessId: negocioA.id, tipo: 'employee', cerradaEn: null } }));
    chk('todas entran', ['paso', 'paso', 'paso', 'paso'], await Promise.all(deEmp.map(pasa)));
    chk('y no le cuentan al dueño', 1, await activasDelDueno());
    const filaEmp = await filaDe(deEmp[0]);
    chk('su fila es de empleado', ['employee', empleado.id], [filaEmp.tipo, filaEmp.employeeId]);

    tit('12. LA LISTA: EL DUEÑO VE TODO, EL EMPLEADO SÓLO LO SUYO');
    // Una sesión vieja ya cerrada, una abandonada, y una de otro negocio.
    const s12cerrada = (await entraDueno(EMAIL_A)).token;
    await SesionCuenta.update({ cerradaEn: new Date(), motivoCierre: 'remota' }, { where: { sid: sidDe(s12cerrada) } });
    const s12quieta = (await entraDueno(EMAIL_A)).token;
    await SesionCuenta.update({ ultimaActividadEn: new Date(Date.now() - 2 * 60 * 60 * 1000) }, { where: { sid: sidDe(s12quieta) } });
    const s12vieja = (await entraDueno(EMAIL_A)).token;
    await SesionCuenta.update({
      creadaEn: new Date(Date.now() - 45 * 86400000),
      ultimaActividadEn: new Date(Date.now() - 45 * 86400000),
      venceEn: new Date(Date.now() - 44 * 86400000),
      cerradaEn: new Date(Date.now() - 44 * 86400000), motivoCierre: 'usuario',
    }, { where: { sid: sidDe(s12vieja) } });
    await entraDueno(EMAIL_B);

    const listaJefe = await conSesion(jefe11, sesionesCtrl.listar);
    chk('el dueño lista', 200, listaJefe.status);
    const L = listaJefe.json;
    const idsActivas = L.sesiones.map((s) => s.id);
    const filaJefe = await filaDe(jefe11);
    chk('marca cuál es la de este dispositivo', filaJefe.id, L.actual);
    chk('y la pone primera', true, L.sesiones[0]?.actual === true);
    chk('ve las del empleado', true, L.sesiones.some((s) => s.tipo === 'employee' && s.empleado?.id === empleado.id));
    chk('con el nombre del empleado', 'Emi', L.sesiones.find((s) => s.tipo === 'employee')?.empleado?.nombre);
    const idCerrada = (await filaDe(s12cerrada)).id;
    const enHistorial = L.historial.find((x) => x.id === idCerrada);
    chk('la cerrada va al historial, con su motivo',
      ['cerrada', 'remota', 'Se cerró desde otro dispositivo'],
      [enHistorial?.estado, enHistorial?.motivoCierre, enHistorial?.motivoTexto]);
    const idQuieta = (await filaDe(s12quieta)).id;
    chk('la abandonada no figura activa', false, idsActivas.includes(idQuieta));
    chk('figura como vencida', 'vencida', L.historial.find((x) => x.id === idQuieta)?.estado);
    const idVieja = (await filaDe(s12vieja)).id;
    chk('la que terminó hace 44 días no aparece', false, [...L.sesiones, ...L.historial].some((x) => x.id === idVieja));
    const idsB = (await SesionCuenta.findAll({ where: { businessId: negocioB.id }, attributes: ['id'] })).map((f) => f.id);
    chk('no aparece nada del otro negocio', false, [...L.sesiones, ...L.historial].some((x) => idsB.includes(x.id)));
    chk('trae el tope y el modo', [2, 'activo'], [L.limite?.tope, L.limite?.modo]);
    chk('y cuántas del dueño hay activas', await activasDelDueno(), L.limite?.activas);
    chk('no expone el sid de ninguna sesión', false, JSON.stringify(L).includes(sidDe(jefe11)));

    const listaEmp = await conSesion(deEmp[0], sesionesCtrl.listar);
    chk('el empleado lista', 200, listaEmp.status);
    const LE = listaEmp.json;
    chk('ve sus cuatro sesiones', 4, LE.sesiones.length);
    chk('y ninguna del dueño', false, [...LE.sesiones, ...LE.historial].some((x) => x.tipo === 'business'));
    chk('ni de otro empleado', true, [...LE.sesiones, ...LE.historial].every((x) => x.empleado?.id === empleado.id));
    chk('sin datos del límite del dueño', null, LE.limite);

    tit('13. CERRAR UNA');
    const filaEmp1 = await filaDe(deEmp[1]);
    const sinClave = await conSesion(jefe11, sesionesCtrl.cerrarUna, { method: 'POST', params: { id: String(filaEmp1.id) }, body: {} });
    chk('sin contraseña no cierra', 400, sinClave.status);
    const claveMala = await conSesion(jefe11, sesionesCtrl.cerrarUna, { method: 'POST', params: { id: String(filaEmp1.id) }, body: { passwordActual: 'no-es' } });
    chk('con la contraseña equivocada tampoco', 400, claveMala.status);
    chk('y la sesión sigue', 'paso', await pasa(deEmp[1]));

    const idDeB = idsB[0];
    const ajena = await conSesion(jefe11, sesionesCtrl.cerrarUna, { method: 'POST', params: { id: String(idDeB) }, body: { passwordActual: CLAVE } });
    chk('una sesión de otro negocio da 404', 404, ajena.status);
    chk('y no se cerró', null, (await SesionCuenta.findByPk(idDeB)).cerradaEn);

    const propia = await conSesion(jefe11, sesionesCtrl.cerrarUna, { method: 'POST', params: { id: String(filaJefe.id) }, body: { passwordActual: CLAVE } });
    chk('la propia no se cierra por acá (es «Salir»)', 400, propia.status);

    const delEmpAlJefe = await conSesion(deEmp[0], sesionesCtrl.cerrarUna, { method: 'POST', params: { id: String(filaJefe.id) }, body: { passwordActual: CLAVE_EMP } });
    chk('un empleado no puede cerrar la del dueño: 404', 404, delEmpAlJefe.status);
    chk('y el dueño sigue adentro', 'paso', await pasa(jefe11));

    const cierre = await conSesion(jefe11, sesionesCtrl.cerrarUna, { method: 'POST', params: { id: String(filaEmp1.id) }, body: { passwordActual: CLAVE } });
    chk('el dueño cierra la de un empleado', 200, cierre.status);
    chk('y esa sesión queda afuera', 'SESION_CERRADA_REMOTA', await codigoDe(deEmp[1]));

    const filaEmp2 = await filaDe(deEmp[2]);
    const elMismo = await conSesion(deEmp[0], sesionesCtrl.cerrarUna, { method: 'POST', params: { id: String(filaEmp2.id) }, body: { passwordActual: CLAVE_EMP } });
    chk('el empleado cierra otra sesión suya', 200, elMismo.status);
    chk('y queda afuera', 401, (await conSesion(deEmp[2])).status);

    tit('14. CERRAR TODAS MENOS ÉSTA');
    // El empleado: sólo las suyas.
    const otraDelJefe = (await entraDueno(EMAIL_A)).token;
    const emp2 = (await entraEmpleado(EMAIL_EMP2)).token;
    const todasEmp = await conSesion(deEmp[0], sesionesCtrl.cerrarOtras, { method: 'POST', path: '/account/sesiones/cerrar', body: { passwordActual: CLAVE_EMP } });
    chk('el empleado cierra las suyas', 200, todasEmp.status);
    chk('la suya restante queda afuera', 401, (await conSesion(deEmp[3])).status);
    chk('la de este dispositivo sigue', 'paso', await pasa(deEmp[0]));
    chk('el dueño no se entera', ['paso', 'paso'], [await pasa(jefe11), await pasa(otraDelJefe)]);
    chk('ni su compañera', 'paso', await pasa(emp2));

    // El dueño: todo el negocio.
    const sinClaveTodas = await conSesion(jefe11, sesionesCtrl.cerrarOtras, { method: 'POST', path: '/account/sesiones/cerrar', body: { passwordActual: 'no-es' } });
    chk('el dueño con la contraseña equivocada no cierra nada', [400, 'paso'], [sinClaveTodas.status, await pasa(otraDelJefe)]);
    const deBantes = (await entraDueno(EMAIL_B)).token;
    const todas = await conSesion(jefe11, sesionesCtrl.cerrarOtras, { method: 'POST', path: '/account/sesiones/cerrar', body: { passwordActual: CLAVE } });
    chk('con la correcta cierra', 200, todas.status);
    chk('la otra del dueño queda afuera', 'SESION_CERRADA_REMOTA', await codigoDe(otraDelJefe));
    chk('los empleados también', [401, 401], [(await conSesion(deEmp[0])).status, (await conSesion(emp2)).status]);
    chk('el que apretó sigue con un token nuevo de la MISMA sesión', sidDe(jefe11), todas.token ? sidDe(todas.token) : null);
    chk('ese token entra', 'paso', await pasa(todas.token));
    chk('y su fila sigue abierta', null, (await filaDe(jefe11)).cerradaEn);
    chk('el otro negocio no se tocó', 'paso', await pasa(deBantes));
    const jefe14 = todas.token;

    tit('15. CAMBIO DE CONTRASEÑA DEL DUEÑO');
    const otra15 = (await entraDueno(EMAIL_A)).token;
    const emp15 = (await entraEmpleado(EMAIL_EMP)).token;
    await AccountChangeCode.create({
      businessId: negocioA.id, tipo: 'password', canal: 'email', destino: EMAIL_A, code: '418275', attemptsLeft: 4,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    const cambio = await conSesion(jefe14, accountCtrl.confirmarCambioPassword, {
      method: 'POST', path: '/account/password/confirmar', body: { code: '418275', passwordNueva: CLAVE_NUEVA },
    });
    chk('la contraseña cambia', 200, cambio.status);
    chk('la otra sesión del dueño se cierra por contraseña', 'password', (await filaDe(otra15)).motivoCierre);
    chk('y no entra', 'SESION_CERRADA', await codigoDe(otra15));
    chk('la de este dispositivo sigue abierta', null, (await filaDe(jefe14)).cerradaEn);
    chk('con un token nuevo de la misma sesión, que entra',
      [sidDe(jefe14), 'paso'], [cambio.token ? sidDe(cambio.token) : null, await pasa(cambio.token)]);
    chk('el empleado no se ve afectado', ['paso', null], [await pasa(emp15), (await filaDe(emp15)).cerradaEn]);
    await negocioA.update({ passwordHash: await bcrypt.hash(CLAVE, 10) });
    const jefe15 = cambio.token;

    tit('16. OLVIDÉ MI CONTRASEÑA CIERRA TODAS LAS DEL DUEÑO');
    const otra16 = (await entraDueno(EMAIL_A)).token;
    await PasswordResetCode.create({
      businessId: negocioA.id, code: '736214', attemptsLeft: 4, expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    const reset = await llamar(authCtrl.resetPassword, {
      method: 'POST', path: '/auth/reset-password', body: { email: EMAIL_A, code: '736214', newPassword: CLAVE_NUEVA },
    });
    chk('la contraseña se rehace', 200, reset.status);
    chk('se cierran todas las del dueño, sin excepción', ['password', 'password'],
      [(await filaDe(otra16)).motivoCierre, (await filaDe(jefe15)).motivoCierre]);
    chk('las del empleado no', null, (await filaDe(emp15)).cerradaEn);
    await negocioA.update({ passwordHash: await bcrypt.hash(CLAVE, 10) });

    tit('17. EMPLEADO: CAMBIO DE CONTRASEÑA Y BORRADO');
    const jefe17 = (await entraDueno(EMAIL_A)).token;
    const emp17 = (await entraEmpleado(EMAIL_EMP)).token;
    const emp17b = (await entraEmpleado(EMAIL_EMP2)).token;
    const edicion = await conSesion(jefe17, employeeCtrl.updateEmployee, {
      method: 'PUT', path: `/employees/${empleado.id}`, params: { id: String(empleado.id) }, body: { password: 'QaEmpTabla2026!nueva' },
    });
    chk('el dueño le cambia la contraseña', 200, edicion.status);
    chk('sus filas se cierran por contraseña', 'password', (await filaDe(emp17)).motivoCierre);
    chk('la de la compañera no', null, (await filaDe(emp17b)).cerradaEn);
    chk('ni la del dueño', null, (await filaDe(jefe17)).cerradaEn);

    // Desactivar NO cierra: reactivar devuelve la misma sesión (test-aislamiento).
    const toggle = await conSesion(jefe17, employeeCtrl.toggleActive, {
      method: 'PATCH', path: `/employees/${empleado2.id}/toggle`, params: { id: String(empleado2.id) },
    });
    chk('desactivar a la compañera', 200, toggle.status);
    chk('no le cierra la fila', null, (await filaDe(emp17b)).cerradaEn);
    chk('pero no entra', 401, (await conSesion(emp17b)).status);
    const listaSusp = await conSesion(jefe17, sesionesCtrl.listar);
    const susp = listaSusp.json.sesiones.find((s) => s.empleado?.id === empleado2.id);
    chk('y la lista la marca suspendida', true, susp?.suspendida === true);
    await conSesion(jefe17, employeeCtrl.toggleActive, {
      method: 'PATCH', path: `/employees/${empleado2.id}/toggle`, params: { id: String(empleado2.id) },
    });
    chk('reactivada, la misma sesión vuelve a entrar', 'paso', await pasa(emp17b));

    const borrado = await conSesion(jefe17, employeeCtrl.deleteEmployee, {
      method: 'DELETE', path: `/employees/${empleado2.id}`, params: { id: String(empleado2.id) },
    });
    chk('borrarla', 204, borrado.status);
    chk('cierra su fila por baja', 'baja', (await filaDe(emp17b)).motivoCierre);
    chk('que queda en el historial aunque ya no exista la empleada', true,
      (await conSesion(jefe17, sesionesCtrl.listar)).json.historial.some((h) => h.motivoCierre === 'baja' && h.empleado?.id === empleado2.id));

    tit('18. LA PURGA');
    const purgaVieja = await SesionCuenta.create({
      sid: `qa-purga-1-${SUF}`.slice(0, 36), businessId: negocioA.id, tipo: 'business',
      creadaEn: new Date(Date.now() - 120 * 86400000), ultimaActividadEn: new Date(Date.now() - 120 * 86400000),
      venceEn: new Date(Date.now() - 119 * 86400000), cerradaEn: new Date(Date.now() - 100 * 86400000), motivoCierre: 'usuario',
    });
    const purgaAbierta = await SesionCuenta.create({
      sid: `qa-purga-2-${SUF}`.slice(0, 36), businessId: negocioA.id, tipo: 'business',
      creadaEn: new Date(Date.now() - 120 * 86400000), ultimaActividadEn: new Date(Date.now() - 120 * 86400000),
      venceEn: new Date(Date.now() - 119 * 86400000),
    });
    const purgaReciente = await SesionCuenta.create({
      sid: `qa-purga-3-${SUF}`.slice(0, 36), businessId: negocioA.id, tipo: 'business',
      creadaEn: new Date(Date.now() - 20 * 86400000), ultimaActividadEn: new Date(Date.now() - 20 * 86400000),
      venceEn: new Date(Date.now() - 19 * 86400000), cerradaEn: new Date(Date.now() - 10 * 86400000), motivoCierre: 'usuario',
    });
    await sesiones.purgar();
    chk('borra la cerrada hace 100 días', null, await SesionCuenta.findByPk(purgaVieja.id));
    chk('y la que nunca se cerró pero venció hace 119', null, await SesionCuenta.findByPk(purgaAbierta.id));
    chk('no toca la de hace 10 días', true, Boolean(await SesionCuenta.findByPk(purgaReciente.id)));
    chk('ni las abiertas de hoy', 'paso', await pasa(jefe17));

    tit('19. LOS PLANES');
    const porCodigo = Object.fromEntries(PLANES.map((p) => [p.codigo, p.maxSesiones]));
    chk('el catálogo trae el tope del dueño (Inicial 2, Pro 3, Superior 5, Enterprise sin tope)',
      { inicial: 2, pro: 3, superior: 5, enterprise: null }, porCodigo);
    for (const p of PLANES) {
      const fila = await Plan.findOne({ where: { codigo: p.codigo } });
      if (fila && !fila.editadoEn) chk(`la base tiene el del ${p.codigo}`, p.maxSesiones ?? null, fila.maxSesiones);
    }

    /*
     * La semilla corrige el tope en un plan que nadie editó. Si `maxSesiones`
     * no estuviera en la comparación, un plan de la base con otro número
     * quedaría "igual" y no se tocaría nunca.
     */
    const inicial = await Plan.findOne({ where: { codigo: 'inicial' } });
    if (inicial && !inicial.editadoEn) {
      const original = inicial.maxSesiones;
      await inicial.update({ maxSesiones: 9 });
      await planService.sembrarPlanes();
      await inicial.reload();
      chk('la semilla corrige un tope de sesiones distinto', 2, inicial.maxSesiones);
      // Si la prueba falló, el plan real no puede quedar con el 9.
      if (inicial.maxSesiones === 9) await inicial.update({ maxSesiones: original });
    } else {
      console.log('  — el plan inicial está editado desde el backoffice: no se prueba la semilla');
    }

    const uso = await planService.usoDe(negocioA.id);
    chk('el uso del plan trae las sesiones del dueño', [await activasDelDueno(), 2, 'activo'],
      [uso.sesiones?.usado, uso.sesiones?.tope, uso.sesiones?.modo]);

    const conAdmin = (handler) => (req, res, next) => { req.admin = { rol: 'owner', id: 0 }; return handler(req, res, next); };
    const editarComoAdmin = (valor) => llamar(conAdmin(backofficeCtrl.editarPlan), {
      method: 'PUT', params: { codigo: PLAN_QA }, body: { maxSesiones: valor },
    });
    chk('el backoffice no acepta cero', 400, (await editarComoAdmin(0)).status);
    chk('ni un número con decimales', 400, (await editarComoAdmin(2.5)).status);
    chk('acepta un entero', [200, 4], [(await editarComoAdmin(4)).status, (await planQa.reload()).maxSesiones]);
    chk('y vacío es sin tope', [200, null], [(await editarComoAdmin(null)).status, (await planQa.reload()).maxSesiones]);

    tit('20. LA ETIQUETA DEL DISPOSITIVO');
    chk('Chrome en Windows', 'Chrome · Windows', etiquetaDeDispositivo(UA_CHROME_WIN));
    chk('Safari en iPhone', 'Safari · iPhone', etiquetaDeDispositivo(UA_SAFARI_IPHONE));
    chk('Edge no se confunde con Chrome', 'Edge · Windows', etiquetaDeDispositivo(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0'));
    chk('Chrome en Android', 'Chrome · Android', etiquetaDeDispositivo(
      'Mozilla/5.0 (Linux; Android 14; SM-A146M) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36'));
    chk('Firefox en Mac', 'Firefox · Mac', etiquetaDeDispositivo(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0'));
    chk('un script no se disfraza de navegador', 'Otro programa', etiquetaDeDispositivo('curl/8.5.0'));
    chk('sin user agent', 'Dispositivo desconocido', etiquetaDeDispositivo(''));
    chk('la IPv4 mapeada pierde el prefijo', '10.1.2.3', normalizarIp('::ffff:10.1.2.3'));
    chk('una IPv6 de verdad queda igual', '2001:db8::1', normalizarIp('2001:db8::1'));

    tit('21. EL FRENO DE LA CONTRASEÑA NO SE ESQUIVA CON EL CUERPO DEL PEDIDO');
    /*
     * Cerrar sesiones pide la contraseña de quien tiene la sesión, y la
     * respuesta distingue "mal" (400) de "bien" (200/404): sin freno es un
     * oráculo para adivinarla. El freno lo pone el limitador de la RUTA, así
     * que esto va por HTTP, con el router de verdad, en un puerto efímero de
     * este mismo proceso (no en el 3000). `trust proxy` en 1 para poder
     * simular IPs con X-Forwarded-For, como hace Railway.
     *
     * La revisión de v3.44 encontró que la clave del limitador tomaba el email
     * del CUERPO antes que la sesión: mandando un email inventado distinto en
     * cada pedido, cada intento caía en un contador nuevo y nunca llegaba al
     * 429. Y sin email, el dueño y todos los empleados compartían cupo.
     */
    process.env.SESIONES_LIMITE = 'off';
    await empleado.update({ passwordHash: await bcrypt.hash(CLAVE_EMP, 10) });
    const express = require('express');
    const cookieParser = require('cookie-parser');
    const freno = require('../src/middleware/rateLimit');
    const app21 = express();
    app21.set('trust proxy', 1);
    app21.use(cookieParser());
    app21.use(express.json());
    app21.use('/api', require('../src/routes'));
    const server21 = await new Promise((r) => { const s = app21.listen(0, '127.0.0.1', () => r(s)); });
    const base21 = `http://127.0.0.1:${server21.address().port}/api`;
    const post21 = async (token, ruta, cuerpo, ip) => {
      const r = await fetch(base21 + ruta, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'X-Forwarded-For': ip,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(cuerpo),
      });
      let json = null;
      try { json = await r.json(); } catch { /* sin cuerpo */ }
      return { status: r.status, json };
    };
    // N intentos con la contraseña mal; devuelve los estados en orden.
    const fallar = async (token, ruta, n, ip, extra = () => ({})) => {
      const estados = [];
      for (let i = 0; i < n; i++) {
        estados.push((await post21(token, ruta, { passwordActual: `no-es-${i}`, ...extra(i) }, ip)).status);
      }
      return estados;
    };
    const llegaA429 = (estados) => estados.includes(429);

    // Las claves, sueltas: lo que decide en qué contador cae cada pedido.
    {
      const conAuth = (auth, body = {}, ip = '203.0.113.50') => ({ ip, auth, body });
      const dueno = { businessId: 7, type: 'business', sid: 's-1' };
      const cajero = { businessId: 7, type: 'employee', employeeId: 3, sid: 's-2' };
      chk('con sesión, el email del cuerpo no cambia la clave',
        freno.claveIpMasEmail(conAuth(dueno, { email: 'a@x.test' })),
        freno.claveIpMasEmail(conAuth(dueno, { email: 'b@x.test' })));
      chk('ni aparece en ella', false, freno.claveIpMasEmail(conAuth(dueno, { email: 'a@x.test' })).includes('a@x.test'));
      chk('el dueño y un empleado del mismo negocio van en cupos distintos', false,
        freno.claveIpMasEmail(conAuth(dueno)) === freno.claveIpMasEmail(conAuth(cajero)));
      chk('y dos empleados también', false,
        freno.claveIpMasEmail(conAuth(cajero)) === freno.claveIpMasEmail(conAuth({ ...cajero, employeeId: 4 })));
      chk('sin sesión (login, recupero) sigue siendo IP + email',
        '203.0.113.50|a@x.test', freno.claveIpMasEmail({ ip: '203.0.113.50', body: { email: ' A@x.test' } }));
      chk('el freno de la contraseña cuenta por sesión: la misma desde dos IPs es una',
        freno.claveDeSesion(conAuth(dueno, {}, '198.51.100.1')), freno.claveDeSesion(conAuth(dueno, {}, '198.51.100.2')));
      chk('y dos sesiones del mismo dueño son dos', false,
        freno.claveDeSesion(conAuth(dueno)) === freno.claveDeSesion(conAuth({ ...dueno, sid: 's-3' })));
    }

    try {
      const jefe21a = (await entraDueno(EMAIL_A)).token;
      const sinEmail = await fallar(jefe21a, '/account/sesiones/1/cerrar', 7, '192.0.2.10');
      chk('sin email: cinco errores y después 429', [400, 400, 400, 400, 400, 429, 429], sinEmail);

      // El ataque de la revisión: un email inventado distinto en cada pedido.
      const jefe21b = (await entraDueno(EMAIL_A)).token;
      const rotandoUna = await fallar(jefe21b, '/account/sesiones/1/cerrar', 8, '192.0.2.11',
        (i) => ({ email: `r${i}.${SUF}@x.test` }));
      chk('cerrar UNA con un email distinto en cada pedido igual llega al 429', true, llegaA429(rotandoUna));
      chk('y en el sexto, no después', 429, rotandoUna[5]);

      const jefe21c = (await entraDueno(EMAIL_A)).token;
      const rotandoTodas = await fallar(jefe21c, '/account/sesiones/cerrar', 8, '192.0.2.12',
        (i) => ({ email: `t${i}.${SUF}@x.test` }));
      chk('el «cerrar todas» del dueño tampoco se esquiva', true, llegaA429(rotandoTodas));

      const emp21a = (await entraEmpleado(EMAIL_EMP)).token;
      const rotandoEmp = await fallar(emp21a, '/account/sesiones/cerrar', 8, '192.0.2.13',
        (i) => ({ email: `e${i}.${SUF}@x.test` }));
      chk('ni el de un empleado (su propia contraseña)', true, llegaA429(rotandoEmp));

      // El 2FA comparte la clave del limitador: el mismo arreglo lo cubre.
      const jefe21d = (await entraDueno(EMAIL_A)).token;
      const rotando2fa = await fallar(jefe21d, '/account/2fa/desactivar', 8, '192.0.2.14',
        (i) => ({ email: `d${i}.${SUF}@x.test` }));
      chk('desactivar el 2FA con emails inventados tampoco esquiva el freno', true, llegaA429(rotando2fa));

      /*
       * Cupos separados. Cinco errores de un empleado desde la PC del local no
       * pueden dejar sin el botón de pánico al dueño que está en el mismo local
       * (misma IP pública).
       */
      const emp21b = (await entraEmpleado(EMAIL_EMP)).token;
      const jefe21e = (await entraDueno(EMAIL_A)).token;
      const errEmp = await fallar(emp21b, '/account/sesiones/cerrar', 6, '192.0.2.15');
      chk('el empleado que se equivoca cinco veces queda frenado', 429, errEmp[5]);
      const panico = await post21(jefe21e, '/account/sesiones/cerrar', { passwordActual: CLAVE }, '192.0.2.15');
      chk('pero el dueño, desde la misma IP, sigue pudiendo cerrar todas', 200, panico.status);

      /*
       * El cupo es de la SESIÓN, no de la persona ni de la IP. Quien tiene una
       * sesión robada del dueño gasta el cupo de ESA sesión: el dueño, desde su
       * celular en la misma red, puede echarla igual.
       */
      const robada = (await entraDueno(EMAIL_A)).token;
      const celular = (await entraDueno(EMAIL_A)).token;
      const errRobada = await fallar(robada, '/account/sesiones/cerrar', 6, '192.0.2.16');
      chk('la sesión robada queda frenada', 429, errRobada[5]);
      const idRobada = (await filaDe(robada)).id;
      const echar = await post21(celular, `/account/sesiones/${idRobada}/cerrar`, { passwordActual: CLAVE }, '192.0.2.16');
      chk('y el dueño la cierra desde su celular, misma IP', 200, echar.status);
      chk('la robada queda afuera', 401, (await conSesion(robada)).status);

      // Rotar IPs tampoco suma intentos: la sesión es la misma.
      const jefe21f = (await entraDueno(EMAIL_A)).token;
      const estadosIps = [];
      for (let i = 0; i < 8; i++) {
        estadosIps.push((await post21(jefe21f, '/account/sesiones/1/cerrar', { passwordActual: `no-${i}` }, `198.18.${i}.1`)).status);
      }
      chk('cambiando de IP en cada pedido, igual 429 en el sexto', 429, estadosIps[5]);

      /*
       * Los aciertos no cuentan: quien se equivoca y después la pone bien no
       * se acerca al tope. Un empleado cerrando sus otras sesiones.
       */
      const emp21c = (await entraEmpleado(EMAIL_EMP)).token;
      const mezcla = [
        ...(await fallar(emp21c, '/account/sesiones/cerrar', 4, '192.0.2.17')),
        (await post21(emp21c, '/account/sesiones/cerrar', { passwordActual: CLAVE_EMP }, '192.0.2.17')).status,
        ...(await fallar(emp21c, '/account/sesiones/cerrar', 1, '192.0.2.17')),
      ];
      chk('cuatro errores, un acierto y otro error: ningún 429', [400, 400, 400, 400, 200, 400], mezcla);

      /*
       * El freno lento. Cinco por minuto, durante las 24 h que vive una sesión,
       * siguen siendo miles de intentos. Además del de un minuto hay un tope
       * por sesión para todo el día: pasado, hay que salir y volver a entrar
       * —y el login tiene su propio bloqueo por cuenta—.
       */
      const [rapido, diario] = Array.isArray(freno.frenoContrasenaDeSesion) ? freno.frenoContrasenaDeSesion : [];
      if (!rapido || !diario || typeof freno.claveDeSesion !== 'function') {
        chk('existe el freno por sesión, rápido y diario', true, false);
      } else {
        const lenta = (await entraDueno(EMAIL_A)).token;
        const clave = freno.claveDeSesion({ auth: verifyToken(lenta) });
        const todos = [];
        // De a cuatro, soltando el de un minuto entre tanda y tanda, como si
        // pasara el minuto.
        for (let tanda = 0; tanda < 6; tanda++) {
          todos.push(...(await fallar(lenta, '/account/sesiones/1/cerrar', 4, '192.0.2.18')));
          await rapido.resetKey(clave);
        }
        chk('con el de un minuto suelto, veinte errores pasan', 20, todos.slice(0, 20).filter((s) => s === 400).length);
        chk('y el 21 ya no', 429, todos[20]);
        const despues = await post21(lenta, '/account/sesiones/cerrar', { passwordActual: CLAVE }, '192.0.2.18');
        chk('ni siquiera con la contraseña bien: la sesión agotó el día', 429, despues.status);
        chk('y el mensaje dice cómo seguir', true, /volv[eé] a entrar/i.test(despues.json?.message || ''));
        const otraVez = (await entraDueno(EMAIL_A)).token;
        chk('saliendo y volviendo a entrar, la sesión nueva tiene su cupo', 200,
          (await post21(otraVez, '/account/sesiones/cerrar', { passwordActual: CLAVE }, '192.0.2.18')).status);
      }

      /*
       * El login no cambia: sin sesión, la clave sigue siendo IP + el email del
       * cuerpo, que es el único dato que hay. Con un email que no existe, para
       * no dejar bloqueada ninguna cuenta de la suite.
       */
      const nadie = `qa.sestabla.nadie.${SUF}@stocker.test`;
      const otroNadie = `qa.sestabla.nadie2.${SUF}@stocker.test`;
      const logins = [];
      for (let i = 0; i < 6; i++) {
        logins.push((await post21(null, '/auth/login', { email: nadie, password: `no-${i}` }, '192.0.2.19')).status);
      }
      chk('el login sigue frenando a los cinco errores', [401, 401, 401, 401, 401, 429], logins);
      chk('y otro email desde la misma IP sigue teniendo su cupo', 401,
        (await post21(null, '/auth/login', { email: otroNadie, password: 'no' }, '192.0.2.19')).status);
    } finally {
      await new Promise((r) => server21.close(r));
    }

    tit('22. UN CIERRE NO RESUCITA SESIONES QUE YA HABÍAN TERMINADO');
    /*
     * La revisión de v3.44: cerrar() cerraba toda fila sin cerrar, aunque
     * hubiera pasado su tope absoluto hacía semanas, y la purga sólo borra una
     * fila sin cerrar a los 90 días de su tope. Un "cerrar todas" o un cambio
     * de contraseña le ponía cerradaEn = HOY a una sesión muerta hace 80 días:
     * aparecía en el historial de 30 días (decisión 4) y la purga, que medía
     * por cerradaEn, guardaba su IP y su navegador casi 180 días (la Política
     * de Privacidad dice 90).
     *
     * Una fila pasada de su tope absoluto (venceEn = el absExp del token) ya
     * no tiene token que la use: no hace falta cerrarla. Y como red, la lista
     * y la purga miden por el fin REAL, no por cerradaEn.
     */
    process.env.SESIONES_LIMITE = 'off';
    const DIA22 = 86400000;
    const HORA22 = 3600000;
    const hace22 = (ms) => new Date(Date.now() - ms);
    const fila22 = (datos) => SesionCuenta.create({
      sid: require('node:crypto').randomUUID(), businessId: negocioA.id, tipo: 'employee', employeeId: empleado.id,
      ip: '203.0.113.61', dispositivo: 'Chrome · Windows', ...datos,
    });
    // Venció hace 60 días y nadie la cerró, como casi todas.
    const muerta60 = await fila22({
      creadaEn: hace22(61 * DIA22), ultimaActividadEn: hace22(60 * DIA22 + HORA22), venceEn: hace22(60 * DIA22),
    });
    // Quieta hace dos horas, pero su tope es dentro de 22 h: la última actividad
    // guardada puede atrasar, así que ésta SÍ se cierra (es el porqué de cerrar
    // también las que "parecen" muertas).
    const quieta2h = await fila22({
      creadaEn: hace22(3 * HORA22), ultimaActividadEn: hace22(2 * HORA22), venceEn: new Date(Date.now() + 21 * HORA22),
    });
    // Datos que ya dejó el código anterior: cerrada ayer, muerta hace 60 días.
    const resucitada = await fila22({
      creadaEn: hace22(61 * DIA22), ultimaActividadEn: hace22(60 * DIA22 + HORA22), venceEn: hace22(60 * DIA22),
      cerradaEn: hace22(DIA22), motivoCierre: 'cerrar-todo',
    });
    // Ídem, muerta hace 91 días: la purga tiene que borrarla ya.
    const resucitada91 = await fila22({
      creadaEn: hace22(92 * DIA22), ultimaActividadEn: hace22(91 * DIA22 + HORA22), venceEn: hace22(91 * DIA22),
      cerradaEn: hace22(2 * DIA22), motivoCierre: 'password',
    });
    // Quieta desde hace 90 días y 6 h, con el tope 12 h después (hace 89 días
    // y 18 h): terminó hace más de 90 días aunque su venceEn diga menos.
    const quieta90 = await fila22({
      creadaEn: hace22(90 * DIA22 + 8 * HORA22), ultimaActividadEn: hace22(90 * DIA22 + 6 * HORA22),
      venceEn: hace22(90 * DIA22 - 6 * HORA22),
    });
    // Trabajó hasta el último minuto de su tope, que fue hace 90 días y 5
    // minutos, y el código anterior la "cerró" hace 2 días. Su fin es el tope.
    const alTope90 = await fila22({
      creadaEn: hace22(91 * DIA22), ultimaActividadEn: hace22(90 * DIA22 + 15 * 60000),
      venceEn: hace22(90 * DIA22 + 5 * 60000), cerradaEn: hace22(2 * DIA22), motivoCierre: 'cerrar-todo',
    });
    // Una normal: se cerró hace 10 días mientras estaba viva.
    const normal10 = await fila22({
      creadaEn: hace22(10 * DIA22 + HORA22), ultimaActividadEn: hace22(10 * DIA22 + 10 * 60000),
      venceEn: hace22(10 * DIA22 - 23 * HORA22), cerradaEn: hace22(10 * DIA22), motivoCierre: 'usuario',
    });

    const jefe22 = (await entraDueno(EMAIL_A)).token;
    const una22 = await conSesion(jefe22, sesionesCtrl.cerrarUna, {
      method: 'POST', params: { id: String(muerta60.id) }, body: { passwordActual: CLAVE },
    });
    chk('cerrar UNA que ya había terminado contesta bien', 200, una22.status);
    chk('y dice que ya había terminado, sin decir que la cerró', true, /terminad/i.test(una22.json?.message || ''));
    chk('pero no le pone fecha de cierre', null, (await muerta60.reload()).cerradaEn);

    const todas22 = await conSesion(jefe22, sesionesCtrl.cerrarOtras, {
      method: 'POST', path: '/account/sesiones/cerrar', body: { passwordActual: CLAVE },
    });
    chk('«cerrar todas» funciona', 200, todas22.status);
    chk('no toca la que venció hace 60 días', null, (await muerta60.reload()).cerradaEn);
    chk('sí cierra la quieta que todavía estaba dentro de su tope', 'cerrar-todo', (await quieta2h.reload()).motivoCierre);

    // Lo mismo con el cierre de un empleado (sus propias sesiones).
    const emp22 = (await entraEmpleado(EMAIL_EMP)).token;
    await conSesion(emp22, sesionesCtrl.cerrarOtras, {
      method: 'POST', path: '/account/sesiones/cerrar', body: { passwordActual: CLAVE_EMP },
    });
    chk('ni el «cerrar todas» del empleado', null, (await muerta60.reload()).cerradaEn);

    // Salir con un token de una sesión que ya pasó su tope tampoco la "cierra hoy".
    const tarde22 = (await entraDueno(EMAIL_A)).token;
    await SesionCuenta.update({ venceEn: hace22(2 * DIA22), ultimaActividadEn: hace22(2 * DIA22 + HORA22) },
      { where: { sid: sidDe(tarde22) } });
    await llamar(authCtrl.logout, { token: tarde22, method: 'POST', path: '/auth/logout' });
    chk('salir con el token de una sesión pasada de su tope no le pone fecha de cierre', null, (await filaDe(tarde22)).cerradaEn);

    const lista22 = (await conSesion(todas22.token || jefe22, sesionesCtrl.listar)).json;
    const ids22 = new Set([...(lista22?.sesiones || []), ...(lista22?.historial || [])].map((x) => x.id));
    chk('la que venció hace 60 días no aparece en la lista', false, ids22.has(muerta60.id));
    chk('ni la que el código anterior «cerró ayer» estando muerta hace 60', false, ids22.has(resucitada.id));
    chk('la quieta de hace dos horas sí, como vencida', 'vencida',
      lista22?.historial?.find((x) => x.id === quieta2h.id)?.estado);
    chk('y la normal de hace 10 días, como cerrada', 'cerrada',
      lista22?.historial?.find((x) => x.id === normal10.id)?.estado);

    await sesiones.purgar();
    chk('la purga borra la «cerrada hace 2 días» que murió hace 91', null, await SesionCuenta.findByPk(resucitada91.id));
    chk('y la quieta hace 90 días y 6 h aunque su tope fuera 12 h después', null, await SesionCuenta.findByPk(quieta90.id));
    chk('y la que llegó a su tope hace 90 días y 5 minutos', null, await SesionCuenta.findByPk(alTope90.id));
    chk('no borra la que murió hace 60', true, Boolean(await SesionCuenta.findByPk(muerta60.id)));
    chk('ni la de hace 10 días', true, Boolean(await SesionCuenta.findByPk(normal10.id)));
  } finally {
    if (modoOriginal === undefined) delete process.env.SESIONES_LIMITE;
    else process.env.SESIONES_LIMITE = modoOriginal;
    console.warn = warnOriginal;
    tit('Limpieza');
    await limpiar();
    chk('no quedan los negocios de prueba', 0, await Business.count({ where: { email: { [Op.like]: PATRON } } }));
    chk('ni el plan de prueba', 0, await Plan.count({ where: { codigo: PLAN_QA } }));
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch(async (e) => {
  console.warn = warnOriginal;
  console.error('ERROR', e);
  await limpiar().catch(() => {});
  process.exit(1);
});
