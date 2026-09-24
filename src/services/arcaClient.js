/*
 * Cliente ARCA (ex-AFIP) directo — SIN intermediarios/proxies.
 * Habla directo con:
 *   - WSAA (auth):    https://wsaa[homo].afip.gov.ar/ws/services/LoginCms
 *   - WSFEv1 (fact):  https://[wswhomo|servicios1].afip.gov.ar/wsfev1/service.asmx
 *
 * Implementa:
 *   1) WSAA LoginCms: firma un ticket XML con PKCS#7/CMS usando node-forge,
 *      y llama al servicio SOAP loginCms. Guarda el TA (token+sign) en memoria
 *      con TTL (12h reales; usamos 11h por seguridad).
 *   2) WSFEv1 SOAP: FEDummy, FEParamGetPtosVenta, FECompUltimoAutorizado, FECAESolicitar.
 *
 * No usa librería SOAP: los XMLs son simples y los armamos a mano con templates.
 */

const forge = require('node-forge');
const axios = require('axios');
const https = require('node:https');

/*
 * Agente TLS para hablar con AFIP.
 *
 * Sus servidores de producción todavía negocian Diffie-Hellman con claves de
 * 1024 bits. OpenSSL 3 (Node 17 en adelante) las rechaza por debajo de su
 * nivel de seguridad por defecto, y la conexión muere antes del handshake con
 * "dh key too small" — un error de red que parece un problema del certificado
 * o del punto de venta, cuando en realidad AFIP no actualizó sus parámetros.
 *
 * SECLEVEL=1 es lo mínimo que las acepta. Va en un agente propio y no en una
 * variable global de OpenSSL: así el resto de las conexiones salientes del
 * servidor (mail, MercadoLibre) conservan el nivel de seguridad normal.
 */
const agenteAfip = new https.Agent({
  ciphers: 'DEFAULT:@SECLEVEL=1',
  keepAlive: true,
});

// ── URLs por ambiente ─────────────────────────────────────────────
const URLS = {
  homologacion: {
    wsaa:      'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
    wsfe:      'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
    padronA4:  'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA4',
    padronA5:  'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA5',
    padronA10: 'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA10',
    padronA13: 'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA13',
  },
  produccion: {
    wsaa:      'https://wsaa.afip.gov.ar/ws/services/LoginCms',
    wsfe:      'https://servicios1.afip.gov.ar/wsfev1/service.asmx',
    padronA4:  'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA4',
    padronA5:  'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5',
    padronA10: 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA10',
    padronA13: 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA13',
  },
};

/*
 * ── Cache de TA (Token+Sign) por (cuit, ambiente, service) ───────
 *
 * El TA dura 12h y lo persistimos en Postgres (ver arcaTokenStore) porque
 * perderlo nos deja sin autenticar.
 *
 * Lo que AFIP NO permite es pedir muchos TA seguidos para el mismo servicio:
 * el "El CEE ya posee un TA valido" salta si se piden dos dentro de una
 * ventana corta —2 minutos en producción, 10 en homologación según el manual
 * del WSAA—, no durante las 12h enteras. Por eso sí se puede forzar uno nuevo
 * cuando hace falta (ver `forzar`), siempre que entre pedido y pedido pasen
 * varios minutos.
 *
 * El TTL sale del propio TA (`exp_time`), no de un número puesto a mano: AFIP
 * ignora la expiración que pedimos y pone la suya.
 */
const taStore = require('./arcaTokenStore');
const TA_TTL_MS = 11 * 60 * 60 * 1000; // sólo como red de seguridad si el TA no se puede leer
const MARGEN_TA_MS = 5 * 60 * 1000;    // no usar un TA en sus últimos minutos

function cacheKey({ cuit, ambiente, service }) {
  return `${cuit}::${ambiente}::${service}`;
}

