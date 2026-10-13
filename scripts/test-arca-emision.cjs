/*
 * Emisión de un comprobante de punta a punta, con AFIP simulado.
 *
 * No llama a AFIP: intercepta el transporte y contesta lo que contestaría el
 * servicio real. Lo que se prueba es lo que va EN el pedido —letra, IVA,
 * condición del receptor, numeración— porque eso es lo que queda escrito en un
 * comprobante fiscal y no se puede corregir después.
 *
 * Uso:  node scripts/test-arca-emision.cjs
 */
const path = require('path');
const Module = require('module');

let ULTIMO_NRO = 23;
let PEDIDOS = [];

const originalLoad = Module._load;
Module._load = function (pedido) {
  if (pedido === 'axios') {
    return {
      post: async (url, cuerpo) => {
        PEDIDOS.push(cuerpo);
        if (/LoginCms/.test(url)) {
          const vence = new Date(Date.now() + 11 * 3600e3).toISOString();
          return { data: `<loginCmsReturn>&lt;loginTicketResponse&gt;&lt;header&gt;&lt;expirationTime&gt;${vence}&lt;/expirationTime&gt;&lt;/header&gt;&lt;credentials&gt;&lt;token&gt;TOKEN&lt;/token&gt;&lt;sign&gt;SIGN&lt;/sign&gt;&lt;/credentials&gt;&lt;/loginTicketResponse&gt;</loginCmsReturn>` };
        }
        if (/FECompUltimoAutorizado/.test(cuerpo)) {
          return { data: `<FECompUltimoAutorizadoResult><PtoVta>8</PtoVta><CbteNro>${ULTIMO_NRO}</CbteNro></FECompUltimoAutorizadoResult>` };
        }
        // FECAESolicitar: se devuelve el número que vino pedido.
        const desde = (cuerpo.match(/<ar:CbteDesde>(\d+)</) || [])[1] || '0';
        return { data: `<FECAESolicitarResult>
          <FeCabResp><Resultado>A</Resultado></FeCabResp>
          <FeDetResp><FECAEDetResponse><CbteDesde>${desde}</CbteDesde><CbteHasta>${desde}</CbteHasta>
          <Resultado>A</Resultado><CAE>75000000000001</CAE><CAEFchVto>20260828</CAEFchVto>
          </FECAEDetResponse></FeDetResp></FECAESolicitarResult>` };
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

// Certificado y clave de juguete: sólo tienen que existir para que firme.
const forge = require('node-forge');
const par = forge.pki.rsa.generateKeyPair(1024);
const cert = forge.pki.createCertificate();
cert.publicKey = par.publicKey;
cert.serialNumber = '01';
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date(Date.now() + 86400e3);
cert.setSubject([{ name: 'commonName', value: 'test' }]);
cert.setIssuer([{ name: 'commonName', value: 'test' }]);
cert.sign(par.privateKey);
const CERT = forge.pki.certificateToPem(cert);
const KEY = forge.pki.privateKeyToPem(par.privateKey);

process.env.ARCA_MOCK = 'false';
process.env.ARCA_CERT_B64_PROD = Buffer.from(CERT).toString('base64');
process.env.ARCA_KEY_B64_PROD = Buffer.from(KEY).toString('base64');
process.env.ARCA_STOCKER_CUIT = '20472979397';
require('dotenv').config({ path: __dirname + '/../.env' });
process.env.ARCA_MOCK = 'false';

const arca = require(path.join(__dirname, '..', 'src', 'services', 'arcaService.js'));

let ok = 0, ko = 0;
const chk = (t, esperado, obtuvo) => {
  const a = JSON.stringify(esperado), b = JSON.stringify(obtuvo);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

// Lee un campo del último FECAESolicitar enviado.
const enviado = (campo) => {
  const req = PEDIDOS.filter((p) => /FECAESolicitar/.test(p)).pop() || '';
  const v = (req.match(new RegExp(`<ar:${campo}>([^<]*)<`)) || [])[1];
  return v === undefined ? null : v;
};

(async () => {
  tit('1. MONOTRIBUTISTA A CONSUMIDOR FINAL — factura C, sin IVA');
  PEDIDOS = [];
  let r = await arca.solicitarCAE({
    tipo: 'C', total: 24900, clienteCuit: null, clienteCondicion: 'Consumidor Final',
    businessCuit: '27928813415', puntoVenta: 8, ambiente: 'produccion',
  });
  chk('devuelve el CAE',        '75000000000001', r.cae);
  chk('vencimiento con guiones',   '2026-08-28', r.caeVencimiento);
  chk('numera después del último',           24, r.numero);
  chk('tipo 11 (factura C)',               '11', enviado('CbteTipo'));
  chk('el neto es el total',            '24900', enviado('ImpNeto'));
  chk('IVA en cero',                        '0', enviado('ImpIVA'));
  chk('total sin tocar',                '24900', enviado('ImpTotal'));
  chk('receptor consumidor final',          '5', enviado('CondicionIVAReceptorId'));
  chk('doc tipo 99 (sin identificar)',     '99', enviado('DocTipo'));
  chk('sin objeto Iva',                    true, !/<ar:AlicIva>/.test(PEDIDOS.filter((p) => /FECAESolicitar/.test(p)).pop()));

  tit('2. MONOTRIBUTISTA A UN CUIT — sigue siendo C');
  PEDIDOS = [];
  await arca.solicitarCAE({
    tipo: 'C', total: 10000, clienteCuit: '20111111112', clienteCondicion: 'Responsable Inscripto',
    businessCuit: '27928813415', puntoVenta: 8, ambiente: 'produccion',
  });
  chk('tipo 11',                    '11', enviado('CbteTipo'));
  chk('IVA en cero',                 '0', enviado('ImpIVA'));
  chk('doc tipo 80 (CUIT)',         '80', enviado('DocTipo'));
  chk('receptor inscripto',          '1', enviado('CondicionIVAReceptorId'));

  tit('3. RESPONSABLE INSCRIPTO — factura A con IVA discriminado');
  PEDIDOS = [];
  await arca.solicitarCAE({
    tipo: 'A', total: 12100, clienteCuit: '20111111112', clienteCondicion: 'Responsable Inscripto',
    businessCuit: '30111111117', puntoVenta: 8, ambiente: 'produccion',
  });
  chk('tipo 1 (factura A)',   '1', enviado('CbteTipo'));
  chk('neto sin IVA',     '10000', enviado('ImpNeto'));
  chk('IVA 21%',           '2100', enviado('ImpIVA'));
  chk('total = neto + IVA','12100', enviado('ImpTotal'));
  chk('lleva la alícuota', true, /<ar:AlicIva>/.test(PEDIDOS.filter((p) => /FECAESolicitar/.test(p)).pop()));

  tit('4. NUMERACIÓN — sigue a AFIP, no al sistema');
  ULTIMO_NRO = 0;
  const nueva = await arca.solicitarCAE({
    tipo: 'C', total: 100, clienteCuit: null, businessCuit: '27928813415', puntoVenta: 8, ambiente: 'produccion',
  });
  chk('un punto de venta sin facturas arranca en 1', 1, nueva.numero);
  ULTIMO_NRO = 999;
  const seguida = await arca.solicitarCAE({
    tipo: 'C', total: 100, clienteCuit: null, businessCuit: '27928813415', puntoVenta: 8, ambiente: 'produccion',
  });
  chk('y sigue el que AFIP tenga', 1000, seguida.numero);

  tit('5. FALTA DE DATOS — corta antes de emitir');
  const falla = async (args) => { try { await arca.solicitarCAE(args); return null; } catch (e) { return e.message; } };
  chk('sin punto de venta', true, /puntoVenta/.test(await falla({ tipo: 'C', total: 1, businessCuit: '27928813415', ambiente: 'produccion' }) || ''));
  chk('sin CUIT emisor',    true, /businessCuit/.test(await falla({ tipo: 'C', total: 1, puntoVenta: 8, ambiente: 'produccion' }) || ''));

  tit('6. LA FECHA DEL COMPROBANTE ES LA DE ARGENTINA');
  /*
   * El servidor corre en UTC. Con el día sacado de `toISOString()`, una venta
   * de las 23:30 de acá se le declaraba a ARCA con la fecha de mañana. Se
   * detiene el reloj en ese instante y se mira qué CbteFch sale en el pedido.
   */
  const RealDate = Date;
  const conReloj = async (iso, fn) => {
    const fijo = new RealDate(iso).getTime();
    global.Date = class extends RealDate {
      constructor(...a) { super(...(a.length ? a : [fijo])); }
      static now() { return fijo; }
    };
    try { return await fn(); } finally { global.Date = RealDate; }
  };
  const ventaB = { tipo: 'B', total: 1210, clienteCuit: null, businessCuit: '30111111117', puntoVenta: 8, ambiente: 'produccion' };
  PEDIDOS = [];
  const deNoche = await conReloj('2026-10-13T02:30:00Z', () => arca.solicitarCAE(ventaB));
  chk('una venta de las 23:30 de Argentina va con la fecha de ese día', '20261012', enviado('CbteFch'));
  chk('y es la que se devuelve para guardar e imprimir', '20261012', deNoche.cbteFch);
  PEDIDOS = [];
  await conReloj('2026-10-13T03:30:00Z', () => arca.solicitarCAE(ventaB));
  chk('pasada la medianoche de acá ya es el día siguiente', '20261013', enviado('CbteFch'));

  tit('7. LA CONDICIÓN DEL RECEPTOR SE DEVUELVE, Y UNA NOTA USA LA DE SU FACTURA');
  PEDIDOS = [];
  const normal = await arca.solicitarCAE(ventaB);
  chk('se devuelve lo que se declaró, para guardarlo en la factura', 5, normal.condicionIvaReceptorId);
  PEDIDOS = [];
  const nota = await arca.solicitarCAE({
    ...ventaB, clase: 'nota_credito', clienteCuit: '20111111112', clienteCondicion: null,
    condicionReceptorId: 6,
    asociada: { cbteTipo: 6, ptoVta: 8, numero: 5, fecha: '20261012', cuit: '30111111117' },
  });
  chk('la nota declara al receptor como lo declaró su factura (6)', '6', enviado('CondicionIVAReceptorId'));
  chk('y lo devuelve', 6, nota.condicionIvaReceptorId);
  PEDIDOS = [];
  await arca.solicitarCAE({ ...ventaB, clienteCuit: '20111111112', clienteCondicion: null });
  chk('sin condición guardada se calcula como siempre (5)', '5', enviado('CondicionIVAReceptorId'));

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
