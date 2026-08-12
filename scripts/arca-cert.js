#!/usr/bin/env node
/*
 * Carga un certificado de AFIP nuevo: valida el par, lo pasa a base64 y
 * actualiza el .env.
 *
 * El base64 es la única forma de llevar los certificados a Railway, porque el
 * filesystem del contenedor es efímero y no se pueden subir archivos.
 *
 * Valida ANTES de escribir nada. Un certificado que no corresponde a su clave,
 * o uno de homologación puesto en la variable de producción, no falla al
 * guardarlo: falla al primer intento de facturar, con un error de AFIP que no
 * se entiende. Es mucho más barato detectarlo acá.
 *
 * Uso:
 *   node scripts/arca-cert.js --cert ruta/al.crt --key ruta/a.key
 *   node scripts/arca-cert.js --cert x.crt --key x.key --ambiente produccion
 *   node scripts/arca-cert.js --cert x.crt --key x.key --dry-run
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
function opcion(nombre, porDefecto = null) {
  const i = args.indexOf(nombre);
  if (i === -1 || i + 1 >= args.length) return porDefecto;
  return args[i + 1];
}
const dryRun = args.includes('--dry-run');

const rojo0  = (s) => `\x1b[31m${s}\x1b[0m`;
const verde0 = (s) => `\x1b[32m${s}\x1b[0m`;

// ── Modo --probar: consulta real a AFIP con lo que hay configurado ──
// Es la única comprobación que cierra el círculo: que los archivos sean
// coherentes no garantiza que AFIP tenga el certificado habilitado.
if (args.includes('--probar')) {
  (async () => {
    const { hasCredentials } = require('../src/services/arcaCredentials');
    console.log('\n  Credenciales cargables:');
    console.log(`    producción .... ${hasCredentials('produccion')   ? verde0('sí') : rojo0('no')}`);
    console.log(`    homologación .. ${hasCredentials('homologacion') ? verde0('sí') : rojo0('no')}`);

    if (!hasCredentials('produccion')) {
      console.log('\n  Sin credenciales de producción no se puede consultar el padrón.');
      process.exit(1);
    }

    console.log('\n  Consultando el padrón de AFIP (CUIT de prueba 30500010912)…');
    try {
      const { lookupCuit } = require('../src/services/arcaLookupService');
      const r = await lookupCuit('30500010912');
      if (r.source === 'afip') {
        console.log(`\n  ${verde0('✔')} AFIP autenticó con este certificado y respondió.`);
        console.log(`    servicio usado: ${r.servicioUsado}`);
      } else {
        console.log(`\n  ${rojo0('✖')} No se usó AFIP (fuente: ${r.source}).`);
        console.log('    El certificado puede no estar habilitado para el servicio de padrón,');
        console.log('    o AFIP lo rechazó. Mirá el log de arriba para el detalle.');
        process.exit(1);
      }
    } catch (err) {
      console.log(`\n  ${rojo0('✖')} Falló la consulta: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  })();
  return;
}

// ── Modo --exportar: deja los base64 listos para pegar en Railway ──
// Escribe a un archivo fuera del repositorio en vez de imprimir: la clave
// privada en la terminal queda en el scrollback y en el historial del shell.
if (args.includes('--exportar')) {
  const os = require('os');
  const amb = opcion('--ambiente', 'produccion');
  if (!['produccion', 'homologacion'].includes(amb)) {
    console.error(`Ambiente inválido: ${amb}. Usá produccion u homologacion.`);
    process.exit(1);
  }
  const suf = amb === 'produccion' ? 'PROD' : 'HOMO';
  const claves = [`ARCA_CERT_B64_${suf}`, `ARCA_KEY_B64_${suf}`, 'ARCA_STOCKER_CUIT', 'ARCA_MOCK'];

  const faltan = claves.filter((c) => !process.env[c]);
  if (faltan.includes(`ARCA_CERT_B64_${suf}`) || faltan.includes(`ARCA_KEY_B64_${suf}`)) {
    console.error(`\n✖ No hay credenciales de ${amb} en el .env.`);
    console.error(`  Cargalas primero: node scripts/arca-cert.js --cert tu.crt --key tu.key`);
    process.exit(1);
  }

  const destino = opcion('--out', require('path').join(os.tmpdir(), `arca-${amb}-railway.txt`));
  const lineas = [
    `# Variables de ARCA (${amb}) para el servicio backend en Railway`,
    `# Generado ${new Date().toISOString()}`,
    '# CONTIENE LA CLAVE PRIVADA DE AFIP: borralo cuando termines de pegarlo.',
    '',
    ...claves.filter((c) => process.env[c]).map((c) => `${c}=${process.env[c]}`),
    '',
  ].join('\n');

  fs.writeFileSync(destino, lineas, { mode: 0o600 });
  console.log(`\n✔ Escrito en: ${destino}`);
  console.log('  (fuera del repo, permisos 600)\n');
  console.log('  Abrilo, copiá cada línea a las variables del servicio backend,');
  console.log('  y después borralo:');
  console.log(`\n    shred -u ${destino}\n`);
  process.exit(0);
}

const rutaCert = opcion('--cert');
const rutaKey  = opcion('--key');

if (!rutaCert || !rutaKey) {
  console.error('Faltan argumentos.\n');
  console.error('  node scripts/arca-cert.js --cert ruta/al.crt --key ruta/a.key\n');
  console.error('Opciones:');
  console.error('  --ambiente produccion|homologacion   si no se pasa, se deduce del emisor');
  console.error('  --dry-run                            valida y muestra, sin tocar el .env');
  process.exit(1);
}

const rojo  = (s) => `\x1b[31m${s}\x1b[0m`;
const verde = (s) => `\x1b[32m${s}\x1b[0m`;
const amar  = (s) => `\x1b[33m${s}\x1b[0m`;

function abortar(mensaje, ayuda) {
  console.error(`\n${rojo('✖')} ${mensaje}`);
  if (ayuda) console.error(`  ${ayuda}`);
  process.exit(1);
}

// ── Leer los archivos ─────────────────────────────────────────────
for (const [etiqueta, ruta] of [['certificado', rutaCert], ['clave privada', rutaKey]]) {
  if (!fs.existsSync(ruta)) abortar(`No existe el archivo de ${etiqueta}: ${ruta}`);
}
const certPem = fs.readFileSync(rutaCert, 'utf8');
const keyPem  = fs.readFileSync(rutaKey, 'utf8');

if (!certPem.includes('-----BEGIN CERTIFICATE-----')) {
  abortar('El archivo de certificado no está en formato PEM.',
          'AFIP lo entrega así. Si lo tenés en .pfx/.p12, convertilo primero con openssl pkcs12 -in archivo.pfx -clcerts -nokeys -out cert.crt');
}
if (!keyPem.includes('PRIVATE KEY')) {
  abortar('El archivo de clave no parece una clave privada PEM.');
}
if (keyPem.includes('ENCRYPTED')) {
  abortar('La clave privada tiene contraseña.',
          'El servidor no puede desbloquearla sola. Quitale la contraseña con: openssl rsa -in tu.key -out tu-sin-pass.key');
}

// ── Validar el certificado ────────────────────────────────────────
let cert;
try {
  cert = new crypto.X509Certificate(certPem);
} catch (err) {
  abortar(`No se pudo leer el certificado: ${err.message}`);
}

const subject = cert.subject.replace(/\n/g, ' · ');
const issuer  = cert.issuer.replace(/\n/g, ' · ');
const desde   = new Date(cert.validFrom);
const hasta   = new Date(cert.validTo);
const ahora   = new Date();

// ── ¿La clave corresponde al certificado? ─────────────────────────
// Es la verificación que evita el error críptico de AFIP más adelante.
let keyObj;
try {
  keyObj = crypto.createPrivateKey(keyPem);
} catch (err) {
  abortar(`No se pudo leer la clave privada: ${err.message}`);
}
if (!cert.checkPrivateKey(keyObj)) {
  abortar('La clave privada NO corresponde a este certificado.',
          'Suele pasar al generar un CSR nuevo y bajar el .crt sin guardar la .key que le dio origen. Necesitás la clave con la que generaste ESE pedido.');
}

// ── Ambiente: producción u homologación ───────────────────────────
// El emisor lo dice: la CA de pruebas de AFIP se llama "Computadores Test".
const esHomoPorEmisor = /Computadores Test/i.test(issuer);
const ambienteDetectado = esHomoPorEmisor ? 'homologacion' : 'produccion';
const ambiente = opcion('--ambiente', ambienteDetectado);

if (!['produccion', 'homologacion'].includes(ambiente)) {
  abortar(`Ambiente inválido: ${ambiente}`, 'Usá produccion u homologacion.');
}
if (ambiente !== ambienteDetectado) {
  abortar(
    `Pediste guardarlo como ${ambiente}, pero el emisor dice que es de ${ambienteDetectado}.`,
    'Guardar un certificado de homologación en las variables de producción hace que la facturación real falle. Revisá qué archivo estás cargando.'
  );
}

// ── CUIT del certificado vs el configurado ────────────────────────
const cuitCert = (subject.match(/serialNumber\s*=\s*CUIT\s*(\d{11})/i) || [])[1] || null;
const cuitEnv  = (process.env.ARCA_STOCKER_CUIT || '').replace(/\D/g, '');

// ── Resumen ───────────────────────────────────────────────────────
console.log('\n─────────────────────────────────────────');
console.log('  Certificado a cargar');
console.log('─────────────────────────────────────────');
console.log(`  Titular ....... ${subject}`);
console.log(`  Emisor ........ ${issuer}`);
console.log(`  Ambiente ...... ${ambiente}${opcion('--ambiente') ? '' : ' (deducido del emisor)'}`);
console.log(`  Vigencia ...... ${desde.toLocaleDateString('es-AR')} → ${hasta.toLocaleDateString('es-AR')}`);
console.log(`  CUIT .......... ${cuitCert || '(no figura en el titular)'}`);
console.log(`  Clave privada . ${verde('corresponde a este certificado')}`);

const avisos = [];
if (ahora < desde) avisos.push(`El certificado todavía no es válido: empieza el ${desde.toLocaleDateString('es-AR')}.`);
if (ahora > hasta) avisos.push(`El certificado está VENCIDO desde el ${hasta.toLocaleDateString('es-AR')}.`);
else {
  const diasRestantes = Math.round((hasta - ahora) / 86400000);
  if (diasRestantes < 30) avisos.push(`Vence en ${diasRestantes} días.`);
}
if (cuitCert && cuitEnv && cuitCert !== cuitEnv) {
  avisos.push(`El CUIT del certificado (${cuitCert}) no coincide con ARCA_STOCKER_CUIT (${cuitEnv}).`);
}
if (cuitCert && !cuitEnv) {
  avisos.push('ARCA_STOCKER_CUIT no está definida en el .env.');
}

if (avisos.length) {
  console.log('');
  for (const a of avisos) console.log(`  ${amar('⚠')} ${a}`);
}
console.log('');

const bloqueante = avisos.some((a) => /VENCIDO|no coincide/.test(a));
if (bloqueante && !args.includes('--force')) {
  abortar('Hay un problema que impediría facturar.', 'Si sabés lo que hacés, repetí con --force.');
}

// ── Escribir el .env ──────────────────────────────────────────────
const sufijo = ambiente === 'produccion' ? 'PROD' : 'HOMO';
const claveCert = `ARCA_CERT_B64_${sufijo}`;
const claveKey  = `ARCA_KEY_B64_${sufijo}`;
const b64Cert = Buffer.from(certPem, 'utf8').toString('base64');
const b64Key  = Buffer.from(keyPem, 'utf8').toString('base64');

if (dryRun) {
  console.log(`${amar('Modo --dry-run:')} no se tocó ningún archivo.`);
  console.log(`  Se habría escrito ${claveCert} (${b64Cert.length} chars) y ${claveKey} (${b64Key.length} chars).`);
  process.exit(0);
}

const rutaEnv = path.join(__dirname, '..', '.env');
if (!fs.existsSync(rutaEnv)) abortar(`No encontré el .env en ${rutaEnv}`);

// Copia de seguridad antes de tocar nada: si algo sale mal, el original está.
const respaldo = `${rutaEnv}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.copyFileSync(rutaEnv, respaldo);
fs.chmodSync(respaldo, 0o600);

let contenido = fs.readFileSync(rutaEnv, 'utf8');
function upsert(texto, clave, valor) {
  const rx = new RegExp(`^${clave}=.*$`, 'm');
  if (rx.test(texto)) return texto.replace(rx, `${clave}=${valor}`);
  return `${texto.replace(/\s*$/, '')}\n${clave}=${valor}\n`;
}
contenido = upsert(contenido, claveCert, b64Cert);
contenido = upsert(contenido, claveKey, b64Key);
fs.writeFileSync(rutaEnv, contenido, { mode: 0o600 });

console.log(`${verde('✔')} .env actualizado (${claveCert} y ${claveKey}).`);
console.log(`  Respaldo del anterior: ${path.basename(respaldo)}`);

// ── Siguientes pasos ──────────────────────────────────────────────
console.log('\n─────────────────────────────────────────');
console.log('  Para llevarlo a Railway');
console.log('─────────────────────────────────────────');
console.log(`  Copiá el valor de ${claveCert} y ${claveKey} del .env`);
console.log('  a las variables del servicio backend. Para verlos:');
console.log('');
console.log(`    grep '^${claveCert}=' .env | cut -d= -f2-`);
console.log(`    grep '^${claveKey}=' .env | cut -d= -f2-`);
console.log('');
console.log('  Son cadenas largas de una sola línea: copialas enteras.');
console.log('');
console.log('  Verificá que AFIP lo acepte:');
console.log('    node scripts/arca-cert.js --probar');
console.log('');
console.log(`  ${amar('Acordate de revocar el certificado anterior en AFIP')}`);
console.log('  (Administración de Certificados Digitales) si lo estás reemplazando.');
console.log('');
