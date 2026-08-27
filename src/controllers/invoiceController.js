const path = require('path');
const fse = require('fs-extra');
const sequelize = require('../config/database');
const { Invoice, InvoiceItem, Sale, SaleItem, Business, Client, BusinessCuit, BusinessArcaConfig } = require('../models');
const { nextInvoiceNumber, crearConNumero } = require('../services/invoiceNumberService');
const { tipoComprobante, solicitarCAE, determineInvoiceType, calcularIVA } = require('../services/arcaService');
const { lookupCuit } = require('../services/arcaLookupService');
const { generateInvoicePdf, generateInvoicePdfBuffer } = require('../services/pdfService');
const { sendInvoiceEmail } = require('../services/emailService');
const { sendInvoiceWhatsapp } = require('../services/whatsappService');
const { exigirCupo } = require('../services/planService');

// GET /api/invoices
const getInvoices = async (req, res, next) => {
  try {
    const { Op } = require('sequelize');
    const { desde, hasta, tipo, estado, page = 1, limit = 30 } = req.query;
    const where = { businessId: req.auth.businessId };
    if (tipo)   where.tipo   = tipo;
    if (estado) where.estado = estado;
    if (desde || hasta) {
      where.fechaEmision = {};
      if (desde) where.fechaEmision[Op.gte] = new Date(desde);
      if (hasta) where.fechaEmision[Op.lte] = new Date(`${hasta}T23:59:59`);
    }

    const offset = (Math.max(1, Number(page)) - 1) * Math.min(Number(limit), 100);
    const { count, rows } = await Invoice.findAndCountAll({
      where, offset, limit: Math.min(Number(limit), 100),
      include: [
        { model: InvoiceItem, as: 'items' },
        { association: 'cliente', attributes: ['id', 'nombre', 'apellido', 'cuit'] },
        { association: 'empleado', attributes: ['id', 'nombre', 'apellido'] },
      ],
      order: [['fechaEmision', 'DESC']],
      distinct: true,
    });

    /*
     * Totales del filtro completo, no de la página visible. Mismo criterio que
     * en ventas: la pregunta que se hace al filtrar por mes es "cuánto facturé",
     * y eso no se responde sumando las treinta filas que se ven.
     *
     * Las anuladas se cuentan aparte y NO suman: una nota de crédito deja el
     * comprobante sin efecto fiscal, así que incluirla infla lo facturado.
     */
    const emitidas = { ...where, estado: 'emitida' };
    const [totalEmitido, cantidadEmitidas, anuladas] = await Promise.all([
      Invoice.sum('total', { where: emitidas }),
      Invoice.count({ where: emitidas }),
      Invoice.count({ where: { ...where, estado: 'anulada' } }),
    ]);

    res.json({
      total: count,
      page: Number(page),
      totalPages: Math.ceil(count / limit),
      data: rows,
      resumen: {
        cantidad: count,
        emitidas: cantidadEmitidas,
        anuladas,
        totalEmitido: Number(totalEmitido) || 0,
      },
    });
  } catch (error) { next(error); }
};

// GET /api/invoices/:id
const getInvoice = async (req, res, next) => {
  try {
    const invoice = await Invoice.findOne({
      where: { id: req.params.id, businessId: req.auth.businessId },
      include: [{ model: InvoiceItem, as: 'items' }, { association: 'cliente' }, { association: 'venta' }],
    });
    if (!invoice) return res.status(404).json({ message: 'Factura no encontrada.' });
    res.json(invoice);
  } catch (error) { next(error); }
};

