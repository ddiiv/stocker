const PDFDocument = require('pdfkit');
const fs          = require('fs-extra');
const path        = require('path');

const PDF_DIR = process.env.PDF_STORAGE_PATH || path.join(__dirname, '../../storage/pdfs');

// Paleta espejo del frontend (index.css @theme). Mantener en sync manualmente.
const COLOR = {
  ink950:  '#14171f',
  ink800:  '#232735',
  ink700:  '#2e3346',
  ink600:  '#454b63',
  ink400:  '#7a8099',
  paper50: '#fbfaf7',
  paper100:'#f7f5f0',
  paper200:'#efebe1',
  line:    '#e2ddd0',
  brass500:'#b9852f',
  brass600:'#966a23',
  brass50: '#fbf2e2',
  teal500: '#3e6259',
  brick500:'#b3432d',
};

async function ensureDir() { await fs.ensureDir(PDF_DIR); }

function money(v) {
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(Number(v) || 0);
}
function dateTime(d) {
  return new Intl.DateTimeFormat('es-AR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }).format(new Date(d));
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

// Utilidades de layout ────────────────────────────────────────────
function drawHeaderBar(doc, { titulo, subtitulo, badge, badgeColor = COLOR.brass500 }) {
  // Barra oscura de identidad
  doc.save().rect(0, 0, doc.page.width, 90).fill(COLOR.ink950).restore();

  doc.fillColor(COLOR.paper50).font('Helvetica-Bold').fontSize(20).text(titulo, 50, 26, { width: 380 });
  if (subtitulo) {
    doc.font('Helvetica').fontSize(9).fillColor(COLOR.ink400).text(subtitulo, 50, 58, { width: 380 });
  }

  // Badge (tipo de factura / recibo de venta)
  const bw = 100, bh = 56, bx = doc.page.width - 50 - bw, by = 18;
  doc.save().roundedRect(bx, by, bw, bh, 6).fill(COLOR.paper50).restore();
  doc.save().rect(bx, by, bw, 18).fill(badgeColor).restore();
  doc.fillColor(COLOR.paper50).font('Helvetica-Bold').fontSize(9).text(badge.top, bx, by + 4, { width: bw, align: 'center' });
  doc.fillColor(COLOR.ink950).font('Helvetica-Bold').fontSize(22).text(badge.big, bx, by + 22, { width: bw, align: 'center' });

  doc.fillColor(COLOR.ink900);
}

function drawSectionTitle(doc, text, y) {
  doc.font('Helvetica-Bold').fontSize(10).fillColor(COLOR.brass600).text(text.toUpperCase(), 50, y, { characterSpacing: 1 });
  doc.moveTo(50, y + 14).lineTo(doc.page.width - 50, y + 14).lineWidth(0.5).strokeColor(COLOR.line).stroke();
  return y + 22;
}

function drawKeyValue(doc, x, y, key, value, opts = {}) {
  const kw = opts.keyWidth || 90;
  doc.font('Helvetica').fontSize(9).fillColor(COLOR.ink600).text(key, x, y, { width: kw });
  doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR.ink900).text(String(value ?? '—'), x + kw, y, { width: (opts.width || 200) - kw });
  return y + 14;
}

function drawItemsTable(doc, items, startY) {
  const left = 50, right = doc.page.width - 50;
  const cols = {
    prod: left,
    var:  left + 220,
    cant: left + 340,
    pu:   left + 385,
    sub:  right - 70,
  };

  // Header
  doc.save().rect(left, startY, right - left, 22).fill(COLOR.paper200).restore();
  doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR.ink700);
  doc.text('PRODUCTO / SKU', cols.prod + 6, startY + 7);
  doc.text('VARIANTE',       cols.var,      startY + 7);
  doc.text('CANT.',          cols.cant,     startY + 7);
  doc.text('P. UNIT.',       cols.pu,       startY + 7);
  doc.text('SUBTOTAL',       cols.sub,      startY + 7, { width: 70, align: 'right' });

  let y = startY + 30;
  doc.font('Helvetica').fontSize(9).fillColor(COLOR.ink900);
  let zebra = false;
  for (const item of items) {
    const rowH = 30;
    if (zebra) doc.save().rect(left, y - 4, right - left, rowH).fill(COLOR.paper100).restore();
    zebra = !zebra;

    doc.fillColor(COLOR.ink900).font('Helvetica-Bold').fontSize(9).text(item.titulo, cols.prod + 6, y, { width: 210 });
    doc.fillColor(COLOR.ink600).font('Helvetica').fontSize(7.5).text(`SKU ${item.sku}`, cols.prod + 6, y + 12, { width: 210 });

    doc.fillColor(COLOR.ink700).font('Helvetica').fontSize(9).text(variantDesc(item), cols.var, y + 3, { width: 110 });
    doc.text(String(item.cantidad), cols.cant, y + 3, { width: 40 });
    doc.text(money(item.precioUnitario), cols.pu, y + 3, { width: 70 });
    doc.font('Helvetica-Bold').text(money(item.subtotal), cols.sub, y + 3, { width: 70, align: 'right' });
    doc.font('Helvetica');

    y += rowH;
    if (y > doc.page.height - 150) { doc.addPage(); y = 60; }
  }
  return y;
}

