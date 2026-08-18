/*
 * Lectura de la respuesta de FEParamGetPtosVenta.
 *
 * No llama a AFIP: le da al parser respuestas reales guardadas. Es el punto
 * donde un error se disfraza de trámite faltante — el sistema le dice al
 * usuario "no diste de alta el punto de venta" y lo manda a rehacer algo que
 * ya hizo, mientras el problema estaba en otro lado.
 *
 * Uso:  node scripts/test-arca-ptosventa.cjs
 */
const path = require('path');
const Module = require('module');

/*
 * arcaClient carga certificados y habla por red al importarse. Acá sólo
 * interesa el parseo, así que se intercepta la llamada SOAP y se devuelve el
 * XML del caso. Es más honesto que copiar la expresión regular al test: se
 * prueba la función que corre en producción, no una gemela.
 */
let XML_ACTUAL = '';
const originalLoad = Module._load;
Module._load = function (pedido, padre, esPrincipal) {
  if (pedido === 'axios') {
    return { post: async () => ({ data: XML_ACTUAL }) };
  }
  return originalLoad.apply(this, arguments);
};

process.env.ARCA_MOCK = 'false';
const cliente = require(path.join(__dirname, '..', 'src', 'services', 'arcaClient.js'));

// El TA se cachea por CUIT+ambiente+servicio; se saltea con un stub.
const arcaService = null;

let ok = 0, ko = 0;
const chk = (t, esperado, obtuvo) => {
  const a = JSON.stringify(esperado), b = JSON.stringify(obtuvo);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

// Se prueba el parser directamente sobre el XML, sin red ni TA.
const parsear = cliente.__parsearPtosVenta;

const CON_PUNTOS = `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
 <soap:Body><FEParamGetPtosVentaResponse xmlns="http://ar.gov.afip.dif.FEV1/">
  <FEParamGetPtosVentaResult><ResultGet>
    <PtoVenta><Nro>8</Nro><EmisionTipo>CAE</EmisionTipo><Bloqueado>N</Bloqueado><FchBaja></FchBaja></PtoVenta>
    <PtoVenta><Nro>3</Nro><EmisionTipo>CAE</EmisionTipo><Bloqueado>S</Bloqueado><FchBaja></FchBaja></PtoVenta>
    <PtoVenta><Nro>5</Nro><EmisionTipo>CAE</EmisionTipo><Bloqueado>N</Bloqueado><FchBaja>20250101</FchBaja></PtoVenta>
  </ResultGet></FEParamGetPtosVentaResult>
 </FEParamGetPtosVentaResponse></soap:Body></soap:Envelope>`;

const SIN_RESULTADOS = `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>
 <FEParamGetPtosVentaResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FEParamGetPtosVentaResult>
  <Errors><Err><Code>602</Code><Msg>Sin Resultados</Msg></Err></Errors>
 </FEParamGetPtosVentaResult></FEParamGetPtosVentaResponse></soap:Body></soap:Envelope>`;

const NO_AUTORIZADO = `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>
 <FEParamGetPtosVentaResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FEParamGetPtosVentaResult>
  <Errors><Err><Code>600</Code><Msg>ValidacionDeToken: No estan dados de alta los WS</Msg></Err></Errors>
 </FEParamGetPtosVentaResult></FEParamGetPtosVentaResponse></soap:Body></soap:Envelope>`;

const CON_PREFIJO = CON_PUNTOS.replace(/<(\/?)(PtoVenta|Nro|EmisionTipo|Bloqueado|FchBaja)>/g, '<$1ar:$2>');

tit('1. RESPUESTA CON PUNTOS DE VENTA');
const r1 = parsear(CON_PUNTOS);
chk('lee los tres',                    3, r1.puntos.length);
chk('el número',                       8, r1.puntos[0].Nro);
chk('el tipo de emisión',          'CAE', r1.puntos[0].EmisionTipo);
chk('Bloqueado "N" es false',      false, r1.puntos[0].Bloqueado);
chk('Bloqueado "S" es true',        true, r1.puntos[1].Bloqueado);
chk('la fecha de baja',       '20250101', r1.puntos[2].FchBaja);
chk('sin errores',                     0, r1.errores.length);

/*
 * La regresión que importa: "N" es una cadena, y toda cadena no vacía es
 * verdadera en JavaScript. Si Bloqueado quedara como texto, un filtro por
 * `!p.Bloqueado` descartaría TODOS los puntos de venta activos y el sistema
 * diría que no hay ninguno.
 */
chk('Bloqueado es booleano, no la cadena "N"', 'boolean', typeof r1.puntos[0].Bloqueado);
chk('un activo pasa el filtro de activos', 1,
  r1.puntos.filter((p) => !p.Bloqueado && !p.FchBaja).length);

tit('2. ERRORES DE AFIP — no se los puede confundir con "no hay puntos de venta"');
const r2 = parsear(SIN_RESULTADOS);
chk('602 se recoge',            602, r2.errores[0]?.codigo);
chk('con su mensaje', 'Sin Resultados', r2.errores[0]?.mensaje);
chk('y no inventa puntos',        0, r2.puntos.length);

const r3 = parsear(NO_AUTORIZADO);
chk('600 se recoge',            600, r3.errores[0]?.codigo);
chk('mensaje completo', true, /No estan dados de alta/.test(r3.errores[0]?.mensaje || ''));
chk('600 NO es "sin resultados"', false, r3.errores.every((x) => x.codigo === 602));
chk('602 SÍ lo es',                true, r2.errores.every((x) => x.codigo === 602));

tit('3. TAGS CON PREFIJO DE NAMESPACE');
const r4 = parsear(CON_PREFIJO);
chk('los lee igual',   3, r4.puntos.length);
chk('con sus números',  8, r4.puntos[0].Nro);

tit('4. RESPUESTAS ROTAS');
chk('vacía no explota',        0, parsear('').puntos.length);
chk('basura no explota',       0, parsear('<html>error 500</html>').puntos.length);
chk('un PtoVenta sin Nro se descarta', 0,
  parsear('<PtoVenta><EmisionTipo>CAE</EmisionTipo></PtoVenta>').puntos.length);

console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
process.exit(ko ? 1 : 0);
