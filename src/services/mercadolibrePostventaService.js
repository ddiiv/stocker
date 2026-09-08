/*
 * Lo que pasa DESPUÉS de la venta en Mercado Libre: mensajes y reclamos.
 *
 * Son dos cosas distintas con la misma forma —algo que el comprador inició, que
 * tiene reloj, y que si no se atiende le pega a la cuenta— así que viven juntas
 * y comparten cómo se traen, cómo se guardan y cómo se avisa que algo falló.
 *
 * ── Por qué se guardan acá y no se leen de ML cada vez ────────────
 *
 *   · Se puede saber qué está sin atender. ML marca leído cuando lo abrís EN
 *     ML; acá hace falta un estado propio para que esto sea una bandeja de
 *     trabajo y no un espejo de la de ML.
 *   · La pantalla abre sin esperar a la API. Con doscientas ventas, preguntar
 *     al abrir serían doscientas consultas.
 *   · Un mensaje de una venta vieja se sigue viendo aunque ML ya no lo
 *     devuelva entre lo reciente.
 *
 * ── Sobre la forma de las respuestas de ML ────────────────────────
 *
 * La API de posventa de ML cambia de forma seguido y no siempre igual para
 * todas las cuentas. Todo lo que se lee acá pasa por lecturas tolerantes —un
 * campo que no está queda en null, no rompe— y lo crudo se guarda en `detalle`,
 * para que un campo que hoy no modelamos se pueda mostrar sin volver a pedirlo
 * ni salir a tocar código.
 */

const axios = require('axios');
const {
  MercadoLibreAccount, MercadoLibreMensaje, MercadoLibreReclamo, PedidoPlataforma,
} = require('../models');
const ml = require('./mercadolibreService');
const { log } = require('../utils/logger');

const ML_API = 'https://api.mercadolibre.com';
const TIMEOUT_MS = 15000;

/** Los tópicos de webhook que atiende este archivo. */
const TOPICOS_POSTVENTA = ['messages', 'claims'];

/*
 * Una lectura contra ML que no tumba a quien la llama.
 *
 * Un 403 acá casi siempre significa lo mismo: a la app de Mercado Libre le
 * falta el permiso, y eso no se arregla reintentando. Se distingue del resto
 * para poder decirlo con esas palabras en la pantalla, en vez de mostrar
 * "Request failed with status code 403", que no le dice a nadie qué hacer.
 */
async function pedir(cuenta, ruta, params = null) {
  const token = await ml.tokenValido(cuenta);
  try {
    const { data } = await axios.get(`${ML_API}${ruta}`, {
      headers: { Authorization: `Bearer ${token}` },
      params: params || undefined,
      timeout: TIMEOUT_MS,
    });
    return data;
  } catch (e) {
    const status = e.response?.status;
    if (status === 403 || status === 401) {
      const err = new Error(
        'Mercado Libre rechazó la consulta por permisos. En el panel de tu app de ML, '
        + 'habilitá los tópicos de notificaciones "messages" y "claims" y volvé a '
        + 'autorizar la cuenta: los permisos se otorgan al autorizar, no después.',
      );
      err.codigo = 'ML_SIN_PERMISO';
      err.status = 403;
      throw err;
    }
    throw e;
  }
}

/** El primer valor que exista, para respuestas que cambian de forma. */
const primero = (...valores) => valores.find((v) => v !== undefined && v !== null) ?? null;

const aFecha = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/* ═══════════════════════════════════════════════════════════════════
   MENSAJES
   ═══════════════════════════════════════════════════════════════════ */

/*
 * Los mensajes de una conversación, normalizados.
 *
 * ML devuelve el remitente como un id de usuario. Compararlo contra el id del
 * vendedor es lo único que distingue "me escribió el comprador" de "le
 * contesté yo", y esa distinción es toda la pantalla: una bandeja que mezcla
 * las dos cosas no dice qué falta responder.
 */
