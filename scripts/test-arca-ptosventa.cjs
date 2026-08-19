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

/*
 * Respuesta real de un monotributista. El detalle que importa: los puntos de
 * venta vigentes traen <FchBaja>NULL</FchBaja>, no el tag vacío.
 */
const CON_PUNTOS = `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
 <soap:Body><FEParamGetPtosVentaResponse xmlns="http://ar.gov.afip.dif.FEV1/">
  <FEParamGetPtosVentaResult><ResultGet>
    <PtoVenta><Nro>7</Nro><EmisionTipo>CAE - Monotributo</EmisionTipo><Bloqueado>N</Bloqueado><FchBaja>NULL</FchBaja></PtoVenta>
    <PtoVenta><Nro>8</Nro><EmisionTipo>CAE - Monotributo</EmisionTipo><Bloqueado>N</Bloqueado><FchBaja></FchBaja></PtoVenta>
    <PtoVenta><Nro>3</Nro><EmisionTipo>CAE</EmisionTipo><Bloqueado>S</Bloqueado><FchBaja>NULL</FchBaja></PtoVenta>
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
chk('lee los cuatro',                          4, r1.puntos.length);
chk('el número',                               7, r1.puntos[0].Nro);
chk('el tipo de emisión',    'CAE - Monotributo', r1.puntos[0].EmisionTipo);
chk('Bloqueado "N" es false',              false, r1.puntos[0].Bloqueado);
chk('Bloqueado "S" es true',                true, r1.puntos[2].Bloqueado);
chk('una baja real se lee',           '20250101', r1.puntos[3].FchBaja);
chk('sin errores',                             0, r1.errores.length);

/*
 * La regresión de este caso: AFIP escribe la cadena "NULL" en los campos
 * vacíos. Tomada literal, un punto de venta vigente figura dado de baja, se cae
 * de la lista de activos, y el sistema informa que no hay ninguno habilitado
 * mientras en AFIP se ven perfectamente vigentes.
 */
chk('FchBaja "NULL" es null, no la cadena', null, r1.puntos[0].FchBaja);
chk('el tag vacío también',                 null, r1.puntos[1].FchBaja);
chk('los dos vigentes cuentan como activos',   2,
  r1.puntos.filter((p) => !p.Bloqueado && !p.FchBaja).length);
chk('el bloqueado no cuenta',              false,
  r1.puntos.filter((p) => !p.Bloqueado && !p.FchBaja).some((p) => p.Nro === 3));
chk('el dado de baja tampoco',             false,
  r1.puntos.filter((p) => !p.Bloqueado && !p.FchBaja).some((p) => p.Nro === 5));

/*
 * La regresión que importa: "N" es una cadena, y toda cadena no vacía es
 * verdadera en JavaScript. Si Bloqueado quedara como texto, un filtro por
 * `!p.Bloqueado` descartaría TODOS los puntos de venta activos y el sistema
 * diría que no hay ninguno.
 */
chk('Bloqueado es booleano, no la cadena "N"', 'boolean', typeof r1.puntos[0].Bloqueado);
chk('"NULL" en EmisionTipo tampoco pasa como texto', null,
  parsear('<PtoVenta><Nro>1</Nro><EmisionTipo>NULL</EmisionTipo></PtoVenta>').puntos[0].EmisionTipo);

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
chk('los lee igual',   4, r4.puntos.length);
chk('con sus números',  7, r4.puntos[0].Nro);

tit('4. RESPUESTAS ROTAS');
chk('vacía no explota',        0, parsear('').puntos.length);
chk('basura no explota',       0, parsear('<html>error 500</html>').puntos.length);
chk('un PtoVenta sin Nro se descarta', 0,
  parsear('<PtoVenta><EmisionTipo>CAE</EmisionTipo></PtoVenta>').puntos.length);

// ══════════════════════════════════════════════════════════════════
//  ÚLTIMO COMPROBANTE AUTORIZADO
// ══════════════════════════════════════════════════════════════════
const ultimo = cliente.__parsearUltimoAutorizado;
const tirar = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

tit('5. ÚLTIMO COMPROBANTE — cero legítimo vs. error');
const OK_23 = '<FECompUltimoAutorizadoResult><PtoVta>8</PtoVta><CbteTipo>11</CbteTipo><CbteNro>23</CbteNro></FECompUltimoAutorizadoResult>';
const OK_0  = '<FECompUltimoAutorizadoResult><PtoVta>8</PtoVta><CbteTipo>11</CbteTipo><CbteNro>0</CbteNro></FECompUltimoAutorizadoResult>';
const ERR_600 = '<FECompUltimoAutorizadoResult><Errors><Err><Code>600</Code><Msg>ValidacionDeToken: No aparecio CUIT en lista de relaciones: 27928813415</Msg></Err></Errors></FECompUltimoAutorizadoResult>';
const ERR_PV  = '<FECompUltimoAutorizadoResult><Errors><Err><Code>602</Code><Msg>Sin Resultados</Msg></Err></Errors></FECompUltimoAutorizadoResult>';

chk('lee el número',                     23, ultimo(OK_23));
chk('cero de un PV nuevo es válido',      0, ultimo(OK_0));
chk('con prefijo de namespace',          23, ultimo(OK_23.replace(/<(\/?)(CbteNro|PtoVta|CbteTipo)>/g, '<$1ar:$2>')));

/*
 * La regresión que importa acá: antes CUALQUIER error devolvía 0, el emisor
 * calculaba "próximo = 1" y le pedía a AFIP autorizar el comprobante 1. Con
 * facturas ya emitidas, AFIP contestaba que el número no es correlativo — un
 * mensaje que manda a revisar la numeración en vez de la delegación.
 */
chk('un 600 no se convierte en cero', true, /600/.test(tirar(() => ultimo(ERR_600)) || ''));
chk('y nombra el problema real',      true, /lista de relaciones/.test(tirar(() => ultimo(ERR_600)) || ''));
chk('un 602 tampoco',                 true, /602/.test(tirar(() => ultimo(ERR_PV)) || ''));
chk('una respuesta sin número ni error tampoco', true,
  /no devolvió/.test(tirar(() => ultimo('<html>502 Bad Gateway</html>')) || ''));

// ══════════════════════════════════════════════════════════════════
//  SOLICITUD DE CAE
// ══════════════════════════════════════════════════════════════════
const cae = cliente.__parsearCAE;

const APROBADO = `<FECAESolicitarResult>
  <FeCabResp><Cuit>27928813415</Cuit><PtoVta>8</PtoVta><CbteTipo>11</CbteTipo><Resultado>A</Resultado></FeCabResp>
  <FeDetResp><FECAEDetResponse>
    <Concepto>1</Concepto><DocTipo>99</DocTipo><DocNro>0</DocNro>
    <CbteDesde>24</CbteDesde><CbteHasta>24</CbteHasta><CbteFch>20260818</CbteFch>
    <Resultado>A</Resultado><CAE>75123456789012</CAE><CAEFchVto>20260828</CAEFchVto>
  </FECAEDetResponse></FeDetResp></FECAESolicitarResult>`;

const CON_OBS = APROBADO.replace('</FECAEDetResponse>',
  '<Observaciones><Obs><Code>10063</Code><Msg>Msg de observacion</Msg></Obs></Observaciones></FECAEDetResponse>');

const RECHAZADO = `<FECAESolicitarResult>
  <FeCabResp><Resultado>R</Resultado></FeCabResp>
  <FeDetResp><FECAEDetResponse>
    <CbteDesde>1</CbteDesde><Resultado>R</Resultado><CAE></CAE><CAEFchVto></CAEFchVto>
    <Observaciones><Obs><Code>10016</Code><Msg>El numero de comprobante no es correlativo</Msg></Obs></Observaciones>
  </FECAEDetResponse></FeDetResp></FECAESolicitarResult>`;

const CAE_NULL = APROBADO.replace('<CAE>75123456789012</CAE>', '<CAE>NULL</CAE>');

tit('6. CAE APROBADO');
const a = cae(APROBADO);
chk('el CAE',           '75123456789012', a.CAE);
chk('el vencimiento con guiones', '2026-08-28', a.CAEFchVto);
chk('el resultado',                    'A', a.Resultado);
chk('sin observaciones',                 0, a.Observaciones.length);

tit('6.b APROBADO CON OBSERVACIONES — el CAE vale igual');
const b = cae(CON_OBS);
chk('devuelve el CAE',  '75123456789012', b.CAE);
chk('y guarda la observación', ['10063: Msg de observacion'], b.Observaciones);

tit('7. CAE RECHAZADO');
chk('no devuelve un CAE vacío como válido', true,
  /no es correlativo/.test(tirar(() => cae(RECHAZADO)) || ''));
chk('el código de la observación viaja', true,
  /10016/.test(tirar(() => cae(RECHAZADO)) || ''));

/*
 * `<CAE>NULL</CAE>` es la forma en que AFIP escribe un CAE ausente. Tomado
 * literal se guardaría la cadena "NULL" como número de autorización y la
 * factura quedaría en la base como emitida, con un CAE que no existe.
 */
chk('CAE "NULL" se trata como ausente, no como CAE', true,
  tirar(() => cae(CAE_NULL)) !== null);

tit('8. RESULTADO: MANDA EL DEL DETALLE');
// Cabecera aprobada y detalle rechazado: gana el detalle, que es el que habla
// de este comprobante.
const DISCREPA = APROBADO
  .replace('<Resultado>A</Resultado><CAE>', '<Resultado>R</Resultado><CAE>')
  .replace('<CAE>75123456789012</CAE>', '<CAE></CAE>');
chk('un detalle rechazado rechaza', true, tirar(() => cae(DISCREPA)) !== null);

// ══════════════════════════════════════════════════════════════════
//  LETRA DEL COMPROBANTE
// ══════════════════════════════════════════════════════════════════
process.env.ARCA_MOCK = 'true';   // evita cargar certificados
const { tipoComprobante } = require(path.join(__dirname, '..', 'src', 'services', 'arcaService.js'));
const letra = (emisor, receptor, cuit) =>
  tipoComprobante({ condicionEmisor: emisor, condicionReceptor: receptor, clienteCuit: cuit });

tit('9. EMISOR MONOTRIBUTISTA — siempre C');
/*
 * Es la regla que el sistema no tenía. Elegía la letra mirando sólo al cliente,
 * así que a un cliente responsable inscripto le emitía A aunque el emisor fuera
 * monotributista: una factura que ese emisor no puede emitir, con 21% de IVA
 * discriminado que no le corresponde.
 */
chk('a un responsable inscripto', 'C', letra('Responsable Monotributo', 'Responsable Inscripto', '20111111112'));
chk('a un consumidor final',      'C', letra('Responsable Monotributo', 'Consumidor Final', null));
chk('a otro monotributista',      'C', letra('Responsable Monotributo', 'Responsable Monotributo', '20111111112'));
chk('sin saber del cliente',      'C', letra('Responsable Monotributo', null, '20111111112'));
chk('la variante "Monotributista"', 'C', letra('Monotributista', 'Responsable Inscripto', '20111111112'));

tit('9.b EMISOR EXENTO — también C');
chk('exento a inscripto', 'C', letra('IVA Sujeto Exento', 'Responsable Inscripto', '20111111112'));

tit('10. EMISOR RESPONSABLE INSCRIPTO — A o B según el cliente');
chk('a un inscripto → A',        'A', letra('Responsable Inscripto', 'Responsable Inscripto', '20111111112'));
chk('a un monotributista → B',   'B', letra('Responsable Inscripto', 'Responsable Monotributo', '20111111112'));
chk('a un exento → B',           'B', letra('Responsable Inscripto', 'IVA Sujeto Exento', '20111111112'));
chk('a consumidor final → B',    'B', letra('Responsable Inscripto', 'Consumidor Final', null));

tit('10.b SIN CONDICIÓN DEL RECEPTOR — heurística vieja, sólo para un emisor RI');
chk('con CUIT de 11 dígitos → A', 'A', letra('Responsable Inscripto', null, '20111111112'));
chk('sin CUIT → B',               'B', letra('Responsable Inscripto', null, null));

tit('11. SIN CONDICIÓN DEL EMISOR — no se puede asumir monotributo');
// Con el emisor desconocido se mantiene la heurística anterior: forzar C
// convertiría en monotributista a un responsable inscripto sin datos cargados.
chk('cae en la heurística por cliente', 'A', letra(null, null, '20111111112'));
chk('y sin CUIT, B',                    'B', letra(null, null, null));

console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
process.exit(ko ? 1 : 0);
