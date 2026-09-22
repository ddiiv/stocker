/*
 * Lo que un sistema de afuera puede hacer, y lo que el dueño hace con él.
 *
 * Son dos públicos distintos en un mismo archivo: `recibirPedido` la llama
 * ISUWAYA con su credencial de máquina; el resto lo usa el dueño desde la
 * pantalla de integraciones, con su sesión.
 */

const integraciones = require('../services/integracionesService');
const solicitudes = require('../services/solicitudMayoristaService');

/*
 * POST /api/integraciones/:origen/pedidos
 *
 * El negocio sale de la credencial y nunca del cuerpo. El código de respuesta
 * distingue el alta del reenvío: 201 es "lo tomé por primera vez", 200 es "ya
 * lo tenía". El origen reintenta sobre cualquier cosa que no sea 2xx, así que
 * un pedido repetido tiene que contestar 200 y no un error.
 */
const recibirPedido = async (req, res, next) => {
  try {
    const { businessId, origen } = req.integracion;
    const r = await solicitudes.recibir({ businessId, origen, cuerpo: req.body });

    res.status(r.creada ? 201 : 200).json({
      ok: true,
      id: r.solicitud.id,
      pedidoExterno: r.solicitud.pedidoExterno,
      estado: r.solicitud.estado,
      creada: r.creada,
      repetido: r.repetido,
      // Una entrega vieja que llegó tarde: se descartó a propósito.
      ignorado: r.ignorado,
      /*
       * El pedido cambió después de que acá se revisó. El origen no puede
       * arreglarlo solo, pero tiene que poder mostrarlo en su panel en vez de
       * creer que el cambio se aplicó.
       */
      cambioTardio: r.cambioTardio,
    });
  } catch (e) { next(e); }
};

/*
 * GET /api/integraciones/:origen/pedidos/resoluciones?desde=&limite=
 *
 * Lo que pasó con los pedidos que mandó: aceptados —con el número de venta— y
 * rechazados con su motivo. El que pregunta manda hasta dónde ya leyó y se
 * lleva el cursor para la próxima vuelta.
 *
 * Pregunta el origen en vez de avisar Stocker porque el origen ya tiene un
 * reloj y reintentos escritos, y porque si se cae no se pierde nada: cuando
 * vuelve, pregunta desde donde quedó.
 */
const resolucionesDePedidos = async (req, res, next) => {
  try {
    const { businessId, origen } = req.integracion;
    res.json(await solicitudes.resoluciones({
      businessId, origen, desde: req.query.desde || null, limite: req.query.limite,
    }));
  } catch (e) { next(e); }
};

/*
 * GET /api/integraciones/:origen/precios?desde=
 *
 * El precio mayorista de cada SKU. Existe para que haya UNA lista: el catálogo
 * del portal salió de una exportación y desde ese día los precios viven por
 * separado, así que el cliente arma el pedido con un número y la venta se
 * registra con otro.
 */
const preciosPorSku = async (req, res, next) => {
  try {
    const precios = require('../services/preciosIntegracionService');
    res.json(await precios.precios({
      businessId: req.integracion.businessId,
      desde: req.query.desde || null,
    }));
  } catch (e) { next(e); }
};

/** GET /api/integraciones — las credenciales del negocio, sin los tokens. */
const listar = async (req, res, next) => {
  try {
    res.json({ integraciones: await integraciones.listar(req.auth.businessId) });
  } catch (e) { next(e); }
};

/*
 * POST /api/integraciones — emite una credencial nueva.
 *
 * El token viaja UNA sola vez, en esta respuesta. No se puede volver a ver: si
 * se pierde, se emite otra y la anterior deja de servir.
 */
const emitir = async (req, res, next) => {
  try {
    const { token, integracion } = await integraciones.emitir({
      businessId: req.auth.businessId,
      origen: req.body?.origen,
      nombre: req.body?.nombre || null,
    });
    res.status(201).json({
      token,
      aviso: 'Guardalo ahora: no se vuelve a mostrar.',
      integracion: {
        id: integracion.id, origen: integracion.origen, nombre: integracion.nombre,
        pista: integracion.pista, activa: integracion.activa,
      },
    });
  } catch (e) { next(e); }
};

/** DELETE /api/integraciones/:id — corta el puente. */
const revocar = async (req, res, next) => {
  try {
    res.json(await integraciones.revocar({
      businessId: req.auth.businessId,
      id: Number(req.params.id),
    }));
  } catch (e) { next(e); }
};

module.exports = { recibirPedido, resolucionesDePedidos, preciosPorSku, listar, emitir, revocar };
