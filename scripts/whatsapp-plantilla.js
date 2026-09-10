/*
 * La plantilla de WhatsApp para los códigos de verificación.
 *
 * Meta no deja mandar un código de un solo uso como texto libre: tiene que ir
 * en una plantilla de categoría AUTHENTICATION, aprobada de antemano. Este
 * script la crea, la consulta y la borra, para no tener que ir a hacerlo a mano
 * al Business Manager y para que quede escrito con qué forma exacta se creó.
 *
 * El cuerpo del mensaje NO se elige: en las plantillas de autenticación lo fija
 * y lo traduce Meta ("{{1}} es tu código de verificación"). Lo único que se
 * decide es si lleva la advertencia de seguridad, si avisa el vencimiento, y
 * qué botón tiene. Por eso acá no hay ningún texto para redactar.
 *
 * Uso:
 *   node scripts/whatsapp-plantilla.js ver
 *   node scripts/whatsapp-plantilla.js crear
 *   node scripts/whatsapp-plantilla.js borrar
 *
 * Necesita en el entorno:
 *   WHATSAPP_META_TOKEN     el token de acceso (con permiso whatsapp_business_management)
 *   WHATSAPP_META_WABA_ID   el id de la cuenta de WhatsApp Business (NO el del teléfono)
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const VERSION = process.env.WHATSAPP_META_API_VERSION || 'v22.0';
const TOKEN   = process.env.WHATSAPP_META_TOKEN;
const WABA    = process.env.WHATSAPP_META_WABA_ID;

const NOMBRE  = process.env.WHATSAPP_OTP_TEMPLATE || 'codigo_stocker';
const IDIOMA  = process.env.WHATSAPP_OTP_TEMPLATE_LANG || 'es_AR';
// Los 15 minutos que dura el código de nuestro lado. Que el mensaje diga otra
// cosa sería peor que no decir nada.
const VENCE_EN_MIN = 15;

const rojo  = (t) => `\x1b[31m${t}\x1b[0m`;
const verde = (t) => `\x1b[32m${t}\x1b[0m`;
const negro = (t) => `\x1b[1m${t}\x1b[0m`;

function faltaAlgo() {
  const faltan = [];
  if (!TOKEN) faltan.push('WHATSAPP_META_TOKEN');
  if (!WABA)  faltan.push('WHATSAPP_META_WABA_ID');
  if (!faltan.length) return null;
  return `Faltan variables de entorno: ${faltan.join(', ')}.\n`
    + '  El WABA_ID está en Business Manager → Cuentas de WhatsApp → tu cuenta.\n'
    + '  Ojo: NO es el mismo id que WHATSAPP_META_PHONE_NUMBER_ID.';
}

async function api(ruta, opciones = {}) {
  const url = `https://graph.facebook.com/${VERSION}/${ruta}`;
  const r = await fetch(url, {
    ...opciones,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(opciones.headers || {}),
    },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = data?.error || {};
    throw new Error(`${e.code || r.status} · ${e.message || 'error de Meta'}${e.error_user_msg ? ` — ${e.error_user_msg}` : ''}`);
  }
  return data;
}

async function ver() {
  const data = await api(`${WABA}/message_templates?name=${encodeURIComponent(NOMBRE)}&limit=20`);
  const encontradas = data?.data || [];
  if (!encontradas.length) {
    console.log(`No hay ninguna plantilla llamada ${negro(NOMBRE)} en esta cuenta.`);
    console.log('Creala con:  node scripts/whatsapp-plantilla.js crear');
    return;
  }
  console.log(negro(`Plantillas llamadas "${NOMBRE}":`));
  for (const t of encontradas) {
    const estado = t.status === 'APPROVED' ? verde(t.status) : rojo(t.status);
    console.log(`  ${t.language.padEnd(8)} ${estado.padEnd(20)} categoría: ${t.category}`);
    const botones = (t.components || []).find((c) => c.type === 'BUTTONS');
    if (botones) {
      const tipos = botones.buttons.map((b) => b.otp_type || b.type).join(', ');
      console.log(`           botón: ${tipos}`);
      console.log(`           → en el entorno: WHATSAPP_OTP_TEMPLATE_BOTON=copiar`);
    } else {
      console.log('           sin botón → NO pongas WHATSAPP_OTP_TEMPLATE_BOTON');
    }
    if (t.status !== 'APPROVED' && t.rejected_reason) {
      console.log(`           rechazo: ${t.rejected_reason}`);
    }
  }
  const aprobada = encontradas.find((t) => t.language === IDIOMA && t.status === 'APPROVED');
  console.log(aprobada
    ? verde(`\n✓ Lista para usar en ${IDIOMA}.`)
    : rojo(`\n✖ Todavía no hay una aprobada en ${IDIOMA}. Meta suele tardar unos minutos.`));
}

async function crear() {
  /*
   * Con botón de copiar.
   *
   * Es el que funciona en cualquier teléfono sin configuración extra. Los
   * otros —one-tap y zero-tap— necesitan que la app de Android esté firmada y
   * declarada ante Meta, que acá no aplica: el cliente entra por el navegador.
   */
  const cuerpo = {
    name: NOMBRE,
    language: IDIOMA,
    category: 'AUTHENTICATION',
    components: [
      // El texto lo pone Meta. `add_security_recommendation` le suma
      // "No compartas este código con nadie", que es exactamente lo que hay
      // que decir y en el idioma de la plantilla.
      { type: 'BODY', add_security_recommendation: true },
      { type: 'FOOTER', code_expiration_minutes: VENCE_EN_MIN },
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copiar código' }] },
    ],
  };

  console.log(negro('Creando la plantilla con esta forma:'));
  console.log(JSON.stringify(cuerpo, null, 2));

  const r = await api(`${WABA}/message_templates`, { method: 'POST', body: JSON.stringify(cuerpo) });
  console.log(verde(`\n✓ Creada. id: ${r.id} · estado: ${r.status || 'PENDING'}`));
  console.log('\nPoné esto en el entorno del backend:');
  console.log(`  WHATSAPP_OTP_TEMPLATE=${NOMBRE}`);
  console.log(`  WHATSAPP_OTP_TEMPLATE_LANG=${IDIOMA}`);
  console.log('  WHATSAPP_OTP_TEMPLATE_BOTON=copiar');
  console.log('\nMeta la revisa sola; suele aprobarla en minutos.');
  console.log('Mirá cómo va con:  node scripts/whatsapp-plantilla.js ver');
}

async function borrar() {
  await api(`${WABA}/message_templates?name=${encodeURIComponent(NOMBRE)}`, { method: 'DELETE' });
  console.log(verde(`✓ Borrada la plantilla "${NOMBRE}" (todos sus idiomas).`));
}

(async () => {
  const problema = faltaAlgo();
  if (problema) { console.error(rojo('✖ ' + problema)); process.exit(1); }

  const accion = process.argv[2];
  const acciones = { ver, crear, borrar };
  if (!acciones[accion]) {
    console.log('Uso: node scripts/whatsapp-plantilla.js [ver|crear|borrar]');
    process.exit(1);
  }
  try {
    await acciones[accion]();
  } catch (e) {
    console.error(rojo(`✖ ${e.message}`));
    process.exit(1);
  }
})();
