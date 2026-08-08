const axios = require('axios');

// Cache en memoria para no golpear la API externa repetidas veces (24h)
const cache = new Map();
const TTL_MS = 24 * 60 * 60 * 1000;

// ── Validación local del dígito verificador ──────────────────────
function validateCuit(rawCuit) {
  const cuit = String(rawCuit || '').replace(/[^0-9]/g, '');
  if (cuit.length !== 11) return false;
  const mult = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(cuit[i]) * mult[i];
  let dv = 11 - (sum % 11);
  if (dv === 11) dv = 0;
  if (dv === 10) return false;
  return dv === Number(cuit[10]);
}

// Tipo de persona según los dos primeros dígitos del CUIT
function tipoPersona(cuit) {
  const c = String(cuit).replace(/[^0-9]/g, '');
  const prefix = c.slice(0, 2);
  if (['20', '23', '24', '27', '25', '26'].includes(prefix)) return 'fisica';
  if (['30', '33', '34'].includes(prefix)) return 'juridica';
  if (['50', '51', '55'].includes(prefix)) return 'extranjera';
  return 'desconocida';
}

// Sexo probable según el prefijo (útil para personas físicas)
function sexoProbable(cuit) {
  const p = String(cuit).replace(/[^0-9]/g, '').slice(0, 2);
  if (p === '20') return 'M';
  if (p === '27') return 'F';
  return null; // 23/24 son mixtos, 30+ jurídicas
}

// Extraer el DNI del CUIT (personas físicas): dígitos 3 al 10.
// Ej: 20-12345678-6 → DNI 12345678.
function extraerDni(cuit) {
  const c = String(cuit).replace(/[^0-9]/g, '');
  if (c.length !== 11) return null;
  if (tipoPersona(c) !== 'fisica') return null;
  return c.slice(2, 10).replace(/^0+/, '') || null;
}

// Sugerir tipo de factura y de cliente
function tipoFacturaSugerido(cuit) {
  return tipoPersona(cuit) === 'juridica' ? 'A' : 'B';
}
function tipoClienteSugerido(cuit) {
  return tipoPersona(cuit) === 'juridica' ? 'empresa' : 'minorista';
}

// ── Consulta a API externa configurable ───────────────────────────
// Si el usuario define CUIT_API_URL en .env, se hace una request GET reemplazando
// {cuit} en la URL. La respuesta debe ser JSON. Se mapean campos comunes.
// Con CUIT_API_KEY se agrega header Authorization: Bearer <key> (o el header
// custom definido en CUIT_API_AUTH_HEADER, ej "x-api-key").
async function fetchFromExternalApi(cuit) {
  const template = process.env.CUIT_API_URL;
  if (!template) return null;
  try {
    const url = template.replace('{cuit}', cuit);
    const headers = {};
    if (process.env.CUIT_API_KEY) {
      const headerName = process.env.CUIT_API_AUTH_HEADER || 'Authorization';
      const prefix     = headerName.toLowerCase() === 'authorization' ? 'Bearer ' : '';
      headers[headerName] = prefix + process.env.CUIT_API_KEY;
    }
    const { data } = await axios.get(url, { timeout: 5000, headers });
    if (!data || typeof data !== 'object') return null;

    // Mapeo tolerante — soporta shapes distintos que devuelven las APIs conocidas.
    const razonSocial =
      data.razonSocial || data.razon_social || data.nombre_completo ||
      data.denominacion || data.name || data.nombre ||
      [data.apellido, data.nombre].filter(Boolean).join(', ') || null;

    return {
      razonSocial,
      apellido:      data.apellido || null,
      nombreSolo:    !data.apellido && (data.nombre || data.name) ? (data.nombre || data.name) : null,
      condicionIva:  data.condicionIva || data.condicion_iva || data.condicion || data.tipoContribuyente || null,
      domicilio:     data.domicilio || data.direccion || data.address || null,
      localidad:     data.localidad || data.city || null,
      provincia:     data.provincia || data.state || null,
      codigoPostal:  data.cp || data.codigoPostal || data.zip || null,
      actividad:     data.actividad || data.actividadPrincipal || null,
    };
  } catch {
    return null;
  }
}

