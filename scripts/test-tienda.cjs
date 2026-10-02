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

const { requireIntegracion } = require('../src/middleware/integracion');
const ctrl = require('../src/controllers/integracionesController');

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
    const unaVariante = variantes.find((v) => esperadas.get(v.id) > 0) || variantes[0];
    const enCatalogo = (catalogo.json.productos || [])
      .flatMap((p) => p.variantes)
      .find((v) => v.sku === unaVariante?.sku);
    chk('la cantidad publicable es la misma que la de Mercado Libre y Jumpseller',
      Number(esperadas.get(unaVariante.id) || 0), enCatalogo?.publicable);

    tit('3. EL STOCK DE UNOS SKU');
    const skus = variantes.slice(0, 3).map((v) => v.sku).filter(Boolean);
    const consulta = await llamar({ token, handler: ctrl.stockTienda, query: { skus: skus.join(',') } });
    chk('devuelve una cantidad por SKU', [200, skus.length],
      [consulta.status, Object.keys(consulta.json?.stock || {}).length]);
    chk('y coincide con el catálogo', Number(esperadas.get(unaVariante.id) || 0),
      (await llamar({ token, handler: ctrl.stockTienda, query: { skus: unaVariante.sku } })).json?.stock?.[unaVariante.sku]);

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
  } finally {
    tit('Limpieza');
    await limpiar();
    chk('no queda nada de la prueba', [0, 0],
      [await IntegracionExterna.count({ where: { nombre: { [Op.like]: 'QA tienda%' } } }),
        await PedidoPlataforma.count({ where: { pedidoExterno: { [Op.like]: `${QA}%` } } })]);
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
