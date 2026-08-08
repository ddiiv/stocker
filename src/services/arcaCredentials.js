/*
 * Carga del certificado + clave privada de ARCA/AFIP.
 *
 * Soporta dos orígenes, en este orden:
 *   1. Variables de entorno en base64 (ARCA_CERT_B64 / ARCA_KEY_B64 y sus
 *      variantes _HOMO / _PROD). Es la forma de deployar en Railway, Vercel
 *      o cualquier host con filesystem efímero, donde no podés subir archivos.
 *   2. Rutas a archivos en disco (ARCA_CERT_PATH / ARCA_KEY_PATH y variantes).
 *      Cómodo para desarrollo local.
 *
 * Los certs nunca van al repo (storage/ está en .gitignore), así que en
 * producción el camino esperado es el base64.
 */

const fs = require('fs');

function fromB64(v) {
  if (!v) return null;
  const s = String(v).trim();
  // Si ya viene en PEM plano (algunos hosts permiten multilínea), lo usamos tal cual.
  if (s.includes('-----BEGIN')) return s;
  try {
    const decoded = Buffer.from(s, 'base64').toString('utf8');
    return decoded.includes('-----BEGIN') ? decoded : null;
  } catch { return null; }
}

function fromFile(p) {
  if (!p || !fs.existsSync(p)) return null;
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/**
 * Devuelve { cert, key } en PEM para el ambiente pedido, o null si no hay
 * credenciales configuradas.
 * @param {'homologacion'|'produccion'} ambiente
 */
function loadCredentials(ambiente = 'homologacion') {
  const sufijo = ambiente === 'produccion' ? 'PROD' : 'HOMO';
  const env = process.env;

  const cert =
    fromB64(env[`ARCA_CERT_B64_${sufijo}`]) ||
    fromB64(env.ARCA_CERT_B64) ||
    fromFile(env[`ARCA_CERT_PATH_${sufijo}`]) ||
    fromFile(env.ARCA_CERT_PATH);

  const key =
    fromB64(env[`ARCA_KEY_B64_${sufijo}`]) ||
    fromB64(env.ARCA_KEY_B64) ||
    fromFile(env[`ARCA_KEY_PATH_${sufijo}`]) ||
    fromFile(env.ARCA_KEY_PATH);

  if (!cert || !key) return null;
  return { cert, key };
}

/** true si hay credenciales cargables para ese ambiente (sin leerlas dos veces). */
function hasCredentials(ambiente) {
  return loadCredentials(ambiente) !== null;
}

module.exports = { loadCredentials, hasCredentials };
