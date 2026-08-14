const path = require('path');
const sequelize = require('../config/database');
const { Sale, SaleItem, SalePayment, ProductVariant, Product, Client, Employee, BusinessLocation, StockMovement, Business, BusinessCuit } = require('../models');
const { nextSaleNumber } = require('../services/invoiceNumberService');
const { calcularPagos } = require('../services/paymentService');
const { generateSalePdf, generateSaleTicketPdf } = require('../services/pdfService');
const { sendSaleReceiptToCustomer, sendSaleNotificationToBusiness } = require('../services/emailService');
const { sendSaleWhatsapp } = require('../services/whatsappService');

// Genera PDF de la venta y dispara mails (cliente + negocio) sin bloquear la request.
async function notifySaleAsync(saleId, businessId) {
  try {
    const sale = await Sale.findByPk(saleId, {
      include: [
        { model: SaleItem, as: 'items' },
        { association: 'cliente' },
        { association: 'empleado', attributes: ['id', 'nombre', 'apellido'] },
      ],
    });
    if (!sale || sale.tipo === 'cotizacion') return;

    const business = await Business.findByPk(businessId);
    const emisor   = await BusinessCuit.findOne({ where: { businessId, esPrincipal: true } })
                  || await BusinessCuit.findOne({ where: { businessId } });

    const pdfPath = await generateSalePdf(sale.toJSON(), sale.items.map((i) => i.toJSON()), business.toJSON(), {
      cliente: sale.cliente?.toJSON() || null,
      emisor:  emisor?.toJSON()       || null,
    }).catch((err) => { console.error('[PDF venta] ', err.message); return null; });

    const absPdf = pdfPath ? path.resolve(pdfPath) : null;

    // Mail al cliente si tiene email
    if (sale.cliente?.email) {
      sendSaleReceiptToCustomer({
        to: sale.cliente.email,
        cliente: sale.cliente.toJSON(),
        sale: sale.toJSON(),
        items: sale.items.map((i) => i.toJSON()),
        business: business.toJSON(),
        emisor: emisor?.toJSON() || null,
        pdfPath: absPdf,
      }).catch((err) => console.error('[email cliente]', err.message));
    }
    // Aviso interno al negocio (siempre)
    if (business.email) {
      sendSaleNotificationToBusiness({
        to: business.email,
        cliente: sale.cliente?.toJSON() || null,
        sale: sale.toJSON(),
        items: sale.items.map((i) => i.toJSON()),
        business: business.toJSON(),
        emisor: emisor?.toJSON() || null,
        empleado: sale.empleado?.toJSON() || null,
        pdfPath: absPdf,
      }).catch((err) => console.error('[email negocio]', err.message));
    }
    // WhatsApp al cliente (prefiere whatsapp, cae en telefono)
    const wpTo = sale.cliente?.whatsapp || sale.cliente?.telefono;
    if (wpTo) {
      sendSaleWhatsapp({
        telefono: wpTo,
        cliente:  sale.cliente?.toJSON() || null,
        sale:     sale.toJSON(),
        business: business.toJSON(),
        emisor:   emisor?.toJSON() || null,
      }).catch((err) => console.error('[whatsapp cliente]', err.message));
    }
  } catch (err) {
    console.error('[notifySaleAsync]', err.message);
  }
}

// Precio según mayorista (>= 3 prendas totales en la venta)
function calcPrecio(variant, esMayorista) {
  const padre = variant.producto;
  return esMayorista ? Number(padre.precioMayorista) : Number(padre.precioMinorista);
}

// GET /api/sales
const getSales = async (req, res, next) => {
  try {
    const { tipo, estado, desde, hasta, clientId, page = 1, limit = 30 } = req.query;
    const { Op } = require('sequelize');
    const where = { businessId: req.auth.businessId };
    if (tipo)     where.tipo   = tipo;
    if (estado)   where.estado = estado;
    if (clientId) where.clientId = clientId;
    if (desde || hasta) {
      where.fecha = {};
      if (desde) where.fecha[Op.gte] = desde;
      if (hasta) where.fecha[Op.lte] = hasta;
    }

    const offset = (Math.max(1, Number(page)) - 1) * Math.min(Number(limit), 100);
    const { count, rows } = await Sale.findAndCountAll({
      where, offset, limit: Math.min(Number(limit), 100),
      include: [
        { model: SaleItem, as: 'items' },
        { association: 'cliente', attributes: ['id', 'nombre', 'apellido', 'cuit'] },
        { association: 'empleado', attributes: ['id', 'nombre', 'apellido'] },
        { association: 'local',   attributes: ['id', 'nombre'] },
      ],
      order: [['createdAt', 'DESC']],
      distinct: true,
    });

    res.json({ total: count, page: Number(page), totalPages: Math.ceil(count / limit), data: rows });
  } catch (error) { next(error); }
};

