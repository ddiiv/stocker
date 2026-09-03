/*
 * El diagnóstico de la delegación de AFIP.
 *
 * El error 600 —"No apareció CUIT en lista de relaciones"— es el que más tiempo
 * hace perder de todo el circuito de facturación, porque no dice de quién a
 * quién falta la relación ni de qué lado está el problema. Y son dos problemas
 * distintos con arreglos opuestos:
 *
 *   · Falta la relación DE ESTE CLIENTE. Se arregla en el AFIP del cliente, en
 *     nombre del cliente, y el certificado no tiene nada que ver.
 *   · No anda NUESTRO certificado. Se arregla de nuestro lado, y mandar al
 *     cliente a rehacer su trámite le hace perder el día por nada.
 *
 * Se distinguen preguntando lo mismo por el CUIT de Stocker, que no necesita
 * delegación de nadie. Esta suite comprueba que la distinción se haga bien y
 * que cada caso mande a hacer el trámite que corresponde.
 *
 * Uso:  node scripts/test-arca-delegacion.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const Module = require('module');

/*
 * Se intercepta axios antes de cargar el servicio, igual que en
 * test-arca-ptosventa: se prueba la función que corre en producción, no una
 * gemela escrita en el test. La cola permite que la primera llamada —la del
 * cliente— y la segunda —la de control, por el CUIT de Stocker— devuelvan
 * cosas distintas, que es justamente lo que el diagnóstico compara.
 */
let COLA = [];

/*
 * El WSAA se contesta con un TA de mentira.
 *
 * Antes que el WSFE, el cliente pide un ticket de acceso firmando con el
 * certificado. Sin responder esa llamada, todo termina en "no vino
 * loginCmsReturn" y nunca se llega a lo que se quiere probar. El TA no se
 * valida contra nadie: sólo tiene que parsearse.
 */
const TA_FALSO = `<?xml version="1.0"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>
 <loginCmsResponse><loginCmsReturn>&lt;loginTicketResponse&gt;&lt;credentials&gt;`
  + `&lt;token&gt;TOKEN-QA&lt;/token&gt;&lt;sign&gt;SIGN-QA&lt;/sign&gt;`
  + `&lt;/credentials&gt;&lt;/loginTicketResponse&gt;</loginCmsReturn></loginCmsResponse>
</soapenv:Body></soapenv:Envelope>`;

