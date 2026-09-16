/*
 * Avisarle a las tiendas online que el stock cambió.
 *
 * Cada movimiento que toca el lugar desde el que se publica deja ese SKU
 * marcado, y unos segundos después se le manda a cada canal conectado. Vive
 * acá, y no adentro de un canal, porque la venta es una sola: si cada tienda
 * tuviera su propia cola, una venta de tres artículos dispararía dos tandas
 * distintas, cada una con su demora y su orden, y arreglar un problema en una
 * dejaría a la otra con el error viejo.
 *
 * Tres decisiones que valen la pena explicar:
 *
 * 1. NUNCA rompe la operación que lo disparó. Se llama sin await y todo error
 *    queda adentro: si una tienda no responde, la venta se hace igual. Un
 *    inventario desactualizado se arregla con la próxima pasada; una venta que
 *    no se pudo cobrar porque la API estaba caída, no.
 *
 * 2. Se agrupa con una demora corta. Una venta de cinco artículos son cinco
 *    movimientos en el mismo segundo: sin agrupar serían cinco pedidos por
 *    tienda, y las dos APIs tienen límites.
 *
 * 3. Sólo mira los SKU marcados. Sincronizar el catálogo entero después de
 *    cada venta sería pedir cientos de productos para actualizar uno.
 */

const { ProductVariant, PackComponente, MercadoLibreAccount, JumpsellerAccount } = require('../models');
const { log } = require('../utils/logger');

// El nombre de la variable es el de siempre: ya estaba puesta en los deploys.
const DEMORA_MS = Number(process.env.ML_SYNC_DEMORA_MS) || 6000;

/*
 * Un tope para la demora. Con movimientos entrando todo el tiempo —una feria,
 * una importación— cada uno reinicia la espera y la tanda no sale nunca.
 */
const MAX_ESPERA_MS = Number(process.env.AVISO_STOCK_MAX_ESPERA_MS) || 60000;

// businessId → { skus: Set, timer, desde }
const pendientes = new Map();
// businessId → la promesa del vaciado en curso.
const enCurso = new Map();

/*
 * A la lista de SKU que cambiaron se le agregan los packs que los llevan.
 *
 * Un pack no tiene stock propio: lo que se publica de él es cuántos se pueden
 * armar con lo que haya adentro. Así que vender una remera suelta cambia el
 * stock publicado del pack de tres remeras, aunque el SKU del pack no se haya
 * tocado. Sin esto, la publicación del pack se queda con el número viejo hasta
 * que alguien sincronice a mano — y mientras tanto puede vender packs que ya no
 * se pueden armar.
 *
 * Se resuelve al vaciar la tanda, y no en cada movimiento: es UNA consulta por
 * tanda en vez de una por línea de cada venta.
 */
async function conLosPacksQueLosUsan(skus, businessId) {
  if (!skus.length) return skus;
  try {
    const variantes = await ProductVariant.findAll({
      where: { businessId, sku: skus }, attributes: ['id'],
    });
    if (!variantes.length) return skus;

    const filas = await PackComponente.findAll({
      where: { businessId, componenteVariantId: variantes.map((v) => v.id) },
      attributes: ['packVariantId'],
    });
    if (!filas.length) return skus;

    const packs = await ProductVariant.findAll({
      where: { id: filas.map((f) => f.packVariantId), businessId, activo: true },
      attributes: ['sku'],
    });
    return [...new Set([...skus, ...packs.map((p) => p.sku)])];
  } catch (e) {
    /*
     * Si esto falla se sincroniza igual lo que sí se sabe. Perder la
     * actualización de un pack es malo; perder también la de la prenda que la
     * disparó, peor.
     */
    log.warn('aviso-stock', 'no se pudieron resolver los packs afectados', {
      businessId, motivo: e.message?.slice(0, 200),
    });
    return skus;
  }
}