// ── 1) WSAA: obtener TA ──────────────────────────────────────────
async function getTA({ cert, key, ambiente, service = 'wsfe', forzar = false }) {
  const cuitStr = extractCuitFromCert(cert);
  const key0 = cacheKey({ cuit: cuitStr, ambiente, service });
  /*
   * `forzar` se usa para releer las delegaciones: el TA guardado puede ser de
   * hace horas y no traer al cliente que delegó recién. Quien lo fuerza tiene
   * que espaciar los pedidos (el barrido va cada 15 minutos); si AFIP lo
   * rechaza igual, se sigue con el guardado en vez de romper.
   */
  if (!forzar) {
    const guardado = await taStore.get(key0);
    if (guardado) return guardado;
  }

  // 1.1) Armar LoginTicketRequest XML
  // AFIP requiere formato ISO 8601 CON offset de timezone (no acepta el .toISOString()
  // sin timezone, ni la Z sola en algunos casos). Usamos -03:00 (hora Argentina) explícito.
  const now  = new Date();
  const from = new Date(now.getTime() - 5 * 60_000);          // 5 min atrás (por si hay drift)
  const to   = new Date(now.getTime() + 30 * 60_000);         // 30 min adelante
  const uniqueId = String(Math.floor(now.getTime() / 1000));
  const fmt = (d) => {
    // Formato "2026-08-07T10:00:38-03:00"
    const pad = (n) => String(n).padStart(2, '0');
    const tzOffsetMin = -d.getTimezoneOffset();          // en Argentina: 180 → "-03:00"? no, es +180 → +03:00. AFIP quiere -03:00.
    // El servidor puede estar en cualquier TZ; forzamos AR (-03:00) construyendo desde UTC.
    const utc = new Date(d.getTime() - 3 * 60 * 60 * 1000);
    return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth()+1)}-${pad(utc.getUTCDate())}T${pad(utc.getUTCHours())}:${pad(utc.getUTCMinutes())}:${pad(utc.getUTCSeconds())}-03:00`;
  };
  const loginTicketRequest = `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${uniqueId}</uniqueId>
    <generationTime>${fmt(from)}</generationTime>
    <expirationTime>${fmt(to)}</expirationTime>
  </header>
  <service>${service}</service>
</loginTicketRequest>`;

  // 1.2) Firmar con PKCS#7 / CMS y codificar base64
  const cms = signCMS(loginTicketRequest, cert, key);

  // 1.3) Llamar loginCms via SOAP
  const soapEnvelope = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soap:Body>
    <wsaa:loginCms>
      <wsaa:in0>${cms}</wsaa:in0>
    </wsaa:loginCms>
  </soap:Body>
</soap:Envelope>`;

  let res;
  try {
    res = await axios.post(URLS[ambiente].wsaa, soapEnvelope, {
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'SOAPAction': '' },
      timeout: 20000,
      httpsAgent: agenteAfip,
    });
  } catch (err) {
    const faultDetail = extractSoapFault(err.response?.data) || err.message;
    // Caso especial conocido: AFIP mantiene el TA anterior vigente 12h y no da otro.
    // Traducimos el mensaje críptico a algo útil para el usuario.
    if (/ya posee un TA valido/i.test(faultDetail)) {
      throw new Error(`AFIP ya emitió un TA vigente y no permite renovarlo hasta que expire (dura 12h). Esto pasa si un proceso pidió TA hace poco y se perdió el archivo local. El cliente ya persiste el TA a disco automáticamente, así que próximas veces no volverá a pasar. Esperá ~12h y reintentá.`);
    }
    throw new Error(`WSAA login falló: ${faultDetail}`);
  }

  // 1.4) Extraer <loginCmsReturn> (contiene el TA XML escapado como CDATA o entidades)
  const returnMatch = res.data.match(/<loginCmsReturn>([\s\S]*?)<\/loginCmsReturn>/);
  if (!returnMatch) throw new Error('WSAA: respuesta inesperada, no vino loginCmsReturn.');
  const taXml = decodeXmlEntities(returnMatch[1]);

  const token = (taXml.match(/<token>([\s\S]*?)<\/token>/) || [])[1];
  const sign  = (taXml.match(/<sign>([\s\S]*?)<\/sign>/)   || [])[1];
  if (!token || !sign) throw new Error('WSAA: no se pudo parsear token/sign del TA.');

  const ta = { token, sign, cuit: cuitStr };
  const vence = datosDelTA(ta).vence;
  const expiraEn = vence ? vence.getTime() - MARGEN_TA_MS : Date.now() + TA_TTL_MS;
  await taStore.set(key0, ta, expiraEn);
  return ta;
}

// PKCS#7 signed data (base64) — el formato que espera WSAA
function signCMS(content, certPem, keyPem) {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(content, 'utf8');
  p7.addCertificate(certPem);
  p7.addSigner({
    key: forge.pki.privateKeyFromPem(keyPem),
    certificate: forge.pki.certificateFromPem(certPem),
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest }, // valor calculado por la lib
      { type: forge.pki.oids.signingTime,  value: new Date() },
    ],
  });
  p7.sign({ detached: false });
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return forge.util.encode64(der);
}

