const { log } = require('../utils/logger');

/*
 * Cobro de las suscripciones de Stocker por Mercado Pago.
 *
 * OJO con la confusión fácil: esto NO es la integración de Mercado Libre que
 * usan los negocios para vender. Esto cobra Stocker a sus clientes, contra la
 * cuenta de Mercado Pago del dueño de Stocker. Son credenciales distintas.
 *
 * Dos modos, porque sirven para cosas distintas:
 *
 *   preferencia  → link de pago por un mes suelto. Sirve para cobrar el
 *                  primer mes, para un Enterprise cotizado a mano y para
 *                  quien no quiere dejar débito automático.
 *   preapproval  → débito recurrente mensual. Es lo que evita perseguir el
 *                  cobro todos los meses.
 *
 * Se habla con la API por fetch y sin SDK: son cuatro endpoints y el SDK
 * arrastra dependencias que hay que auditar y actualizar.
 *
 * Sin MP_ACCESS_TOKEN nada de esto explota: `estaConfigurado()` devuelve false
 * y el resto del sistema sigue andando con transferencia bancaria. Es a
 * propósito — el cobro no puede ser requisito para que el producto arranque.
 */

const API = 'https://api.mercadopago.com';

/*
 * Referencia externa: viaja a Mercado Pago y vuelve en el aviso.
 *
 * Es un texto compacto y no un JSON. Dos razones: se puede buscar tal cual en
 * la API de pagos (`?external_reference=...`), que es lo que permite confirmar
 * un cobro sin depender del webhook; y en el panel de Mercado Pago se lee de un
 * vistazo en vez de aparecer como una llave escapada.
 */
const refExterna = ({ businessId, subscriptionId }) => `stocker-${businessId}-${subscriptionId}`;

/** Entiende el formato compacto y el JSON viejo, para no perder cobros previos. */
function leerRef(texto) {
  const bruto = String(texto || '');
  const compacto = bruto.match(/^stocker-(\d+)-(\d+)$/);
  if (compacto) {
    return { businessId: Number(compacto[1]), subscriptionId: Number(compacto[2]) };
  }
  try {
    const j = JSON.parse(bruto);
    if (j && j.businessId) return { businessId: Number(j.businessId), subscriptionId: Number(j.subscriptionId) };
  } catch { /* referencia de otra integración */ }
  return null;
}

const config = () => ({
  token:   process.env.MP_ACCESS_TOKEN || '',
  // A dónde vuelve el usuario después de pagar y a dónde avisa MP del cobro.
  backUrl: process.env.MP_BACK_URL || `${process.env.APP_URL || ''}/cuenta/suscripcion`,
  webhook: process.env.MP_WEBHOOK_URL || `${process.env.API_URL || ''}/api/billing/webhook/mercadopago`,
  // Firma de los webhooks. Sin esto cualquiera podría avisar "ya pagó".
  secretoWebhook: process.env.MP_WEBHOOK_SECRET || '',
});

const estaConfigurado = () => Boolean(config().token);

/*
 * Revisa que las URLs sirvan de verdad.
 *
 * Es el error que más cuesta encontrar, porque no falla: el pago se genera, el
 * cliente paga, y el aviso se manda a una dirección que no existe. La plata
 * entra y la cuenta queda sin activar, sin ningún mensaje de error en el medio.
 *
 * Se revisa acá y no en el arranque solamente, para que la pantalla de Cobros
 * pueda mostrarlo.
 */
function problemasDeUrls() {
  const c = config();
  const problemas = [];

  const revisar = (nombre, url, queEs) => {
    if (!url) {
      problemas.push(`${nombre} está vacía: ${queEs}`);
      return;
    }
    if (/localhost|127\.0\.0\.1|\[::1\]/i.test(url)) {
      problemas.push(
        `${nombre} apunta a localhost. Mercado Pago no puede alcanzar tu máquina: ${queEs}`
      );
      return;
    }
    if (process.env.NODE_ENV === 'production' && !/^https:\/\//i.test(url)) {
      problemas.push(`${nombre} tiene que ser https en producción.`);
    }
  };

  revisar('MP_WEBHOOK_URL', c.webhook,
    'los pagos no se van a acreditar solos y hay que aprobarlos a mano desde el backoffice.');
  revisar('MP_BACK_URL', c.backUrl,
    'el cliente va a ver un error de conexión al volver de pagar.');

  return problemas;
}

