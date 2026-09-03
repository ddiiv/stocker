// Integración ARCA (ex-AFIP) — cliente DIRECTO a AFIP (sin intermediarios).
//
// Modo de operación:
//   - ARCA_MOCK=true  → CAE simulado.
//   - ARCA_MOCK=false → llamada real a AFIP usando node-forge + axios.
//
// Certs por ambiente (elige automático según ambiente):
//   ARCA_CERT_PATH_HOMO / ARCA_KEY_PATH_HOMO  → homologación
//   ARCA_CERT_PATH_PROD / ARCA_KEY_PATH_PROD  → producción
//   ARCA_CERT_PATH / ARCA_KEY_PATH             → fallback genérico
//
// El modelo es de DELEGACIÓN: usamos NUESTRO certificado (stocker) para firmar el TA,
// y declaramos el CUIT del cliente en el Auth.Cuit del request WSFE. AFIP verifica que
// el cliente nos haya delegado el servicio wsfe.

const fs   = require('fs');
const { log } = require('../utils/logger');
const { loadCredentials } = require('./arcaCredentials');

const isMock = process.env.ARCA_MOCK === 'true';

let client = null;
function loadClient() {
  if (client) return client;
  client = require('./arcaClient');
  return client;
}

function loadCert(ambiente) {
  const creds = loadCredentials(ambiente);
  if (!creds) {
    throw new Error(
      `ARCA cert/key no configurados para ambiente=${ambiente}. ` +
      `Definí ARCA_CERT_B64_${ambiente === 'produccion' ? 'PROD' : 'HOMO'} y ARCA_KEY_B64_${ambiente === 'produccion' ? 'PROD' : 'HOMO'} ` +
      `(base64, recomendado en Railway/hosting) o las rutas ARCA_CERT_PATH_* / ARCA_KEY_PATH_*.`
    );
  }
  return creds;
}

// ── Utilidades comunes ────────────────────────────────────────────
function determineInvoiceType(clienteCuit) {
  if (!clienteCuit) return 'B';
  const stripped = String(clienteCuit).replace(/\D/g, '');
  return stripped.length === 11 ? 'A' : 'B';
}

/*
 * La letra del comprobante la manda el EMISOR, no el cliente.
 *
 * En Argentina el orden es ese y no el inverso:
 *
 *   · Monotributista o exento  → siempre C, le venda a quien le venda.
 *   · Responsable inscripto    → A si el cliente es RI, B en cualquier otro caso.
 *
 * El sistema venía eligiendo sólo por el cliente: a un cliente responsable
 * inscripto le emitía A aunque el emisor fuera monotributista. Eso es una
 * factura que el monotributista no puede emitir —AFIP la rechaza contra un
 * punto de venta de monotributo— y, peor, `calcularIVA` le discriminaba 21%
 * que un monotributista no debe discriminar. Si AFIP llegara a autorizarla,
 * queda un comprobante fiscal mal emitido.
 */
function tipoComprobante({ condicionEmisor, condicionReceptor, clienteCuit }) {
  const emisor = String(condicionEmisor || '').toLowerCase();

  // El emisor no factura con IVA discriminado: sólo puede emitir C.
  if (/monotribut|exento|no alcanzado/.test(emisor)) return 'C';

  const receptor = String(condicionReceptor || '').toLowerCase();
  if (/responsable inscripto/.test(receptor)) return 'A';
  if (receptor) return 'B';   // monotributo, exento, consumidor final

  /*
   * Sin condición del receptor se cae a la heurística vieja, que mira si hay
   * CUIT. Es peor que consultar el padrón, pero es lo único disponible cuando
   * el padrón no contesta.
   *
   * Y sólo se usa si el emisor es responsable inscripto: si no, ya devolvió C.
   */
  return determineInvoiceType(clienteCuit);
}
// Descompone el importe total en neto + IVA (21%).
// - Factura A: IVA discriminado, precio no incluye IVA por el receptor (aunque el emisor sí).
// - Factura B: IVA "incluido" en el total, pero AFIP requiere igual el desglose interno.
// - Factura C: monotributista, sin IVA discriminado.
function calcularIVA(total, tipoFactura) {
  if (tipoFactura === 'C') return { neto: Number(total), iva: 0 };
  // A y B: descomponemos total = neto + iva (asumiendo 21%)
  const neto = Math.round(Number(total) / 1.21 * 100) / 100;
  const iva  = Math.round((Number(total) - neto) * 100) / 100;
  return { neto, iva };
}
const CBTE_TIPO = { A: 1, B: 6, C: 11 };
function docTipoFromCliente(clienteCuit) {
  if (!clienteCuit) return 99; // consumidor final
  const s = String(clienteCuit).replace(/\D/g, '');
  return s.length === 11 ? 80 : 96; // CUIT | DNI
}

