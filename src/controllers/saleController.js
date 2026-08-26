const path = require('path');
const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { Sale, SaleItem, SalePayment, PaymentMethod, ProductVariant, Product, Employee, BusinessLocation, Business, BusinessCuit } = require('../models');
const { citar } = require('../utils/sqlHelpers');
const { nextSaleNumber, crearConNumero } = require('../services/invoiceNumberService');
const { calcularPagos } = require('../services/paymentService');
const { cargarVenta, registrarMovimiento, redondear } = require('../services/creditService');
const { descontarStockVenta, devolverStockVenta } = require('../services/saleStockService');
const stockService = require('../services/stockService');
const { precioDeVenta } = require('../services/precioService');
const precioService = require('../services/precioService');
const { generateSalePdf, generateSaleTicketPdf } = require('../services/pdfService');
const fse = require('fs-extra');
const { sendSaleReceiptToCustomer, sendSaleNotificationToBusiness } = require('../services/emailService');
const { sendSaleWhatsapp, sendSaleNotificationWhatsapp } = require('../services/whatsappService');

// Genera PDF de la venta y dispara mails (cliente + negocio) sin bloquear la request.
async function notifySaleAsync(saleId, businessId) {
  try {
    const sale = await Sale.findByPk(saleId, {
      include: [
        { model: SaleItem, as: 'items' },
        { association: 'cliente' },
        { association: 'empleado', attributes: ['id', 'nombre', 'apellido'] },
        // El aviso al negocio nombra el local, así que hace falta acá.
        { association: 'local', attributes: ['id', 'nombre'] },
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

    /*
     * El PDF se borra cuando terminaron de salir los mails.
     *
     * Existe sólo para adjuntarse: los endpoints que entregan comprobantes lo
     * regeneran desde la base, así que el archivo no se vuelve a leer nunca.
     * Dejándolo, el contenedor junta un PDF por venta hasta el próximo deploy
     * —en Railway el disco es efímero y se borra ahí, pero mientras tanto ocupa
     * y no sirve para nada.
     *
     * Se cuentan los envíos y se borra al terminar el último: borrarlo antes
     * dejaría a nodemailer sin el adjunto a mitad de camino.
     */
    let pendientes = 0;
    const limpiar = async () => {
      if (--pendientes > 0 || !absPdf) return;
      await fse.remove(absPdf).catch(() => {});
    };

    // Mail al cliente si tiene email
    if (sale.cliente?.email) {
      pendientes++;
      sendSaleReceiptToCustomer({
        to: sale.cliente.email,
        cliente: sale.cliente.toJSON(),
        sale: sale.toJSON(),
        items: sale.items.map((i) => i.toJSON()),
        business: business.toJSON(),
        emisor: emisor?.toJSON() || null,
        pdfPath: absPdf,
      })
        .catch((err) => console.error('[email cliente]', err.message))
        .finally(limpiar);
    }
    // Aviso interno al negocio (siempre)
    if (business.email) {
      pendientes++;
      sendSaleNotificationToBusiness({
        to: business.email,
        cliente: sale.cliente?.toJSON() || null,
        sale: sale.toJSON(),
        items: sale.items.map((i) => i.toJSON()),
        business: business.toJSON(),
        emisor: emisor?.toJSON() || null,
        empleado: sale.empleado?.toJSON() || null,
        pdfPath: absPdf,
      })
        .catch((err) => console.error('[email negocio]', err.message))
        .finally(limpiar);
    }

    // Nadie va a adjuntarlo: se borra ya.
    if (absPdf && pendientes === 0) await fse.remove(absPdf).catch(() => {});
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

    /*
     * WhatsApp al negocio, con el detalle de lo vendido.
     *
     * Va aparte del aviso al cliente porque dicen cosas distintas: el cliente
     * recibe su comprobante, el dueño quiere ver qué salió del local sin abrir
     * el sistema. Igual que los mails, no bloquea la respuesta de la venta.
     */
    sendSaleNotificationWhatsapp({
      business: business.toJSON(),
      sale:     sale.toJSON(),
      items:    sale.items.map((i) => i.toJSON()),
      cliente:  sale.cliente?.toJSON()  || null,
      empleado: sale.empleado?.toJSON() || null,
      local:    sale.local?.toJSON()    || null,
      emisor:   emisor?.toJSON()        || null,
    }).catch((err) => console.error('[whatsapp negocio]', err.message));
  } catch (err) {
    console.error('[notifySaleAsync]', err.message);
  }
}

/*
 * Precio según mayorista (>= 3 prendas totales en la venta).
 *
 * La variante puede tener precio propio —un talle grande que sale más caro— y
 * en ese caso manda sobre el del producto. Lo resuelve precioService, que es el
 * único lugar donde vive esa regla.
 */
function calcPrecio(variant, esMayorista) {
  return precioDeVenta(variant, esMayorista);
}

/*
 * Filtro por medio de pago.
 *
 * Devuelve la condición SQL, o null si no hay filtro. Tres formas:
 *
 *   <id>        → cobrada SÓLO con ese medio. Una venta mitad efectivo mitad
 *                 transferencia no aparece en "efectivo": no fue una venta en
 *                 efectivo, fue una venta combinada.
 *   combinado   → dos o más medios, cualquiera sea la combinación. Una opción y
 *                 no una por cada par posible, que serían decenas.
 *   fiado       → sin medio todavía: se cobra después.
 *
 * Se escribe a mano con subconsultas en vez de un include con GROUP BY porque
 * agrupar rompe la paginación: el count de findAndCountAll pasa a contar filas
 * de pagos en lugar de ventas.
 */
async function condicionMedioPago(valor, businessId) {
  if (!valor) return null;

  const sp        = citar('sale_payments');
  const saleId    = citar('saleId');
  const metodoId  = citar('paymentMethodId');
  // El alias que Sequelize le da a la tabla principal en el SELECT.
  const venta     = `${citar('Sale')}.${citar('id')}`;
  const cuantos   = `(SELECT COUNT(*) FROM ${sp} WHERE ${sp}.${saleId} = ${venta})`;

  if (valor === 'combinado') {
    return sequelize.literal(`${cuantos} >= 2`);
  }

  if (valor === 'fiado') {
    // No es un medio de pago sino una condición de la venta, pero en la
    // pantalla convive con los medios: es una respuesta más a "cómo se pagó".
    return { condicionPago: 'cuenta_corriente' };
  }

  const id = Number(valor);
  if (!Number.isInteger(id)) return null;

  /*
   * Las ventas anteriores al detalle de pagos no tienen filas en sale_payments:
   * sólo el texto en `medioPago`. Se las incluye comparando por nombre, si no el
   * filtro daría por inexistente todo el historial previo.
   */
  const metodo = await PaymentMethod.findOne({ where: { id, businessId }, attributes: ['nombre'] });
  const porNombre = metodo?.nombre
    ? ` OR (${cuantos} = 0 AND ${citar('Sale')}.${citar('medioPago')} = ${sequelize.escape(metodo.nombre)})`
    : '';

  return sequelize.literal(
    `((${cuantos} = 1 AND EXISTS (SELECT 1 FROM ${sp} ` +
    `WHERE ${sp}.${saleId} = ${venta} AND ${sp}.${metodoId} = ${id}))${porNombre})`
  );
}

// GET /api/sales
const getSales = async (req, res, next) => {
  try {
    const { tipo, estado, condicionPago, medioPago, desde, hasta, clientId, page = 1, limit = 30 } = req.query;
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

    const porMedio = await condicionMedioPago(medioPago, req.auth.businessId);
    if (porMedio) {
      // Un literal no es una clave: va en Op.and para que conviva con el resto.
      if (porMedio.condicionPago) Object.assign(where, porMedio);
      else where[Op.and] = [...(where[Op.and] || []), porMedio];
    }

    const offset = (Math.max(1, Number(page)) - 1) * Math.min(Number(limit), 100);
    const { count, rows } = await Sale.findAndCountAll({
      where, offset, limit: Math.min(Number(limit), 100),
      include: [
        { model: SaleItem, as: 'items' },
        { association: 'pagos' },
        { association: 'cliente', attributes: ['id', 'nombre', 'apellido', 'cuit'] },
        { association: 'empleado', attributes: ['id', 'nombre', 'apellido'] },
        { association: 'local',   attributes: ['id', 'nombre'] },
      ],
      order: [['createdAt', 'DESC']],
      distinct: true,
    });

    /*
     * Totales de TODO el filtro, no de la página que se está viendo.
     *
     * Es el motivo de filtrar: "cuánto entró este mes en efectivo" no se
     * responde sumando las treinta filas visibles. Se calcula aparte con el
     * mismo where.
     */
    const soloCobradas = { ...where, estado: 'pagado' };
    const [totalCobrado, totalNeto, cantidadCobradas, pendienteDeCobro, cantidadPorCobrar] = await Promise.all([
      Sale.sum('totalCobrado', { where: soloCobradas }),
      Sale.sum('total',        { where: soloCobradas }),
      Sale.count({ where: soloCobradas }),
      /*
       * Lo que falta cobrar del filtro.
       *
       * Sin este número, filtrar por fiado mostraba "cobrado $0" — cierto y
       * completamente inútil: lo que se quiere saber al mirar las fiadas es
       * cuánto se debe, no cuánto ya entró. El $0 se leía como "acá no hay
       * nada" aunque la tabla debajo tuviera ventas.
       *
       * Va sin filtrar por estado: una venta al contado que quedó pendiente
       * también es plata por cobrar.
       */
      Sale.sum('saldoPendiente', { where: { ...where, saldoPendiente: { [Op.gt]: 0 } } }),
      Sale.count({ where: { ...where, saldoPendiente: { [Op.gt]: 0 } } }),
    ]);

    res.json({
      total: count,
      page: Number(page),
      totalPages: Math.ceil(count / limit),
      data: rows,
      resumen: {
        cantidad: count,
        cobradas: cantidadCobradas,
        // Lo que entró de verdad, con recargos. `neto` es la mercadería.
        totalCobrado: Number(totalCobrado) || 0,
        totalNeto: Number(totalNeto) || 0,
        // Lo que falta entrar, y en cuántas ventas.
        pendienteDeCobro: Number(pendienteDeCobro) || 0,
        porCobrar: cantidadPorCobrar,
      },
    });
  } catch (error) { next(error); }
};

/*
 * La venta que pide la URL, ubicada por su número.
 *
 * El id de la base dejó de viajar en la ruta. Un id autoincremental es
 * información del sistema, no del negocio: numera TODAS las ventas de TODOS
 * los negocios de la plataforma, así que dos ventas consecutivas dicen cuánto
 * se vendió en el medio, y probar /sales/1, /sales/2… recorre la tabla.
 *
 * El número de comprobante ya es único por negocio —lo garantiza
 * uq_sales_biz_numero— y es el que el cliente tiene impreso en el ticket, así
 * que además es el que alguien va a querer escribir en la barra de direcciones.
 *
 * Se normaliza a mayúsculas porque Postgres compara texto con
 * distinción de mayúsculas y el número se emite siempre en mayúscula.
 */
const dondeVenta = (req, extra = {}) => ({
  numero: String(req.params.numero || '').trim().toUpperCase(),
  businessId: req.auth.businessId,
  ...extra,
});

// GET /api/sales/:numero
const getSale = async (req, res, next) => {
  try {
    const sale = await Sale.findOne({
      where: dondeVenta(req),
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
    /*
     * De qué local sale la mercadería.
     *
     * Desde que cada local tiene su propio stock, esto dejó de ser un dato
     * informativo: es de dónde se descuenta. Un `null` acá significa que el
     * stock sale del local principal sin que nadie lo haya decidido, y eso
     * descuadra el inventario de dos locales a la vez — el que pierde stock que
     * no vendió y el que vendió y no lo pierde.
     *
     * Por eso ninguna de las dos ramas puede terminar en null.
     */
    let locationId = locationIdPedido || null;
    if (req.auth.employeeId) {
      const empleado = await Employee.findOne({
        where: { id: req.auth.employeeId, businessId: req.auth.businessId },
        transaction: t,
      });
      locationId = empleado?.locationId || null;

      // Un empleado sin local asignado no puede vender: no hay de dónde sacar
      // la mercadería. Es un error de configuración y hay que decirlo, no
      // taparlo descontando del principal.
      /*
       * Un empleado asignado a un depósito no vende.
       *
       * Es el caso del chico que cuenta bultos: tiene local asignado, así que
       * la comprobación de abajo lo dejaba pasar, y la venta le descontaba
       * mercadería a la bodega. Se corta acá con el motivo dicho.
       */
      if (locationId && tipo !== 'cotizacion') {
        const suyo = await BusinessLocation.findByPk(locationId, { transaction: t });
        if (suyo?.tipo === 'deposito') {
          throw Object.assign(
            new Error(`Estás asignado a "${suyo.nombre}", que es un depósito, y desde un depósito no se vende.`),
            { status: 409 },
          );
        }
      }

      if (!locationId && tipo !== 'cotizacion') {
        throw Object.assign(
          new Error('Tu usuario no tiene un local asignado, así que no se puede saber de dónde sale la mercadería. Pedile al dueño que te asigne uno desde Empleados.'),
          { status: 409 }
        );
      }

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
    } else {
      // Dueño: elige, pero sólo entre los locales de su negocio.
      if (locationId) {
        const local = await BusinessLocation.findOne({
          where: { id: locationId, businessId: req.auth.businessId, activo: true },
          transaction: t,
        });
        if (!local) throw Object.assign(new Error('El local indicado no pertenece a este negocio o está inactivo.'), { status: 400 });
        if (local.tipo === 'deposito' && tipo !== 'cotizacion') {
          throw Object.assign(
            new Error(`"${local.nombre}" es un depósito y de un depósito no se vende. La mercadería sale por transferencia a un local.`),
            { status: 400 },
          );
        }
      } else if (tipo !== 'cotizacion') {
        /*
         * Sin elegir: con un solo local no hay ambigüedad y se usa ése. Con
         * varios hay que decidir, porque el sistema no puede adivinar de cuál
         * salió la prenda y elegir mal descuadra dos inventarios.
         */
        /*
         * Sólo locales de venta: de un depósito no se vende.
         *
         * Incluirlos acá hacía que un negocio con un local y un depósito
         * cayera en la rama de "elegí cuál" para una decisión que en realidad
         * no existe, y peor, con un solo depósito y ningún local habría
         * elegido la bodega en silencio.
         */
        const activos = await BusinessLocation.findAll({
          where: { businessId: req.auth.businessId, activo: true, tipo: { [Op.ne]: 'deposito' } },
          order: [['id', 'ASC']], transaction: t,
        });
        if (activos.length === 1) locationId = activos[0].id;
        else if (activos.length === 0) {
          throw Object.assign(
            new Error('No hay ningún local de venta cargado. Un depósito no vende: creá al menos un local.'),
            { status: 409 }
          );
        } else {
          throw Object.assign(
            new Error('Elegí de qué local sale la mercadería: el stock se descuenta de ese local.'),
            { status: 400 }
          );
        }
      }
    }

    /*
     * El nombre del local, para los mensajes de faltante.
     *
     * Decir "no queda stock" sin decir dónde manda a buscar en el depósito
     * equivocado cuando la mercadería está en la otra sucursal.
     */
    let nombreLocalVenta = 'este local';
    if (locationId) {
      const l = await BusinessLocation.findByPk(locationId, { attributes: ['nombre'], transaction: t });
      if (l) nombreLocalVenta = l.nombre;
    }

    /*
     * Las cantidades y el precio se validan ANTES de calcular nada.
     *
     * Sin esto entraba cualquier cosa y la venta se guardaba igual:
     *
     *   cantidad -5      → total -$59.500, y al descontar stock lo SUMABA.
     *   cantidad 2,7     → la columna es entera y guardaba 2, pero el subtotal
     *                      se calculaba con 2,7: se cobraba una unidad que no
     *                      salía del inventario.
     *   precio negativo  → total negativo.
     *
     * Un total negativo no es un caso raro de laboratorio: entra en las
     * métricas, en el arqueo de caja y en la cuenta corriente del cliente, y
     * ahí ya no hay forma de distinguirlo de una devolución real.
     */
    for (const item of items) {
      const cant = Number(item.cantidad);
      if (!Number.isInteger(cant) || cant <= 0) {
        throw Object.assign(
          new Error(`La cantidad de cada artículo tiene que ser un número entero mayor a cero (llegó ${item.cantidad}).`),
          { status: 400 },
        );
      }
      if (item.precioUnitario !== undefined && item.precioUnitario !== null) {
        const precio = Number(item.precioUnitario);
        if (!Number.isFinite(precio) || precio < 0) {
          throw Object.assign(new Error('El precio de un artículo no puede ser negativo.'), { status: 400 });
        }
      }
    }

    /*
     * El descuento va entre 0 y 100.
     *
     * Con 150 el total quedaba negativo; con -50 el descuento sumaba en vez de
     * restar y la venta salía más cara que la suma de sus artículos.
     */
    const pct = Number(descuentoPct) || 0;
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw Object.assign(new Error('El descuento tiene que estar entre 0 y 100.'), { status: 400 });
    }

    // Determinar si es mayorista: total de unidades >= 3
    const totalUnidades = items.reduce((s, i) => s + Number(i.cantidad), 0);
    const esMayorista   = totalUnidades >= 3;

    /*
     * Política del negocio ante la falta de stock.
     *
     * Se lee una vez por venta y no por línea: son decenas de líneas y el dato
     * es el mismo para todas.
     */
    const negocio = await Business.findByPk(req.auth.businessId, {
      attributes: ['id', 'ventaSinStock'], transaction: t,
    });
    const politicaSinStock = negocio?.ventaSinStock === 'bloquear' ? 'bloquear' : 'permitir';

    // Lo que se vendió sin tener: se devuelve con la venta para poder avisarlo.
    const faltantes = [];

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
        /*
         * Se comprueba contra el stock DEL LOCAL de la venta.
         *
         * Miraba el total de la variante, que desde que el stock es por local
         * ya no es lo disponible acá: con 0 en esta sucursal y 20 en la otra,
         * la venta pasaba esta comprobación y recién la frenaba el segundo
         * control, con un mensaje sobre otra cosa. Peor todavía, el mensaje
         * decía "no queda stock" cuando sí había, en otro lado.
         */
        const disponible = await stockService.stockEn(variant.id, locationId, t);
        if (disponible < item.cantidad) {
          const nombre = [variant.producto.titulo, variant.variante1Valor, variant.variante2Valor]
            .filter(Boolean).join(' · ');
          const total = Number(variant.stock) || 0;
          const enOtros = total - disponible;

          /*
           * La venta pasa igual, salvo que el negocio pida lo contrario.
           *
           * En el mostrador la prenda está en la mano del cliente y el sistema
           * va atrás: frenar por un dato que todavía no se cargó pierde la
           * venta o empuja al cajero a inventar una vuelta. Lo que sí no puede
           * pasar es que el faltante se pierda, así que la línea queda marcada
           * y el stock queda en negativo A LA VISTA, como pendiente de
           * regularizar.
           */
          if (politicaSinStock === 'bloquear') {
            throw Object.assign(
              new Error(
                (disponible === 0
                  ? `No queda stock de ${nombre} (${variant.sku}) en ${nombreLocalVenta}.`
                  : `Sólo quedan ${disponible} de ${nombre} (${variant.sku}) en ${nombreLocalVenta} y estás vendiendo ${item.cantidad}.`)
                + (enOtros > 0 ? ` Hay ${enOtros} en total entre todos los locales: transferilo desde Stock.` : '')
              ),
              // La pantalla lo usa para ofrecer registrarla como cotización en
              // vez de dejar al cajero sin salida con el cliente enfrente.
              { status: 409, detalles: { codigo: 'SIN_STOCK' } }
            );
          }

          faltantes.push({
            sku: variant.sku, nombre,
            vendido: item.cantidad,
            habia: disponible,
            falta: item.cantidad - disponible,
            enOtrosLocales: enOtros > 0 ? enOtros : 0,
          });
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
        /*
         * El costo del día, congelado en la línea.
         *
         * Es lo que después permite decir qué margen dejó ESTA venta. Leerlo
         * del producto al analizar hace que una suba del proveedor cambie los
         * márgenes de todos los meses anteriores.
         */
        costoUnitario:    precioService.costo(variant, variant.producto),
        subtotal,
        esMayorista,
      });
    }

    const subtotal  = enrichedItems.reduce((s, i) => s + i.subtotal, 0);
    const descuento = Math.round(subtotal * pct / 100 * 100) / 100;
    const total     = subtotal - descuento;


    // Los recargos y descuentos por medio de pago se calculan sobre el total
    // de mercadería. `total` no se toca: sobre él se apoyan la facturación y
    // las métricas, y el costo financiero del medio de pago no es venta.
    //
    // En una venta fiada no hay medios que calcular: se ignora lo que llegue
    // en `pagos` para que el frontend no pueda dejar un cobro anotado sobre
    // plata que todavía no entró.
    // Una cotización tampoco cobra: es un presupuesto. Si llegaran `pagos`
    // se guardarían líneas de cobro sobre plata que nadie entregó.
    const { lineas, recargoPagos, totalCobrado, resumen } =
      await calcularPagos(esFiado || tipo === 'cotizacion' ? null : pagos, total, req.auth.businessId);

    /*
     * El número se toma reintentando: dos cajas cobrando a la vez leían el
     * mismo último número y la segunda moría contra el índice único con un
     * error de base en crudo.
     */
    const sale = await crearConNumero(
      (saltar) => nextSaleNumber(req.auth.businessId, tipo, saltar),
      (numero, sp) => Sale.create({
      businessId:  req.auth.businessId,
      locationId:  locationId || null,
      employeeId,
      clientId:    clientId || null,
      numero, tipo,
      estado:      finalEstado,
      condicionPago,
      esMayorista,
      subtotal, descuentoPct: pct, descuento, total,
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
      }, { transaction: sp || t }),
      { transaction: t },
    );
    const numero = sale.numero;

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

    /*
     * El aviso de lo que se vendió sin tener.
     *
     * Va en la respuesta de la venta y no en un endpoint aparte: el momento en
     * que sirve es justo después de cobrar, con la persona todavía en la
     * pantalla. Un aviso que hay que ir a buscar no lo ve nadie.
     */
    res.status(201).json({
      ...full.toJSON(),
      ...(faltantes.length ? {
        avisoStock: {
          codigo: 'VENDIDO_SIN_STOCK',
          mensaje: faltantes.length === 1
            ? `Vendiste ${faltantes[0].vendido} de ${faltantes[0].nombre} y el sistema tenía ${faltantes[0].habia}. Quedó en negativo hasta que cargues la mercadería.`
            : `${faltantes.length} artículos se vendieron sin stock cargado. Quedaron en negativo hasta que los regularices.`,
          faltantes,
        },
      } : {}),
    });
  } catch (error) {
    /*
     * El rollback no puede tumbar el servidor.
     *
     * Si la transacción ya murió —un error de SQL la aborta sola—, este
     * rollback falla, y como Express no espera al handler la promesa queda sin
     * manejar y el proceso se cae entero. Un pedido que falla tiene que
     * devolver 500, no dejar sin servicio a todos los negocios.
     */
    await t.rollback().catch(() => {});
    next(error);
  }
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
      where: dondeVenta(req),
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
  } catch (error) {
    /*
     * El rollback no puede tumbar el servidor.
     *
     * Si la transacción ya murió —un error de SQL la aborta sola—, este
     * rollback falla, y como Express no espera al handler la promesa queda sin
     * manejar y el proceso se cae entero. Un pedido que falla tiene que
     * devolver 500, no dejar sin servicio a todos los negocios.
     */
    await t.rollback().catch(() => {});
    next(error);
  }
};

/*
 * PATCH /api/sales/:id/estado
 *
 * Cambios de estado que no son el cobro. Marcar "pagado" desde acá quedaría
 * sin detalle de medios de pago y sin cancelar la deuda del cliente, así que
 * ese camino es sólo el de arriba.
 */
/*
 * POST /api/sales/:numero/anular
 *
 * Anula una venta y deshace todo lo que dejó: la mercadería vuelve al local
 * del que salió, la plata deja de figurar como cobrada y la deuda del cliente
 * se cancela.
 *
 * Antes esto se hacía con un PATCH de estado. Devolvía el stock, pero dejaba
 * `totalCobrado` con el importe: la venta figuraba anulada y cobrada a la vez,
 * y ese número lo leen las métricas.
 *
 * Dos cosas que NO hace, a propósito:
 *
 *   - No anula una venta facturada con CAE. Ese comprobante ya está en AFIP y
 *     borrarlo de este lado no lo borra de allá: lo que corresponde es una nota
 *     de crédito. Anular en silencio deja al negocio declarando una venta que
 *     su propio sistema dice que no existió.
 *   - No saca la plata de la caja por su cuenta. El arqueo cuenta las ventas
 *     en estado 'pagado', así que al anularla sale sola del turno; si el
 *     efectivo ya se entregó al cliente, eso es un egreso de caja que registra
 *     quien lo entrega.
 */
const anularSale = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const motivo = String(req.body?.motivo || '').trim();
    if (!motivo) {
      throw Object.assign(
        new Error('Poné el motivo de la anulación: es lo que explica la devolución de stock en el historial.'),
        { status: 400 },
      );
    }

    /*
     * Sin `include`: Postgres rechaza `FOR UPDATE` sobre el lado nulo de un
     * LEFT JOIN ("FOR UPDATE cannot be applied to the nullable side of an
     * outer join"), y traer los ítems asociados arma exactamente ese join. En
     * SQL Server pasa sin chistar, así que el error sólo aparece en
     * producción. Los ítems se cargan aparte, dentro de la misma transacción.
     */
    const sale = await Sale.findOne({
      where: dondeVenta(req),
      transaction: t, lock: t.LOCK.UPDATE,
    });
    if (!sale) throw Object.assign(new Error('Venta no encontrada.'), { status: 404 });
    if (sale.estado === 'cancelado') {
      throw Object.assign(new Error('Esta venta ya está anulada.'), { status: 409 });
    }

    /*
     * Facturada con CAE: no se toca.
     *
     * El comprobante está autorizado por AFIP y sigue existiendo aunque acá se
     * marque otra cosa. La salida es la nota de crédito.
     */
    const { Invoice } = require('../models');
    const factura = await Invoice.findOne({
      where: { saleId: sale.id, businessId: req.auth.businessId },
      transaction: t,
    });
    if (factura && factura.cae) {
      throw Object.assign(
        new Error(
          `La venta ${sale.numero} está facturada (${factura.numero}, CAE ${factura.cae}). `
          + 'Ese comprobante ya está autorizado en ARCA: para revertirlo hace falta una nota de crédito, '
          + 'no alcanza con anular la venta acá.',
        ),
        { status: 409, detalles: { codigo: 'VENTA_FACTURADA', factura: factura.numero, cae: factura.cae } },
      );
    }

    // La deuda de una venta fiada se cancela: el cliente no se llevó nada.
    const pendiente = redondear(sale.saldoPendiente);
    if (sale.condicionPago === 'cuenta_corriente' && sale.clientId && pendiente > 0) {
      await registrarMovimiento({
        businessId: req.auth.businessId,
        clientId:   sale.clientId,
        saleId:     sale.id,
        employeeId: req.auth.employeeId || null,
        tipo:       'pago',
        monto:      pendiente,
        notas:      `Anulación venta ${sale.numero}: ${motivo}`.slice(0, 255),
      }, t);
    }

    const devolvio = await devolverStockVenta(sale, t, {
      employeeId: req.auth.employeeId || null,
      motivo: `Anulación venta ${sale.numero}: ${motivo}`.slice(0, 255),
    });

    await sale.update({
      estado: 'cancelado',
      saldoPendiente: 0,
      /*
       * La plata deja de figurar como cobrada. Si el arqueo del turno ya se
       * cerró con ese efectivo adentro, el ajuste es un egreso de caja hecho
       * por quien devuelve el dinero, no un número que se cambie por atrás.
       */
      totalCobrado: 0,
      recargoPagos: 0,
      notas: [sale.notas, `ANULADA: ${motivo}`].filter(Boolean).join(' · ').slice(0, 500),
    }, { transaction: t });

    await t.commit();

    const full = await Sale.findByPk(sale.id, {
      include: [{ model: SaleItem, as: 'items' }, { association: 'empleado', attributes: ['id', 'nombre', 'apellido'] }],
    });
    res.json({
      ok: true,
      venta: full,
      devolvioStock: devolvio,
      mensaje: devolvio
        ? `Venta ${sale.numero} anulada. La mercadería volvió al stock.`
        : `Venta ${sale.numero} anulada. No había stock que devolver: nunca llegó a descontarse.`,
    });
  } catch (error) {
    await t.rollback().catch(() => {});
    next(error);
  }
};

