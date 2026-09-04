/*
 * Pedidos de muestra para ver Envíos del Día funcionando.
 *
 * Sirve para mirar la pantalla antes de que Mercado Libre esté conectado: crea
 * unos pedidos con horario de corte, como los que va a mandar Flex, y aparta el
 * stock igual que lo haría un pedido real.
 *
 * NO es un test: escribe en el negocio demo y deja las cosas creadas para que
 * se puedan mirar. Por eso trae su propia limpieza.
 *
 *   node scripts/demo-envios.cjs            crea los pedidos
 *   node scripts/demo-envios.cjs --limpiar  los borra y suelta las reservas
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const { Op } = require('sequelize');
const {
  Business, BusinessLocation, ProductVariant, Product, VariantStock,
  PedidoPlataforma, PedidoPlataformaItem,
} = require('../src/models');
const cola = require('../src/services/colaVentasOnlineService');
const stock = require('../src/services/stockService');

const MARCA = 'DEMO-ENV-';

const enHoras = (h) => new Date(Date.now() + h * 3600 * 1000);

(async () => {
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  if (!negocio) { console.log('No está el negocio demo.'); process.exit(1); }

  const pedidos = await PedidoPlataforma.findAll({
    where: { businessId: negocio.id, pedidoExterno: { [Op.like]: `${MARCA}%` } },
  });

  /*
   * Limpiar suelta las reservas ANTES de borrar los pedidos.
   *
   * Al revés quedarían unidades apartadas para pedidos que ya no existen:
   * invisibles, sin nada que las libere, y restando del stock vendible para
   * siempre.
   */
  if (process.argv.includes('--limpiar') || pedidos.length) {
    const items = await PedidoPlataformaItem.findAll({
      where: { pedidoId: pedidos.map((p) => p.id) },
    });
    for (const p of pedidos) {
      if (p.estadoEnvio === 'despachado') continue;   // ya salió: no hay reserva
      for (const i of items.filter((x) => x.pedidoId === p.id)) {
        if (i.productVariantId && i.locationId) {
          await stock.liberarReserva(i.productVariantId, i.locationId, negocio.id, i.cantidad);
        }
      }
    }
    await PedidoPlataformaItem.destroy({ where: { pedidoId: pedidos.map((p) => p.id) } });
    await PedidoPlataforma.destroy({ where: { id: pedidos.map((p) => p.id) } });
    const { ProductVariant: PV2, PackComponente: PC2 } = require('../src/models');
    const packs = await PV2.findAll({ where: { sku: `${MARCA}PACK3` } });
    await PC2.destroy({ where: { packVariantId: packs.map((v) => v.id) } });
    await PV2.destroy({ where: { id: packs.map((v) => v.id) } });
    await require('../src/models').Product.destroy({ where: { sku: `${MARCA}PACK` } });
    console.log(`Se borraron ${pedidos.length} pedido(s) de muestra y se soltaron sus reservas.`);
    if (process.argv.includes('--limpiar')) process.exit(0);
  }

  const local = await BusinessLocation.findOne({
    where: { businessId: negocio.id, tipo: 'local', abasteceOnline: true, activo: true },
  });
  if (!local) { console.log('Ningún local abastece ventas online. Marcá uno en Empleados → Locales.'); process.exit(1); }

  /*
   * Se eligen variantes con stock de sobra: apartar mercadería de un artículo
   * que está por agotarse dejaría al mostrador sin nada para vender por culpa
   * de unos pedidos de muestra.
   */
  const conStock = await VariantStock.findAll({
    where: { businessId: negocio.id, locationId: local.id, stock: { [Op.gte]: 6 } },
    limit: 4,
  });
  if (conStock.length < 2) {
    console.log(`Hacen falta al menos 2 artículos con 6+ unidades en "${local.nombre}".`);
    process.exit(1);
  }

  const variantes = await ProductVariant.findAll({
    where: { id: conStock.map((f) => f.productVariantId) },
    include: [{ model: Product, as: 'producto', attributes: ['titulo'] }],
  });
  const sku = (i) => variantes[i % variantes.length].sku;

  const muestras = [
    { externo: `${MARCA}1`, comprador: 'Lucía Fernández', tipo: 'flex',   corte: 1.5,
      items: [{ sku: sku(0), cantidad: 2 }] },
    { externo: `${MARCA}2`, comprador: 'Martín Ojeda',    tipo: 'flex',   corte: 4,
      items: [{ sku: sku(0), cantidad: 1 }, { sku: sku(1), cantidad: 2 }] },
    { externo: `${MARCA}3`, comprador: 'Sofía Ramírez',   tipo: 'colecta', corte: 7,
      items: [{ sku: sku(1), cantidad: 1 }] },
    { externo: `${MARCA}4`, comprador: 'Diego Paz',       tipo: 'flex',   corte: 0.5,
      items: [{ sku: sku(0), cantidad: 1 }] },
  ];

  for (const m of muestras) {
    const { pedido } = await cola.encolarYProcesar({
      businessId: negocio.id,
      plataforma: 'mercadolibre',
      pedidoExterno: m.externo,
      comprador: { nombre: m.comprador },
      items: m.items,
    });
    /*
     * Los datos del envío se ponen después porque hoy no llegan con el pedido:
     * los va a traer la ingesta de Mercado Libre. Acá se simulan para poder ver
     * la pantalla con horarios de corte, que es lo que ordena la lista.
     */
    await pedido.update({
      envioId: `4300${pedido.id}`,
      envioTipo: m.tipo,
      despacharAntesDe: enHoras(m.corte),
    });
    console.log(`  ${m.externo}  ${m.tipo.padEnd(8)} corte en ${m.corte}h  ${pedido.estado}`);
  }

  /*
   * Dos cosas que sólo se entienden viéndolas: un pack, que se pide como uno y
   * se busca como tres, y un envío que junta dos ventas en la misma caja.
   */
  const conStockPack = conStock[0];
  const varPack = variantes.find((v) => v.id === conStockPack.productVariantId);
  /*
   * El pack va en SU PROPIO producto.
   *
   * Colgarlo de un producto existente rompe las dimensiones de ese producto:
   * sus variantes son Color y Talle, y una que dice "Pack / 3 unidades" hace
   * que la carga por curvas deje de encontrar el eje. Pasó: seis
   * comprobaciones de curvas en rojo, y el síntoma no señalaba al pack.
   */
  const { ProductVariant: PV, PackComponente, Product: Prod } = require('../src/models');
  const packsViejos = await PV.findAll({ where: { sku: `${MARCA}PACK3` } });
  await PackComponente.destroy({ where: { packVariantId: packsViejos.map((v) => v.id) } });
  await PV.destroy({ where: { id: packsViejos.map((v) => v.id) } });
  await Prod.destroy({ where: { sku: `${MARCA}PACK` } });

  const prodPack = await Prod.create({
    businessId: negocio.id, sku: `${MARCA}PACK`, skuAgrupador: `${MARCA}PACK`,
    titulo: 'Pack x3 (muestra)', precioMinorista: 21000, precioMayorista: 21000,
    costo: 9000, activo: true,
  });
  const pack = await PV.create({
    productId: prodPack.id, businessId: negocio.id, sku: `${MARCA}PACK3`,
    variante1Nombre: 'Pack', variante1Valor: '3 unidades', stock: 0, stockMinimo: 0,
  });
  await require('../src/services/packService').definirComponentes(pack.id, negocio.id, [
    { componenteVariantId: varPack.id, cantidad: 3 },
  ]);

  const conPack = await cola.encolarYProcesar({
    businessId: negocio.id, plataforma: 'mercadolibre', pedidoExterno: `${MARCA}5`,
    comprador: { nombre: 'Valeria Sosa' }, items: [{ sku: pack.sku, cantidad: 1 }],
  });
  await conPack.pedido.update({ envioId: '4300900', envioTipo: 'flex', despacharAntesDe: enHoras(2) });
  console.log(`  ${MARCA}5  pack     corte en 2h  ${conPack.pedido.estado}  (1 pack de 3)`);

  // Dos ventas en la MISMA caja, como las junta Mercado Libre.
  for (const [n, quien] of [['6', 'Nicolás Vera'], ['7', 'Nicolás Vera']]) {
    const r = await cola.encolarYProcesar({
      businessId: negocio.id, plataforma: 'mercadolibre', pedidoExterno: `${MARCA}${n}`,
      comprador: { nombre: quien }, items: [{ sku: sku(1), cantidad: 1 }],
    });
    await r.pedido.update({ envioId: '4300950', envioTipo: 'flex', despacharAntesDe: enHoras(3) });
    console.log(`  ${MARCA}${n}  flex     corte en 3h  ${r.pedido.estado}  (misma caja 4300950)`);
  }

  console.log(`\nListo. Entrá a Envíos del día. Para borrarlos:`);
  console.log('  node scripts/demo-envios.cjs --limpiar');
  process.exit(0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
