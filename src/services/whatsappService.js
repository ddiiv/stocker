const axios = require('axios');
const { log, mask } = require('../utils/logger');

/*
 * Integración WhatsApp Cloud API (Meta) — proveedor por defecto.
 *
 * .env requerido:
 *   WHATSAPP_META_TOKEN            → System User Token o Temporary Access Token
 *   WHATSAPP_META_PHONE_NUMBER_ID  → ID del número (no es el número en sí, es el "Phone Number ID" del Business Manager)
 *   WHATSAPP_META_API_VERSION      → opcional, default v22.0
 *
 * Nota importante sobre las 24h window de Meta:
 *   - Podés mandar texto libre solo dentro de las 24h desde el último mensaje que
 *     ENVIÓ el cliente hacia tu número. Fuera de esa ventana solo se aceptan mensajes
 *     de tipo "template" (aprobados en Business Manager).
 *   - Este service intenta primero "text"; si Meta rechaza por ventana cerrada
 *     (error code 131047 o 131026) reintenta con el template configurado en
 *     WHATSAPP_TEMPLATE_NAME (código de idioma en WHATSAPP_TEMPLATE_LANG, default es_AR).
 *   - Si no configurás template, el fallback simplemente loguea el error.
 *
 * Legacy: si no hay WHATSAPP_META_TOKEN se usa CallMeBot (compatibilidad hacia atrás).
 */

// Normaliza el número al formato E.164 sin "+", dígitos solamente.
// Acepta: "+54 9 11 5551-2345", "011 5551 2345" (asume Argentina si no viene código), etc.
function normalizeToE164(raw, defaultCountryCode = '54') {
  const s = String(raw || '');
  const clean = s.replace(/\D/g, '');
  if (!clean) return null;
  if (s.trim().startsWith('+')) return clean; // ya trae código de país
  // Nacional argentino con 0 inicial (ej. "011 5551 2345") → sacamos el 0 y prefijamos 54
  if (clean.startsWith('0')) return defaultCountryCode + clean.replace(/^0+/, '');
  // Si ya tiene más de 11 dígitos asumimos que trae código de país
  if (clean.length >= 11) return clean;
  return defaultCountryCode + clean;
}

async function sendViaMeta({ to, text, templateName, templateLang }) {
  const token   = process.env.WHATSAPP_META_TOKEN;
  const phoneId = process.env.WHATSAPP_META_PHONE_NUMBER_ID;
  const version = process.env.WHATSAPP_META_API_VERSION || 'v22.0';
  const url = `https://graph.facebook.com/${version}/${phoneId}/messages`;

  async function post(body) {
    return axios.post(url, body, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 10000,
    });
  }

  function extractInfo(resData) {
    const contact = resData?.contacts?.[0];
    const msg     = resData?.messages?.[0];
    return {
      messageId: msg?.id || null,
      waId:      contact?.wa_id || null,      // si viene, el número está en WhatsApp
      inputPhone: contact?.input || null,
      msgStatus: msg?.message_status || null, // "accepted" no significa "entregado"
    };
  }

  const attempts = [];

  // 1) intento "text" (funciona dentro de la ventana de 24h)
  try {
    const res = await post({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } });
    const info = extractInfo(res.data);
    log.info('whatsapp', 'texto aceptado', { a: mask.telefono(to), estado: info.msgStatus || 'accepted' });
    return { ok: true, provider: 'meta', mode: 'text', ...info, raw: res.data };
  } catch (err) {
    const errData = err.response?.data?.error || {};
    const code    = errData.code;
    const msg     = errData.message || err.message;
    const details = errData.error_data?.details || errData.error_user_msg;
    console.error(`[whatsapp meta] TEXT falló code=${code} sub=${errData.error_subcode || '-'} msg="${msg}"${details ? ' details="' + details + '"' : ''}`);
    attempts.push({ mode: 'text', code, msg, details });

    // Códigos que se resuelven cambiando a template (fuera ventana 24h / mensaje no entregable)
    const needsTemplate = code === 131047 || code === 131026 || code === 131051 || code === 131056;
    if (!needsTemplate || !templateName) {
      return { ok: false, provider: 'meta', error: msg, code, details, attempts };
    }
    try {
      const res = await post({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: { name: templateName, language: { code: templateLang || 'es_AR' } },
      });
      const info = extractInfo(res.data);
      log.info('whatsapp', 'plantilla aceptada', { plantilla: templateName, a: mask.telefono(to) });
      return { ok: true, provider: 'meta', mode: 'template', template: templateName, ...info, raw: res.data };
    } catch (err2) {
      const errData2 = err2.response?.data?.error || {};
      const msg2 = errData2.message || err2.message;
      console.error(`[whatsapp meta] TEMPLATE ${templateName} falló code=${errData2.code} sub=${errData2.error_subcode || '-'} msg="${msg2}"`);
      attempts.push({ mode: 'template', template: templateName, code: errData2.code, msg: msg2 });
      return { ok: false, provider: 'meta', error: msg2, code: errData2.code, attempts };
    }
  }
}

