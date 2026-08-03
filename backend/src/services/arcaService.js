// Integración ARCA (ex-AFIP) — WSFEv1 vía afipsdk.
// Modo de operación:
//   - ARCA_MOCK=true → CAE simulado, sin llamadas reales. Ideal para dev.
//   - ARCA_MOCK=false → integración real. Usa el certificado de Stocker y
//     el CUIT del cliente por delegación (opción B).
//
// Requiere en .env (solo para modo real):
//   ARCA_STOCKER_CUIT    → el CUIT del titular del certificado (nuestro, único).
//   ARCA_CERT_PATH       → ruta absoluta al .crt firmado por AFIP.
//   ARCA_KEY_PATH        → ruta absoluta a la private key generada.
//
// Cada llamada real requiere `businessCuit` (CUIT del NEGOCIO cliente,
// que nos delegó el servicio wsfe desde su Administrador de Relaciones AFIP)
// y `ambiente` ('homologacion' o 'produccion').

const fs   = require('fs');
const path = require('path');

const isMock = process.env.ARCA_MOCK === 'true';

let AfipLib = null;
function loadAfip() {
  if (AfipLib) return AfipLib;
  try { AfipLib = require('@afipsdk/afip.js'); return AfipLib; }
  catch (err) { throw new Error('@afipsdk/afip.js no está instalado. Corré `npm install @afipsdk/afip.js`.'); }
}

// Cache de instancias por (cuitCliente + ambiente) — así no releemos el cert cada vez.
const afipCache = new Map();
function getAfipInstance({ cuitCliente, ambiente }) {
  const key = `${cuitCliente}::${ambiente}`;
  if (afipCache.has(key)) return afipCache.get(key);

  const certPath = process.env.ARCA_CERT_PATH;
  const keyPath  = process.env.ARCA_KEY_PATH;
  if (!certPath || !keyPath) throw new Error('ARCA_CERT_PATH y ARCA_KEY_PATH deben estar configurados.');
  if (!fs.existsSync(certPath)) throw new Error(`No existe el certificado en ${certPath}.`);
  if (!fs.existsSync(keyPath))  throw new Error(`No existe la key en ${keyPath}.`);

  const Afip = loadAfip();
  const instance = new Afip({
    CUIT: Number(cuitCliente),               // CUIT del cliente en cuyo nombre facturamos
    cert: fs.readFileSync(certPath, 'utf8'), // nuestro certificado (misma para todos los clientes)
    key:  fs.readFileSync(keyPath,  'utf8'),
    production: ambiente === 'produccion',
    // access_token opcional — omitido, usa el TA local que la lib maneja
  });
  afipCache.set(key, instance);
  return instance;
}

// Tipo de factura según el receptor
function determineInvoiceType(clienteCuit) {
  if (!clienteCuit) return 'B';
  const stripped = String(clienteCuit).replace(/\D/g, '');
  return stripped.length === 11 ? 'A' : 'B';
}

// Calcula IVA solo para Factura A
function calcularIVA(total, tipoFactura) {
  if (tipoFactura !== 'A') return { neto: Number(total), iva: 0 };
  const neto = Math.round(Number(total) / 1.21 * 100) / 100;
  const iva  = Math.round((Number(total) - neto) * 100) / 100;
  return { neto, iva };
}

// Códigos AFIP para tipo de comprobante (WSFEv1)
const CBTE_TIPO = { A: 1, B: 6, C: 11 };
// Doc del receptor: 80 = CUIT, 96 = DNI, 99 = consumidor final
function docTipoFromCliente(clienteCuit) {
  if (!clienteCuit) return 99;
  const s = String(clienteCuit).replace(/\D/g, '');
  return s.length === 11 ? 80 : 96;
}

/**
 * Solicita CAE a ARCA para una factura.
 *
 * En modo real esperamos también:
 *   - businessCuit: CUIT del negocio emisor (cliente Stocker que nos delegó wsfe)
 *   - puntoVenta:   número del punto de venta electrónico dado de alta en AFIP
 *   - ambiente:     'homologacion' | 'produccion'
 *   - conceptoIva:  opcional, alícuota (por ahora fijo 21%)
 */
