/*
 * Las casillas del dominio propio.
 *
 * Son tres CUENTAS REALES, cada una con su usuario y su contraseña. No son
 * alias, y esa diferencia es la que resuelve el problema de fondo: cuando el
 * que autentica el SMTP es el mismo que figura como remitente, Gmail no tiene
 * nada que reescribir.
 *
 * Con alias pasaba lo contrario. Se autenticaba con la cuenta principal y se
 * mandaba "como" noreply@; Gmail aceptaba el mail —respondía 250, igual que si
 * estuviera todo bien— y recién al entregarlo cambiaba el remitente por la
 * cuenta autenticada, dejando `X-Google-Original-From` en el encabezado. El
 * cliente veía una dirección distinta de la que el sistema había puesto, y
 * desde el código no había manera de detectarlo.
 *
 *   noreply@   Manda todo lo automático: comprobantes, cotizaciones, facturas,
 *              códigos de acceso y avisos de diferencia de caja. Es la cuenta
 *              con la que se autentica el envío.
 *
 *   soporte@   Recibe los reportes de problemas. Va al revés que las otras:
 *              acá Stocker recibe y hay una persona del otro lado. Tiene
 *              credencial propia por si el sistema necesita responder desde
 *              ella; hoy ningún envío la usa.
 *
 *   official@  La cuenta principal de Workspace: administración, verificación
 *              del dominio y firma de SPF/DKIM/DMARC. No manda mails del
 *              sistema.
 */

const DOMINIO = process.env.MAIL_DOMINIO || 'stockerback.com';

const dir = (valor, porDefecto) => String(valor || porDefecto).trim().toLowerCase();

/*
 * Cada cuenta con su credencial.
 *
 * `MAIL_PASSSORTE` está escrito así en las variables del proyecto; se acepta
 * también `MAIL_PASSSOPORTE`, que es como lo va a escribir cualquiera que
 * agregue la variable de memoria dentro de seis meses. Aceptar las dos evita
 * que la casilla quede sin credencial por una letra.
 */
const CUENTAS = {
  principal: {
    user: dir(process.env.MAIL_USER, `official@${DOMINIO}`),
    pass: process.env.MAIL_PASS || null,
  },
  noreply: {
    user: dir(process.env.MAIL_NOREPLY, `noreply@${DOMINIO}`),
    /*
     * Sin credencial propia se cae a la principal.
     *
     * Es lo que mantiene el sistema andando durante la migración: mientras
     * noreply@ todavía no existe como usuario, sigue mandando la principal
     * —con el remitente reescrito, pero mandando— en vez de cortar los
     * comprobantes de golpe. El aviso de arranque lo señala igual.
     */
    pass: process.env.MAIL_PASSNOREPLY || process.env.MAIL_PASS || null,
    propia: Boolean(process.env.MAIL_PASSNOREPLY),
  },
  soporte: {
    user: dir(process.env.MAIL_SOPORTE, `soporte@${DOMINIO}`),
    pass: process.env.MAIL_PASSSORTE || process.env.MAIL_PASSSOPORTE || null,
  },
};

/** Las direcciones sueltas, para quien sólo necesita saber a dónde escribir. */
const CASILLAS = {
  noreply: CUENTAS.noreply.user,
  soporte: CUENTAS.soporte.user,
  oficial: CUENTAS.principal.user,
};

/*
 * El nombre que se ve en la bandeja del que recibe.
 *
 * Es siempre Stocker, y no el nombre del negocio: el mail sale de
 * noreply@stockerback.com y ese dominio es el que firma SPF y DKIM. Un
 * remitente que dice "Isumayorista" desde stockerback.com es un nombre que no
 * tiene nada que ver con la dirección, y eso es justo lo que los filtros
 * marcan. El negocio va en el asunto y en el encabezado del cuerpo, que es
 * donde el cliente lo lee igual.
 */
const NOMBRE_REMITENTE = process.env.MAIL_NOMBRE || 'Stocker';

/*
 * Con qué cuenta se manda.
 *
 * Todo sale por noreply, incluidos los reportes que van a soporte. Mandarlos
 * DESDE soporte hacia soporte sería un mail a uno mismo, y Gmail descarta esos
 * duplicados: el reporte llegaría a veces sí y a veces no.
 */
const CUENTA_ENVIO = 'noreply';

function remitente() {
  return `"${NOMBRE_REMITENTE}" <${CASILLAS.noreply}>`;
}

function haciaSoporte() {
  return { from: remitente(), to: CASILLAS.soporte };
}

/*
 * Estado de la configuración, para el arranque.
 *
 * Un correo mal configurado no falla: manda igual y cae en spam, o llega con
 * el remitente cambiado. Es peor que un error, porque nadie se entera hasta
 * que un cliente dice que no le llegó el comprobante.
 */
function estado() {
  const envio = CUENTAS[CUENTA_ENVIO];
  const alDominio = envio.user.endsWith(`@${DOMINIO}`);
  const avisos = [];

  if (!envio.pass) {
    avisos.push('Sin contraseña para la cuenta de envío: no se manda ningún mail.');
  } else if (!envio.propia) {
    /*
     * Está autenticando con la principal. Gmail va a reescribir el remitente
     * al entregar y el cliente verá la principal, no noreply@. Es exactamente
     * el problema que las cuentas separadas vienen a resolver, así que se
     * avisa aunque el envío "funcione".
     */
    avisos.push(
      `Falta MAIL_PASSNOREPLY: se autentica con la cuenta principal (${CUENTAS.principal.user}) `
      + `y se manda como ${envio.user}. Gmail va a reescribir el remitente y el cliente va a ver la principal.`,
    );
  }
  if (!alDominio) {
    avisos.push(`La cuenta de envío (${envio.user}) no es del dominio ${DOMINIO}: los mails pueden ir a spam.`);
  }

  return {
    dominio: DOMINIO,
    casillas: { ...CASILLAS },
    cuentaEnvio: envio.user,
    // Que el que autentica sea el que figura como remitente es la condición
    // para que Gmail no reescriba nada.
    credencialPropia: Boolean(envio.propia),
    soporteConCredencial: Boolean(CUENTAS.soporte.pass),
    configurado: Boolean(envio.pass),
    dominioCoincide: alDominio,
    avisos,
  };
}

module.exports = {
  CUENTAS, CASILLAS, DOMINIO, NOMBRE_REMITENTE, CUENTA_ENVIO,
  remitente, haciaSoporte, estado,
};
