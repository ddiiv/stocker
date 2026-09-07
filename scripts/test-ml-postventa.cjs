/*
 * Mensajes y reclamos de Mercado Libre.
 *
 * Lo que se comprueba:
 *
 *   · Un mensaje del comprador entra por webhook y queda SIN LEER; lo que
 *     contestó el vendedor entra leído, porque no hay nada que atender.
 *   · La misma notificación repetida —que en ML pasa seguido— no duplica nada.
 *   · La bandeja agrupa por conversación y ordena poniendo primero lo que
 *     espera respuesta.
 *   · Un reclamo trae su plazo, y el que se pasó del plazo se ve como vencido.
 *   · Sincronizar un reclamo que ya está NO pisa la nota ni el "atendido": eso
 *     es de acá, ML no lo conoce.
 *   · Los datos de otro negocio no se leen ni se tocan.
 *   · Sin el permiso de la app de ML, el error dice qué casilla tildar.
 *
 * Uso:  node scripts/test-ml-postventa.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const Module = require('module');

const ML_USER = '999000111';
let RESPUESTAS = new Map();
let FALLAR_CON = null;

/*
 * axios simulado. Se intercepta el require como en las otras pruebas de ML: la
 * alternativa es pegarle a la API de verdad, que necesita una cuenta conectada
 * y ensucia datos reales de un vendedor.
 */
const originalLoad = Module._load;
Module._load = function (pedido) {
  if (pedido === 'axios') {
    const responder = async (metodo, url) => {
      if (FALLAR_CON) {
        const e = new Error('rechazado');
        e.response = { status: FALLAR_CON, data: { message: 'forbidden' } };
        throw e;
      }
      const ruta = url.replace('https://api.mercadolibre.com', '').split('?')[0];
      if (RESPUESTAS.has(ruta)) return { data: RESPUESTAS.get(ruta) };
      const e = new Error('no encontrado');
      e.response = { status: 404, data: {} };
      throw e;
    };
    const cliente = {
      get: (url) => responder('get', url),
      post: (url) => responder('post', url),
      put: (url) => responder('put', url),
      create: () => cliente,
    };
    return cliente;
  }
  return originalLoad.apply(this, arguments);
};

const { Op } = require('sequelize');
const {
  Business, MercadoLibreAccount, MercadoLibreMensaje, MercadoLibreReclamo,
  PedidoPlataforma,
} = require('../src/models');
const postventa = require('../src/services/mercadolibrePostventaService');
const mlPedidos = require('../src/services/mercadolibrePedidosService');

const API = process.env.API || 'http://localhost:3000';

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

