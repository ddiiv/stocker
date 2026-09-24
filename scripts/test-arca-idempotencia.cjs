/*
 * Qué pasa cuando se corta la conexión justo al pedir el CAE.
 *
 * Es el peor momento posible para un corte, y no es raro: AFIP se cae seguido
 * y el pedido tarda segundos. Del lado de acá queda un error; del lado de AFIP
 * puede haber quedado un comprobante autorizado. Nadie sabe cuál de las dos.
 *
 * Reintentar a ciegas es lo que hace daño. El número siguiente se calcula
 * preguntando cuál fue el último autorizado: si AFIP sí lo autorizó, el
 * reintento pide el SIGUIENTE y el cliente termina con dos comprobantes
 * fiscales por una sola venta —y el primero, con su CAE, no queda registrado
 * en ningún lado—. Eso no se corrige después: es una factura emitida.
 *
 * Así que antes de dar el error por bueno se pregunta con FECompConsultar. Hay
 * tres finales y los tres importan:
 *
 *   · está y es el nuestro     → se adopta ese CAE, la venta queda facturada;
 *   · no está                  → se puede reintentar tranquilo, y se dice;
 *   · no se pudo preguntar     → no se sabe: lo mira una persona, no un
 *                                reintento automático.
 *
 * Uso:  node scripts/test-arca-idempotencia.cjs
 */
const path = require('path');
const Module = require('module');

/* Cómo se va a comportar AFIP en la próxima llamada. Lo maneja cada prueba. */
const AFIP = {
  ultimo: 23,
  /* 'ok' | 'corte' | 'rechazo' */
  solicitar: 'ok',
  /* Lo que contesta FECompConsultar: null = no existe. */
  comprobante: null,
  /* Si la consulta misma se cae. */
  consultaCae: false,
  llamadas: [],
};

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
          AFIP.llamadas.push('ultimo');
          return { data: `<FECompUltimoAutorizadoResult><PtoVta>8</PtoVta><CbteNro>${AFIP.ultimo}</CbteNro></FECompUltimoAutorizadoResult>` };
        }
        if (/FECompConsultar/.test(cuerpo)) {
          AFIP.llamadas.push('consultar');
          if (AFIP.consultaCae) throw new Error('socket hang up');
          const c = AFIP.comprobante;
          if (!c) {
            return { data: `<FECompConsultarResult><Errors><Err><Code>602</Code><Msg>No existen datos en nuestros registros para el criterio de busqueda ingresado.</Msg></Err></Errors></FECompConsultarResult>` };
          }
          return { data: `<FECompConsultarResult><ResultGet>
            <CbteDesde>${c.numero}</CbteDesde><CbteHasta>${c.numero}</CbteHasta>
            <PtoVta>8</PtoVta><CbteTipo>6</CbteTipo><CbteFch>${c.fecha}</CbteFch>
            <ImpTotal>${c.total}</ImpTotal><DocTipo>96</DocTipo><DocNro>${c.docNro}</DocNro>
            <Resultado>A</Resultado><CodAutorizacion>${c.cae}</CodAutorizacion><FchVto>20261130</FchVto>
          </ResultGet></FECompConsultarResult>` };
        }
        // FECAESolicitar
        AFIP.llamadas.push('solicitar');
        if (AFIP.solicitar === 'corte') throw new Error('timeout of 30000ms exceeded');
        if (AFIP.solicitar === 'rechazo') {
          return { data: `<FECAESolicitarResult><FeDetResp><FECAEDetResponse>
            <Resultado>R</Resultado></FECAEDetResponse></FeDetResp>
            <Errors><Err><Code>10016</Code><Msg>El numero o fecha del comprobante no se corresponde con el proximo a autorizar</Msg></Err></Errors>
          </FECAESolicitarResult>` };
        }
        const desde = (cuerpo.match(/<ar:CbteDesde>(\d+)</) || [])[1] || '0';
        return { data: `<FECAESolicitarResult>
          <FeCabResp><Resultado>A</Resultado></FeCabResp>
          <FeDetResp><FECAEDetResponse><CbteDesde>${desde}</CbteDesde><CbteHasta>${desde}</CbteHasta>
          <Resultado>A</Resultado><CAE>75000000000009</CAE><CAEFchVto>20261130</CAEFchVto>
          </FECAEDetResponse></FeDetResp></FECAESolicitarResult>` };
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

