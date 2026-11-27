/*
 * Eliminar una variante es darla de BAJA, nunca borrar la fila.
 *
 * El DELETE de antes se llevaba en cascada su historial de movimientos y su
 * stock, dejaba las ventas sin ítem y un pedido online pendiente sin nada que
 * despachar ni cancelar. Con la baja la fila queda (activo = false), así que el
 * pedido se puede seguir despachando o cancelando por id.
 */
const sequelize = require('../config/database');
const { ProductVariant, VariantStock, PackComponente } = require('../models');
const stockService = require('./stockService');
const ml = require('./mercadolibreService');
const { codigoDeBaja, LARGO } = require('../utils/codigoDeBaja');
const { log } = require('../utils/logger');

const ESPERA_ML_MS = 20_000;

/** `variant` viene con su producto. Devuelve { apartadas, avisos }. */
async function darDeBaja(variant, { businessId, employeeId = null }) {
  const sku = variant.sku;
  let apartadas = 0;
  await sequelize.transaction(async (t) => {
    // Un pack activo que la lleva adentro seguiría vendiendo una prenda eliminada.
    const usos = await PackComponente.findAll({ where: { componenteVariantId: variant.id }, transaction: t });
    const pack = usos.length && await ProductVariant.findOne({ where: { id: usos.map((u) => u.packVariantId), activo: true }, transaction: t });
    if (pack) {
      throw Object.assign(new Error(`Esta variante es parte del pack ${pack.sku}. Sacala del pack (o eliminá el pack) y volvé a intentar.`), { status: 409 });
    }
    // Lo apartado para un pedido online se queda; el resto sale con su movimiento, para que ningún total lo siga contando.
    // Los packs y los productos de evento no llevan stock propio.
    if (!variant.esPack && !variant.producto.esFeria) {
      const filas = await VariantStock.findAll({ where: { productVariantId: variant.id }, transaction: t, lock: t.LOCK.UPDATE });
      for (const f of filas) {
        const reservado = Number(f.reservado) || 0;
        apartadas += reservado;
        if (Number(f.stock) !== reservado) {
          await stockService.mover({
            variantId: variant.id, businessId, locationId: f.locationId, fijar: reservado,
            tipo: 'ajuste', motivo: `Baja de la variante ${sku}`, employeeId, transaction: t, permitirNegativo: true,
          });
        }
      }
    }
    await variant.update({
      activo: false, sku: codigoDeBaja(sku, variant.id, LARGO.variante), codigoBarras: null,
      sincronizadoCon: null, sincronizadoEn: null,
    }, { transaction: t });
  });

  const avisos = [];
  if (apartadas) avisos.push(`Tenía ${apartadas} unidad(es) apartada(s) para pedidos online: el pedido sigue en Envíos del Día para despacharlo o cancelarlo.`);
  try {
    // Ya no está en Stocker, así que la sincronización no la va a tocar más: el cero se manda ahora.
    const enMl = ml.dejarEnCero(businessId, sku);
    // El proxy del front corta a los 30 s: si ML demora, se contesta igual y el cero termina solo.
    let reloj;
    const demora = new Promise((listo) => { reloj = setTimeout(listo, ESPERA_ML_MS, null); });
    const r = await Promise.race([enMl, demora]).finally(() => clearTimeout(reloj));
    if (r) avisos.push(...r);
    else {
      enMl.then((a) => log.warn('baja-variante', 'cero en ML terminado tarde', { businessId, sku, avisos: a.join(' · ').slice(0, 400) }))
        .catch((e) => log.error('baja-variante', 'no se pudo poner en cero en ML', { businessId, sku, motivo: e.message?.slice(0, 300) }));
      avisos.push('Mercado Libre está demorando: revisá en unos minutos que esta variante haya quedado en 0 (si no, pausala a mano).');
    }
  } catch (e) {
    avisos.push(`La variante se eliminó, pero no se pudo revisar Mercado Libre (${e.message}). Si está publicada, pausala a mano.`);
  }
  return { apartadas, avisos };
}

module.exports = { darDeBaja };