async function sendViaCallMeBot({ to, text }) {
  const apiKey = process.env.WHATSAPP_API_KEY;
  const apiUrl = process.env.WHATSAPP_API_URL || 'https://api.callmebot.com/whatsapp.php';
  if (!apiKey) return { ok: false, provider: 'callmebot', error: 'sin API key' };
  try {
    await axios.get(apiUrl, { params: { phone: to, text, apikey: apiKey }, timeout: 10000 });
    return { ok: true, provider: 'callmebot' };
  } catch (err) {
    return { ok: false, provider: 'callmebot', error: err.message };
  }
}

// ── API pública ───────────────────────────────────────────────────
async function sendWhatsappMessage({ telefono, mensaje }) {
  const to = normalizeToE164(telefono);
  if (!to) {
    console.warn('[whatsapp] telefono vacío o inválido');
    return { ok: false, error: 'telefono inválido' };
  }

  const templateName = process.env.WHATSAPP_TEMPLATE_NAME || null;
  const templateLang = process.env.WHATSAPP_TEMPLATE_LANG || 'es_AR';

  let result;
  if (process.env.WHATSAPP_META_TOKEN && process.env.WHATSAPP_META_PHONE_NUMBER_ID) {
    result = await sendViaMeta({ to, text: mensaje, templateName, templateLang });
  } else if (process.env.WHATSAPP_API_KEY) {
    result = await sendViaCallMeBot({ to, text: mensaje });
  } else {
    console.warn('[whatsapp] Sin credenciales configuradas (WHATSAPP_META_TOKEN o WHATSAPP_API_KEY) — mensaje omitido');
    return { ok: false, error: 'sin credenciales' };
  }

  if (result.ok) log.info('whatsapp', 'mensaje enviado', { a: mask.telefono(to), proveedor: result.provider });
  return result;
}

async function sendInvoiceWhatsapp({ telefono, clienteNombre, invoice, business }) {
  if (!telefono) return;
  const mensaje =
    `✅ *${business.nombreNegocio}*\n\n` +
    `Hola ${clienteNombre} 👋\n\n` +
    `Tu factura *N° ${invoice.numero}* fue generada.\n` +
    `📋 Tipo: Factura *${invoice.tipo}*\n` +
    `💰 Total: *$${Number(invoice.total).toLocaleString('es-AR')}*\n` +
    `${invoice.cae ? `🔑 CAE: ${invoice.cae}\n` : ''}` +
    `\nTe mandamos también el PDF por email. ¡Gracias por tu compra!`;
  return sendWhatsappMessage({ telefono, mensaje });
}

async function sendSaleWhatsapp({ telefono, cliente, sale, business, emisor }) {
  if (!telefono) return;
  const nombreEmisor = emisor?.nombre || business.nombreNegocio;
  const clienteNombre = cliente?.nombre || 'cliente';
  const mensaje =
    `📦 *${nombreEmisor}*\n\n` +
    `Hola ${clienteNombre} 👋\n\n` +
    `Registramos tu ${sale.tipo === 'cotizacion' ? 'cotización' : 'pedido'} *${sale.numero}*.\n` +
    `💰 Total: *$${Number(sale.total).toLocaleString('es-AR')}*\n` +
    `📊 Estado: ${(sale.estado || '').toUpperCase()}\n` +
    (sale.medioPago ? `💳 Medio de pago: ${sale.medioPago}\n` : '') +
    `\nTe enviamos el detalle por email. ¡Gracias!`;
  return sendWhatsappMessage({ telefono, mensaje });
}