// AFIP RG 5616 — Condición IVA del receptor (obligatorio desde 11/2024).
// Códigos oficiales del padrón AFIP:
//   1  = IVA Responsable Inscripto
//   4  = IVA Sujeto Exento
//   5  = Consumidor Final
//   6  = Responsable Monotributo
//   7  = Sujeto No Categorizado
//   8  = Proveedor del Exterior
//   9  = Cliente del Exterior
//  10  = IVA Liberado – Ley Nº 19.640
//  13  = Monotributista Social
//  15  = IVA No Alcanzado
//  16  = Monotributo Trabajador Independiente Promovido
function condicionIvaReceptorId({ tipo, clienteCuit, clienteCondicion }) {
  // Si el llamador pasa una condición explícita (nombre humano) la mapeamos
  if (clienteCondicion) {
    const c = String(clienteCondicion).toLowerCase();
    if (/responsable inscripto/.test(c))  return 1;
    if (/exento/.test(c))                 return 4;
    if (/consumidor final/.test(c))       return 5;
    if (/monotribut(o|ista)/.test(c))     return 6;
    if (/no categorizado/.test(c))        return 7;
  }
  // Sin dato explícito: inferir por tipo de factura y presencia de CUIT.
  if (!clienteCuit) return 5;              // Consumidor Final
  if (tipo === 'A') return 1;              // Factura A sólo se emite a responsable inscripto
  /*
   * Con CUIT pero sin condición conocida se declara Consumidor Final.
   *
   * Antes, en una factura C, se devolvía 6 (Responsable Monotributo). Ese campo
   * describe al RECEPTOR, y que el emisor sea monotributista no dice nada de su
   * cliente: se le estaba atribuyendo una condición fiscal inventada a quien
   * recibe el comprobante. Consumidor final es lo que corresponde cuando no se
   * sabe, y es el valor que AFIP admite sin condicionamientos.
   */
  return 5;
}

