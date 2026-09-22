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
  Business, BusinessLocation, Client, Product, ProductVariant, Sale, SaleItem, VariantStock,
  SalePayment, ClientAccountEntry, Invoice,
  IntegracionExterna, SolicitudMayorista, SolicitudMayoristaItem,
} = require('../src/models');
const { devolverStockVenta } = require('../src/services/saleStockService');
const sequelize = require('../src/config/database');
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

/* La sesión de una persona, que es con la que se revisa la bandeja. */
function sesion() {
  let cookie = '';
  return async (metodo, ruta, cuerpo) => {
    const r = await fetch(`${API}${ruta}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    const set = r.headers.getSetCookie?.() || [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const texto = await r.text();
    let json = null; try { json = JSON.parse(texto); } catch { /* no json */ }
    return { status: r.status, json, texto };
  };
}

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

  const local = await BusinessLocation.findOne({
    where: { businessId: negocio.id, tipo: 'local', activo: true }, order: [['id', 'ASC']],
  });
  if (!local) { console.log('Hace falta un local de venta en', negocio.nombre); process.exit(1); }

  /*
   * El stock se deja como estaba.
   *
   * Aceptar un pedido sin stock da de alta las unidades que faltan —es lo que
   * se pidió— y eso queda escrito en el inventario. Se guarda la foto de
   * antes y se restaura al final: una suite no puede dejarle stock inventado
   * a la base.
   */
  const stockAntes = new Map();
  for (const v of [v1, v2]) {
    const fila = await VariantStock.findOne({ where: { productVariantId: v.id, locationId: local.id } });
    stockAntes.set(v.id, fila ? { stock: fila.stock, reservado: fila.reservado } : null);
  }
  const ventasDePrueba = [];

  const limpiar = async () => {
    /*
     * Las ventas de la prueba se borran con todo lo que les cuelga.
     *
     * Una venta fiada deja además su renglón en la cuenta corriente del
     * cliente, y una cobrada sus pagos: borrando sólo la venta, la base rechaza
     * el DELETE por clave foránea, la limpieza se corta a la mitad y la corrida
     * siguiente arranca con basura de la anterior. Pasó: por eso está escrito
     * así y no con un destroy solo.
     */
    const aBorrar = [...new Set([
      ...ventasDePrueba.filter(Boolean),
      ...(await Sale.findAll({
        where: { businessId: negocio.id, notas: { [Op.like]: `%${QA}%` } }, attributes: ['id'],
      })).map((v) => v.id),
    ])];
    for (const id of aBorrar) {
      const venta = await Sale.findByPk(id, { include: [{ model: SaleItem, as: 'items' }] });
      if (!venta) continue;
      const t = await sequelize.transaction();
      try {
        await devolverStockVenta(venta, t, { motivo: 'QA solicitud mayorista' });
        await t.commit();
      } catch { await t.rollback().catch(() => {}); }
      await SolicitudMayorista.update({ saleId: null }, { where: { saleId: id } });
      await ClientAccountEntry.destroy({ where: { saleId: id } });
      await SalePayment.destroy({ where: { saleId: id } });
      await Invoice.destroy({ where: { saleId: id } });
      await SaleItem.destroy({ where: { saleId: id } });
      await Sale.destroy({ where: { id } });
    }
    ventasDePrueba.length = 0;
    for (const [variantId, antes] of stockAntes) {
      if (!antes) { await VariantStock.destroy({ where: { productVariantId: variantId, locationId: local.id } }); continue; }
      await VariantStock.update(antes, { where: { productVariantId: variantId, locationId: local.id } });
    }
    await Client.destroy({ where: { businessId: negocio.id, nombre: 'QA Textiles Mayorista' } });
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
   * El cliente de prueba se crea DESPUÉS de la limpieza, que es justamente la
   * que lo borra. Creado antes, la suite se queda con el id de una fila que ya
   * no existe y la venta fiada rebota con "el cliente no pertenece a este
   * negocio": un error que manda a buscar el problema al lado equivocado.
   */
  const [cliente] = await Client.findOrCreate({
    where: { businessId: negocio.id, cuit: '30-99999991-1' },
    defaults: {
      businessId: negocio.id, nombre: 'QA Textiles Mayorista', cuit: '30-99999991-1', tipo: 'mayorista',
      // Fiar exige cuenta habilitada y límite: es la puerta que Stocker ya tiene.
      cuentaHabilitada: true, limiteCredito: 500000,
    },
  });

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

    /*
     * Del otro lado hay un sistema configurado con una URL base y una ruta, y
     * las dos formas de partirlo son razonables. Cuando no coinciden, el pedido
     * se perdía con un 404 que se lee "la ruta no existe" y no dice que
     * faltaban cuatro caracteres. Ahora llega igual.
     */
    const sinApi = await fetch(`${API}/integraciones/isuwaya/pedidos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(pedido(`${QA}003`)),
    });
    chk('el pedido llega aunque la URL venga sin el /api', [201, true],
      [sinApi.status, Boolean(await leer(`${QA}003`))]);

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

    /*
     * Que el pedido siga su curso allá —enviado, entregado— llega igual que una
     * modificación. Si eso avisara "el portal cambió el pedido", el aviso sería
     * ruido y el día que cambie de verdad nadie lo miraría.
     */
    await mandar(token, pedido(`${QA}001`, {
      // El mismo contenido que quedó guardado acá: lo único que cambió es su estado allá.
      secuencia: 12, total: 90000, unidades: 2, estado: 'enviado', evento: 'enviado',
    }));
    const despachada = await leer(`${QA}001`);
    chk('que el pedido avance allá no cuenta como cambio', ['enviado', 250000],
      [despachada.s.estadoOrigen,
        (() => { try { return JSON.parse(despachada.s.cambioPosterior).total; } catch { return 'sin anotar'; } })()]);

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
    const token3 = tercera.token;
    chk('emitir una nueva apaga la anterior: no quedan dos vivas', 401,
      (await mandar(segunda.token, pedido(`${QA}012`))).status);
    chk('y la última anda', 201, (await mandar(tercera.token, pedido(`${QA}013`))).status);

    tit('7. LA BANDEJA');
    const api = sesion();
    const login = await api('POST', '/api/auth/login', { email: negocio.email, password: 'Demo2026!!' });
    if (login.status !== 200) { console.log('No se pudo entrar como', negocio.email, login.status); process.exit(1); }

    // Cantidades chicas: acá se prueba la bandeja, no el stock.
    await mandar(token3, pedido(`${QA}100`, {
      items: [
        { sku: v1.sku, cantidad: 1, precioUnitario: 45000, producto: 'Remera QA' },
        { sku: v2.sku, cantidad: 1, precioUnitario: 40000, producto: 'Pantalón QA' },
      ],
    }));
    const bandeja = await api('GET', '/api/solicitudes-mayoristas?estado=pendiente');
    const enLista = (bandeja.json?.solicitudes || []).find((x) => x.pedidoExterno === `${QA}100`);
    chk('la solicitud aparece en la bandeja', [200, true, 'pendiente'],
      [bandeja.status, !!enLista, enLista?.estado]);

    const det = await api('GET', `/api/solicitudes-mayoristas/${enLista.id}`);
    chk('el detalle trae las líneas y qué no se pudo identificar', [2, 0],
      [det.json?.items?.length, det.json?.sinIdentificar?.length]);
    chk('y el JSON del origen llega leído, no como texto', 'Textiles QA', det.json?.cliente?.nombre);

    tit('8. RECHAZAR');
    const sinMotivo = await api('POST', `/api/solicitudes-mayoristas/${enLista.id}/rechazar`, {});
    chk('rechazar sin motivo no se puede: del otro lado hay alguien esperando', 400, sinMotivo.status);

    const rechazo = await api('POST', `/api/solicitudes-mayoristas/${enLista.id}/rechazar`,
      { motivo: 'No hay tela para esa curva hasta el mes que viene.' });
    chk('con motivo, queda rechazada y el motivo guardado',
      [200, 'rechazada', 'No hay tela para esa curva hasta el mes que viene.'],
      [rechazo.status, rechazo.json?.estado, rechazo.json?.motivoRechazo]);
    chk('una rechazada ya no se puede aceptar', 409,
      (await api('POST', `/api/solicitudes-mayoristas/${enLista.id}/aceptar`, { locationId: local.id })).status);

    tit('9. ACEPTAR: LO QUE NO SE PUEDE VENDER');
    await mandar(token3, pedido(`${QA}101`, {
      items: [
        { sku: v1.sku, cantidad: 1, producto: 'Remera QA' },
        { sku: 'SIN-SKU:QA:Melang:XXL', cantidad: 2, producto: 'Buzo QA' },
      ],
    }));
    const conRaro = (await api('GET', `/api/solicitudes-mayoristas?estado=pendiente`))
      .json.solicitudes.find((x) => x.pedidoExterno === `${QA}101`);
    const noIdentificada = await api('POST', `/api/solicitudes-mayoristas/${conRaro.id}/aceptar`,
      { locationId: local.id });
    chk('con una línea que Stocker no reconoce no se acepta', [409, 'SIN_IDENTIFICAR'],
      [noIdentificada.status, noIdentificada.json?.codigo || noIdentificada.json?.detalles?.codigo]);
    chk('y la solicitud sigue en la bandeja, no marcada', 'pendiente',
      (await api('GET', `/api/solicitudes-mayoristas/${conRaro.id}`)).json?.estado);

    tit('10. ACEPTAR: EL PEDIDO SE HACE VENTA');
    /*
     * El stock se pone en cero a propósito.
     *
     * Sin fijarlo, que falte o no stock depende de lo que tenga la base ese
     * día: si había, la venta sale derecho y toda la mitad importante de esta
     * sección —el aviso de faltante, la vuelta a la bandeja, el alta
     * confirmada— no se prueba y la suite igual da verde. Se descubrió
     * justamente así: tres controles no hicieron fallar nada.
     */
    for (const variante of [v1, v2]) {
      const [fila] = await VariantStock.findOrCreate({
        where: { productVariantId: variante.id, locationId: local.id },
        defaults: { productVariantId: variante.id, locationId: local.id, businessId: negocio.id, stock: 0, reservado: 0 },
      });
      await fila.update({ stock: 0, reservado: 0 });
    }
    /*
     * Un pedido mayorista se hace a pedido: lo normal es que el stock no esté.
     * Stocker avisa qué falta y no vende hasta que una persona lo confirme.
     */
    await mandar(token3, pedido(`${QA}102`, {
      items: [{ sku: v1.sku, cantidad: 3, precioUnitario: 45000, producto: 'Remera QA' },
        { sku: v2.sku, cantidad: 2, precioUnitario: 40000, producto: 'Pantalón QA' }],
      total: 215000, unidades: 5,
    }));
    const paraVender = (await api('GET', '/api/solicitudes-mayoristas?estado=pendiente'))
      .json.solicitudes.find((x) => x.pedidoExterno === `${QA}102`);

    const sinStock = await api('POST', `/api/solicitudes-mayoristas/${paraVender.id}/aceptar`,
      { locationId: local.id, estado: 'pagado', medioPago: 'efectivo' });
    chk('si falta stock, avisa qué falta antes de vender', [409, 'SIN_STOCK'],
      [sinStock.status, sinStock.json?.codigo || sinStock.json?.detalles?.codigo]);
    chk('y dice cuántas unidades faltan de cada artículo', true,
      (sinStock.json?.faltantes || sinStock.json?.detalles?.faltantes || []).length > 0);
    chk('y la solicitud VUELVE a la bandeja para reintentar', 'pendiente',
      (await api('GET', `/api/solicitudes-mayoristas/${paraVender.id}`)).json?.estado);

    /*
     * Ahora con el alta confirmada: se suman las unidades que faltaban y la
     * venta se las lleva. Es lo mismo que hace el mostrador cuando la percha
     * tiene algo que el inventario no.
     */
    const aceptada = await api(
      'POST', `/api/solicitudes-mayoristas/${paraVender.id}/aceptar`,
      {
        locationId: local.id, estado: 'pagado', medioPago: 'efectivo', confirmarAltaStock: true,
        // Artículos de mentira a propósito: aceptar es aceptar ESTE pedido.
        items: [{ productVariantId: v2.id, cantidad: 99 }],
      },
    );
    ventasDePrueba.push(aceptada.json?.venta?.id);
    chk('se acepta y nace la venta', [201, true], [aceptada.status, !!aceptada.json?.venta?.id]);
    chk('la venta lleva los artículos del pedido y no los que mandó el navegador',
      [2, 3, 2],
      [aceptada.json?.venta?.items?.length,
        aceptada.json?.venta?.items?.find((i) => i.productVariantId === v1.id)?.cantidad,
        aceptada.json?.venta?.items?.find((i) => i.productVariantId === v2.id)?.cantidad]);
    chk('la solicitud queda aceptada y apunta a su venta', ['aceptada', aceptada.json?.venta?.id],
      [(await api('GET', `/api/solicitudes-mayoristas/${paraVender.id}`)).json?.estado,
        (await api('GET', `/api/solicitudes-mayoristas/${paraVender.id}`)).json?.saleId]);
    chk('y queda escrito de qué pedido salió', true,
      String(aceptada.json?.venta?.notas || '').includes(`${QA}102`));
    chk('el alta se avisa: se dieron de alta las unidades que faltaban', 'STOCK_DADO_DE_ALTA',
      aceptada.json?.venta?.altaStock?.codigo);
    /*
     * Lo que se dio de alta se lo llevó la venta: el inventario no queda con
     * unidades fantasma sueltas.
     */
    const tras102 = await VariantStock.findOne({ where: { productVariantId: v1.id, locationId: local.id } });
    chk('y el inventario no queda con unidades fantasma sueltas', 0, Number(tras102?.stock ?? 0));

    const repetida = await api('POST', `/api/solicitudes-mayoristas/${paraVender.id}/aceptar`,
      { locationId: local.id, estado: 'pagado', medioPago: 'efectivo', confirmarAltaStock: true });
    if (repetida.json?.venta?.id) ventasDePrueba.push(repetida.json.venta.id);
    chk('aceptarla dos veces no crea una segunda venta', [409, 1],
      [repetida.status,
        await Sale.count({ where: { businessId: negocio.id, notas: { [Op.like]: `%${QA}102%` } } })]);

    tit('11. O SE DEJA A COBRAR');
    await mandar(token3, pedido(`${QA}103`, {
      items: [{ sku: v1.sku, cantidad: 1, precioUnitario: 45000, producto: 'Remera QA' }],
      total: 45000, unidades: 1,
    }));
    const aFiar = (await api('GET', '/api/solicitudes-mayoristas?estado=pendiente'))
      .json.solicitudes.find((x) => x.pedidoExterno === `${QA}103`);
    const fiada = await api('POST', `/api/solicitudes-mayoristas/${aFiar.id}/aceptar`, {
      locationId: local.id,
      clientId: cliente.id,
      condicionPago: 'cuenta_corriente',
      descontarStock: true,
      confirmarAltaStock: true,
    });
    if (fiada.json?.venta?.id) ventasDePrueba.push(fiada.json.venta.id);
    chk('la misma solicitud se puede dejar a cobrar en vez de cobrarla',
      [201, 'cuenta_corriente', cliente.id],
      [fiada.status, fiada.json?.venta?.condicionPago, fiada.json?.venta?.clientId]);
    chk('y queda como deuda del cliente, no como plata en la caja', true,
      Number(fiada.json?.venta?.saldoPendiente) > 0);
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
