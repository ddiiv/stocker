const { SaleItem, ProductVariant } = require('../models');
const stockService = require('./stockService');

/*
 * Salida de mercadería de una venta.
 *
 * Antes esto vivía suelto dentro del controlador y se disparaba cuando la
 * venta pasaba a "pagado". Con las ventas fiadas cobrar y entregar dejaron de
 * ser el mismo momento: el cliente puede llevarse la ropa hoy y pagar la
 * semana que viene, o dejarla señada y retirarla al pagar. Por eso ahora la
 * verdad la lleva `sale.stockDescontado` y no el estado de la venta.
 *
 * La función es idempotente: si el stock ya salió, no hace nada. Es lo que
 * evita que cobrar una venta fiada descuente por segunda vez lo mismo.
 */

/**
 * Descuenta el stock de la venta si todavía no salió.
 * @returns {boolean} true si esta llamada fue la que lo descontó.
 */
async function descontarStockVenta(sale, t, { employeeId = null, motivo = null } = {}) {
  if (sale.stockDescontado) return false;

  const items = sale.items?.length
    ? sale.items
    : await SaleItem.findAll({ where: { saleId: sale.id }, transaction: t });

  /*
   * El stock sale del local donde se hizo la venta.
   *
   * Antes se descontaba del total de la variante, que era el único que había.
   * Ahora la mercadería está en algún lado: vender en Palermo tiene que bajar
   * el stock de Palermo, no el del depósito. Sin local en la venta —ventas
   * viejas, o un negocio de un solo punto— cae al local principal.
   */
  const local = sale.locationId || await stockService.localPorDefecto(sale.businessId, t);

  for (const item of items) {
    if (!item.productVariantId) continue;

    // Con la fila bloqueada: dos cajas cobrando la última unidad a la vez no
    // pueden leer las dos el mismo stock y venderla dos veces.
    const variant = await ProductVariant.findByPk(item.productVariantId, {
      transaction: t, lock: t.LOCK.UPDATE,
    });
    if (!variant) continue;

    /*
     * Se comprueba contra el stock DEL LOCAL, no contra el total.
     *
     * Es el punto de todo el cambio: que el total alcance no significa que la
     * prenda esté en este local. Vender lo que está en la otra sucursal deja el
     * stock de acá en negativo y a un cliente esperando algo que no está.
     */
    const disponible = await stockService.stockEn(variant.id, local, t);
    if (disponible < item.cantidad) {
      const nombreLocal = local ? await nombreDeLocal(local, t) : 'este local';
      throw Object.assign(
        new Error(
          `No hay stock suficiente de ${item.titulo} (${item.sku}) en ${nombreLocal}: ` +
          `quedan ${disponible} y la venta ${sale.numero} pide ${item.cantidad}. ` +
          `Hay ${Number(variant.stock) || 0} en total entre todos los locales: ` +
          `transferilo desde Stock o ajustá la venta.`
        ),
        { status: 409, detalles: { codigo: 'SIN_STOCK' } }
      );
    }

    await stockService.mover({
      variantId: variant.id,
      businessId: sale.businessId,
      locationId: local,
      delta: -item.cantidad,
      tipo: 'egreso',
      motivo: motivo || `Venta ${sale.numero}`,
      employeeId,
      saleItemId: item.id,
      transaction: t,
    });
  }

  await sale.update({ stockDescontado: true }, { transaction: t });
  return true;
}

/**
 * Devuelve al inventario la mercadería de una venta anulada.
 * Igual de idempotente: si el stock nunca salió, no entra nada.
 */
async function devolverStockVenta(sale, t, { employeeId = null, motivo = null } = {}) {
  if (!sale.stockDescontado) return false;

  const items = sale.items?.length
    ? sale.items
    : await SaleItem.findAll({ where: { saleId: sale.id }, transaction: t });

  // Vuelve al mismo local del que salió: es donde el cliente devuelve la prenda.
  const local = sale.locationId || await stockService.localPorDefecto(sale.businessId, t);

  for (const item of items) {
    if (!item.productVariantId) continue;
    const variant = await ProductVariant.findByPk(item.productVariantId, { transaction: t });
    if (!variant) continue;

    await stockService.mover({
      variantId: variant.id,
      businessId: sale.businessId,
      locationId: local,
      delta: item.cantidad,
      tipo: 'ingreso',
      motivo: motivo || `Anulación venta ${sale.numero}`,
      employeeId,
      saleItemId: item.id,
      transaction: t,
    });
  }

  await sale.update({ stockDescontado: false }, { transaction: t });
  return true;
}

/*
 * El nombre del local, sólo para el mensaje de error.
 *
 * Decir "no hay stock" sin decir dónde obliga a adivinar en cuál de las
 * sucursales falta.
 */
async function nombreDeLocal(locationId, t) {
  const { BusinessLocation } = require('../models');
  const l = await BusinessLocation.findByPk(locationId, { attributes: ['nombre'], transaction: t });
  return l?.nombre || 'este local';
}

module.exports = { descontarStockVenta, devolverStockVenta };
