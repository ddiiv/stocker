/*
 * Mensajes y reclamos de Mercado Libre, por HTTP.
 *
 * El negocio SIEMPRE sale de la sesión. Sin ese filtro, los ids de mensaje y de
 * reclamo llegan del cliente y cualquiera con una cuenta podría leerse la
 * conversación de un comprador de otro negocio —nombre, teléfono, dirección— o
 * marcarle los reclamos como atendidos.
 */

const { Op } = require('sequelize');
const postventa = require('../services/mercadolibrePostventaService');
const {
  MercadoLibreAccount, MercadoLibreMensaje, MercadoLibreReclamo, PedidoPlataforma,
} = require('../models');

/** La cuenta conectada, o un 409 que dice qué hacer. */
async function cuentaDe(req, res) {
  const cuenta = await MercadoLibreAccount.findOne({ where: { businessId: req.auth.businessId } });
  if (!cuenta?.refreshToken) {
    res.status(409).json({
      message: 'No hay ninguna cuenta de Mercado Libre conectada. Conectala en Integraciones.',
    });
    return null;
  }
  return cuenta;
}

/*
 * GET /api/mercadolibre/mensajes
 *
 * Agrupado por conversación, no un mensaje por fila.
 *
 * Una bandeja de mensajes sueltos obliga a reconstruir mentalmente quién dijo
 * qué: lo que se atiende es la conversación, y lo que se necesita ver de un
 * vistazo es cuál tiene algo sin leer y hace cuánto.
 */
const listarMensajes = async (req, res, next) => {
  try {
    const { businessId } = req.auth;
    const soloSinLeer = req.query.sinLeer === '1';

    const donde = { businessId };
    const mensajes = await MercadoLibreMensaje.findAll({
      where: donde,
      order: [['enviadoEn', 'DESC']],
      limit: 500,
    });

    const porPack = new Map();
    for (const m of mensajes) {
      if (!porPack.has(m.packId)) {
        porPack.set(m.packId, {
          packId: m.packId,
          pedidoExterno: m.pedidoExterno,
          sinLeer: 0,
          ultimo: null,
          mensajes: [],
        });
      }
      const c = porPack.get(m.packId);
      if (m.deQuien === 'comprador' && !m.leidoEn) c.sinLeer += 1;
      c.mensajes.push({
        id: m.id,
        deQuien: m.deQuien,
        texto: m.texto,
        adjuntos: m.adjuntos ? JSON.parse(m.adjuntos) : [],
        enviadoEn: m.enviadoEn,
        leidoEn: m.leidoEn,
      });
      if (!c.ultimo || (m.enviadoEn && m.enviadoEn > c.ultimo)) c.ultimo = m.enviadoEn;
    }

    // Dentro de cada conversación, en orden de lectura: lo primero arriba.
    const conversaciones = [...porPack.values()].map((c) => ({
      ...c,
      mensajes: c.mensajes.slice().reverse(),
    }));

    // El comprador, cuando la venta está en Stocker. Sin nombre, la bandeja es
    // una lista de números de pedido.
    const externos = conversaciones.map((c) => c.pedidoExterno).filter(Boolean);
    if (externos.length) {
      const pedidos = await PedidoPlataforma.findAll({
        where: { businessId, plataforma: 'mercadolibre', pedidoExterno: externos },
        attributes: ['pedidoExterno', 'compradorNombre', 'total'],
      });
      const porExterno = new Map(pedidos.map((p) => [p.pedidoExterno, p]));
      for (const c of conversaciones) {
        const p = porExterno.get(c.pedidoExterno);
        c.comprador = p?.compradorNombre || null;
        c.total = p ? Number(p.total) : null;
      }
    }

    const visibles = soloSinLeer ? conversaciones.filter((c) => c.sinLeer > 0) : conversaciones;
    visibles.sort((a, b) => {
      // Lo que espera respuesta primero: es una bandeja de trabajo.
      if ((b.sinLeer > 0) !== (a.sinLeer > 0)) return b.sinLeer > 0 ? 1 : -1;
      return new Date(b.ultimo || 0) - new Date(a.ultimo || 0);
    });

    return res.json({
      conversaciones: visibles,
      resumen: {
        conversaciones: conversaciones.length,
        sinLeer: conversaciones.filter((c) => c.sinLeer > 0).length,
        mensajesSinLeer: conversaciones.reduce((n, c) => n + c.sinLeer, 0),
      },
    });
  } catch (e) { return next(e); }
};

/*
 * POST /api/mercadolibre/mensajes/:packId/leido
 *
 * Marca leída la conversación entera, no mensaje por mensaje: se lee de una y
 * pedir un clic por mensaje convierte atender diez conversaciones en cuarenta
 * clics.
 *
 * Sólo marca lo del comprador. Lo del vendedor ya nace leído.
 */
const marcarLeida = async (req, res, next) => {
  try {
    const [cuantos] = await MercadoLibreMensaje.update(
      { leidoEn: new Date() },
      {
        where: {
          businessId: req.auth.businessId,
          packId: String(req.params.packId),
          deQuien: 'comprador',
          leidoEn: null,
        },
      },
    );
    return res.json({ ok: true, marcados: cuantos });
  } catch (e) { return next(e); }
};