/** Los canales que este negocio tiene conectados y con la sincronización prendida. */
async function canalesDe(businessId) {
  const ml = require('./mercadolibreService');
  const jumpseller = require('./jumpsellerService');
  const salida = [];

  if (ml.estaConfigurado()) {
    const cuenta = await MercadoLibreAccount.findOne({ where: { businessId } });
    if (cuenta && cuenta.syncActiva !== false && cuenta.refreshToken) {
      salida.push({ nombre: 'mercadolibre', sincronizar: (skus) => ml.sincronizarStock(businessId, { skus }) });
    }
  }

  const tienda = await JumpsellerAccount.findOne({ where: { businessId } });
  if (tienda && tienda.syncActiva !== false) {
    salida.push({ nombre: 'jumpseller', sincronizar: (skus) => jumpseller.sincronizarStock(businessId, { skus }) });
  }
  return salida;
}

/** El vaciado propiamente dicho. Se entra por `correrPendiente`. */
async function vaciar(businessId) {
  const entrada = pendientes.get(businessId);
  if (!entrada) return;
  pendientes.delete(businessId);

  const skus = await conLosPacksQueLosUsan([...entrada.skus], businessId);
  if (!skus.length) return;

  const canales = await canalesDe(businessId);
  for (const canal of canales) {
    /*
     * Cada tienda en su propio try: que Mercado Libre esté caído no puede
     * dejar a Jumpseller con el stock viejo, ni al revés.
     */
    try {
      const r = await canal.sincronizar(skus);
      if (r?.resumen?.actualizados || r?.resumen?.errores) {
        log.info(canal.nombre, 'sincronización automática', {
          businessId, skus: skus.length,
          actualizados: r.resumen.actualizados, errores: r.resumen.errores,
        });
      }
    } catch (e) {
      /*
       * Se avisa y se sigue. Los casos comunes —tienda desconectada, sin lugar
       * online, clave vencida— no son errores de la venta que lo disparó, y el
       * botón de sincronizar a mano sigue estando para cuando se resuelvan.
       */
      log.warn(canal.nombre, 'no se pudo sincronizar automáticamente', {
        businessId, motivo: e.message?.slice(0, 200),
      });
    }
  }
}

/*
 * Una tanda por negocio a la vez.
 *
 * Dos tandas del mismo negocio corriendo juntas leen el stock en dos momentos
 * distintos y después corren carrera al escribir: la que leyó primero puede
 * escribir última y dejar publicado el número viejo. Además le piden el
 * catálogo entero dos veces a la misma tienda. Si ya hay una corriendo, los SKU
 * nuevos esperan en la cola y se mandan cuando termine.
 */
async function correrPendiente(businessId) {
  const previo = enCurso.get(businessId);
  // El que espera vuelve a entrar al terminar: ahí la cola ya tiene lo nuevo.
  if (previo) return previo.then(() => correrPendiente(businessId));

  const corrida = vaciar(businessId)
    .catch(() => { /* cada canal ya maneja lo suyo; acá no queda nada por decir */ })
    .finally(() => { enCurso.delete(businessId); });
  enCurso.set(businessId, corrida);
  return corrida;
}

/** Marca un SKU como cambiado. No espera a nadie: agenda y vuelve. */
function marcar(businessId, sku) {
  if (!businessId || !sku) return;

  let entrada = pendientes.get(businessId);
  if (!entrada) {
    entrada = { skus: new Set(), timer: null, desde: Date.now() };
    pendientes.set(businessId, entrada);
  }
  entrada.skus.add(sku);

  // La espera se reinicia con cada movimiento, pero nunca más allá del tope.
  const espera = Math.max(0, Math.min(DEMORA_MS, entrada.desde + MAX_ESPERA_MS - Date.now()));
  clearTimeout(entrada.timer);
  entrada.timer = setTimeout(() => { correrPendiente(businessId); }, espera);
  // Que un envío pendiente no impida cerrar el proceso en un deploy.
  entrada.timer.unref?.();
}

module.exports = { marcar, correrPendiente, conLosPacksQueLosUsan, DEMORA_MS };