/*
 * Estado de la configuración, sin exponer secretos.
 *
 * Existe porque el primer intento de cobro real siempre falla por algo chico:
 * el token es de prueba y se esperaba producción, falta la URL del webhook,
 * o el secreto de firma no se copió. Adivinar cuál de las tres es la parte
 * lenta; esto lo dice de una.
 */
async function diagnostico() {
  const c = config();
  const base = {
    tokenCargado: Boolean(c.token),
    // Los tokens de prueba de Mercado Pago empiezan con TEST-. Distinguirlo
    // importa: con uno de prueba los pagos nunca acreditan plata de verdad.
    modo: !c.token ? 'sin configurar' : c.token.startsWith('TEST-') ? 'prueba' : 'produccion',
    // "Configurada" no alcanza: una URL a localhost está cargada y no sirve.
    webhookConfigurado: Boolean(c.webhook) && !/localhost|127\.0\.0\.1/i.test(c.webhook),
    webhookUrl: c.webhook || null,
    firmaVerificable: Boolean(c.secretoWebhook),
    urlDeRetorno: c.backUrl || null,
  };

  if (!c.token) {
    return { ...base, cuentaValida: false, problema: 'Falta MP_ACCESS_TOKEN.' };
  }

  // Se consulta la cuenta propia: es la forma de confirmar que el token es
  // válido sin crear nada ni cobrarle a nadie.
  try {
    const yo = await llamar('/users/me');
    return {
      ...base,
      cuentaValida: true,
      cuenta: {
        id: yo.id,
        apodo: yo.nickname || null,
        email: yo.email || null,
        pais: yo.site_id || null,
      },
      // Advertencias, no errores: el cobro funciona igual, pero con estas
      // cosas sin resolver hay que acreditar a mano.
      advertencias: [
        ...problemasDeUrls(),
        !base.firmaVerificable && 'Sin MP_WEBHOOK_SECRET el webhook no se puede verificar, así que se procesa igual pero queda registrado como no verificado.',
        base.modo === 'prueba' && 'El token es de prueba: los pagos no mueven plata real.',
      ].filter(Boolean),
    };
  } catch (e) {
    return { ...base, cuentaValida: false, problema: 'El token no fue aceptado por Mercado Pago. Revisá que sea el Access Token completo y de la aplicación correcta.' };
  }
}

class ErrorMercadoPago extends Error {
  constructor(mensaje, status = 502) {
    super(mensaje);
    this.status = status;
  }
}

/*
 * @param queFalla  qué se le dice al usuario si Mercado Pago no responde. Cada
 *   endpoint necesita el suyo: decir "no se pudo generar el pago" cuando lo que
 *   falló fue una consulta manda a la persona a intentar algo que no era.
 */