/*
 * Los únicos estados que una venta puede tener.
 *
 * Sin esta lista se guardaba cualquier texto: un PATCH con estado "banana"
 * devolvía 200 y dejaba la venta en un estado que ninguna pantalla sabe
 * dibujar y que ningún filtro encuentra. Peor todavía, salía del arqueo de
 * caja —que busca 'pagado'— sin quedar como cancelada.
 */
const ESTADOS_VENTA = ['pendiente', 'pagado', 'cancelado'];

const updateSaleStatus = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const { estado } = req.body;
    if (!ESTADOS_VENTA.includes(estado)) {
      throw Object.assign(
        new Error(`Estado inválido. Los posibles son: ${ESTADOS_VENTA.join(', ')}.`),
        { status: 400 }
      );
    }
    if (estado === 'pagado') {
      throw Object.assign(
        new Error('Para cobrar una venta usá el cobro, que registra con qué se pagó.'),
        { status: 400 }
      );
    }
    if (estado === 'cancelado') {
      throw Object.assign(
        new Error('Para anular una venta usá la anulación, que pide el motivo y devuelve el stock.'),
        { status: 400 }
      );
    }

    const sale = await Sale.findOne({
      where: dondeVenta(req),
      transaction: t, lock: t.LOCK.UPDATE,
    });
    if (!sale) throw Object.assign(new Error('Venta no encontrada.'), { status: 404 });

    await sale.update({ estado }, { transaction: t });
    await t.commit();

    const full = await Sale.findByPk(sale.id, {
      include: [{ model: SaleItem, as: 'items' }, { association: 'empleado', attributes: ['id', 'nombre', 'apellido'] }],
    });
    res.json(full);
  } catch (error) {
    /*
     * El rollback no puede tumbar el servidor.
     *
     * Si la transacción ya murió —un error de SQL la aborta sola—, este
     * rollback falla, y como Express no espera al handler la promesa queda sin
     * manejar y el proceso se cae entero. Un pedido que falla tiene que
     * devolver 500, no dejar sin servicio a todos los negocios.
     */
    await t.rollback().catch(() => {});
    next(error);
  }
};

