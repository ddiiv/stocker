/*
 * La sección Plataformas: el estado de cada forma de conectar el negocio y el
 * pedido de cotización de un desarrollo a medida.
 *
 * El negocio sale SIEMPRE de la sesión (req.auth). El cuerpo trae lo que la
 * persona escribió y nada más.
 */

const plataformas = require('../services/plataformasService');

/* GET /api/plataformas — sin tokens, ver plataformasService.estadoDePlataformas. */
const estado = async (req, res, next) => {
  try {
    res.json(await plataformas.estadoDePlataformas(req.auth.businessId));
  } catch (e) { next(e); }
};

/* GET /api/plataformas/cotizaciones — los pedidos de este negocio y su estado. */
const listarCotizaciones = async (req, res, next) => {
  try {
    res.json({ cotizaciones: await plataformas.cotizacionesDe(req.auth.businessId) });
  } catch (e) { next(e); }
};

/*
 * POST /api/plataformas/cotizaciones
 *
 * 201 en cuanto la fila está guardada, haya salido el mail o no: el pedido no
 * se pierde porque el correo esté caído. El aviso corre después, solo.
 */
const crearCotizacion = async (req, res, next) => {
  try {
    const { cotizacion, whatsapp } = await plataformas.crearCotizacion(req.auth, req.body || {});
    res.status(201).json({
      cotizacion,
      whatsapp,
      mensaje: 'Recibimos tu pedido. Te escribimos para conversar el alcance y pasarte el presupuesto.',
    });
  } catch (e) { next(e); }
};

/* ── Backoffice ───────────────────────────────────────────────── */

/* GET /api/backoffice/cotizaciones?estado= */
const listarBackoffice = async (req, res, next) => {
  try {
    res.json({
      cotizaciones: await plataformas.listarParaBackoffice({
        estado: req.query.estado || null,
        limite: req.query.limit,
      }),
      estados: plataformas.ESTADOS_COTIZACION,
    });
  } catch (e) { next(e); }
};

/* PATCH /api/backoffice/cotizaciones/:id  { estado?, notaInterna? } */
const actualizarBackoffice = async (req, res, next) => {
  try {
    const { estado: nuevo, notaInterna } = req.body || {};
    res.json({
      cotizacion: await plataformas.actualizarDesdeBackoffice(req.params.id, { estado: nuevo, notaInterna }, req.admin),
    });
  } catch (e) { next(e); }
};

module.exports = { estado, listarCotizaciones, crearCotizacion, listarBackoffice, actualizarBackoffice };