function drawTotals(doc, y, { subtotal, descuento, descuentoPct, iva, total, esMayorista }) {
  const right = doc.page.width - 50;
  const boxW = 240, boxX = right - boxW;

  doc.save().roundedRect(boxX, y, boxW, 90 + (iva > 0 ? 14 : 0) + (descuento > 0 ? 14 : 0), 4).fill(COLOR.paper100).restore();
  let cy = y + 12;
  const label = (k, v, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9)
       .fillColor(bold ? COLOR.ink950 : COLOR.ink700);
    doc.text(k, boxX + 12, cy);
    doc.text(v, boxX + 12, cy, { width: boxW - 24, align: 'right' });
    cy += bold ? 18 : 14;
  };
  label('Subtotal', money(subtotal));
  if (descuento > 0) label(`Descuento (${descuentoPct || 0}%)`, `- ${money(descuento)}`);
  if (iva > 0) label('IVA (21%)', money(iva));
  cy += 4;
  // Separador
  doc.moveTo(boxX + 12, cy).lineTo(boxX + boxW - 12, cy).lineWidth(0.5).strokeColor(COLOR.line).stroke();
  cy += 8;
  label('TOTAL', money(total), true);
  if (esMayorista) {
    doc.font('Helvetica').fontSize(7.5).fillColor(COLOR.brass600)
       .text('Precio mayorista aplicado (≥ 3 unidades)', boxX + 12, cy, { width: boxW - 24, align: 'right' });
    cy += 12;
  }
  return cy + 4;
}

function drawFooter(doc, business) {
  const bottom = doc.page.height - 40;
  doc.save().moveTo(50, bottom - 8).lineTo(doc.page.width - 50, bottom - 8).lineWidth(0.5).strokeColor(COLOR.line).stroke().restore();
  doc.font('Helvetica').fontSize(7.5).fillColor(COLOR.ink400)
     .text(`${business.nombreNegocio || ''} · Documento generado automáticamente`, 50, bottom, { width: doc.page.width - 100, align: 'center' });
}

