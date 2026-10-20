/*
 * El segundo factor no se pide cada vez que la sesión se cierra por inactividad.
 *
 * Después de pasar el código, el navegador se queda con una marca firmada
 * (cookie `stocker2fa`). Al volver a entrar en esa computadora alcanza con la
 * contraseña, mientras no hayan pasado las horas de la cuenta sin usar Stocker
 * (24 por omisión; 0 = pedirlo siempre). Un cambio de contraseña o "cerrar
 * todas" la invalidan, y una marca de otra cuenta no sirve.
 *
 * Va por HTTP contra el router real en un puerto efímero de este proceso, con
 * la cuenta demo y un secreto TOTP puesto sólo durante la prueba.
 */

require('dotenv').config({ path: __dirname + '/../.env' });

let ok = 0;
let ko = 0;
const chk = (t, esperado, obtenido) => {
  const igual = JSON.stringify(esperado) === JSON.stringify(obtenido);
  console.log(`  ${igual ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${t}`);
  if (!igual) console.log(`      esperaba ${JSON.stringify(esperado)} · vino ${JSON.stringify(obtenido)}`);
  igual ? (ok += 1) : (ko += 1);
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

(async () => {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const { Business } = require('../src/models');
  const totp = require('../src/utils/totp');
  const { signToken } = require('../src/utils/jwt');
  const dosFactores = require('../src/services/dosFactoresService');

  const app = express();
  app.set('trust proxy', 1);
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api', require('../src/routes'));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  // Una IP propia por corrida: el freno del login cuenta por IP + email.
  const IP = `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

  const pedir = async (metodo, ruta, { cuerpo, cookies = {} } = {}) => {
    const r = await fetch(base + ruta, {
      method: metodo,
      headers: {
        'Content-Type': 'application/json', 'X-Forwarded-For': IP,
        Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    const puestas = Object.fromEntries((r.headers.getSetCookie?.() || [])
      .map((c) => c.split(';')[0].split('=')).map(([k, ...v]) => [k, v.join('=')]));
    let json = null;
    try { json = await r.json(); } catch { /* sin cuerpo */ }
    return { status: r.status, json, puestas };
  };

  // La columna de las horas entra por ensureColumns, como en un arranque.
  await require('../src/database/ensureColumns').ensureColumns(require('../src/config/database'));
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  const antes = {
    totpSecret: negocio.totpSecret, totpActivadoEn: negocio.totpActivadoEn,
    totpUltimoPaso: negocio.totpUltimoPaso, dobleFactorVentanaH: negocio.dobleFactorVentanaH,
    sesionesDesde: negocio.sesionesDesde,
  };
  const SECRETO = totp.generarSecreto();
  // Activado hace días: una marca anterior a la activación no vale (sección 3).
  const ACTIVADO = new Date(Date.now() - 10 * 24 * 3600e3);
  const CLAVE = { email: negocio.email, password: 'Demo2026!!' };
  const C = dosFactores.COOKIE_CONFIANZA;
  const marca = (uso, id = negocio.id) => signToken({ c2fa: id, uso }, { expiresIn: '30d' });

  try {
    await negocio.update({
      totpSecret: SECRETO, totpActivadoEn: ACTIVADO, totpUltimoPaso: null,
      dobleFactorVentanaH: null, sesionesDesde: null,
    });

    tit('1. LA PRIMERA VEZ EN UNA COMPUTADORA PIDE EL CÓDIGO');
    const sinCodigo = await pedir('POST', '/auth/login', { cuerpo: CLAVE });
    chk('sin código: 401 TOTP_REQUERIDO', [401, 'TOTP_REQUERIDO'], [sinCodigo.status, sinCodigo.json?.codigo]);
    const conCodigo = await pedir('POST', '/auth/login', {
      cuerpo: { ...CLAVE, code: totp.codigoPara(SECRETO, Math.floor(Date.now() / 1000 / totp.PASO_SEG)) },
    });
    chk('con el código entra', 200, conCodigo.status);
    chk('y el navegador se queda con la marca de confianza', true, Boolean(conCodigo.puestas[C]));

    tit('2. AL VOLVER A ENTRAR EN ESA COMPUTADORA, SÓLO LA CONTRASEÑA');
    const segunda = await pedir('POST', '/auth/login', { cuerpo: CLAVE, cookies: { [C]: conCodigo.puestas[C] } });
    chk('entra sin código', 200, segunda.status);
    chk('y la marca se renueva', true, Boolean(segunda.puestas[C]));

    tit('3. CUÁNDO LA MARCA YA NO ALCANZA');
    const req = (valor) => ({ cookies: valor ? { [C]: valor } : {} });
    const fresco = await Business.findByPk(negocio.id);
    chk('usada hace 23 h, con la ventana de 24: vale', true,
      dosFactores.confiaEnEsteDispositivo(req(marca(Date.now() - 23 * 3600e3)), fresco));
    chk('25 h sin usar Stocker: pide el código de nuevo', false,
      dosFactores.confiaEnEsteDispositivo(req(marca(Date.now() - 25 * 3600e3)), fresco));
    chk('la marca de otra cuenta no sirve', false,
      dosFactores.confiaEnEsteDispositivo(req(marca(Date.now(), negocio.id + 1)), fresco));
    chk('sin marca, tampoco', false, dosFactores.confiaEnEsteDispositivo(req(null), fresco));
    chk('una marca alterada, tampoco', false,
      dosFactores.confiaEnEsteDispositivo(req(`${marca(Date.now())}x`), fresco));
    fresco.sesionesDesde = new Date();
    chk('después de cambiar la contraseña o "cerrar todas", no vale', false,
      dosFactores.confiaEnEsteDispositivo(req(marca(Date.now() - 1000)), fresco));
    fresco.sesionesDesde = null;
    fresco.totpActivadoEn = new Date();
    chk('ni después de volver a activar el segundo factor', false,
      dosFactores.confiaEnEsteDispositivo(req(marca(Date.now() - 1000)), fresco));
    fresco.totpActivadoEn = ACTIVADO;
    fresco.dobleFactorVentanaH = 0;
    chk('con la cuenta en "siempre", la marca no alcanza nunca', false,
      dosFactores.confiaEnEsteDispositivo(req(marca(Date.now())), fresco));
    fresco.dobleFactorVentanaH = 72;
    chk('con 72 h, una marca de hace 48 vale', true,
      dosFactores.confiaEnEsteDispositivo(req(marca(Date.now() - 48 * 3600e3)), fresco));

    tit('4. USAR STOCKER CORRE LA MARCA');
    const sesion = segunda.puestas.stockerToken;
    const hace10 = marca(Date.now() - 10 * 60e3);
    const me = await pedir('GET', '/auth/me', { cookies: { stockerToken: sesion, [C]: hace10 } });
    chk('un pedido con la sesión abierta la renueva', [200, true], [me.status, Boolean(me.puestas[C])]);
    const me2 = await pedir('GET', '/auth/me', { cookies: { stockerToken: sesion, [C]: me.puestas[C] } });
    chk('pero no en cada pedido: como mucho cada cinco minutos', false, Boolean(me2.puestas[C]));

    tit('5. LAS HORAS SE ELIGEN EN CONFIGURACIÓN');
    const cookies = { stockerToken: sesion };
    chk('una opción que no está en la lista se rechaza', 400,
      (await pedir('PUT', '/account', { cuerpo: { dobleFactorVentanaH: 5 }, cookies })).status);
    chk('72 h se guarda', 200, (await pedir('PUT', '/account', { cuerpo: { dobleFactorVentanaH: 72 }, cookies })).status);
    chk('y la cuenta lo muestra', 72, (await pedir('GET', '/account', { cookies })).json?.dobleFactor?.ventanaH);
    await pedir('PUT', '/account', { cuerpo: { dobleFactorVentanaH: 0 }, cookies });
    const siempre = await pedir('POST', '/auth/login', { cuerpo: CLAVE, cookies: { [C]: conCodigo.puestas[C] } });
    chk('con "siempre", vuelve a pedir el código aunque haya marca', [401, 'TOTP_REQUERIDO'],
      [siempre.status, siempre.json?.codigo]);
  } finally {
    await Business.update(antes, { where: { id: negocio.id } });
    server.close();
    const db = require('../src/config/database');
    await db.close().catch(() => {});
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
