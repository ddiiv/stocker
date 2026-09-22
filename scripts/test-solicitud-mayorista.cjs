/*
 * La puerta por la que ISUWAYA deja un pedido mayorista.
 *
 * Lo que entra por acá no es una venta: es una solicitud esperando que una
 * persona la mire. Así que lo que se prueba no es el alta de una venta, sino
 * las tres cosas que tienen que estar bien ANTES de que alguien apriete
 * aceptar:
 *
 *   · Quién entra. Una credencial de máquina y nada más, y el negocio sale de
 *     ella y nunca del cuerpo: si viniera de afuera, una credencial cualquiera
 *     escribiría en la cuenta de otro cliente de Stocker.
 *   · Qué entra. El pedido completo, con las líneas que Stocker no reconoce
 *     marcadas en vez de escondidas.
 *   · Cuántas veces entra. El origen reintenta solo hasta por dos días: el
 *     mismo pedido reenviado tiene que quedar UNA vez, y una entrega vieja que
 *     llega tarde no puede pisar a la nueva.
 *
 * Uso:  API=http://localhost:3000 node scripts/test-solicitud-mayorista.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const API = process.env.API || 'http://localhost:3000';
const { Op } = require('sequelize');
const {
  Business, Product, ProductVariant,
  IntegracionExterna, SolicitudMayorista, SolicitudMayoristaItem,
} = require('../src/models');
const integraciones = require('../src/services/integracionesService');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

// El prefijo con el que se reconocen los pedidos de esta prueba, para limpiar.
const QA = 'QA-ISU-';

async function mandar(token, cuerpo) {
  const r = await fetch(`${API}/api/integraciones/isuwaya/pedidos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  let json = null; try { json = JSON.parse(texto); } catch { /* no json */ }
  return { status: r.status, json, texto };
}