async function llamar(ruta, { method = 'GET', body, idempotencia, queFalla } = {}) {
  const { token } = config();
  if (!token) throw new ErrorMercadoPago('Mercado Pago no está configurado en este entorno.', 503);

  const res = await fetch(`${API}${ruta}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      // Evita que un reintento de red cobre dos veces.
      ...(idempotencia ? { 'X-Idempotency-Key': idempotencia } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const datos = await res.json().catch(() => ({}));
  if (!res.ok) {
    // El detalle va al log, no a la respuesta: puede traer datos de la cuenta
    // de cobro de Stocker que el cliente no tiene por qué ver.
    log.error('mercadopago', `${method} ${ruta} respondió ${res.status}`, { detalle: datos?.message });
    throw new ErrorMercadoPago(queFalla || 'Mercado Pago no respondió. Probá de nuevo en unos minutos.');
  }
  return datos;
}

/**
 * Link de pago por un período suelto.
 * @returns {{ id, initPoint, sandbox }}
 */
async function crearLinkDePago({ businessId, subscriptionId, plan, monto, descripcion }) {
  const c = config();
  const pref = await llamar('/checkout/preferences', {
    method: 'POST',
    idempotencia: `sub-${subscriptionId}-${Date.now()}`,
    queFalla: 'No se pudo generar el link de pago. Probá de nuevo en unos minutos.',
    body: {
      items: [{
        title: descripcion || `Stocker — ${plan?.nombre || 'Suscripción'}`,
        quantity: 1,
        currency_id: 'ARS',
        unit_price: Number(monto),
      }],
      // Viaja de ida y vuelta: es cómo el webhook sabe a qué cuenta acreditar
      // sin confiar en nada que mande el navegador.
      external_reference: refExterna({ businessId, subscriptionId }),
      back_urls: { success: c.backUrl, pending: c.backUrl, failure: c.backUrl },
      auto_return: 'approved',
      notification_url: c.webhook || undefined,
    },
  });

  return { id: pref.id, initPoint: pref.init_point, sandbox: pref.sandbox_init_point };
}

/**
 * Débito automático mensual.
 * @returns {{ id, initPoint }}
 */
async function crearSuscripcionRecurrente({ businessId, subscriptionId, plan, monto, emailPagador }) {
  const c = config();
  const pre = await llamar('/preapproval', {
    method: 'POST',
    idempotencia: `preap-${subscriptionId}`,
    queFalla: 'No se pudo dar de alta el débito automático. Probá de nuevo en unos minutos.',
    body: {
      reason: `Stocker — ${plan?.nombre || 'Suscripción mensual'}`,
      external_reference: refExterna({ businessId, subscriptionId }),
      payer_email: emailPagador,
      back_url: c.backUrl,
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: Number(monto),
        currency_id: 'ARS',
      },
    },
  });

  return { id: pre.id, initPoint: pre.init_point };
}

/** Estado real de un pago, consultado a MP. Nunca se confía en el webhook. */
async function consultarPago(paymentId) {
  const p = await llamar(`/v1/payments/${paymentId}`, {
    queFalla: 'No pudimos consultar ese pago en Mercado Pago.',
  });
  return {
    id: String(p.id),
    estado: p.status,                       // approved | pending | rejected | refunded
    monto: Number(p.transaction_amount) || 0,
    metodo: p.payment_method_id || null,
    fecha: p.date_approved || p.date_created || null,
    referencia: leerRef(p.external_reference),
  };
}

/*
 * Pagos de una suscripción, consultados a Mercado Pago.
 *
 * Es la red de contención del webhook. El aviso puede no llegar nunca —en
 * desarrollo Mercado Pago no alcanza a localhost, y en producción un deploy en
 * el momento justo lo pierde— y sin esto la plata quedaría cobrada con la
 * cuenta sin activar. Acá se pregunta directamente, que es la única fuente
 * confiable.
 */
async function buscarPagosDe({ businessId, subscriptionId }) {
  const ref = encodeURIComponent(refExterna({ businessId, subscriptionId }));
  const r = await llamar(`/v1/payments/search?sort=date_created&criteria=desc&external_reference=${ref}`, {
    queFalla: 'No pudimos consultarle a Mercado Pago si el pago entró. Probá de nuevo en unos minutos.',
  });

  return (r.results || []).map((p) => ({
    id: String(p.id),
    estado: p.status,
    monto: Number(p.transaction_amount) || 0,
    metodo: p.payment_method_id || null,
    fecha: p.date_approved || p.date_created || null,
    referencia: leerRef(p.external_reference),
  }));
}

async function cancelarSuscripcionRecurrente(preapprovalId) {
  return llamar(`/preapproval/${preapprovalId}`, { method: 'PUT', body: { status: 'cancelled' } });
}

/*
 * Validación de la firma del webhook.
 *
 * Mercado Pago manda `x-signature: ts=...,v1=...` y el hash se arma sobre
 * `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`. Sin esta comprobación
 * cualquiera que conozca la URL puede activar cuentas gratis con un POST.
 *
 * Si no hay secreto configurado devuelve `null` = "no verificable", y el
 * llamador decide. No devuelve `true`: un fallo de configuración no puede
 * leerse como una firma válida.
 */
function firmaValida({ signature, requestId, dataId }) {
  const { secretoWebhook } = config();
  if (!secretoWebhook) return null;
  if (!signature) return false;

  const partes = Object.fromEntries(
    String(signature).split(',').map((p) => p.split('=').map((x) => x.trim()))
  );
  if (!partes.ts || !partes.v1) return false;

  const crypto = require('node:crypto');
  const manifiesto = `id:${dataId};request-id:${requestId || ''};ts:${partes.ts};`;
  const esperado = crypto.createHmac('sha256', secretoWebhook).update(manifiesto).digest('hex');

  const a = Buffer.from(esperado, 'utf8');
  const b = Buffer.from(String(partes.v1), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  estaConfigurado, diagnostico, problemasDeUrls, crearLinkDePago, crearSuscripcionRecurrente,
  consultarPago, buscarPagosDe, cancelarSuscripcionRecurrente,
  firmaValida, refExterna, leerRef, ErrorMercadoPago,
};