const originalLoad = Module._load;
Module._load = function (pedido) {
  if (pedido === 'axios') {
    return {
      post: async (url) => {
        if (String(url).includes('LoginCms')) return { data: TA_FALSO };
        return { data: COLA.length > 1 ? COLA.shift() : COLA[0] };
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

process.env.ARCA_MOCK = 'false';
process.env.ARCA_STOCKER_CUIT = process.env.ARCA_STOCKER_CUIT || '20472979397';

const arca = require('../src/services/arcaService');
const email = require('../src/services/emailService');
const tokenStore = require('../src/services/arcaTokenStore');

let ok = 0, ko = 0;
const chk = (t, esperado, obtuvo) => {
  const a = JSON.stringify(esperado), b = JSON.stringify(obtuvo);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const sobre = (adentro) => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
 <soap:Body><FEParamGetPtosVentaResponse xmlns="http://ar.gov.afip.dif.FEV1/">
  <FEParamGetPtosVentaResult>${adentro}</FEParamGetPtosVentaResult>
 </FEParamGetPtosVentaResponse></soap:Body></soap:Envelope>`;

const SIN_RELACION = sobre(
  '<Errors><Err><Code>600</Code><Msg>ValidacionDeToken: No aparecio CUIT en lista de relaciones: 23929816439</Msg></Err></Errors>',
);
const CON_PUNTOS = sobre(
  '<ResultGet><PtoVenta><Nro>8</Nro><EmisionTipo>CAE</EmisionTipo>'
  + '<Bloqueado>N</Bloqueado><FchBaja>NULL</FchBaja></PtoVenta></ResultGet>',
);

const CLIENTE = '23929816439';

(async () => {
  /*
   * El TA se cachea en la base por CUIT+ambiente+servicio. Sin saltearlo, la
   * segunda corrida usaría el guardado y no pasaría por el axios de mentira.
   */
  tokenStore.obtener = async () => null;
  tokenStore.guardar = async () => {};

  try {
    tit('1. EL CERTIFICADO ANDA — falta la relación de ESTE cliente');
    /*
     * Primera llamada (el cliente): 600. Segunda (Stocker por sí mismo): anda.
     * Es el caso normal y el que hay que saber separar: el trámite es del
     * cliente y nuestro certificado no se toca.
     */
    COLA = [SIN_RELACION, CON_PUNTOS];
    const r1 = await arca.verifyDelegation({ businessCuit: CLIENTE, ambiente: 'produccion' });

    chk('no queda listo para facturar', false, r1.listoParaFacturar);
    chk('y se reconoce que el certificado propio sí anda', 'anda', r1.certificadoPropio);
    chk('el aviso lo dice, para no mandar a revisar el certificado', true,
      /certificado de Stocker sí factura por su propio CUIT/i.test(r1.hint || ''));
    chk('nombra las dos puntas y el ambiente', true,
      new RegExp(`${CLIENTE}.*produccion`).test(r1.hint || ''));

    /*
     * La cuarta causa es la que queda cuando el cliente ya hizo las tres
     * primeras: la relación se creó en nombre propio en vez de en nombre del
     * cliente. La pantalla de AFIP se ve igual en los dos casos, así que sin
     * decirlo nadie lo encuentra.
     */
    chk('están las cuatro causas', 4, (r1.causas || []).length);
    chk('y la cuarta es la de "en nombre de"', true,
      /Actuar en nombre de/i.test((r1.causas || []).join(' ')));

    tit('2. EL CERTIFICADO NO ANDA — el trámite es nuestro');
    /*
     * Las dos llamadas fallan: el problema no es la delegación del cliente.
     * Mandarlo a rehacer su trámite sería hacerle perder el día por algo que
     * no está de su lado.
     */
    COLA = [SIN_RELACION, SIN_RELACION];
    const r2 = await arca.verifyDelegation({ businessCuit: CLIENTE, ambiente: 'produccion' });

    chk('se reconoce que el propio también falla', 'falla', r2.certificadoPropio);
    chk('el aviso avisa que no es del cliente', true,
      /tampoco factura por su propio CUIT/i.test(r2.hint || ''));
    chk('y las causas apuntan a nuestro lado', true,
      /no hace falta que el cliente toque nada/i.test((r2.causas || []).join(' ')));
    chk('sin repetir las causas del cliente', false,
      /Actuar en nombre de/i.test((r2.causas || []).join(' ')));

    tit('3. CUANDO ANDA, NO HAY DIAGNÓSTICO QUE DAR');
    COLA = [CON_PUNTOS];
    const r3 = await arca.verifyDelegation({ businessCuit: CLIENTE, ambiente: 'produccion' });
    chk('queda listo para facturar', true, r3.listoParaFacturar);
    chk('sin causas', undefined, r3.causas);
    chk('y sin la consulta de control, que sólo se hace al fallar', undefined, r3.certificadoPropio);

    tit('4. EL AVISO AL BACKOFFICE NO ROMPE NADA');
    /*
     * Sin correo configurado tiene que devolver el motivo y no explotar: el
     * aviso es un extra, y el cliente necesita ver su diagnóstico igual.
     *
     * Las credenciales de envío se vacían a propósito antes de llamar. La
     * primera versión de esta prueba mandaba un mail de verdad a la casilla de
     * soporte en cada corrida: una suite que se corre veinte veces por día no
     * puede escribirle a nadie. Lo que se prueba acá es que la función devuelva
     * un motivo en vez de tirar, y eso se ve mejor justamente sin correo.
     */
    const correo = require('../src/config/correo');
    const cuenta = correo.CUENTAS[correo.CUENTA_ENVIO];
    const passOriginal = cuenta?.pass;
    if (cuenta) cuenta.pass = '';

    const aviso = await email.sendDelegacionArcaPendiente({
      negocio: { id: 1, nombreNegocio: 'QA', cuit: '20111111112' },
      cuit: CLIENTE, nombre: 'QA Fiscal', ambiente: 'produccion',
      motivo: '[600] ValidacionDeToken', emailDueno: 'qa@test.local',
    });
    if (cuenta) cuenta.pass = passOriginal;
    chk('devuelve un resultado en vez de tirar', true, typeof aviso?.enviado === 'boolean');
    chk('y sin correo configurado no manda nada', false, aviso?.enviado);
    chk('diciendo por qué', 'correo no configurado', aviso?.motivo);

  } catch (e) {
    console.error('\x1b[31mERROR\x1b[0m', e.message);
    ko++;
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})();