/*
 * GET /api/mercadolibre/reclamos
 *
 * Los abiertos primero y, dentro de ésos, el que vence antes: un reclamo que se
 * pasa de plazo lo resuelve ML a favor del comprador y le pega a la reputación
 * de la cuenta, así que el orden por fecha de apertura sepulta justo el que
 * apura.
 */
const listarReclamos = async (req, res, next) => {
  try {
    const { businessId } = req.auth;
    const donde = { businessId };
    if (req.query.abiertos === '1') donde.cerradoEn = null;

    const filas = await MercadoLibreReclamo.findAll({
      where: donde, order: [['abiertoEn', 'DESC']], limit: 300,
    });

    const ahora = Date.now();
    const reclamos = filas.map((r) => ({
      id: r.id,
      reclamoIdMl: r.reclamoIdMl,
      pedidoExterno: r.pedidoExterno,
      envioId: r.envioId,
      tipo: r.tipo,
      estadoMl: r.estadoMl,
      etapa: r.etapa,
      razon: r.razon,
      abiertoEn: r.abiertoEn,
      venceEn: r.venceEn,
      cerradoEn: r.cerradoEn,
      atendidoEn: r.atendidoEn,
      nota: r.nota,
      /*
       * Vencido: pasó el plazo de ML y todavía está abierto. Es el estado que
       * hay que ver de lejos, porque a esa altura ya no se puede hacer nada
       * desde acá y sólo queda entender qué falló.
       */
      vencido: Boolean(r.venceEn && !r.cerradoEn && new Date(r.venceEn).getTime() < ahora),
      horasParaVencer: r.venceEn && !r.cerradoEn
        ? Math.round((new Date(r.venceEn).getTime() - ahora) / 3600000)
        : null,
    }));

    reclamos.sort((a, b) => {
      const abiertoA = a.cerradoEn ? 1 : 0;
      const abiertoB = b.cerradoEn ? 1 : 0;
      if (abiertoA !== abiertoB) return abiertoA - abiertoB;
      // Entre abiertos, el que vence antes. Sin vencimiento, al final.
      const va = a.venceEn ? new Date(a.venceEn).getTime() : Infinity;
      const vb = b.venceEn ? new Date(b.venceEn).getTime() : Infinity;
      if (va !== vb) return va - vb;
      return new Date(b.abiertoEn || 0) - new Date(a.abiertoEn || 0);
    });

    return res.json({
      reclamos,
      resumen: {
        total: reclamos.length,
        abiertos: reclamos.filter((r) => !r.cerradoEn).length,
        vencidos: reclamos.filter((r) => r.vencido).length,
        sinAtender: reclamos.filter((r) => !r.cerradoEn && !r.atendidoEn).length,
      },
    });
  } catch (e) { return next(e); }
};

/*
 * PATCH /api/mercadolibre/reclamos/:id
 *
 * El seguimiento de acá: quién lo tomó y qué se hizo. ML no tiene dónde anotar
 * eso, y es justo lo que se pierde cuando lo maneja una persona de memoria.
 */
const seguirReclamo = async (req, res, next) => {
  try {
    const r = await MercadoLibreReclamo.findOne({
      where: { id: Number(req.params.id), businessId: req.auth.businessId },
    });
    if (!r) return res.status(404).json({ message: 'Ese reclamo no existe en este negocio.' });

    const cambios = {};
    if (req.body?.nota !== undefined) cambios.nota = String(req.body.nota).slice(0, 4000);
    if (req.body?.atendido !== undefined) {
      cambios.atendidoEn = req.body.atendido ? new Date() : null;
      cambios.atendidoPorEmployeeId = req.body.atendido ? (req.auth.employeeId || null) : null;
    }
    await r.update(cambios);
    return res.json({ ok: true, atendidoEn: r.atendidoEn, nota: r.nota });
  } catch (e) { return next(e); }
};

/*
 * POST /api/mercadolibre/postventa/sincronizar
 *
 * El botón manual. Existe aunque haya webhook y barrido: cuando alguien
 * sospecha que falta algo, mirar una pantalla que no ofrece forma de
 * comprobarlo es peor que la espera.
 */
const sincronizar = async (req, res, next) => {
  try {
    const cuenta = await cuentaDe(req, res);
    if (!cuenta) return undefined;

    const r = await postventa.barrer(cuenta);
    return res.json({
      ok: true,
      ...r,
      mensaje: `${r.mensajesNuevos} mensaje(s) nuevo(s) en ${r.conversaciones} conversación(es). `
        + `Reclamos: ${r.reclamos.nuevos} nuevo(s), ${r.reclamos.cambiados} con cambios.`,
    });
  } catch (e) {
    if (e.codigo === 'ML_SIN_PERMISO') {
      return res.status(403).json({ message: e.message, codigo: e.codigo });
    }
    return next(e);
  }
};

module.exports = {
  listarMensajes, marcarLeida, listarReclamos, seguirReclamo, sincronizar,
};
