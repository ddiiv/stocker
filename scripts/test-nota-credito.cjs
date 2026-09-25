/*
 * Notas de crédito: la única forma de revertir una factura con CAE.
 *
 * Hasta ahora el sistema decía "hace falta una nota de crédito" en dos lugares
 * y no había ninguna forma de emitirla: una factura mal hecha quedaba sin
 * salida. Lo que se prueba es lo que duele si sale mal, que en un comprobante
 * fiscal es todo:
 *
 *   · Que se pueda guardar. Había un único sobre saleId de cuando el único
 *     comprobante posible era una factura: con él, la nota reventaba al
 *     insertar DESPUÉS de haber quemado el CAE en AFIP.
 *   · Que no se acredite de más. AFIP no controla que las notas no excedan a
 *     la factura: dos notas por el total salen las dos bien y quedan las dos
 *     autorizadas.
 *   · Que apunte a la factura correcta (CbtesAsoc) y con su misma letra.
 *   · Que lo que no es una factura no se pueda "anular" marcándolo en la base.
 *
 * AFIP está simulado: lo que importa es lo que VA en el pedido y lo que queda
 * en la base, no la respuesta.
 *
 * Uso:  node scripts/test-nota-credito.cjs
 */
const path = require('path');
const Module = require('module');

const AFIP = { ultimo: 40, pedidos: [] };