// Consulta directa al padrón oficial de AFIP usando nuestro cert.
// Es la fuente autoritativa — mejor que cualquier API externa. Requiere
// que el CUIT de Stocker tenga adherido "ws_sr_constancia_inscripcion" en AFIP.
async function fetchFromAfipPadron(cuit) {
  if (process.env.ARCA_MOCK === 'true') return null;
  const stockerCuit = process.env.ARCA_STOCKER_CUIT;
  if (!stockerCuit) return null;
  // El padrón SOLO existe en producción (homologación no autoriza ws_sr_*).
  // Como es una consulta de solo lectura (no emite comprobantes), usamos
  // siempre el cert productivo aunque estemos facturando en homologación.
  const { loadCredentials } = require('./arcaCredentials');
  const creds = loadCredentials('produccion');
  if (!creds) return null;
  try {
    const arcaClient = require('./arcaClient');
    const data = await arcaClient.padronA5({
      cert: creds.cert,
      key:  creds.key,
      ambiente: 'produccion',
      cuitConsultado: cuit,
    });
    return {
      razonSocial:    data.razonSocial,
      apellido:       data.apellido,
      // `nombre` es el nombre de pila tal cual lo da AFIP (para personas físicas).
      // `nombreSolo` queda para el caso sin apellido, donde el nombre es todo.
      nombre:         data.nombre,
      nombreSolo:     !data.apellido && data.nombre ? data.nombre : null,
      condicionIva:   data.condicionIva || null,
      condicionIvaId: data.condicionIvaId || null,
      domicilio:      data.domicilio?.direccion || null,
      localidad:      data.domicilio?.localidad || null,
      provincia:      data.domicilio?.descripcionProvincia || null,
      codigoPostal:   data.domicilio?.codPostal || null,
      actividad:      data.actividadPrincipal || null,
      estadoClave:    data.estadoClave || null,
      servicioUsado:  data.servicioUsado || null,
    };
  } catch (err) {
    const msg = err.message || '';
    // Errores "esperados" cuando el cert no tiene autorizado el padrón — silenciosos.
    // El caller cae automáticamente a validación local (comportamiento normal).
    if (/computador no autorizado/i.test(msg) || /ya posee un TA valido/i.test(msg)) {
      return null;
    }
    console.warn('[padron AFIP]', msg);
    return null;
  }
}

async function lookupCuit(rawCuit) {
  const cuit = String(rawCuit || '').replace(/[^0-9]/g, '');
  const valido = validateCuit(cuit);
  const base = {
    cuit,
    valido,
    tipoPersona:  valido ? tipoPersona(cuit)         : null,
    tipoFactura:  valido ? tipoFacturaSugerido(cuit) : null,
    tipoCliente:  valido ? tipoClienteSugerido(cuit) : null,
    dniInferido:  valido ? extraerDni(cuit)          : null,
    sexoProbable: valido ? sexoProbable(cuit)        : null,
  };
  if (!valido) return { ...base, source: 'local' };

  const cached = cache.get(cuit);
  if (cached && Date.now() - cached.at < TTL_MS) {
    const origen = cached.source === 'afip' ? 'AFIP (oficial, cacheado)' : 'API EXTERNA (NO AFIP, cacheado)';
    console.log(`[CUIT ${cuit}] Datos de ${origen}.`);
    return { ...base, ...cached.data, source: cached.source, lockedFields: cached.lockedFields || [] };
  }

  // Prioridad 1: padrón oficial AFIP (si tenemos cert configurado)
  const afip = await fetchFromAfipPadron(cuit);
  if (afip) {
    // Marcamos qué campos vinieron efectivamente de AFIP para que el
    // frontend los bloquee (son datos oficiales, no se deben editar).
    const lockedFields = [];
    if (afip.razonSocial || afip.apellido || afip.nombreSolo) lockedFields.push('nombre', 'apellido');
    if (afip.domicilio)    lockedFields.push('direccion');
    // Con la condición IVA real de AFIP el tipo de factura deja de ser una
    // heurística por prefijo de CUIT: solo un Responsable Inscripto lleva A.
    if (afip.condicionIvaId) base.tipoFactura = afip.condicionIvaId === 1 ? 'A' : 'B';
    cache.set(cuit, { at: Date.now(), data: afip, source: 'afip', lockedFields });
    console.log(`[CUIT ${cuit}] Datos OFICIALES de AFIP — padrón productivo vía ${afip.servicioUsado}. ${afip.razonSocial || ''} · ${afip.condicionIva || 'sin condición IVA'} · Factura ${base.tipoFactura}`);
    return { ...base, ...afip, source: 'afip', lockedFields };
  }

  // Prioridad 2: API externa configurable (fallback)
  const padron = await fetchFromExternalApi(cuit);
  if (padron) {
    cache.set(cuit, { at: Date.now(), data: padron, source: 'padron-externo', lockedFields: [] });
    console.log(`[CUIT ${cuit}] Datos de API EXTERNA (NO es AFIP) — CUIT_API_URL configurada. Fuente no oficial, puede estar desactualizada o ser incorrecta.`);
    return { ...base, ...padron, source: 'padron-externo' };
  }

  console.log(`[CUIT ${cuit}] Sin datos externos: solo validación local (dígito verificador + inferencia por prefijo). No se consultó AFIP ni ninguna API.`);
  return { ...base, source: 'local-only' };
}

module.exports = { lookupCuit, validateCuit, tipoPersona, tipoFacturaSugerido, extraerDni };
