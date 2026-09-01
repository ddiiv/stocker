/*
 * Lista de espera de venta online.
 *
 * El caso que justifica todo el archivo: dos plataformas vendiendo la MISMA
 * última unidad con medio segundo de diferencia. Sin fila, las dos leen
 * "queda 1", las dos descuentan y el stock queda en −1 con dos clientes
 * esperando la misma prenda. Con fila, la segunda se encuentra con cero y se
 * rechaza — sigue siendo un problema, pero uno solo y avisado.
 *
 * Uso:  API=http://localhost:3000 node scripts/test-cola-online.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const API = process.env.API || 'http://localhost:3000';
const {
  Business, BusinessLocation, Product, ProductVariant, VariantStock,
  StockMovement, PedidoPlataforma, PedidoPlataformaItem,
} = require('../src/models');
const stock = require('../src/services/stockService');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

function sesion() {
  let cookie = '';
  return async (m, ruta, cuerpo) => {
    const r = await fetch(`${API}${ruta}`, {
      method: m, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    const set = r.headers.getSetCookie?.() || [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    let json = null; try { json = JSON.parse(await r.text()); } catch { /* no json */ }
    return { status: r.status, json };
  };
}

(async () => {
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  const locales = await BusinessLocation.findAll({
    where: { businessId: negocio.id, abasteceOnline: true, activo: true }, order: [['id', 'ASC']],
  });
  const [A, B] = locales;
  if (!A || !B) {
    console.error(`\x1b[31m✖ Hacen falta DOS locales que abastezcan lo online, y hay ${locales.length}.\x1b[0m`);
    process.exit(1);
  }

  const prod = await Product.create({
    businessId: negocio.id, sku: 'QA-COLA', skuAgrupador: 'QA-COLA', titulo: 'QA Cola online',
    precioMinorista: 1000, precioMayorista: 800, costo: 400, activo: true,
  });
  const v = await ProductVariant.create({
    productId: prod.id, businessId: negocio.id, sku: 'QA-COLA-1',
    variante1Nombre: 'Color', variante1Valor: 'Único', stock: 0, stockMinimo: 0, activo: true,
  });

  const api = sesion();
  const login = await api('POST', '/api/auth/login', { email: negocio.email, password: 'Demo2026!!' });
  if (login.status !== 200) { console.log('No se pudo entrar:', login.status); process.exit(1); }

  const fijar = async (local, n) => stock.mover({
    variantId: v.id, businessId: negocio.id, locationId: local.id,
    fijar: n, tipo: 'ajuste', motivo: 'QA cola',
  });
  const enA = () => stock.stockEn(v.id, A.id);
  const enB = () => stock.stockEn(v.id, B.id);

  const pedir = (plataforma, externo, cantidad, extra = {}) => api('POST', '/api/online/pedidos', {
    plataforma, pedidoExterno: externo,
    items: [{ sku: 'QA-COLA-1', cantidad, precioUnitario: 1000 }],
    comprador: { nombre: 'QA Comprador', documento: '20345678901', email: 'qa@test' },
    total: 1000 * cantidad, ...extra,
  });

  try {
    tit('1. EL STOCK ONLINE ES LA SUMA DE LOS LOCALES QUE ABASTECEN');
    await fijar(A, 3); await fijar(B, 2);
    const s = await stock.stockOnline(v.id, negocio.id);
    chk('suma los dos locales', 5, s.total);
    chk('y dice cuánto pone cada uno', [3, 2], s.porLocal.map((l) => l.stock));

    tit('2. UN PEDIDO NORMAL SE ACEPTA Y DESCUENTA');
    const uno = await pedir('mercadolibre', 'ML-1', 2);
    chk('responde 201', 201, uno.status);
    chk('aceptado', 'aceptado', uno.json?.estado);
    chk('sale del local que MÁS tenía', 1, await enA());
    chk('sin tocar el otro', 2, await enB());

    tit('3. SI UNO NO ALCANZA, SE COMPLETA CON EL OTRO');
    /*
     * Es lo que hace que se aproveche todo el stock: con 1 en A y 2 en B, un
     * pedido de 3 tiene que salir igual, repartido.
     */
    const tres = await pedir('jumpseller', 'JS-1', 3);
    chk('se acepta', 201, tres.status);
    chk('vacía los dos', [0, 0], [await enA(), await enB()]);

    tit('4. SIN STOCK SE RECHAZA Y SE AVISA EN EL POST');
    const sin = await pedir('mercadolibre', 'ML-2', 1);
    chk('responde 409', 409, sin.status);
    chk('rechazado', 'rechazado', sin.json?.estado);
    chk('y dice por qué', true, /Sin stock para despachar/.test(sin.json?.motivo || ''));
    chk('sin dejar el stock en negativo', [0, 0], [await enA(), await enB()]);

    tit('5. EL RECHAZO NO SE BORRA');
    /*
     * Un rechazo significa que la plataforma ya vendió algo que no teníamos.
     * Es justo el caso que hay que poder mirar al día siguiente.
     */
    const lista = await api('GET', '/api/online/pedidos?estado=rechazado');
    chk('queda en la lista', true, (lista.json || []).some((p) => p.pedidoExterno === 'ML-2'));

    tit('6. DOS PLATAFORMAS PELEANDO LA ÚLTIMA UNIDAD');
    /*
     * El caso que justifica toda la cola. Las dos piden a la vez; una se la
     * lleva y la otra se entera. Lo que NO puede pasar es que ganen las dos.
     */
    await fijar(A, 1); await fijar(B, 0);
    const [ml, js] = await Promise.all([
      pedir('mercadolibre', 'ML-3', 1),
      pedir('jumpseller', 'JS-3', 1),
    ]);
    const estados = [ml.json?.estado, js.json?.estado].sort();
    chk('una se la lleva y la otra no', ['aceptado', 'rechazado'], estados);
    chk('el stock queda en cero, nunca en negativo', 0, await enA());
    chk('y no quedó ningún negativo', 0,
      await VariantStock.count({ where: { productVariantId: v.id, stock: { [require('sequelize').Op.lt]: 0 } } }));

    tit('7. EL MISMO PEDIDO DOS VECES DESCUENTA UNA SOLA');
    /*
     * Las plataformas reintentan cuando no ven un 200 a tiempo: Jumpseller
     * hasta ocho veces en cuatro días. Sin idempotencia, cada reintento
     * descontaría de nuevo.
     */
    await fijar(A, 5); await fijar(B, 0);
    const primera = await pedir('mercadolibre', 'ML-REPE', 2);
    chk('la primera entra', 201, primera.status);
    chk('descuenta 2', 3, await enA());

    const segunda = await pedir('mercadolibre', 'ML-REPE', 2);
    chk('la segunda no vuelve a descontar', 3, await enA());
    chk('y avisa que ya lo tenía', true, segunda.json?.repetido);

    tit('8. UN SKU QUE NO EXISTE NO FRENA EL RESTO');
    /*
     * La venta ya ocurrió en la plataforma. No descontar lo que SÍ conocemos
     * haría la diferencia más grande, no más chica.
     */
    await fijar(A, 4);
    const mixto = await api('POST', '/api/online/pedidos', {
      plataforma: 'jumpseller', pedidoExterno: 'JS-MIX',
      items: [
        { sku: 'QA-COLA-1', cantidad: 1 },
        { sku: 'NO-EXISTE-EN-STOCKER', cantidad: 9 },
      ],
    });
    chk('se acepta en parte', 200, mixto.status);
    chk('marcado como parcial', 'parcial', mixto.json?.estado);
    chk('diciendo cuál quedó afuera', true, /NO-EXISTE-EN-STOCKER/.test(mixto.json?.motivo || ''));
    chk('y el conocido sí se descontó', 3, await enA());

    tit('9. LO QUE NO ES UN PEDIDO VÁLIDO SE RECHAZA');
    const sinPlataforma = await api('POST', '/api/online/pedidos', {
      plataforma: 'tiendanube', pedidoExterno: 'X', items: [{ sku: 'QA-COLA-1', cantidad: 1 }],
    });
    chk('plataforma desconocida', 400, sinPlataforma.status);

    const sinItems = await api('POST', '/api/online/pedidos', {
      plataforma: 'mercadolibre', pedidoExterno: 'X2', items: [],
    });
    chk('pedido sin artículos', 400, sinItems.status);

    const cantidadMala = await api('POST', '/api/online/pedidos', {
      plataforma: 'mercadolibre', pedidoExterno: 'X3',
      items: [{ sku: 'QA-COLA-1', cantidad: 0 }],
    });
    chk('cantidad en cero', 400, cantidadMala.status);

    tit('10. EL ORDEN DE LLEGADA MANDA');
    /*
     * "El que venda primero se lleva la venta." Con 2 unidades y tres pedidos
     * de 1, los dos primeros entran y el tercero no — sea de la plataforma que
     * sea.
     */
    await fijar(A, 2); await fijar(B, 0);
    const uno1 = await pedir('mercadolibre', 'ORD-1', 1);
    const dos2 = await pedir('jumpseller', 'ORD-2', 1);
    const tres3 = await pedir('mercadolibre', 'ORD-3', 1);
    chk('el primero entra', 'aceptado', uno1.json?.estado);
    chk('el segundo entra', 'aceptado', dos2.json?.estado);
    chk('el tercero se rechaza', 'rechazado', tres3.json?.estado);
    chk('stock en cero', 0, await enA());
  } finally {
    tit('Limpieza');
    const pedidos = await PedidoPlataforma.findAll({ where: { businessId: negocio.id }, attributes: ['id'] });
    await PedidoPlataformaItem.destroy({ where: { pedidoId: pedidos.map((p) => p.id) } });
    await PedidoPlataforma.destroy({ where: { id: pedidos.map((p) => p.id) } });
    await StockMovement.destroy({ where: { productVariantId: v.id } });
    await VariantStock.destroy({ where: { productVariantId: v.id } });
    await ProductVariant.destroy({ where: { id: v.id } });
    await Product.destroy({ where: { id: prod.id } });
    chk('no quedan pedidos de prueba', 0, await PedidoPlataforma.count({ where: { businessId: negocio.id } }));
  }

  console.log(`\n\x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
