/*
 * Arma el bloque de variables para pegar en Railway, tomando los valores del
 * .env local.
 *
 * Escribe el resultado FUERA del repositorio (por defecto en /tmp) porque el
 * archivo contiene secretos: certificados de AFIP, credenciales de mail y el
 * JWT_SECRET. Nunca dejarlo dentro del proyecto.
 *
 * Uso:
 *   node scripts/railway-env.js --front https://mi-front.up.railway.app
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);
// Ojo: indexOf devuelve -1 si falta el flag, y args[-1 + 1] es args[0] —
// terminaría tomando el flag siguiente como si fuera el valor.
function opcion(nombre, porDefecto = null) {
  const i = args.indexOf(nombre);
  if (i === -1 || i + 1 >= args.length) return porDefecto;
  return args[i + 1];
}

const frontUrl = (opcion('--front', '') || '').replace(/\/$/, '');
if (!frontUrl || !frontUrl.startsWith('http')) {
  console.error('Falta la URL pública del front.\n');
  console.error('  node scripts/railway-env.js --front https://mi-front.up.railway.app');
  process.exit(1);
}

const backServiceName = opcion('--back-service', 'stocker-back');
const salida = opcion('--out', path.join(os.tmpdir(), 'railway-env-stocker.txt'));

const e = process.env;
const faltantes = [];
function req(clave, valor, nota) {
  if (!valor) faltantes.push(clave);
  return { clave, valor: valor || '', nota };
}

// Valores que cambian respecto del entorno local.
const jwt = e.JWT_SECRET && e.JWT_SECRET.length >= 32
  ? e.JWT_SECRET
  : require('crypto').randomBytes(48).toString('base64');

const backend = [
  { seccion: 'Obligatorias' },
  req('NODE_ENV', 'production', 'activa Secure en la cookie y apaga el SQL en logs'),
  req('PORT', '3000', 'debe coincidir con el puerto de API_INTERNAL_URL del front'),
  req('DATABASE_URL', '${{Postgres.DATABASE_URL}}', 'referencia interna de Railway, pegar tal cual'),
  req('JWT_SECRET', jwt, e.JWT_SECRET ? 'el mismo que usás local' : 'GENERADO ACÁ: guardalo'),
  req('FRONTEND_URL', frontUrl, 'URL pública del front'),

  { seccion: 'ARCA / AFIP' },
  req('ARCA_STOCKER_CUIT', e.ARCA_STOCKER_CUIT),
  req('ARCA_MOCK', e.ARCA_MOCK || 'false'),
  req('ARCA_CERT_B64_PROD', e.ARCA_CERT_B64_PROD, 'cert en base64 — el disco de Railway es efímero'),
  req('ARCA_KEY_B64_PROD', e.ARCA_KEY_B64_PROD),
  req('ARCA_CERT_B64_HOMO', e.ARCA_CERT_B64_HOMO),
  req('ARCA_KEY_B64_HOMO', e.ARCA_KEY_B64_HOMO),

  { seccion: 'Mail' },
  req('MAIL_HOST', e.MAIL_HOST),
  req('MAIL_PORT', e.MAIL_PORT),
  req('MAIL_SECURE', e.MAIL_SECURE),
  req('MAIL_USER', e.MAIL_USER),
  req('MAIL_PASS', e.MAIL_PASS),
  req('MAIL_FROM', e.MAIL_FROM),

  { seccion: 'MercadoLibre' },
  req('ML_CLIENT_ID', e.ML_CLIENT_ID),
  req('ML_CLIENT_SECRET', e.ML_CLIENT_SECRET),
  req('ML_REDIRECT_URI', `${frontUrl}/api/mercadolibre/callback`,
      'CAMBIÓ: ahora apunta al FRONT, no al back. Actualizalo también en developers.mercadolibre.com.ar'),

  { seccion: 'WhatsApp (opcional)' },
  req('WHATSAPP_META_TOKEN', e.WHATSAPP_META_TOKEN),
  req('WHATSAPP_META_PHONE_NUMBER_ID', e.WHATSAPP_META_PHONE_NUMBER_ID),
  req('WHATSAPP_TEMPLATE_NAME', e.WHATSAPP_TEMPLATE_NAME),
  req('WHATSAPP_TEMPLATE_LANG', e.WHATSAPP_TEMPLATE_LANG),

  { seccion: 'Sesión (opcional — estos son los valores por defecto)' },
  req('SESSION_IDLE_MINUTES', e.SESSION_IDLE_MINUTES || '30'),
  req('SESSION_ABSOLUTE_HOURS', e.SESSION_ABSOLUTE_HOURS || '24'),
];

const frontend = [
  { seccion: 'Servicio del front' },
  req('NODE_ENV', 'production', 'activa HSTS y la redirección a https'),
  req('API_INTERNAL_URL', `http://${backServiceName}.railway.internal:3000`,
      'http, no https: dentro de la red privada no hay TLS'),
];

function render(titulo, filas) {
  let out = `\n${'='.repeat(70)}\n${titulo}\n${'='.repeat(70)}\n`;
  for (const f of filas) {
    if (f.seccion) { out += `\n# ── ${f.seccion} ${'─'.repeat(Math.max(0, 60 - f.seccion.length))}\n`; continue; }
    if (f.nota) out += `# ${f.nota}\n`;
    out += `${f.clave}=${f.valor}\n`;
  }
  return out;
}

const contenido =
  `Variables para Railway — generado ${new Date().toISOString()}\n` +
  `CONTIENE SECRETOS: no lo subas al repo ni lo compartas.\n` +
  render('SERVICIO BACKEND', backend) +
  render('SERVICIO FRONTEND', frontend) +
  (faltantes.length ? `\n\nSIN VALOR EN TU .env LOCAL (revisalas):\n  ${faltantes.join('\n  ')}\n` : '\n\nTodas las variables tienen valor.\n');

fs.writeFileSync(salida, contenido, { mode: 0o600 });

console.log(`✔ Escrito en: ${salida}`);
console.log(`  (fuera del repo, permisos 600)`);
if (faltantes.length) {
  console.log(`\n⚠ Sin valor en tu .env local: ${faltantes.join(', ')}`);
}
console.log(`\nAbrilo y copiá cada bloque al servicio correspondiente en Railway.`);
