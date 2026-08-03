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
    return { ...base, ...cached.data, source: 'cache' };
  }

  const padron = await fetchFromExternalApi(cuit);
  if (padron) {
    cache.set(cuit, { at: Date.now(), data: padron });
    return { ...base, ...padron, source: 'padron' };
  }
  return { ...base, source: 'local-only' };
}

module.exports = { lookupCuit, validateCuit, tipoPersona, tipoFacturaSugerido, extraerDni };