function normalizarMensaje(m, cuenta, packId) {
  const remitente = String(primero(m?.from?.user_id, m?.from?.id, '') || '');
  const esVendedor = remitente && String(cuenta.mlUserId) === remitente;
  const adjuntos = Array.isArray(m?.message_attachments)
    ? m.message_attachments.map((a) => primero(a?.original_filename, a?.filename, a?.id)).filter(Boolean)
    : [];

  return {
    mensajeIdMl: String(primero(m?.id, m?.message_id, '')),
    packId: String(packId),
    deQuien: esVendedor ? 'vendedor' : 'comprador',
    remitenteMl: remitente || null,
    texto: primero(m?.text, m?.message, m?.plain_text) || '',
    adjuntos: adjuntos.length ? JSON.stringify(adjuntos) : null,
    enviadoEn: aFecha(primero(m?.message_date?.created, m?.date_created, m?.date_created_at)),
  };
}

/**
 * Trae y guarda la conversación de un pack. Devuelve cuántos mensajes nuevos.
 *
 * Es idempotente por `mensajeIdMl`: la misma notificación repetida —que en ML
 * pasa seguido— no duplica nada.
 */
async function traerConversacion(cuenta, packId) {
  const data = await pedir(
    cuenta,
    `/messages/packs/${packId}/sellers/${cuenta.mlUserId}`,
    { mark_as_read: false, limit: 200 },
  );
  const crudos = Array.isArray(data?.messages) ? data.messages
    : Array.isArray(data?.results) ? data.results
      : Array.isArray(data) ? data : [];

  // Con qué venta tiene que ver, si la tenemos. Sirve para poder abrir el
  // pedido desde el mensaje sin que la pantalla tenga que adivinarlo.
  const pedido = await PedidoPlataforma.findOne({
    where: { businessId: cuenta.businessId, plataforma: 'mercadolibre', pedidoExterno: String(packId) },
    attributes: ['pedidoExterno'],
  });

  let nuevos = 0;
  for (const crudo of crudos) {
    const m = normalizarMensaje(crudo, cuenta, packId);
    if (!m.mensajeIdMl) continue;
    const [, creado] = await MercadoLibreMensaje.findOrCreate({
      where: { businessId: cuenta.businessId, mensajeIdMl: m.mensajeIdMl },
      defaults: {
        ...m,
        businessId: cuenta.businessId,
        pedidoExterno: pedido?.pedidoExterno || String(packId),
        /*
         * Lo que escribió el vendedor nace leído: es de él, no tiene nada que
         * atender. Sólo lo del comprador entra a la bandeja.
         */
        leidoEn: m.deQuien === 'vendedor' ? new Date() : null,
      },
    });
    if (creado) nuevos += 1;
  }
  return nuevos;
}

/*
 * Una notificación de mensaje.
 *
 * El recurso viene como `/messages/<id>`. Se pide ese mensaje sólo para saber
 * de qué conversación es, y después se trae la conversación entera: un mensaje
 * suelto sin lo anterior no se entiende, y con la conversación completa la
 * pantalla no tiene que ir juntando pedazos.
 */
async function procesarMensaje(cuenta, resource) {
  const id = String(resource || '').split('/').filter(Boolean).pop();
  if (!id) return { accion: 'ignorada', motivo: 'sin id de mensaje' };

  const data = await pedir(cuenta, `/messages/${id}`);
  const packId = primero(
    data?.resource_id,
    data?.message_resources?.[0]?.id,
    data?.pack_id,
    data?.order_id,
  );
  if (!packId) return { accion: 'ignorada', motivo: 'el mensaje no dice de qué venta es' };

  const nuevos = await traerConversacion(cuenta, packId);
  return { accion: 'guardada', packId: String(packId), nuevos };
}

/* ═══════════════════════════════════════════════════════════════════
   RECLAMOS
   ═══════════════════════════════════════════════════════════════════ */