// ── PDF de Factura ────────────────────────────────────────────────
async function generateInvoicePdf(invoice, items, business) {
  await ensureDir();
  const filename = `factura-${invoice.numero.replace(/\//g, '-')}-${invoice.id}.pdf`;
  const filepath = path.join(PDF_DIR, filename);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);

    // Emisor: usar snapshot de la factura si existe, sino datos del negocio (legacy)
    const emisorNombre = invoice.emisorNombre || business.nombreNegocio;
    const emisorCuit   = invoice.emisorCuit   || business.cuit;

    drawHeaderBar(doc, {
      titulo: emisorNombre,
      subtitulo: `CUIT ${emisorCuit}${business.telefono ? ' · Tel ' + business.telefono : ''}`,
      badge: { top: 'FACTURA', big: invoice.tipo || 'B' },
    });

    let y = 110;
    y = drawSectionTitle(doc, 'Comprobante', y);
    const col1x = 50, col2x = 310;
    drawKeyValue(doc, col1x, y,     'N° Factura',    invoice.numero);
    drawKeyValue(doc, col1x, y+14,  'Fecha emisión', dateTime(invoice.fechaEmision));
    drawKeyValue(doc, col1x, y+28,  'Tipo',          `Factura ${invoice.tipo}`);
    drawKeyValue(doc, col2x, y,     'CAE',           invoice.cae || '—');
    drawKeyValue(doc, col2x, y+14,  'Vto. CAE',      invoice.caeVencimiento ? dateOnly(invoice.caeVencimiento) : '—');
    drawKeyValue(doc, col2x, y+28,  'Estado',        (invoice.estado || 'emitida').toUpperCase());
    y += 60;

    y = drawSectionTitle(doc, 'Cliente', y);
    drawKeyValue(doc, col1x, y,     'Nombre',    invoice.clienteNombre || 'Consumidor final');
    drawKeyValue(doc, col1x, y+14,  'CUIT/DNI',  invoice.clienteCuit || '—');
    drawKeyValue(doc, col1x, y+28,  'Email',     invoice.clienteEmail || '—');
    drawKeyValue(doc, col2x, y,     'Dirección', invoice.clienteDireccion || '—');
    drawKeyValue(doc, col2x, y+14,  'Precio',    invoice.esMayorista ? 'MAYORISTA' : 'MINORISTA');
    y += 60;

    y = drawSectionTitle(doc, 'Detalle', y);
    y = drawItemsTable(doc, items, y);
    y += 10;

    drawTotals(doc, y, {
      subtotal: invoice.subtotal,
      descuento: 0,
      descuentoPct: 0,
      iva: invoice.iva || 0,
      total: invoice.total,
      esMayorista: invoice.esMayorista,
    });

    drawFooter(doc, business);
    doc.end();
    stream.on('finish', () => resolve(path.relative(process.cwd(), filepath)));
    stream.on('error', reject);
  });
}

// Misma lógica pero devuelve un Buffer en memoria (sin tocar el disco).
// Usar para servir el PDF directamente desde el endpoint, funciona en
// cualquier hosting con filesystem efímero (Railway, Render, etc.).
async function generateInvoicePdfBuffer(invoice, items, business) {
  const emisorNombre = invoice.emisorNombre || business.nombreNegocio;
  const emisorCuit   = invoice.emisorCuit   || business.cuit;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    drawHeaderBar(doc, {
      titulo: emisorNombre,
      subtitulo: `CUIT ${emisorCuit}${business.telefono ? ' · Tel ' + business.telefono : ''}`,
      badge: { top: 'FACTURA', big: invoice.tipo || 'B' },
    });

    let y = 110;
    y = drawSectionTitle(doc, 'Comprobante', y);
    const col1x = 50, col2x = 310;
    drawKeyValue(doc, col1x, y,    'N° Factura',    invoice.numero);
    drawKeyValue(doc, col1x, y+14, 'Fecha emisión', dateTime(invoice.fechaEmision));
    drawKeyValue(doc, col1x, y+28, 'Tipo',          `Factura ${invoice.tipo}`);
    drawKeyValue(doc, col2x, y,    'CAE',           invoice.cae || '—');
    drawKeyValue(doc, col2x, y+14, 'Vto. CAE',      invoice.caeVencimiento ? dateOnly(invoice.caeVencimiento) : '—');
    drawKeyValue(doc, col2x, y+28, 'Estado',        (invoice.estado || 'emitida').toUpperCase());
    y += 60;

    y = drawSectionTitle(doc, 'Cliente', y);
    drawKeyValue(doc, col1x, y,    'Nombre',    invoice.clienteNombre || 'Consumidor final');
    drawKeyValue(doc, col1x, y+14, 'CUIT/DNI',  invoice.clienteCuit || '—');
    drawKeyValue(doc, col1x, y+28, 'Email',     invoice.clienteEmail || '—');
    drawKeyValue(doc, col2x, y,    'Dirección', invoice.clienteDireccion || '—');
    drawKeyValue(doc, col2x, y+14, 'Precio',    invoice.esMayorista ? 'MAYORISTA' : 'MINORISTA');
    y += 60;

    y = drawSectionTitle(doc, 'Detalle', y);
    y = drawItemsTable(doc, items, y);
    y += 10;

    drawTotals(doc, y, {
      subtotal: invoice.subtotal,
      descuento: 0, descuentoPct: 0,
      iva: invoice.iva || 0,
      total: invoice.total,
      esMayorista: invoice.esMayorista,
    });

    drawFooter(doc, business);
    doc.end();
  });
}