// ── Solicitar CAE ─────────────────────────────────────────────────
async function solicitarCAE({ tipo, total, clienteCuit, clienteCondicion, businessCuit, puntoVenta, ambiente = 'homologacion' }) {
  if (isMock) {
    const cae = `${Date.now()}`.slice(0, 14).padEnd(14, '0');
    const vto = new Date(); vto.setDate(vto.getDate() + 10);
    log.info('arca', 'CAE simulado (modo mock)', { tipo });
    return {
      cae, caeVencimiento: vto.toISOString().slice(0, 10), numero: null,
      respuesta: { mock: true, tipo, total, clienteCuit },
    };
  }

  if (!businessCuit) throw Object.assign(new Error('Falta businessCuit (CUIT emisor).'), { status: 400 });
  if (!puntoVenta)   throw Object.assign(new Error('Falta puntoVenta configurado en ARCA para este CUIT.'), { status: 400 });

  const { cert, key } = loadCert(ambiente);
  const cli = loadClient();
  const cuitEmisor = String(businessCuit).replace(/\D/g, '');
  const cbteTipo = CBTE_TIPO[tipo] || CBTE_TIPO.B;
  const { neto, iva } = calcularIVA(total, tipo);

  // Consultar último número + 1
  const ultimo = await cli.feCompUltimoAutorizado({
    cert, key, ambiente, cuitEmisor,
    PtoVta: Number(puntoVenta), CbteTipo: cbteTipo,
  });
  const numero = ultimo + 1;

  const hoy = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const condReceptor = condicionIvaReceptorId({ tipo, clienteCuit, clienteCondicion });
  const FeCAEReq = {
    FeCabReq: {
      CantReg: 1, PtoVta: Number(puntoVenta), CbteTipo: cbteTipo,
    },
    FeDetReq: {
      FECAEDetRequest: {
        Concepto:                 1,
        DocTipo:                  docTipoFromCliente(clienteCuit),
        DocNro:                   clienteCuit ? Number(String(clienteCuit).replace(/\D/g, '')) : 0,
        CbteDesde:                numero, CbteHasta: numero, CbteFch: hoy,
        ImpTotal:                 Number(total), ImpTotConc: 0,
        ImpNeto:                  neto, ImpOpEx: 0,
        ImpIVA:                   iva, ImpTrib: 0,
        MonId:                    'PES', MonCotiz: 1,
        CondicionIVAReceptorId:   condReceptor, // RG 5616 — obligatorio desde 11/2024
        // Objeto IVA obligatorio si ImpNeto > 0 (aplica a factura A y B). Id=5 → 21%.
        ...(iva > 0 ? {
          Iva: { AlicIva: { Id: 5, BaseImp: neto, Importe: iva } },
        } : {}),
      },
    },
  };

  let result;
  try {
    result = await cli.feCAESolicitar({ cert, key, ambiente, cuitEmisor, FeCAEReq });
  } catch (err) {
    const msg = err.message || '';
    // Traducimos errores comunes a mensajes útiles para el usuario final
    if (/No aparecio CUIT en lista de relaciones/i.test(msg) || /600.*relaci/i.test(msg)) {
      throw Object.assign(new Error(
        `El CUIT ${cuitEmisor} no tiene delegado el servicio de facturación electrónica a Stocker en AFIP. ` +
        `Andá a Configurar ARCA de este CUIT y seguí el paso 2 (delegar wsfe a Stocker en Administrador de Relaciones AFIP), ` +
        `después probá con "Verificar" antes de intentar facturar.`
      ), { status: 400 });
    }
    if (/computador no autorizado/i.test(msg)) {
      throw Object.assign(new Error('El certificado de Stocker no está autorizado para wsfe en AFIP. Contactar soporte.'), { status: 502 });
    }
    throw err;
  }

  return {
    cae: result.CAE,
    caeVencimiento: result.CAEFchVto,
    numero, puntoVenta: Number(puntoVenta), ambiente,
    respuesta: { ...result, ambiente, puntoVenta, cbteTipo, numero },
  };
}

// ── Health check ──────────────────────────────────────────────────
async function checkStatus({ ambiente = 'homologacion' } = {}) {
  if (isMock) return { ok: true, mock: true };
  const stockerCuit = process.env.ARCA_STOCKER_CUIT;
  if (!stockerCuit) throw new Error('ARCA_STOCKER_CUIT no configurado.');
  const { cert, key } = loadCert(ambiente);
  const cli = loadClient();
  const st = await cli.feDummy({ cert, key, ambiente, cuitEmisor: stockerCuit });
  const ok = st.AppServer === 'OK' && st.DbServer === 'OK' && st.AuthServer === 'OK';
  return { ok, ambiente, ...st };
}

/*
 * Un pedazo legible de la respuesta de AFIP, para poder diagnosticar.
 *
 * Se queda con el cuerpo del resultado y descarta el sobre SOAP, que ocupa
 * mucho y no dice nada. No lleva token ni firma: esos van en el pedido, no en
 * la respuesta, así que este recorte se puede mostrar en pantalla.
 */
function recorte(xml) {
  if (!xml) return null;
  const cuerpo = xml.match(/<(?:\w+:)?FEParamGetPtosVentaResult>([\s\S]*?)<\/(?:\w+:)?FEParamGetPtosVentaResult>/);
  return (cuerpo ? cuerpo[1] : xml).replace(/\s+/g, ' ').trim().slice(0, 600);
}

