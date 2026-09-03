/*
 * La factura sale con los datos del cliente de la venta.
 *
 * Si la venta tiene un cliente asociado, el comprobante se emite con SU CUIT,
 * SU razón social y SU domicilio. Antes el cuerpo del pedido los pisaba
 * —`clienteCuit || cliente?.cuit`—, y eso no es un problema de prolijidad: es
 * un comprobante fiscal emitido a nombre de un CUIT que no compró, y un
 * comprobante emitido no se corrige, se anula con nota de crédito.
 *
 * Y una vez emitido salen dos mails: el del cliente, que es su comprobante, y
 * la copia del negocio, que es lo que va al libro de IVA ventas.
 *
 * ── Por qué levanta su propio servidor ────────────────────────────
 *
 * Emitir de verdad exige que AFIP tenga la delegación del CUIT del negocio
 * hecha, y en una máquina de desarrollo casi nunca está: la emisión termina en
 * un 500 y no se llega a probar nada de lo de arriba. Con ARCA_MOCK el CAE es
 * simulado y todo el circuito posterior —los datos del cliente, la copia en la
 * factura, los dos correos— corre igual que en producción.
 *
 * Se levanta aparte y en otro puerto para no dejar el servidor de las demás
 * suites en modo simulado, que haría pasar en verde pruebas de facturación que
 * en realidad no probaron ARCA.
 *
 * Uso:  node scripts/test-factura-cliente.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const { spawn } = require('child_process');
const path = require('path');
const { Op } = require('sequelize');
const {
  Business, BusinessLocation, Client, PaymentMethod, Product, ProductVariant,
  Sale, SaleItem, SalePayment, Invoice, InvoiceItem, StockMovement, VariantStock,
} = require('../src/models');
const stock = require('../src/services/stockService');

const PUERTO = 3099;
const API = `http://localhost:${PUERTO}`;

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function sesion() {
  let cookie = '';
  return async (m, ruta, cuerpo) => {
    const r = await fetch(`${API}${ruta}`, {
      method: m,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    const set = r.headers.getSetCookie?.() || [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    let json = null; try { json = JSON.parse(await r.text()); } catch { /* no json */ }
    return { status: r.status, json };
  };
}

const CUIT_CLIENTE = '20111111112';
const CUIT_IMPOSTOR = '27222222228';