const originalLoad = Module._load;
Module._load = function (pedido) {
  if (pedido === 'axios') {
    return {
      post: async (url, cuerpo) => {
        if (/LoginCms/.test(url)) {
          const vence = new Date(Date.now() + 11 * 3600e3).toISOString();
          return { data: `<loginCmsReturn>&lt;loginTicketResponse&gt;&lt;header&gt;&lt;expirationTime&gt;${vence}&lt;/expirationTime&gt;&lt;/header&gt;&lt;credentials&gt;&lt;token&gt;TOKEN&lt;/token&gt;&lt;sign&gt;SIGN&lt;/sign&gt;&lt;/credentials&gt;&lt;/loginTicketResponse&gt;</loginCmsReturn>` };
        }
        if (/FECompUltimoAutorizado/.test(cuerpo)) {
          return { data: `<FECompUltimoAutorizadoResult><PtoVta>8</PtoVta><CbteNro>${AFIP.ultimo}</CbteNro></FECompUltimoAutorizadoResult>` };
        }
        if (/FECompConsultar/.test(cuerpo)) {
          return { data: '<FECompConsultarResult><Errors><Err><Code>602</Code><Msg>No existen datos</Msg></Err></Errors></FECompConsultarResult>' };
        }
        AFIP.pedidos.push(cuerpo);
        const desde = (cuerpo.match(/<ar:CbteDesde>(\d+)</) || [])[1] || '0';
        return { data: `<FECAESolicitarResult>
          <FeCabResp><Resultado>A</Resultado></FeCabResp>
          <FeDetResp><FECAEDetResponse><CbteDesde>${desde}</CbteDesde><CbteHasta>${desde}</CbteHasta>
          <Resultado>A</Resultado><CAE>7500000000${String(desde).padStart(4, '0')}</CAE><CAEFchVto>20261231</CAEFchVto>
          </FECAEDetResponse></FeDetResp></FECAESolicitarResult>` };
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

const forge = require('node-forge');
const par = forge.pki.rsa.generateKeyPair(1024);
const certificado = forge.pki.createCertificate();
certificado.publicKey = par.publicKey;
certificado.serialNumber = '01';
certificado.validity.notBefore = new Date();
certificado.validity.notAfter = new Date(Date.now() + 86400e3);
certificado.setSubject([{ name: 'commonName', value: 'test' }]);
certificado.setIssuer([{ name: 'commonName', value: 'test' }]);
certificado.sign(par.privateKey);

process.env.ARCA_MOCK = 'false';
process.env.ARCA_CERT_B64_PROD = Buffer.from(forge.pki.certificateToPem(certificado)).toString('base64');
process.env.ARCA_KEY_B64_PROD = Buffer.from(forge.pki.privateKeyToPem(par.privateKey)).toString('base64');
process.env.ARCA_STOCKER_CUIT = '20472979397';
require('dotenv').config({ path: __dirname + '/../.env' });
process.env.ARCA_MOCK = 'false';

const { Op } = require('sequelize');
const { Business, Invoice, InvoiceItem, Sale, ArcaIntento } = require(path.join(__dirname, '..', 'src', 'models'));
const notas = require(path.join(__dirname, '..', 'src', 'services', 'notaCreditoService.js'));

let ok = 0, ko = 0;
const chk = (t, esperado, obtuvo) => {
  const a = JSON.stringify(esperado), b = JSON.stringify(obtuvo);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const fallo = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const QA = 'QA-NC-';

(async () => {
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } })
    || await Business.findOne({ order: [['id', 'ASC']] });
  /*
   * Una venta por factura: el único parcial no deja dos facturas de la misma
   * venta, que es justamente lo que tiene que seguir protegiendo.
   */
  const ventas = await Sale.findAll({ where: { businessId: negocio.id }, order: [['id', 'DESC']], limit: 10 });
  if (ventas.length < 8) { console.log('Hacen falta al menos 8 ventas en', negocio.nombreNegocio); process.exit(1); }
  let proxima = 0;
  const venta = ventas[0];

  const limpiar = async () => {
    const filas = await Invoice.findAll({ where: { numero: { [Op.like]: `${QA}%` } }, attributes: ['id'] });
    if (filas.length) {
      await InvoiceItem.destroy({ where: { invoiceId: filas.map((f) => f.id) } });
      await ArcaIntento.update({ invoiceId: null }, { where: { invoiceId: filas.map((f) => f.id) } });
      await Invoice.destroy({ where: { id: filas.map((f) => f.id) } });
    }
    await ArcaIntento.destroy({ where: { cuitEmisor: '30999999911' } });
  };
  await limpiar();

  /* Una factura como la que deja el circuito real, con sus coordenadas de AFIP. */
  let serie = 0;
  const crearFactura = async (extra = {}) => {
    const suya = ventas[proxima++ % ventas.length];
    const f = await Invoice.create({
      businessId: negocio.id, saleId: suya.id, numero: `${QA}${Date.now() % 10000}-${serie++}`,
      tipo: 'B', clase: 'factura',
      clienteNombre: 'QA Cliente', clienteCuit: '30999999911',
      subtotal: 100000, iva: 21000, total: 121000,
      cae: '75000000000040', caeVencimiento: '2026-12-31',
      ambiente: 'produccion', simulado: false,
      emisorCuit: '30-99999991-1', emisorNombre: 'QA Emisor',
      ptoVtaArca: 8, cbteNroArca: 40, cbteTipoArca: 6, cbteFchArca: '20260925',
      ...extra,
    });
    await InvoiceItem.create({
      invoiceId: f.id, titulo: 'Remera QA', sku: 'QA-1', cantidad: 2,
      precioUnitario: 60500, subtotal: 121000,
    });
    return f;
  };

  try {
    tit('1. LA NOTA SE PUEDE GUARDAR');
    /*
     * Había un único sobre saleId de cuando el único comprobante posible era
     * una factura. Con él, la nota reventaba al insertar DESPUÉS de haber
     * quemado el CAE en AFIP: un comprobante fiscal emitido que el sistema no
     * registra.
     */
    const factura = await crearFactura();
    AFIP.pedidos = [];
    const nota = await notas.emitirNota({
      businessId: negocio.id, facturaId: factura.id, motivo: 'Devolución completa',
    });
    chk('queda guardada, con la misma venta que la factura', [factura.saleId, 'nota_credito'],
      [nota.saleId, nota.clase]);
    chk('con su CAE y apuntando a la factura', [true, factura.id],
      [Boolean(nota.cae), nota.facturaAsociadaId]);
    chk('por el total de la factura', 121000, Number(nota.total));

    tit('2. LO QUE VIAJA A AFIP');
    const pedido = AFIP.pedidos.at(-1) || '';
    chk('el tipo de comprobante es nota de crédito B, no factura B', true,
      /<ar:CbteTipo>8<\/ar:CbteTipo>/.test(pedido));
    /*
     * CbtesAsoc es lo único que hace que una nota sea una nota: sin eso es un
     * comprobante suelto que no revierte nada.
     */
    chk('lleva el comprobante asociado, con sus tres datos', true,
      /<ar:CbtesAsoc>[\s\S]*<ar:CbteAsoc>[\s\S]*<ar:Tipo>6<\/ar:Tipo>[\s\S]*<ar:PtoVta>8<\/ar:PtoVta>[\s\S]*<ar:Nro>40<\/ar:Nro>/.test(pedido));
    chk('y va antes del nodo Iva, como pide el orden del XSD', true,
      pedido.indexOf('<ar:CbtesAsoc>') > 0 && pedido.indexOf('<ar:CbtesAsoc>') < pedido.indexOf('<ar:Iva>'));

    tit('3. NO SE PUEDE ACREDITAR DE MÁS');
    /*
     * AFIP no controla esto: dos notas por el total salen las dos bien y quedan
     * las dos autorizadas. Revertir eso necesita una nota de débito.
     */
    const segunda = await fallo(() => notas.emitirNota({
      businessId: negocio.id, facturaId: factura.id, motivo: 'Otra vez',
    }));
    chk('una factura ya acreditada no admite otra nota', 'FACTURA_ACREDITADA', segunda?.codigo);

    const factura2 = await crearFactura();
    await notas.emitirNota({
      businessId: negocio.id, facturaId: factura2.id, total: 100000, motivo: 'Devolución parcial',
    });
    const saldo = await notas.saldoParaNotas(factura2.id);
    chk('una nota parcial deja el resto disponible', [121000, 100000, 21000],
      [saldo.total, saldo.acreditado, saldo.disponible]);

    const pasada = await fallo(() => notas.emitirNota({
      businessId: negocio.id, facturaId: factura2.id, total: 30000, motivo: 'Me paso',
    }));
    chk('y no se puede pasar de lo que queda', 'EXCEDE_FACTURA', pasada?.codigo);
    chk('el error dice cuánto queda', 21000, pasada?.detalles?.disponible);

    const justa = await notas.emitirNota({
      businessId: negocio.id, facturaId: factura2.id, total: 21000, motivo: 'El resto',
    });
    chk('lo que queda justo sí entra', 21000, Number(justa.total));

    tit('4. LO QUE NO SE PUEDE EMITIR');
    const paraElMotivo = await crearFactura({ numero: `${QA}mot` });
    const sinMotivo = await fallo(() => notas.emitirNota({
      businessId: negocio.id, facturaId: paraElMotivo.id, motivo: '  ',
    }));
    chk('una nota sin motivo', 400, sinMotivo?.status);

    const sinCae = await crearFactura({ cae: null, numero: `${QA}sincae` });
    const deBorrador = await fallo(() => notas.emitirNota({
      businessId: negocio.id, facturaId: sinCae.id, motivo: 'No hay nada que revertir',
    }));
    chk('una factura sin CAE: no hay nada que revertir en AFIP', 409, deBorrador?.status);

    const vieja = await crearFactura({ numero: `${QA}vieja`, ptoVtaArca: null, cbteNroArca: null, cbteTipoArca: null });
    const sinCoordenadas = await fallo(() => notas.emitirNota({
      businessId: negocio.id, facturaId: vieja.id, motivo: 'De antes',
    }));
    chk('una factura sin coordenadas de AFIP no se puede asociar', 'FACTURA_SIN_COORDENADAS',
      sinCoordenadas?.codigo);

    const ajena = await fallo(() => notas.emitirNota({
      businessId: negocio.id + 99999, facturaId: factura.id, motivo: 'De otro negocio',
    }));
    chk('una factura de otro negocio', 404, ajena?.status);

    tit('5. LOS RENGLONES');
    const factura3 = await crearFactura({ numero: `${QA}reng` });
    const total3 = await notas.emitirNota({
      businessId: negocio.id, facturaId: factura3.id, motivo: 'Devuelve todo',
    });
    const renglonesTotal = await InvoiceItem.findAll({ where: { invoiceId: total3.id } });
    chk('una nota total copia los renglones de la factura', ['Remera QA', 2],
      [renglonesTotal[0]?.titulo, renglonesTotal[0]?.cantidad]);

    const factura4 = await crearFactura({ numero: `${QA}parc` });
    const parcial = await notas.emitirNota({
      businessId: negocio.id, facturaId: factura4.id, total: 50000, motivo: 'Faltó un talle',
    });
    const renglonesParcial = await InvoiceItem.findAll({ where: { invoiceId: parcial.id } });
    /*
     * Una parcial no puede copiar los renglones: no cerrarían con el importe, y
     * un comprobante impreso cuyo detalle no suma el total es un problema.
     */
    chk('una parcial lleva una sola línea con el motivo', [1, 50000],
      [renglonesParcial.length, Number(renglonesParcial[0]?.subtotal)]);
    chk('y el motivo se ve en el renglón', true,
      String(renglonesParcial[0]?.titulo || '').includes('Faltó un talle'));

    tit('6. LA NOTA HEREDA, NO RECALCULA');
    /*
     * La letra, el emisor, el punto de venta y el ambiente son los del
     * comprobante que se revierte. Recalcularlos sería emitir otro comprobante
     * distinto que casualmente lleva un CbtesAsoc apuntando a la factura vieja.
     */
    chk('la letra es la de la factura', 'B', parcial.tipo);
    chk('el emisor y el ambiente también', ['30-99999991-1', 'produccion'],
      [parcial.emisorCuit, parcial.ambiente]);
    chk('y sale del mismo punto de venta', 8, parcial.ptoVtaArca);
  } finally {
    tit('Limpieza');
    await limpiar();
    chk('no queda nada de la prueba', 0,
      await Invoice.count({ where: { numero: { [Op.like]: `${QA}%` } } }));
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
