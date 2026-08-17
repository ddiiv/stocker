#!/usr/bin/env node
/*
 * Alta del superusuario del backoffice.
 *
 * Se corre a mano, en el servidor, una sola vez. No hay endpoint que cree
 * superusuarios: si existiera, sería el camino más corto para tomar la
 * plataforma entera.
 *
 * Uso:
 *   node scripts/crear-superuser.js "Nombre Apellido" email@dominio.com
 *   node scripts/crear-superuser.js "Nombre Apellido" email@dominio.com --reset
 *
 * Hace todo en una corrida: crea la cuenta, muestra la clave del segundo
 * factor, espera a que la cargues en el teléfono y la activa contra el código
 * que te muestre la app. Al terminar ya podés entrar.
 *
 * La primera versión pedía cargar un BACKOFFICE_SETUP_TOKEN en el entorno,
 * reiniciar el backend y activar el 2FA por HTTP. Era ceremonia sin beneficio:
 * este script ya corre con acceso a la base y al servidor, así que pedirle un
 * token para un paso de la misma sesión de consola sólo agregaba tres formas
 * de trabarse. El endpoint sigue existiendo para reactivar el 2FA sin consola.
 *
 * La contraseña se pide por consola y nunca por argumento: los argumentos
 * quedan en el historial del shell y en la lista de procesos.
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const readline = require('node:readline');
const { PlatformAdmin } = require('../src/models');
const totp = require('../src/utils/totp');
const { evaluate } = require('../src/utils/passwordPolicy');

function preguntar(pregunta, oculto = false) {
  return new Promise((resolver) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (!oculto) return rl.question(pregunta, (r) => { rl.close(); resolver(r.trim()); });

    // Eco apagado: la contraseña no se muestra mientras se tipea.
    process.stdout.write(pregunta);
    const alEscribir = rl._writeToOutput;
    rl._writeToOutput = function () { /* sin eco */ };
    rl.question('', (r) => {
      rl._writeToOutput = alEscribir;
      rl.close();
      process.stdout.write('\n');
      resolver(r);
    });
  });
}

// Google Authenticator acepta la clave tipeada a mano si viene en grupos de 4.
const enGrupos = (s) => s.match(/.{1,4}/g).join(' ');

const linea = '─'.repeat(62);

(async () => {
  const nombre = process.argv[2];
  const email = String(process.argv[3] || '').trim().toLowerCase();
  const reset = process.argv.includes('--reset');

  if (!nombre || !email) {
    console.error('Uso: node scripts/crear-superuser.js "Nombre Apellido" email@dominio.com [--reset]');
    process.exit(1);
  }

  const existente = await PlatformAdmin.findOne({ where: { email } });
  if (existente && !reset) {
    console.error(`\nYa existe un operador con el email ${email}.`);
    console.error('Para rehacerle la contraseña y el segundo factor:\n');
    console.error(`  node scripts/crear-superuser.js "${nombre}" ${email} --reset\n`);
    process.exit(1);
  }

  // ── Contraseña ───────────────────────────────────────────────
  console.log(`\n${linea}\n  ${existente ? 'REHACER' : 'CREAR'} SUPERUSUARIO — ${email}\n${linea}\n`);

  let password;
  for (;;) {
    password = await preguntar('  Contraseña: ', true);
    const repetida = await preguntar('  Repetila:   ', true);

    if (password !== repetida) {
      console.log('\n  Las contraseñas no coinciden. De nuevo.\n');
      continue;
    }
    const politica = evaluate(password);
    if (!politica.valid) {
      console.log('\n  La contraseña no cumple:');
      for (const f of politica.failed) console.log(`    · ${f.msg}`);
      console.log('');
      continue;
    }
    break;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const totpSecret = totp.generarSecreto();

  const datos = {
    nombre, email, passwordHash, rol: 'superuser', activo: true,
    totpSecret, totpActivadoEn: null,
  };
  const admin = existente ? await existente.update(datos) : await PlatformAdmin.create(datos);

  // ── Segundo factor ───────────────────────────────────────────
  console.log(`\n${linea}
  SEGUNDO FACTOR

  Abrí Google Authenticator (o Authy, o 1Password) y agregá una
  cuenta nueva con esta clave:

      ${enGrupos(totpSecret)}

  En Google Authenticator es "Ingresar clave de configuración",
  con el tipo "Basada en tiempo".

  Si preferís el QR, pegá este link en cualquier generador:

      ${totp.uriParaQr({ secreto: totpSecret, cuenta: email })}
${linea}\n`);

  let intentos = 0;
  for (;;) {
    const codigo = await preguntar('  Código de 6 dígitos que muestra la app: ');

    if (totp.validar(totpSecret, codigo)) break;

    intentos++;
    console.log('\n  Ese código no coincide.');
    if (intentos === 1) {
      // Es la causa del 90% de los fallos y no es obvia: el TOTP se calcula
      // contra el reloj, así que un teléfono desfasado nunca va a acertar.
      console.log('  Revisá que la hora del teléfono esté en automático,');
      console.log('  y probá con el código siguiente (cambian cada 30 segundos).\n');
    } else if (intentos >= 5) {
      console.log('\n  La cuenta quedó creada pero SIN el segundo factor activo,');
      console.log('  así que todavía no se puede entrar. Volvé a correr:\n');
      console.log(`    node scripts/crear-superuser.js "${nombre}" ${email} --reset\n`);
      process.exit(1);
    } else {
      console.log('');
    }
  }

  await admin.update({ totpActivadoEn: new Date() });

  console.log(`\n${linea}
  LISTO — ya podés entrar al backoffice

  Usuario   ${email}
  Segundo factor activo

  En desarrollo:  http://localhost:5174
  En producción:  el dominio del servicio del backoffice

  El login pide los tres datos juntos: email, contraseña y el
  código del momento.

  Un detalle de desarrollo: en localhost las cookies se comparten
  entre puertos, así que si tenés la sesión de un negocio abierta
  en :5173 va a chocar con la del backoffice. Usá una ventana de
  incógnito para cada una. En producción son dominios distintos y
  no pasa.

  La clave del segundo factor no se vuelve a mostrar. Si la
  perdés, corré este script otra vez con --reset.
${linea}\n`);

  process.exit(0);
})().catch((e) => {
  console.error('\nNo se pudo crear el superusuario:', e.message, '\n');
  process.exit(1);
});