function normalizarReclamo(c) {
  const recursos = Array.isArray(c?.resource) ? c.resource
    : Array.isArray(c?.related_entities) ? c.related_entities : [];
  const buscar = (tipo) => {
    const r = recursos.find((x) => String(primero(x?.type, x?.resource, '')).includes(tipo));
    return r ? String(primero(r?.id, r?.resource_id, '')) : null;
  };

  return {
    reclamoIdMl: String(primero(c?.id, c?.claim_id, '')),
    pedidoExterno: primero(
      c?.resource === 'order' ? String(c?.resource_id) : null,
      buscar('order'),
      c?.order_id ? String(c.order_id) : null,
    ),
    envioId: primero(buscar('shipment'), c?.shipment_id ? String(c.shipment_id) : null),
    tipo: primero(c?.type, c?.claim_type),
    estadoMl: primero(c?.status, c?.claim_status),
    etapa: primero(c?.stage, c?.claim_stage),
    razon: String(primero(c?.reason_id, c?.reason?.name, c?.title, '') || '').slice(0, 200) || null,
    abiertoEn: aFecha(primero(c?.date_created, c?.created_at)),
    /*
     * El plazo para contestar. Es el dato que convierte la lista en algo
     * accionable: sin él, un reclamo abierto hace tres días se ve igual que uno
     * que vence en dos horas, y el que vence es el que cuesta plata.
     */
    venceEn: aFecha(primero(
      c?.expiration_date, c?.due_date, c?.players?.[0]?.expiration_date,
    )),
    cerradoEn: aFecha(primero(c?.last_updated_status, c?.date_closed)),
    detalle: JSON.stringify(c).slice(0, 60000),
  };
}

/**
 * Trae los reclamos de la cuenta y los guarda. Devuelve cuántos nuevos y
 * cuántos cambiaron de estado.
 *
 * Se actualiza lo que ya está en vez de sólo insertar lo nuevo: un reclamo vive
 * días y lo que importa es su estado de hoy, no el del día que se abrió.
 */
async function traerReclamos(cuenta, { limite = 50 } = {}) {
  /*
   * ML exige al menos uno de dos pares de filtro: resource+resource_id o
   * players.role+players.user_id. Sin ninguno responde 400 siempre, sin
   * importar el resto de los parámetros. El negocio es el vendedor, así que
   * siempre es "respondent" del lado del que reclaman.
   */
  const data = await pedir(cuenta, '/post-purchase/v1/claims/search', {
    limit: limite,
    sort: 'date_created:desc',
    'players.role': 'respondent',
    'players.user_id': cuenta.mlUserId,
  });
  const crudos = Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.results) ? data.results
      : Array.isArray(data) ? data : [];

  let nuevos = 0;
  let cambiados = 0;
  for (const crudo of crudos) {
    const r = normalizarReclamo(crudo);
    if (!r.reclamoIdMl) continue;

    const [fila, creado] = await MercadoLibreReclamo.findOrCreate({
      where: { businessId: cuenta.businessId, reclamoIdMl: r.reclamoIdMl },
      defaults: { ...r, businessId: cuenta.businessId, ultimaSync: new Date() },
    });
    if (creado) { nuevos += 1; continue; }

    /*
     * Se conservan la nota y el "atendido": son de acá, ML no los conoce y
     * pisarlos con cada sincronización borraría el seguimiento que alguien
     * escribió a mano.
     */
    const cambioEstado = fila.estadoMl !== r.estadoMl || fila.etapa !== r.etapa;
    await fila.update({ ...r, ultimaSync: new Date() });
    if (cambioEstado) cambiados += 1;
  }
  return { nuevos, cambiados, total: crudos.length };
}

/** Una notificación de reclamo: se resincroniza la lista, que es barata. */
async function procesarReclamo(cuenta) {
  const r = await traerReclamos(cuenta);
  return { accion: 'guardada', ...r };
}