// ── 2) Cliente WSFEv1 ────────────────────────────────────────────
async function callWsfe({ cert, key, ambiente, cuitEmisor, method, params = {} }) {
  // Necesitamos TA para el service "wsfe"
  const ta = await getTA({ cert, key, ambiente, service: 'wsfe' });

  // IMPORTANTE: todos los tags dentro del namespace de AFIP deben llevar el prefix "ar:"
  // (o al menos declarar el namespace inline). Sin el prefix, AFIP responde
  // "Tag Auth no fue ingresado" porque no matchea con el namespace esperado.
  const authXml = `
    <ar:Auth>
      <ar:Token>${ta.token}</ar:Token>
      <ar:Sign>${ta.sign}</ar:Sign>
      <ar:Cuit>${cuitEmisor}</ar:Cuit>
    </ar:Auth>`;

  // Serializar los parámetros extra a XML (con prefix ar:)
  const paramsXml = objectToXml(params, '      ', 'ar:');

  const soapEnvelope = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/">
  <soap:Body>
    <ar:${method}>
      ${authXml}
      ${paramsXml}
    </ar:${method}>
  </soap:Body>
</soap:Envelope>`;

  let res;
  try {
    res = await axios.post(URLS[ambiente].wsfe, soapEnvelope, {
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': `http://ar.gov.afip.dif.FEV1/${method}`,
      },
      timeout: 30000,
      httpsAgent: agenteAfip,
    });
  } catch (err) {
    const faultDetail = extractSoapFault(err.response?.data) || err.message;
    throw new Error(`WSFE ${method}: ${faultDetail}`);
  }

  // Parsear el resultado (varía por método — devolvemos el string XML y quien llama lo parsea)
  const returnMatch = res.data.match(new RegExp(`<${method}Result>([\\s\\S]*?)<\\/${method}Result>`));
  if (!returnMatch) {
    // Puede que sea un SOAP Fault
    const fault = extractSoapFault(res.data);
    if (fault) throw new Error(`WSFE ${method}: ${fault}`);
    return res.data;
  }
  return returnMatch[1];
}

// Serializa objetos JS → XML plano (recursivo, arrays soportados con nombre repetido).
// Soporta un `prefix` de namespace opcional (ej. "ar:") que se aplica a TODOS los tags.
function objectToXml(obj, indent = '      ', prefix = '') {
  if (obj == null) return '';
  return Object.entries(obj).map(([key, val]) => {
    if (val == null) return '';
    const tag = `${prefix}${key}`;
    if (Array.isArray(val)) return val.map((v) => {
      if (typeof v === 'object') return `${indent}<${tag}>\n${objectToXml(v, indent + '  ', prefix)}\n${indent}</${tag}>`;
      return `${indent}<${tag}>${escapeXml(v)}</${tag}>`;
    }).join('\n');
    if (typeof val === 'object') return `${indent}<${tag}>\n${objectToXml(val, indent + '  ', prefix)}\n${indent}</${tag}>`;
    return `${indent}<${tag}>${escapeXml(val)}</${tag}>`;
  }).join('\n');
}

function escapeXml(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' }[c]));
}
function decodeXmlEntities(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function extractSoapFault(data) {
  if (!data) return null;
  const s = typeof data === 'string' ? data : String(data);
  const m = s.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i);
  return m ? m[1].trim() : null;
}

// Extraer CUIT del serialNumber del cert (formato "CUIT NNNNNNNNNNN")
function extractCuitFromCert(certPem) {
  try {
    const cert = forge.pki.certificateFromPem(certPem);
    // OJO: cert.subject.getField('serialNumber') NO sirve — node-forge trata
    // cualquier string como shortName, y el atributo serialNumber (OID 2.5.4.5)
    // no tiene shortName. Hay que recorrer los atributos a mano.
    for (const attr of cert.subject.attributes || []) {
      if (attr.name === 'serialNumber' || attr.type === '2.5.4.5') {
        const m = String(attr.value || '').match(/(\d{11})/);
        if (m) return m[1];
      }
    }
    return null;
  } catch { return null; }
}

