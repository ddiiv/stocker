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
  PaymentMethod, Sale, SaleItem, SalePayment,
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

  /*
   * Las ventas de mostrador que hace la prueba quedan apuntando a las variantes
   * por clave foránea: si no se borran primero, el borrado de variantes explota
   * con un error de constraint que no dice nada del pack.
   */
  const ventasHechas = [];
  const limpiar = async () => {
    const p = await PedidoPlataforma.findAll({ where: { pedidoExterno: { [Op.like]: 'QA-PACK%' } } });
    await PedidoPlataformaItem.destroy({ where: { pedidoId: p.map((x) => x.id) } });
    await PedidoPlataforma.destroy({ where: { id: p.map((x) => x.id) } });

    if (ventasHechas.length) {
      await SalePayment.destroy({ where: { saleId: ventasHechas } });
      await SaleItem.destroy({ where: { saleId: ventasHechas } });
      await Sale.destroy({ where: { id: ventasHechas } });
      ventasHechas.length = 0;
    }
  };
  await limpiar();
  const viejas = await ProductVariant.findAll({ where: { sku: { [Op.like]: 'QA-PK-%' } } });
  await PackComponente.destroy({ where: { packVariantId: viejas.map((v) => v.id) } });
  /*
   * Las ventas de una corrida anterior que se cortó por la mitad.
   *
   * Sin esto el borrado de variantes choca contra la clave foránea de
   * sale_items y la prueba muere antes de empezar, con un error de constraint
   * que no dice nada de packs. Pasó.
   */
  const itemsViejos = await SaleItem.findAll({
    where: { productVariantId: viejas.map((v) => v.id) }, attributes: ['saleId'],
  });
  const ventasViejas = [...new Set(itemsViejos.map((i) => i.saleId))];
  if (ventasViejas.length) {
    await SalePayment.destroy({ where: { saleId: ventasViejas } });
    await SaleItem.destroy({ where: { saleId: ventasViejas } });
    await Sale.destroy({ where: { id: ventasViejas } });
  }
  await StockMovement.destroy({ where: { productVariantId: viejas.map((v) => v.id) } });
  await VariantStock.destroy({ where: { productVariantId: viejas.map((v) => v.id) } });
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
  /*
   * El pack va en SU PROPIO producto: las variantes de un producto comparten
   * dimensiones —Color y Talle— y un pack no las tiene. Ver definirComponentes.
   */
  const prodPack = await Product.create({
    businessId: negocio.id, sku: 'QA-PKP', skuAgrupador: 'QA-PKP', titulo: 'Pack Baby Tee x3',
    precioMinorista: 21000, precioMayorista: 21000, costo: 9000, activo: true,
  });
  const pack = await ProductVariant.create({
    productId: prodPack.id, businessId: negocio.id, sku: 'QA-PK-PACK3',
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
    /*
     * Se usa un pack en su propio producto para probar el anidado: sobre una
     * variante con hermanas, el rechazo llegaría por mezclar dimensiones y no
     * por el anidado, y la prueba estaría midiendo otra cosa.
     */
    const prodPack2 = await Product.create({
      businessId: negocio.id, sku: 'QA-PKP2', skuAgrupador: 'QA-PKP2', titulo: 'Pack QA 2',
      precioMinorista: 1000, precioMayorista: 1000, costo: 400, activo: true,
    });
    const pack2 = await ProductVariant.create({
      productId: prodPack2.id, businessId: negocio.id, sku: 'QA-PK-PACK9',
      variante1Nombre: 'Pack', variante1Valor: '9', stock: 0, stockMinimo: 0,
    });
    const anidado = await fallo(() => packs.definirComponentes(pack2.id, negocio.id, [
      { componenteVariantId: pack.id, cantidad: 1 },
    ]));
    chk('un pack adentro de otro se rechaza', 'PACK_ANIDADO', anidado?.codigo);

    const mezclado = await fallo(() => packs.definirComponentes(remera.id, negocio.id, [
      { componenteVariantId: otra.id, cantidad: 1 },
    ]));
    chk('un pack mezclado con prendas sueltas se rechaza', 'PACK_MEZCLADO', mezclado?.codigo);
    await ProductVariant.destroy({ where: { id: pack2.id } });
    await Product.destroy({ where: { id: prodPack2.id } });

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

    tit('12. LOS ENDPOINTS, COMO LOS USA LA PANTALLA');
    /*
     * El servicio ya está probado arriba. Lo que se mira acá es la capa HTTP,
     * que es donde vive el filtro por negocio: el variantId llega del cliente y
     * sin ese filtro se podría rearmar el pack de otro negocio.
     */
    const lista = await api('GET', '/api/packs');
    chk('GET /api/packs responde 200', 200, lista.status);
    /*
     * El listado viene agrupado por producto de pack, no una fila por variante:
     * un pack sobre un producto de nueve combinaciones son nueve variantes, y
     * sueltas la pantalla es una pared de tarjetas casi idénticas.
     */
    const grupoMio = (lista.json || []).find((g) => g.productId === pack.productId);
    const mio = grupoMio?.variantes?.find((v) => v.sku === 'QA-PK-PACK3');
    chk('el pack aparece en la lista', true, !!mio);
    chk('y trae su composición', 1, mio?.componentes?.length);
    chk('con la cantidad que lleva', 3, mio?.componentes?.[0]?.cantidad);
    // La pantalla muestra el nombre, no el id: si no viene, la lista queda muda.
    chk('y el SKU del componente, no sólo el id', 'QA-PK-NEG-M', mio?.componentes?.[0]?.sku);
    /*
     * Armables tiene que salir de los componentes, no de un número guardado:
     * con 30 remeras en el local y 3 por pack, son 10.
     */
    await fijar(remera, 30);
    const conStock = await api('GET', `/api/packs/${pack.id}`);
    chk('GET /api/packs/:id calcula cuántos se arman', 10, conStock.json?.armables);

    const quienUsa = await api('GET', `/api/packs/usan/${remera.id}`);
    chk('GET /api/packs/usan/:id no cae en :variantId', 200, quienUsa.status);
    chk('y dice qué pack se rompe', 'QA-PK-PACK3', quienUsa.json?.[0]?.sku);

    // Un pack de otro negocio no se toca ni para leerlo.
    const ajenoPack = await ProductVariant.findOne({
      where: { businessId: { [Op.ne]: negocio.id } }, attributes: ['id'],
    });
    if (ajenoPack) {
      const leer = await api('GET', `/api/packs/${ajenoPack.id}`);
      chk('leer el pack de otro negocio da 404', 404, leer.status);
      const tocar = await api('PUT', `/api/packs/${ajenoPack.id}`, {
        componentes: [{ componenteVariantId: remera.id, cantidad: 1 }],
      });
      chk('y armarlo también', 404, tocar.status);
      chk('la variante ajena sigue sin ser pack', false,
        !!(await ProductVariant.findByPk(ajenoPack.id))?.esPack);
    }

    // El PUT reemplaza la composición entera, no suma.
    const rearmado = await api('PUT', `/api/packs/${pack.id}`, {
      componentes: [{ componenteVariantId: remera.id, cantidad: 2 }],
    });
    chk('PUT /api/packs/:id rearma', 200, rearmado.status);
    chk('y queda un solo componente', 1, rearmado.json?.componentes?.length);
    chk('con la cantidad nueva', 2, rearmado.json?.componentes?.[0]?.cantidad);
    chk('y el guardado ya devuelve el nombre', 'QA-PK-NEG-M', rearmado.json?.componentes?.[0]?.sku);
    chk('no quedaron filas viejas', 1,
      await PackComponente.count({ where: { packVariantId: pack.id } }));

    // Un pack sin componentes no es un pack: se rechaza antes de guardarlo.
    const sinComponentes = await api('PUT', `/api/packs/${pack.id}`, { componentes: [] });
    chk('un pack vacío se rechaza', 400, sinComponentes.status);
    chk('y la composición anterior sigue intacta', 1,
      await PackComponente.count({ where: { packVariantId: pack.id } }));

    tit('12b. VENDER EL PACK EN EL MOSTRADOR');
    /*
     * El pack se puede escanear en el POS como cualquier artículo. Si la venta
     * local no lo expandiera, intentaría descontar de la variante del pack
     * —que está siempre en cero— y terminaría dando de alta un pack fantasma
     * mientras las tres remeras siguen figurando en el estante.
     */
    await packs.definirComponentes(pack.id, negocio.id, [
      { componenteVariantId: remera.id, cantidad: 3 },
    ]);
    await fijar(remera, 10);
    await fijar(otra, 10);

    const metodo = await PaymentMethod.findOne({
      where: { businessId: negocio.id, activo: true },
    });
    const antesRemera = await enEstante(remera);

    const ventaPack = await api('POST', '/api/sales', {
      tipo: 'venta', estado: 'pagado', locationId: local.id,
      items: [{ productVariantId: pack.id, cantidad: 2 }],
      pagos: [{ paymentMethodId: metodo.id, monto: 42000 }],   // 2 packs × $21.000
    });
    if (ventaPack.status !== 201) console.log('      →', JSON.stringify(ventaPack.json));
    if (ventaPack.json?.id) ventasHechas.push(ventaPack.json.id);
    chk('la venta del pack entra', 201, ventaPack.status);
    // 2 packs × 3 remeras = 6.
    chk('salieron las remeras, no el pack', antesRemera - 6, await enEstante(remera));
    chk('el pack no movió stock propio', 0, await enEstante(pack));

    // Y el libro tiene que decir que salieron por un pack.
    const ultimo = await StockMovement.findOne({
      where: { productVariantId: remera.id },
      order: [['id', 'DESC']],
    });
    chk('el movimiento nombra el pack', true, /pack QA-PK-PACK3/.test(ultimo?.motivo || ''));

    /*
     * Anular tiene que devolver las tres remeras, no un pack.
     */
    const anulada = await api('POST', `/api/sales/${ventaPack.json.numero}/anular`, {
      motivo: 'QA packs',
    });
    if (![200, 201].includes(anulada.status)) console.log('      →', JSON.stringify(anulada.json));
    chk('se anula', true, [200, 201].includes(anulada.status));
    chk('volvieron las remeras al estante', antesRemera, await enEstante(remera));

    /*
     * Un pack y la misma remera suelta en la misma venta: entre las dos piden
     * más de lo que hay. Antes cada línea se comparaba por separado contra el
     * mismo stock y las dos parecían alcanzar.
     */
    await fijar(remera, 7);
    const mixta = await api('POST', '/api/sales', {
      tipo: 'venta', estado: 'pagado', locationId: local.id,
      items: [
        { productVariantId: pack.id, cantidad: 2 },      // 6 remeras
        { productVariantId: remera.id, cantidad: 2 },    // 2 más = 8 > 7
      ],
      pagos: [{ paymentMethodId: metodo.id, monto: 58000 }],  // 42.000 + 2 × 8.000
    });
    if (mixta.json?.id) ventasHechas.push(mixta.json.id);
    chk('pack + suelta se suman y falta stock', 409, mixta.status);
    chk('el aviso nombra el pack', true,
      /pack QA-PK-PACK3/.test(mixta.json?.message || ''));
    chk('y no se descontó nada', 7, await enEstante(remera));

    // Un pack sin composición no puede venderse a ciegas.
    await PackComponente.destroy({ where: { packVariantId: pack.id } });
    const huerfano = await api('POST', '/api/sales', {
      tipo: 'venta', estado: 'pagado', locationId: local.id,
      items: [{ productVariantId: pack.id, cantidad: 1 }],
      pagos: [{ paymentMethodId: metodo.id, monto: 21000 }],
    });
    if (huerfano.json?.id) ventasHechas.push(huerfano.json.id);
    chk('un pack sin componentes no se vende', 409, huerfano.status);
    chk('y lo dice con el SKU', true, /QA-PK-PACK3/.test(huerfano.json?.message || ''));
    await packs.definirComponentes(pack.id, negocio.id, [
      { componenteVariantId: remera.id, cantidad: 3 },
    ]);

    tit('12c. UNA VENTA QUE ENTRÓ ANTES DE QUE EL PACK EXISTIERA');
    /*
     * El caso de producción.
     *
     * Un pedido de Mercado Libre entra con el SKU de un pack que todavía no
     * está cargado —el pack se armó después, o la venta se trajo con el
     * backfill de pedidos viejos—. `productVariantId` se escribe UNA vez, al
     * entrar, así que la línea queda apuntando a nada PARA SIEMPRE, aunque el
     * SKU exista al día siguiente.
     *
     * Y no era sólo un cartel equivocado: al despachar, las líneas sin variante
     * se saltean. El paquete salía por la puerta y el inventario no bajaba una
     * sola prenda.
     */
    await packs.definirComponentes(pack.id, negocio.id, [
      { componenteVariantId: remera.id, cantidad: 3 },
    ]);
    await fijar(remera, 20);

    // Entra con un SKU que todavía no existe.
    const entradaTarde = await api('POST', '/api/online/pedidos', {
      plataforma: 'mercadolibre', pedidoExterno: 'QA-PACK-TARDE', total: 1000,
      items: [{ sku: 'QA-PK-INEXISTENTE', cantidad: 2 }],
    });
    const pedidoTarde = await PedidoPlataforma.findOne({
      where: { pedidoExterno: 'QA-PACK-TARDE' },
    });
    chk('el pedido entra parcial', 'parcial', pedidoTarde?.estado);
    chk('y la línea queda sin resolver', true,
      !(await PedidoPlataformaItem.findOne({ where: { pedidoId: pedidoTarde.id } }))
        .productVariantId);

    // Ahora sí existe: se le pone ese SKU a una variante real.
    const antesDelRescate = await apartado(remera);
    await ProductVariant.update({ sku: 'QA-PK-INEXISTENTE' }, { where: { id: pack.id } });

    /*
     * Envíos del Día tiene que dejar de mentir: el SKU existe. Y tiene que
     * distinguirlo del que de verdad no existe, porque se arreglan distinto.
     */
    await PedidoPlataforma.update(
      { envioId: 'QA-ENV-TARDE', estadoEnvio: 'pendiente' },
      { where: { id: pedidoTarde.id } },
    );
    const j1 = await envios.delDia(negocio.id, { filtro: 'todos', diasAdelante: 2 });
    const paqTarde = j1.paquetes.find(
      (q) => q.ventas.some((vt) => vt.pedidoExterno === 'QA-PACK-TARDE'),
    );
    const lineaTarde = paqTarde?.items?.[0];
    chk('ya no dice que el SKU no está en Stocker', false, lineaTarde?.sinResolver);
    chk('dice que existe pero no apartó nada', true, lineaTarde?.sinApartar);
    chk('y lo muestra como el pack que es', true, lineaTarde?.esPack);
    chk('con lo que hay que poner en la caja', 6, lineaTarde?.componentes?.[0]?.cantidad);

    // Despachar así sería sacar el paquete sin descontar nada: se corta.
    const despachoCiego = await fallo(() => envios.despachar({
      pedidoId: pedidoTarde.id, businessId: negocio.id, employeeId: null,
    }));
    chk('despachar sin apartar se rechaza', 'SIN_APARTAR', despachoCiego?.codigo);
    chk('y dice qué hacer', true, /[Rr]eprocesá/.test(despachoCiego?.message || ''));
    chk('el estante sigue intacto', 20, await enEstante(remera));

    // Reprocesar resuelve la línea y aparta de verdad.
    const rep = await api('POST', `/api/online/pedidos/${pedidoTarde.id}/reprocesar`);
    chk('reprocesar responde', 200, rep.status);
    chk('no queda ninguna línea sin resolver', 0, rep.json?.sinResolver);
    chk('el pedido pasa a aceptado', 'aceptado', rep.json?.estado);
    // 2 packs × 3 remeras = 6 apartadas.
    chk('ahora sí apartó la mercadería', antesDelRescate + 6, await apartado(remera));

    // Reprocesar dos veces no aparta el doble.
    await api('POST', `/api/online/pedidos/${pedidoTarde.id}/reprocesar`);
    chk('reprocesar de nuevo no aparta el doble', antesDelRescate + 6, await apartado(remera));

    // Y ahora el despacho sí mueve las prendas.
    const despTarde = await envios.despachar({
      pedidoId: pedidoTarde.id, businessId: negocio.id, employeeId: null,
    });
    chk('el despacho mueve 6 prendas', 6, despTarde.movidas);
    chk('y el estante baja', 14, await enEstante(remera));

    await ProductVariant.update({ sku: 'QA-PK-PACK3' }, { where: { id: pack.id } });

    tit('12d. SÓLO CUENTAN LOS PACKS ENTEROS');
    /*
     * La regla, dicha con números: con 3 unidades por pack, 2 unidades dan 0
     * packs y 8 dan 2. Lo que sobra no es medio pack, es nada.
     *
     * Se comprueba contra el ENDPOINT y no sólo contra el servicio: el número
     * que se cuestionó es el que se ve en pantalla, y entre el servicio y la
     * pantalla hay un controlador que suma por local.
     */
    await packs.definirComponentes(pack.id, negocio.id, [
      { componenteVariantId: remera.id, cantidad: 3 },
    ]);
    const armablesDe = async (unidades) => {
      await fijar(remera, unidades);
      const r = await api('GET', '/api/packs');
      const grupo = (r.json || []).find((g) => g.productId === pack.productId);
      return grupo?.variantes?.find((v) => v.sku === 'QA-PK-PACK3');
    };

    chk('con 0 unidades no se arma ninguno', 0, (await armablesDe(0))?.armables);
    chk('con 2 unidades tampoco: sobra, no alcanza', 0, (await armablesDe(2))?.armables);
    chk('con 3 unidades, uno justo', 1, (await armablesDe(3))?.armables);
    chk('con 5 unidades, uno y sobran 2', 1, (await armablesDe(5))?.armables);
    chk('con 8 unidades, dos y sobran 2', 2, (await armablesDe(8))?.armables);
    chk('con 9 unidades, tres justos', 3, (await armablesDe(9))?.armables);

    /*
     * Y el stock del componente viaja al lado del número, para que la cuenta se
     * pueda comprobar sin ir a Stock a contar: es lo que hacía que "se arman 5"
     * fuera indistinguible de un error.
     */
    const con10 = await armablesDe(10);
    chk('con 10 unidades, tres', 3, con10?.armables);
    chk('y dice cuántas unidades hay detrás de ese número', 10,
      con10?.componentes?.[0]?.disponible);
    chk('con el desglose por local', 10,
      con10?.componentes?.[0]?.disponiblePorLocal?.[0]?.unidades);

    /*
     * Lo apartado no cuenta: una unidad comprometida para otro pedido no se
     * puede usar para armar un pack. Con 10 y 2 apartadas quedan 8 → 2 packs.
     */
    await stock.reservar(remera.id, local.id, negocio.id, 2);
    const conReserva = await api('GET', '/api/packs');
    const grupoReserva = (conReserva.json || []).find((g) => g.productId === pack.productId);
    const filaReserva = grupoReserva?.variantes?.find((v) => v.sku === 'QA-PK-PACK3');
    chk('lo apartado no cuenta para armar', 2, filaReserva?.armables);
    chk('y el disponible lo refleja', 8, filaReserva?.componentes?.[0]?.disponible);
    await stock.liberarReserva(remera.id, local.id, negocio.id, 2);

    tit('12e. LO PUBLICADO ES LO QUE LA VENTA PUEDE APARTAR, LOCAL POR LOCAL');
    /*
     * El bug: lo que se publica en Mercado Libre juntaba el stock de cada
     * prenda entre locales y recién ahí dividía. 2 remeras en un local y 1 en
     * otro daban "1 Pack x3" publicado — pero la venta aparta el pack ENTERO
     * en un local, así que entraba y se rechazaba por falta de stock.
     *
     * No alcanza con que el número dé bien: se compara contra lo que
     * `repartirPackOnline` —la venta— puede apartar de verdad. Si esos dos no
     * coinciden, se vuelve a publicar algo que no se puede vender.
     */
    const otroLocal = await BusinessLocation.create({
      businessId: negocio.id, nombre: 'QA Packs segundo local', direccion: 'QA',
      tipo: 'local', abasteceOnline: true, activo: true,
    });
    try {
      const publicado = async () => (await packs.disponibleDePacksEnLocales(
        [pack.id], [local.id, otroLocal.id], negocio.id,
      )).get(pack.id);
      const enOtro = async (n) => {
        await stock.mover({ variantId: remera.id, businessId: negocio.id, locationId: otroLocal.id,
          fijar: n, tipo: 'ajuste', motivo: 'QA packs segundo local' });
      };

      // 2 + 1: juntas son 3, pero en ningún local se arma un pack de 3.
      await fijar(remera, 2);
      await enOtro(1);
      chk('2 en un local y 1 en otro: no se publica ningún pack', 0, await publicado());
      chk('y la venta tampoco podría apartar uno', false,
        (await packs.repartirPackOnline(pack.id, negocio.id, 1)).alcanza);

      // 3 + 1: uno entero en el primer local; la que sobra en el otro no suma.
      await fijar(remera, 3);
      chk('3 en un local y 1 en otro: se publica uno', 1, await publicado());
      chk('y la venta puede apartar ése', true,
        (await packs.repartirPackOnline(pack.id, negocio.id, 1)).alcanza);

      // 3 + 3: uno entero en cada local, sumados.
      await enOtro(3);
      chk('3 y 3: se publican dos, uno por local', 2, await publicado());
      const dos = await packs.repartirPackOnline(pack.id, negocio.id, 2);
      chk('la venta puede apartar los dos', true, dos.alcanza);
      chk('uno de cada local', 2, dos.reparto.length);

      /*
       * La invariante, dicha directo: pedir uno más de lo publicado no
       * alcanza. Si alcanzara, se estaría publicando de menos; si lo publicado
       * no alcanzara, de más — que es el caso que rechazaba ventas.
       */
      chk('uno más de lo publicado ya no alcanza', false,
        (await packs.repartirPackOnline(pack.id, negocio.id, (await publicado()) + 1)).alcanza);
    } finally {
      await StockMovement.destroy({ where: { productVariantId: remera.id, locationId: otroLocal.id } });
      await VariantStock.destroy({ where: { productVariantId: remera.id, locationId: otroLocal.id } });
      await otroLocal.destroy();
      await fijar(remera, 10);
    }

    tit('13. ARMAR EL PACK DESDE EL PRODUCTO PADRE');
    /*
     * Un pack no es un artículo suelto: es el mismo producto vendido de a N.
     * Se elige el producto y salen tantos packs como combinaciones tenga, cada
     * uno con los atributos de la suya. Todo en una transacción: partido en
     * pasos, un fallo a mitad dejaría el producto con la mitad de los packs y
     * desde el listado no habría forma de saber cuáles faltan.
     */
    const previa = await api('GET',
      `/api/packs/sugerencia?productId=${prod.id}&unidades=3&sku=QAPACK3`);
    chk('la previa responde', 200, previa.status);
    // El producto de la prueba tiene dos variantes: la remera y la otra.
    chk('proyecta un pack por cada variante del padre', 2, previa.json?.variantes?.length);
    /*
     * El precio es una sugerencia: lo que vale el producto por las unidades.
     * La remera vale 8000, tres son 24000.
     */
    chk('sugiere el precio por unidad × unidades', 24000, previa.json?.precioMinorista);
    chk('y dice de dónde sale', 8000, previa.json?.padre?.precioMinorista);
    // El SKU sale de la regla del negocio, la misma de los productos normales.
    chk('los SKU cuelgan del SKU del pack', true,
      (previa.json?.variantes || []).every((v) => v.sku.startsWith('QAPACK3')));
    chk('y cada uno dice de qué variante sale', true,
      (previa.json?.variantes || []).every((v) => v.skuPadre?.startsWith('QA-PK-')));

    const alta = await api('POST', '/api/packs', {
      productId: prod.id, sku: 'QAPACK3', unidades: 3, precioMinorista: 21000,
    });
    if (alta.status !== 201) console.log('      →', JSON.stringify(alta.json));
    chk('POST /api/packs crea el pack entero', 201, alta.status);
    chk('una variante de pack por cada variante del padre', 2, alta.json?.variantes?.length);

    const packProductId = alta.json?.productId;
    const nacidas = await ProductVariant.findAll({ where: { productId: packProductId } });
    chk('todas nacen marcadas como pack', true, nacidas.every((v) => v.esPack));
    chk('sin stock propio', true, nacidas.every((v) => Number(v.stock) === 0));
    /*
     * Los atributos se copian del padre: el pack de la negra M es el pack de la
     * negra M, no un "pack" sin color ni talle.
     */
    chk('con los atributos de su variante', true,
      nacidas.every((v) => v.variante1Nombre === 'Color' && v.variante1Valor));
    chk('cada una con su composición', 2,
      await PackComponente.count({ where: { packVariantId: nacidas.map((v) => v.id) } }));
    chk('y lleva las unidades pedidas', true,
      (await PackComponente.findAll({ where: { packVariantId: nacidas.map((v) => v.id) } }))
        .every((c) => Number(c.cantidad) === 3));

    // El producto del pack toma como sku y skuAgrupador el que se escribió.
    const packProd = await Product.findByPk(packProductId);
    chk('el sku del producto es el del pack', 'QAPACK3', packProd?.sku);
    chk('y el agrupador también', 'QAPACK3', packProd?.skuAgrupador);
    chk('el precio es el que se escribió, no el sugerido', 21000, Number(packProd?.precioMinorista));

    tit('14. EL PACK NO ES UN PRODUCTO DEL CATÁLOGO');
    /*
     * Es el punto que más se malentiende: el pack existe para vender de a N, no
     * para figurar entre las prendas. Si apareciera en el catálogo, cada remera
     * estaría dos veces —suelta y en pack— con una columna de stock en cero que
     * no significa nada.
     */
    const catalogo = await api('GET', '/api/products?search=QAPACK3&limit=50');
    chk('no aparece en el catálogo', 0, (catalogo.json?.data || []).length);
    const porLocal = await api('GET', '/api/stock/por-local/productos');
    chk('ni en el stock por local', false,
      (porLocal.json?.data || porLocal.json || []).some?.((p) => p.sku === 'QAPACK3') || false);

    // Y no se le puede cargar stock por ningún camino: `mover` lo corta.
    const packConStock = await fallo(() => stock.mover({
      variantId: nacidas[0].id, businessId: negocio.id, locationId: local.id,
      delta: 5, tipo: 'ingreso', motivo: 'QA packs',
    }));
    chk('no se le puede cargar stock propio', 'PACK_SIN_STOCK_PROPIO', packConStock?.codigo);
    chk('y lo explica', true, /no lleva stock propio/.test(packConStock?.message || ''));

    const ajuste = await api('PATCH', `/api/products/variants/${nacidas[0].id}/stock`, {
      locationId: local.id, tipo: 'ingreso', cantidad: 5, motivo: 'QA packs',
    });
    chk('el ajuste manual también se corta', 409, ajuste.status);

    tit('15. LAS VARIANTES QUE EL PADRE GANA DESPUÉS');
    /*
     * Se agrega un color y el pack se queda sin él: no hay ningún error, ese
     * color simplemente no se puede vender de a tres y nadie se entera.
     */
    const nueva = await ProductVariant.create({
      productId: prod.id, businessId: negocio.id, sku: 'QA-PK-VER-M',
      variante1Nombre: 'Color', variante1Valor: 'Verde',
      variante2Nombre: 'Talle', variante2Valor: 'M', stock: 0, stockMinimo: 0,
    });
    const listado = await api('GET', '/api/packs');
    const grupo = (listado.json || []).find((g) => g.sku === 'QAPACK3');
    chk('el listado agrupa por producto de pack', true, !!grupo);
    chk('y avisa cuántas variantes quedaron sin pack', 1, grupo?.faltanVariantes);
    chk('dice de qué producto sale', prod.id, grupo?.padre?.productId);
    chk('y cuántas unidades lleva', 3, grupo?.unidades);

    const completado = await api('POST', `/api/packs/${packProductId}/completar`);
    chk('se generan las que faltaban', 200, completado.status);
    chk('una sola', 1, completado.json?.creadas?.length);
    chk('ahora no falta ninguna', 0,
      ((await api('GET', '/api/packs')).json || [])
        .find((g) => g.sku === 'QAPACK3')?.faltanVariantes);
    // Repetirlo no duplica nada.
    const otraVez = await api('POST', `/api/packs/${packProductId}/completar`);
    chk('repetirlo no crea de más', 0, otraVez.json?.creadas?.length);

    tit('16. DAR DE BAJA EL PACK');
    /*
     * Se desactiva, no se borra: las ventas que ya se hicieron lo nombran. Y
     * sigue marcado como pack, porque sacarle la marca lo convertiría en un
     * artículo común con stock cero —justo lo que un pack no es—.
     */
    const baja = await api('DELETE', `/api/packs/producto/${packProductId}`);
    chk('DELETE /api/packs/producto/:id da de baja', 200, baja.status);
    const tras = await ProductVariant.findAll({ where: { productId: packProductId } });
    chk('quedan inactivas', true, tras.every((v) => !v.activo));
    chk('pero siguen marcadas como pack', true, tras.every((v) => v.esPack));
    chk('sin composición', 0,
      await PackComponente.count({ where: { packVariantId: tras.map((v) => v.id) } }));
    chk('y desaparecen del listado', undefined,
      ((await api('GET', '/api/packs')).json || []).find((g) => g.sku === 'QAPACK3'));
    chk('tampoco entran al catálogo al quedar inactivas', 0,
      ((await api('GET', '/api/products?search=QAPACK3&limit=50')).json?.data || []).length);

    tit('17. RECHAZOS DEL ALTA');
    const skuTomado = await api('POST', '/api/packs', {
      productId: prod.id, sku: 'QAPACK3', unidades: 3,
    });
    chk('un SKU repetido da 409, no un 500', 409, skuTomado.status);

    const productosAntes = await Product.count({ where: { businessId: negocio.id } });
    const sinUnidades = await api('POST', '/api/packs', {
      productId: prod.id, sku: 'QAPACK-X', unidades: 0,
    });
    chk('sin unidades se rechaza', 400, sinUnidades.status);
    chk('y no queda ningún producto huérfano', productosAntes,
      await Product.count({ where: { businessId: negocio.id } }));

    const ajenoProd = await Product.findOne({
      where: { businessId: { [Op.ne]: negocio.id } }, attributes: ['id'],
    });
    if (ajenoProd) {
      const deOtro = await api('POST', '/api/packs', {
        productId: ajenoProd.id, sku: 'QAPACK-AJENO', unidades: 2,
      });
      chk('un producto de otro negocio da 404', 404, deOtro.status);
    }

    // El buscador no ofrece packs cuando se le pide que no.
    await ProductVariant.update({ activo: true }, { where: { productId: packProductId } });
    await Product.update({ activo: true }, { where: { id: packProductId } });
    const busca = await api('GET', '/api/products/buscar-variantes?q=QAPACK3&limit=40&sinPacks=1');
    chk('el buscador con sinPacks no devuelve packs', true,
      (busca.json?.data || []).every((v) => !v.esPack));
    const buscaTodo = await api('GET', '/api/products/buscar-variantes?q=QAPACK3&limit=40');
    chk('y sin el filtro sí los trae, marcados', true,
      (buscaTodo.json?.data || []).some((v) => v.esPack === true));

    await ProductVariant.destroy({ where: { productId: packProductId } });
    await Product.destroy({ where: { id: packProductId } });
    await ProductVariant.destroy({ where: { id: nueva.id } });

    const desarmado = await api('DELETE', `/api/packs/${pack.id}`);
    chk('DELETE /api/packs/:id da de baja esa combinación', 200, desarmado.status);
    chk('queda inactiva', false, !!(await ProductVariant.findByPk(pack.id))?.activo);
    /*
     * Sigue marcada como pack a propósito. Sacarle la marca la convertiría en
     * un artículo común con stock cero —que es justo lo que un pack no es— y
     * reaparecería en el catálogo y en las cuentas de inventario.
     */
    chk('pero sigue marcada como pack', true, !!(await ProductVariant.findByPk(pack.id))?.esPack);
    chk('y no le quedan componentes', 0,
      await PackComponente.count({ where: { packVariantId: pack.id } }));

    tit('14. COMBOS: PRODUCTOS DISTINTOS, UNO POR TALLE EN COMÚN');
    {
      const limpiarCombos = async () => {
        const vs = await ProductVariant.findAll({ where: { businessId: negocio.id, sku: { [Op.like]: 'QA-CB%' } } });
        const ids = vs.map((v) => v.id);
        if (ids.length) {
          await PackComponente.destroy({ where: { [Op.or]: [{ packVariantId: ids }, { componenteVariantId: ids }] } });
          await StockMovement.destroy({ where: { productVariantId: ids } });
          await VariantStock.destroy({ where: { productVariantId: ids } });
          await ProductVariant.destroy({ where: { id: ids } });
        }
        await Product.destroy({ where: { businessId: negocio.id, sku: { [Op.like]: 'QA-CB%' } } });
      };
      await limpiarCombos();
      const producto = (sku, titulo, precio) => Product.create({
        businessId: negocio.id, sku, skuAgrupador: sku, titulo,
        precioMinorista: precio, precioMayorista: precio, costo: precio / 2, activo: true,
      });
      const variante = (prod, sku, pares) => ProductVariant.create({
        productId: prod.id, businessId: negocio.id, sku, stock: 0, stockMinimo: 0,
        variante1Nombre: pares[0]?.[0] || null, variante1Valor: pares[0]?.[1] || null,
        variante2Nombre: pares[1]?.[0] || null, variante2Valor: pares[1]?.[1] || null,
      });
      try {
        const rem = await producto('QA-CB-REM', 'Remera QA', 8000);
        const remV = {};
        for (const c of ['Negro', 'Blanco']) {
          for (const tl of ['L', 'S', 'M']) {
            remV[`${c}-${tl}`] = await variante(rem, `QA-CB-REM-${c.slice(0, 3)}-${tl}`, [['Color', c], ['Talle', tl]]);
          }
        }
        const pan = await producto('QA-CB-PAN', 'Pantalón QA', 12000);
        const panV = {};
        for (const tl of ['XL', 'M', 'L']) {
          panV[tl] = await variante(pan, `QA-CB-PAN-${tl}`, [['Color', 'Negro'], ['Talle', tl]]);
        }
        const jean = await producto('QA-CB-JEAN', 'Jean QA', 15000);
        for (const tl of ['38', '40']) await variante(jean, `QA-CB-JEAN-${tl}`, [['Talle', tl]]);
        const gorra = await producto('QA-CB-GOR', 'Gorra QA', 5000);
        const gorraV = await variante(gorra, 'QA-CB-GOR-ROJ', [['Color', 'Rojo']]);

        const negro = { Color: 'Negro' };
        const sug = (piezas, extra = {}) => api('POST', '/api/packs/combo/sugerencia', { piezas, ...extra });

        const uno = await sug([{ productId: rem.id }]);
        chk('un combo de un solo producto se rechaza', 400, uno.status);
        const dosVeces = await sug([{ productId: rem.id }, { productId: rem.id }]);
        chk('el mismo producto dos veces se rechaza', 400, dosVeces.status);

        const sinColor = await sug([{ productId: rem.id }, { productId: pan.id }]);
        chk('sin elegir el color de la remera, pide elegirlo', true,
          /Elegí Color de Remera QA/.test(sinColor.json?.piezas?.[0]?.problema || ''));
        chk('y no inventa combos', 0, sinColor.json?.variantes?.length);
        chk('ofrece los colores de la remera', ['Blanco', 'Negro'], sinColor.json?.piezas?.[0]?.ejes?.Color);
        chk('y sus talles ordenados como en la góndola', ['S', 'M', 'L'], sinColor.json?.piezas?.[0]?.talles);

        const violeta = await sug([{ productId: rem.id, fijos: { Color: 'Violeta' } }, { productId: pan.id }]);
        chk('un color que la prenda no tiene se avisa', true,
          /no tiene Color Violeta/.test(violeta.json?.piezas?.[0]?.problema || ''));

        const conj = await sug([{ productId: rem.id, fijos: negro }, { productId: pan.id }], { sku: 'QA-CB-CONJ' });
        chk('sugerencia: 200', 200, conj.status);
        chk('salen sólo los talles en común, en orden', ['M', 'L'], (conj.json?.variantes || []).map((v) => v.talle));
        chk('y avisa qué talles quedan afuera', true,
          (conj.json?.avisos || []).some((a) => /S, XL/.test(a)));
        const filaM = (conj.json?.variantes || []).find((v) => v.talle === 'M');
        chk('el combo M lleva la remera negra M y el pantalón M',
          [remV['Negro-M'].id, panV.M.id].sort(), (filaM?.componentes || []).map((c) => c.componenteVariantId).sort());
        chk('precio sugerido: la suma de las prendas', 20000, conj.json?.precioMinorista);
        chk('los SKU salen del SKU del combo', true,
          (conj.json?.variantes || []).every((v) => v.sku.startsWith('QA-CB-CONJ')));

        const conGorra = await sug([{ productId: rem.id, fijos: negro }, { productId: gorra.id }]);
        chk('una prenda sin talle entra en todos los combos', ['S', 'M', 'L'],
          (conGorra.json?.variantes || []).map((v) => v.talle));
        chk('con la misma gorra en cada uno', true, (conGorra.json?.variantes || [])
          .every((v) => v.componentes.some((c) => c.componenteVariantId === gorraV.id)));

        const conJean = await sug([{ productId: rem.id, fijos: negro }, { productId: jean.id }]);
        chk('letras con números: no hay talles en común', 0, conJean.json?.variantes?.length);
        chk('y lo dice', true, (conJean.json?.avisos || []).some((a) => /ningún talle en común/.test(a)));
        const creaJean = await api('POST', '/api/packs/combo', {
          sku: 'QA-CB-NADA', piezas: [{ productId: rem.id, fijos: negro }, { productId: jean.id }],
        });
        chk('crear un combo sin talles en común da 400', 400, creaJean.status);
        chk('y no deja nada creado', 0, await Product.count({ where: { sku: 'QA-CB-NADA' } }));

        const alta = await api('POST', '/api/packs/combo', {
          sku: 'QA-CB-CONJ', titulo: 'Conjunto QA',
          piezas: [{ productId: rem.id, fijos: negro }, { productId: pan.id }],
        });
        chk('crear el combo: 201', 201, alta.status);
        chk('crea uno por talle en común', 2, alta.json?.variantes?.length);
        const comboProd = await Product.findByPk(alta.json?.productId);
        chk('toma el precio sugerido si no se escribe otro', 20000, Number(comboProd?.precioMinorista));
        chk('guarda la definición del combo', 2, JSON.parse(comboProd?.definicionCombo || '{}').piezas?.length);
        const comboM = await ProductVariant.findOne({ where: { productId: comboProd.id, variante1Valor: 'M' } });
        const comboL = await ProductVariant.findOne({ where: { productId: comboProd.id, variante1Valor: 'L' } });
        chk('las variantes son packs', true, !!comboM?.esPack && !!comboL?.esPack);
        chk('el combo M lleva dos componentes', 2, await PackComponente.count({ where: { packVariantId: comboM.id } }));

        const repetido = await api('POST', '/api/packs/combo', {
          sku: 'QA-CB-CONJ', piezas: [{ productId: rem.id, fijos: negro }, { productId: pan.id }],
        });
        chk('el mismo SKU de combo dos veces da 409', 409, repetido.status);

        await fijar(remV['Negro-M'], 3);
        await fijar(panV.M, 2);
        await fijar(remV['Negro-L'], 5);
        const arm = await packs.disponibleDePacksEnLocales([comboM.id, comboL.id], [local.id], negocio.id);
        chk('se arman tantos combos M como la prenda que menos hay', 2, arm.get(comboM.id));
        chk('sin pantalón L no hay combo L, aunque sobren remeras', 0, arm.get(comboL.id));

        await packs.reservarPack(comboM.id, local.id, negocio.id, 1);
        chk('vender un combo aparta la remera', 1, await apartado(remV['Negro-M']));
        chk('y el pantalón', 1, await apartado(panV.M));
        chk('pero no la remera blanca', 0, await apartado(remV['Blanco-M']));
        await packs.liberarPack(comboM.id, local.id, negocio.id, 1);

        const ruta = `/api/products/variants/${comboM.id}`;
        chk('el margen de ML se guarda por SKU', 200, (await api('PUT', ruta, { margenMl: 2 })).status);
        chk('un margen negativo se rechaza', 400, (await api('PUT', ruta, { margenMl: -1 })).status);
        chk('y uno con decimales también', 400, (await api('PUT', ruta, { margenMl: 2.5 })).status);
        chk('lo rechazado no pisa lo guardado', 2, Number((await ProductVariant.findByPk(comboM.id)).margenMl));

        let lista = await api('GET', '/api/packs');
        let grupo = (lista.json || []).find((g) => g.productId === comboProd.id);
        chk('la lista lo marca como combo', 'combo', grupo?.tipo);
        chk('nombra las dos prendas', ['Pantalón QA', 'Remera QA'], (grupo?.piezas || []).map((x) => x.titulo).sort());
        chk('sin talles faltantes', 0, grupo?.faltanVariantes);
        chk('la lista de packs trae el margen', 2,
          (grupo?.variantes || []).find((x) => x.variantId === comboM.id)?.margenMl);

        // El pantalón suma el talle S: la remera ya lo tenía.
        await variante(pan, 'QA-CB-PAN-S', [['Color', 'Negro'], ['Talle', 'S']]);
        lista = await api('GET', '/api/packs');
        grupo = (lista.json || []).find((g) => g.productId === comboProd.id);
        chk('un talle nuevo en común se cuenta como faltante', 1, grupo?.faltanVariantes);
        const comp = await api('POST', `/api/packs/${comboProd.id}/completar`);
        chk('completar el combo: 200', 200, comp.status);
        chk('agrega sólo el talle S', ['S'], (comp.json?.creadas || []).map((x) => x.etiqueta));
        const otraVez = await api('POST', `/api/packs/${comboProd.id}/completar`);
        chk('completar de nuevo no duplica', 0, otraVez.json?.creadas?.length);
      } finally {
        await limpiarCombos();
        chk('no queda nada de los combos de prueba', 0,
          await ProductVariant.count({ where: { sku: { [Op.like]: 'QA-CB%' } } }));
      }
    }

  } finally {
    tit('Limpieza');
    await limpiar();
    const ids = [remera.id, otra.id, pack.id];
    await PackComponente.destroy({ where: { packVariantId: ids } });
    await StockMovement.destroy({ where: { productVariantId: ids } });
    await VariantStock.destroy({ where: { productVariantId: ids } });
    await ProductVariant.destroy({ where: { id: ids } });
    await Product.destroy({ where: { id: [prod.id, prodPack.id] } });
    chk('no queda nada de la prueba', 0,
      await ProductVariant.count({ where: { sku: { [Op.like]: 'QA-PK-%' } } }));
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
