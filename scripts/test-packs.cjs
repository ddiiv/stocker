/*
 * Packs: se venden solos, descuentan lo que llevan adentro.
 *
 * Un "pack de 3 remeras" tiene su propio SKU y se publica en Mercado Libre como
 * un artículo más. Pero las tres remeras están en el estante una sola vez:
 * cuando el pack se vende salen esas tres, no una cuarta cosa llamada pack.
 *
 * Lo que se comprueba:
 *
 *   · Lo que hay de un pack es lo que alcance para armarlo, y es piso: con 2
 *     remeras y un pack de 3 hay CERO packs, no "casi uno".
 *   · Vender el pack aparta las remeras, no el pack.
 *   · Vender una remera suelta baja lo que hay de packs, sin que nadie lo
 *     recalcule: es la misma mercadería mirada de dos formas.
 *   · Al despachar, el libro registra remeras —que se cuentan en el estante—,
 *     no packs.
 *   · El picking abre el pack: quien va al estante busca tres remeras.
 *   · Un pack adentro de otro se rechaza: con un ciclo la cuenta no termina.
 *
 * Uso:  node scripts/test-packs.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const { Op } = require('sequelize');
const API = process.env.API || 'http://localhost:3000';
const {
  Business, BusinessLocation, Product, ProductVariant, VariantStock, StockMovement,
  PackComponente, PedidoPlataforma, PedidoPlataformaItem,
} = require('../src/models');
const stock = require('../src/services/stockService');
const packs = require('../src/services/packService');
const envios = require('../src/services/enviosDelDiaService');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const fallo = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

function sesion() {
  let cookie = '';
  return async (m, ruta, cuerpo) => {
    const r = await fetch(`${API}${ruta}`, {
      method: m,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
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
  const local = await BusinessLocation.findOne({
    where: { businessId: negocio.id, tipo: 'local', abasteceOnline: true, activo: true },
  });

  const limpiar = async () => {
    const p = await PedidoPlataforma.findAll({ where: { pedidoExterno: { [Op.like]: 'QA-PACK%' } } });
    await PedidoPlataformaItem.destroy({ where: { pedidoId: p.map((x) => x.id) } });
    await PedidoPlataforma.destroy({ where: { id: p.map((x) => x.id) } });
  };
  await limpiar();
  const viejas = await ProductVariant.findAll({ where: { sku: { [Op.like]: 'QA-PK-%' } } });
  await PackComponente.destroy({ where: { packVariantId: viejas.map((v) => v.id) } });
  await ProductVariant.destroy({ where: { id: viejas.map((v) => v.id) } });
  await Product.destroy({ where: { sku: { [Op.like]: 'QA-PK%' } } });

  const prod = await Product.create({
    businessId: negocio.id, sku: 'QA-PK', skuAgrupador: 'QA-PK', titulo: 'Baby Tee',
    precioMinorista: 8000, precioMayorista: 8000, costo: 3000, activo: true,
  });
  // La remera suelta: color y talle, que es lo que el pack descuenta.
  const remera = await ProductVariant.create({
    productId: prod.id, businessId: negocio.id, sku: 'QA-PK-NEG-M',
    variante1Nombre: 'Color', variante1Valor: 'Negro',
    variante2Nombre: 'Talle', variante2Valor: 'M', stock: 0, stockMinimo: 0,
  });
  const otra = await ProductVariant.create({
    productId: prod.id, businessId: negocio.id, sku: 'QA-PK-BLA-M',
    variante1Nombre: 'Color', variante1Valor: 'Blanco',
    variante2Nombre: 'Talle', variante2Valor: 'M', stock: 0, stockMinimo: 0,
  });
  // El pack: su propio SKU, publicable en ML.
  const pack = await ProductVariant.create({
    productId: prod.id, businessId: negocio.id, sku: 'QA-PK-PACK3',
    variante1Nombre: 'Pack', variante1Valor: '3 unidades', stock: 0, stockMinimo: 0,
  });

  const enEstante = (v) => stock.stockEn(v.id, local.id);
  const apartado = async (v) => {
    const f = await VariantStock.findOne({ where: { productVariantId: v.id, locationId: local.id } });
    return Number(f?.reservado) || 0;
  };
  const fijar = async (v, n) => {
    const f = await VariantStock.findOne({ where: { productVariantId: v.id, locationId: local.id } });
    const ap = Number(f?.reservado) || 0;
    if (ap > 0) await stock.liberarReserva(v.id, local.id, negocio.id, ap);
    await stock.mover({ variantId: v.id, businessId: negocio.id, locationId: local.id,
      fijar: n, tipo: 'ajuste', motivo: 'QA packs' });
  };

  const api = sesion();
  const entro = await api('POST', '/api/auth/login', { email: negocio.email, password: 'Demo2026!!' });
  if (entro.status !== 200) { console.log('No se pudo entrar:', entro.status); process.exit(1); }

  try {
    tit('1. UN PACK NO TIENE STOCK PROPIO: LO TIENE LO QUE LLEVA ADENTRO');
    await packs.definirComponentes(pack.id, negocio.id, [
      { componenteVariantId: remera.id, cantidad: 3 },
    ]);
    const recargado = await ProductVariant.findByPk(pack.id);
    chk('queda marcado como pack', true, recargado.esPack);

    await fijar(remera, 7);
    /*
     * Es piso, no redondeo: con 7 remeras y un pack de 3 hay 2 packs. Con 2
     * remeras no hay "casi un pack", hay dos remeras.
     */
    chk('con 7 remeras hay 2 packs', 2, await packs.disponibleDePack(pack.id, local.id));
    await fijar(remera, 2);
    chk('con 2 remeras hay 0 packs', 0, await packs.disponibleDePack(pack.id, local.id));
    await fijar(remera, 9);
    chk('con 9 hay 3', 3, await packs.disponibleDePack(pack.id, local.id));

    tit('2. LA MISMA MERCADERÍA MIRADA DE DOS FORMAS');
    /*
     * Vender una remera suelta baja lo que hay de packs sin que nadie
     * recalcule nada. Es el motivo por el que el pack no guarda stock propio:
     * serían dos verdades sobre las mismas nueve remeras.
     */
    await stock.mover({ variantId: remera.id, businessId: negocio.id, locationId: local.id,
      delta: -1, tipo: 'egreso', motivo: 'QA venta suelta' });
    chk('vendiendo una remera quedan 8', 8, await enEstante(remera));
    chk('y los packs bajan a 2 solos', 2, await packs.disponibleDePack(pack.id, local.id));

    tit('3. VENDER EL PACK APARTA LAS REMERAS, NO EL PACK');
    await fijar(remera, 9);
    const pudo = await packs.reservarPack(pack.id, local.id, negocio.id, 2);
    chk('se apartan 2 packs', true, pudo);
    chk('el estante de remeras NO se movió', 9, await enEstante(remera));
    chk('pero quedaron 6 remeras apartadas', 6, await apartado(remera));
    chk('el pack no tiene reserva propia', 0, await apartado(pack));
    chk('y quedan 1 pack armable con las 3 libres', 1, await packs.disponibleDePack(pack.id, local.id));

    tit('4. EL MOSTRADOR NO SE LLEVA LO APARTADO POR UN PACK');
    const err = await fallo(() => stock.mover({
      variantId: remera.id, businessId: negocio.id, locationId: local.id,
      delta: -5, tipo: 'egreso', motivo: 'QA mostrador',
    }));
    chk('vender 5 de las 9 que se ven se frena', true, Boolean(err));
    chk('diciendo que están apartadas', true, /apartadas para pedidos online/.test(err?.message || ''));
    chk('las 3 libres sí', undefined, await stock.mover({
      variantId: remera.id, businessId: negocio.id, locationId: local.id,
      delta: -3, tipo: 'egreso', motivo: 'QA mostrador',
    }).then(() => undefined));
    chk('y ahí no queda ningún pack armable', 0, await packs.disponibleDePack(pack.id, local.id));

    tit('5. TODO O NADA: UN PACK MIXTO QUE NO ALCANZA NO APARTA A MEDIAS');
    /*
     * Media reserva deja mercadería comprometida para un pack que nunca se va a
     * poder armar, y nadie la va a soltar porque no queda ningún pedido que la
     * explique.
     */
    await packs.definirComponentes(pack.id, negocio.id, [
      { componenteVariantId: remera.id, cantidad: 1 },
      { componenteVariantId: otra.id, cantidad: 2 },
    ]);
    await fijar(remera, 5);
    await fijar(otra, 1);   // no alcanza para ningún pack
    chk('no hay packs armables', 0, await packs.disponibleDePack(pack.id, local.id));

    const noPudo = await packs.reservarPack(pack.id, local.id, negocio.id, 1);
    chk('reservar devuelve false', false, noPudo);
    chk('y no quedó apartada la remera del primer componente', 0, await apartado(remera));
    chk('ni la otra', 0, await apartado(otra));

    tit('6. LA COLA DE PEDIDOS ENTIENDE EL SKU DEL PACK');
    /*
     * Es lo que pidió el caso: se publica el SKU del pack en Mercado Libre y al
     * venderse tiene que descontar las prendas.
     */
    await packs.definirComponentes(pack.id, negocio.id, [
      { componenteVariantId: remera.id, cantidad: 3 },
    ]);
    await fijar(remera, 10);
    const venta = await api('POST', '/api/online/pedidos', {
      plataforma: 'mercadolibre', pedidoExterno: 'QA-PACK-1',
      comprador: { nombre: 'Compra Pack' },
      items: [{ sku: 'QA-PK-PACK3', cantidad: 2 }],
    });
    chk('el pedido del pack entra', 201, venta.status);
    chk('y queda aceptado', 'aceptado', venta.json?.estado);
    chk('el estante de remeras sigue en 10', 10, await enEstante(remera));
    chk('con 6 apartadas por los 2 packs', 6, await apartado(remera));

    tit('7. SIN STOCK PARA ARMARLO, EL PEDIDO SE RECHAZA');
    await fijar(remera, 2);
    const sinStock = await api('POST', '/api/online/pedidos', {
      plataforma: 'mercadolibre', pedidoExterno: 'QA-PACK-2',
      comprador: { nombre: 'Sin stock' },
      items: [{ sku: 'QA-PK-PACK3', cantidad: 1 }],
    });
    chk('se rechaza con 409', 409, sinStock.status);
    chk('sin apartar nada', 0, await apartado(remera));

    tit('8. EL PICKING ABRE EL PACK');
    /*
     * Quien va al estante no busca un pack: busca tres remeras negras talle M.
     * Mostrar sólo la línea del pack lo deja dando vueltas por un artículo que
     * no está en ninguna percha.
     */
    await fijar(remera, 12);
    await api('POST', '/api/online/pedidos', {
      plataforma: 'mercadolibre', pedidoExterno: 'QA-PACK-3',
      comprador: { nombre: 'Para pickear' },
      items: [{ sku: 'QA-PK-PACK3', cantidad: 2 }],
    });
    const jornada = await envios.delDia(negocio.id, { filtro: 'todos' });
    /*
     * Un paquete puede llevar varias ventas —Mercado Libre junta compras del
     * mismo comprador en un envío— así que se busca por el número de venta
     * adentro de la caja, no comparando contra la caja.
     */
    const elPedido = jornada.paquetes.find(
      (p) => (p.ventas || []).some((v) => v.pedidoExterno === 'QA-PACK-3'),
    );
    chk('el paquete aparece', true, Boolean(elPedido));

    const linea = elPedido.items[0];
    chk('la línea dice que es un pack', true, linea.esPack);
    chk('y trae lo que hay que juntar', 'QA-PK-NEG-M', linea.componentes?.[0]?.sku);
    chk('con la cantidad YA multiplicada: 2 packs de 3 son 6', 6, linea.componentes?.[0]?.cantidad);
    chk('y dice cuántas van por pack', 3, linea.componentes?.[0]?.porPack);

    const enConsolidado = jornada.consolidado.find((l) => l.sku === 'QA-PK-NEG-M');
    chk('el recorrido lista remeras, no packs', true, Boolean(enConsolidado));
    chk('sin ninguna línea del SKU del pack', false,
      jornada.consolidado.some((l) => l.sku === 'QA-PK-PACK3'));
    chk('y dice de qué pack vienen', true, (enConsolidado?.deLosPacks || []).includes('QA-PK-PACK3'));

    tit('9. DESPACHAR REGISTRA REMERAS, NO PACKS');
    /*
     * El libro de stock tiene que hablar de mercadería que se puede contar:
     * "salieron 6 remeras negras M" se cuenta en el estante; "salió 1 pack" no
     * se cuenta en ningún lado.
     */
    const antesEstante = await enEstante(remera);
    const desp = await envios.despachar({ pedidoId: elPedido.id, businessId: negocio.id });
    chk('el despacho entra', 'despachado', desp.pedido.estadoEnvio);
    // Lo que salió del estante son prendas, no packs: 2 packs de 3 son 6.
    chk('y cuenta las prendas que salieron, no los packs', 6, desp.movidas);
    chk('el estante baja 6 remeras', antesEstante - 6, await enEstante(remera));

    const mov = await StockMovement.findOne({
      where: { productVariantId: remera.id, motivo: { [Op.like]: '%QA-PACK-3%' } },
      order: [['id', 'DESC']],
    });
    chk('el movimiento es de la remera', remera.id, mov?.productVariantId);
    chk('por 6 unidades', 6, Number(mov?.cantidad));
    chk('y el motivo nombra el pack, para poder rastrearlo', true,
      /pack QA-PK-PACK3/.test(mov?.motivo || ''));
    chk('no quedó ningún movimiento del SKU del pack', 0,
      await StockMovement.count({ where: { productVariantId: pack.id } }));

    tit('10. LO QUE NO SE PUEDE ARMAR');
    const anidado = await fallo(() => packs.definirComponentes(remera.id, negocio.id, [
      { componenteVariantId: pack.id, cantidad: 1 },
    ]));
    chk('un pack adentro de otro se rechaza', 'PACK_ANIDADO', anidado?.codigo);

    const solo = await fallo(() => packs.definirComponentes(pack.id, negocio.id, [
      { componenteVariantId: pack.id, cantidad: 1 },
    ]));
    chk('un pack que se lleva a sí mismo, también', true,
      /a sí mismo/.test(solo?.message || ''));

    const vacio = await fallo(() => packs.definirComponentes(pack.id, negocio.id, []));
    chk('un pack sin componentes se rechaza', true, /al menos un componente/.test(vacio?.message || ''));

    const repetido = await fallo(() => packs.definirComponentes(pack.id, negocio.id, [
      { componenteVariantId: remera.id, cantidad: 1 },
      { componenteVariantId: remera.id, cantidad: 2 },
    ]));
    chk('el mismo componente dos veces se rechaza', true, /dos veces/.test(repetido?.message || ''));

    const cero = await fallo(() => packs.definirComponentes(pack.id, negocio.id, [
      { componenteVariantId: remera.id, cantidad: 0 },
    ]));
    chk('una cantidad en cero se rechaza', true, /mayor a cero/.test(cero?.message || ''));

    /*
     * La defensa que importa: el id del componente viene del navegador, y sin
     * el filtro por negocio se podría armar un pack que descuenta stock ajeno.
     */
    const ajena = await ProductVariant.findOne({
      where: { businessId: { [Op.ne]: negocio.id } }, attributes: ['id'],
    });
    if (ajena) {
      const conAjena = await fallo(() => packs.definirComponentes(pack.id, negocio.id, [
        { componenteVariantId: ajena.id, cantidad: 1 },
      ]));
      chk('un componente de otro negocio se rechaza', true,
        /no existe en este negocio/.test(conAjena?.message || ''));
    }

    tit('11. QUÉ PACKS SE ROMPEN SI TOCO ESTE ARTÍCULO');
    await packs.definirComponentes(pack.id, negocio.id, [
      { componenteVariantId: remera.id, cantidad: 3 },
    ]);
    const usan = await packs.packsQueUsan(remera.id, negocio.id);
    chk('la remera avisa que un pack la usa', 'QA-PK-PACK3', usan[0]?.sku);
    chk('y cuántas lleva', 3, usan[0]?.lleva);

  } finally {
    tit('Limpieza');
    await limpiar();
    const ids = [remera.id, otra.id, pack.id];
    await PackComponente.destroy({ where: { packVariantId: ids } });
    await StockMovement.destroy({ where: { productVariantId: ids } });
    await VariantStock.destroy({ where: { productVariantId: ids } });
    await ProductVariant.destroy({ where: { id: ids } });
    await Product.destroy({ where: { id: prod.id } });
    chk('no queda nada de la prueba', 0,
      await ProductVariant.count({ where: { sku: { [Op.like]: 'QA-PK-%' } } }));
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
