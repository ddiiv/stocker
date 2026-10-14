/*
 * A quién le avisa Stocker de una venta.
 *
 * Al cliente: su comprobante, por mail (con el PDF) si tiene mail y por
 * WhatsApp si tiene número. Al negocio: NADA. Antes salían un mail y un
 * WhatsApp al dueño por cada venta; lo cortó el dueño de Stocker porque la
 * venta ya queda registrada en el sistema y cada envío cuesta. La copia de cada
 * FACTURA al mail del negocio sí sigue: es su comprobante fiscal.
 *
 * No manda nada de verdad ni toca la base: los envíos, el PDF y las lecturas
 * de la venta se reemplazan por espías ANTES de cargar el controlador (que los
 * toma al cargarse).
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
  const fs = require('fs');
  const path = require('path');
  const email = require('../src/services/emailService');
  const whatsapp = require('../src/services/whatsappService');
  const pdf = require('../src/services/pdfService');
  const { Sale, Business, BusinessCuit } = require('../src/models');

  // Todo envío exportado pasa por acá: si alguno le escribe al negocio, se ve.
  const envios = [];
  for (const [nombre, modulo] of [['mail', email], ['whatsapp', whatsapp]]) {
    for (const [fn, real] of Object.entries(modulo)) {
      if (typeof real !== 'function' || !/^send/.test(fn)) continue;
      modulo[fn] = async (datos = {}) => { envios.push({ canal: nombre, fn, a: datos.to || datos.telefono || null }); };
    }
  }
  const pdfs = [];
  pdf.generateSalePdf = async () => { pdfs.push(1); return null; };

  const DUENIO = { email: 'duenio@negocio.example', ownerTelefono: '+5491100000001', telefono: '+5491100000002' };
  const conJson = (o) => ({ ...o, toJSON: () => o });
  let cliente = null;
  Sale.findByPk = async () => conJson({
    id: 1, tipo: 'venta', numero: 'V-0001', total: 1000, items: [conJson({ titulo: 'Remera', cantidad: 1 })],
    cliente: cliente ? conJson(cliente) : null,
  });
  Business.findByPk = async () => conJson({ id: 7, nombreNegocio: 'Negocio de prueba', ...DUENIO });
  BusinessCuit.findOne = async () => null;

  const { notifySaleAsync } = require('../src/controllers/saleController');
  const correr = async (c) => {
    cliente = c;
    envios.length = 0;
    pdfs.length = 0;
    await notifySaleAsync(1, 7);
    await new Promise((r) => setImmediate(r));
    return envios.map((e) => `${e.canal}:${e.a}`).sort();
  };
  const alNegocio = () => envios.filter((e) => Object.values(DUENIO).includes(e.a));

  try {
    tit('1. CLIENTE CON MAIL Y WHATSAPP');
    const c1 = await correr({ nombre: 'Ana', email: 'ana@cliente.example', whatsapp: '+5491122223333' });
    chk('el cliente recibe su mail y su WhatsApp, y nada más sale', [
      'mail:ana@cliente.example', 'whatsapp:+5491122223333',
    ], c1);
    chk('nada va al mail ni al teléfono del negocio', [], alNegocio());
    chk('el PDF se arma una vez, para adjuntarlo', 1, pdfs.length);

    tit('2. CLIENTE SIN MAIL NI TELÉFONO, Y CONSUMIDOR FINAL');
    chk('cliente sin datos de contacto: no sale nada', [], await correr({ nombre: 'Beto' }));
    chk('  y no se arma un PDF que nadie va a recibir', 0, pdfs.length);
    chk('consumidor final: no sale nada', [], await correr(null));
    chk('  ni al negocio', [], alNegocio());

    tit('3. CLIENTE SÓLO CON TELÉFONO');
    chk('le llega el WhatsApp (cae en el teléfono si no hay whatsapp)', ['whatsapp:+5491144445555'],
      await correr({ nombre: 'Caro', telefono: '+5491144445555' }));
    chk('  sin PDF: no hay mail que lo lleve', 0, pdfs.length);

    tit('4. LOS AVISOS AL NEGOCIO YA NO EXISTEN; LA COPIA DE LA FACTURA SÍ');
    const realEmail = require.cache[require.resolve('../src/services/emailService')];
    chk('emailService no tiene el aviso de venta al negocio', false,
      'sendSaleNotificationToBusiness' in realEmail.exports);
    chk('whatsappService no tiene el aviso de venta al negocio', false,
      'sendSaleNotificationWhatsapp' in whatsapp);
    chk('la copia de la factura al negocio sigue existiendo', 'function', typeof email.sendInvoiceCopyToBusiness);
    const factura = fs.readFileSync(path.join(__dirname, '../src/controllers/invoiceController.js'), 'utf8');
    chk('  y la factura la sigue mandando al mail del negocio', true,
      /sendInvoiceCopyToBusiness\(\{\s*to: business\.email/.test(factura));
  } finally {
    const db = require('../src/config/database');
    await db.close().catch(() => {});
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
