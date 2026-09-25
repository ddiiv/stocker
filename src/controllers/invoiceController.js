const path = require('path');
const fse = require('fs-extra');
const sequelize = require('../config/database');
const { Invoice, InvoiceItem, Sale, SaleItem, Business, Client, BusinessCuit, BusinessArcaConfig, SalePayment, ArcaIntento } = require('../models');
const { nextInvoiceNumber, crearConNumero } = require('../services/invoiceNumberService');
const { tipoComprobante, solicitarCAE, determineInvoiceType, calcularIVA } = require('../services/arcaService');
const { lookupCuit } = require('../services/arcaLookupService');
const { generateInvoicePdf, generateInvoicePdfBuffer, destinatariosDe } = require('../services/pdfService');

/*
 * Los destinatarios del cobro, en una línea para guardar en la factura.
 *
 * Sale del mismo `destinatariosDe` que arma el ticket y el PDF de la venta: si
 * cada uno agrupara por su cuenta, el día que se cambie el criterio —juntar dos
 * cobros al mismo CUIT, por ejemplo— la factura diría una cosa y el ticket
 * otra, y los dos serían el comprobante de la misma venta.
 */
function textoDeDestinatarios(pagos) {
  const destinos = destinatariosDe(pagos)
    .map((d) => `${d.nombre ? `${d.nombre} · ` : ''}CUIT ${d.cuit}`);
  return destinos.length ? destinos.join(' / ').slice(0, 300) : null;
}
const { sendInvoiceEmail, sendInvoiceCopyToBusiness } = require('../services/emailService');
const { sendInvoiceWhatsapp } = require('../services/whatsappService');
const { exigirCupo } = require('../services/planService');
const { log, sinDatos } = require('../utils/logger');

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
     * ── Las notas se restan, no se esconden ────────────────────
     *
     * Antes esto sumaba todo lo 'emitida' y descontaba lo 'anulada'. Con notas
     * de crédito en la misma tabla eso queda mal de las dos puntas: la nota
     * sumaría como si fuera una venta —inflando el facturado justo cuando se
     * devolvió plata— y la factura revertida desaparecería del total, cuando
     * en el libro sigue existiendo.
     *
     * Así que se separa por clase: facturado es lo emitido, acreditado es lo
     * que se devolvió, y el neto es la resta. Los tres se devuelven porque los
     * tres se miran: el contador quiere el facturado, el dueño el neto.
     */
    const emitidas = { ...where, estado: 'emitida' };
    const [totalFacturado, cantidadEmitidas, anuladas, totalAcreditado, totalDebitado] = await Promise.all([
      Invoice.sum('total', { where: { ...emitidas, clase: 'factura' } }),
      Invoice.count({ where: { ...emitidas, clase: 'factura' } }),
      Invoice.count({ where: { ...where, estado: 'anulada' } }),
      Invoice.sum('total', { where: { ...emitidas, clase: 'nota_credito' } }),
      Invoice.sum('total', { where: { ...emitidas, clase: 'nota_debito' } }),
    ]);
    const facturado = Number(totalFacturado) || 0;
    const acreditado = Number(totalAcreditado) || 0;
    const debitado = Number(totalDebitado) || 0;

    res.json({
      total: count,
      page: Number(page),
      totalPages: Math.ceil(count / limit),
      data: rows,
      resumen: {
        cantidad: count,
        emitidas: cantidadEmitidas,
        anuladas,
        facturado,
        acreditado,
        debitado,
        neto: Math.round((facturado - acreditado + debitado) * 100) / 100,
        /*
         * El nombre viejo sigue saliendo, ahora con el neto: las pantallas que
         * lo leen quieren "cuánto facturé de verdad", y desde que existen las
         * notas esa respuesta es el neto.
         */
        totalEmitido: Math.round((facturado - acreditado + debitado) * 100) / 100,
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

    /*
     * A qué CUIT del negocio entró el cobro de esta venta.
     *
     * Se arma acá y se guarda en la factura como texto: el comprobante es una
     * foto y no puede cambiar de destinatario si mañana se corrige una razón
     * social. Uno por destinatario distinto — dos medios que caen en la misma
     * cuenta se nombran una sola vez.
     */
    const pagosDeLaVenta = await SalePayment.findAll({
      where: { saleId: sale.id }, transaction: t,
    });
    const cobroDestino = textoDeDestinatarios(pagosDeLaVenta);
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

    /*
     * ── Los datos del cliente registrado mandan ──────────────────
     *
     * Si la venta tiene un cliente asociado, la factura sale con SUS datos: los
     * de la ficha, no los que vengan en el pedido. Los del cuerpo sólo sirven
     * para la venta de mostrador sin cliente cargado, que es el único caso en
     * que no hay de dónde sacarlos.
     *
     * Antes era `clienteCuit || cliente?.cuit`: el cuerpo pisaba a la ficha. Y
     * eso no es sólo un problema de prolijidad. Es un comprobante fiscal: con
     * un `clienteCuit` en el pedido se le podía emitir una factura a nombre de
     * cualquier CUIT mientras la venta figuraba a nombre de otro cliente, y el
     * comprobante ya emitido no se corrige, se anula con nota de crédito.
     *
     * Lo único que se sigue aceptando desde afuera para un cliente registrado
     * es el email de envío: mandar el comprobante a otra casilla —la del
     * contador, la del marido— no cambia a quién se le facturó.
     */
    const cliente        = sale.cliente;
    const tieneFicha     = Boolean(cliente);
    const finalCuit      = tieneFicha ? (cliente.cuit || null)      : (clienteCuit || null);
    const finalDireccion = tieneFicha ? (cliente.direccion || null) : (clienteDireccion || null);
    // El email sí puede cambiarse en el momento: es a dónde se manda, no a
    // quién se le factura. Si no viene, el de la ficha.
    const finalEmail     = clienteEmail || cliente?.email || null;
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
    const ambienteArca = arcaConfig?.ambiente === 'produccion' ? 'produccion' : 'homologacion';
    const {
      cae, caeVencimiento, respuesta: arcaRespuesta, intentoId,
      numero: cbteNroArca, puntoVenta: ptoVtaArca, cbteTipo: cbteTipoArca, cbteFch: cbteFchArca,
    } = await solicitarCAE({
      tipo, total: totalAFacturar, clienteCuit: finalCuit,
      clienteCondicion: condicionReceptor,
      businessCuit: emisorCuit,
      puntoVenta: arcaConfig?.puntoVenta || null,
      ambiente:   ambienteArca,
      items: sale.items,
      /*
       * De quién es el CAE que se está pidiendo. Con esto, si el CAE sale y la
       * factura no llega a guardarse —cualquier cosa que falle entre acá y el
       * commit deshace el INSERT, con el comprobante ya emitido en AFIP—, el
       * próximo intento de facturar esta venta encuentra ese CAE y lo reusa en
       * vez de pedir otro. Sin esto quedan dos comprobantes fiscales por una
       * venta, y eso no se corrige después.
       */
      businessId: req.auth.businessId,
      saleId: sale.id,
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
        /*
         * El neto gravado, no el bruto de la venta.
         *
         * Guardaba `sale.subtotal`, que es la suma de las líneas ANTES del
         * descuento, mientras que el IVA y el total salen de lo efectivamente
         * cobrado. En una venta con descuento el comprobante quedaba con tres
         * números que no cierran: el PDF imprime Subtotal + IVA + Total y la
         * cuenta no daba. En un documento fiscal eso no es un detalle.
         *
         * `calcularIVA` descompone el total cobrado, así que neto + iva es
         * exactamente el total, que es la forma en que AFIP espera el desglose.
         */
        subtotal:      neto,
        iva, total:    totalAFacturar,
        esMayorista:   sale.esMayorista,
        cae, caeVencimiento,
        /*
         * Las coordenadas del comprobante en AFIP, como columnas.
         *
         * Es lo que hace falta para imprimir el número que vale y, sobre todo,
         * para poder revertirlo con una nota de crédito: AFIP las pide en
         * CbtesAsoc. Antes vivían sólo adentro de `arcaRespuesta`, un texto
         * que puede no parsear.
         */
        ptoVtaArca, cbteNroArca, cbteTipoArca, cbteFchArca,
        arcaRespuesta,
        /*
         * Queda escrito en el comprobante si es fiscal o no.
         *
         * Un comprobante de homologación tiene CAE, número y PDF igual que uno
         * real, pero NO existe en ARCA: buscarlo por CAE no devuelve nada. Sin
         * este dato guardado, la única forma de saberlo era acordarse de en qué
         * ambiente estaba configurado el CUIT el día que se emitió.
         */
        ambiente: ambienteArca,
        simulado: Boolean(arcaRespuesta?.mock),
        businessCuitId: emisor?.id || null,
        cobroDestino,
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

    /*
     * El intento queda atado a la factura, DENTRO de esta transacción.
     *
     * Es lo que cierra el circuito: mientras el vínculo no exista, ese CAE
     * cuenta como emitido y sin registrar, y el próximo intento de facturar la
     * venta lo reusa. Si esta transacción se deshace, el vínculo se deshace
     * con ella y el CAE vuelve a quedar disponible para rescatar — que es
     * exactamente lo que se quiere.
     */
    if (intentoId) {
      await ArcaIntento.update({ invoiceId: invoice.id }, { where: { id: intentoId }, transaction: t });
    }

    await t.commit();

    // Generar PDF (fuera de la transacción)
    const items = await InvoiceItem.findAll({ where: { invoiceId: invoice.id } });
    const pdfPath = await generateInvoicePdf(invoice.toJSON(), items, business.toJSON()).catch((err) => {
      log.error('factura', 'no se pudo generar el PDF', { motivo: sinDatos(err.message, 160) });
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

    /*
     * ── Los dos mails: el del cliente y la copia del negocio ─────
     *
     * El comprobante es de los dos. El cliente lo necesita para su compra; el
     * negocio, para el libro de IVA ventas y para lo que el contador pide a fin
     * de mes. Hasta ahora salía sólo el del cliente y del lado del negocio
     * quedaba la fila en la pantalla, que sirve para mirar y no para archivar.
     *
     * Los dos adjuntan el MISMO archivo, así que el borrado espera a que los
     * dos terminen. Borrarlo apenas sale el primero dejaba al segundo
     * adjuntando un archivo que ya no estaba, y ese mail llegaba sin la
     * factura.
     *
     * Ninguno frena nada: la factura ya tiene CAE de ARCA cuando esto corre. Un
     * problema de correo no deshace un comprobante fiscal, así que se registra
     * y se sigue.
     */
    const envios = [];

    /*
     * ── Al cliente NO se le manda un comprobante que no es fiscal ────
     *
     * Un comprobante de homologación —o uno simulado con ARCA_MOCK— tiene CAE,
     * número y PDF iguales a uno real, pero no existe en ARCA. Mandárselo al
     * comprador es entregarle un papel que parece una factura, que él va a
     * archivar como respaldo, y que no le sirve para nada: no lo puede
     * presentar, no lo puede computar, y cuando lo busque por CAE no va a
     * estar. El daño no es nuestro, es de él.
     *
     * La copia al negocio sí sale, marcada: quien está probando la integración
     * necesita ver que el circuito anduvo de punta a punta.
     */
    const esFiscal = ambienteArca === 'produccion' && !arcaRespuesta?.mock;
    const motivoNoFiscal = arcaRespuesta?.mock
      ? 'el CAE es simulado (ARCA_MOCK está activo)'
      : 'la facturación está en modo homologación (prueba)';

    if (finalEmail && enviarEmail && !esFiscal) {
      await invoice.update({
        emailEstado: 'no_enviado',
        emailError: `No se le mandó al cliente porque ${motivoNoFiscal}: `
          + 'este comprobante no tiene validez fiscal.',
      }).catch(() => {});
      log.warn('factura', 'no se envía al cliente: el comprobante no es fiscal', {
        invoiceId: invoice.id, ambiente: ambienteArca, simulado: Boolean(arcaRespuesta?.mock),
      });
    } else if (finalEmail && enviarEmail) {
      envios.push(
        sendInvoiceEmail({
          to: finalEmail, clienteNombre, invoice: invoice.toJSON(),
          pdfPath: absPdf, business: business.toJSON(),
        })
          .then(() => invoice.update({ emailEstado: 'enviado', emailError: null }))
          /*
           * El motivo queda EN EL COMPROBANTE, no sólo en el log.
           *
           * Antes un fallo de correo se registraba en el servidor y la pantalla
           * decía "factura emitida" a secas: nadie se enteraba de que el
           * cliente nunca la recibió, hasta que el cliente reclamaba.
           */
          .catch((err) => {
            log.error('factura', 'no se pudo enviar al cliente', {
              motivo: sinDatos(err.message, 160),
            });
            return invoice.update({
              emailEstado: 'falló',
              emailError: sinDatos(err.message, 280),
            }).catch(() => {});
          }),
      );
    }
    if (business.email) {
      envios.push(
        sendInvoiceCopyToBusiness({
          to: business.email, invoice: invoice.toJSON(), pdfPath: absPdf,
          business: business.toJSON(), clienteNombre,
        }).catch((err) => log.error('factura', 'no se pudo enviar la copia al negocio', {
          motivo: sinDatos(err.message, 160),
        })),
      );
    }

    if (envios.length) {
      // Sin await sobre la respuesta: quien factura no tiene por qué esperar a
      // que salga el correo. El archivo se borra cuando los dos terminaron.
      Promise.all(envios).finally(() => { if (absPdf) fse.remove(absPdf).catch(() => {}); });
    } else if (absPdf) {
      // Sin mail que lo adjunte, el archivo no tiene ningún uso.
      await fse.remove(absPdf).catch(() => {});
    }

    if (clienteWhatsapp && enviarWhatsapp) {
      sendInvoiceWhatsapp({ telefono: clienteWhatsapp, clienteNombre, invoice: invoice.toJSON(), business: business.toJSON() })
        .catch((err) => log.error('factura', 'no se pudo enviar por WhatsApp', { motivo: sinDatos(err.message, 160) }));
    }

    const full = await Invoice.findByPk(invoice.id, { include: [{ model: InvoiceItem, as: 'items' }] });
    res.status(201).json(full);
  } catch (error) { await t.rollback().catch(() => {}); next(error); }
};

/*
 * POST /api/invoices/:id/nota-credito
 *
 * La única forma de revertir una factura con CAE. El comprobante original
 * sigue existiendo en AFIP y sigue siendo válido: lo que esto emite es otro
 * comprobante que lo compensa.
 *
 * No pasa por el cupo del plan: el cupo mide capacidad de facturar, y una nota
 * no es facturar — es la única forma de corregir. Cobrarle cupo convertiría un
 * límite comercial en un candado fiscal.
 */
const emitirNotaDeCredito = async (req, res, next) => {
  try {
    const { emitirNota } = require('../services/notaCreditoService');
    const nota = await emitirNota({
      businessId: req.auth.businessId,
      facturaId: Number(req.params.id),
      clase: req.body?.clase === 'nota_debito' ? 'nota_debito' : 'nota_credito',
      total: req.body?.total ?? null,
      motivo: req.body?.motivo,
      employeeId: req.auth.employeeId || null,
    });
    res.status(201).json(nota);
  } catch (e) { next(e); }
};

/* GET /api/invoices/:id/saldo-notas — cuánto queda por acreditar. */
const saldoDeNotas = async (req, res, next) => {
  try {
    const { saldoParaNotas } = require('../services/notaCreditoService');
    const factura = await Invoice.findOne({
      where: { id: req.params.id, businessId: req.auth.businessId },
      attributes: ['id'],
    });
    if (!factura) return res.status(404).json({ message: 'Comprobante no encontrado.' });
    res.json(await saldoParaNotas(factura.id));
  } catch (e) { next(e); }
};

// PATCH /api/invoices/:id/anular
const voidInvoice = async (req, res, next) => {
  try {
    const invoice = await Invoice.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!invoice) return res.status(404).json({ message: 'Factura no encontrada.' });

    /*
     * Un comprobante fiscal no se anula marcándolo en la base.
     *
     * Existe en AFIP y va a seguir existiendo: ponerle 'anulada' acá deja los
     * libros diciendo una cosa y AFIP otra, en silencio. La única salida real
     * es la nota de crédito.
     *
     * Lo que sí se puede marcar es lo que NO es fiscal: homologación y los
     * simulados de ARCA_MOCK, que son las pruebas. Sin eso no habría forma de
     * limpiar la pantalla después de probar.
     */
    const esFiscal = invoice.cae && invoice.ambiente === 'produccion' && !invoice.simulado;
    if (esFiscal && invoice.clase === 'factura') {
      throw Object.assign(
        new Error(
          `La factura ${invoice.numero} está autorizada en ARCA (CAE ${invoice.cae}). `
          + 'Para revertirla hace falta una nota de crédito: marcarla como anulada acá dejaría los libros en desacuerdo con AFIP.',
        ),
        { status: 409, detalles: { codigo: 'COMPROBANTE_FISCAL', accion: 'nota_credito' } },
      );
    }
    if (esFiscal) {
      throw Object.assign(
        new Error('Una nota autorizada en ARCA no se anula. Si está mal emitida, se compensa con una nota del tipo contrario.'),
        { status: 409, detalles: { codigo: 'COMPROBANTE_FISCAL' } },
      );
    }

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

module.exports = {
  getInvoices, getInvoice, createInvoice, voidInvoice, downloadPdf,
  emitirNotaDeCredito, saldoDeNotas,
};