// POST /api/sales/cotizacion/:numero/convertir
// Convierte una cotización en venta sin facturar
/*
 * POST /api/sales/cotizacion/:numero/convertir
 *
 * Pasa un presupuesto a venta: comprueba el stock, lo descuenta y le da número
 * de venta.
 *
 * Antes esto sólo cambiaba `tipo` de cotizacion a venta. Nada más. La
 * cotización se puede hacer sin stock —es justamente para lo que sirve, cotizar
 * algo que todavía no llegó—, así que convertirla sin mirar dejaba la venta
 * hecha, la mercadería sin descontar y el inventario diciendo que había una
 * prenda que ya se había entregado. La diferencia recién aparecía contando a
 * mano.
 *
 * El stock sale acá y no al cobrar: convertir un presupuesto en venta es el
 * momento en que el cliente se lleva la mercadería, aunque pague después.
 */
const convertQuoteToSale = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    /*
     * Sin `include`: Postgres rechaza `FOR UPDATE` sobre el lado nulo de un
     * LEFT JOIN ("FOR UPDATE cannot be applied to the nullable side of an
     * outer join"), y traer los ítems asociados arma exactamente ese join. En
     * SQL Server pasa sin chistar, así que el error sólo aparece en
     * producción. Los ítems se cargan aparte, dentro de la misma transacción.
     */
    const quote = await Sale.findOne({
      where: dondeVenta(req, { tipo: 'cotizacion' }),
      transaction: t, lock: t.LOCK.UPDATE,
    });
    if (!quote) {
      await t.rollback();
      return res.status(404).json({ message: 'Cotización no encontrada.' });
    }
    if (quote.estado === 'cancelado') {
      await t.rollback();
      return res.status(409).json({ message: 'Esta cotización está anulada.' });
    }

    /*
     * De qué local sale la mercadería.
     *
     * El de la cotización si lo tiene; si no, el del empleado. Una cotización
     * puede haberse hecho sin local —no descuenta nada, así que no hacía
     * falta—, pero la venta sí necesita saberlo.
     */
    let locationId = Number(req.body?.locationId) || quote.locationId || null;

    if (req.auth.employeeId && !Number(req.body?.locationId)) {
      const empleado = await Employee.findOne({
        where: { id: req.auth.employeeId, businessId: req.auth.businessId }, transaction: t,
      });
      locationId = empleado?.locationId || locationId;
    }

    if (!locationId) {
      const activos = await BusinessLocation.findAll({
        where: { businessId: req.auth.businessId, activo: true, tipo: { [Op.ne]: 'deposito' } },
        order: [['id', 'ASC']], transaction: t,
      });
      if (activos.length === 1) locationId = activos[0].id;
      else if (activos.length === 0) {
        await t.rollback();
        return res.status(409).json({ message: 'No hay ningún local de venta cargado.' });
      } else {
        await t.rollback();
        return res.status(400).json({ message: 'Elegí de qué local sale la mercadería al convertir la cotización.' });
      }
    }

    const local = await BusinessLocation.findOne({
      where: { id: locationId, businessId: req.auth.businessId, activo: true }, transaction: t,
    });
    if (!local) {
      await t.rollback();
      return res.status(400).json({ message: 'El local indicado no pertenece a este negocio o está inactivo.' });
    }
    if (local.tipo === 'deposito') {
      await t.rollback();
      return res.status(400).json({
        message: `"${local.nombre}" es un depósito y de un depósito no se vende. Transferí la mercadería a un local primero.`,
      });
    }

    /*
     * Se comprueba TODO antes de descontar nada.
     *
     * Frenar en la mitad dejaría media cotización convertida, con parte del
     * stock ya descontado y un documento que sigue diciendo "cotización".
     */
    const lineas = await SaleItem.findAll({ where: { saleId: quote.id }, transaction: t });

    const faltantes = [];
    for (const item of lineas) {
      if (!item.productVariantId) continue;
      const disponible = await stockService.stockEn(item.productVariantId, locationId, t);
      if (disponible < item.cantidad) {
        const variante = await ProductVariant.findByPk(item.productVariantId, {
          include: [{ model: Product, as: 'producto', attributes: ['titulo'] }], transaction: t,
        });
        const nombre = [variante?.producto?.titulo, variante?.variante1Valor, variante?.variante2Valor]
          .filter(Boolean).join(' · ');
        faltantes.push({
          sku: variante?.sku || String(item.productVariantId),
          nombre, pide: item.cantidad, hay: disponible,
          total: Number(variante?.stock) || 0,
        });
      }
    }

    if (faltantes.length) {
      await t.rollback();
      const detalle = faltantes
        .map((f) => `${f.nombre || f.sku} (${f.sku}): ${f.hay === 0 ? 'no queda nada' : `quedan ${f.hay}`} y la cotización pide ${f.pide}`)
        .join('; ');
      const enOtros = faltantes.some((f) => f.total > f.hay);
      return res.status(409).json({
        message: `No se puede convertir en venta: falta stock en ${local.nombre}. ${detalle}.`
          + (enOtros ? ' Hay unidades en otros locales: transferilas desde Stock.' : ''),
        codigo: 'SIN_STOCK',
        faltantes,
      });
    }

    /*
     * El número va por el mismo camino que el de una venta nueva.
     *
     * Acá el `numero` se escribe sobre una fila que ya existe, y eso es
     * exactamente lo que rompía la numeración: una venta convertida queda con
     * número alto sobre un id viejo. Con el máximo como fuente eso ya no
     * confunde a nadie, y el reintento cubre que otra caja esté cobrando en
     * este mismo momento.
     */
    let numero;
    await crearConNumero(
      (saltar) => nextSaleNumber(req.auth.businessId, 'venta', saltar),
      // Nace como venta abierta: se debe entera hasta que se cobre.
      (n, sp) => {
        numero = n;
        return quote.update({
          tipo: 'venta', estado: 'pendiente', numero: n,
          saldoPendiente: quote.total,
          locationId,
          employeeId: quote.employeeId || req.auth.employeeId || null,
        }, { transaction: sp || t });
      },
      { transaction: t },
    );

    await descontarStockVenta(quote, t, {
      employeeId: req.auth.employeeId || null,
      motivo: `Conversión de cotización a venta ${numero}`,
    });

    await t.commit();

    const full = await Sale.findByPk(quote.id, {
      include: [{ model: SaleItem, as: 'items' }, { association: 'empleado', attributes: ['id', 'nombre', 'apellido'] }],
    });
    res.json(full);
  } catch (error) {
    await t.rollback().catch(() => {});
    next(error);
  }
};

// GET /api/sales/:numero/ticket → devuelve PDF de ticket 80mm inline
const downloadTicket = async (req, res, next) => {
  try {
    const sale = await Sale.findOne({
      where: dondeVenta(req),
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

module.exports = { getSales, getSale, createSale, cobrarSale, updateSaleStatus, anularSale, convertQuoteToSale, downloadTicket };
