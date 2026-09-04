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
    const mio = (lista.json || []).find((x) => x.sku === 'QA-PK-PACK3');
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

    tit('13. ALTA DE UN PACK ENTERO EN UNA SOLA LLAMADA');
    /*
     * Producto, variante y composición van juntos. Si esto se partiera en tres
     * llamadas y fallara la última, quedaría un producto vacío colgado en el
     * listado de stock que nadie sabría de dónde salió.
     */
    const alta = await api('POST', '/api/packs', {
      sku: 'QA-PK-NUEVO', titulo: 'QA Pack alta', precioMinorista: 21000,
      componentes: [{ componenteVariantId: remera.id, cantidad: 3 }],
    });
    chk('POST /api/packs crea', 201, alta.status);
    const nuevoId = alta.json?.variantId;
    const creado = nuevoId ? await ProductVariant.findByPk(nuevoId) : null;
    chk('la variante nace como pack', true, !!creado?.esPack);
    chk('sin stock propio', 0, Number(creado?.stock) || 0);
    // La dimensión dice qué es: es lo que se lee en el POS y en la etiqueta.
    chk('y con la dimensión que la explica', '3 unidades', creado?.variante1Valor);
    chk('en su propio producto, no colgada de otro', 1,
      await ProductVariant.count({ where: { productId: creado?.productId } }));
    chk('con la composición ya cargada', 1,
      await PackComponente.count({ where: { packVariantId: nuevoId } }));

    // Repetir el SKU tiene que dar un choque limpio, no un 500 de la base.
    const skuChocado = await api('POST', '/api/packs', {
      sku: 'QA-PK-NUEVO', titulo: 'Otro', precioMinorista: 1000,
      componentes: [{ componenteVariantId: remera.id, cantidad: 1 }],
    });
    chk('un SKU repetido da 409, no un 500', 409, skuChocado.status);

    /*
     * Y si la composición es inválida no puede quedar el producto creado: es
     * justamente el caso que motivó hacerlo en una transacción.
     */
    const productosAntes = await Product.count({ where: { businessId: negocio.id } });
    const malArmado = await api('POST', '/api/packs', {
      sku: 'QA-PK-HUERFANO', titulo: 'QA huérfano', precioMinorista: 1000,
      componentes: [{ componenteVariantId: nuevoId, cantidad: 1 }],   // un pack adentro
    });
    chk('un pack adentro de otro se rechaza en el alta', 400, malArmado.status);
    chk('y no quedó ningún producto huérfano', productosAntes,
      await Product.count({ where: { businessId: negocio.id } }));
    chk('ni la variante', 0,
      await ProductVariant.count({ where: { sku: 'QA-PK-HUERFANO' } }));

    // Un precio en cero se rechaza: sería regalar el pack.
    const gratis = await api('POST', '/api/packs', {
      sku: 'QA-PK-GRATIS', titulo: 'QA gratis', precioMinorista: 0,
      componentes: [{ componenteVariantId: remera.id, cantidad: 1 }],
    });
    chk('un pack a precio cero se rechaza', 400, gratis.status);

    // El buscador no ofrece packs cuando se le pide que no.
    const busca = await api('GET', '/api/products/buscar-variantes?q=QA-PK&limit=40&sinPacks=1');
    chk('el buscador con sinPacks no devuelve packs', true,
      (busca.json?.data || []).every((v) => !v.esPack));
    const buscaTodo = await api('GET', '/api/products/buscar-variantes?q=QA-PK-NUEVO&limit=40');
    chk('y sin el filtro sí lo trae, marcado', true,
      (buscaTodo.json?.data || []).some((v) => v.sku === 'QA-PK-NUEVO' && v.esPack === true));

    if (creado) {
      await PackComponente.destroy({ where: { packVariantId: creado.id } });
      await ProductVariant.destroy({ where: { id: creado.id } });
      await Product.destroy({ where: { id: creado.productId } });
    }

    const desarmado = await api('DELETE', `/api/packs/${pack.id}`);
    chk('DELETE /api/packs/:id desarma', 200, desarmado.status);
    chk('ya no es pack', false, !!(await ProductVariant.findByPk(pack.id))?.esPack);
    chk('y no le quedan componentes', 0,
      await PackComponente.count({ where: { packVariantId: pack.id } }));

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