// ── PDF de Venta / Pedido ─────────────────────────────────────────
async function generateSalePdf(sale, items, business, { cliente, emisor } = {}) {
  await ensureDir();
  const numero = sale.numero.replace(/\//g, '-');
  const filename = `${sale.tipo === 'cotizacion' ? 'cotizacion' : 'venta'}-${numero}-${sale.id}.pdf`;
  const filepath = path.join(PDF_DIR, filename);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);

    const emisorNombre = emisor?.nombre || business.nombreNegocio;
    const emisorCuit   = emisor?.cuit   || business.cuit;

    drawHeaderBar(doc, {
      titulo: emisorNombre,
      subtitulo: `CUIT ${emisorCuit}${business.telefono ? ' · Tel ' + business.telefono : ''}`,
      badge: {
        top: sale.tipo === 'cotizacion' ? 'COTIZACIÓN' : 'COMPROBANTE',
        big: sale.tipo === 'cotizacion' ? 'COT' : 'VENTA',
      },
      badgeColor: sale.tipo === 'cotizacion' ? COLOR.teal500 : COLOR.brass500,
    });

    let y = 110;
    y = drawSectionTitle(doc, sale.tipo === 'cotizacion' ? 'Cotización' : 'Comprobante de venta', y);
    const col1x = 50, col2x = 310;
    drawKeyValue(doc, col1x, y,     'Número',    sale.numero);
    drawKeyValue(doc, col1x, y+14,  'Fecha',     dateOnly(sale.fecha));
    drawKeyValue(doc, col1x, y+28,  'Estado',    (sale.estado || 'pendiente').toUpperCase());
    drawKeyValue(doc, col2x, y,     'Medio pago', sale.medioPago || '—');
    drawKeyValue(doc, col2x, y+14,  'Precio',    sale.esMayorista ? 'MAYORISTA' : 'MINORISTA');
    y += 60;

    y = drawSectionTitle(doc, 'Cliente', y);
    if (cliente) {
      drawKeyValue(doc, col1x, y,     'Nombre',    `${cliente.nombre || ''} ${cliente.apellido || ''}`.trim());
      drawKeyValue(doc, col1x, y+14,  'CUIT/DNI',  cliente.cuit || cliente.dni || '—');
      drawKeyValue(doc, col1x, y+28,  'Email',     cliente.email || '—');
      drawKeyValue(doc, col2x, y,     'Teléfono',  cliente.telefono || '—');
      drawKeyValue(doc, col2x, y+14,  'Dirección', cliente.direccion || '—');
    } else {
      drawKeyValue(doc, col1x, y, 'Nombre', 'Consumidor final');
    }
    y += 60;

    y = drawSectionTitle(doc, 'Detalle', y);
    y = drawItemsTable(doc, items, y);
    y += 10;

    drawTotals(doc, y, {
      subtotal: sale.subtotal,
      descuento: Number(sale.descuento) || 0,
      descuentoPct: Number(sale.descuentoPct) || 0,
      iva: 0,
      total: sale.total,
      esMayorista: sale.esMayorista,
    });

    if (sale.notas) {
      doc.moveDown(2);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR.brass600).text('NOTAS', 50, doc.y, { characterSpacing: 1 });
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(9).fillColor(COLOR.ink700).text(sale.notas, 50, doc.y, { width: doc.page.width - 100 });
    }

    drawFooter(doc, business);
    doc.end();
    stream.on('finish', () => resolve(path.relative(process.cwd(), filepath)));
    stream.on('error', reject);
  });
}

