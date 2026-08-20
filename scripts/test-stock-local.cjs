/*
 * Stock por local: que cada local tenga el suyo y que el total no mienta.
 *
 * Lo que se prueba no es la aritmética sino la invariante: la suma de los
 * locales tiene que ser siempre igual al total de la variante. Ese total lo
 * leen media docena de pantallas —métricas, Mercado Libre, etiquetas, el
 * buscador del punto de venta— y si se desincroniza nadie lo nota hasta que
 * alguien va a buscar mercadería que el sistema dice tener.
 *
 * Uso:  node scripts/test-stock-local.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const { db: sequelize, Business, BusinessLocation, Product, ProductVariant, VariantStock, StockMovement, Sale, SaleItem } = require('../src/models');
const stock = require('../src/services/stockService');
const { descontarStockVenta, devolverStockVenta } = require('../src/services/saleStockService');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const fallo = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

(async () => {
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  const locales = await BusinessLocation.findAll({ where: { businessId: negocio.id }, order: [['id', 'ASC']] });
  const [A, B] = locales;

  // Producto de prueba propio: no se toca el catálogo real.
  const prod = await Product.create({
    businessId: negocio.id, sku: 'QA-LOC', skuAgrupador: 'QA-LOC', titulo: 'QA Stock por local',
    precioMinorista: 100, precioMayorista: 80, costo: 50, activo: true,
  });
  const v = await ProductVariant.create({
    productId: prod.id, businessId: negocio.id, sku: 'QA-LOC-1',
    variante1Nombre: 'Color', variante1Valor: 'Rojo', stock: 0, stockMinimo: 2,
  });

  const totalDe = async () => Number((await ProductVariant.findByPk(v.id)).stock);
  const enLocal = (l) => stock.stockEn(v.id, l.id);
  const suma = async () => {
    const filas = await VariantStock.findAll({ where: { productVariantId: v.id } });
    return filas.reduce((s, f) => s + f.stock, 0);
  };

  try {
    tit('1. CADA LOCAL LLEVA EL SUYO');
    await stock.mover({ variantId: v.id, businessId: negocio.id, locationId: A.id, delta: 10, tipo: 'ingreso', motivo: 'QA' });
    await stock.mover({ variantId: v.id, businessId: negocio.id, locationId: B.id, delta: 4, tipo: 'ingreso', motivo: 'QA' });
    chk(`${A.nombre} tiene 10`, 10, await enLocal(A));
    chk(`${B.nombre} tiene 4`,   4, await enLocal(B));
    chk('el total es la suma',  14, await totalDe());

    tit('2. LA INVARIANTE SE MANTIENE');
    await stock.mover({ variantId: v.id, businessId: negocio.id, locationId: A.id, delta: -3, tipo: 'egreso', motivo: 'QA' });
    chk('tras un egreso, suma = total', await suma(), await totalDe());
    await stock.mover({ variantId: v.id, businessId: negocio.id, locationId: B.id, fijar: 20, tipo: 'ajuste', motivo: 'QA' });
    chk('tras fijar, suma = total',     await suma(), await totalDe());
    chk('el ajuste dejó el local en 20', 20, await enLocal(B));
    chk('y el otro local no se tocó',     7, await enLocal(A));

    tit('3. NO SE SACA MÁS DE LO QUE HAY EN EL LOCAL');
    chk('sacar de más falla', true,
      /no se puede sacar más/.test(await fallo(() => stock.mover({ variantId: v.id, businessId: negocio.id, locationId: A.id, delta: -999, tipo: 'egreso' })) || ''));
    chk('y no dejó el stock tocado', 7, await enLocal(A));
    chk('el total tampoco',         27, await totalDe());

    tit('4. TRANSFERENCIA');
    await stock.transferir({ variantId: v.id, businessId: negocio.id, desde: B.id, hacia: A.id, cantidad: 5, motivo: 'QA' });
    chk('sale del origen',   15, await enLocal(B));
    chk('entra en el destino', 12, await enLocal(A));
    chk('el total NO cambia',  27, await totalDe());
    chk('quedan los dos movimientos', 2,
      await StockMovement.count({ where: { productVariantId: v.id, motivo: { [require('sequelize').Op.like]: '%(sale)%' } } })
      + await StockMovement.count({ where: { productVariantId: v.id, motivo: { [require('sequelize').Op.like]: '%(entra)%' } } }));
    chk('transferir de más falla', true,
      /no se puede sacar más/.test(await fallo(() => stock.transferir({ variantId: v.id, businessId: negocio.id, desde: B.id, hacia: A.id, cantidad: 999 })) || ''));

    tit('5. LA VENTA DESCUENTA DE SU LOCAL');
    const venta = await Sale.create({
      businessId: negocio.id, locationId: B.id, numero: 'QA-V-1', tipo: 'venta', estado: 'pagado',
      fecha: new Date().toISOString().slice(0, 10), total: 100, totalCobrado: 100, condicionPago: 'contado',
      saldoPendiente: 0, stockDescontado: false,
    });
    await SaleItem.create({ saleId: venta.id, productVariantId: v.id, sku: v.sku, titulo: prod.titulo, cantidad: 3, precioUnitario: 100, subtotal: 300 });

    const t1 = await sequelize.transaction();
    await descontarStockVenta(venta, t1, { motivo: 'QA venta' });
    await t1.commit();

    chk('bajó el local de la venta', 12, await enLocal(B));
    chk('el otro local no se tocó',  12, await enLocal(A));
    chk('el total bajó 3',           24, await totalDe());

    tit('6. NO SE VENDE LO QUE ESTÁ EN OTRO LOCAL');
    // Se vacía B y se deja todo en A: la venta de B ya no puede salir.
    await stock.mover({ variantId: v.id, businessId: negocio.id, locationId: B.id, fijar: 0, tipo: 'ajuste', motivo: 'QA' });
    const venta2 = await Sale.create({
      businessId: negocio.id, locationId: B.id, numero: 'QA-V-2', tipo: 'venta', estado: 'pagado',
      fecha: new Date().toISOString().slice(0, 10), total: 100, totalCobrado: 100, condicionPago: 'contado',
      saldoPendiente: 0, stockDescontado: false,
    });
    await SaleItem.create({ saleId: venta2.id, productVariantId: v.id, sku: v.sku, titulo: prod.titulo, cantidad: 1, precioUnitario: 100, subtotal: 100 });

    const t2 = await sequelize.transaction();
    const msg = await fallo(() => descontarStockVenta(venta2, t2, {}));
    await t2.rollback();
    chk('la venta se frena', true, /No hay stock suficiente/.test(msg || ''));
    chk('y dice en qué local', true, new RegExp(B.nombre).test(msg || ''));
    /*
     * Que el mensaje mencione el total de los otros locales es lo que convierte
     * el error en algo accionable: hay mercadería, sólo que en otro lado, y lo
     * que corresponde es transferir y no reponer.
     */
    chk('y que hay en otros locales', true, /en total entre todos los locales/.test(msg || ''));

    tit('7. ANULAR DEVUELVE AL MISMO LOCAL');
    const t3 = await sequelize.transaction();
    await devolverStockVenta(venta, t3, { motivo: 'QA anulación' });
    await t3.commit();
    chk('vuelve al local de la venta', 3, await enLocal(B));
    chk('el otro sigue igual',        12, await enLocal(A));
    chk('suma = total',      await suma(), await totalDe());

    tit('8. RECÁLCULO: EL TOTAL SE AUTOCORRIGE');
    // Se ensucia el total a mano, como lo dejaría un bug viejo o una migración
    // a medias, y se comprueba que el próximo movimiento lo repara.
    await ProductVariant.update({ stock: 9999 }, { where: { id: v.id } });
    chk('el total quedó sucio', 9999, await totalDe());
    await stock.mover({ variantId: v.id, businessId: negocio.id, locationId: A.id, delta: 1, tipo: 'ingreso', motivo: 'QA' });
    chk('el movimiento siguiente lo corrige', await suma(), await totalDe());

  } finally {
    await StockMovement.destroy({ where: { productVariantId: v.id } });
    await SaleItem.destroy({ where: { productVariantId: v.id } });
    await Sale.destroy({ where: { numero: ['QA-V-1', 'QA-V-2'] } });
    await VariantStock.destroy({ where: { productVariantId: v.id } });
    await ProductVariant.destroy({ where: { id: v.id } });
    await Product.destroy({ where: { id: prod.id } });
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
