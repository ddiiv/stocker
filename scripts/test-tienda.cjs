/*
 * Lo que la tienda minorista le pregunta a Stocker.
 *
 * La tienda es un canal online más: no calcula stock ni precios, los pregunta.
 * Lo que se prueba es lo que la rompe si sale mal:
 *
 *   · Que publique EL MISMO número que Mercado Libre y Jumpseller. Si cada
 *     canal hiciera su cuenta, dos publicarían distinto del mismo estante.
 *   · Que un SKU que Stocker no conoce NO vuelva como cero. Cero es "no
 *     queda"; que no exista es que la tienda publica algo que acá no está, y
 *     esas dos cosas se arreglan en lugares distintos.
 *   · Que la credencial de la tienda no pueda leer el catálogo de otro
 *     negocio, ni la del portal mayorista entrar por acá.
 *   · Que el pedido entre por la MISMA cola que los otros canales: el que
 *     aparta mercadería tiene que ser uno solo.
 *
 * Se llama a la puerta y a los controladores EN PROCESO, con un req y un res
 * de mentira: así la prueba no depende de que el puerto 3000 esté libre ni de
 * qué versión del servidor quedó levantada. Lo que se prueba es el mismo
 * middleware y el mismo controlador que monta la ruta.
 *
 * Uso:  node scripts/test-tienda.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const { Op } = require('sequelize');
const {
  Business, BusinessLocation, Product, ProductVariant, VariantStock,
  IntegracionExterna, PedidoPlataforma, PedidoPlataformaItem,
} = require('../src/models');
const integraciones = require('../src/services/integracionesService');
const { variantesPublicables, cantidadesPublicables } = require('../src/services/stockPublicableService');
const { localesQueAbastecenOnline } = require('../src/services/stockService');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const QA = 'QA-TIENDA-';
// Lo que había en la fila de stock antes de la prueba, para devolverlo al final.
let restaurarStock = null;

const { requireIntegracion } = require('../src/middleware/integracion');
const ctrl = require('../src/controllers/integracionesController');
const cola = require('../src/services/colaVentasOnlineService');

/*
 * Una llamada completa: primero la puerta —el mismo middleware que monta la
 * ruta— y después el controlador. Si la puerta contesta, el controlador ni se
 * ejecuta, igual que en Express.
 */
function llamar({ token, origen = 'tienda', handler, query = {}, params = {}, body = {} }) {
  return new Promise((resolve, reject) => {
    const req = {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      query, params, body, ip: '127.0.0.1',
    };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, json: payload }); },
    };
    const seguir = () => Promise.resolve(handler(req, res, reject)).catch(reject);
    Promise.resolve(requireIntegracion(origen)(req, res, seguir)).catch(reject);
  });
}