// ── Métodos WSFE de alto nivel ───────────────────────────────────
async function feDummy({ cert, key, ambiente, cuitEmisor }) {
  const xml = await callWsfe({ cert, key, ambiente, cuitEmisor, method: 'FEDummy' });
  return {
    AppServer:  (xml.match(/<AppServer>([^<]+)/)  || [])[1] || null,
    DbServer:   (xml.match(/<DbServer>([^<]+)/)   || [])[1] || null,
    AuthServer: (xml.match(/<AuthServer>([^<]+)/) || [])[1] || null,
  };
}

/*
 * Lista de puntos de venta electrónicos del CUIT.
 *
 * Devuelve { puntos, errores, xml }. Los errores viajan en vez de tirarse
 * porque quien llama necesita distinguir tres situaciones que antes se veían
 * todas iguales: el CUIT no tiene ningún punto de venta, AFIP rechazó algo, o
 * la respuesta no se pudo interpretar. Concluir "no diste de alta el punto de
 * venta" cuando en realidad AFIP dijo otra cosa manda al usuario a rehacer un
 * trámite que ya hizo.
 */
async function feParamGetPtosVenta({ cert, key, ambiente, cuitEmisor }) {
  const xml = await callWsfe({ cert, key, ambiente, cuitEmisor, method: 'FEParamGetPtosVenta' });
  return parsearPtosVenta(xml);
}

/*
 * El parseo va aparte de la llamada para poder probarlo sin AFIP.
 *
 * Interpretar esta respuesta es donde estuvo el error que hacía decir "falta
 * dar de alta el punto de venta" a quien ya lo tenía, así que conviene poder
 * fijarlo con respuestas reales guardadas en vez de depender de una prueba
 * contra el ambiente de homologación.
 */
function parsearPtosVenta(xml) {
  /*
   * Los <Err> de AFIP se recogen todos, con su código.
   *
   * Antes se miraba un solo <Msg> y se tiraba sólo si decía "error", "no
   * autorizado" o "denegada". El 602 de AFIP dice "Sin Resultados" y el 600
   * "ClientCredentials no válidos": ninguno matchea, así que se devolvía una
   * lista vacía como si el CUIT no tuviera puntos de venta.
   */
  const errores = leerErrores(xml);

  /*
   * Cada <PtoVenta> se saca entero y después se leen sus campos.
   *
   * La versión anterior intentaba capturarlo todo en una sola expresión con
   * grupos opcionales entre comodines perezosos, y el grupo de EmisionTipo no
   * matcheaba casi nunca: el comodín de la izquierda se lo comía antes.
   */
  const puntos = [];
  const rxPto = /<(?:\w+:)?PtoVenta>([\s\S]*?)<\/(?:\w+:)?PtoVenta>/g;
  let m; while ((m = rxPto.exec(xml)) !== null) {
    const bloque = m[1];
    /*
     * Un campo vacío de AFIP puede venir de tres formas: ausente, `<X></X>` o
     * —y esta es la que engaña— con la cadena literal `NULL`.
     *
     * Esa cadena es verdadera en JavaScript. Tomada tal cual, un punto de venta
     * activo con <FchBaja>NULL</FchBaja> se lee como dado de baja, desaparece
     * de la lista de activos y el sistema informa que no hay ninguno
     * habilitado. El usuario mira en AFIP, lo ve vigente, y no hay manera de
     * conciliar las dos cosas.
     */
    const campo = (nombre) => {
      const bruto = (bloque.match(new RegExp(`<(?:\\w+:)?${nombre}>([^<]*)<`)) || [])[1]?.trim();
      if (!bruto || /^null$/i.test(bruto)) return null;
      return bruto;
    };

    const nro = campo('Nro');
    if (!nro) continue;
    puntos.push({
      Nro: Number(nro),
      EmisionTipo: campo('EmisionTipo'),
      // "N"/"S", no un booleano. Mismo motivo que arriba: dejar la cadena haría
      // que `if (p.Bloqueado)` diera verdadero también con "N".
      Bloqueado: /^s$/i.test(campo('Bloqueado') || ''),
      FchBaja: campo('FchBaja'),
    });
  }

  return { puntos, errores, xml };
}


async function feCompUltimoAutorizado({ cert, key, ambiente, cuitEmisor, PtoVta, CbteTipo }) {
  const xml = await callWsfe({ cert, key, ambiente, cuitEmisor, method: 'FECompUltimoAutorizado', params: { PtoVta, CbteTipo } });
  return parsearUltimoAutorizado(xml);
}

