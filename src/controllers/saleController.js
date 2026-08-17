const path = require('path');
const sequelize = require('../config/database');
const { Sale, SaleItem, SalePayment, ProductVariant, Product, Employee, BusinessLocation, Business, BusinessCuit } = require('../models');
const { nextSaleNumber } = require('../services/invoiceNumberService');
const { calcularPagos } = require('../services/paymentService');
const { cargarVenta, registrarMovimiento, redondear } = require('../services/creditService');
const { descontarStockVenta, devolverStockVenta } = require('../services/saleStockService');
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
    const { tipo, estado, condicionPago, desde, hasta, clientId, page = 1, limit = 30 } = req.query;
    const { Op } = require('sequelize');
    const where = { businessId: req.auth.businessId };
    if (tipo)     where.tipo   = tipo;
    if (estado)   where.estado = estado;
    if (clientId) where.clientId = clientId;
    // Permite listar sólo lo fiado sin traerse todas las ventas al frontend.
    if (condicionPago) where.condicionPago = condicionPago;
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
        { association: 'pagos' },
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
      // 'contado' (se cobra ahora) o 'cuenta_corriente' (se fía).
      condicionPago: condicionPedida,
      // Sólo para las fiadas: si el cliente se lleva la mercadería ahora.
      descontarStock,
      // Si no hay clientId registrado, datos ad-hoc del cliente
      clienteAdHoc,
    } = req.body;

    if (!items.length) throw Object.assign(new Error('La venta necesita al menos un ítem.'), { status: 400 });

    /*
     * Venta fiada.
     *
     * Fiar es una condición de la venta, no un medio de pago: al registrarla
     * todavía no se sabe con qué va a pagar el cliente, así que no se pide
     * medio de pago. Queda pendiente, con el total anotado como deuda suya, y
     * al cobrarla recién ahí entran los medios y sus combinaciones.
     *
     * Una cotización no fía nada: todavía no hay venta.
     */
    const condicionPago = condicionPedida === 'cuenta_corriente' && tipo !== 'cotizacion'
      ? 'cuenta_corriente'
      : 'contado';
    const esFiado = condicionPago === 'cuenta_corriente';

    // Fiar es la función que separa al Enterprise: se controla acá y no en la
    // ruta porque POST /sales sirve para los dos tipos de venta.
    if (esFiado) {
      const { tieneFeature } = require('../services/planService');
      const { FEATURES } = require('../config/planes');
      if (!(await tieneFeature(req.auth.businessId, FEATURES.CUENTAS_CORRIENTES))) {
        throw Object.assign(
          new Error('Las ventas en cuenta corriente están incluidas en el Plan Enterprise.'),
          { status: 402, motivo: 'plan', feature: FEATURES.CUENTAS_CORRIENTES }
        );
      }
    }

    if (esFiado && !clientId) {
      throw Object.assign(
        new Error('Para fiar hay que elegir un cliente: no se puede vender en cuenta corriente a consumidor final.'),
        { status: 400 }
      );
    }

    /*
     * Estado y salida de mercadería, que dejaron de ir juntos.
     *
     *   contado pagado   → cobrada y entregada en el acto (mostrador).
     *   contado pendiente→ ni cobrada ni entregada; sale al cobrarla.
     *   fiada            → pendiente, pero la mercadería sale ahora salvo que
     *                      el vendedor destilde "se la lleva": una seña que
     *                      queda en el local no puede descontar stock.
     */
    const finalEstado = tipo === 'cotizacion' || esFiado ? 'pendiente' : (estado || 'pendiente');
    const sacaMercaderia = tipo === 'cotizacion'
      ? false
      : (esFiado ? descontarStock !== false : finalEstado === 'pagado');

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
       * Se exige cuando la mercadería sale ahora, esté cobrada o fiada: lo que
       * importa es que salga del depósito, no que haya entrado la plata.
       */
      if (sacaMercaderia) {
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

    const numero = await nextSaleNumber(req.auth.businessId, tipo);

    // Los recargos y descuentos por medio de pago se calculan sobre el total
    // de mercadería. `total` no se toca: sobre él se apoyan la facturación y
    // las métricas, y el costo financiero del medio de pago no es venta.
    //
    // En una venta fiada no hay medios que calcular: se ignora lo que llegue
    // en `pagos` para que el frontend no pueda dejar un cobro anotado sobre
    // plata que todavía no entró.
    const { lineas, recargoPagos, totalCobrado, resumen } =
      await calcularPagos(esFiado ? null : pagos, total, req.auth.businessId);

    const sale = await Sale.create({
      businessId:  req.auth.businessId,
      locationId:  locationId || null,
      employeeId,
      clientId:    clientId || null,
      numero, tipo,
      estado:      finalEstado,
      condicionPago,
      esMayorista,
      subtotal, descuentoPct, descuento, total,
      medioPago:   finalEstado === 'pagado' ? (resumen || medioPago || null) : null,
      recargoPagos: finalEstado === 'pagado' ? recargoPagos : 0,
      // Lo cobrado sólo tiene sentido cuando efectivamente se cobró. Una venta
      // pendiente con `totalCobrado` cargado hacía figurar plata que no entró.
      totalCobrado: finalEstado === 'pagado' ? totalCobrado : 0,
      // Lo que falta cobrar: nada si se cobró en el acto, todo si quedó abierta.
      saldoPendiente: tipo === 'cotizacion' || finalEstado === 'pagado' ? 0 : total,
      // Lo pone `descontarStockVenta` unas líneas más abajo; arranca en false
      // para que el helper sepa que todavía no salió.
      stockDescontado: false,
      cobradoEn:            finalEstado === 'pagado' ? new Date() : null,
      cobradoPorEmployeeId: finalEstado === 'pagado' ? employeeId : null,
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

    /*
     * Deuda de la venta fiada.
     *
     * Va dentro de la misma transacción que la venta para que no pueda existir
     * una sin la otra, y el servicio valida ahí adentro que el cliente tenga
     * cuenta habilitada y crédito disponible: si no lo tiene, la venta entera
     * se cae antes de descontar stock.
     */
    if (esFiado) {
      await cargarVenta({
        saleId:     sale.id,
        clientId,
        businessId: req.auth.businessId,
        employeeId,
        monto:      total,
        numero,
      }, t);
    }

    // La segunda comprobación de stock, ya con la fila bloqueada, la hace el
    // helper: es la que garantiza que dos cajas vendiendo la última unidad a
    // la vez no la vendan las dos.
    if (sacaMercaderia) {
      await descontarStockVenta(sale, t, { employeeId, motivo: `Venta ${numero}` });
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

/*
 * POST /api/sales/:id/cobrar
 *
 * Cobra una venta que quedó abierta — fiada o simplemente pendiente. Es acá
 * donde aparecen los medios de pago y sus combinaciones: al registrarla no se
 * sabía con qué iba a pagar el cliente.
 *
 * Hace, en una sola transacción: guarda el detalle del cobro, saca la
 * mercadería si todavía no había salido, y cancela la deuda del cliente si la
 * venta era fiada.
 */
const cobrarSale = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    // Sin `include`: el lock de fila no se lleva bien con el LEFT JOIN de los
    // ítems. El helper de stock los busca por su cuenta dentro de la misma
    // transacción.
    const sale = await Sale.findOne({
      where: { id: req.params.id, businessId: req.auth.businessId },
      transaction: t, lock: t.LOCK.UPDATE,
    });
    if (!sale) throw Object.assign(new Error('Venta no encontrada.'), { status: 404 });
    if (sale.tipo === 'cotizacion') {
      throw Object.assign(new Error('Una cotización no se cobra: convertila en venta primero.'), { status: 400 });
    }
    if (sale.estado === 'pagado')    throw Object.assign(new Error('Esta venta ya está cobrada.'), { status: 409 });
    if (sale.estado === 'cancelado') throw Object.assign(new Error('Esta venta está cancelada.'), { status: 400 });

    // Lo que falta cobrar, que no siempre es el total: el cliente pudo haber
    // pagado una parte a cuenta desde su ficha.
    const aCobrar = redondear(Number(sale.saldoPendiente) || Number(sale.total));
    if (aCobrar <= 0) throw Object.assign(new Error('Esta venta no tiene saldo pendiente.'), { status: 409 });

    // Mismo criterio que al vender: si cobra un empleado, la plata entra a su
    // caja, y sin turno abierto no hay caja contra la cual rendirla.
    if (req.auth.employeeId) {
      const { turnoAbierto } = require('../services/cashService');
      const turno = await turnoAbierto(req.auth.employeeId, req.auth.businessId, t);
      if (!turno) {
        throw Object.assign(new Error('Necesitás abrir tu turno de caja antes de cobrar.'), { status: 409 });
      }
    }

    const { lineas, recargoPagos, resumen } =
      await calcularPagos(req.body?.pagos, aCobrar, req.auth.businessId);

    if (lineas.length) {
      await SalePayment.bulkCreate(lineas.map((l) => ({ ...l, saleId: sale.id })), { transaction: t });
    }

    await sale.update({
      estado: 'pagado',
      saldoPendiente: 0,
      medioPago: resumen || req.body?.medioPago || sale.medioPago,
      recargoPagos,
      // El recargo del medio de pago se suma al neto de mercadería; `total`
      // sigue siendo lo vendido, que es de donde salen métricas y facturación.
      totalCobrado: redondear(Number(sale.total) + recargoPagos),
      cobradoEn: new Date(),
      // Quién lo cobró, que no siempre es quien vendió: lo fiado lo puede
      // cobrar otro empleado, y el efectivo va a la caja de ese otro.
      cobradoPorEmployeeId: req.auth.employeeId || null,
    }, { transaction: t });

    // Si la mercadería quedó en el local (una seña, por ejemplo), sale recién
    // ahora. Si ya se la había llevado, el helper no vuelve a descontarla.
    await descontarStockVenta(sale, t, {
      employeeId: req.auth.employeeId || null,
      motivo: `Cobro venta ${sale.numero}`,
    });

    // Venta fiada: cobrarla cancela la deuda que había nacido con ella.
    if (sale.condicionPago === 'cuenta_corriente' && sale.clientId) {
      await registrarMovimiento({
        businessId: req.auth.businessId,
        clientId:   sale.clientId,
        saleId:     sale.id,
        employeeId: req.auth.employeeId || null,
        tipo:       'pago',
        monto:      aCobrar,
        paymentMethodId: lineas.length === 1 ? lineas[0].paymentMethodId : null,
        medioPago:  resumen || null,
        notas:      `Cobro venta ${sale.numero}`,
      }, t);
    }

    await t.commit();

    const full = await Sale.findByPk(sale.id, {
      include: [
        { model: SaleItem, as: 'items' },
        { association: 'pagos' },
        { association: 'cliente' },
        { association: 'empleado', attributes: ['id', 'nombre', 'apellido'] },
      ],
    });
    notifySaleAsync(sale.id, req.auth.businessId);
    res.json(full);
  } catch (error) { await t.rollback(); next(error); }
};

/*
 * PATCH /api/sales/:id/estado
 *
 * Cambios de estado que no son el cobro. Marcar "pagado" desde acá quedaría
 * sin detalle de medios de pago y sin cancelar la deuda del cliente, así que
 * ese camino es sólo el de arriba.
 */
const updateSaleStatus = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const { estado } = req.body;
    if (estado === 'pagado') {
      throw Object.assign(
        new Error('Para cobrar una venta usá el cobro, que registra con qué se pagó.'),
        { status: 400 }
      );
    }

    const sale = await Sale.findOne({
      where: { id: req.params.id, businessId: req.auth.businessId },
      transaction: t, lock: t.LOCK.UPDATE,
    });
    if (!sale) throw Object.assign(new Error('Venta no encontrada.'), { status: 404 });

    /*
     * Cancelar una venta fiada tiene que borrar la deuda que dejó: si no, el
     * cliente sigue debiendo por mercadería que nunca se llevó. Y si el stock
     * había salido, vuelve al inventario.
     */
    if (estado === 'cancelado' && sale.estado !== 'cancelado') {
      const pendiente = redondear(sale.saldoPendiente);
      if (sale.condicionPago === 'cuenta_corriente' && sale.clientId && pendiente > 0) {
        await registrarMovimiento({
          businessId: req.auth.businessId,
          clientId:   sale.clientId,
          saleId:     sale.id,
          employeeId: req.auth.employeeId || null,
          tipo:       'pago',
          monto:      pendiente,
          notas:      `Anulación venta ${sale.numero}`,
        }, t);
      }
      await devolverStockVenta(sale, t, { employeeId: req.auth.employeeId || null });
      await sale.update({ saldoPendiente: 0 }, { transaction: t });
    }

    await sale.update({ estado }, { transaction: t });
    await t.commit();

    const full = await Sale.findByPk(sale.id, {
      include: [{ model: SaleItem, as: 'items' }, { association: 'empleado', attributes: ['id', 'nombre', 'apellido'] }],
    });
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
    // Nace como venta abierta: se debe entera hasta que se cobre.
    await quote.update({ tipo: 'venta', estado: 'pendiente', numero, saldoPendiente: quote.total });
    res.json(quote);
  } catch (error) { next(error); }
};

// GET /api/sales/:id/ticket → devuelve PDF de ticket 80mm inline
const downloadTicket = async (req, res, next) => {
  try {
    const sale = await Sale.findOne({
      where: { id: req.params.id, businessId: req.auth.businessId },
      // `pagos` alimenta el desglose por medio de pago del ticket.
      include: [{ model: SaleItem, as: 'items' }, { association: 'cliente' }, { association: 'pagos' }],
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

module.exports = { getSales, getSale, createSale, cobrarSale, updateSaleStatus, convertQuoteToSale, downloadTicket };
