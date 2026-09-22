/*
 * La bandeja de pedidos mayoristas: mirar, aceptar, rechazar.
 *
 * ── Por qué la venta la crea `createSale` y no este archivo ──────
 *
 * Una venta mayorista es una venta: numera igual, descuenta igual, va a la
 * caja igual, se factura igual y arma la cuenta corriente igual. Escribir acá
 * una segunda forma de nacer sería tener dos, y la segunda se atrasa siempre —
 * la primera vez que alguien arregle algo en el punto de venta, esto va a
 * quedar viejo sin que nadie se entere.
 *
 * Así que se llama a la misma función que usa el mostrador, en el mismo
 * proceso. Lee `req.auth` y `req.body` y contesta una sola vez, así que
 * alcanza con armarle los dos y escucharle la respuesta.
 *
 * ── Por qué la sesión de quien aprueba ───────────────────────────
 *
 * De qué local sale la mercadería, qué empleado la vendió, en qué turno de
 * caja entra la plata y si se cobra o se fía son cuatro cosas que un sistema
 * de afuera no puede saber. Salen solas de la persona que aprieta el botón.
 */

const solicitudes = require('../services/solicitudMayoristaService');
const { createSale } = require('./saleController');

/**
 * Corre `createSale` en este mismo proceso y devuelve lo que habría contestado.
 *
 * No se comparte la transacción: `createSale` abre la suya. Por eso la
 * solicitud se reserva ANTES —con un UPDATE condicionado— y se devuelve a la
 * bandeja si la venta no sale. Es la diferencia entre una venta huérfana y una
 * solicitud que vuelve a aparecer para que alguien reintente.
 */
function crearVenta({ auth, body }) {
  return new Promise((resolve, reject) => {
    const req = { auth, body, params: {}, query: {}, headers: {} };
    const res = {
      statusCode: 200,
      status(codigo) { this.statusCode = codigo; return this; },
      json(payload) { resolve(payload); },
    };
    Promise.resolve(createSale(req, res, reject)).catch(reject);
  });
}

const getSolicitudes = async (req, res, next) => {
  try {
    res.json(await solicitudes.listar({
      businessId: req.auth.businessId,
      estado: req.query.estado || null,
      limite: req.query.limite,
    }));
  } catch (e) { next(e); }
};

const getSolicitud = async (req, res, next) => {
  try {
    res.json(await solicitudes.detalle({
      businessId: req.auth.businessId,
      id: Number(req.params.id),
    }));
  } catch (e) { next(e); }
};

/*
 * POST /api/solicitudes-mayoristas/:id/aceptar
 *
 * El cuerpo es el de una venta del mostrador —local, cliente, condición de
 * pago, pagos— menos los artículos, que salen de la solicitud y no de quien
 * aprueba: aceptar es aceptar ESTE pedido, no armar otro.
 *
 * Si falta stock, `createSale` contesta 409 con el detalle de lo que falta.
 * La persona lo mira y vuelve con `confirmarAltaStock: true`, que da de alta
 * esas unidades y las descuenta con la venta. Es el mismo camino que el
 * mostrador usa cuando la percha tiene algo que el inventario no.
 */
const postAceptar = async (req, res, next) => {
  const businessId = req.auth.businessId;
  const id = Number(req.params.id);
  let reservada = false;
  try {
    const { solicitud, items } = await solicitudes.reservarParaAceptar({
      businessId, id, employeeId: req.auth.employeeId,
    });
    reservada = true;

    const nota = [`Pedido ${solicitud.origen} ${solicitud.pedidoExterno}`, req.body?.notas]
      .filter(Boolean).join(' · ');

    const venta = await crearVenta({
      auth: req.auth,
      body: {
        tipo: 'venta',
        locationId: req.body?.locationId,
        clientId: req.body?.clientId ?? null,
        clienteAdHoc: req.body?.clienteAdHoc,
        condicionPago: req.body?.condicionPago || 'contado',
        estado: req.body?.estado,
        medioPago: req.body?.medioPago,
        pagos: req.body?.pagos,
        descuentoPct: req.body?.descuentoPct,
        descuentoMonto: req.body?.descuentoMonto,
        descontarStock: req.body?.descontarStock,
        confirmarAltaStock: req.body?.confirmarAltaStock === true,
        notas: nota.slice(0, 500),
        // Los artículos salen de la solicitud, no del navegador.
        items: items.map((i) => ({ productVariantId: i.productVariantId, cantidad: i.cantidad })),
      },
    });

    await solicitudes.anotarVenta({ businessId, id, saleId: venta.id });
    res.status(201).json({
      ok: true,
      venta,
      solicitud: await solicitudes.detalle({ businessId, id }),
    });
  } catch (e) {
    /*
     * La venta no salió: la solicitud vuelve a la bandeja.
     *
     * Sin esto, un 409 por falta de stock —que es el caso normal de un pedido
     * mayorista— dejaría la solicitud marcada como aceptada y sin venta, y
     * nadie podría volver a intentarlo.
     */
    if (reservada) await solicitudes.devolverALaBandeja({ businessId, id }).catch(() => {});
    next(e);
  }
};

const postRechazar = async (req, res, next) => {
  try {
    res.json(await solicitudes.rechazar({
      businessId: req.auth.businessId,
      id: Number(req.params.id),
      motivo: req.body?.motivo,
      employeeId: req.auth.employeeId,
    }));
  } catch (e) { next(e); }
};

module.exports = { getSolicitudes, getSolicitud, postAceptar, postRechazar };
