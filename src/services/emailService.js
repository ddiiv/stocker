const nodemailer = require('nodemailer');
const { log, mask } = require('../utils/logger');

// Paleta espejo del frontend
const C = {
  ink950:  '#14171f',
  ink700:  '#2e3346',
  ink600:  '#454b63',
  ink400:  '#7a8099',
  paper50: '#fbfaf7',
  paper100:'#f7f5f0',
  line:    '#e2ddd0',
  brass500:'#b9852f',
  brass600:'#966a23',
  brass50: '#fbf2e2',
  teal500: '#3e6259',
};

function money(v) {
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(Number(v) || 0);
}
function dateOnly(d) {
  return new Intl.DateTimeFormat('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' }).format(new Date(d));
}
function variantDesc(item) {
  return [
    item.variante1Valor && `${item.variante1Nombre}: ${item.variante1Valor}`,
    item.variante2Valor && `${item.variante2Nombre}: ${item.variante2Valor}`,
  ].filter(Boolean).join(' · ') || '—';
}

let transportSingleton = null;
function transport() {
  if (transportSingleton) return transportSingleton;
  // Defaults sensatos: si no seteás MAIL_PORT usa 465, y `secure` se deriva
  // del puerto (465 = TLS directo, 587 = STARTTLS). En Railway pasa esto
  // seguido: MAIL_PORT / MAIL_SECURE no seteadas → sin defaults, NaN, timeout.
  const port     = parseInt(process.env.MAIL_PORT, 10) || 465;
  const secure   = process.env.MAIL_SECURE === 'true' || (process.env.MAIL_SECURE == null && port === 465);
  transportSingleton = nodemailer.createTransport({
    host:   process.env.MAIL_HOST || 'smtp.gmail.com',
    port,
    secure,
    auth:   { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
    connectionTimeout: 15000,
    greetingTimeout:   10000,
    socketTimeout:     20000,
  });
  return transportSingleton;
}

function mailReady() {
  if (!process.env.MAIL_USER || !process.env.MAIL_PASS) {
    console.warn('[email] MAIL_USER/MAIL_PASS no configurado — email omitido');
    return false;
  }
  return true;
}

// ── Layout HTML común ─────────────────────────────────────────────
function shell({ title, businessName, bodyHtml, cuit }) {
  return `
  <!doctype html><html><body style="margin:0;padding:0;background:${C.paper100};font-family:Arial,Helvetica,sans-serif;color:${C.ink700};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.paper100};padding:24px 12px;">
      <tr><td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:${C.paper50};border:1px solid ${C.line};border-radius:10px;overflow:hidden;">
          <tr><td style="background:${C.ink950};padding:22px 26px;">
            <div style="color:${C.paper50};font-size:20px;font-weight:700;letter-spacing:-0.01em;">${escapeHtml(businessName)}</div>
            ${cuit ? `<div style="color:${C.ink400};font-size:12px;margin-top:4px;">CUIT ${escapeHtml(cuit)}</div>` : ''}
            <div style="color:${C.brass500};font-size:11px;margin-top:10px;letter-spacing:1px;text-transform:uppercase;font-weight:700;">${escapeHtml(title)}</div>
          </td></tr>
          <tr><td style="padding:24px 26px;color:${C.ink700};font-size:14px;line-height:1.5;">
            ${bodyHtml}
          </td></tr>
          <tr><td style="border-top:1px solid ${C.line};padding:14px 26px;color:${C.ink400};font-size:11px;">
            Este mensaje fue generado automáticamente por ${escapeHtml(businessName)}.
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body></html>`;
}

function itemsTable(items) {
  const rows = items.map((i, idx) => `
    <tr style="background:${idx % 2 ? C.paper100 : C.paper50};">
      <td style="padding:8px 10px;border-bottom:1px solid ${C.line};">
        <div style="color:${C.ink950};font-weight:600;">${escapeHtml(i.titulo)}</div>
        <div style="color:${C.ink400};font-size:11px;">SKU ${escapeHtml(i.sku)} · ${escapeHtml(variantDesc(i))}</div>
      </td>
      <td style="padding:8px 10px;border-bottom:1px solid ${C.line};text-align:center;">${i.cantidad}</td>
      <td style="padding:8px 10px;border-bottom:1px solid ${C.line};text-align:right;">${money(i.precioUnitario)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid ${C.line};text-align:right;font-weight:600;color:${C.ink950};">${money(i.subtotal)}</td>
    </tr>`).join('');
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:6px;overflow:hidden;margin:12px 0;">
      <thead><tr style="background:${C.paper100};color:${C.ink600};font-size:11px;letter-spacing:0.5px;">
        <th align="left"  style="padding:8px 10px;text-transform:uppercase;font-weight:700;">Producto</th>
        <th align="center" style="padding:8px 10px;text-transform:uppercase;font-weight:700;">Cant.</th>
        <th align="right" style="padding:8px 10px;text-transform:uppercase;font-weight:700;">P. unit.</th>
        <th align="right" style="padding:8px 10px;text-transform:uppercase;font-weight:700;">Subtotal</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function totalsBox({ subtotal, descuento, descuentoPct, total }) {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;">
      <tr><td style="text-align:right;padding:2px 0;color:${C.ink600};">Subtotal</td><td style="width:140px;text-align:right;color:${C.ink900};">${money(subtotal)}</td></tr>
      ${Number(descuento) > 0 ? `<tr><td style="text-align:right;padding:2px 0;color:${C.ink600};">Descuento (${descuentoPct || 0}%)</td><td style="text-align:right;color:${C.ink900};">- ${money(descuento)}</td></tr>` : ''}
      <tr><td style="text-align:right;padding:8px 0 2px;color:${C.ink950};font-weight:700;font-size:15px;">TOTAL</td><td style="text-align:right;color:${C.ink950};font-weight:700;font-size:15px;">${money(total)}</td></tr>
    </table>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ── Emails de FACTURA (compat con el flujo actual) ────────────────
async function sendInvoiceEmail({ to, clienteNombre, invoice, pdfPath, business }) {
  if (!mailReady()) return;
  const emisorNombre = invoice.emisorNombre || business.nombreNegocio;
  const emisorCuit   = invoice.emisorCuit   || business.cuit;

  const body = `
    <p>Hola <strong>${escapeHtml(clienteNombre)}</strong>,</p>
    <p>Te enviamos tu factura <strong>${escapeHtml(invoice.numero)}</strong> correspondiente a tu compra.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:6px;overflow:hidden;margin:12px 0;">
      <tr style="background:${C.paper100};"><td style="padding:8px 10px;color:${C.ink600};">Número</td><td style="padding:8px 10px;color:${C.ink950};font-weight:600;">${escapeHtml(invoice.numero)}</td></tr>
      <tr><td style="padding:8px 10px;color:${C.ink600};">Tipo</td><td style="padding:8px 10px;color:${C.ink950};">Factura ${escapeHtml(invoice.tipo)}</td></tr>
      <tr style="background:${C.paper100};"><td style="padding:8px 10px;color:${C.ink600};">Emisor</td><td style="padding:8px 10px;color:${C.ink950};">${escapeHtml(emisorNombre)} · ${escapeHtml(emisorCuit)}</td></tr>
      <tr><td style="padding:8px 10px;color:${C.ink600};">Total</td><td style="padding:8px 10px;color:${C.ink950};font-weight:700;">${money(invoice.total)}</td></tr>
      ${invoice.cae ? `<tr style="background:${C.paper100};"><td style="padding:8px 10px;color:${C.ink600};">CAE</td><td style="padding:8px 10px;font-family:monospace;color:${C.ink950};">${escapeHtml(invoice.cae)}</td></tr>` : ''}
    </table>
    <p>Adjuntamos el PDF de tu factura.</p>`;

  await transport().sendMail({
    from: process.env.MAIL_FROM || `"${emisorNombre}" <${process.env.MAIL_USER}>`,
    to,
    subject: `Factura ${invoice.numero} · ${emisorNombre}`,
    html: shell({ title: `Factura ${invoice.tipo}`, businessName: emisorNombre, cuit: emisorCuit, bodyHtml: body }),
    attachments: pdfPath ? [{ filename: `factura-${invoice.numero.replace(/\//g, '-')}.pdf`, path: pdfPath }] : [],
  });
  log.info('email', 'factura enviada', { numero: invoice.numero, a: mask.email(to) });
}

// ── Email VENTA al CLIENTE ────────────────────────────────────────
async function sendSaleReceiptToCustomer({ to, cliente, sale, items, business, pdfPath, emisor }) {
  if (!mailReady() || !to) return;
  const emisorNombre = emisor?.nombre || business.nombreNegocio;
  const emisorCuit   = emisor?.cuit   || business.cuit;

  const body = `
    <p>Hola <strong>${escapeHtml(cliente?.nombre || 'cliente')}</strong>,</p>
    <p>Registramos tu ${sale.tipo === 'cotizacion' ? 'cotización' : 'compra'} <strong>${escapeHtml(sale.numero)}</strong> del ${dateOnly(sale.fecha)}.</p>
    ${itemsTable(items)}
    ${totalsBox({ subtotal: sale.subtotal, descuento: sale.descuento, descuentoPct: sale.descuentoPct, total: sale.total })}
    <p style="color:${C.ink600};font-size:12px;margin-top:16px;">
      Estado: <strong style="color:${C.ink900}">${escapeHtml((sale.estado || '').toUpperCase())}</strong>
      ${sale.medioPago ? ` · Medio de pago: ${escapeHtml(sale.medioPago)}` : ''}
    </p>
    <p>Adjuntamos el comprobante en PDF.</p>`;

  await transport().sendMail({
    from: process.env.MAIL_FROM || `"${emisorNombre}" <${process.env.MAIL_USER}>`,
    to,
    subject: `${sale.tipo === 'cotizacion' ? 'Cotización' : 'Comprobante'} ${sale.numero} · ${emisorNombre}`,
    html: shell({
      title: sale.tipo === 'cotizacion' ? 'Cotización' : 'Comprobante de venta',
      businessName: emisorNombre, cuit: emisorCuit, bodyHtml: body,
    }),
    attachments: pdfPath ? [{ filename: `${sale.tipo === 'cotizacion' ? 'cotizacion' : 'venta'}-${sale.numero.replace(/\//g, '-')}.pdf`, path: pdfPath }] : [],
  });
  log.info('email', 'comprobante de venta enviado', { numero: sale.numero, a: mask.email(to) });
}

// ── Email VENTA al NEGOCIO (aviso interno) ───────────────────────
async function sendSaleNotificationToBusiness({ to, cliente, sale, items, business, pdfPath, emisor, empleado }) {
  if (!mailReady() || !to) return;
  const emisorNombre = emisor?.nombre || business.nombreNegocio;

  const clienteBloque = cliente
    ? `${escapeHtml(cliente.nombre)} ${escapeHtml(cliente.apellido || '')} ${cliente.cuit ? ' · CUIT ' + escapeHtml(cliente.cuit) : ''} ${cliente.email ? ' · ' + escapeHtml(cliente.email) : ''}`
    : 'Consumidor final';

  const body = `
    <p>Se registró una nueva ${sale.tipo === 'cotizacion' ? 'cotización' : 'venta'}: <strong>${escapeHtml(sale.numero)}</strong>.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:6px;overflow:hidden;margin:10px 0;">
      <tr style="background:${C.paper100};"><td style="padding:8px 10px;color:${C.ink600};width:130px;">Cliente</td><td style="padding:8px 10px;color:${C.ink950};">${clienteBloque}</td></tr>
      <tr><td style="padding:8px 10px;color:${C.ink600};">Fecha</td><td style="padding:8px 10px;color:${C.ink950};">${dateOnly(sale.fecha)}</td></tr>
      <tr style="background:${C.paper100};"><td style="padding:8px 10px;color:${C.ink600};">Estado</td><td style="padding:8px 10px;color:${C.ink950};">${escapeHtml((sale.estado || '').toUpperCase())}${sale.medioPago ? ' · ' + escapeHtml(sale.medioPago) : ''}</td></tr>
      <tr><td style="padding:8px 10px;color:${C.ink600};">Tipo de precio</td><td style="padding:8px 10px;color:${C.ink950};">${sale.esMayorista ? 'Mayorista' : 'Minorista'}</td></tr>
      ${empleado ? `<tr style="background:${C.paper100};"><td style="padding:8px 10px;color:${C.ink600};">Vendedor</td><td style="padding:8px 10px;color:${C.ink950};">${escapeHtml(empleado.nombre)} ${escapeHtml(empleado.apellido || '')}</td></tr>` : ''}
      <tr><td style="padding:8px 10px;color:${C.ink600};">Emisor</td><td style="padding:8px 10px;color:${C.ink950};">${escapeHtml(emisorNombre)}</td></tr>
    </table>
    ${itemsTable(items)}
    ${totalsBox({ subtotal: sale.subtotal, descuento: sale.descuento, descuentoPct: sale.descuentoPct, total: sale.total })}
    ${sale.notas ? `<p style="color:${C.ink600};font-size:12px;"><strong>Notas:</strong> ${escapeHtml(sale.notas)}</p>` : ''}
    <p style="color:${C.ink400};font-size:12px;">Adjuntamos el PDF con el detalle completo.</p>`;

  await transport().sendMail({
    from: process.env.MAIL_FROM || `"${business.nombreNegocio}" <${process.env.MAIL_USER}>`,
    to,
    subject: `[Nueva ${sale.tipo === 'cotizacion' ? 'cotización' : 'venta'}] ${sale.numero} · ${money(sale.total)}`,
    html: shell({ title: 'Nueva operación', businessName: business.nombreNegocio, cuit: business.cuit, bodyHtml: body }),
    attachments: pdfPath ? [{ filename: `${sale.tipo === 'cotizacion' ? 'cotizacion' : 'venta'}-${sale.numero.replace(/\//g, '-')}.pdf`, path: pdfPath }] : [],
  });
  log.info('email', 'aviso interno de venta enviado', { numero: sale.numero, a: mask.email(to) });
}

// ── Email código de recuperación de contraseña ─────────────────
async function sendPasswordResetCode({ to, ownerName, code, businessName, expiresInMinutes = 15 }) {
  if (!mailReady() || !to) return;
  const body = `
    <p>Hola <strong>${escapeHtml(ownerName || '')}</strong>,</p>
    <p>Recibimos un pedido de recuperación de contraseña para tu cuenta de <strong>${escapeHtml(businessName)}</strong>.</p>
    <p>Ingresá este código en la pantalla de Stocker para continuar:</p>
    <div style="margin:20px auto;padding:18px;background:${C.paper100};border:2px dashed ${C.brass500};border-radius:8px;text-align:center;">
      <div style="font-family:monospace;font-size:34px;font-weight:700;letter-spacing:8px;color:${C.ink950};">${escapeHtml(code)}</div>
    </div>
    <p style="color:${C.ink600};font-size:12px;">El código vence en ${expiresInMinutes} minutos. Si vos no pediste este cambio, ignorá este mensaje.</p>`;
  // Versión texto plano (crítico para spam scoring — mails HTML-only son sospechosos).
  const text =
`Hola ${ownerName || ''},

Recibimos un pedido de recuperación de contraseña para tu cuenta de ${businessName}.
Ingresá este código en la pantalla de Stocker para continuar:

    ${code}

El código vence en ${expiresInMinutes} minutos.
Si vos no pediste este cambio, ignorá este mensaje.

— Stocker`;

  const info = await transport().sendMail({
    from: process.env.MAIL_FROM || `"Stocker" <${process.env.MAIL_USER}>`,
    to,
    replyTo: process.env.MAIL_FROM || process.env.MAIL_USER,
    // Subject sin el código dentro (Gmail marca como phishing "your code is XXX").
    // Formato con brackets tipo el de venta que sí llega bien al inbox.
    subject: `[Stocker] Recuperar contraseña de ${businessName}`,
    html: shell({ title: 'Recuperar contraseña', businessName: businessName || 'Stocker', bodyHtml: body }),
    text,
    headers: {
      'X-Entity-Ref-ID': `stocker-reset-${Date.now()}`,
      'X-Auto-Response-Suppress': 'OOF, AutoReply',
      'Auto-Submitted': 'auto-generated',
    },
  });
  log.info('email', 'código de recuperación enviado', { a: mask.email(to) });
  return info;
}

// ── Email alerta de intentos fallidos de recuperación ──────────
async function sendPasswordResetAlert({ to, ownerName, businessName, attemptedAt, ip }) {
  if (!mailReady() || !to) return;
  const body = `
    <p>Hola <strong>${escapeHtml(ownerName || '')}</strong>,</p>
    <p style="color:${C.brick500};font-weight:700;">Alguien intentó recuperar la contraseña de tu cuenta de <strong>${escapeHtml(businessName)}</strong> y falló varias veces con el código.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:6px;overflow:hidden;margin:12px 0;">
      <tr style="background:${C.paper100};"><td style="padding:8px 10px;color:${C.ink600};">Fecha</td><td style="padding:8px 10px;color:${C.ink950};">${new Date(attemptedAt).toLocaleString('es-AR')}</td></tr>
      <tr><td style="padding:8px 10px;color:${C.ink600};">IP</td><td style="padding:8px 10px;font-family:monospace;color:${C.ink950};">${escapeHtml(ip || '—')}</td></tr>
    </table>
    <p><strong>Si fuiste vos y olvidaste la contraseña</strong>: podés reintentar el proceso desde el login.</p>
    <p><strong>Si no fuiste vos</strong>: te recomendamos cambiar la contraseña actual desde tu cuenta (Configuración → Seguridad) y revisar las sesiones activas de tus empleados.</p>`;
  const text =
`Hola ${ownerName || ''},

Alguien intentó recuperar la contraseña de tu cuenta de ${businessName} y falló varias veces.

Fecha: ${new Date(attemptedAt).toLocaleString('es-AR')}
IP:    ${ip || '—'}

Si fuiste vos y olvidaste la contraseña, reintentá desde el login.
Si NO fuiste vos, cambiá la contraseña y revisá las sesiones activas.

— Stocker`;

  const info = await transport().sendMail({
    from: process.env.MAIL_FROM || `"Stocker" <${process.env.MAIL_USER}>`,
    to,
    replyTo: process.env.MAIL_FROM || process.env.MAIL_USER,
    subject: `Alerta de seguridad en tu cuenta de Stocker`,
    html: shell({ title: 'Alerta de seguridad', businessName: 'Stocker', bodyHtml: body }),
    text,
    headers: {
      'X-Entity-Ref-ID': `stocker-alert-${Date.now()}`,
      'X-Auto-Response-Suppress': 'OOF, AutoReply',
    },
  });
  log.info('email', 'alerta de seguridad enviada', { a: mask.email(to) });
  return info;
}


// ── Email de descuadre de caja ─────────────────────────────────
// Se manda al dueño cuando un turno cierra con diferencia. El objetivo es que
// se entere el mismo día: revisar un faltante una semana después, cuando nadie
// recuerda el turno, no sirve de nada.
async function sendCashDiscrepancyAlert({ to, ownerName, businessName, turno, empleado, local, desglose }) {
  if (!mailReady() || !to) return;

  const dif = Number(turno.diferencia);
  const falta = dif < 0;
  const money = (n) => `$${Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
  const color = falta ? C.brick500 : C.brass500;
  const titulo = falta ? 'Faltante de caja' : 'Sobrante de caja';

  const fila = (etiqueta, valor, destacado = false) =>
    `<tr${destacado ? ` style="background:${C.paper100};"` : ''}><td style="padding:8px 10px;color:${C.ink600};">${etiqueta}</td><td style="padding:8px 10px;text-align:right;color:${C.ink950};${destacado ? 'font-weight:700;' : ''}">${valor}</td></tr>`;

  const body = `
    <p>Hola <strong>${escapeHtml(ownerName || '')}</strong>,</p>
    <p>El turno de caja de <strong>${escapeHtml(empleado)}</strong>${local ? ` en ${escapeHtml(local)}` : ''} cerró con una diferencia.</p>
    <p style="color:${color};font-weight:700;font-size:18px;margin:14px 0;">${titulo}: ${money(Math.abs(dif))}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:6px;overflow:hidden;margin:12px 0;">
      ${fila('Efectivo inicial', money(desglose.montoInicial))}
      ${fila('Ventas en efectivo', money(desglose.efectivoVentas), true)}
      ${fila('Ingresos', money(desglose.ingresos))}
      ${fila('Egresos', `- ${money(desglose.egresos)}`, true)}
      ${fila('Retiros', `- ${money(desglose.retiros)}`)}
      ${fila('Debería haber', money(turno.montoEsperado), true)}
      ${fila('Contado por el empleado', money(turno.montoDeclarado))}
    </table>
    ${turno.notaCierre ? `<p style="color:${C.ink600};"><strong>Nota del cierre:</strong> ${escapeHtml(turno.notaCierre)}</p>` : ''}
    <p style="color:${C.ink600};font-size:13px;">Sólo se cuenta el efectivo: lo cobrado con tarjeta, transferencia o QR no pasa por la caja.</p>`;

  const text =
`Hola ${ownerName || ''},

${titulo}: ${money(Math.abs(dif))}
Turno de ${empleado}${local ? ` en ${local}` : ''}

Efectivo inicial:    ${money(desglose.montoInicial)}
Ventas en efectivo:  ${money(desglose.efectivoVentas)}
Ingresos:            ${money(desglose.ingresos)}
Egresos:            -${money(desglose.egresos)}
Retiros:            -${money(desglose.retiros)}
Debería haber:       ${money(turno.montoEsperado)}
Contado:             ${money(turno.montoDeclarado)}
${turno.notaCierre ? `\nNota: ${turno.notaCierre}` : ''}

Sólo se cuenta efectivo.

— Stocker`;

  const info = await transport().sendMail({
    from: process.env.MAIL_FROM || `"Stocker" <${process.env.MAIL_USER}>`,
    to,
    subject: `${titulo} de ${money(Math.abs(dif))} — ${businessName}`,
    html: shell({ title: titulo, businessName, bodyHtml: body }),
    text,
    headers: { 'X-Entity-Ref-ID': `stocker-caja-${turno.id}` },
  });
  log.info('email', 'alerta de descuadre enviada', { a: mask.email(to), turno: turno.id });
  return info;
}

/*
 * Código para confirmar un cambio de email o de contraseña desde la cuenta.
 *
 * Distinto del de recuperación: acá el dueño ya está adentro y está cambiando
 * una credencial. En el cambio de email este mensaje va a la casilla NUEVA,
 * así que el texto no puede dar por hecho que quien lo lee ya usa Stocker.
 */
async function sendAccountChangeCode({ to, ownerName, code, businessName, expiresInMinutes = 15 }) {
  if (!mailReady() || !to) return;
  const body = `
    <p>Hola <strong>${escapeHtml(ownerName || '')}</strong>,</p>
    <p>Pediste confirmar un cambio en los datos de acceso de tu cuenta de <strong>${escapeHtml(businessName)}</strong>.</p>
    <p>Ingresá este código en Stocker para completarlo:</p>
    <div style="margin:20px auto;padding:18px;background:${C.paper100};border:2px dashed ${C.brass500};border-radius:8px;text-align:center;">
      <div style="font-family:monospace;font-size:34px;font-weight:700;letter-spacing:8px;color:${C.ink950};">${escapeHtml(code)}</div>
    </div>
    <p style="color:${C.ink600};font-size:12px;">El código vence en ${expiresInMinutes} minutos. Si vos no pediste este cambio, ignorá este mensaje y revisá tu contraseña.</p>`;
  const text =
`Hola ${ownerName || ''},

Pediste confirmar un cambio en los datos de acceso de tu cuenta de ${businessName}.
Ingresá este código en Stocker para completarlo:

    ${code}

El código vence en ${expiresInMinutes} minutos.
Si vos no pediste este cambio, ignoralo y revisá tu contraseña.

— Stocker`;

  const info = await transport().sendMail({
    from: process.env.MAIL_FROM || `"Stocker" <${process.env.MAIL_USER}>`,
    to,
    replyTo: process.env.MAIL_FROM || process.env.MAIL_USER,
    subject: `[Stocker] Confirmar cambio en tu cuenta de ${businessName}`,
    html: shell({ title: 'Confirmar cambio', businessName: businessName || 'Stocker', bodyHtml: body }),
    text,
    headers: {
      'X-Entity-Ref-ID': `stocker-account-${Date.now()}`,
      'X-Auto-Response-Suppress': 'OOF, AutoReply',
      'Auto-Submitted': 'auto-generated',
    },
  });
  log.info('email', 'código de cambio de cuenta enviado', { a: mask.email(to) });
  return info;
}

/*
 * Aviso interno: un cliente pidió dar de baja su cuenta.
 *
 * Va a la casilla de operaciones de Stocker, no al cliente. Es un pedido para
 * que lo procese una persona: borrar el historial de facturación de un negocio
 * no puede dispararlo un clic, y una vez borrado no se recupera.
 *
 * La casilla se toma de BACKOFFICE_EMAIL para poder mudarla al dominio propio
 * sin tocar el código.
 */
const CASILLA_BACKOFFICE = process.env.BACKOFFICE_EMAIL || 'stockerbackofficenoreply@gmail.com';

async function sendAccountDeletionRequest({ negocio, plan, motivo }) {
  if (!mailReady()) return;

  const filas = [
    ['Negocio',   negocio.nombreNegocio],
    ['Titular',   `${negocio.ownerNombre || ''} ${negocio.ownerApellido || ''}`.trim()],
    ['Email',     negocio.email],
    ['Teléfono',  negocio.ownerTelefono || negocio.telefono || '—'],
    ['CUIT',      negocio.cuit],
    ['ID interno', String(negocio.id)],
    ['Plan',      plan || '—'],
    ['Pedido el', new Date().toLocaleString('es-AR')],
  ];

  const body = `
    <p>El titular de <strong>${escapeHtml(negocio.nombreNegocio)}</strong> solicitó la baja de su cuenta.</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
      ${filas.map(([k, v]) => `
        <tr>
          <td style="padding:6px 10px;color:${C.ink600};border-bottom:1px solid ${C.line};width:130px;">${escapeHtml(k)}</td>
          <td style="padding:6px 10px;color:${C.ink950};border-bottom:1px solid ${C.line};">${escapeHtml(String(v))}</td>
        </tr>`).join('')}
    </table>
    ${motivo ? `<p style="color:${C.ink600};"><strong>Motivo que dejó:</strong><br>${escapeHtml(motivo)}</p>` : ''}
    <p style="color:${C.brick500};font-size:13px;">
      No se borró nada. La cuenta sigue operativa hasta que alguien procese la baja a mano.
    </p>`;

  const text =
`Solicitud de baja de cuenta

${filas.map(([k, v]) => `${k}: ${v}`).join('\n')}
${motivo ? `\nMotivo: ${motivo}` : ''}

No se borró nada: la cuenta sigue operativa hasta que se procese la baja a mano.

— Stocker`;

  const info = await transport().sendMail({
    from: process.env.MAIL_FROM || `"Stocker" <${process.env.MAIL_USER}>`,
    to: CASILLA_BACKOFFICE,
    replyTo: negocio.email,
    subject: `[Stocker] Baja de cuenta — ${negocio.nombreNegocio} (${negocio.cuit})`,
    html: shell({ title: 'Solicitud de baja', businessName: 'Stocker', bodyHtml: body }),
    text,
    headers: { 'X-Entity-Ref-ID': `stocker-baja-${negocio.id}-${Date.now()}` },
  });
  log.info('email', 'solicitud de baja de cuenta enviada al backoffice', { negocio: negocio.id });
  return info;
}

module.exports = { sendInvoiceEmail, sendSaleReceiptToCustomer, sendSaleNotificationToBusiness, sendPasswordResetCode, sendPasswordResetAlert, sendCashDiscrepancyAlert, sendAccountChangeCode, sendAccountDeletionRequest, CASILLA_BACKOFFICE };
