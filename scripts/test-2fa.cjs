/*
 * Verificación en dos pasos (TOTP).
 *
 * Lo que se comprueba:
 *
 *   · Activar es de DOS pasos. El secreto queda pendiente hasta que la persona
 *     escribe un código correcto. Si se activara de una, quien abre la pantalla
 *     y se distrae queda con el 2FA prendido y sin app cargada: afuera de su
 *     propia cuenta y sin forma de volver.
 *   · Sin código no hay sesión, y el 401 lo dice con TOTP_REQUERIDO.
 *   · Un código NO sirve dos veces. Vale noventa segundos contando la
 *     tolerancia, y en ese rato alguien que lo vio puede tipearlo en otra
 *     máquina.
 *   · Los códigos de recuperación son de un solo uso, y regenerarlos mata a los
 *     viejos —si no, regenerarlos porque se filtraron no arreglaría nada—.
 *   · Desactivar pide contraseña Y código.
 *
 * Corre sobre un negocio propio y descartable: activarle el 2FA a la cuenta
 * demo dejaría afuera a las otras 35 suites.
 *
 * Uso:  API=http://localhost:3000 node scripts/test-2fa.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const API = process.env.API || 'http://localhost:3000';
const { Business, Subscription, AuthAttempt } = require('../src/models');
const { iniciarTrial } = require('../src/services/planService');
const totp = require('../src/utils/totp');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

function sesion() {
  let cookie = '';
  return async (m, ruta, cuerpo) => {
    const r = await fetch(`${API}${ruta}`, {
      method: m,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    const set = r.headers.getSetCookie?.() || [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    let json = null; try { json = JSON.parse(await r.text()); } catch { /* sin json */ }
    return { status: r.status, json, hayCookie: set.length > 0 };
  };
}

const CUIT   = '20999888772';
const SUFIJO = `${process.pid}${Date.now().toString(36)}`;
const EMAIL  = `qa.2fa.${SUFIJO}@stocker.test`;
const CLAVE  = 'QaDosFactores2026!';

const PASO = 30;
const pasoAhora = () => Math.floor(Date.now() / 1000 / PASO);

async function limpiar() {
  await AuthAttempt.destroy({ where: { identificador: { [Op.like]: 'qa.2fa.%@stocker.test' } } }).catch(() => {});
  const restos = await Business.findAll({
    where: { [Op.or]: [{ email: { [Op.like]: 'qa.2fa.%@stocker.test' } }, { cuit: CUIT }] },
  });
  for (const b of restos) {
    await Subscription.destroy({ where: { businessId: b.id } });
    await b.destroy();
  }
}