// GET /api/sales/:id
const getSale = async (req, res, next) => {
  try {
    const sale = await Sale.findOne({
      where: { id: req.params.id, businessId: req.auth.businessId },
      include: [
        { model: SaleItem, as: 'items' },
        { association: 'cliente' },
        { association: 'empleado', attributes: ['id', 'nombre', 'apellido'] },
        { association: 'local', attributes: ['id', 'nombre', 'direccion'] },
        { association: 'factura' },
      ],
    });
    if (!sale) return res.status(404).json({ message: 'Venta no encontrada.' });
    res.json(sale);
  } catch (error) { next(error); }
};

// POST /api/sales
const createSale = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const {
      tipo = 'venta', fecha, clientId, locationId: locationIdPedido, items = [],
      descuentoPct = 0, estado, medioPago, notas, cotizacionId,
      // Detalle de cobro: una línea por medio de pago usado.
      pagos,
      // Si no hay clientId registrado, datos ad-hoc del cliente
      clienteAdHoc,
    } = req.body;

    if (!items.length) throw Object.assign(new Error('La venta necesita al menos un ítem.'), { status: 400 });

    // El vendedor es siempre quien está logueado: un empleado no puede
    // registrar una venta a nombre de otro. El dueño no tiene employeeId, así
    // que sus ventas quedan sin vendedor asignado salvo que lo mande.
    const employeeId = req.auth.employeeId || null;

    // El local también se fija solo para los empleados, con el que tienen
    // asignado. Lo que llegue en el body se ignora: la restricción es del
    // servidor, no de que el frontend deshabilite el desplegable.
    let locationId = locationIdPedido || null;
    if (req.auth.employeeId) {
      const empleado = await Employee.findOne({
        where: { id: req.auth.employeeId, businessId: req.auth.businessId },
        transaction: t,
      });
      locationId = empleado?.locationId || null;

      // Sin turno abierto la venta no tiene contra qué arquearse: el efectivo
      // entraría a una caja que nadie rinde. Las cotizaciones no cobran, así
      // que no lo necesitan.
      if (tipo !== 'cotizacion') {
        const { turnoAbierto } = require('../services/cashService');
        const turno = await turnoAbierto(req.auth.employeeId, req.auth.businessId);
        if (!turno) {
          throw Object.assign(
            new Error('Necesitás abrir tu turno de caja antes de vender.'),
            { status: 409 }
          );
        }
      }
    } else if (locationId) {
      // Dueño: elige, pero sólo entre los locales de su negocio.
      const local = await BusinessLocation.findOne({
        where: { id: locationId, businessId: req.auth.businessId },
        transaction: t,
      });
      if (!local) throw Object.assign(new Error('El local indicado no pertenece a este negocio.'), { status: 400 });
    }

    // Determinar si es mayorista: total de unidades >= 3
    const totalUnidades = items.reduce((s, i) => s + i.cantidad, 0);
    const esMayorista   = totalUnidades >= 3;

    // Construir sale items
    const enrichedItems = [];
    for (const item of items) {
      // El id de variante viene del cliente: hay que confirmar que pertenezca
      // a este negocio. Sin esta comprobación se puede vender el producto de
      // otro negocio, leyendo su título y precio y descontándole el stock.
      const variant = await ProductVariant.findByPk(item.productVariantId, {
        include: [{ model: Product, as: 'producto' }],
        transaction: t,
      });
      if (!variant || variant.producto?.businessId !== req.auth.businessId)
        throw Object.assign(new Error(`Variante ${item.productVariantId} no encontrada.`), { status: 404 });

      /*
       * Stock disponible.
       *
       * Al descontar se hacía Math.max(0, stock - cantidad), que recorta a cero
       * en silencio: vender 5 unidades teniendo 2 dejaba la venta hecha y el
       * stock en 0, sin que nadie se enterara. A partir de ahí el inventario
       * miente y la diferencia sólo aparece al contar a mano.
       *
       * Sólo se exige en ventas que se cobran: una cotización no mueve stock.
       */
      if (tipo !== 'cotizacion' && estado === 'pagado') {
        const disponible = Number(variant.stock) || 0;
        if (disponible < item.cantidad) {
          const nombre = [variant.producto.titulo, variant.variante1Valor, variant.variante2Valor]
            .filter(Boolean).join(' · ');
          throw Object.assign(
            new Error(
              disponible === 0
                ? `No queda stock de ${nombre} (${variant.sku}).`
                : `Sólo quedan ${disponible} de ${nombre} (${variant.sku}) y estás vendiendo ${item.cantidad}.`
            ),
            { status: 409 }
          );
        }
      }

      const precioUnitario = item.precioUnitario ?? calcPrecio(variant, esMayorista);
      const subtotal = precioUnitario * item.cantidad;

      enrichedItems.push({
        productVariantId: variant.id,
        titulo:           variant.producto.titulo,
        sku:              variant.sku,
        skuAgrupador:     variant.producto.skuAgrupador,
        variante1Nombre:  variant.variante1Nombre,
        variante1Valor:   variant.variante1Valor,
        variante2Nombre:  variant.variante2Nombre,
        variante2Valor:   variant.variante2Valor,
        cantidad:         item.cantidad,
        precioUnitario,
        subtotal,
        esMayorista,
      });
    }

    const subtotal  = enrichedItems.reduce((s, i) => s + i.subtotal, 0);
    const descuento = Math.round(subtotal * Number(descuentoPct) / 100 * 100) / 100;
    const total     = subtotal - descuento;

    const finalEstado = tipo === 'cotizacion' ? 'pendiente' : (estado || 'pendiente');
    const numero = await nextSaleNumber(req.auth.businessId, tipo);

    // Los recargos y descuentos por medio de pago se calculan sobre el total
    // de mercadería. `total` no se toca: sobre él se apoyan la facturación y
    // las métricas, y el costo financiero del medio de pago no es venta.
    const { lineas, recargoPagos, totalCobrado, resumen } =
      await calcularPagos(pagos, total, req.auth.businessId);

    const sale = await Sale.create({
      businessId:  req.auth.businessId,
      locationId:  locationId || null,
      employeeId,
      clientId:    clientId || null,
      numero, tipo,
      estado:      finalEstado,
      esMayorista,
      subtotal, descuentoPct, descuento, total,
      medioPago:   finalEstado === 'pagado' ? (resumen || medioPago || null) : null,
      recargoPagos,
      totalCobrado,
      notas,
      cotizacionId: cotizacionId || null,
      fecha:       fecha || new Date().toISOString().slice(0, 10),
    }, { transaction: t });

    await SaleItem.bulkCreate(enrichedItems.map((i) => ({ ...i, saleId: sale.id })), { transaction: t });

    if (lineas.length) {
      await SalePayment.bulkCreate(
        lineas.map((l) => ({ ...l, saleId: sale.id })),
        { transaction: t }
      );
    }

    // Si se paga, descuentar stock
    if (finalEstado === 'pagado') {
      for (const item of enrichedItems) {
        const variant = await ProductVariant.findByPk(item.productVariantId, { transaction: t, lock: t.LOCK.UPDATE });
        const stockAnterior = Number(variant.stock) || 0;

        // Segunda comprobación, ahora con la fila bloqueada. La de más arriba
        // corre sin lock y da un error temprano y claro; ésta es la que
        // garantiza que dos cajas vendiendo la última unidad a la vez no la
        // vendan las dos.
        if (stockAnterior < item.cantidad) {
          throw Object.assign(
            new Error(
              `Se quedó sin stock ${item.titulo} (${item.sku}) mientras se registraba la venta: ` +
              `quedan ${stockAnterior} y se piden ${item.cantidad}.`
            ),
            { status: 409 }
          );
        }

        const stockNuevo = stockAnterior - item.cantidad;
        await variant.update({ stock: stockNuevo }, { transaction: t });
        await StockMovement.create({
          productVariantId: variant.id,
          locationId: locationId || null,
          employeeId, tipo: 'egreso',
          cantidad: item.cantidad, stockAnterior, stockNuevo,
          motivo: `Venta ${numero}`, fechaMovimiento: new Date(),
        }, { transaction: t });
      }
    }

    await t.commit();

    const full = await Sale.findByPk(sale.id, {
      include: [
        { model: SaleItem, as: 'items' },
        { association: 'cliente' },
        { association: 'empleado', attributes: ['id', 'nombre', 'apellido'] },
      ],
    });
    // Notificaciones (asíncrono, no bloquea la respuesta)
    notifySaleAsync(sale.id, req.auth.businessId);
    res.status(201).json(full);
  } catch (error) { await t.rollback(); next(error); }
};