(async () => {
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } })
    || await Business.findOne({ order: [['id', 'ASC']] });

  const limpiar = async () => {
    await IntegracionExterna.destroy({ where: { nombre: { [Op.like]: 'QA tienda%' } } });
    const pedidos = await PedidoPlataforma.findAll({
      where: { plataforma: 'tienda', pedidoExterno: { [Op.like]: `${QA}%` } }, attributes: ['id'],
    });
    if (pedidos.length) {
      await PedidoPlataformaItem.destroy({ where: { pedidoId: pedidos.map((p) => p.id) } });
      await PedidoPlataforma.destroy({ where: { id: pedidos.map((p) => p.id) } });
    }
  };
  await limpiar();

  try {
    tit('1. LA PUERTA');
    const { token } = await integraciones.emitir({
      businessId: negocio.id, origen: 'tienda', nombre: 'QA tienda',
    });
    chk('sin credencial no se entra', 401, (await llamar({ token: null, handler: ctrl.catalogoTienda })).status);
    chk('con una inventada tampoco', 401,
      (await llamar({ token: 'no-existe', handler: ctrl.catalogoTienda })).status);

    /*
     * La credencial del portal mayorista NO entra por acá. Son dos canales
     * distintos con permisos distintos: el mayorista manda pedidos para que
     * alguien los revise, la tienda aparta mercadería sola.
     */
    const { token: tokenMayorista } = await integraciones.emitir({
      businessId: negocio.id, origen: 'isuwaya', nombre: 'QA tienda ajena',
    });
    chk('la credencial del portal mayorista no sirve para la tienda', 401,
      (await llamar({ token: tokenMayorista, handler: ctrl.catalogoTienda })).status);
    chk('y la de la tienda no sirve para la del mayorista', 401,
      (await llamar({ token, origen: 'isuwaya', handler: ctrl.preciosPorSku })).status);

    tit('2. EL CATÁLOGO');
    const catalogo = await llamar({ token, handler: ctrl.catalogoTienda });
    chk('contesta con productos agrupados por SKU padre', [200, true],
      [catalogo.status, Array.isArray(catalogo.json?.productos)]);

    const conVariantes = (catalogo.json.productos || []).find((p) => p.variantes?.length);
    chk('cada producto trae sus variantes con SKU, color y talle', true,
      Boolean(conVariantes && 'sku' in conVariantes.variantes[0]
        && 'color' in conVariantes.variantes[0] && 'talle' in conVariantes.variantes[0]));
    /*
     * Los precios van con nombre completo: la otra integración devuelve
     * `precio` y ahí significa el mayorista. Dos rutas con el mismo campo
     * queriendo decir cosas distintas se descubre cobrando mal.
     */
    chk('los precios vienen con nombre, sin un "precio" ambiguo', [true, true, false],
      ['precioMinorista' in conVariantes.variantes[0],
        'precioMayorista' in conVariantes.variantes[0],
        'precio' in conVariantes.variantes[0]]);

    /*
     * El número tiene que ser EL MISMO que se le manda a los otros canales: es
     * la razón por la que existe stockPublicableService.
     */
    const locales = await localesQueAbastecenOnline(negocio.id);
    const variantes = await variantesPublicables(negocio.id, { soloActivas: true });
    const esperadas = locales.length
      ? await cantidadesPublicables(negocio.id, locales, variantes)
      : new Map();
    const cuanto = (id) => Number(esperadas.get(id)?.cantidad || 0);
    const unaVariante = variantes.find((v) => cuanto(v.id) > 0) || variantes[0];
    const enCatalogo = (catalogo.json.productos || [])
      .flatMap((p) => p.variantes)
      .find((v) => v.sku === unaVariante?.sku);
    chk('la cantidad publicable es la misma que la de Mercado Libre y Jumpseller',
      cuanto(unaVariante.id), enCatalogo?.publicable);
    /*
     * Y es un número de verdad.
     *
     * Sin esto la prueba pasaba con el bug puesto: el servicio devolvía NaN, la
     * prueba esperaba NaN, y los dos se comparaban iguales. Un valor que no es
     * un entero finito es un defecto por sí mismo, sin importar si coincide.
     */
    chk('y es un número, no un null ni un NaN', true,
      Number.isInteger(enCatalogo?.publicable));

    /*
     * Los ids, que son la clave con la que la tienda engancha lo suyo.
     *
     * Un SKU se corrige —alguien le arregla un typo— y la tienda perdería el
     * enganche con sus fotos y su texto si hubiera guardado el SKU como
     * identidad. Además el aviso `stock_cambio` viaja por id de variante, así
     * que sin esto la tienda no puede traducirlo a un SKU suyo.
     */
    const padreDelCatalogo = (catalogo.json.productos || []).find((p) => (p.variantes || []).length);
    chk('el producto trae su id, no sólo el SKU', true,
      Number.isInteger(padreDelCatalogo?.id) && padreDelCatalogo.id > 0);
    chk('y cada variante trae el suyo', true,
      (padreDelCatalogo?.variantes || []).every((v) => Number.isInteger(v.id) && v.id > 0));
    chk('y el id de la variante es el de Stocker, el mismo que viaja en stock_cambio',
      true, variantes.some((v) => v.id === padreDelCatalogo.variantes[0].id));

    /*
     * El negocio y el precio del padre, que el importador de la tienda exige.
     *
     * El negocio existe porque la tienda guarda los productos contra uno: si
     * algún día una credencial se reemplaza por la de otro negocio sin que nadie
     * lo note, este dato es lo único que lo delata antes de mezclar dos catálogos
     * en la misma base. Y el precio del padre es el que la ficha muestra antes de
     * que el cliente elija talle: una variante con precio nulo usa el del
     * producto, así que sin este número esa ficha no tiene nada que mostrar.
     */
    chk('el catálogo dice de qué negocio es', negocio.id, catalogo.json?.negocio);
    chk('y el producto trae su propio precio, además del de cada variante', true,
      typeof padreDelCatalogo?.precioMinorista === 'number'
        && typeof padreDelCatalogo?.precioMayorista === 'number');
    chk('que no es NaN ni negativo', true,
      Number.isFinite(padreDelCatalogo?.precioMinorista) && padreDelCatalogo.precioMinorista >= 0);

    tit('3. EL STOCK DE UNOS SKU');
    const skus = variantes.slice(0, 3).map((v) => v.sku).filter(Boolean);
    const consulta = await llamar({ token, handler: ctrl.stockTienda, query: { skus: skus.join(',') } });
    chk('devuelve una cantidad por SKU', [200, skus.length],
      [consulta.status, Object.keys(consulta.json?.stock || {}).length]);
    const unoSolo = (await llamar({ token, handler: ctrl.stockTienda, query: { skus: unaVariante.sku } }))
      .json?.stock?.[unaVariante.sku];
    chk('y coincide con el catálogo', cuanto(unaVariante.id), unoSolo);
    chk('y también es un número de verdad', true, Number.isInteger(unoSolo));

    /*
     * Un SKU que Stocker no conoce NO puede volver como cero: cero es "no
     * queda" y eso es "la tienda publica algo que acá no está". Se arreglan en
     * lugares distintos.
     */
    const conFantasma = await llamar({ token, handler: ctrl.stockTienda, query: { skus: `${skus[0]},NO-EXISTE-QA` } });
    chk('un SKU desconocido vuelve aparte, no como cero',
      [true, ['NO-EXISTE-QA']],
      [!('NO-EXISTE-QA' in (conFantasma.json?.stock || {})), conFantasma.json?.desconocidos]);

    chk('pedir de a miles se rechaza con un motivo', 400,
      (await llamar({ token, handler: ctrl.stockTienda, query: { skus: Array.from({ length: 501 }, (_, i) => `S${i}`).join(',') } }).catch((e) => ({ status: e.status }))).status);

    tit('4. UN NEGOCIO NO VE EL DE OTRO');
    const otro = await Business.findOne({ where: { id: { [Op.ne]: negocio.id } }, order: [['id', 'ASC']] });
    if (otro) {
      const { token: tokenOtro } = await integraciones.emitir({
        businessId: otro.id, origen: 'tienda', nombre: 'QA tienda otro negocio',
      });
      const ajeno = await llamar({ token: tokenOtro, handler: ctrl.stockTienda, query: { skus: unaVariante.sku } });
      chk('el SKU de un negocio no existe para la credencial de otro',
        [true, [unaVariante.sku]],
        [!(unaVariante.sku in (ajeno.json?.stock || {})), ajeno.json?.desconocidos]);
    }

    tit('5. EL PEDIDO ENTRA POR LA MISMA COLA');
    /*
     * Stock conocido antes de empezar.
     *
     * Sin esto la suite depende de lo que haya en la base del que la corre: con
     * cero, TODOS los pedidos salen rechazados y las pruebas del camino normal
     * pasan o fallan por el inventario y no por el código. Se restaura al final.
     */
    const filaStock = await VariantStock.findOne({
      where: { productVariantId: unaVariante.id },
      order: [['locationId', 'ASC']],
    });
    const stockOriginal = filaStock
      ? { id: filaStock.id, stock: filaStock.stock, reservado: filaStock.reservado }
      : null;
    if (filaStock) await filaStock.update({ stock: 20, reservado: 0 });
    restaurarStock = stockOriginal;
    chk('la prueba arranca con stock para apartar', true, Boolean(filaStock));
    /*
     * Por la cola de siempre y no por una propia: el que aparta mercadería
     * tiene que ser uno solo, en orden de llegada, o dos canales se llevan la
     * misma última unidad.
     */
    const alta = await llamar({
      token, handler: ctrl.pedidoDeTienda,
      body: {
        pedidoExterno: `${QA}001`,
        items: [{ sku: unaVariante.sku, cantidad: 1 }],
        comprador: { nombre: 'QA Comprador', documento: '30999999911' },
        total: 1000,
      },
    });
    chk('el pedido entra', true, [201, 409].includes(alta.status));
    const enLaCola = await PedidoPlataforma.findOne({
      where: { businessId: negocio.id, plataforma: 'tienda', pedidoExterno: `${QA}001` },
    });
    chk('y queda en la cola de venta online, como los otros canales', 'tienda', enLaCola?.plataforma);

    /*
     * La tienda reintenta sobre cualquier cosa que no sea 2xx: el mismo pedido
     * reenviado tiene que contestar 200 y no volver a apartar.
     */
    const repetido = await llamar({
      token, handler: ctrl.pedidoDeTienda,
      body: {
        pedidoExterno: `${QA}001`,
        items: [{ sku: unaVariante.sku, cantidad: 1 }],
        total: 1000,
      },
    });
    chk('reenviarlo no crea otro ni aparta de nuevo', [200, true],
      [repetido.status, repetido.json?.repetido]);
    chk('y el pedido quedó apartado, no rechazado', 'aceptado', repetido.json?.estado);
    chk('y sigue habiendo un solo pedido', 1,
      await PedidoPlataforma.count({
        where: { businessId: negocio.id, plataforma: 'tienda', pedidoExterno: `${QA}001` },
      }));

    const cancelado = await llamar({
      token, handler: ctrl.cancelarPedidoDeTienda,
      params: { pedidoExterno: `${QA}001` }, body: { motivo: 'Pago vencido' },
    });
    chk('se puede cancelar para liberar la reserva', 200, cancelado.status);
    chk('cancelar uno que no existe da 404', 404,
      (await llamar({ token, handler: ctrl.cancelarPedidoDeTienda, params: { pedidoExterno: `${QA}nada` } })).status);

    /*
     * ── El sobre del contrato de movimientos ──────────────────────
     *
     * `docs/contrato-movimientos.md` define una forma igual para los cinco
     * tipos. Las dos formas —la plana, con la que la tienda ya integró, y el
     * sobre— tienen que caer en LA MISMA clave de idempotencia: si no, el
     * mismo pedido mandado de las dos maneras se descontaría dos veces.
     */
    tit('El sobre del contrato');
    const fallo = (e) => ({ status: e.status, json: null, mensaje: e.message || '' });
    const enSobre = await llamar({
      token, handler: ctrl.pedidoDeTienda,
      body: {
        contrato: 1, tipo: 'venta', id: `isu:${QA}002`,
        ocurrioEn: new Date().toISOString(),
        datos: { items: [{ sku: unaVariante.sku, cantidad: 1 }], total: 1000 },
      },
    }).catch(fallo);
    chk('un pedido en sobre entra', true, [201, 409].includes(enSobre.status));
    chk('y el número sale del id, sin el prefijo de la plataforma', `${QA}002`,
      (await PedidoPlataforma.findOne({
        where: { businessId: negocio.id, plataforma: 'tienda', pedidoExterno: `${QA}002` },
      }))?.pedidoExterno);

    /*
     * El prefijo se corta en el PRIMER dos puntos: los de más atrás son parte
     * del número del pedido. Cortar en el último uniría dos pedidos distintos
     * de la misma plataforma bajo la misma clave, y el segundo volvería como
     * "ya lo tenía" sin apartar nada.
     */
    const conDosPuntos = await llamar({
      token, handler: ctrl.pedidoDeTienda,
      body: {
        contrato: 1, tipo: 'venta', id: `isu:${QA}005:B`,
        datos: { items: [{ sku: unaVariante.sku, cantidad: 1 }], total: 1000 },
      },
    }).catch(fallo);
    chk('un número de pedido con dos puntos adentro llega entero', [true, `${QA}005:B`],
      [[201, 409].includes(conDosPuntos.status),
        (await PedidoPlataforma.findOne({
          where: { businessId: negocio.id, plataforma: 'tienda', pedidoExterno: `${QA}005:B` },
        }))?.pedidoExterno]);

    const mismoPlano = await llamar({
      token, handler: ctrl.pedidoDeTienda,
      body: { pedidoExterno: `${QA}002`, items: [{ sku: unaVariante.sku, cantidad: 1 }], total: 1000 },
    }).catch(fallo);
    chk('el mismo pedido en plano es el mismo pedido, no otro', [200, true],
      [mismoPlano.status, mismoPlano.json?.repetido]);
    chk('y sigue habiendo uno solo', 1,
      await PedidoPlataforma.count({
        where: { businessId: negocio.id, plataforma: 'tienda', pedidoExterno: `${QA}002` },
      }));

    /*
     * Una versión que no conocemos se rechaza en vez de interpretarse, y un
     * tipo equivocado también: una devolución entrando por la ruta de ventas
     * descontaría stock en vez de devolverlo.
     */
    const vieja = await llamar({
      token, handler: ctrl.pedidoDeTienda,
      body: { contrato: 99, tipo: 'venta', id: `isu:${QA}003`, datos: { items: [{ sku: unaVariante.sku, cantidad: 1 }] } },
    }).catch(fallo);
    chk('un contrato que no entendemos se rechaza, y lo dice', [400, true],
      [vieja.status, /contrato de movimientos/.test(vieja.mensaje)]);
    const cruzado = await llamar({
      token, handler: ctrl.pedidoDeTienda,
      body: { contrato: 1, tipo: 'devolucion', id: `isu:${QA}004`, datos: { items: [{ sku: unaVariante.sku, cantidad: 1 }] } },
    }).catch(fallo);
    chk('una devolución mandada a la ruta de ventas se rechaza por el tipo', [400, true],
      [cruzado.status, /devolucion/.test(cruzado.mensaje)]);
    chk('y ninguno de los dos dejó un pedido en la cola', 0,
      await PedidoPlataforma.count({
        where: { businessId: negocio.id, plataforma: 'tienda', pedidoExterno: { [Op.in]: [`${QA}003`, `${QA}004`] } },
      }));

    chk('se puede cancelar en sobre', 200,
      (await llamar({
        token, handler: ctrl.cancelarPedidoDeTienda, params: { pedidoExterno: `${QA}002` },
        body: { contrato: 1, tipo: 'cancelacion', id: `isu:${QA}002`, datos: { motivo: 'Pago vencido' } },
      }).catch(fallo)).status);

    /*
     * ── El pedido que quedó a mitad de camino ─────────────────────
     *
     * Una fila 'pendiente' significa que la venta entró y el stock NO se
     * apartó: el primer intento commiteó la fila y se murió antes de procesar
     * —un deploy de Railway en el medio, un deadlock—. Antes el reenvío
     * contestaba "ya lo tenía" sin mirar el estado, la plataforma lo daba por
     * entregado, y ese pedido no volvía a existir para nadie.
     */
    tit('El pedido que quedó pendiente');
    const colgado = await PedidoPlataforma.create({
      businessId: negocio.id, plataforma: 'tienda', pedidoExterno: `${QA}010`,
      estado: 'pendiente', recibidoEn: new Date(),
    });
    await PedidoPlataformaItem.create({
      pedidoId: colgado.id, sku: unaVariante.sku, cantidad: 1, precioUnitario: 1000,
    });
    chk('arranca pendiente, sin nada apartado', 'pendiente', colgado.estado);

    const reenvio = await llamar({
      token, handler: ctrl.pedidoDeTienda,
      body: { pedidoExterno: `${QA}010`, items: [{ sku: unaVariante.sku, cantidad: 1 }], total: 1000 },
    }).catch(fallo);
    await colgado.reload();
    chk('el reenvío lo procesa en vez de devolverlo sin tocar', true,
      colgado.estado !== 'pendiente');
    chk('y contesta 2xx, no un error', true, [200, 201, 409].includes(reenvio.status));

    /*
     * Y si la plataforma no reenvía nunca, lo levanta el rescate del reloj. La
     * gracia existe para no pelearle el lock al que se está procesando ahora.
     */
    const viejo = await PedidoPlataforma.create({
      businessId: negocio.id, plataforma: 'tienda', pedidoExterno: `${QA}011`,
      estado: 'pendiente', recibidoEn: new Date(Date.now() - 10 * 60 * 1000),
    });
    await PedidoPlataformaItem.create({
      pedidoId: viejo.id, sku: unaVariante.sku, cantidad: 1, precioUnitario: 1000,
    });
    const recien = await PedidoPlataforma.create({
      businessId: negocio.id, plataforma: 'tienda', pedidoExterno: `${QA}012`,
      estado: 'pendiente', recibidoEn: new Date(),
    });
    await PedidoPlataformaItem.create({
      pedidoId: recien.id, sku: unaVariante.sku, cantidad: 1, precioUnitario: 1000,
    });
    await cola.rescatarPendientes();
    await viejo.reload(); await recien.reload();
    chk('el rescate levanta el que quedó colgado', true, viejo.estado !== 'pendiente');
    chk('y no toca el que acaba de entrar', 'pendiente', recien.estado);

    /*
     * ── El envío, que la jornada del depósito necesita ────────────
     *
     * Las columnas ya existían para Mercado Libre y `encolar` las descartaba, así
     * que un pedido de la tienda entraba sin tipo y sin corte: un paquete sin
     * reloj, al final de una lista que se ordena por el corte.
     */
    tit('El envío del pedido');
    const corte = new Date(Date.now() + 6 * 3600 * 1000);
    const conEnvio = await llamar({
      token, handler: ctrl.pedidoDeTienda,
      body: {
        contrato: 1, tipo: 'venta', id: `isu:${QA}030`,
        datos: {
          items: [{ sku: unaVariante.sku, cantidad: 1 }], total: 1000,
          envio: { tipo: 'correo_argentino', despacharAntesDe: corte.toISOString() },
        },
      },
    }).catch(fallo);
    chk('el pedido con envío entra', true, [201, 409].includes(conEnvio.status));
    const guardado = await PedidoPlataforma.findOne({
      where: { businessId: negocio.id, plataforma: 'tienda', pedidoExterno: `${QA}030` },
    });
    chk('y el tipo de envío se guarda tal cual', 'correo_argentino', guardado?.envioTipo);
    chk('y el corte del día también', corte.toISOString().slice(0, 16),
      guardado?.despacharAntesDe ? new Date(guardado.despacharAntesDe).toISOString().slice(0, 16) : null);

    /*
     * Una fecha que no se entiende no puede voltear una venta: se descarta y el
     * paquete queda sin reloj, pero el pedido entra.
     */
    const fechaMala = await llamar({
      token, handler: ctrl.pedidoDeTienda,
      body: {
        pedidoExterno: `${QA}031`, items: [{ sku: unaVariante.sku, cantidad: 1 }], total: 1000,
        envio: { tipo: 'retiro', despacharAntesDe: 'el jueves a la tarde' },
      },
    }).catch(fallo);
    chk('una fecha de corte ilegible no tira el pedido', true, [201, 409].includes(fechaMala.status));
    const conMala = await PedidoPlataforma.findOne({
      where: { businessId: negocio.id, plataforma: 'tienda', pedidoExterno: `${QA}031` },
    });
    chk('entra igual, con el tipo puesto y sin corte', ['retiro', null],
      [conMala?.envioTipo, conMala?.despacharAntesDe ?? null]);

    /*
     * ── El reenvío de un pedido RECHAZADO ─────────────────────────
     *
     * Antes el código lo decidía el reenvío: un pedido que se había rechazado
     * por falta de stock contestaba 200 la segunda vez, y la tienda se quedaba
     * creyendo que estaba apartado. Ahora el estado manda sobre el reenvío.
     */
    tit('El reenvío de un rechazado');
    if (filaStock) await filaStock.update({ stock: 0, reservado: 0 });
    const sinStock = await llamar({
      token, handler: ctrl.pedidoDeTienda,
      body: { pedidoExterno: `${QA}020`, items: [{ sku: unaVariante.sku, cantidad: 3 }], total: 3000 },
    }).catch(fallo);
    chk('sin stock se rechaza con 409', [409, 'rechazado'], [sinStock.status, sinStock.json?.estado]);
    const otraVez = await llamar({
      token, handler: ctrl.pedidoDeTienda,
      body: { pedidoExterno: `${QA}020`, items: [{ sku: unaVariante.sku, cantidad: 3 }], total: 3000 },
    }).catch(fallo);
    chk('y el reenvío sigue diciendo 409, no 200', 409, otraVez.status);
    if (filaStock) await filaStock.update({ stock: 20, reservado: 0 });

    /*
     * ── La idempotencia, en la base y no sólo en el código ────────
     *
     * Dos reintentos que entran JUNTOS no se ven entre sí en el SELECT previo.
     * Lo que los ordena es el índice único: uno entra y el otro recibe "ya lo
     * tenía", nunca un 500 ni una segunda reserva.
     */
    tit('Dos reintentos a la vez');
    const juntos = await Promise.all([
      cola.encolar({ businessId: negocio.id, plataforma: 'tienda', pedidoExterno: `${QA}013`,
        items: [{ sku: unaVariante.sku, cantidad: 1 }], total: 1000 }).catch((e) => ({ error: e.name })),
      cola.encolar({ businessId: negocio.id, plataforma: 'tienda', pedidoExterno: `${QA}013`,
        items: [{ sku: unaVariante.sku, cantidad: 1 }], total: 1000 }).catch((e) => ({ error: e.name })),
    ]);
    chk('ninguno de los dos falla', [undefined, undefined],
      [juntos[0].error, juntos[1].error]);
    chk('queda UN solo pedido', 1,
      await PedidoPlataforma.count({
        where: { businessId: negocio.id, plataforma: 'tienda', pedidoExterno: `${QA}013` },
      }));
    chk('y uno de los dos se enteró de que ya estaba', true,
      Boolean(juntos[0].repetido) !== Boolean(juntos[1].repetido));
  } finally {
    tit('Limpieza');
    await limpiar();
    if (restaurarStock) {
      await VariantStock.update(
        { stock: restaurarStock.stock, reservado: restaurarStock.reservado },
        { where: { id: restaurarStock.id } },
      );
    }
    chk('el stock quedó como estaba', true, !restaurarStock || Boolean(
      (await VariantStock.findByPk(restaurarStock.id))?.stock === restaurarStock.stock));
    chk('no queda nada de la prueba', [0, 0],
      [await IntegracionExterna.count({ where: { nombre: { [Op.like]: 'QA tienda%' } } }),
        await PedidoPlataforma.count({ where: { pedidoExterno: { [Op.like]: `${QA}%` } } })]);
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