async function solicitarCAE({ tipo, total, clienteCuit, businessCuit, puntoVenta, ambiente = 'homologacion', items }) {
  if (isMock) {
    const cae = `${Date.now()}`.slice(0, 14).padEnd(14, '0');
    const vto = new Date(); vto.setDate(vto.getDate() + 10);
    console.log(`[ARCA MOCK] CAE simulado ${cae} tipo=${tipo} total=${total}`);
    return {
      cae,
      caeVencimiento: vto.toISOString().slice(0, 10),
      numero: null,
      respuesta: { mock: true, tipo, total, clienteCuit },
    };
  }

  if (!businessCuit) throw new Error('Falta businessCuit para facturar (CUIT emisor).');
  if (!puntoVenta)   throw new Error('Falta puntoVenta configurado en ARCA para este CUIT.');

  const afip = getAfipInstance({ cuitCliente: businessCuit, ambiente });
  const cbteTipo = CBTE_TIPO[tipo] || CBTE_TIPO.B;
  const { neto, iva } = calcularIVA(total, tipo);

  // Consultar último número emitido y sumar 1
  const ultimo = await afip.ElectronicBilling.getLastVoucher(Number(puntoVenta), cbteTipo);
  const numero = Number(ultimo) + 1;

  const hoy = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const data = {
    CantReg:   1,
    PtoVta:    Number(puntoVenta),
    CbteTipo:  cbteTipo,
    Concepto:  1, // 1=Productos, 2=Servicios, 3=Ambos
    DocTipo:   docTipoFromCliente(clienteCuit),
    DocNro:    clienteCuit ? Number(String(clienteCuit).replace(/\D/g, '')) : 0,
    CbteDesde: numero,
    CbteHasta: numero,
    CbteFch:   hoy,
    ImpTotal:  Number(total),
    ImpTotConc: 0,
    ImpNeto:   neto,
    ImpOpEx:   0,
    ImpIVA:    iva,
    ImpTrib:   0,
    MonId:     'PES',
    MonCotiz:  1,
  };
  if (tipo === 'A' && iva > 0) {
    data.Iva = [{ Id: 5, BaseImp: neto, Importe: iva }]; // Id=5 → 21%
  }

  const res = await afip.ElectronicBilling.createVoucher(data);
  return {
    cae:            res.CAE,
    caeVencimiento: (res.CAEFchVto || '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
    numero,
    puntoVenta:     Number(puntoVenta),
    ambiente,
    respuesta:      { ...res, ambiente, puntoVenta, cbteTipo, numero },
  };
}

// FEDummy: chequeo básico de conectividad + estado de los sub-servicios (auth, db, appserver).
// Sirve para probar que nuestro cert está bien y el ambiente responde.
async function checkStatus({ ambiente = 'homologacion' } = {}) {
  if (isMock) return { ok: true, mock: true };
  const stockerCuit = process.env.ARCA_STOCKER_CUIT;
  if (!stockerCuit) throw new Error('ARCA_STOCKER_CUIT no configurado en .env');
  const afip = getAfipInstance({ cuitCliente: stockerCuit, ambiente });
  const res = await afip.ElectronicBilling.getServerStatus();
  const ok = res.AppServer === 'OK' && res.DbServer === 'OK' && res.AuthServer === 'OK';
  return { ok, ambiente, ...res };
}

// Verifica que un CUIT dado nos haya delegado el servicio wsfe.
// Truco: getSalesPoints() consulta al servicio en representación del CUIT declarado.
// Si el CUIT NO nos delegó, AFIP devuelve error 600 (autorización insuficiente).
async function verifyDelegation({ businessCuit, ambiente = 'homologacion' }) {
  if (isMock) return { ok: true, mock: true, note: 'ARCA_MOCK=true — verificación simulada.' };
  const stockerCuit = process.env.ARCA_STOCKER_CUIT;
  if (!stockerCuit) throw new Error('ARCA_STOCKER_CUIT no configurado en .env');
  if (!businessCuit) throw new Error('Falta el CUIT del negocio a verificar.');

  const afip = getAfipInstance({ cuitCliente: businessCuit, ambiente });
  try {
    const sp = await afip.ElectronicBilling.getSalesPoints();
    return { ok: true, ambiente, puntosVenta: sp, stockerCuit };
  } catch (err) {
    const msg = err.message || String(err);
    // Errores típicos:
    //   - "Computador no autorizado" → cert mal cargado en AFIP
    //   - "600" o "Autorización" → no hay delegación de wsfe
    //   - "No hay Puntos de Venta" (600 sub 3005) → el CUIT sí delegó pero no dio de alta un punto electrónico
    const hint =
      /puntos? de venta/i.test(msg)     ? 'El CUIT delegó el servicio pero todavía no dio de alta un Punto de Venta electrónico en AFIP.' :
      /autoriz|600|delega/i.test(msg)   ? 'El CUIT no nos delegó el servicio wsfe. Revisar Administrador de Relaciones en AFIP.' :
      /computador|comput_?no.*aut/i.test(msg) ? 'Nuestro certificado no está autorizado en AFIP. Revisar Administrador de Certificados Digitales.' :
      null;
    return { ok: false, ambiente, error: msg, hint };
  }
}

module.exports = {
  solicitarCAE,
  determineInvoiceType,
  calcularIVA,
  checkStatus,
  verifyDelegation,
};
