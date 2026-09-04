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

  console.log(`\nListo. Entrá a Envíos del día. Para borrarlos:`);
  console.log('  node scripts/demo-envios.cjs --limpiar');
  process.exit(0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