(async () => {
  await limpiar();
  const negocio = await Business.create({
    nombreNegocio: 'QA 2FA', ownerNombre: 'QA', ownerApellido: 'DosFactores',
    cuit: CUIT, email: EMAIL, passwordHash: await bcrypt.hash(CLAVE, 10),
  });
  await iniciarTrial(negocio.id);

  try {
    const api = sesion();
    const entrada = await api('POST', '/api/auth/login', { email: EMAIL, password: CLAVE });
    if (entrada.status === 429) {
      console.log('\n\x1b[31m✖ El limitador está frenando los logins. Esperá un minuto.\x1b[0m');
      await limpiar(); process.exit(1);
    }

    tit('1. ARRANCA APAGADO');
    chk('se entra sin código', 200, entrada.status);
    const cuenta0 = await api('GET', '/api/account');
    chk('la cuenta dice que está apagado', false, cuenta0.json?.dobleFactor?.habilitado);

    tit('2. EMPEZAR LA ACTIVACIÓN PIDE LA CONTRASEÑA');
    const malIniciar = await api('POST', '/api/account/2fa/iniciar', { passwordActual: 'no-es-esta' });
    chk('con la contraseña equivocada no arranca', 400, malIniciar.status);

    const inicio = await api('POST', '/api/account/2fa/iniciar', { passwordActual: CLAVE });
    chk('con la correcta sí',        200,  inicio.status);
    chk('devuelve un secreto',       true, typeof inicio.json?.secreto === 'string' && inicio.json.secreto.length >= 16);
    chk('y la URI para el teléfono', true, String(inicio.json?.uri || '').startsWith('otpauth://totp/'));
    const secreto = inicio.json.secreto;

    tit('3. TODAVÍA NO PROTEGE NADA');
    /*
     * El paso intermedio es lo que evita el peor final posible: quedar con el
     * 2FA prendido y sin ninguna app cargada.
     */
    const cuenta1 = await api('GET', '/api/account');
    chk('sigue apagado hasta confirmar', false, cuenta1.json?.dobleFactor?.habilitado);
    chk('pero figura como pendiente',    true,  cuenta1.json?.dobleFactor?.pendiente);
    chk('y se puede entrar sin código',  200,   (await sesion()('POST', '/api/auth/login', { email: EMAIL, password: CLAVE })).status);

    tit('4. ACTIVAR EXIGE UN CÓDIGO DE VERDAD');
    const malCodigo = await api('POST', '/api/account/2fa/activar', { code: '000000' });
    chk('un código inventado no activa', 400, malCodigo.status);

    const paso0 = pasoAhora();
    const activar = await api('POST', '/api/account/2fa/activar', { code: totp.codigoPara(secreto, paso0) });
    chk('el código de la app sí',            200, activar.status);
    chk('y entrega ocho códigos de recuperación', 8, activar.json?.codigosDeRecuperacion?.length);
    const recuperacion = activar.json.codigosDeRecuperacion;

    const cuenta2 = await api('GET', '/api/account');
    chk('ahora sí figura activo',   true, cuenta2.json?.dobleFactor?.habilitado);
    chk('con ocho códigos guardados', 8,  cuenta2.json?.dobleFactor?.codigosRestantes);

    tit('5. SIN CÓDIGO NO HAY SESIÓN');
    const sinCodigo = await sesion()('POST', '/api/auth/login', { email: EMAIL, password: CLAVE });
    chk('el login se frena',        401,               sinCodigo.status);
    chk('y dice qué falta',         'TOTP_REQUERIDO',  sinCodigo.json?.codigo);
    chk('sin emitir ninguna cookie', false,            sinCodigo.hayCookie);

    const codigoMalo = await sesion()('POST', '/api/auth/login', { email: EMAIL, password: CLAVE, code: '123456' });
    chk('un código equivocado tampoco entra', 401, codigoMalo.status);

    tit('6. CON EL CÓDIGO DE LA APP SE ENTRA');
    const conCodigo = totp.codigoPara(secreto, paso0 + 1);
    const entra = await sesion()('POST', '/api/auth/login', { email: EMAIL, password: CLAVE, code: conCodigo });
    chk('entra',                 200, entra.status);
    chk('y avisa cuántos códigos de recuperación quedan', 8, entra.json?.codigosDeRecuperacionRestantes);

    tit('7. EL MISMO CÓDIGO NO SIRVE DOS VECES');
    /*
     * Es el punto que separa un 2FA de un teatro de 2FA: sin esto, el código
     * que alguien vio por encima del hombro sirve durante noventa segundos.
     */
    const reuso = await sesion()('POST', '/api/auth/login', { email: EMAIL, password: CLAVE, code: conCodigo });
    chk('el reuso se rechaza', 401,  reuso.status);
    chk('y lo explica',        true, /ya se usó/i.test(reuso.json?.message || ''));

    tit('8. LOS CÓDIGOS DE RECUPERACIÓN SON DE UN SOLO USO');
    const conRec = await sesion()('POST', '/api/auth/login', { email: EMAIL, password: CLAVE, code: recuperacion[0] });
    chk('con uno de recuperación entra', 200, conRec.status);
    chk('y queda uno menos',             7,   conRec.json?.codigosDeRecuperacionRestantes);

    const recRepetido = await sesion()('POST', '/api/auth/login', { email: EMAIL, password: CLAVE, code: recuperacion[0] });
    chk('el mismo, otra vez, no', 401, recRepetido.status);

    tit('9. REGENERAR MATA A LOS VIEJOS');
    const nuevos = await api('POST', '/api/account/2fa/codigos', {
      passwordActual: CLAVE, code: recuperacion[1],
    });
    chk('se regeneran',       200, nuevos.status);
    chk('vuelven a ser ocho', 8,   nuevos.json?.codigosDeRecuperacion?.length);
    /*
     * Si los viejos siguieran valiendo, regenerarlos porque se filtraron no
     * arreglaría nada: es justamente para eso que se regeneran.
     *
     * Se comprueba contra /account y no contra el login a propósito. El
     * limitador de intentos fallidos se llavea por IP+email para el login y
     * por IP+cuenta para /account: son cupos distintos, y esta suite necesita
     * fallar a propósito varias veces. Gastando los dos cupos en el mismo, la
     * prueba se bloquea a sí misma y aparecen 429 donde debería haber 401 —una
     * falla que no dice nada del código—.
     */
    const viejoMuerto = await api('POST', '/api/account/2fa/codigos', {
      passwordActual: CLAVE, code: recuperacion[2],
    });
    chk('un código viejo ya no sirve', 400, viejoMuerto.status);
    chk('uno nuevo sí',                200,
      (await sesion()('POST', '/api/auth/login', { email: EMAIL, password: CLAVE, code: nuevos.json.codigosDeRecuperacion[0] })).status);

    tit('10. DESACTIVAR PIDE CONTRASEÑA Y CÓDIGO');
    const sinCode = await api('POST', '/api/account/2fa/desactivar', { passwordActual: CLAVE });
    chk('sin código no se desactiva', 400, sinCode.status);

    const apagar = await api('POST', '/api/account/2fa/desactivar', {
      passwordActual: CLAVE, code: nuevos.json.codigosDeRecuperacion[2],
    });
    chk('con los dos sí', 200, apagar.status);

    const cuenta3 = await api('GET', '/api/account');
    chk('queda apagado',                  false, cuenta3.json?.dobleFactor?.habilitado);
    chk('y sin códigos guardados',        0,     cuenta3.json?.dobleFactor?.codigosRestantes);
    const final = await sesion()('POST', '/api/auth/login', { email: EMAIL, password: CLAVE });
    if (final.status === 429) {
      console.log('  (el limitador frenó el último login: se saltea, no es una falla del 2FA)');
    } else {
      chk('y se vuelve a entrar sin código', 200, final.status);
    }

  } finally {
    tit('Limpieza');
    await limpiar();
    chk('no queda el negocio de prueba', 0, await Business.count({ where: { email: EMAIL } }));
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch(async (e) => { console.error('ERROR', e); await limpiar().catch(() => {}); process.exit(1); });