// PATCH /api/sales/:id/estado
const updateSaleStatus = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const sale = await Sale.findOne({
      where: { id: req.params.id, businessId: req.auth.businessId },
      include: [{ model: SaleItem, as: 'items' }],
      transaction: t,
    });
    if (!sale) { await t.rollback(); return res.status(404).json({ message: 'Venta no encontrada.' }); }

    const { estado, medioPago } = req.body;
    const wasUnpaid = sale.estado !== 'pagado';

    await sale.update({ estado, medioPago: medioPago || sale.medioPago }, { transaction: t });

    if (estado === 'pagado' && wasUnpaid) {
      for (const item of sale.items) {
        const variant = await ProductVariant.findByPk(item.productVariantId, { transaction: t, lock: t.LOCK.UPDATE });
        if (!variant) continue;
        const stockAnterior = Number(variant.stock) || 0;

        // Entre que se registró la venta pendiente y este cobro pudo haberse
        // vendido la misma mercadería. Cobrar igual dejaría el stock en cero
        // sin aviso, que es lo que hacía el Math.max(0, …) de antes.
        if (stockAnterior < item.cantidad) {
          throw Object.assign(
            new Error(
              `No hay stock suficiente de ${item.titulo} (${item.sku}): quedan ${stockAnterior} ` +
              `y la venta pide ${item.cantidad}. Ajustá el stock o modificá la venta antes de cobrarla.`
            ),
            { status: 409 }
          );
        }

        const stockNuevo = stockAnterior - item.cantidad;
        await variant.update({ stock: stockNuevo }, { transaction: t });
        await StockMovement.create({
          productVariantId: variant.id,
          locationId: sale.locationId, employeeId: req.auth.employeeId || null,
          tipo: 'egreso', cantidad: item.cantidad, stockAnterior, stockNuevo,
          motivo: `Cobro venta ${sale.numero}`, fechaMovimiento: new Date(),
        }, { transaction: t });
      }
    }

    await t.commit();
    const full = await Sale.findByPk(sale.id, { include: [{ model: SaleItem, as: 'items' }, { association: 'empleado', attributes: ['id', 'nombre', 'apellido'] }] });
    // Si pasó a pagado, disparar aviso de venta al cliente/negocio (idempotente porque el PDF se sobreescribe)
    if (estado === 'pagado' && wasUnpaid) {
      notifySaleAsync(sale.id, req.auth.businessId);
    }
    res.json(full);
  } catch (error) { await t.rollback(); next(error); }
};

