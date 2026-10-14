/*
 * Dónde mandan a leer los Términos el registro y Configuración.
 *
 * El front tenía las direcciones escritas a mano con un dominio que no era el
 * nuestro: quien se registraba y tocaba "Términos y Condiciones" terminaba en
 * un sitio ajeno. Ahora salen de LANDING_DOMAIN por GET /api/public/legales.
 * Esta suite cuida que la ruta exista sin sesión, que arme bien la dirección
 * con lo que suele ponerse en Railway (con o sin https://, con la barra del
 * final), y que sin la variable diga null en vez de inventar un dominio.
 *
 * Va por HTTP contra el router real, en un puerto efímero de este proceso: no
 * depende de qué backend tenga el 3000.
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
  const router = require('../src/routes');
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}/api`;
  const pedir = async () => {
    const r = await fetch(`${base}/public/legales`);
    return { status: r.status, cache: r.headers.get('cache-control'), json: await r.json().catch(() => null) };
  };

  const original = process.env.LANDING_DOMAIN;
  try {
    tit('1. CON LANDING_DOMAIN');
    process.env.LANDING_DOMAIN = 'pagina-de-prueba.example';
    const r = await pedir();
    chk('responde sin sesión', 200, r.status);
    chk('los cuatro textos, en la página pública', {
      terminos: 'https://pagina-de-prueba.example/terminos',
      privacidad: 'https://pagina-de-prueba.example/privacidad',
      reembolsos: 'https://pagina-de-prueba.example/reembolsos',
      cookies: 'https://pagina-de-prueba.example/cookies',
    }, r.json?.enlaces);
    // Sin cache compartida: un cambio de dominio no puede quedar pegado en un proxy.
    chk('sin cache compartida', true, /no-cache/.test(r.cache || ''));

    process.env.LANDING_DOMAIN = '  https://pagina-de-prueba.example/  ';
    chk('con https://, espacios y la barra del final', 'https://pagina-de-prueba.example/terminos',
      (await pedir()).json?.enlaces?.terminos);

    process.env.LANDING_DOMAIN = 'http://localhost:8082';
    chk('respeta http:// (desarrollo)', 'http://localhost:8082/privacidad',
      (await pedir()).json?.enlaces?.privacidad);

    tit('2. SIN LANDING_DOMAIN');
    delete process.env.LANDING_DOMAIN;
    const sin = await pedir();
    chk('dice null en vez de inventar un dominio', { enlaces: null }, sin.json);

    process.env.LANDING_DOMAIN = '   ';
    chk('una variable en blanco es lo mismo que no tenerla', { enlaces: null }, (await pedir()).json);

    tit('3. NINGÚN DOMINIO ESCRITO A MANO EN EL FRONT');
    /*
     * La causa del problema fue una dirección escrita en el código del front.
     * Si alguien vuelve a escribir una, esta prueba lo dice.
     */
    const fs = require('fs');
    const path = require('path');
    const front = path.join(__dirname, '../../../front/stocker/src');
    if (fs.existsSync(front)) {
      const archivos = [];
      const recorrer = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
        const p = path.join(d, e.name);
        if (e.isDirectory()) recorrer(p); else if (/\.(jsx?|mjs)$/.test(e.name)) archivos.push(p);
      });
      recorrer(front);
      const conLegalesAMano = archivos.filter((a) =>
        /https?:\/\/[^"'`\s]+\/(terminos|privacidad|reembolsos|cookies)\b/.test(fs.readFileSync(a, 'utf8')));
      chk('ningún archivo del front tiene la dirección de un texto legal escrita a mano', [],
        conLegalesAMano.map((a) => path.relative(front, a)));
    } else {
      console.log('  (no está el front al lado: se saltea)');
    }
  } finally {
    if (original === undefined) delete process.env.LANDING_DOMAIN; else process.env.LANDING_DOMAIN = original;
    servidor.close();
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  const db = require('../src/config/database');
  await db.close();
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
