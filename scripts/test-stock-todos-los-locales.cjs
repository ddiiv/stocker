/*
 * El catálogo de la tienda con ?locales=todos: suma el stock de todos los
 * locales que venden, no sólo el de los que abastecen lo online. Lo usa el
 * catálogo de WhatsApp para avisar "poco stock" sólo cuando no hay en ningún
 * local. Sin el parámetro, el catálogo de la tienda queda como siempre.
 *
 * Uso:  node scripts/test-stock-todos-los-locales.cjs   (sobre el negocio demo)
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const { Business, BusinessLocation, ProductVariant, VariantStock, StockMovement } = require('../src/models');
const stock = require('../src/services/stockService');
const tienda = require('../src/services/tiendaService');
const { catalogoTienda } = require('../src/controllers/integracionesController');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};

// Lo que contesta la ruta, sin levantar el servidor.
const pedir = (businessId, query) => new Promise((listo, fallo) => {
  catalogoTienda({ integracion: { businessId }, query }, { json: listo }, fallo);
});
const publicable = (cat, sku) => cat.productos.flatMap((p) => p.variantes).find((v) => v.sku === sku)?.publicable;

(async () => {
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  if (!negocio) throw new Error('Falta el negocio demo (node scripts/seed-demo-business.js)');
  const antes = await pedir(negocio.id, {});
  const variante = antes.productos.flatMap((p) => p.variantes)[0];
  if (!variante) throw new Error('El demo no tiene variantes publicables');

  // Un local que vende pero no abastece lo online, con 1000 de esa variante.
  const local = await BusinessLocation.create({
    businessId: negocio.id, nombre: 'QA local que no abastece online', direccion: 'QA',
    tipo: 'local', abasteceOnline: false, activo: true,
  });
  try {
    await stock.mover({ variantId: variante.id, businessId: negocio.id, locationId: local.id, fijar: 1000, tipo: 'ajuste', motivo: 'QA stock de todos los locales' });
    // Lo publicable descuenta el margen de la variante (el mismo de Mercado Libre): con 1000 se nota igual.
    const margen = Math.max(0, Number((await ProductVariant.findByPk(variante.id, { attributes: ['margenMl'] }))?.margenMl) || 0);

    const online = await pedir(negocio.id, {});
    const todos = await pedir(negocio.id, { locales: 'todos' });
    chk('sin el parámetro, el catálogo de la tienda no cuenta ese local', publicable(antes, variante.sku), publicable(online, variante.sku));
    chk('con locales=todos, lo suma', true, publicable(todos, variante.sku) >= 1000 - margen && publicable(todos, variante.sku) > publicable(online, variante.sku));
    chk('el local nuevo está entre los que venden', true, (await tienda.localesQueVenden(negocio.id)).some((l) => l.id === local.id));
  } finally {
    // Sólo lo que creó esta prueba, por id exacto.
    await StockMovement.destroy({ where: { locationId: local.id } });
    await VariantStock.destroy({ where: { locationId: local.id } });
    await local.destroy();
  }

  console.log(`\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m\n`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