// ── PDF Ticket 80mm (impresora comandera) ────────────────────────
// Ancho 80mm = 226.77pt. Área imprimible efectiva ~72mm (204pt) por márgenes físicos
// del rollo. Alto arbitrario grande — la comandera corta al final del contenido.
async function generateSaleTicketPdf(sale, items, business, { cliente, emisor } = {}) {
  await ensureDir();
  const filename = `ticket-${sale.numero.replace(/\//g, '-')}-${sale.id}.pdf`;
  const filepath = path.join(PDF_DIR, filename);

  return new Promise((resolve, reject) => {
    const W = 227; // 80mm en pt (redondeado)
    const doc = new PDFDocument({
      size: [W, 800], // alto amplio; la impresora corta al final del contenido
      margins: { top: 8, bottom: 8, left: 8, right: 8 },
    });
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);

    const innerW = W - 16;
    const emisorNombre = emisor?.nombre || business.nombreNegocio;
    const emisorCuit   = emisor?.cuit   || business.cuit;

    // ── Logo (si existe) ──────────────────────────────────────
    const logoPath = process.env.LOGO_PATH || path.join(__dirname, '../../storage/assets/logo.png');
    if (fs.existsSync(logoPath)) {
      try {
        doc.image(logoPath, (W - 48) / 2, doc.y, { width: 48, height: 48 });
        doc.y += 52;
      } catch { /* imagen inválida, ignora */ }
    }

    // ── Cabecera: marca + datos negocio ───────────────────────
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#000').text('STOCKER', 8, doc.y, { width: innerW, align: 'center' });
    doc.moveDown(0.15);
    doc.font('Helvetica-Bold').fontSize(11).text(emisorNombre, 8, doc.y, { width: innerW, align: 'center' });
    doc.font('Helvetica').fontSize(8).text(`CUIT ${emisorCuit}`, 8, doc.y, { width: innerW, align: 'center' });
    if (business.telefono) doc.text(`Tel ${business.telefono}`, 8, doc.y, { width: innerW, align: 'center' });

    // Separador de guiones
    doc.moveDown(0.4);
    doc.font('Courier').fontSize(8).text('-'.repeat(38), 8, doc.y, { width: innerW, align: 'center' });

    // ── Datos del comprobante ─────────────────────────────────
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(9).text(`${sale.tipo === 'cotizacion' ? 'COTIZACIÓN' : 'COMPROBANTE'} ${sale.numero}`, 8, doc.y, { width: innerW, align: 'center' });
    doc.font('Helvetica').fontSize(8);
    doc.text(`Fecha: ${dateOnly(sale.fecha)}`, 8, doc.y, { width: innerW, align: 'center' });

    // Cliente
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(8).text('CLIENTE', 8);
    doc.font('Helvetica').fontSize(8);
    if (cliente) {
      doc.text(`${cliente.nombre || ''} ${cliente.apellido || ''}`.trim(), 8);
      if (cliente.cuit || cliente.dni) doc.text(`CUIT/DNI: ${cliente.cuit || cliente.dni}`, 8);
      if (cliente.telefono) doc.text(`Tel: ${cliente.telefono}`, 8);
    } else {
      doc.text('Consumidor final', 8);
    }

    // Separador
    doc.moveDown(0.3);
    doc.font('Courier').fontSize(8).text('-'.repeat(38), 8, doc.y, { width: innerW, align: 'center' });

    // ── Tabla de ítems (agrupados por producto padre) ─────────
    // Cantidad | Descripción | Subtotal
    const grouped = new Map();
    for (const it of items) {
      const key = it.skuAgrupador || it.sku;
      const prev = grouped.get(key);
      if (prev) {
        prev.cantidad += Number(it.cantidad);
        prev.subtotal += Number(it.subtotal);
      } else {
        grouped.set(key, {
          titulo: it.titulo,
          cantidad: Number(it.cantidad),
          subtotal: Number(it.subtotal),
          precioUnitario: Number(it.precioUnitario),
        });
      }
    }

    doc.moveDown(0.2);
    // Header
    doc.font('Courier-Bold').fontSize(8);
    doc.text('CANT DESCRIPCION       IMPORTE', 8, doc.y, { width: innerW });
    doc.moveDown(0.15);
    doc.font('Courier').fontSize(8).text('-'.repeat(38), 8, doc.y, { width: innerW, align: 'center' });

    doc.font('Helvetica').fontSize(8);
    for (const g of grouped.values()) {
      // Título del producto padre en su propia línea (puede ser largo),
      // y debajo "cantidad x precio unitario" con el subtotal alineado a la
      // derecha — como en cualquier ticket de supermercado.
      doc.font('Helvetica-Bold').fontSize(8.5).text(g.titulo, 8, doc.y, { width: innerW });
      const y = doc.y;
      const unitario = g.precioUnitario || (g.cantidad ? g.subtotal / g.cantidad : 0);
      doc.font('Courier').fontSize(8).text(`${g.cantidad} x ${money(unitario)}`, 8, y, { width: innerW * 0.6 });
      doc.font('Courier').fontSize(8).text(money(g.subtotal), 8, y, { width: innerW, align: 'right' });
      doc.moveDown(0.2);
    }

    // Separador y total
    doc.font('Courier').fontSize(8).text('-'.repeat(38), 8, doc.y, { width: innerW, align: 'center' });
    doc.moveDown(0.2);
    const total = money(sale.total);
    doc.font('Helvetica-Bold').fontSize(13).text('TOTAL', 8, doc.y, { width: innerW / 2, continued: true });
    doc.text(total, 8, doc.y, { width: innerW, align: 'right' });

    if (Number(sale.descuento) > 0) {
      doc.moveDown(0.15);
      doc.font('Helvetica').fontSize(8).text(`Descuento (${sale.descuentoPct || 0}%): ${money(sale.descuento)}`, 8, doc.y, { width: innerW, align: 'right' });
    }

    /*
     * Desglose del cobro.
     *
     * Con pago combinado, "Forma de pago: Efectivo + Transferencia" no dice
     * cuánto entró por cada uno, que es justo lo que el cliente necesita ver
     * y lo que hace falta para cuadrar la caja. Se lista una línea por medio,
     * con su recargo si lo tuvo.
     */
    const pagos = Array.isArray(sale.pagos) ? sale.pagos : [];
    if (pagos.length) {
      doc.moveDown(0.3);
      doc.font('Helvetica-Bold').fontSize(8.5).text('Formas de pago', 8, doc.y, { width: innerW });
      doc.moveDown(0.15);
      for (const pago of pagos) {
        const ajuste = Number(pago.ajusteMonto) || 0;
        doc.font('Helvetica').fontSize(8)
           .text(`${pago.nombre}`, 8, doc.y, { width: innerW * 0.55, continued: true })
           .text(money(pago.montoFinal), { width: innerW * 0.45, align: 'right' });
        if (ajuste !== 0) {
          const etiqueta = ajuste > 0 ? 'recargo' : 'descuento';
          doc.font('Helvetica').fontSize(6.5).fillColor('#666')
             .text(`   ${money(pago.monto)} + ${etiqueta} ${pago.ajustePct}% (${money(Math.abs(ajuste))})`,
                   8, doc.y, { width: innerW });
          doc.fillColor('#000');
        }
      }
      const totalCobrado = Number(sale.totalCobrado) || Number(sale.total);
      if (Number(sale.recargoPagos)) {
        doc.moveDown(0.15);
        doc.font('Helvetica-Bold').fontSize(9)
           .text('TOTAL COBRADO', 8, doc.y, { width: innerW * 0.55, continued: true })
           .text(money(totalCobrado), { width: innerW * 0.45, align: 'right' });
      }
    } else if (sale.condicionPago === 'cuenta_corriente' && Number(sale.saldoPendiente) > 0) {
      /*
       * Venta fiada todavía sin cobrar: no hay medio de pago que imprimir
       * porque se elige al cobrarla. Lo que el cliente tiene que llevarse por
       * escrito es cuánto quedó debiendo.
       */
      doc.moveDown(0.3);
      doc.font('Helvetica-Bold').fontSize(9).text('VENTA EN CUENTA CORRIENTE', 8, doc.y, { width: innerW });
      doc.moveDown(0.15);
      doc.font('Helvetica-Bold').fontSize(9)
         .text('SALDO ADEUDADO', 8, doc.y, { width: innerW * 0.55, continued: true })
         .text(money(sale.saldoPendiente), { width: innerW * 0.45, align: 'right' });
    } else if (sale.medioPago) {
      doc.moveDown(0.3);
      doc.font('Helvetica-Bold').fontSize(9).text(`Forma de pago: ${sale.medioPago}`, 8, doc.y, { width: innerW });
    }

    // ── Pie ───────────────────────────────────────────────────
    doc.moveDown(0.6);
    doc.font('Courier').fontSize(8).text('-'.repeat(38), 8, doc.y, { width: innerW, align: 'center' });
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(7.5).fillColor('#000')
       .text('Gracias por su compra', 8, doc.y, { width: innerW, align: 'center' });
    doc.font('Helvetica').fontSize(6.5).fillColor('#666')
       .text('Documento no válido como factura', 8, doc.y, { width: innerW, align: 'center' });
    doc.text('Emitido por Stocker', 8, doc.y, { width: innerW, align: 'center' });

    doc.end();
    stream.on('finish', () => resolve(path.relative(process.cwd(), filepath)));
    stream.on('error', reject);
  });
}