(async () => {
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } })
    || await Business.findOne({ order: [['id', 'ASC']] });

  // Dos variantes de verdad del catálogo: el cruce por SKU es lo que se prueba.
  const variantes = await ProductVariant.findAll({
    include: [{ model: Product, as: 'producto', required: true, where: { businessId: negocio.id } }],
    where: { sku: { [Op.ne]: null } },
    limit: 2,
    order: [['id', 'ASC']],
  });
  if (variantes.length < 2) { console.log('Hacen falta dos variantes con SKU en', negocio.nombre); process.exit(1); }
  const [v1, v2] = variantes;

  const limpiar = async () => {
    const filas = await SolicitudMayorista.findAll({
      where: { pedidoExterno: { [Op.like]: `${QA}%` } }, attributes: ['id'],
    });
    if (filas.length) {
      await SolicitudMayoristaItem.destroy({ where: { solicitudId: filas.map((f) => f.id) } });
      await SolicitudMayorista.destroy({ where: { id: filas.map((f) => f.id) } });
    }
    await IntegracionExterna.destroy({ where: { nombre: { [Op.like]: 'QA %' } } });
  };
  await limpiar();

  /*
   * Se busca por el número del pedido y NO por el negocio.
   *
   * Filtrando por el negocio correcto, una solicitud que quedó en el negocio
   * equivocado se ve igual que una que no entró, y la prueba se cae con un
   * error de lectura en vez de decir qué pasó. El negocio se comprueba como un
   * dato más, que es lo que es.
   */
  const leer = async (pedidoExterno) => {
    const s = await SolicitudMayorista.findOne({ where: { pedidoExterno } });
    if (!s) return null;
    const items = await SolicitudMayoristaItem.findAll({
      where: { solicitudId: s.id }, order: [['id', 'ASC']],
    });
    return { s, items };
  };

  const pedido = (numero, extra = {}) => ({
    negocioId: 999999,           // a propósito: el negocio NO puede salir de acá
    plataforma: 'isuwaya',
    evento: 'alta',
    secuencia: 1,
    pedidoExterno: numero,
    estado: 'pendiente',
    total: 130000,
    unidades: 3,
    pago: { forma: 'transferencia', condicion: 'cuenta_corriente' },
    comprador: { nombre: 'Textiles QA', documento: '30999999911' },
    cliente: { nombre: 'Textiles QA', cuit: '30-99999991-1', tipo: 'mayorista' },
    envio: { forma: 'expreso', localidad: 'Córdoba' },
    items: [
      { sku: v1.sku, cantidad: 2, precioUnitario: 45000, producto: 'Remera QA', color: 'Negro', talle: 'M' },
      { sku: v2.sku, cantidad: 1, precioUnitario: 40000, producto: 'Pantalón QA', color: 'Azul', talle: 'L' },
    ],
    ...extra,
  });

  try {
    tit('1. QUIÉN ENTRA');
    const { token } = await integraciones.emitir({
      businessId: negocio.id, origen: 'isuwaya', nombre: 'QA ISUWAYA',
    });

    chk('sin credencial no se entra', 401, (await mandar(null, pedido(`${QA}000`))).status);
    chk('con una credencial inventada tampoco', 401,
      (await mandar('no-existe-este-token', pedido(`${QA}000`))).status);
    chk('y el mensaje no dice cuál de las dos cosas falló', 'Credencial inválida.',
      (await mandar('no-existe-este-token', pedido(`${QA}000`))).json?.message);

    const alta = await mandar(token, pedido(`${QA}001`));
    chk('con la credencial buena, el pedido entra', [201, true, true],
      [alta.status, alta.json?.ok, alta.json?.creada]);

    /*
     * El negocio sale de la credencial y nunca del cuerpo. El pedido viene con
     * negocioId 999999: si esto fallara, una credencial cualquiera podría
     * escribirle pedidos a otro cliente de Stocker.
     */
    const guardado = await leer(`${QA}001`);
    chk('el negocio sale de la credencial, no del cuerpo', negocio.id, guardado.s.businessId);

    tit('2. QUÉ ENTRA');
    chk('las dos líneas quedaron, en orden', 2, guardado.items.length);
    chk('los SKU del catálogo se cruzan con su variante',
      [v1.id, v2.id], guardado.items.map((i) => i.productVariantId));
    chk('se guarda lo que el origen dice de cada línea',
      ['Remera QA · Negro · M', 45000],
      [guardado.items[0].descripcion, Number(guardado.items[0].precioOrigen)]);
    chk('y cómo se acordó cobrar, que es una propuesta y no una orden',
      ['cuenta_corriente', 'transferencia'],
      [guardado.s.pagoCondicion, guardado.s.pagoForma]);
    chk('nace pendiente: todavía no es una venta', ['pendiente', null], [guardado.s.estado, guardado.s.saleId]);

    /*
     * El catálogo de ISUWAYA se importó de acá pero se desfasa: un color
     * renombrado, una variante borrada. Esa línea NO se puede saltear: el
     * pedido se vería completo cuando no lo está.
     */
    await mandar(token, pedido(`${QA}002`, {
      items: [
        { sku: v1.sku, cantidad: 1, producto: 'Remera QA' },
        { sku: 'SIN-SKU:QA:Melang:XXL', cantidad: 4, producto: 'Buzo QA', color: 'Melang', talle: 'XXL' },
      ],
    }));
    const conDesconocido = await leer(`${QA}002`);
    /*
     * Ojo con confundir "la línea no está" con "la línea está y su variante es
     * null": null es justo lo que se espera acá, así que se pregunta primero si
     * la línea existe y recién después por su valor.
     */
    const identificada = conDesconocido.items[0];
    const sinIdentificar = conDesconocido.items[1];
    chk('un SKU que Stocker no conoce entra igual, marcado', [2, v1.id, null],
      [conDesconocido.items.length,
        identificada ? identificada.productVariantId : 'falta la línea',
        sinIdentificar ? sinIdentificar.productVariantId : 'falta la línea']);
    chk('y se guarda su SKU tal cual, para poder identificarlo a mano',
      'SIN-SKU:QA:Melang:XXL', sinIdentificar ? sinIdentificar.sku : 'falta la línea');

    tit('3. CUÁNTAS VECES ENTRA');
    /*
     * El origen reintenta solo hasta por dos días ante cualquier caída. Si el
     * reenvío creara otro pedido, el depósito prepararía dos.
     */
    const repetido = await mandar(token, pedido(`${QA}001`));
    chk('el mismo pedido reenviado no crea otro', [200, false, true],
      [repetido.status, repetido.json?.creada, repetido.json?.repetido]);
    chk('y sigue habiendo una sola solicitud', 1,
      await SolicitudMayorista.count({ where: { businessId: negocio.id, pedidoExterno: `${QA}001` } }));

    // Llega el pedido cambiado: mientras nadie lo revisó, vale el último.
    await mandar(token, pedido(`${QA}001`, {
      secuencia: 5, total: 90000, unidades: 2, estado: 'modificado',
      items: [{ sku: v1.sku, cantidad: 2, precioUnitario: 45000, producto: 'Remera QA' }],
    }));
    const tras = await leer(`${QA}001`);
    chk('mientras está pendiente, el último envío manda',
      [90000, 2, 1, 'modificado'],
      [Number(tras.s.total), tras.s.unidades, tras.items.length, tras.s.estadoOrigen]);

    /*
     * Una entrega vieja puede llegar después de la nueva: la red no garantiza
     * orden y la cola reintenta. Sin la secuencia, el pedido volvería atrás.
     */
    const tarde = await mandar(token, pedido(`${QA}001`, {
      secuencia: 2, total: 130000, unidades: 3, estado: 'pendiente',
    }));
    const despues = await leer(`${QA}001`);
    chk('una entrega vieja que llega tarde se descarta', true, tarde.json?.ignorado);
    chk('y no revive los datos viejos', [90000, 2], [Number(despues.s.total), despues.s.unidades]);

    tit('4. UNA SOLICITUD YA REVISADA NO SE PISA');
    /*
     * Después de aceptar hay una venta con su número, y puede estar cobrada.
     * Reescribirla por detrás sería cambiarle el importe a algo ya cerrado.
     * Pero perder el aviso es peor: el depósito prepararía lo que el cliente ya
     * no pidió.
     */
    await despues.s.update({ estado: 'aceptada', revisadoEn: new Date(), saleId: 123456 });
    const posterior = await mandar(token, pedido(`${QA}001`, {
      secuencia: 9, total: 250000, unidades: 7, estado: 'modificado',
    }));
    const revisada = await leer(`${QA}001`);
    chk('el cambio tardío se acepta pero no reescribe la solicitud',
      [200, true, 'aceptada', 90000],
      [posterior.status, posterior.json?.cambioTardio, revisada.s.estado, Number(revisada.s.total)]);
    const anotado = (() => { try { return JSON.parse(revisada.s.cambioPosterior); } catch { return null; } })();
    chk('y queda anotado para que alguien lo mire', [9, 250000],
      [anotado?.secuencia ?? 'sin anotar', anotado?.total ?? 'sin anotar']);

    tit('5. LO QUE NO PUEDE ENTRAR');
    const malo = async (cuerpo) => (await mandar(token, cuerpo)).status;
    chk('un pedido sin número de origen', 400, await malo(pedido(`${QA}900`, { pedidoExterno: '' })));
    chk('un pedido sin líneas', 400, await malo(pedido(`${QA}901`, { items: [] })));
    chk('una línea sin SKU', 400,
      await malo(pedido(`${QA}902`, { items: [{ sku: '', cantidad: 1 }] })));
    chk('una cantidad en cero', 400,
      await malo(pedido(`${QA}903`, { items: [{ sku: v1.sku, cantidad: 0 }] })));
    chk('media prenda', 400,
      await malo(pedido(`${QA}904`, { items: [{ sku: v1.sku, cantidad: 2.5 }] })));
    chk('una cantidad negativa', 400,
      await malo(pedido(`${QA}905`, { items: [{ sku: v1.sku, cantidad: -3 }] })));
    chk('un pedido de 201 líneas', 400,
      await malo(pedido(`${QA}906`, {
        items: Array.from({ length: 201 }, () => ({ sku: v1.sku, cantidad: 1 })),
      })));
    chk('y nada de eso dejó una solicitud a medias', 0,
      await SolicitudMayorista.count({ where: { pedidoExterno: { [Op.like]: `${QA}9%` } } }));

    tit('6. CORTAR EL PUENTE');
    /*
     * El día que ISUWAYA deje de usarse, o que el token se filtre, tiene que
     * poder cortarse sin tocar nada más.
     */
    const fila = await IntegracionExterna.findOne({ where: { tokenHash: integraciones.__hash(token) } });
    await integraciones.revocar({ businessId: negocio.id, id: fila.id });
    chk('con la credencial revocada no se entra más', 401,
      (await mandar(token, pedido(`${QA}010`))).status);

    const segunda = await integraciones.emitir({
      businessId: negocio.id, origen: 'isuwaya', nombre: 'QA ISUWAYA 2',
    });
    chk('la credencial nueva sí entra', 201, (await mandar(segunda.token, pedido(`${QA}011`))).status);
    chk('el token no se guarda en claro', [false, 6],
      [(await IntegracionExterna.findByPk(segunda.integracion.id)).tokenHash.includes(segunda.token),
        (await IntegracionExterna.findByPk(segunda.integracion.id)).pista.length]);

    const tercera = await integraciones.emitir({
      businessId: negocio.id, origen: 'isuwaya', nombre: 'QA ISUWAYA 3',
    });
    chk('emitir una nueva apaga la anterior: no quedan dos vivas', 401,
      (await mandar(segunda.token, pedido(`${QA}012`))).status);
    chk('y la última anda', 201, (await mandar(tercera.token, pedido(`${QA}013`))).status);
  } finally {
    tit('Limpieza');
    await limpiar();
    chk('no queda nada de la prueba', [0, 0],
      [await SolicitudMayorista.count({ where: { pedidoExterno: { [Op.like]: `${QA}%` } } }),
        await IntegracionExterna.count({ where: { nombre: { [Op.like]: 'QA %' } } })]);
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
