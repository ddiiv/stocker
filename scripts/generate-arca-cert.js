#!/usr/bin/env node
/*
 * Genera la private key + CSR para dar de alta el certificado de Stocker en AFIP.
 *
 * Uso:
 *   ARCA_STOCKER_CUIT=20472979397 ARCA_ORG="Stocker" node scripts/generate-arca-cert.js
 *
 * Salida: escribe stocker.key y stocker.csr en backend/storage/arca/.
 * Después del script vos:
 *   1. Entrás a https://auth.afip.gob.ar/contribuyente_/login.xhtml con tu Clave Fiscal.
 *   2. Buscás el servicio "Administrador de Certificados Digitales".
 *   3. Botón "Agregar alias" → nombre (ej. "stocker") → pegás/subís el CSR.
 *   4. AFIP te muestra el certificado firmado (.crt) — copiálo a backend/storage/arca/stocker.crt.
 *   5. Buscás "Administrador de Relaciones" → tu CUIT → Nueva Relación:
 *        - Servicio: "Facturación Electrónica" (wsfe)
 *        - Representante: tu propio CUIT (o el CUIT de la empresa cliente cuando quiera delegarte)
 *        - Computador Fiscal: el alias "stocker" recién creado.
 *   6. En .env: setear ARCA_MOCK=false, ARCA_CERT_PATH y ARCA_KEY_PATH a las rutas absolutas.
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const isMock = process.env.ARCA_MOCK === 'true';
const c = process.env.ARCA_STOCKER_CUIT;
console.log(`[ARCA] Modo ${isMock ? 'MOCK' : 'REAL'} — Stocker CUIT=${c || '(no configurado)'}`);

const CUIT = process.env.ARCA_STOCKER_CUIT;
const ORG  = process.env.ARCA_ORG || 'Stocker';
if (!CUIT || !/^\d{11}$/.test(CUIT)) {
  console.error('✖ ARCA_STOCKER_CUIT debe estar seteado con 11 dígitos.');
  process.exit(1);
}

const outDir = path.join(__dirname, '..', 'storage', 'arca');
fs.mkdirSync(outDir, { recursive: true });

const keyPath = path.join(outDir, 'stocker.key');
const csrPath = path.join(outDir, 'stocker.csr');

if (fs.existsSync(keyPath)) {
  console.error(`✖ Ya existe ${keyPath}. Borralo manualmente si querés regenerar.`);
  process.exit(1);
}

console.log(`→ Generando private key en ${keyPath}`);
execSync(`openssl genrsa -out "${keyPath}" 2048`, { stdio: 'inherit' });
fs.chmodSync(keyPath, 0o600);

const subject = `/C=AR/O=${ORG}/CN=stocker/serialNumber=CUIT ${CUIT}`;
console.log(`→ Generando CSR en ${csrPath}`);
console.log(`  Subject: ${subject}`);
execSync(`openssl req -new -key "${keyPath}" -subj "${subject}" -out "${csrPath}"`, { stdio: 'inherit' });

console.log('\n─────────────────────────────────────────────────────────────');
console.log('✔ Listo. Próximos pasos:\n');
console.log(`  1. Copiá el contenido de ${csrPath} y subilo a:`);
console.log('     https://auth.afip.gob.ar → "Administrador de Certificados Digitales"');
console.log('     → "Agregar alias" (nombre sugerido: "stocker") → pegá el CSR → Aceptar.');
console.log(`  2. Descargá el .crt firmado y guardalo como ${outDir}/stocker.crt`);
console.log('  3. En .env agregá:');
console.log('       ARCA_MOCK=false');
console.log(`       ARCA_STOCKER_CUIT=${CUIT}`);
console.log(`       ARCA_CERT_PATH=${outDir}/stocker.crt`);
console.log(`       ARCA_KEY_PATH=${keyPath}`);
console.log('  4. Reiniciá el backend y probá con `GET /api/arca/status`.');
console.log('─────────────────────────────────────────────────────────────');