function sesion() {
  let cookie = '';
  return async (m, ruta, cuerpo) => {
    const r = await fetch(`${API}${ruta}`, {
      method: m,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    const set = r.headers.getSetCookie?.() || [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    let json = null; try { json = JSON.parse(await r.text()); } catch { /* no json */ }
    return { status: r.status, json };
  };
}

const mensaje = (id, de, texto, fecha) => ({
  id: String(id),
  from: { user_id: de },
  text: texto,
  message_date: { created: fecha },
});

(async () => {
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });

  const limpiar = async () => {
    await MercadoLibreMensaje.destroy({ where: { businessId: negocio.id } });
    await MercadoLibreReclamo.destroy({ where: { businessId: negocio.id } });
    const p = await PedidoPlataforma.findAll({ where: { pedidoExterno: { [Op.like]: 'QA-POST%' } } });
    await PedidoPlataforma.destroy({ where: { id: p.map((x) => x.id) } });
  };
  await limpiar();
  await MercadoLibreAccount.destroy({ where: { mlUserId: ML_USER } });

  const cuenta = await MercadoLibreAccount.create({
    businessId: negocio.id, mlUserId: ML_USER, nickname: 'QA_POSTVENTA',
    accessToken: 'T', refreshToken: 'R', tokenExpiraEn: new Date(Date.now() + 5 * 3600e3),
  });

  // Una venta, para que la conversación tenga nombre de comprador.
  await PedidoPlataforma.create({
    businessId: negocio.id, plataforma: 'mercadolibre', pedidoExterno: 'QA-POST-1',
    estado: 'aceptado', compradorNombre: 'Ana Gómez', total: 15000, recibidoEn: new Date(),
  });

  const api = sesion();
  const entro = await api('POST', '/api/auth/login', { email: negocio.email, password: 'Demo2026!!' });
  if (entro.status !== 200) { console.log('No se pudo entrar:', entro.status); process.exit(1); }

  try {
    tit('1. UN MENSAJE DEL COMPRADOR ENTRA POR WEBHOOK');
    RESPUESTAS.set('/messages/M1', { id: 'M1', resource_id: 'QA-POST-1' });
    RESPUESTAS.set(`/messages/packs/QA-POST-1/sellers/${ML_USER}`, {
      messages: [
        mensaje('M1', '555', '¿Tienen talle L?', '2026-09-04T10:00:00.000Z'),
        mensaje('M2', ML_USER, 'Sí, lo tenemos.', '2026-09-04T10:05:00.000Z'),
      ],
    });

    const r1 = await mlPedidos.procesarNotificacion({
      topic: 'messages', resource: '/messages/M1', userId: ML_USER,
    });
    chk('la notificación se atiende', 'guardada', r1.accion);
    chk('y trae la conversación entera, no el mensaje suelto', 2, r1.nuevos);

    const delComprador = await MercadoLibreMensaje.findOne({
      where: { businessId: negocio.id, mensajeIdMl: 'M1' },
    });
    chk('el del comprador queda sin leer', null, delComprador.leidoEn);
    chk('marcado como del comprador', 'comprador', delComprador.deQuien);
    const delVendedor = await MercadoLibreMensaje.findOne({
      where: { businessId: negocio.id, mensajeIdMl: 'M2' },
    });
    /*
     * Lo que escribió el vendedor nace leído: es de él, no hay nada que
     * atender. Sin esto, la bandeja marca como pendiente cada respuesta propia.
     */
    chk('lo del vendedor nace leído', true, Boolean(delVendedor.leidoEn));
    chk('y reconoce que es del vendedor', 'vendedor', delVendedor.deQuien);

    tit('2. LA MISMA NOTIFICACIÓN REPETIDA NO DUPLICA');
    const r2 = await mlPedidos.procesarNotificacion({
      topic: 'messages', resource: '/messages/M1', userId: ML_USER,
    });
    chk('no guarda ninguno nuevo', 0, r2.nuevos);
    chk('y siguen siendo dos', 2,
      await MercadoLibreMensaje.count({ where: { businessId: negocio.id } }));

    tit('3. LA BANDEJA AGRUPA POR CONVERSACIÓN');
    const bandeja = await api('GET', '/api/mercadolibre/mensajes');
    chk('responde', 200, bandeja.status);
    chk('una sola conversación', 1, bandeja.json?.conversaciones?.length);
    const conv = bandeja.json.conversaciones[0];
    chk('con los dos mensajes', 2, conv.mensajes.length);
    chk('en orden de lectura: primero el más viejo', 'M1' && '¿Tienen talle L?', conv.mensajes[0].texto);
    chk('cuenta uno sin leer', 1, conv.sinLeer);
    // El nombre sale de la venta: una bandeja de números de pedido no sirve.
    chk('y dice quién es el comprador', 'Ana Gómez', conv.comprador);
    chk('el resumen cuenta lo pendiente', 1, bandeja.json?.resumen?.mensajesSinLeer);

    tit('4. MARCAR LEÍDA LA CONVERSACIÓN');
    const leida = await api('POST', '/api/mercadolibre/mensajes/QA-POST-1/leido');
    chk('marca sólo lo del comprador', 1, leida.json?.marcados);
    const trasLeer = await api('GET', '/api/mercadolibre/mensajes?sinLeer=1');
    chk('ya no queda ninguna sin leer', 0, trasLeer.json?.conversaciones?.length);

    tit('5. LOS RECLAMOS TRAEN SU PLAZO');
    const enDosHoras = new Date(Date.now() + 2 * 3600e3).toISOString();
    const haceUnDia = new Date(Date.now() - 24 * 3600e3).toISOString();
    RESPUESTAS.set('/post-purchase/v1/claims/search', {
      data: [
        { id: 'C1', status: 'opened', stage: 'claim', type: 'mediations',
          resource: 'order', resource_id: 'QA-POST-1', reason_id: 'PDD_NOT_RECEIVED',
          date_created: haceUnDia, expiration_date: enDosHoras },
        { id: 'C2', status: 'opened', stage: 'dispute', type: 'return',
          resource: 'order', resource_id: 'QA-POST-9', reason_id: 'PNR',
          date_created: haceUnDia,
          // Ya se pasó del plazo: es el que hay que ver de lejos.
          expiration_date: haceUnDia },
      ],
    });

    const rc = await postventa.traerReclamos(cuenta);
    chk('trae los dos', 2, rc.nuevos);

    const lista = await api('GET', '/api/mercadolibre/reclamos');
    chk('responde', 200, lista.status);
    chk('el resumen cuenta los abiertos', 2, lista.json?.resumen?.abiertos);
    chk('y marca el vencido', 1, lista.json?.resumen?.vencidos);
    /*
     * El que se pasó del plazo va primero: ordenar por fecha de apertura
     * sepulta justo el que apura, y un reclamo vencido lo resuelve ML a favor
     * del comprador.
     */
    chk('el vencido va primero', 'C2', lista.json?.reclamos?.[0]?.reclamoIdMl);
    chk('el otro dice cuántas horas quedan', true,
      lista.json?.reclamos?.[1]?.horasParaVencer > 0);
    chk('y con qué venta tiene que ver', 'QA-POST-1',
      lista.json?.reclamos?.[1]?.pedidoExterno);

    tit('6. EL SEGUIMIENTO ES NUESTRO Y NO LO PISA ML');
    const cual = lista.json.reclamos.find((x) => x.reclamoIdMl === 'C1');
    const seguido = await api('PATCH', `/api/mercadolibre/reclamos/${cual.id}`, {
      atendido: true, nota: 'Hablé con el comprador, reenvío mañana.',
    });
    chk('se puede anotar el seguimiento', 200, seguido.status);

    // Sincronizar de nuevo: ML no sabe de la nota y no tiene que borrarla.
    const rc2 = await postventa.traerReclamos(cuenta);
    chk('no crea ninguno nuevo', 0, rc2.nuevos);
    const trasSync = await MercadoLibreReclamo.findOne({
      where: { businessId: negocio.id, reclamoIdMl: 'C1' },
    });
    chk('la nota sobrevive', 'Hablé con el comprador, reenvío mañana.', trasSync.nota);
    chk('y el atendido también', true, Boolean(trasSync.atendidoEn));

    // Pero el estado de ML sí se actualiza: es de ellos.
    RESPUESTAS.set('/post-purchase/v1/claims/search', {
      data: [{ id: 'C1', status: 'closed', stage: 'none', type: 'mediations',
        resource: 'order', resource_id: 'QA-POST-1',
        date_created: haceUnDia, date_closed: new Date().toISOString() }],
    });
    const rc3 = await postventa.traerReclamos(cuenta);
    chk('un cambio de estado se detecta', 1, rc3.cambiados);
    chk('y queda cerrado', 'closed',
      (await MercadoLibreReclamo.findOne({
        where: { businessId: negocio.id, reclamoIdMl: 'C1' } })).estadoMl);

    tit('7. LO DE OTRO NEGOCIO NO SE TOCA');
    const otro = await Business.findOne({ where: { id: { [Op.ne]: negocio.id } } });
    if (otro) {
      const ajeno = await MercadoLibreReclamo.create({
        businessId: otro.id, reclamoIdMl: 'C-AJENO', estadoMl: 'opened',
      });
      const noVisto = await api('GET', '/api/mercadolibre/reclamos');
      chk('no aparece en la lista', false,
        (noVisto.json?.reclamos || []).some((x) => x.reclamoIdMl === 'C-AJENO'));
      const tocar = await api('PATCH', `/api/mercadolibre/reclamos/${ajeno.id}`, { atendido: true });
      chk('y no se puede tocar', 404, tocar.status);
      chk('sigue sin atender', null,
        (await MercadoLibreReclamo.findByPk(ajeno.id)).atendidoEn);
      await ajeno.destroy();

      const mensajeAjeno = await MercadoLibreMensaje.create({
        businessId: otro.id, mensajeIdMl: 'M-AJENO', packId: 'X-1',
        deQuien: 'comprador', texto: 'privado',
      });
      const bandeja2 = await api('GET', '/api/mercadolibre/mensajes');
      chk('la conversación ajena no se lee', false,
        (bandeja2.json?.conversaciones || []).some((c) => c.packId === 'X-1'));
      // Marcar leído no puede alcanzar al de otro negocio.
      await api('POST', '/api/mercadolibre/mensajes/X-1/leido');
      chk('ni marcarse como leída', null,
        (await MercadoLibreMensaje.findByPk(mensajeAjeno.id)).leidoEn);
      await mensajeAjeno.destroy();
    }

    tit('8. SIN EL PERMISO DE LA APP, EL ERROR DICE QUÉ HACER');
    /*
     * Un 403 acá casi siempre es lo mismo: falta tildar el tópico en el panel
     * de la app de ML. "Request failed with status code 403" no le dice a nadie
     * que tiene que ir a tildar dos casillas y volver a autorizar.
     */
    FALLAR_CON = 403;
    const sinPermiso = await api('POST', '/api/mercadolibre/postventa/sincronizar');
    chk('responde 403', 403, sinPermiso.status);
    chk('y nombra los tópicos que faltan', true,
      /messages/.test(sinPermiso.json?.message || '') && /claims/.test(sinPermiso.json?.message || ''));
    chk('dice que hay que volver a autorizar', true,
      /autorizar/.test(sinPermiso.json?.message || ''));

    // Y queda anotado en la cuenta, para que la pantalla lo muestre una vez.
    const r8 = await mlPedidos.procesarNotificacion({
      topic: 'claims', resource: '/claims/C9', userId: ML_USER,
    });
    chk('la notificación no explota, se anota', 'error', r8.accion);
    chk('el motivo queda en la cuenta', true,
      /permisos/.test((await MercadoLibreAccount.findByPk(cuenta.id)).ultimoError || ''));
    FALLAR_CON = null;

    tit('9. UN TÓPICO DESCONOCIDO SIGUE DICIENDO QUÉ TILDAR');
    const otroTema = await mlPedidos.procesarNotificacion({
      topic: 'items', resource: '/items/MLA1', userId: ML_USER,
    });
    chk('se ignora', true, Boolean(otroTema.ignorado));
    chk('y el aviso ya nombra los cuatro tópicos', true,
      /messages/.test(otroTema.ignorado) && /orders_v2/.test(otroTema.ignorado));

  } finally {
    tit('Limpieza');
    await limpiar();
    await MercadoLibreAccount.destroy({ where: { mlUserId: ML_USER } });
    chk('no queda nada de la prueba', 0,
      await MercadoLibreMensaje.count({ where: { businessId: negocio.id } }));
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