// ── Verificar delegación de un CUIT ───────────────────────────────
async function verifyDelegation({ businessCuit, ambiente = 'homologacion' }) {
  if (isMock) return { ok: true, mock: true, note: 'ARCA_MOCK=true — verificación simulada.' };
  if (!businessCuit) throw new Error('Falta el CUIT del negocio a verificar.');
  const { cert, key } = loadCert(ambiente);
  const cli = loadClient();
  try {
    const { puntos, errores, xml } = await cli.feParamGetPtosVenta({
      cert, key, ambiente, cuitEmisor: String(businessCuit).replace(/\D/g, ''),
    });

    const base = { ambiente, puntosVenta: puntos, stockerCuit: process.env.ARCA_STOCKER_CUIT };

    /*
     * Los errores de AFIP se muestran tal cual, con su código.
     *
     * El 600 y el 601 son de credenciales o delegación; el 602 es "sin
     * resultados", que sí significa que no hay puntos de venta. Antes todos
     * terminaban en el mismo mensaje —"falta dar de alta el punto de venta"—
     * y mandaban a rehacer un trámite ya hecho mientras el problema real
     * estaba en otro lado.
     */
    const sinResultados = errores.every((x) => x.codigo === 602);
    if (errores.length && !sinResultados) {
      /*
       * ── ¿Falla el certificado, o falla la delegación? ───────────
       *
       * El 600 no distingue las dos cosas y son arreglos opuestos: uno se
       * resuelve en el AFIP del cliente y el otro en el nuestro. Se pregunta lo
       * mismo por el CUIT de Stocker, que no necesita delegación de nadie:
       *
       *   · Si por Stocker anda, el certificado, el WSAA y el ambiente están
       *     bien. Lo único que falta es la relación de este cliente, y no tiene
       *     sentido hacerle revisar nuestro certificado.
       *   · Si por Stocker TAMBIÉN falla, el problema es nuestro y el cliente
       *     puede haber hecho todo bien. Mandarlo a rehacer el trámite sería
       *     hacerle perder el día por algo que no está de su lado.
       *
       * Es una llamada de más, y sólo se hace cuando ya falló: el costo es una
       * espera en el caso que igual estaba roto.
       */
      let certificadoPropio = null;
      const esDeRelaciones = errores.some((x) => [600, 601].includes(x.codigo));
      const cuitStocker = String(process.env.ARCA_STOCKER_CUIT || '').replace(/\D/g, '');
      if (esDeRelaciones && cuitStocker && cuitStocker !== String(businessCuit).replace(/\D/g, '')) {
        try {
          const propio = await cli.feParamGetPtosVenta({
            cert, key, ambiente, cuitEmisor: cuitStocker,
          });
          const fallaPropio = (propio.errores || []).some((x) => [600, 601].includes(x.codigo));
          certificadoPropio = fallaPropio ? 'falla' : 'anda';
        } catch {
          // Que la comprobación de más no se lleve puesto el diagnóstico
          // principal: sin ella el mensaje es peor, no inexistente.
          certificadoPropio = null;
        }
      }

      return {
        ...base,
        certificadoPropio,
        ok: false,
        listoParaFacturar: false,
        error: errores.map((x) => `[${x.codigo}] ${x.mensaje}`).join(' · '),
        /*
         * El 600 nombra las dos puntas y el ambiente.
         *
         * "No apareció CUIT en lista de relaciones" no dice de quién a quién
         * falta la relación, y sin eso el mensaje no se puede accionar: hay que
         * saber que el token es de un CUIT y que se está pidiendo facturar por
         * otro. El ambiente va incluido porque las delegaciones de homologación
         * y de producción son dos listas distintas, y hacer el trámite en una y
         * consultar la otra da exactamente este error.
         */
        hint: esDeRelaciones
          ? `AFIP no reconoce que ${process.env.ARCA_STOCKER_CUIT} pueda facturar por ${String(businessCuit).replace(/\D/g, '')} en ${ambiente}.`
            + (certificadoPropio === 'anda'
              ? ' El certificado de Stocker sí factura por su propio CUIT en este ambiente, así que lo que falta es la relación de ESTE cliente, no el certificado.'
              : certificadoPropio === 'falla'
                ? ' Ojo: el certificado de Stocker tampoco factura por su propio CUIT en este ambiente. El problema es del certificado o del ambiente, no de la delegación del cliente.'
                : '')
          : null,
        /*
         * Las tres causas, en orden de probabilidad.
         *
         * La primera es la que más cuesta encontrar: la delegación CUIT a CUIT
         * se ve aceptada en el Administrador de Relaciones y aun así falla,
         * porque el token lo firma el certificado y la relación no lo nombra.
         * Mientras el mensaje decía sólo "revisá la delegación", el trámite ya
         * hecho parecía el problema y nadie miraba el paso que faltaba.
         */
        causas: !esDeRelaciones ? undefined : certificadoPropio === 'falla' ? [
          'El certificado de Stocker no está habilitado para "Facturación Electrónica" en este ambiente, o el que está cargado no es el del ambiente que se consultó.',
          'No hace falta que el cliente toque nada: el trámite que falta es de nuestro lado.',
        ] : [
          'El certificado no está asignado a esa delegación. Aunque el cliente ya delegó "Facturación Electrónica" y figure Aceptada, falta crear la relación que nombra al Computador Fiscal como representante. Es el paso que habilita el "Delegable: SI".',
          'El servicio delegado es otro: "Comprobantes en línea" es para facturar a mano desde el sitio de AFIP; para Stocker tiene que ser "Facturación Electrónica" (webservice wsfe).',
          `El trámite se hizo en el otro ambiente: las relaciones de homologación y de producción son listas separadas, y acá se consultó ${ambiente}.`,
          /*
           * La cuarta, que es la que queda cuando el cliente jura haber hecho
           * las tres anteriores. Y es la más fácil de hacer mal, porque la
           * pantalla se ve igual en los dos casos.
           */
          'La relación del Computador Fiscal se creó en nombre propio y no en nombre del cliente. En el Administrador de Relaciones hay que entrar primero por "Actuar en nombre de" y elegir al cliente; recién ahí, "Nueva relación" → servicio "Facturación Electrónica" → representante: el alias del certificado. Hecho en nombre propio, la relación queda apuntando a nuestro CUIT y el token sale sin el del cliente, que es exactamente este error.',
        ],
        erroresAfip: errores,
      };
    }

    /*
     * Que AFIP conteste ya prueba que la delegación existe: si no nos hubiera
     * autorizado, la llamada fallaría. Pero la lista puede venir vacía, y ahí
     * la delegación está bien y facturar igual no se puede — falta que el CUIT
     * dé de alta un punto de venta electrónico en AFIP.
     */
    const activos = puntos.filter((p) => !p.Bloqueado && !p.FchBaja);

    if (activos.length === 0) {
      /*
       * Distinguir "no hay ninguno" de "hay pero están todos dados de baja".
       *
       * Mandar a dar de alta un punto de venta a alguien que ya lo tiene, sólo
       * que bloqueado, es hacerle repetir el trámite equivocado.
       */
      const hayPeroInactivos = puntos.length > 0;
      return {
        ...base,
        ok: true,
        listoParaFacturar: false,
        advertencia: hayPeroInactivos
          ? `Este CUIT tiene ${puntos.length} punto(s) de venta en AFIP, pero todos figuran bloqueados o dados de baja.`
          : 'La delegación está bien, pero en este ambiente AFIP no devuelve ningún punto de venta para este CUIT.',
        // Cuando AFIP no devolvió nada y tampoco explicó por qué, viaja un
        // recorte de la respuesta: es la única forma de que el que está
        // trabado pueda ver qué contestó AFIP en lugar de nuestra conjetura.
        respuestaAfip: puntos.length === 0 ? recorte(xml) : undefined,
        pasos: hayPeroInactivos
          ? [
            'Entrá a afip.gob.ar con clave fiscal del CUIT que factura.',
            'Servicio "Administración de Puntos de Venta y Domicilios" → A/B/M de puntos de venta.',
            'Verificá que el punto de venta no esté dado de baja y volvé a habilitarlo.',
          ]
          : [
            'Confirmá el ambiente: los puntos de venta de homologación y de producción son distintos. Si lo diste de alta en el AFIP real, acá tiene que decir "producción".',
            'Entrá a afip.gob.ar con clave fiscal del CUIT que factura.',
            'Buscá el servicio "Administración de Puntos de Venta y Domicilios".',
            'Elegí la empresa, entrá a "A/B/M de puntos de venta" y tocá "Agregar".',
            'Como sistema elegí "RECE para aplicativo y web services" (comprobantes electrónicos).',
            'Asociá el domicilio fiscal y guardá. Anotá el número que te asigna.',
            'Volvé acá, cargá ese número como Punto de Venta y verificá de nuevo.',
          ],
      };
    }

    return { ...base, ok: true, listoParaFacturar: true };
  } catch (err) {
    const msg = err.message || String(err);
    const hint =
      /puntos? de venta/i.test(msg)             ? 'El CUIT delegó el servicio pero todavía no dio de alta un Punto de Venta electrónico en AFIP.' :
      /autoriz|denegada|600|delega/i.test(msg)  ? 'El CUIT no nos delegó el servicio wsfe. Revisar Administrador de Relaciones en AFIP.' :
      /computador/i.test(msg)                   ? 'Nuestro certificado no está autorizado en AFIP.' :
      null;
    return { ok: false, ambiente, error: msg, hint };
  }
}

