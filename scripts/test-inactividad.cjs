/*
 * Los minutos de inactividad los elige cada cuenta.
 *
 * Hasta acá eran uno solo para toda la plataforma (SESSION_IDLE_MINUTES). Ahora
 * el dueño los elige en Configuración → Seguridad y valen para él y sus
 * empleados desde el próximo ingreso: viajan firmados en el token (`idleMin`)
 * y quedan en la fila de la sesión (`inactividadMin`), para que la lista y el
 * tope de dispositivos del plan cuenten con los mismos minutos que el token.
 *
 * Va por HTTP contra el router real en un puerto efímero, con la cuenta demo.
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
  const jwt = require('jsonwebtoken');
  const db = require('../src/config/database');
  await require('../src/database/ensureColumns').ensureColumns(db);
  const { Business, SesionCuenta } = require('../src/models');
  const sesiones = require('../src/services/sesionesService');
  const { IDLE_MIN } = require('../src/utils/session');

  const app = express();
  app.set('trust proxy', 1);
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api', require('../src/routes'));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const IP = `10.78.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

  const pedir = async (metodo, ruta, { cuerpo, token } = {}) => {
    const r = await fetch(base + ruta, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': IP, ...(token ? { Cookie: `stockerToken=${token}` } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    const sesion = (r.headers.getSetCookie?.() || []).find((c) => c.startsWith('stockerToken='));
    let json = null;
    try { json = await r.json(); } catch { /* sin cuerpo */ }
    return {
      status: r.status, json,
      token: sesion ? sesion.split(';')[0].slice('stockerToken='.length) : null,
      maxAge: sesion ? Number(/Max-Age=(\d+)/i.exec(sesion)?.[1]) : null,
    };
  };
  // Duración del token en minutos, redondeada.
  const minutosDe = (token) => { const p = jwt.decode(token); return Math.round((p.exp - p.iat) / 60); };

  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  const antes = negocio.sesionInactividadMin;
  const CLAVE = { email: negocio.email, password: 'Demo2026!!' };
  const sids = [];
  const entrar = async () => {
    const r = await pedir('POST', '/auth/login', { cuerpo: CLAVE });
    if (r.token) sids.push(jwt.decode(r.token).sid);
    return r;
  };

  try {
    await negocio.update({ sesionInactividadMin: null });

    tit('1. SIN ELEGIR, LOS DE LA PLATAFORMA');
    const comun = await entrar();
    chk('entra', 200, comun.status);
    chk(`el token dura ${IDLE_MIN} minutos`, IDLE_MIN, minutosDe(comun.token));
    chk('y no lleva minutos propios', undefined, jwt.decode(comun.token).idleMin);

    tit('2. LA CUENTA ELIGE');
    chk('una opción que no está en la lista se rechaza', 400,
      (await pedir('PUT', '/account', { cuerpo: { sesionInactividadMin: 7 }, token: comun.token })).status);
    chk('60 minutos se guarda', 200,
      (await pedir('PUT', '/account', { cuerpo: { sesionInactividadMin: 60 }, token: comun.token })).status);
    chk('y la cuenta lo muestra', 60, (await pedir('GET', '/account', { token: comun.token })).json?.inactividadMin);

    tit('3. RIGE DESDE EL PRÓXIMO INGRESO');
    const larga = await entrar();
    chk('el token nuevo dura 60 minutos', 60, minutosDe(larga.token));
    chk('la cookie también', [true, true], [larga.maxAge > 59 * 60, larga.maxAge <= 60 * 60]);
    const me = await pedir('GET', '/auth/me', { token: larga.token });
    chk('la pantalla se entera (para cerrarse sola a tiempo)', 60, me.json?.sesion?.inactividadMin);
    chk('al renovarse sigue durando 60', 60, Math.round((jwt.decode(me.token).exp * 1000 - Date.now()) / 60000));
    const fila = await SesionCuenta.findOne({ where: { sid: jwt.decode(larga.token).sid } });
    chk('y la fila de la sesión lo guarda', 60, fila.inactividadMin);

    tit('4. LA LISTA Y EL TOPE CUENTAN CON LOS MINUTOS DE CADA SESIÓN');
    // Contra lo que había antes, sin tocar las otras sesiones de la cuenta demo.
    const conEsta = await sesiones.contarActivasDelDueno(negocio.id);
    await fila.update({ ultimaActividadEn: new Date(Date.now() - 40 * 60e3) });
    chk('quieta 40 minutos con 60 elegidos: sigue activa', conEsta, await sesiones.contarActivasDelDueno(negocio.id));
    await fila.update({ inactividadMin: 15 });
    chk('la misma con 15: ya no cuenta', conEsta - 1, await sesiones.contarActivasDelDueno(negocio.id));
  } finally {
    await Business.update({ sesionInactividadMin: antes }, { where: { id: negocio.id } });
    if (sids.length) await SesionCuenta.destroy({ where: { sid: sids } });
    server.close();
    await db.close().catch(() => {});
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
