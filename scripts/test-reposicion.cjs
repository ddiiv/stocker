/*
 * Circuito depósito → local: ingreso de mercadería y pedidos de reposición.
 *
 * Lo que se prueba no es que los endpoints respondan, sino las tres reglas de
 * negocio de las que depende que el inventario no mienta:
 *
 *   1. De un depósito no se vende, y la mercadería cruda entra sólo por ahí.
 *   2. El stock sale del depósito al despachar y entra al local al confirmar.
 *      En el medio no está en ningún lado —está arriba de una camioneta— y esa
 *      diferencia es la única forma de distinguir "nunca salió" de "se perdió".
 *   3. Nada se borra: rechazar, anular y los faltantes son estados con motivo.
 *
 * Uso:  node scripts/test-reposicion.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const {
  db: sequelize, Business, BusinessLocation, Product, ProductVariant,
  StockIngreso, StockIngresoItem, PedidoReposicion, PedidoReposicionItem,
} = require('../src/models');
const stock = require('../src/services/stockService');
const deposito = require('../src/services/depositoService');
const reposicion = require('../src/services/reposicionService');

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

  // Lugares propios: no se toca la configuración real del negocio.
  const dep = await BusinessLocation.create({
    businessId: negocio.id, nombre: 'QA Depósito', direccion: 'QA 1', tipo: 'deposito', activo: true,
  });
  const loc = await BusinessLocation.create({
    businessId: negocio.id, nombre: 'QA Local', direccion: 'QA 2', tipo: 'local', activo: true,
  });

  const prod = await Product.create({
    businessId: negocio.id, sku: 'QA-REP', skuAgrupador: 'QA-REP', titulo: 'QA Reposición',
    precioMinorista: 100, precioMayorista: 80, costo: 50, activo: true,
  });
  const v = await ProductVariant.create({
    productId: prod.id, businessId: negocio.id, sku: 'QA-REP-1',
    variante1Nombre: 'Color', variante1Valor: 'Rojo', stock: 0, stockMinimo: 0,
  });
  const v2 = await ProductVariant.create({
    productId: prod.id, businessId: negocio.id, sku: 'QA-REP-2',
    variante1Nombre: 'Color', variante1Valor: 'Azul', stock: 0, stockMinimo: 0,
  });

  const enDep = () => stock.stockEn(v.id, dep.id);
  const enLoc = () => stock.stockEn(v.id, loc.id);

  try {
    // ── 1 ──────────────────────────────────────────────────────────
    tit('1. DEPÓSITO Y LOCAL SON COSAS DISTINTAS');
    chk('el depósito figura como depósito', true,
      (await deposito.depositos(negocio.id)).some((d) => d.id === dep.id));
    chk('y no aparece entre los locales de venta', false,
      (await deposito.locales(negocio.id)).some((l) => l.id === dep.id));
    chk('exigirDeposito acepta un depósito', true,
      Boolean(await deposito.exigirDeposito(dep.id, negocio.id)));
    chk('y rechaza un local de venta',
      `"QA Local" es un local de venta, no un depósito. La mercadería nueva entra por un depósito y de ahí se transfiere.`,
      await fallo(() => deposito.exigirDeposito(loc.id, negocio.id)));

    // ── 2 ──────────────────────────────────────────────────────────
    tit('2. PLAN A — INGRESO CON ETIQUETAS: EL STOCK SUBE EN EL ACTO');
    const t1 = await sequelize.transaction();
    const { ingreso: iA } = await deposito.registrarIngreso({
      businessId: negocio.id, locationId: dep.id, origen: 'etiquetas',
      items: [{ productVariantId: v.id, cantidad: 20 }], transaction: t1,
    });
    await t1.commit();
    chk('queda aplicado sin pasar por nadie', 'aplicado', iA.estado);
    chk('el stock está en el depósito', 20, await enDep());
    chk('el número sigue el formato del resto', true, /^ING-\d{4}-\d{2}-\d{5}$/.test(iA.numero));

    tit('3. ANULAR UN INGRESO DEVUELVE EL DEPÓSITO A COMO ESTABA');
    chk('sin motivo no se anula',
      'Poné el motivo de la anulación: es lo que explica el movimiento en el historial.',
      await fallo(async () => {
        const t = await sequelize.transaction();
        try { await deposito.anularIngreso({ ingresoId: iA.id, businessId: negocio.id, motivo: '  ', transaction: t }); }
        finally { await t.rollback().catch(() => {}); }
      }));

    const t2 = await sequelize.transaction();
    await deposito.anularIngreso({ ingresoId: iA.id, businessId: negocio.id, motivo: 'Se contó mal', transaction: t2 });
    await t2.commit();
    chk('el stock vuelve a cero', 0, await enDep());
    chk('y no se puede anular dos veces',
      'Sólo se puede anular un ingreso aplicado. Este está anulado.',
      await fallo(async () => {
        const t = await sequelize.transaction();
        try { await deposito.anularIngreso({ ingresoId: iA.id, businessId: negocio.id, motivo: 'otra vez', transaction: t }); }
        finally { await t.rollback().catch(() => {}); }
      }));

    tit('4. NO SE ANULA LO QUE YA SE MOVIÓ');
    const t3 = await sequelize.transaction();
    const { ingreso: iB } = await deposito.registrarIngreso({
      businessId: negocio.id, locationId: dep.id, origen: 'etiquetas',
      items: [{ productVariantId: v.id, cantidad: 10 }], transaction: t3,
    });
    await t3.commit();
    // Se saca la mitad por otro camino, como si ya hubiera viajado.
    await stock.mover({ variantId: v.id, businessId: negocio.id, locationId: dep.id, delta: -6, tipo: 'egreso', motivo: 'QA' });
    const msg = await fallo(async () => {
      const t = await sequelize.transaction();
      try { await deposito.anularIngreso({ ingresoId: iB.id, businessId: negocio.id, motivo: 'tarde', transaction: t }); }
      finally { await t.rollback().catch(() => {}); }
    });
    chk('avisa que parte ya salió, con los números', true,
      /ya salió del depósito/.test(msg) && /entraron 10 y quedan 4/.test(msg));
    chk('y no dejó el depósito en negativo', 4, await enDep());

    tit('5. PLAN B — CONTEO SIN ETIQUETAS: ESPERA FIRMA');
    const t4 = await sequelize.transaction();
    const { ingreso: iC } = await deposito.registrarIngreso({
      businessId: negocio.id, locationId: dep.id, origen: 'conteo',
      items: [{ productVariantId: v.id, cantidad: 6 }], transaction: t4,
    });
    await t4.commit();
    chk('queda pendiente', 'pendiente', iC.estado);
    chk('y el stock NO subió', 4, await enDep());

    const t5 = await sequelize.transaction();
    await deposito.aceptarIngreso({ ingresoId: iC.id, businessId: negocio.id, transaction: t5 });
    await t5.commit();
    chk('al aceptar, recién ahí sube', 10, await enDep());

    tit('6. RECHAZAR UN CONTEO NO MUEVE NADA Y GUARDA EL PORQUÉ');
    const t6 = await sequelize.transaction();
    const { ingreso: iD } = await deposito.registrarIngreso({
      businessId: negocio.id, locationId: dep.id, origen: 'conteo',
      items: [{ productVariantId: v.id, cantidad: 99 }], transaction: t6,
    });
    await t6.commit();
    chk('sin motivo no se rechaza',
      'Poné el motivo del rechazo: quien contó necesita saber qué corregir.',
      await fallo(async () => {
        const t = await sequelize.transaction();
        try { await deposito.rechazarIngreso({ ingresoId: iD.id, businessId: negocio.id, motivo: '', transaction: t }); }
        finally { await t.rollback().catch(() => {}); }
      }));
    const t7 = await sequelize.transaction();
    const rechazado = await deposito.rechazarIngreso({
      ingresoId: iD.id, businessId: negocio.id, motivo: 'Ese modelo no llegó', transaction: t7,
    });
    await t7.commit();
    chk('queda rechazado con su motivo', ['rechazado', 'Ese modelo no llegó'], [rechazado.estado, rechazado.motivo]);
    chk('el stock no se tocó', 10, await enDep());
    chk('el documento sigue existiendo', true,
      Boolean(await StockIngreso.findByPk(iD.id)));

    // ── PEDIDOS ────────────────────────────────────────────────────
    tit('7. PEDIDO DE REPOSICIÓN: EL CIRCUITO COMPLETO');
    const t8 = await sequelize.transaction();
    const pedido = await reposicion.crearPedido({
      businessId: negocio.id, locationId: loc.id, depositoId: dep.id,
      items: [{ productVariantId: v.id, cantidad: 8 }], notas: 'QA', transaction: t8,
    });
    await t8.commit();
    chk('nace pendiente', 'pendiente', pedido.estado);

    chk('no se despacha sin aprobar', 'Este pedido todavía no está aprobado por oficina.',
      await fallo(async () => {
        const t = await sequelize.transaction();
        try { await reposicion.despachar({ pedidoId: pedido.id, businessId: negocio.id, envios: [], transaction: t }); }
        finally { await t.rollback().catch(() => {}); }
      }));
    chk('ni se rechaza sin motivo', 'Poné el motivo del rechazo: el local necesita saber por qué no se le manda.',
      await fallo(async () => {
        const t = await sequelize.transaction();
        try { await reposicion.rechazar({ pedidoId: pedido.id, businessId: negocio.id, motivo: '', transaction: t }); }
        finally { await t.rollback().catch(() => {}); }
      }));

    const t9 = await sequelize.transaction();
    await reposicion.aprobar({ pedidoId: pedido.id, businessId: negocio.id, transaction: t9 });
    await t9.commit();

    const items = await PedidoReposicionItem.findAll({ where: { pedidoId: pedido.id } });
    const item = items[0];

    chk('no se manda más de lo pedido', true,
      /se pidieron 8 y estás enviando 40/.test(await fallo(async () => {
        const t = await sequelize.transaction();
        try {
          await reposicion.despachar({
            pedidoId: pedido.id, businessId: negocio.id,
            envios: [{ itemId: item.id, cantidad: 40 }], transaction: t,
          });
        } finally { await t.rollback().catch(() => {}); }
      })));

    tit('8. EL STOCK SALE AL DESPACHAR Y NO ANTES');
    const antesDep = await enDep(), antesLoc = await enLoc();
    const t10 = await sequelize.transaction();
    await reposicion.despachar({
      pedidoId: pedido.id, businessId: negocio.id,
      envios: [{ itemId: item.id, cantidad: 5 }], transaction: t10,
    });
    await t10.commit();
    chk('el depósito descontó lo despachado', antesDep - 5, await enDep());
    chk('el local todavía no sumó nada', antesLoc, await enLoc());

    const transito = await reposicion.enTransito(negocio.id, { locationId: loc.id });
    chk('y las unidades figuran en tránsito', 5,
      transito.filter((x) => x.productVariantId === v.id).reduce((s, x) => s + x.cantidad, 0));

    tit('9. RECEPCIÓN PARCIAL: EL FALTANTE QUEDA A LA VISTA');
    chk('no se recibe más de lo que salió', true,
      /salieron 5 del depósito y estás recibiendo 9/.test(await fallo(async () => {
        const t = await sequelize.transaction();
        try {
          await reposicion.recibir({
            pedidoId: pedido.id, businessId: negocio.id,
            recepciones: [{ itemId: item.id, cantidad: 9 }], transaction: t,
          });
        } finally { await t.rollback().catch(() => {}); }
      })));

    const t11 = await sequelize.transaction();
    const { pedido: cerrado, faltan } = await reposicion.recibir({
      pedidoId: pedido.id, businessId: negocio.id,
      recepciones: [{ itemId: item.id, cantidad: 4, notaFaltante: 'Caja abierta' }],
      nota: 'Falta una', transaction: t11,
    });
    await t11.commit();
    chk('el pedido cierra como parcial', ['recibido_parcial', true], [cerrado.estado, faltan]);
    chk('el local sumó sólo lo que llegó', antesLoc + 4, await enLoc());

    const cierre = await PedidoReposicionItem.findByPk(item.id);
    chk('quedan las tres cantidades', [8, 5, 4],
      [cierre.cantidadPedida, cierre.cantidadEnviada, cierre.cantidadRecibida]);
    chk('y la nota del faltante', 'Caja abierta', cierre.notaFaltante);
    chk('ya no queda nada en tránsito', 0,
      (await reposicion.enTransito(negocio.id, { locationId: loc.id }))
        .filter((x) => x.productVariantId === v.id).length);

    tit('10. LA UNIDAD PERDIDA NO SE TAPA CON UN AJUSTE');
    // Salió 5 del depósito y entraron 4 al local: la diferencia es la pérdida
    // real en tránsito y tiene que seguir siendo visible.
    chk('la suma de los dos lugares refleja la pérdida', antesDep + antesLoc - 1,
      (await enDep()) + (await enLoc()));

    tit('11. UN DEPÓSITO NO PIDE REPOSICIÓN');
    chk('el pedido con destino depósito se rechaza',
      'Un depósito no pide reposición: la mercadería nueva le entra directo.',
      await fallo(async () => {
        const t = await sequelize.transaction();
        try {
          await reposicion.crearPedido({
            businessId: negocio.id, locationId: dep.id, depositoId: dep.id,
            items: [{ productVariantId: v.id, cantidad: 1 }], transaction: t,
          });
        } finally { await t.rollback().catch(() => {}); }
      }));

    tit('12. LAS LÍNEAS REPETIDAS SE SUMAN, NO SE DUPLICAN');
    const t12 = await sequelize.transaction();
    const lineas = await deposito.armarItems(
      [{ productVariantId: v2.id, cantidad: 3 }, { productVariantId: v2.id, cantidad: 4 }],
      negocio.id, t12,
    );
    await t12.rollback();
    chk('dos veces la misma variante dan una línea de 7', [1, 7], [lineas.length, lineas[0].cantidad]);

    chk('una cantidad en cero se rechaza', 'Cada línea necesita una cantidad entera mayor a cero.',
      await fallo(() => deposito.armarItems([{ productVariantId: v.id, cantidad: 0 }], negocio.id)));
    chk('una variante de otro negocio se rechaza', true,
      /no pertenecen a este negocio/.test(await fallo(() =>
        deposito.armarItems([{ productVariantId: 999999, cantidad: 1 }], negocio.id))));

    tit('13. LA INVARIANTE DE STOCK SIGUE EN PIE');
    await v.reload();
    const filas = await require('../src/models').VariantStock.findAll({ where: { productVariantId: v.id } });
    chk('el total es la suma de los locales', v.stock, filas.reduce((s, f) => s + f.stock, 0));
    chk('y ningún local quedó en negativo', false, filas.some((f) => f.stock < 0));
    tit('14. DESPACHAR LO QUE ESTÁ EN EL ESTANTE PERO NO CARGADO');
    /*
     * El caso real del depósito: la mercadería está, el ingreso nunca se cargó.
     * Antes frenaba el despacho y obligaba a salir de la pantalla, ir a
     * Depósito, cargar el ingreso, volver y empezar de nuevo. Ahora se pregunta
     * y, confirmado, entra al depósito y de ahí sale al local — que es el
     * recorrido que la mercadería hizo de verdad.
     */
    const pedidoAlta = await reposicion.crearPedido({
      businessId: negocio.id, locationId: loc.id, depositoId: dep.id,
      items: [{ productVariantId: v2.id, cantidad: 6 }],
    });
    const itemAlta = (await PedidoReposicionItem.findAll({ where: { pedidoId: pedidoAlta.id } }))[0];
    await pedidoAlta.update({ estado: 'aprobado' });

    // El depósito no tiene nada declarado de v2.
    const enDep2 = () => stock.stockEn(v2.id, dep.id);
    const enLoc2 = () => stock.stockEn(v2.id, loc.id);
    chk('el depósito arranca sin stock declarado', 0, await enDep2());

    // Sin confirmar: se frena y se dice qué falta.
    let elError = null;
    {
      const t = await sequelize.transaction();
      try {
        await reposicion.despachar({
          pedidoId: pedidoAlta.id, businessId: negocio.id,
          envios: [{ itemId: itemAlta.id, cantidad: 6 }], transaction: t,
        });
      } catch (e) { elError = e; } finally { await t.rollback().catch(() => {}); }
    }
    chk('sin confirmar, no despacha', true, Boolean(elError));
    chk('con su código', 'SIN_STOCK_DEPOSITO', elError?.detalles?.codigo);
    chk('y ofrece confirmar', true, elError?.detalles?.puedeConfirmar);
    chk('diciendo cuánto falta', [6, 0], [
      elError?.detalles?.faltantes?.[0]?.falta,
      elError?.detalles?.faltantes?.[0]?.hay,
    ]);
    chk('sin haber movido nada', [0, 0], [await enDep2(), await enLoc2()]);

    // Confirmando: entra al depósito y sale al local en la misma operación.
    const tAlta = await sequelize.transaction();
    const despacho = await reposicion.despachar({
      pedidoId: pedidoAlta.id, businessId: negocio.id,
      envios: [{ itemId: itemAlta.id, cantidad: 6 }],
      confirmarAltaStock: true, transaction: tAlta,
    });
    await tAlta.commit();

    chk('confirmando, despacha', 'enviado', despacho.pedido.estado);
    chk('y avisa cuánto se dio de alta', 6, despacho.altaStock?.[0]?.agregadas);
    /*
     * El depósito vuelve a cero: entró lo que faltaba y salió lo despachado.
     * Que quede en cero y no en 6 es lo que prueba que las dos patas ocurrieron
     * —el alta y el egreso— y no sólo una.
     */
    chk('el depósito queda en cero: entró y salió', 0, await enDep2());
    chk('el local todavía no sumó: está en tránsito', 0, await enLoc2());

    const movs = await require('../src/models').StockMovement.findAll({
      where: { productVariantId: v2.id, locationId: dep.id },
      order: [['id', 'ASC']],
    });
    const ultimos = movs.slice(-2);
    chk('quedan las dos patas registradas', ['ingreso', 'egreso'], ultimos.map((m) => m.tipo));
    chk('el alta dice que la declaró una persona', true,
      /Alta declarada en depósito/.test(ultimos[0]?.motivo || ''));

    /*
     * Lo que NO se puede: inventar inventario desde afuera. La cantidad a dar
     * de alta la calcula el servicio con lo que hay, no la manda el navegador.
     */
    const pedidoTruco = await reposicion.crearPedido({
      businessId: negocio.id, locationId: loc.id, depositoId: dep.id,
      items: [{ productVariantId: v2.id, cantidad: 2 }],
    });
    const itemTruco = (await PedidoReposicionItem.findAll({ where: { pedidoId: pedidoTruco.id } }))[0];
    await pedidoTruco.update({ estado: 'aprobado' });
    const tTruco = await sequelize.transaction();
    await reposicion.despachar({
      pedidoId: pedidoTruco.id, businessId: negocio.id,
      // Se manda un faltante inflado a propósito: tiene que ignorarse.
      envios: [{ itemId: itemTruco.id, cantidad: 2, falta: 9999 }],
      faltantes: [{ productVariantId: v2.id, falta: 9999 }],
      confirmarAltaStock: true, transaction: tTruco,
    });
    await tTruco.commit();
    chk('un faltante inflado desde afuera no da de alta de más', 0, await enDep2());

  } finally {
    // Limpieza: todo lo de QA se va, pase lo que pase con los tests.
    const ingresos = await StockIngreso.findAll({ where: { locationId: dep.id } });
    await StockIngresoItem.destroy({ where: { ingresoId: ingresos.map((i) => i.id) } });
    await StockIngreso.destroy({ where: { id: ingresos.map((i) => i.id) } });
    const pedidos = await PedidoReposicion.findAll({ where: { depositoId: dep.id } });
    await PedidoReposicionItem.destroy({ where: { pedidoId: pedidos.map((p) => p.id) } });
    await PedidoReposicion.destroy({ where: { id: pedidos.map((p) => p.id) } });
    await require('../src/models').StockMovement.destroy({ where: { productVariantId: [v.id, v2.id] } });
    await require('../src/models').VariantStock.destroy({ where: { productVariantId: [v.id, v2.id] } });
    await ProductVariant.destroy({ where: { id: [v.id, v2.id] } });
    await prod.destroy();
    await dep.destroy();
    await loc.destroy();
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m`);
  console.log(`  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