/*
 * Comprobante del cobro de la suscripción a Stocker.
 *
 * No es una factura: Stocker emite la suya por ARCA aparte. Esto es el
 * comprobante del pago, que es lo que el cliente necesita para su propia
 * contabilidad y lo primero que pide cuando cierra el mes.
 */
async function generateSubscriptionReceiptPdf(pago, negocio, plan) {
  await ensureDir();
  const ruta = path.join(PDF_DIR, `recibo-suscripcion-${pago.id}.pdf`);
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const stream = fs.createWriteStream(ruta);
  doc.pipe(stream);

  const anchoUtil = doc.page.width - 100;

  // Encabezado
  doc.rect(0, 0, doc.page.width, 110).fill(COLOR.ink950);
  doc.fillColor(COLOR.paper50).font('Helvetica-Bold').fontSize(22)
     .text('STOCKER', 50, 38);
  doc.fillColor(COLOR.brass500).font('Helvetica-Bold').fontSize(10)
     .text('COMPROBANTE DE PAGO', 50, 68, { characterSpacing: 1.5 });
  doc.fillColor(COLOR.ink400).font('Helvetica').fontSize(9)
     .text(`N.º ${String(pago.id).padStart(8, '0')}`, 50, 84);

  doc.fillColor(COLOR.ink950);
  let y = 150;

  const fila = (etiqueta, valor, opciones = {}) => {
    doc.font('Helvetica').fontSize(9).fillColor(COLOR.ink600)
       .text(etiqueta, 50, y, { width: 160 });
    doc.font(opciones.fuerte ? 'Helvetica-Bold' : 'Helvetica')
       .fontSize(opciones.fuerte ? 12 : 10)
       .fillColor(opciones.fuerte ? COLOR.ink950 : COLOR.ink800)
       .text(String(valor ?? '—'), 210, y - (opciones.fuerte ? 2 : 0), { width: anchoUtil - 160 });
    y += opciones.fuerte ? 26 : 20;
  };

  doc.font('Helvetica-Bold').fontSize(11).fillColor(COLOR.ink950).text('Cliente', 50, y);
  y += 20;
  fila('Negocio', negocio.nombreNegocio);
  fila('CUIT', negocio.cuit);
  fila('Email', negocio.email);

  y += 10;
  doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor(COLOR.line).stroke();
  y += 20;

  doc.font('Helvetica-Bold').fontSize(11).fillColor(COLOR.ink950).text('Detalle', 50, y);
  y += 20;
  fila('Concepto', `Suscripción a Stocker${plan ? ` — ${plan.nombre}` : ''}`);
  if (pago.periodoDesde && pago.periodoHasta) {
    fila('Período', `${dateOnly(pago.periodoDesde)} al ${dateOnly(pago.periodoHasta)}`);
  }
  fila('Medio de pago', pago.metodo === 'mercadopago' ? 'Mercado Pago'
                     : pago.metodo === 'transferencia' ? 'Transferencia bancaria'
                     : 'Registrado manualmente');
  if (pago.proveedorRef) fila('Referencia', pago.proveedorRef);
  fila('Fecha de pago', dateOnly(pago.fecha));

  y += 12;
  doc.rect(50, y, anchoUtil, 46).fill(COLOR.paper100);
  doc.fillColor(COLOR.ink600).font('Helvetica').fontSize(9)
     .text('TOTAL ABONADO', 66, y + 12, { characterSpacing: 1 });
  doc.fillColor(COLOR.ink950).font('Helvetica-Bold').fontSize(18)
     .text(money(pago.monto), 66, y + 24, { width: anchoUtil - 32, align: 'right' });
  y += 70;

  doc.fillColor(COLOR.ink400).font('Helvetica').fontSize(8)
     .text(
       'Este comprobante acredita el pago de la suscripción al servicio. ' +
       'La factura electrónica correspondiente se emite por separado.',
       50, y, { width: anchoUtil }
     );

  doc.end();
  // Se espera al stream y no a `doc`: el documento termina antes de que el
  // archivo esté escrito en disco, y devolver la ruta antes deja al que la
  // recibe leyendo un PDF a medias.
  await new Promise((resolver, rechazar) => {
    stream.on('finish', resolver);
    stream.on('error', rechazar);
  });
  return ruta;
}

module.exports = { generateInvoicePdf, generateInvoicePdfBuffer, generateSalePdf, generateSaleTicketPdf, generateSubscriptionReceiptPdf, PDF_DIR, COLOR };
