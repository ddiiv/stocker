// Eliminar una variante: baja sin perder historial, con stock y con unidades apartadas. Necesita base (la descartable).
const assert = require('node:assert/strict');
const m = require('../src/models');
const stock = require('../src/services/stockService');
const { darDeBaja } = require('../src/services/bajaVarianteService');

(async () => {
  const negocio = await m.Business.findOne({ where: { email: 'demo@stocker.app' } });
  const local = await m.BusinessLocation.findOne({ where: { businessId: negocio.id, activo: true } });
  const sello = `BAJA-T${process.pid}`;
  const producto = await m.Product.create({ businessId: negocio.id, titulo: sello, sku: sello, skuAgrupador: sello, precioMinorista: 100, precioMayorista: 80 });
  const crear = () => m.ProductVariant.create({ businessId: negocio.id, productId: producto.id, sku: `${sello}-S`, variante1Nombre: 'Color', variante1Valor: 'Negro', stock: 0 });
  const v = await crear();
  await stock.mover({ variantId: v.id, businessId: negocio.id, locationId: local.id, delta: 5, tipo: 'ajuste' });
  assert.equal(await stock.reservar(v.id, local.id, negocio.id, 2), true);

  v.producto = producto;
  const r = await darDeBaja(v, { businessId: negocio.id });
  assert.equal(r.apartadas, 2);
  const queda = await m.ProductVariant.findByPk(v.id);
  assert.equal(queda.activo, false);
  assert.equal(queda.sku, `${sello}-S-BAJA${v.id}`);
  assert.equal(queda.stock, 2, 'sólo queda lo apartado');
  assert.equal(await m.StockMovement.count({ where: { productVariantId: v.id } }), 2, 'el historial se conserva y suma el de la baja');

  // El pedido pendiente se puede cancelar igual, y el SKU quedó libre.
  assert.equal(await stock.liberarReserva(v.id, local.id, negocio.id, 2), true);
  const nueva = await crear();
  assert.ok(nueva.id !== v.id);

  // Parte de un pack activo: no se deja, y no se toca nada.
  const pack = await m.ProductVariant.create({ businessId: negocio.id, productId: producto.id, sku: `${sello}-PACK`, esPack: true, stock: 0 });
  await m.PackComponente.create({ businessId: negocio.id, packVariantId: pack.id, componenteVariantId: nueva.id, cantidad: 2 });
  nueva.producto = producto;
  await assert.rejects(darDeBaja(nueva, { businessId: negocio.id }), /parte del pack/);
  assert.equal((await m.ProductVariant.findByPk(nueva.id)).activo, true);
  console.log('Pasaron: baja de variante OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
