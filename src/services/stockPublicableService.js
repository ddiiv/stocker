/*
 * Qué se publica de cada variante, para cualquier canal.
 *
 * Mercado Libre y Jumpseller publican lo mismo: lo disponible en los locales
 * que abastecen las ventas online, menos el margen de seguridad, y en un pack
 * cuántos se pueden armar. Vive acá y no adentro del servicio de una
 * plataforma porque si cada canal hiciera su propia cuenta, el día que una
 * cambie —un local nuevo, otra forma de contar los packs— los dos publicarían
 * números distintos del mismo estante.
 */

const { Product, ProductVariant, VariantStock } = require('../models');
const packService = require('./packService');
const { NO_ES_FERIA } = require('../utils/feria');

/*
 * Las variantes que se pueden publicar.
 *
 * Los de feria quedan afuera: no llevan stock, así que publicar el suyo sería
 * anunciar cero unidades de algo que se vende igual, o peor, pisar la
 * publicación de su equivalente del catálogo normal.
 */
function variantesPublicables(businessId, { soloActivas = false } = {}) {
  const where = soloActivas ? { activo: true } : {};
  return ProductVariant.findAll({
    where,
    include: [{
      model: Product, as: 'producto', required: true,
      where: { businessId, activo: true, ...NO_ES_FERIA },
    }],
  });
}

/*
 * Cuánto le toca publicar a cada variante: lo disponible en los locales que
 * abastecen online, menos su margen de seguridad.
 *
 * El stock de todas las variantes sale en una sola consulta: preguntarlo de a
 * una eran tantas idas a la base como artículos publicados.
 */
async function cantidadesPublicables(businessId, locales, variantes) {
  const filasStock = await VariantStock.findAll({
    where: { businessId, locationId: locales.map((l) => l.id) },
    attributes: ['productVariantId', 'stock', 'reservado'],
  });
  const disponible = new Map();
  for (const f of filasStock) {
    /*
     * Lo DISPONIBLE, no lo que hay en el estante.
     *
     * Una unidad apartada para un pedido online sigue en el estante hasta que
     * alguien la despacha, pero no se puede volver a vender: publicarla sería
     * ofrecer dos veces la misma prenda, que es justo lo que la reserva vino a
     * evitar.
     */
    const libre = Math.max(0, (Number(f.stock) || 0) - (Number(f.reservado) || 0));
    disponible.set(f.productVariantId, (disponible.get(f.productVariantId) || 0) + libre);
  }

  /*
   * Los packs no tienen fila en `variant_stocks`: lo que hay de un pack es lo
   * que alcance para armarlo con lo que lleva adentro. Sin esto, cada pack
   * publicado saldría con stock cero y dejaría de venderse sin explicación.
   */
  const idsPacks = variantes.filter((v) => v.esPack).map((v) => v.id);
  if (idsPacks.length) {
    const armables = await packService.disponibleDePacksEnLocales(
      idsPacks, locales.map((l) => l.id), businessId,
    );
    for (const [packId, cuantos] of armables) disponible.set(packId, cuantos);
  }

  const salida = new Map();
  for (const v of variantes) {
    const margen = Math.max(0, Math.trunc(Number(v.margenMl) || 0));
    // El negativo se publica como cero: lo que quedó en -3 no tiene nada para
    // despachar, y mandarlo a ML sería pedirle que ofrezca deuda.
    const hay = Math.max(0, disponible.get(v.id) || 0);
    salida.set(v.id, { disponible: hay, margen, cantidad: Math.max(0, hay - margen) });
  }
  return salida;
}

module.exports = { variantesPublicables, cantidadesPublicables };