/*
 * Aviso de venta al WhatsApp del negocio.
 *
 * Distinto del que va al cliente: acá el dueño quiere ver QUÉ se vendió, no un
 * agradecimiento. Lleva el detalle de los ítems, el desglose de cobro y quién
 * la hizo — es el mensaje que se mira desde el celular sin abrir el sistema.
 *
 * El número sale del teléfono del dueño, y si no lo tiene, del del negocio.
 * Sin ninguno de los dos no se manda nada y no es un error: hay negocios que no
 * cargan teléfono.
 *
 * Se puede apagar con WHATSAPP_AVISAR_NEGOCIO=false. Existe la opción porque un
 * local con doscientas ventas al día recibe doscientos mensajes, y en la API de
 * Meta cada uno fuera de la ventana de 24 h se cobra.
 */
/*
 * Arma el texto del aviso, sin enviarlo.
 *
 * Está separado del envío a propósito: el contenido es lo que hay que poder
 * revisar —qué dice una venta fiada, cómo se corta un mayorista de cuarenta
 * ítems— y probarlo contra la función que envía significaría mandar mensajes de
 * prueba al teléfono de alguien.
 */
function armarAvisoVentaNegocio({ business, sale, items = [], cliente, empleado, local, emisor }) {
  const plata = (v) => `$${Number(v || 0).toLocaleString('es-AR')}`;

  /*
   * El detalle se corta a ocho líneas. WhatsApp recorta los mensajes largos con
   * un "leer más" y una venta mayorista de cuarenta ítems dejaría el total
   * escondido detrás de ese corte — justo el dato que se quiere ver.
   */
  const MAX_LINEAS = 8;
  const lineas = items.slice(0, MAX_LINEAS).map((i) => {
    const variante = [i.variante1Valor, i.variante2Valor].filter(Boolean).join(' · ');
    return `• ${i.cantidad} × ${i.titulo}${variante ? ` (${variante})` : ''} — ${plata(i.subtotal)}`;
  });
  if (items.length > MAX_LINEAS) {
    lineas.push(`• …y ${items.length - MAX_LINEAS} ítem(s) más`);
  }

  const esFiada = sale.condicionPago === 'cuenta_corriente';
  const quien = cliente
    ? [cliente.nombre, cliente.apellido].filter(Boolean).join(' ')
    : 'Consumidor final';

  return (
    `🧾 *${emisor?.nombre || business.nombreNegocio}*\n` +
    `Venta *${sale.numero}*\n\n` +
    `${lineas.join('\n')}\n\n` +
    `👤 ${quien}\n` +
    (empleado ? `🙋 Vendió: ${[empleado.nombre, empleado.apellido].filter(Boolean).join(' ')}\n` : '') +
    (local?.nombre ? `📍 ${local.nombre}\n` : '') +
    `\n💰 Total: *${plata(sale.total)}*\n` +
    // Lo cobrado sólo si difiere del total: con recargo son números distintos y
    // hay que ver el que entró de verdad.
    (Number(sale.recargoPagos) ? `💵 Cobrado: *${plata(sale.totalCobrado)}* (con recargo)\n` : '') +
    (esFiada
      ? `⏳ *FIADA* — queda a cuenta de ${quien}\n`
      : sale.medioPago ? `💳 ${sale.medioPago}\n` : '') +
    (Number(sale.saldoPendiente) > 0 && !esFiada
      ? `⚠️ Pendiente de cobro: ${plata(sale.saldoPendiente)}\n`
      : '')
  );
}

async function sendSaleNotificationWhatsapp(datos) {
  if (process.env.WHATSAPP_AVISAR_NEGOCIO === 'false') return;

  const { business } = datos;
  const telefono = business?.ownerTelefono || business?.telefono;
  if (!telefono) return;

  return sendWhatsappMessage({ telefono, mensaje: armarAvisoVentaNegocio(datos) });
}

module.exports = {
  sendWhatsappMessage, sendInvoiceWhatsapp, sendSaleWhatsapp,
  sendSaleNotificationWhatsapp, armarAvisoVentaNegocio, normalizeToE164,
};