// POST /api/invoices  → genera factura desde una venta pagada
const createInvoice = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const { saleId, clienteCuit, clienteEmail, clienteDireccion, tipoOverride, enviarEmail = true, enviarWhatsapp = true, businessCuitId } = req.body;

    /*
     * La venta se traba antes de mirar si ya tiene factura.
     *
     * Las dos consultas corrían fuera de la transacción y sin lock, y entre el
     * "¿ya tiene factura?" y el guardado hay un viaje a ARCA que tarda
     * segundos. Dos pedidos simultáneos para la misma venta pasaban los dos el
     * control, pedían los dos un CAE —dos autorizaciones fiscales de verdad,
     * quemadas— y recién chocaban al insertar, contra uq_invoices_sale. La
     * fila duplicada no llegaba a existir, pero el número fiscal ya estaba
     * gastado y el cupo del mes también.
     *
     * Con el lock, el segundo espera al primero y encuentra la factura ya
     * grabada: rebota con 409 sin haber molestado a ARCA.
     *
     * Sin `include`: Postgres rechaza FOR UPDATE sobre el lado nulo de un LEFT
     * JOIN, así que los ítems y el cliente se cargan aparte.
     */
    const sale = await Sale.findOne({
      where: { id: saleId, businessId: req.auth.businessId },
      transaction: t, lock: t.LOCK.UPDATE,
    });
    if (!sale)             throw Object.assign(new Error('Venta no encontrada.'), { status: 404 });
    if (sale.estado !== 'pagado') throw Object.assign(new Error('Solo se puede facturar una venta ya cobrada.'), { status: 400 });

    const existingInvoice = await Invoice.findOne({
      where: { saleId, businessId: req.auth.businessId },
      transaction: t,
    });
    if (existingInvoice)   throw Object.assign(new Error('Esta venta ya tiene una factura generada.'), { status: 409 });

    sale.items = await SaleItem.findAll({ where: { saleId: sale.id }, transaction: t });
    sale.cliente = sale.clientId
      ? await Client.findOne({ where: { id: sale.clientId, businessId: req.auth.businessId }, transaction: t })
      : null;

    /*
     * Tope de comprobantes del mes.
     *
     * Va después de las validaciones de la venta y antes de pedirle el CAE a
     * ARCA: cortar acá evita quemar un número de comprobante que después
     * habría que anular. Se cuenta el mes corriente y arranca de cero el día 1.
     */
    await exigirCupo(req.auth.businessId, 'comprobantes');

    const business = await Business.findByPk(req.auth.businessId);

    // Elegir CUIT emisor: businessCuitId explícito, o el marcado principal, o el del negocio (fallback legacy)
    let emisor = null;
    if (businessCuitId) {
      emisor = await BusinessCuit.findOne({ where: { id: businessCuitId, businessId: req.auth.businessId } });
      if (!emisor) throw Object.assign(new Error('CUIT emisor no encontrado en este negocio.'), { status: 400 });
    } else {
      emisor = await BusinessCuit.findOne({ where: { businessId: req.auth.businessId, esPrincipal: true } });
      if (!emisor) emisor = await BusinessCuit.findOne({ where: { businessId: req.auth.businessId } });
    }
    const emisorCuit   = emisor?.cuit   || business.cuit;
    const emisorNombre = emisor?.nombre || business.nombreNegocio;

    // Datos del cliente (del registro o ad-hoc)
    const cliente       = sale.cliente;
    const finalCuit     = clienteCuit     || cliente?.cuit     || null;
    const finalEmail    = clienteEmail    || cliente?.email    || null;
    const finalDireccion= clienteDireccion|| cliente?.direccion|| null;
    const clienteNombre = cliente ? `${cliente.nombre} ${cliente.apellido || ''}`.trim() : (sale.clienteAdHoc || 'Consumidor Final');
    const clienteWhatsapp = cliente?.whatsapp || cliente?.telefono || null;

    // Tipo de factura (A, B o C).
    // Consultamos el padrón AFIP para saber la condición IVA REAL del receptor:
    // sin esto, cualquier CUIT de 11 dígitos se facturaba como A, cuando un
    // monotributista o un exento deben recibir B.
    let condicionReceptor = null;
    let padronInfo = null;
    if (finalCuit) {
      try {
        padronInfo = await lookupCuit(finalCuit);
        if (padronInfo?.source === 'afip') condicionReceptor = padronInfo.condicionIva;
      } catch { /* si el padrón falla, seguimos con la heurística */ }
    }
    /*
     * La letra sale del emisor primero y del receptor después.
     *
     * La condición del emisor se toma de su config de ARCA y, si no está, del
     * CUIT. Un monotributista emite C siempre; sólo un responsable inscripto
     * elige entre A y B según a quién le venda.
     *
     * `tipoOverride` sigue mandando sobre todo: es la salida manual para los
     * casos que la regla no cubre.
     */
    const configEmisor = emisor?.id
      ? await BusinessArcaConfig.findOne({ where: { businessCuitId: emisor.id } })
      : null;
    const condicionEmisor = configEmisor?.condicionIva || emisor?.condicionIva || business.condicionIva || null;

    const tipo = tipoOverride || tipoComprobante({
      condicionEmisor,
      condicionReceptor: condicionReceptor
        || (padronInfo?.condicionIvaId === 1 ? 'Responsable Inscripto' : null),
      clienteCuit: finalCuit,
    });

    /*
     * Se factura lo que el cliente efectivamente paga, recargo del medio de
     * pago incluido. Si una venta de $10.000 se cobra por transferencia con
     * 5% de recargo, entran $10.500 y ese es el importe que corresponde
     * declarar: el comprobante tiene que reflejar el movimiento real de
     * dinero, no el precio de lista.
     *
     * `totalCobrado` es 0 en las ventas anteriores a los medios de pago con
     * ajuste, así que ahí se cae al total de siempre.
     */
    const totalAFacturar = Number(sale.totalCobrado) || Number(sale.total);
    const { neto, iva } = calcularIVA(totalAFacturar, tipo);

    // La config del emisor ya se leyó arriba para decidir la letra.
    const arcaConfig = configEmisor;
    const { cae, caeVencimiento, respuesta: arcaRespuesta } = await solicitarCAE({
      tipo, total: totalAFacturar, clienteCuit: finalCuit,
      clienteCondicion: condicionReceptor,
      businessCuit: emisorCuit,
      puntoVenta: arcaConfig?.puntoVenta || null,
      ambiente:   arcaConfig?.ambiente   || 'homologacion',
      items: sale.items,
    });

    /*
     * Crear Invoice en BD.
     *
     * El número se calcula acá adentro, después del CAE y no antes: entre
     * pedirle el CAE a ARCA y guardar pueden pasar varios segundos, y en esa
     * ventana otra caja factura y se lleva el número. El CAE queda afuera del
     * reintento a propósito —se pide una sola vez, pase lo que pase con la
     * numeración—; lo único que se repite es el INSERT.
     */
    const invoice = await crearConNumero(
      (saltar) => nextInvoiceNumber(req.auth.businessId, saltar, t),
      (numero, sp) => Invoice.create({
        businessId:    req.auth.businessId,
        saleId:        sale.id,
        clientId:      sale.clientId || null,
        employeeId:    req.auth.employeeId || sale.employeeId,
        numero, tipo,
        clienteNombre, clienteCuit: finalCuit,
        clienteEmail:  finalEmail,
        clienteDireccion: finalDireccion,
        subtotal:      Number(sale.subtotal),
        iva, total:    totalAFacturar,
        esMayorista:   sale.esMayorista,
        cae, caeVencimiento,
        arcaRespuesta,
        businessCuitId: emisor?.id || null,
        emisorCuit, emisorNombre,
        fechaEmision:  new Date(),
        estado:        'emitida',
      }, { transaction: sp || t }),
      { transaction: t },
    );

    // InvoiceItems: snapshot completo de cada variante
    const invoiceItems = sale.items.map((i) => ({
      invoiceId:       invoice.id,
      titulo:          i.titulo,
      sku:             i.sku,
      skuAgrupador:    i.skuAgrupador,
      variante1Nombre: i.variante1Nombre,
      variante1Valor:  i.variante1Valor,
      variante2Nombre: i.variante2Nombre,
      variante2Valor:  i.variante2Valor,
      cantidad:        i.cantidad,
      esMayorista:     i.esMayorista,
      precioUnitario:  Number(i.precioUnitario),
      subtotal:        Number(i.subtotal),
    }));

    // El recargo va como línea propia: si no, el comprobante mostraría
    // productos por $10.000 y un total de $10.500 sin explicar la diferencia.
    // Si el ajuste fue un descuento, la línea sale en negativo.
    const ajuste = Number(sale.recargoPagos) || 0;
    if (ajuste !== 0) {
      const detalle = sale.medioPago ? ` (${sale.medioPago})` : '';
      invoiceItems.push({
        invoiceId:      invoice.id,
        titulo:         ajuste > 0 ? `Recargo por medio de pago${detalle}` : `Descuento por medio de pago${detalle}`,
        sku:            null,
        cantidad:       1,
        esMayorista:    false,
        precioUnitario: ajuste,
        subtotal:       ajuste,
      });
    }

    await InvoiceItem.bulkCreate(invoiceItems, { transaction: t });

    await t.commit();

    // Generar PDF (fuera de la transacción)
    const items = await InvoiceItem.findAll({ where: { invoiceId: invoice.id } });
    const pdfPath = await generateInvoicePdf(invoice.toJSON(), items, business.toJSON()).catch((err) => {
      console.error('[PDF] Error generando PDF:', err.message);
      return null;
    });

    /*
     * `pdfPath` ya NO se guarda en la factura.
     *
     * Apuntaba a un archivo del contenedor, y en Railway el disco se borra en
     * cada deploy: la columna quedaba señalando algo que no existe. Peor, daba
     * a entender que la factura vive en ese archivo cuando la fuente es la
     * base — `/api/invoices/:id/pdf` la regenera entera cada vez que se pide.
     *
     * El archivo se genera igual porque el mail lo adjunta, y se borra apenas
     * sale.
     */
    const absPdf = pdfPath ? path.resolve(pdfPath) : null;

    // Notificaciones
    if (finalEmail && enviarEmail) {
      sendInvoiceEmail({ to: finalEmail, clienteNombre, invoice: invoice.toJSON(), pdfPath: absPdf, business: business.toJSON() })
        .catch((err) => console.error('[email]', err.message))
        .finally(() => { if (absPdf) fse.remove(absPdf).catch(() => {}); });
    } else if (absPdf) {
      // Sin mail que lo adjunte, el archivo no tiene ningún uso.
      await fse.remove(absPdf).catch(() => {});
    }

    if (clienteWhatsapp && enviarWhatsapp) {
      sendInvoiceWhatsapp({ telefono: clienteWhatsapp, clienteNombre, invoice: invoice.toJSON(), business: business.toJSON() })
        .catch((err) => console.error('[whatsapp]', err.message));
    }

    const full = await Invoice.findByPk(invoice.id, { include: [{ model: InvoiceItem, as: 'items' }] });
    res.status(201).json(full);
  } catch (error) { await t.rollback().catch(() => {}); next(error); }
};

// PATCH /api/invoices/:id/anular
const voidInvoice = async (req, res, next) => {
  try {
    const invoice = await Invoice.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!invoice) return res.status(404).json({ message: 'Factura no encontrada.' });
    await invoice.update({ estado: 'anulada' });
    res.json(invoice);
  } catch (error) { next(error); }
};

// GET /api/invoices/:id/pdf  → devuelve el PDF (regenerado en memoria, sin disco)
const downloadPdf = async (req, res, next) => {
  try {
    const invoice = await Invoice.findOne({
      where: { id: req.params.id, businessId: req.auth.businessId },
      include: [{ model: InvoiceItem, as: 'items' }],
    });
    if (!invoice) return res.status(404).json({ message: 'Factura no encontrada.' });

    const business = await Business.findByPk(req.auth.businessId);
    const buffer = await generateInvoicePdfBuffer(invoice.toJSON(), invoice.items || [], business.toJSON());

    const filename = `factura-${(invoice.numero || invoice.id).toString().replace(/\//g, '-')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (error) { next(error); }
};

module.exports = { getInvoices, getInvoice, createInvoice, voidInvoice, downloadPdf };
