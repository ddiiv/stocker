const { sendWhatsappMessage, normalizeToE164 } = require('../services/whatsappService');

// POST /api/whatsapp/test  { to, text }
// Endpoint de diagnóstico: manda un mensaje y devuelve el response completo de Meta
// para debuggear por qué no llega (número no autorizado, template caído, etc.).
const testSend = async (req, res, next) => {
  try {
    const to = req.body?.to || req.query?.to;
    const text = req.body?.text || req.query?.text || 'Test desde Stocker · WhatsApp Meta OK';
    if (!to) return res.status(400).json({ message: 'Falta parámetro "to" (número de destino).' });
    const normalized = normalizeToE164(to);

    const provider = process.env.WHATSAPP_META_TOKEN ? 'meta' : (process.env.WHATSAPP_API_KEY ? 'callmebot' : 'ninguno');
    const config = {
      provider,
      phoneNumberId: process.env.WHATSAPP_META_PHONE_NUMBER_ID || null,
      apiVersion:    process.env.WHATSAPP_META_API_VERSION || 'v22.0',
      templateName:  process.env.WHATSAPP_TEMPLATE_NAME || null,
      templateLang:  process.env.WHATSAPP_TEMPLATE_LANG || 'es_AR',
      tokenPreview:  process.env.WHATSAPP_META_TOKEN ? (process.env.WHATSAPP_META_TOKEN.slice(0, 10) + '…' + process.env.WHATSAPP_META_TOKEN.slice(-4)) : null,
    };

    const result = await sendWhatsappMessage({ telefono: to, mensaje: text });
    res.json({
      inputTo: to,
      normalizedTo: normalized,
      config,
      result,
      hints: [
        result.ok && !result.waId ? 'La API aceptó pero no confirma wa_id — probablemente el número no está en WhatsApp o Meta lo descartó.' : null,
        result.code === 131030 ? 'Número no está en la lista de destinatarios permitidos (números de prueba de Meta requieren pre-registro).' : null,
        result.code === 131047 || result.code === 131026 ? 'Fuera de ventana de 24h — se intentó template, verificar que exista y esté APPROVED en Business Manager.' : null,
        result.code === 132001 ? 'El template no existe o no está aprobado. Revisar WHATSAPP_TEMPLATE_NAME y WHATSAPP_TEMPLATE_LANG.' : null,
        result.code === 190 ? 'Token expirado o inválido — generar uno nuevo en la app de Meta Developers.' : null,
        !result.ok && !result.code ? 'Sin credenciales de Meta — verificá WHATSAPP_META_TOKEN y WHATSAPP_META_PHONE_NUMBER_ID en .env.' : null,
      ].filter(Boolean),
    });
  } catch (error) { next(error); }
};

module.exports = { testSend };