/* ═══════════════════════════════════════════════════════════════════
   ENTRADA COMÚN
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Atiende una notificación de posventa.
 *
 * El negocio SIEMPRE sale de la cuenta conectada que coincide con el `user_id`,
 * nunca del cuerpo de la notificación: ML no las firma, así que creerle al
 * payload sobre de quién es el mensaje dejaría que cualquiera se lea la
 * conversación de otro negocio.
 */
async function procesarNotificacion({ topic, resource, userId }) {
  const tema = String(topic || '');
  if (!TOPICOS_POSTVENTA.includes(tema)) return { accion: 'ignorada', motivo: 'no es de posventa' };

  const cuenta = await MercadoLibreAccount.findOne({ where: { mlUserId: String(userId || '') } });
  if (!cuenta) return { accion: 'ignorada', motivo: 'no hay ninguna cuenta conectada con ese user_id' };

  try {
    const r = tema === 'messages'
      ? await procesarMensaje(cuenta, resource)
      : await procesarReclamo(cuenta);
    log.info('ml-postventa', `notificación de ${tema} procesada`, {
      businessId: cuenta.businessId, ...r,
    });
    return { ...r, businessId: cuenta.businessId };
  } catch (e) {
    /*
     * El motivo queda en la cuenta, no sólo en el log. Si a la app le falta el
     * permiso, esto falla en TODAS las notificaciones y en el log se ve como
     * ruido repetido que nadie mira; en la pantalla se ve una vez y se
     * entiende.
     */
    if (e.codigo === 'ML_SIN_PERMISO') {
      await cuenta.update({ ultimoError: e.message.slice(0, 400) }).catch(() => {});
    }
    log.warn('ml-postventa', `no se pudo procesar ${tema}`, {
      businessId: cuenta.businessId, motivo: e.message?.slice(0, 200),
    });
    return { accion: 'error', motivo: e.message };
  }
}

/**
 * El barrido: trae reclamos y los mensajes de las ventas recientes.
 *
 * Los reclamos se piden enteros porque es UNA consulta. Los mensajes no: hay
 * que preguntar conversación por conversación, así que se acota a las ventas de
 * los últimos días. Lo viejo llega por webhook o no llega, y un mensaje de una
 * venta de hace un mes no es trabajo del día.
 */
async function barrer(cuenta, { diasDeVentas = 7, topeConversaciones = 40 } = {}) {
  const desde = new Date(Date.now() - diasDeVentas * 24 * 3600 * 1000);
  const { Op } = require('sequelize');

  const resumen = { reclamos: null, conversaciones: 0, mensajesNuevos: 0 };

  resumen.reclamos = await traerReclamos(cuenta);

  const pedidos = await PedidoPlataforma.findAll({
    where: {
      businessId: cuenta.businessId,
      plataforma: 'mercadolibre',
      recibidoEn: { [Op.gte]: desde },
    },
    attributes: ['pedidoExterno'],
    order: [['recibidoEn', 'DESC']],
    limit: topeConversaciones,
  });

  for (const p of pedidos) {
    try {
      resumen.mensajesNuevos += await traerConversacion(cuenta, p.pedidoExterno);
      resumen.conversaciones += 1;
    } catch (e) {
      /*
       * Una conversación que falla no voltea el barrido. Con permisos faltantes
       * fallarían todas, y entonces sí conviene cortar: seguir intentando
       * cuarenta veces lo mismo sólo gasta llamadas contra el límite de ML.
       */
      if (e.codigo === 'ML_SIN_PERMISO') throw e;
    }
  }
  return resumen;
}

module.exports = {
  TOPICOS_POSTVENTA,
  procesarNotificacion,
  traerConversacion,
  traerReclamos,
  barrer,
  __normalizarMensaje: normalizarMensaje,
  __normalizarReclamo: normalizarReclamo,
};