(async () => {
  /*
   * El servidor de esta suite: ARCA simulado y sin correo.
   *
   * Sin correo a propósito: los dos envíos se comprueban por lo que registra el
   * servicio, no mandando mails de verdad. Una suite que se corre veinte veces
   * por día no puede escribirle a nadie.
   */
  const servidor = spawn('node', [path.join(__dirname, '..', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PUERTO),
      ARCA_MOCK: 'true',
      /*
       * Las TRES credenciales, no una.
       *
       * La cuenta de envío es `noreply`, cuya clave sale de MAIL_PASSNOREPLY y
       * recién después cae a MAIL_PASS. Vaciando sólo la segunda el correo
       * seguía configurado y esta prueba mandaba dos mails de verdad en cada
       * corrida —uno a la casilla del negocio— sin que se notara: el único
       * síntoma era que la comprobación de abajo daba en rojo.
       */
      MAIL_PASS: '', MAIL_PASSNOREPLY: '', MAIL_PASSSORTE: '', MAIL_PASSSOPORTE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const salida = [];
  servidor.stdout.on('data', (d) => salida.push(String(d)));
  servidor.stderr.on('data', (d) => salida.push(String(d)));

  const cerrar = () => { try { servidor.kill('SIGTERM'); } catch { /* ya murió */ } };
  process.on('exit', cerrar);

  // Se espera a que conteste en vez de dormir un número fijo: en una máquina
  // cargada, doce segundos alcanzan y en otra no.
  let vivo = false;
  for (let i = 0; i < 40 && !vivo; i++) {
    await esperar(500);
    vivo = await fetch(`${API}/api/auth/me`).then(() => true).catch(() => false);
  }
  if (!vivo) {
    console.error('El servidor de prueba no levantó:\n', salida.join('').slice(-1500));
    cerrar(); process.exit(1);
  }

  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  const local = await BusinessLocation.findOne({
    where: { businessId: negocio.id, tipo: 'local', activo: true },
  });
  const metodo = await PaymentMethod.findOne({
    where: { businessId: negocio.id, activo: true, destinoCuit: false },
  });

  await Client.destroy({ where: { cuit: { [Op.in]: [CUIT_CLIENTE, CUIT_IMPOSTOR] } } });
  const cliente = await Client.create({
    businessId: negocio.id, nombre: 'QA Cliente', apellido: 'Facturado',
    cuit: CUIT_CLIENTE, email: 'qa.cliente@test.local',
    direccion: 'Av. Siempre Viva 742', telefono: '1155667788',
  });

  const prod = await Product.create({
    businessId: negocio.id, sku: 'QA-FACT', skuAgrupador: 'QA-FACT', titulo: 'QA Factura',
    precioMinorista: 1210, precioMayorista: 1210, costo: 500, activo: true,
  });
  const v = await ProductVariant.create({
    productId: prod.id, businessId: negocio.id, sku: 'QA-FACT-1',
    variante1Nombre: 'Color', variante1Valor: 'Único', stock: 0, stockMinimo: 0,
  });
  await stock.mover({
    variantId: v.id, businessId: negocio.id, locationId: local.id,
    delta: 20, tipo: 'ingreso', motivo: 'QA factura',
  });

  const api = sesion();
  const entro = await api('POST', '/api/auth/login', { email: negocio.email, password: 'Demo2026!!' });
  if (entro.status !== 200) { console.log('No se pudo entrar:', entro.status); cerrar(); process.exit(1); }

  const ventas = [];
  const vender = async (extra = {}) => {
    const r = await api('POST', '/api/sales', {
      tipo: 'venta', estado: 'pagado', locationId: local.id,
      items: [{ productVariantId: v.id, cantidad: 1 }],
      pagos: [{ paymentMethodId: metodo.id, monto: 1210 }],
      ...extra,
    });
    if (r.json?.id) ventas.push(r.json.id);
    return r;
  };

  try {
    tit('1. LA FACTURA SALE CON LOS DATOS DEL CLIENTE DE LA VENTA');
    const venta = await vender({ clientId: cliente.id });
    chk('la venta con cliente entra', 201, venta.status);

    const factura = await api('POST', '/api/invoices', {
      saleId: venta.json.id, enviarEmail: false, enviarWhatsapp: false,
    });
    chk('la factura se emite', 201, factura.status);
    chk('con CAE', true, Boolean(factura.json?.cae));
    chk('y el CUIT del cliente', CUIT_CLIENTE, factura.json?.clienteCuit);
    chk('con su nombre', 'QA Cliente Facturado', factura.json?.clienteNombre);
    chk('y su domicilio', 'Av. Siempre Viva 742', factura.json?.clienteDireccion);

    tit('2. NO SE PUEDE FACTURARLE A OTRO CUIT');
    /*
     * El caso que esto cierra: la venta es del cliente A y el pedido manda el
     * CUIT de B. Antes salía a nombre de B, con la venta figurando a nombre de
     * A. Un comprobante emitido no se corrige: se anula con nota de crédito.
     */
    const venta2 = await vender({ clientId: cliente.id });
    const impostor = await api('POST', '/api/invoices', {
      saleId: venta2.json.id, clienteCuit: CUIT_IMPOSTOR,
      clienteDireccion: 'Calle Falsa 123',
      enviarEmail: false, enviarWhatsapp: false,
    });
    chk('la factura se emite igual', 201, impostor.status);
    chk('pero con el CUIT del cliente, no el del pedido', CUIT_CLIENTE, impostor.json?.clienteCuit);
    chk('y con SU domicilio', 'Av. Siempre Viva 742', impostor.json?.clienteDireccion);

    tit('3. SIN CLIENTE CARGADO, LOS DATOS DEL PEDIDO SON LOS ÚNICOS QUE HAY');
    // Venta de mostrador: no hay ficha de dónde sacarlos, así que el cuerpo es
    // la única fuente y se sigue aceptando.
    const suelta = await vender({});
    const adHoc = await api('POST', '/api/invoices', {
      saleId: suelta.json.id, clienteCuit: CUIT_IMPOSTOR,
      clienteDireccion: 'Calle Falsa 123',
      enviarEmail: false, enviarWhatsapp: false,
    });
    chk('se emite con lo que vino en el pedido', CUIT_IMPOSTOR, adHoc.json?.clienteCuit);
    chk('y su domicilio', 'Calle Falsa 123', adHoc.json?.clienteDireccion);

    tit('4. LOS DOS MAILS: EL DEL CLIENTE Y LA COPIA DEL NEGOCIO');
    /*
     * Sin correo configurado los dos envíos se omiten, y eso es lo que hay que
     * comprobar: que se INTENTEN los dos y que ninguno rompa la emisión. La
     * factura ya tiene CAE cuando esto corre — un problema de correo no puede
     * deshacer un comprobante fiscal.
     */
    salida.length = 0;
    const venta3 = await vender({ clientId: cliente.id });
    const conMail = await api('POST', '/api/invoices', {
      saleId: venta3.json.id, enviarEmail: true, enviarWhatsapp: false,
    });
    chk('la factura se emite con los envíos pedidos', 201, conMail.status);

    await esperar(1200);   // los envíos no bloquean la respuesta
    const log = salida.join('');
    const omitidos = (log.match(/sin credenciales para la cuenta de envío/g) || []).length;
    chk('se intentaron los dos envíos, no uno', true, omitidos >= 2);
    chk('y la factura quedó emitida igual', 'emitida',
      (await Invoice.findOne({ where: { saleId: venta3.json.id } }))?.estado);

    tit('5. LA FACTURA SE QUEDA CON SU PROPIA COPIA DEL CLIENTE');
    /*
     * Se cambia la ficha DESPUÉS de emitir. El comprobante no puede cambiar:
     * es una foto del momento en que se emitió.
     */
    await cliente.update({ nombre: 'QA Cliente Renombrado', direccion: 'Otra dirección 999' });
    const guardada = await Invoice.findOne({ where: { saleId: venta.json.id } });
    chk('el nombre sigue siendo el de entonces', 'QA Cliente Facturado', guardada.clienteNombre);
    chk('y el domicilio también', 'Av. Siempre Viva 742', guardada.clienteDireccion);

  } finally {
    tit('Limpieza');
    for (const id of ventas) {
      const fs = await Invoice.findAll({ where: { saleId: id } });
      for (const f of fs) {
        await InvoiceItem.destroy({ where: { invoiceId: f.id } });
        await f.destroy();
      }
      await SalePayment.destroy({ where: { saleId: id } });
      await SaleItem.destroy({ where: { saleId: id } });
      await Sale.destroy({ where: { id } });
    }
    await StockMovement.destroy({ where: { productVariantId: v.id } });
    await VariantStock.destroy({ where: { productVariantId: v.id } });
    await ProductVariant.destroy({ where: { id: v.id } });
    await Product.destroy({ where: { id: prod.id } });
    await Client.destroy({ where: { id: cliente.id } });
    chk('no quedan facturas de prueba', 0, await Invoice.count({ where: { saleId: ventas } }));
    cerrar();
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