/*
 * Último comprobante autorizado de un punto de venta.
 *
 * Cero es una respuesta legítima: un punto de venta recién dado de alta no
 * tiene ninguno, y el próximo es el 1.
 *
 * Por eso hay que distinguirlo de un error. La versión anterior hacía
 * `nro ? Number(nro) : 0`, así que cualquier rechazo de AFIP —delegación,
 * punto de venta inexistente, token vencido— también devolvía cero. El emisor
 * seguía adelante y le pedía a AFIP autorizar el comprobante número 1: si el
 * punto de venta ya tenía facturas, AFIP contestaba que el número no es
 * correlativo, un mensaje que no menciona el problema real y manda a revisar
 * la numeración en vez de la delegación.
 */
function parsearUltimoAutorizado(xml) {
  const errores = leerErrores(xml);
  if (errores.length) {
    throw new Error(errores.map((e) => `[${e.codigo}] ${e.mensaje}`).join(' | '));
  }

  const nro = (xml.match(/<(?:\w+:)?CbteNro>(\d+)<\/(?:\w+:)?CbteNro>/) || [])[1];
  if (nro === undefined) {
    // Ni número ni error: la respuesta no es la que esperamos. Antes esto
    // también terminaba en cero.
    throw new Error(`AFIP no devolvió el último comprobante autorizado. Respuesta: ${xml.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  return Number(nro);
}

/*
 * Los <Err> de una respuesta de AFIP, con su código.
 *
 * Compartido por todos los métodos: cada uno los traía con su propia expresión
 * —o no los traía— y así fue como una respuesta de error terminó leyéndose
 * como "este CUIT no tiene puntos de venta".
 */
function leerErrores(xml) {
  const out = [];
  const rx = /<(?:\w+:)?Err>[\s\S]*?<(?:\w+:)?Code>(\d+)<\/(?:\w+:)?Code>[\s\S]*?<(?:\w+:)?Msg>([\s\S]*?)<\/(?:\w+:)?Msg>[\s\S]*?<\/(?:\w+:)?Err>/g;
  let m; while ((m = rx.exec(xml)) !== null) out.push({ codigo: Number(m[1]), mensaje: m[2].trim() });
  return out;
}

/*
 * ── Preguntar si un comprobante ya existe en AFIP ────────────────
 *
 * Es la respuesta a la pregunta más incómoda de todo esto: pedimos el CAE, se
 * cortó la conexión, y no sabemos si AFIP lo autorizó o no.
 *
 * Reintentar a ciegas es lo peor que se puede hacer. El número siguiente se
 * calcula preguntando cuál fue el último autorizado: si AFIP SÍ autorizó el
 * que se cortó, el reintento pide el siguiente y el cliente termina con DOS
 * comprobantes fiscales por una sola venta —y el primero, con su CAE, no queda
 * registrado en ningún lado—.
 *
 * FECompConsultar contesta por (CbteTipo, PtoVta, CbteNro): o está y viene con
 * su CAE, o AFIP contesta que no existe.
 */
async function feCompConsultar({ cert, key, ambiente, cuitEmisor, PtoVta, CbteTipo, CbteNro }) {
  const xml = await callWsfe({
    cert, key, ambiente, cuitEmisor,
    method: 'FECompConsultar',
    params: { FeCompConsReq: { CbteTipo, CbteNro, PtoVta } },
  });
  return parsearComprobante(xml);
}

/*
 * Lo que AFIP sabe de ese comprobante, o null si no lo tiene.
 *
 * "No existe" no es un error: es la respuesta que hace falta para saber que se
 * puede reintentar tranquilo. AFIP la da como error 602 ("No existen datos en
 * nuestros registros para el criterio de búsqueda ingresado") y también,
 * según el caso, devolviendo el resultado vacío.
 *
 * Cualquier OTRO error sí se levanta: no saber si el comprobante existe es
 * distinto de saber que no existe, y confundirlos es volver al problema.
 */
const SIN_DATOS = 602;

function parsearComprobante(xml) {
  const errores = leerErrores(xml);
  if (errores.length) {
    if (errores.every((e) => e.codigo === SIN_DATOS)) return null;
    throw new Error(errores.map((e) => `[${e.codigo}] ${e.mensaje}`).join(' | '));
  }

  const cuerpo = (xml.match(/<(?:\w+:)?ResultGet>([\s\S]*?)<\/(?:\w+:)?ResultGet>/) || [])[1];
  if (!cuerpo) return null;

  const dato = (nombre) => {
    const v = (cuerpo.match(new RegExp(`<(?:\\w+:)?${nombre}>([^<]*)<`)) || [])[1]?.trim();
    return (!v || /^null$/i.test(v)) ? null : v;
  };

  const cae = dato('CodAutorizacion');
  if (!cae) return null;

  const vto = dato('FchVto');
  return {
    CAE: cae,
    CAEFchVto: vto ? vto.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : null,
    Resultado: dato('Resultado'),
    CbteDesde: Number(dato('CbteDesde') || 0),
    CbteHasta: Number(dato('CbteHasta') || 0),
    CbteFch: dato('CbteFch'),
    ImpTotal: Number(dato('ImpTotal') || 0),
    DocNro: Number(dato('DocNro') || 0),
    DocTipo: Number(dato('DocTipo') || 0),
    PtoVta: Number(dato('PtoVta') || 0),
    CbteTipo: Number(dato('CbteTipo') || 0),
  };
}

async function feCAESolicitar({ cert, key, ambiente, cuitEmisor, FeCAEReq }) {
  const xml = await callWsfe({ cert, key, ambiente, cuitEmisor, method: 'FECAESolicitar', params: { FeCAEReq } });
  return parsearCAE(xml);
}

/*
 * Respuesta de la solicitud de CAE.
 *
 * El resultado se lee del detalle (FeDetResp) y no de la cabecera (FeCabResp).
 * Los dos traen un <Resultado> y con un solo comprobante coinciden, pero el que
 * manda sobre ESE comprobante es el del detalle: tomar el primero que aparece
 * en el XML es tomar el de la cabecera por casualidad de orden.
 *
 * Un comprobante puede salir aprobado CON observaciones. Eso no es un error y
 * el CAE vale, pero las observaciones se devuelven para que queden guardadas
 * con la factura: son lo que explica, meses después, por qué AFIP la marcó.
 */
function parsearCAE(xml) {
  const detalle = (xml.match(/<(?:\w+:)?FECAEDetResponse>([\s\S]*?)<\/(?:\w+:)?FECAEDetResponse>/) || [])[1] || xml;

  const dato = (fuente, nombre) => {
    const v = (fuente.match(new RegExp(`<(?:\\w+:)?${nombre}>([^<]*)<`)) || [])[1]?.trim();
    return (!v || /^null$/i.test(v)) ? null : v;
  };

  const cae = dato(detalle, 'CAE');
  const vto = dato(detalle, 'CAEFchVto');
  const resultado = dato(detalle, 'Resultado') || dato(xml, 'Resultado');

  const errores = leerErrores(xml).map((e) => `${e.codigo}: ${e.mensaje}`);
  const observaciones = [...xml.matchAll(/<(?:\w+:)?Obs>[\s\S]*?<(?:\w+:)?Code>([^<]+)<\/(?:\w+:)?Code>[\s\S]*?<(?:\w+:)?Msg>([^<]+)<\/(?:\w+:)?Msg>[\s\S]*?<\/(?:\w+:)?Obs>/g)]
    .map((m) => `${m[1].trim()}: ${m[2].trim()}`);

  if (resultado === 'R' || !cae) {
    const msgs = [...errores, ...observaciones];
    const detail = msgs.length ? msgs.join(' | ') : `CAE rechazado por AFIP. XML: ${xml.replace(/\s+/g, ' ').slice(0, 500)}`;
    throw new Error(detail);
  }

  return {
    CAE: cae,
    CAEFchVto: vto ? vto.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : null,
    Resultado: resultado,
    Observaciones: observaciones,
  };
}

// ── Padrón AFIP (autocomplete de clientes por CUIT) ──────────────
// El padrón SOLO existe en producción (homologación no autoriza los
// servicios ws_sr_*). Es una consulta de solo lectura: no emite nada,
// así que es seguro usar el cert productivo aunque estemos facturando
// en homologación.
//
// Prioridad de servicios (el primero que esté autorizado gana):
//   1. ws_sr_constancia_inscripcion → getPersona_v2 @ A5   (completo: + impuestos → condición IVA)
//   2. ws_sr_padron_a13             → getPersona    @ A13  (básico: nombre + domicilio)
const PADRON_VARIANTES = [
  { service: 'ws_sr_constancia_inscripcion', urlKey: 'padronA5',  ns: 'a5',  nsUrl: 'http://a5.soap.ws.server.puc.sr/',  metodo: 'getPersona_v2' },
  { service: 'ws_sr_padron_a13',             urlKey: 'padronA13', ns: 'a13', nsUrl: 'http://a13.soap.ws.server.puc.sr/', metodo: 'getPersona'    },
  { service: 'ws_sr_padron_a5',              urlKey: 'padronA5',  ns: 'a5',  nsUrl: 'http://a5.soap.ws.server.puc.sr/',  metodo: 'getPersona'    },
];

// Mapea los impuestos/monotributo del padrón a la condición IVA de AFIP
// (los ids son los de FEParamGetCondicionIvaReceptor, RG 5616).
function inferirCondicionIva({ impuestos, esMonotributo, tipoPersona }) {
  if (esMonotributo)                          return { id: 6, desc: 'Responsable Monotributo' };
  if (impuestos.some((i) => i.id === '30'))   return { id: 1, desc: 'IVA Responsable Inscripto' };
  if (impuestos.some((i) => i.id === '32'))   return { id: 4, desc: 'IVA Sujeto Exento' };
  // Sin IVA ni monotributo activos: para jurídicas suele ser exento/no alcanzado,
  // para físicas lo tratamos como consumidor final.
  return tipoPersona === 'JURIDICA'
    ? { id: 4, desc: 'IVA Sujeto Exento' }
    : { id: 5, desc: 'Consumidor Final' };
}

async function padronA5({ cert, key, ambiente, cuitConsultado }) {
  // Ignoramos el `ambiente` recibido: el padrón siempre va a producción.
  const amb = 'produccion';
  const cuitRepresentante = extractCuitFromCert(cert);
  if (!cuitRepresentante) throw new Error('Padrón: no se pudo extraer el CUIT del certificado.');

  let xml = null;
  let usado = null;
  let lastError = null;
  for (const v of PADRON_VARIANTES) {
    try {
      const ta = await getTA({ cert, key, ambiente: amb, service: v.service });
      const soapEnvelope = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:${v.ns}="${v.nsUrl}">
  <soap:Body>
    <${v.ns}:${v.metodo}>
      <token>${ta.token}</token>
      <sign>${ta.sign}</sign>
      <cuitRepresentada>${cuitRepresentante}</cuitRepresentada>
      <idPersona>${cuitConsultado}</idPersona>
    </${v.ns}:${v.metodo}>
  </soap:Body>
</soap:Envelope>`;
      const res = await axios.post(URLS[amb][v.urlKey], soapEnvelope, {
        headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': '' },
        timeout: 20000,
        httpsAgent: agenteAfip,
      });
      const fault = extractSoapFault(res.data);
      if (fault) { lastError = new Error(`Padrón ${v.service}: ${fault}`); continue; }
      xml = res.data;
      usado = v.service;
      break;
    } catch (err) {
      const detalle = extractSoapFault(err.response?.data) || err.message;
      lastError = new Error(`Padrón ${v.service}: ${detalle}`);
      // "no autorizado" → probamos el siguiente servicio. Otro error → cortamos.
      if (!/no autorizado/i.test(detalle)) throw lastError;
    }
  }
  if (!xml) throw lastError || new Error('Padrón AFIP: ningún servicio disponible');

  const pick = (tag, scope = xml) => {
    const m = scope.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
    return m ? m[1].trim() : null;
  };

  // Domicilio fiscal. A5/constancia usa <domicilioFiscal>; A13 devuelve varios
  // <domicilio> y hay que quedarse con el que tenga tipoDomicilio FISCAL.
  let domScope = (xml.match(/<domicilioFiscal>[\s\S]*?<\/domicilioFiscal>/) || [])[0];
  if (!domScope) {
    const bloques = xml.match(/<domicilio>[\s\S]*?<\/domicilio>/g) || [];
    domScope = bloques.find((b) => /<tipoDomicilio>FISCAL<\/tipoDomicilio>/.test(b)) || bloques[0] || '';
  }
  const domicilio = {
    direccion:            pick('direccion', domScope),
    localidad:            pick('localidad', domScope) || pick('descripcionProvincia', domScope),
    // A5 usa codPostal, A13 usa codigoPostal
    codPostal:            pick('codPostal', domScope) || pick('codigoPostal', domScope),
    idProvincia:          pick('idProvincia', domScope),
    descripcionProvincia: pick('descripcionProvincia', domScope),
  };

  // Impuestos activos (solo los que devuelve la constancia)
  const impuestos = [...xml.matchAll(/<impuesto>([\s\S]*?)<\/impuesto>/g)]
    .map((m) => ({
      id:     pick('idImpuesto', m[1]),
      desc:   pick('descripcionImpuesto', m[1]),
      estado: pick('estadoImpuesto', m[1]),
    }))
    .filter((i) => !i.estado || i.estado === 'AC');

  const esMonotributo = /<datosMonotributo>/.test(xml)
    || impuestos.some((i) => /monotributo/i.test(i.desc || ''));
  const categoriaMonotributo = pick('descripcionCategoria');

  const tipoPersona = pick('tipoPersona');
  const razonSocial = pick('razonSocial');
  const nombre      = pick('nombre');
  const apellido    = pick('apellido');
  const condicionIva = inferirCondicionIva({ impuestos, esMonotributo, tipoPersona });

  return {
    cuit:         pick('idPersona') || cuitConsultado,
    tipoPersona,                       // FISICA | JURIDICA
    tipoClave:    pick('tipoClave'),   // CUIT | CUIL
    estadoClave:  pick('estadoClave'), // ACTIVO | INACTIVO
    razonSocial:  razonSocial || (nombre && apellido ? `${apellido}, ${nombre}` : (nombre || null)),
    nombre, apellido,
    domicilio,
    impuestos:    impuestos.map((i) => i.desc).filter(Boolean),
    monotributo:  esMonotributo ? (categoriaMonotributo || 'Monotributo') : null,
    condicionIva:   condicionIva.desc,
    condicionIvaId: condicionIva.id,
    // A5/constancia: <descripcionActividad>; A13: <descripcionActividadPrincipal>
    actividadPrincipal: pick('descripcionActividadPrincipal') || pick('descripcionActividad'),
    servicioUsado: usado,
  };
}

