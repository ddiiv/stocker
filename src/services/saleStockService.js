const { SaleItem, ProductVariant, StockMovement } = require('../models');

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

  for (const item of items) {
    if (!item.productVariantId) continue;

    // Con la fila bloqueada: dos cajas cobrando la última unidad a la vez no
    // pueden leer las dos el mismo stock y venderla dos veces.
    const variant = await ProductVariant.findByPk(item.productVariantId, {
      transaction: t, lock: t.LOCK.UPDATE,
    });
    if (!variant) continue;

    const stockAnterior = Number(variant.stock) || 0;
    if (stockAnterior < item.cantidad) {
      throw Object.assign(
        new Error(
          `No hay stock suficiente de ${item.titulo} (${item.sku}): quedan ${stockAnterior} ` +
          `y la venta ${sale.numero} pide ${item.cantidad}. Ajustá el stock o modificá la venta.`
        ),
        { status: 409 }
      );
    }

    const stockNuevo = stockAnterior - item.cantidad;
    await variant.update({ stock: stockNuevo }, { transaction: t });
    await StockMovement.create({
      productVariantId: variant.id,
      locationId: sale.locationId || null,
      employeeId,
      tipo: 'egreso',
      cantidad: item.cantidad, stockAnterior, stockNuevo,
      motivo: motivo || `Venta ${sale.numero}`,
      fechaMovimiento: new Date(),
    }, { transaction: t });
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

  for (const item of items) {
    if (!item.productVariantId) continue;
    const variant = await ProductVariant.findByPk(item.productVariantId, {
      transaction: t, lock: t.LOCK.UPDATE,
    });
    if (!variant) continue;

    const stockAnterior = Number(variant.stock) || 0;
    const stockNuevo    = stockAnterior + item.cantidad;
    await variant.update({ stock: stockNuevo }, { transaction: t });
    await StockMovement.create({
      productVariantId: variant.id,
      locationId: sale.locationId || null,
      employeeId,
      tipo: 'ingreso',
      cantidad: item.cantidad, stockAnterior, stockNuevo,
      motivo: motivo || `Anulación venta ${sale.numero}`,
      fechaMovimiento: new Date(),
    }, { transaction: t });
  }

  await sale.update({ stockDescontado: false }, { transaction: t });
  return true;
}

module.exports = { descontarStockVenta, devolverStockVenta };