// POST /api/sales/cotizacion/:id/convertir
// Convierte una cotización en venta sin facturar
const convertQuoteToSale = async (req, res, next) => {
  try {
    const quote = await Sale.findOne({ where: { id: req.params.id, tipo: 'cotizacion', businessId: req.auth.businessId } });
    if (!quote) return res.status(404).json({ message: 'Cotización no encontrada.' });

    const numero = await nextSaleNumber(req.auth.businessId, 'venta');
    await quote.update({ tipo: 'venta', estado: 'pendiente', numero });
    res.json(quote);
  } catch (error) { next(error); }
};

// GET /api/sales/:id/ticket → devuelve PDF de ticket 80mm inline
const downloadTicket = async (req, res, next) => {
  try {
    const sale = await Sale.findOne({
      where: { id: req.params.id, businessId: req.auth.businessId },
      include: [{ model: SaleItem, as: 'items' }, { association: 'cliente' }],
    });
    if (!sale) return res.status(404).json({ message: 'Venta no encontrada.' });

    const business = await Business.findByPk(req.auth.businessId);
    const emisor   = await BusinessCuit.findOne({ where: { businessId: req.auth.businessId, esPrincipal: true } })
                  || await BusinessCuit.findOne({ where: { businessId: req.auth.businessId } });

    const pdfPath = await generateSaleTicketPdf(sale.toJSON(), sale.items.map(i => i.toJSON()), business.toJSON(), {
      cliente: sale.cliente?.toJSON() || null,
      emisor:  emisor?.toJSON()       || null,
    });
    const abs = path.resolve(pdfPath);
    res.download(abs, `ticket-${sale.numero.replace(/\//g, '-')}.pdf`);
  } catch (error) { next(error); }
};

module.exports = { getSales, getSale, createSale, updateSaleStatus, convertQuoteToSale, downloadTicket };