// ── Debug: config actual sin llamar a AFIP ────────────────────────
function debugConfig() {
  const homoCert = process.env.ARCA_CERT_PATH_HOMO || null;
  const homoKey  = process.env.ARCA_KEY_PATH_HOMO  || null;
  const prodCert = process.env.ARCA_CERT_PATH_PROD || null;
  const prodKey  = process.env.ARCA_KEY_PATH_PROD  || null;
  const genCert  = process.env.ARCA_CERT_PATH      || null;
  const genKey   = process.env.ARCA_KEY_PATH       || null;
  const effHomoCert = homoCert || genCert;
  const effHomoKey  = homoKey  || genKey;
  const effProdCert = prodCert || genCert;
  const effProdKey  = prodKey  || genKey;
  const status = (p) => (p ? (fs.existsSync(p) ? 'existe' : 'FALTA') : '(sin setear)');
  return {
    mock: isMock,
    stockerCuit: process.env.ARCA_STOCKER_CUIT || null,
    ambientes: {
      homologacion: {
        certPath: effHomoCert, certStatus: status(effHomoCert),
        keyPath:  effHomoKey,  keyStatus:  status(effHomoKey),
        wsaaHost: 'wsaahomo.afip.gov.ar',
        wsfeHost: 'wswhomo.afip.gov.ar',
      },
      produccion: {
        certPath: effProdCert, certStatus: status(effProdCert),
        keyPath:  effProdKey,  keyStatus:  status(effProdKey),
        wsaaHost: 'wsaa.afip.gov.ar',
        wsfeHost: 'servicios1.afip.gov.ar',
      },
    },
    envVars: {
      ARCA_CERT_PATH_HOMO: !!homoCert, ARCA_KEY_PATH_HOMO: !!homoKey,
      ARCA_CERT_PATH_PROD: !!prodCert, ARCA_KEY_PATH_PROD: !!prodKey,
      ARCA_CERT_PATH:      !!genCert,  ARCA_KEY_PATH:      !!genKey,
    },
  };
}

module.exports = {
  tipoComprobante,
  solicitarCAE, determineInvoiceType, calcularIVA,
  checkStatus, verifyDelegation, debugConfig,
};
