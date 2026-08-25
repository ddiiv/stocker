/*
 * Comprueba la configuración de correo, cuenta por cuenta.
 *
 * Existe por una lección concreta: la respuesta del servidor no alcanza como
 * prueba. Gmail contesta 250 tanto cuando el remitente está autorizado como
 * cuando lo va a reescribir al entregar, así que un envío "exitoso" puede
 * llegar con otra dirección y nadie enterarse hasta que un cliente reclama.
 *
 * Lo que sí se puede verificar desde acá es que cada cuenta autentique con su
 * propia credencial — que es la condición para que no haya reescritura. El
 * resto se confirma mirando el encabezado del mail que llega.
 *
 * Uso:
 *   node scripts/probar-correo.cjs            comprueba las credenciales
 *   node scripts/probar-correo.cjs --enviar   además manda una prueba a soporte
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const nodemailer = require('nodemailer');
const correo = require('../src/config/correo');

const verde = (t) => `\x1b[32m${t}\x1b[0m`;
const rojo  = (t) => `\x1b[31m${t}\x1b[0m`;
const gris  = (t) => `\x1b[90m${t}\x1b[0m`;

function transporte(datos) {
  const port = parseInt(process.env.MAIL_PORT, 10) || 465;
  return nodemailer.createTransport({
    host: process.env.MAIL_HOST || 'smtp.gmail.com',
    port,
    secure: process.env.MAIL_SECURE === 'true' || (process.env.MAIL_SECURE == null && port === 465),
    auth: { user: datos.user, pass: String(datos.pass).replace(/\s+/g, '') },
    connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000,
  });
}

(async () => {
  const e = correo.estado();
  console.log(`\n\x1b[1mCorreo de ${e.dominio}\x1b[0m\n`);

  for (const [nombre, datos] of Object.entries(correo.CUENTAS)) {
    const etiqueta = `${nombre} (${datos.user})`.padEnd(46);
    if (!datos.pass) {
      console.log(`  ${etiqueta} ${gris('sin credencial — no se probó')}`);
      continue;
    }
    try {
      await transporte(datos).verify();
      console.log(`  ${etiqueta} ${verde('✔ autentica')}`);
    } catch (err) {
      console.log(`  ${etiqueta} ${rojo('✖ ' + (err.code || '') + ' ' + err.message.split('\n')[0])}`);
    }
  }

  console.log('');
  if (e.avisos.length) {
    for (const a of e.avisos) console.log(`  ${rojo('✖')} ${a}`);
  } else {
    console.log(`  ${verde('✔')} La cuenta que autentica es la que figura como remitente.`);
  }

  if (process.argv.includes('--enviar')) {
    const sello = new Date().toLocaleTimeString('es-AR');
    try {
      const info = await transporte(correo.CUENTAS[correo.CUENTA_ENVIO]).sendMail({
        from: correo.remitente(),
        to: correo.CASILLAS.soporte,
        subject: `Prueba de correo — ${sello}`,
        text: 'Prueba de configuración.\n\n'
            + 'Abrí este mail, entrá a "Mostrar original" y mirá el encabezado:\n'
            + `  · Si dice  From: Stocker <${correo.CASILLAS.noreply}>  y NO aparece X-Google-Original-From, está bien.\n`
            + '  · Si aparece X-Google-Original-From, Gmail reescribió el remitente.\n',
      });
      console.log(`\n  ${verde('✔')} Enviado a ${correo.CASILLAS.soporte} — asunto "Prueba de correo — ${sello}"`);
      console.log(`  ${gris('El 250 del servidor no prueba que llegue con ese remitente: revisá "Mostrar original".')}`);
      console.log(`  ${gris('messageId: ' + info.messageId)}`);
    } catch (err) {
      console.log(`\n  ${rojo('✖ No se pudo enviar:')} ${err.message.split('\n')[0]}`);
    }
  }

  console.log('');
  process.exit(e.avisos.length ? 1 : 0);
})();
