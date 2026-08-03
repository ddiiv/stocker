const nodemailer = require('nodemailer');

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
  transportSingleton = nodemailer.createTransport({
    host:   process.env.MAIL_HOST || 'smtp.gmail.com',
    port:   parseInt(process.env.MAIL_PORT) || 465,
    secure: true,
    auth:   { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
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
  console.log(`[email] Factura ${invoice.numero} enviada a ${to}`);
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
  console.log(`[email] Comprobante venta ${sale.numero} enviado a ${to}`);
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
  console.log(`[email] Aviso interno venta ${sale.numero} enviado a ${to}`);
}

module.exports = { sendInvoiceEmail, sendSaleReceiptToCustomer, sendSaleNotificationToBusiness };