// Certificado de juguete: sólo tiene que existir para que la firma no falle.
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

process.env.ARCA_MOCK = 'false';
process.env.ARCA_CERT_B64_PROD = Buffer.from(forge.pki.certificateToPem(cert)).toString('base64');
process.env.ARCA_KEY_B64_PROD = Buffer.from(forge.pki.privateKeyToPem(par.privateKey)).toString('base64');
process.env.ARCA_STOCKER_CUIT = '20472979397';
require('dotenv').config({ path: __dirname + '/../.env' });
process.env.ARCA_MOCK = 'false';

const arca = require(path.join(__dirname, '..', 'src', 'services', 'arcaService.js'));
const cli = require(path.join(__dirname, '..', 'src', 'services', 'arcaClient.js'));

let ok = 0, ko = 0;
const chk = (t, esperado, obtuvo) => {
  const a = JSON.stringify(esperado), b = JSON.stringify(obtuvo);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const HOY = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const TOTAL = 121000;
const DOC = 30999999911;

const emitir = () => arca.solicitarCAE({
  tipo: 'B', total: TOTAL, clienteCuit: String(DOC), clienteCondicion: 'Consumidor Final',
  businessCuit: '30-99999991-1', puntoVenta: 8, ambiente: 'produccion',
});

const fallo = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

(async () => {
  tit('1. LO NORMAL NO CAMBIA');
  AFIP.solicitar = 'ok'; AFIP.llamadas = [];
  const normal = await emitir();
  chk('se pide el CAE y se devuelve', ['75000000000009', 24], [normal.cae, normal.numero]);
  chk('no se le pregunta nada de más a AFIP', ['ultimo', 'solicitar'], AFIP.llamadas);
  chk('y no figura como recuperado', false, normal.recuperado);

  tit('2. SE CORTÓ, Y AFIP NO LO HABÍA AUTORIZADO');
  /*
   * El final más común: el pedido no llegó. Lo único que hace falta es que el
   * error lo diga, para que reintentar sea una decisión y no una apuesta.
   */
  AFIP.solicitar = 'corte'; AFIP.comprobante = null; AFIP.llamadas = [];
  const sinAutorizar = await fallo(emitir);
  chk('se consulta antes de dar el error por bueno', ['ultimo', 'solicitar', 'consultar'], AFIP.llamadas);
  chk('el error dice que NO quedó autorizado', 'ARCA_SIN_AUTORIZAR', sinAutorizar?.codigo);
  chk('y que se puede reintentar', [true, 24], [sinAutorizar?.reintentable, sinAutorizar?.numeroIntentado]);
  /*
   * El manejador de errores del proyecto sólo deja pasar `detalles` a la
   * pantalla. Sin eso, el front no puede decidir si ofrecer «reintentar» o
   * mandar a mirar en AFIP: le llega un texto y nada más.
   */
  chk('y la pantalla lo puede leer, no sólo el texto',
    { codigo: 'ARCA_SIN_AUTORIZAR', reintentable: true, numeroIntentado: 24 }, sinAutorizar?.detalles);

  tit('3. SE CORTÓ, PERO AFIP SÍ LO HABÍA AUTORIZADO');
  /*
   * Acá está el daño que esto evita: sin consultar, el reintento pediría el
   * número 25 y el cliente terminaría con dos comprobantes por una venta.
   */
  AFIP.solicitar = 'corte'; AFIP.llamadas = [];
  AFIP.comprobante = { numero: 24, total: TOTAL, docNro: DOC, fecha: HOY, cae: '75000000000024' };
  const rescatado = await emitir();
  chk('se adopta el CAE que AFIP ya había emitido', '75000000000024', rescatado.cae);
  chk('con su número, que es el que se pidió', 24, rescatado.numero);
  chk('queda marcado como recuperado', true, rescatado.recuperado);
  chk('y eso queda guardado en la respuesta de ARCA', true, rescatado.respuesta.recuperado);
  chk('no se pidió un CAE nuevo', 1, AFIP.llamadas.filter((l) => l === 'solicitar').length);

  tit('4. EL NÚMERO ESTÁ, PERO NO ES EL NUESTRO');
  /*
   * Otra caja facturó con ese número mientras se emitía. Adoptar ese CAE
   * pegaría nuestra venta a la factura de otro: es peor que el error.
   */
  AFIP.solicitar = 'corte'; AFIP.llamadas = [];
  AFIP.comprobante = { numero: 24, total: 999, docNro: 20111111112, fecha: HOY, cae: '75000000000099' };
  const ajeno = await fallo(emitir);
  chk('no se adopta un comprobante ajeno', 'ARCA_NUMERO_OCUPADO', ajeno?.codigo);
  chk('y no se ofrece reintentar solo', false, ajeno?.reintentable);
  chk('el mensaje trae los tres datos con los que se busca en AFIP', true,
    /punto de venta 8/.test(String(ajeno?.message))
    && /tipo 6/.test(String(ajeno?.message))
    && /número 24/.test(String(ajeno?.message)));

  tit('5. NO SE PUDO PREGUNTAR');
  /*
   * El peor final: no se sabe. Es el único caso en el que la respuesta correcta
   * es "que lo mire una persona": un reintento automático acá es exactamente
   * cómo se duplica una factura.
   */
  AFIP.solicitar = 'corte'; AFIP.comprobante = null; AFIP.consultaCae = true; AFIP.llamadas = [];
  const incierto = await fallo(emitir);
  AFIP.consultaCae = false;
  chk('se avisa que no se sabe', 'ARCA_INCIERTO', incierto?.codigo);
  chk('y que NO se reintente solo', false, incierto?.reintentable);
  chk('la pantalla recibe el comprobante para mostrarlo',
    { ptoVta: 8, cbteTipo: 6, numero: 24 }, incierto?.detalles?.comprobante);
  chk('con los tres datos para buscarlo a mano', true,
    /punto de venta 8/.test(String(incierto?.message))
    && /tipo 6/.test(String(incierto?.message))
    && /número 24/.test(String(incierto?.message)));

  tit('6. UN RECHAZO DE AFIP NO ES UN CORTE');
  /*
   * Si AFIP contestó que no, el comprobante no existe y no hay nada que
   * consultar. Preguntar igual sería una llamada de más en cada error de
   * validación —y hay muchos— y taparía el mensaje real.
   */
  AFIP.solicitar = 'rechazo'; AFIP.comprobante = null; AFIP.llamadas = [];
  const rechazo = await fallo(emitir);
  chk('no se consulta', false, AFIP.llamadas.includes('consultar'));
  chk('y se ve el motivo que dio AFIP', true, /10016/.test(String(rechazo?.message)));

  tit('7. LEER LO QUE CONTESTA FECompConsultar');
  const existe = cli.__parsearComprobante(`<FECompConsultarResult><ResultGet>
    <CbteDesde>24</CbteDesde><PtoVta>8</PtoVta><CbteTipo>6</CbteTipo><CbteFch>20260924</CbteFch>
    <ImpTotal>121000</ImpTotal><DocNro>30999999911</DocNro>
    <Resultado>A</Resultado><CodAutorizacion>75000000000024</CodAutorizacion><FchVto>20261130</FchVto>
  </ResultGet></FECompConsultarResult>`);
  chk('un comprobante que existe trae su CAE y su vencimiento',
    ['75000000000024', '2026-11-30', 121000], [existe.CAE, existe.CAEFchVto, existe.ImpTotal]);

  chk('"no existen datos" es null y no un error', null, cli.__parsearComprobante(
    '<FECompConsultarResult><Errors><Err><Code>602</Code><Msg>No existen datos</Msg></Err></Errors></FECompConsultarResult>',
  ));

  /*
   * Cualquier otro error SÍ se levanta: no saber si existe es distinto de
   * saber que no existe, y confundirlos es volver al problema de raíz.
   */
  const otroError = (() => {
    try {
      cli.__parsearComprobante('<FECompConsultarResult><Errors><Err><Code>600</Code><Msg>Token invalido</Msg></Err></Errors></FECompConsultarResult>');
      return null;
    } catch (e) { return e.message; }
  })();
  chk('un error distinto no se lee como "no existe"', true, /600/.test(String(otroError)));

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