/*
 * Los CUIT que este certificado puede representar hoy, según AFIP.
 *
 * El token del TA es XML en base64 y adentro trae la lista de relaciones que
 * AFIP reconoce para este certificado y este servicio. Es la única forma
 * automática de saber que una delegación quedó ACTIVA de punta a punta: el
 * cliente delega, alguien de Stocker acepta la designación y le asigna el
 * certificado, y recién entonces el CUIT aparece acá.
 *
 * Sirve también para lo contrario. La revocación es unilateral y AFIP no avisa
 * nada: el CUIT simplemente deja de estar en la lista. Sin mirarla, un cliente
 * que nos sacó la delegación se entera cuando falla la primera factura, que es
 * el peor momento posible.
 */
function xmlDelTA(ta) {
  if (!ta?.token) return '';
  try {
    return Buffer.from(String(ta.token), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/*
 * Lo que el TA dice de sí mismo: a quiénes representamos y hasta cuándo vale.
 *
 * Las dos cosas salen del mismo XML y se usan juntas. `vence` importa porque
 * la lista de relaciones es una foto del momento en que AFIP emitió el TA: un
 * cliente que delega después no aparece hasta que pidamos uno nuevo.
 *
 *   <id ... gen_time="1790005496" exp_time="1790048756"/>   (epoch en segundos)
 */
function datosDelTA(ta) {
  const xml = xmlDelTA(ta);
  if (!xml) return { relaciones: [], generado: null, vence: null };

  const cuits = new Set();
  for (const m of xml.matchAll(/<relation\b[^>]*\bkey="(\d{11})"/g)) cuits.add(m[1]);

  const epoch = (attr) => {
    const m = xml.match(new RegExp(`\\b${attr}="(\\d+)"`));
    if (!m) return null;
    const ms = Number(m[1]) * 1000;
    return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
  };

  return { relaciones: [...cuits], generado: epoch('gen_time'), vence: epoch('exp_time') };
}

/** Los CUIT que nos delegaron el servicio, según el TA. */
function relacionesDelTA(ta) {
  return datosDelTA(ta).relaciones;
}

module.exports = {
  URLS,
  relacionesDelTA,
  datosDelTA,
  feCompConsultar,
  __parsearComprobante: parsearComprobante,
  feDummy,
  feParamGetPtosVenta,
  // sólo para los tests
  __parsearPtosVenta: parsearPtosVenta,
  __parsearUltimoAutorizado: parsearUltimoAutorizado,
  __parsearCAE: parsearCAE,
  feCompUltimoAutorizado,
  feCAESolicitar,
  padronA5,
  // Exportados para scripts de diagnóstico (npm run arca:diag)
  __getTA: getTA,
  __extractCuitFromCert: extractCuitFromCert,
};
