/*
 * Dos pedidos a la vez sobre las mismas filas de stock.
 *
 * Existe por un cuelgue de la importación de Excel en SQL Server: se subió el
 * mismo archivo dos veces, las dos importaciones crearon la misma fila de stock
 * al mismo tiempo, y la relectura de findOrCreate —fuera de su transacción—
 * quedó esperando a la transacción que la esperaba a ella. Cada fila tardaba 15
 * segundos en fallar por timeout, mientras las lecturas de stock de todo el
 * sistema esperaban detrás.
 *
 * Se prueba lo que importa: que dos escritores sobre las mismas variantes
 * terminen enseguida y sin errores, que quede UNA fila por variante y el total
 * cierre; y que una segunda importación del mismo negocio se rechace en vez de
 * duplicar los ajustes.
 *
 * Uso:  node scripts/test-stock-concurrente.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const ExcelJS = require('exceljs');
const { Business, BusinessLocation, Product, ProductVariant, VariantStock, StockMovement } = require('../src/models');
const stock = require('../src/services/stockService');
const { importProductsXlsx } = require('../src/services/productExcelService');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

(async () => {
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  const local = await BusinessLocation.findOne({ where: { businessId: negocio.id, activo: true }, order: [['id', 'ASC']] });
  const skus = ['QA-CONC', 'QA-IMPCONC'];
  const limpiar = async () => {
    for (const p of await Product.findAll({ where: { businessId: negocio.id, sku: skus } })) {
      const ids = (await ProductVariant.findAll({ where: { productId: p.id }, attributes: ['id'] })).map((v) => v.id);
      if (ids.length) {
        await StockMovement.destroy({ where: { productVariantId: ids } });
        await VariantStock.destroy({ where: { productVariantId: ids } });
        await ProductVariant.destroy({ where: { id: ids } });
      }
      await Product.destroy({ where: { id: p.id } });
    }
  };

  try {
    await limpiar();

    tit('1. DOS ESCRITORES SOBRE LAS MISMAS VARIANTES');
    const prod = await Product.create({
      businessId: negocio.id, sku: 'QA-CONC', skuAgrupador: 'QA-CONC', titulo: 'QA concurrencia',
      precioMinorista: 1, precioMayorista: 1, costo: 1, activo: true,
    });
    const ids = [];
    for (let i = 0; i < 8; i++) {
      ids.push((await ProductVariant.create({
        productId: prod.id, businessId: negocio.id, sku: `QA-CONC-${i}`, stock: 0, stockMinimo: 1,
      })).id);
    }

    const errores = [];
    const escritor = async () => {
      for (const id of ids) {
        try {
          // Igual que la importación: leer, y si no coincide, fijar.
          if (await stock.stockEn(id, local.id) !== 5) {
            await stock.mover({ variantId: id, businessId: negocio.id, locationId: local.id, fijar: 5, tipo: 'ajuste', motivo: 'QA concurrencia' });
          }
        } catch (e) { errores.push(e.message); }
      }
    };
    const t0 = Date.now();
    await Promise.all([escritor(), escritor(), escritor()]);
    const ms = Date.now() - t0;

    chk('ninguno falló', [], errores);
    chk('terminó enseguida (antes eran 15 s por fila)', true, ms < 10000);
    chk('una sola fila de stock por variante', ids.length, await VariantStock.count({ where: { productVariantId: ids } }));
    const variantes = await ProductVariant.findAll({ where: { id: ids } });
    chk('el total de cada variante cierra', ids.map(() => 5), variantes.map((v) => Number(v.stock)));

    tit('2. UNA IMPORTACIÓN A LA VEZ POR NEGOCIO');
    const wb = new ExcelJS.Workbook();
    const hoja = wb.addWorksheet('Productos');
    hoja.addRow(['SKU Padre', 'Título', 'SKU Variante', 'Variante 1 Nombre', 'Variante 1 Valor', 'Stock']);
    for (const t of ['S', 'M', 'L']) hoja.addRow(['QA-IMPCONC', 'QA importación', `QA-IMPCONC-${t}`, 'Talle', t, 4]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const [a, b] = await Promise.allSettled([
      importProductsXlsx(negocio.id, buffer, { locationId: local.id }),
      importProductsXlsx(negocio.id, buffer, { locationId: local.id }),
    ]);
    chk('la primera se hizo', 'fulfilled', a.status);
    chk('crea sus 3 variantes', 3, a.value?.variantsCreated);
    chk('la segunda se rechazó', 'rejected', b.status);
    chk('con 409', 409, b.reason?.status);

    const pImp = await Product.findOne({ where: { businessId: negocio.id, sku: 'QA-IMPCONC' } });
    const idsImp = (await ProductVariant.findAll({ where: { productId: pImp.id }, attributes: ['id'] })).map((v) => v.id);
    chk('un ajuste por variante, no dos', 3, await StockMovement.count({ where: { productVariantId: idsImp, motivo: 'Importación de Excel' } }));

    const otra = await importProductsXlsx(negocio.id, buffer, { locationId: local.id });
    chk('terminada la primera, se puede importar de nuevo', 0, otra.variantsCreated);
  } finally {
    await limpiar();
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
