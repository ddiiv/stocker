/*
 * Reservar al vender, consumir al despachar.
 *
 * Antes había un solo número por variante y local, y con uno solo hay que
 * elegir: o se descuenta al vender —y el inventario dice que la prenda no está
 * mientras sigue colgada esperando que la pickeen— o se descuenta al despachar
 * —y la misma unidad se vende dos veces en el rato del medio—.
 *
 * Ahora son dos. `stock` es lo que hay en el estante y es lo que tiene que
 * decir un recuento; `reservado` es lo apartado y todavía no despachado. Lo que
 * se puede comprometer es la resta de los dos.
 *
 * Uso:  node scripts/test-reservas.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const { Business, BusinessLocation, Product, ProductVariant, VariantStock, StockMovement } = require('../src/models');
const sequelize = require('../src/config/database');
const stock = require('../src/services/stockService');

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
  const local = await BusinessLocation.create({
    businessId: negocio.id, nombre: 'QA Reservas', direccion: 'QA', tipo: 'local', activo: true,
  });
  const prod = await Product.create({
    businessId: negocio.id, sku: 'QA-RSV', skuAgrupador: 'QA-RSV', titulo: 'QA Reservas',
    precioMinorista: 100, precioMayorista: 100, costo: 40, activo: true,
  });
  const v = await ProductVariant.create({
    productId: prod.id, businessId: negocio.id, sku: 'QA-RSV-1',
    variante1Nombre: 'Color', variante1Valor: 'Único', stock: 0, stockMinimo: 0,
  });

  const fila = () => VariantStock.findOne({ where: { productVariantId: v.id, locationId: local.id } });
  const estado = async () => {
    const f = await fila();
    return [Number(f?.stock) || 0, Number(f?.reservado) || 0];
  };
  const disp = () => stock.disponibleEn(v.id, local.id);

  try {
    tit('1. RESERVAR NO MUEVE MERCADERÍA');
    await stock.mover({ variantId: v.id, businessId: negocio.id, locationId: local.id,
      delta: 10, tipo: 'ingreso', motivo: 'QA reservas' });
    chk('arranca con 10 y nada apartado', [10, 0], await estado());

    chk('reservar 3 devuelve true', true,
      await stock.reservar(v.id, local.id, negocio.id, 3));
    chk('el estante sigue con 10, apartadas 3', [10, 3], await estado());
    chk('y lo vendible baja a 7', 7, await disp());

    tit('2. NO SE PUEDE APARTAR MÁS DE LO DISPONIBLE');
    chk('reservar 8 sobre 7 disponibles devuelve false', false,
      await stock.reservar(v.id, local.id, negocio.id, 8));
    chk('sin haber tocado nada', [10, 3], await estado());
    chk('reservar exactamente lo que queda sí entra', true,
      await stock.reservar(v.id, local.id, negocio.id, 7));
    chk('y ahí no queda nada vendible', [10, 10], await estado());
    chk('disponible en cero', 0, await disp());

    tit('3. EL MOSTRADOR NO SE LLEVA LO APARTADO');
    /*
     * Es el punto de todo esto: hay 10 en el estante, pero están comprometidas.
     * Una venta de mostrador tiene que frenarse aunque el estante diga 10.
     */
    const err = await fallo(() => stock.mover({
      variantId: v.id, businessId: negocio.id, locationId: local.id,
      delta: -1, tipo: 'egreso', motivo: 'QA mostrador',
    }));
    chk('la venta se frena', true, Boolean(err));
    chk('y explica que están apartadas, no que no hay', true, /apartadas para pedidos online/.test(err || ''));
    chk('sin mover el estante', [10, 10], await estado());

    await stock.liberarReserva(v.id, local.id, negocio.id, 7);
    chk('liberando 7 vuelve a haber 7 vendibles', 7, await disp());

    tit('4. LIBERAR NO INVENTA NI PIERDE MERCADERÍA');
    chk('el estante nunca se movió', 10, (await estado())[0]);
    chk('liberar más de lo apartado no hace nada', false,
      await stock.liberarReserva(v.id, local.id, negocio.id, 99));
    chk('y deja las 3 que quedaban', [10, 3], await estado());

    tit('5. CONSUMIR: LA RESERVA SE CONVIERTE EN SALIDA');
    chk('consumir 2 de las 3 apartadas', true,
      await stock.consumirReserva(v.id, local.id, negocio.id, 2));
    chk('bajan las dos cosas a la vez', [8, 1], await estado());
    chk('y el total de la variante se recalcula', 8,
      Number((await ProductVariant.findByPk(v.id)).stock));

    chk('consumir más de lo apartado no hace nada', false,
      await stock.consumirReserva(v.id, local.id, negocio.id, 5));
    chk('sin tocar nada', [8, 1], await estado());

    tit('6. UN RECUENTO NO PUEDE TAPAR UNA RESERVA');
    /*
     * Si el conteo dice 0 y hay 1 comprometida, el problema no es el número: es
     * que ese pedido no se va a poder despachar. Ajustar en silencio dejaría la
     * invariante rota y el faltante apareciendo recién en el picking.
     */
    const errFijar = await fallo(() => stock.mover({
      variantId: v.id, businessId: negocio.id, locationId: local.id,
      fijar: 0, tipo: 'ajuste', motivo: 'QA recuento',
    }));
    chk('fijar por debajo de lo apartado se rechaza', true, Boolean(errFijar));
    chk('diciendo cuántas están apartadas', true, /1 unidad\(es\) apartadas/.test(errFijar || ''));
    chk('fijar en lo apartado o más sí entra', undefined,
      await stock.mover({ variantId: v.id, businessId: negocio.id, locationId: local.id,
        fijar: 1, tipo: 'ajuste', motivo: 'QA recuento' }).then(() => undefined));
    chk('queda en 1 con 1 apartada', [1, 1], await estado());

    tit('7. DOS PEDIDOS PELEANDO LA ÚLTIMA UNIDAD');
    /*
     * La misma prueba que la cola, un nivel más abajo. Sin la resta condicionada
     * los dos leerían "queda 1" y los dos reservarían.
     */
    await stock.liberarReserva(v.id, local.id, negocio.id, 1);
    chk('queda 1 libre', [1, 0], await estado());

    const dos = await Promise.all([
      (async () => {
        const t = await sequelize.transaction();
        try { const r = await stock.reservar(v.id, local.id, negocio.id, 1, t); await t.commit(); return r; }
        catch { await t.rollback().catch(() => {}); return null; }
      })(),
      (async () => {
        const t = await sequelize.transaction();
        try { const r = await stock.reservar(v.id, local.id, negocio.id, 1, t); await t.commit(); return r; }
        catch { await t.rollback().catch(() => {}); return null; }
      })(),
    ]);
    chk('una reserva y la otra no', [true, false], dos.sort((a, b) => (a === b ? 0 : a ? -1 : 1)));
    chk('y queda exactamente 1 apartada, nunca 2', [1, 1], await estado());

    tit('8. LA INVARIANTE SE SOSTIENE');
    const f = await fila();
    chk('reservado nunca supera al stock', true, Number(f.reservado) <= Number(f.stock));
    chk('ni baja de cero', true, Number(f.reservado) >= 0);

  } finally {
    tit('Limpieza');
    await StockMovement.destroy({ where: { productVariantId: v.id } });
    await VariantStock.destroy({ where: { productVariantId: v.id } });
    await ProductVariant.destroy({ where: { id: v.id } });
    await Product.destroy({ where: { id: prod.id } });
    await BusinessLocation.destroy({ where: { id: local.id } });
    chk('no queda nada de la prueba', 0,
      await VariantStock.count({ where: { productVariantId: v.id } }));
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
