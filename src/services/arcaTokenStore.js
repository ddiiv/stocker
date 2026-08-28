/*
 * Persistencia del TA (Token + Sign) de AFIP.
 *
 * AFIP no reemite un TA hasta que el vigente expira (12h). Si lo perdemos,
 * quedamos sin poder autenticar hasta que caduque — por eso hay que
 * guardarlo en algún lado que sobreviva reinicios y deploys.
 *
 * Estrategia en capas:
 *   1. Memoria  — evita ir a la base en cada request.
 *   2. Postgres — sobrevive deploys y lo comparten todas las instancias.
 *                 Es la fuente de verdad en producción (Railway borra el
 *                 filesystem en cada deploy).
 *   3. Disco    — fallback para scripts standalone y desarrollo local sin
 *                 base levantada. En Railway no sirve, pero no molesta.
 */

const fs   = require('fs');
const path = require('path');
const { sinDatos } = require('../utils/logger');

const memCache = new Map();
const TA_DIR = path.join(__dirname, '..', '..', 'storage', 'arca-ta');
try { fs.mkdirSync(TA_DIR, { recursive: true }); } catch { /* ok */ }

function fileFor(clave) {
  return path.join(TA_DIR, `ta-${clave.replace(/::/g, '-')}.json`);
}

// El modelo se resuelve tarde y con tolerancia a fallos: este módulo también
// corre desde scripts que no levantan la base.
function getModel() {
  try { return require('../models').ArcaToken || null; } catch { return null; }
}

/** Devuelve { token, sign, cuit } vigente, o null si no hay o ya expiró. */
async function get(clave) {
  const ahora = Date.now();

  const enMemoria = memCache.get(clave);
  if (enMemoria && enMemoria.expiraEn > ahora) return enMemoria.ta;

  const ArcaToken = getModel();
  if (ArcaToken) {
    try {
      const fila = await ArcaToken.findOne({ where: { clave } });
      if (fila && new Date(fila.expiraEn).getTime() > ahora) {
        const ta = { token: fila.token, sign: fila.sign, cuit: fila.cuit };
        memCache.set(clave, { ta, expiraEn: new Date(fila.expiraEn).getTime() });
        return ta;
      }
    } catch { /* base caída o tabla inexistente → probamos disco */ }
  }

  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(clave), 'utf8'));
    // Formato viejo: { at, ta }. Formato nuevo: { expiraEn, ta }.
    const expiraEn = raw.expiraEn || (raw.at ? raw.at + 11 * 60 * 60 * 1000 : 0);
    if (expiraEn > ahora) {
      memCache.set(clave, { ta: raw.ta, expiraEn });
      // Migración: si el TA vivía en disco y hay base, lo subimos. Así no se
      // pierde al deployar (AFIP no daría otro hasta que este expire).
      if (ArcaToken) set(clave, raw.ta, expiraEn).catch(() => {});
      return raw.ta;
    }
  } catch { /* no hay archivo */ }

  return null;
}

/** Guarda el TA en las tres capas. `expiraEn` es un timestamp en ms. */
async function set(clave, ta, expiraEn) {
  memCache.set(clave, { ta, expiraEn });

  const ArcaToken = getModel();
  if (ArcaToken) {
    try {
      const valores = {
        clave, token: ta.token, sign: ta.sign, cuit: ta.cuit || null,
        expiraEn: new Date(expiraEn),
      };
      const [fila, creada] = await ArcaToken.findOrCreate({ where: { clave }, defaults: valores });
      if (!creada) await fila.update(valores);
    } catch (err) {
      // No es fatal: seguimos teniendo memoria y disco. Pero avisamos, porque
      // en producción significa que el próximo deploy va a perder el TA.
      console.warn('[ARCA] No se pudo guardar el TA en la base:', sinDatos(err.message, 160));
    }
  }

  try {
    fs.writeFileSync(fileFor(clave), JSON.stringify({ expiraEn, ta }), 'utf8');
  } catch { /* filesystem de solo lectura → ok, ya está en la base */ }
}

module.exports = { get, set };
