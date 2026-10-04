/*
 * La puerta del pago: que no se despache lo que no se cobró.
 *
 * La tienda minorista aparta la prenda y cobra después —transferencia a 48 h,
 * Pago Fácil a 72 h—, así que un pedido puede entrar debiendo plata. Lo que esta
 * suite cuida son las tres cosas que pueden salir mal con eso:
 *
 *   1. Que el depósito despache mercadería impaga. La puerta tiene que estar
 *      DENTRO de `despachar` y no sólo en el filtro de la lista: las rutas de
 *      despachar toman el id del cuerpo y nunca pasan por `delDia`.
 *   2. Que el filtro nuevo congele Mercado Libre y Jumpseller. Sus pedidos no
 *      informan pago y tienen la columna en NULL: si el filtro compara contra
 *      'pagado' en vez de preguntar por NULL, la pantalla del depósito queda
 *      vacía para todos y los envíos con reloj se pierden ese día.
 *   3. Que un pedido impago quede invisible. Retiene stock —lo publicable es
 *      stock - reservado— así que tiene que aparecer en su propia pestaña, o
 *      nadie se entera de que esa prenda está secuestrada.
 *
 * Los pedidos entran por la cola de verdad, no armados a mano: un pedido sin
 * reserva real lo rechaza `despachar` por su cuenta y la prueba pasaría por el
 * motivo equivocado. Corre en proceso, sin HTTP, para no depender de qué backend
 * tenga el 3000.
 */

require('dotenv').config({ path: __dirname + '/../.env' });

const { Op } = require('sequelize');
const db = require('../src/config/database');
const {
  Business, ProductVariant, VariantStock, PedidoPlataforma, PedidoPlataformaItem, PlataformaCobro, IntegracionExterna,
} = require('../src/models');
const envios = require('../src/services/enviosDelDiaService');
const cola = require('../src/services/colaVentasOnlineService');
const { variantesPublicables, cantidadesPublicables } = require('../src/services/stockPublicableService');
const { localesQueAbastecenOnline } = require('../src/services/stockService');

const { requireIntegracion } = require('../src/middleware/integracion');
const ctrl = require('../src/controllers/integracionesController');
const integraciones = require('../src/services/integracionesService');

/* Entra por la puerta de verdad: credencial + controlador, sin HTTP. */
function llamar({ token, handler, params = {}, body = {}, query = {} }) {
  return new Promise((resolve, reject) => {
    const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, query, params, body, ip: '127.0.0.1' };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, json: payload }); },
    };
    const seguir = () => Promise.resolve(handler(req, res, reject)).catch(reject);
    Promise.resolve(requireIntegracion('tienda')(req, res, seguir)).catch(reject);
  });
}

let ok = 0;
let ko = 0;
const chk = (t, esperado, obtenido) => {
  const igual = JSON.stringify(esperado) === JSON.stringify(obtenido);
  console.log(`  ${igual ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${t}`);
  if (!igual) console.log(`      esperaba ${JSON.stringify(esperado)} · vino ${JSON.stringify(obtenido)}`);
  igual ? (ok += 1) : (ko += 1);
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const QA = 'QA-PAGO-';
let restaurarStock = null;

(async () => {
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } })
    || await Business.findOne({ order: [['id', 'ASC']] });

  const limpiar = async () => {
    const filas = await PedidoPlataforma.findAll({
      where: { pedidoExterno: { [Op.like]: `${QA}%` } }, attributes: ['id'],
    });
    if (filas.length) {
      await PlataformaCobro.destroy({ where: { pedidoId: filas.map((f) => f.id) } });
      await PedidoPlataformaItem.destroy({ where: { pedidoId: filas.map((f) => f.id) } });
      await PedidoPlataforma.destroy({ where: { id: filas.map((f) => f.id) } });
    }
  };
  await limpiar();

  try {
    tit('0. QUÉ ESTADO DE PAGO LE TOCA A CADA CANAL');
    /*
     * El default de la tienda es pendiente: falla cerrado. Un paquete retenido
     * se destraba con un clic; uno despachado sin cobrar no vuelve.
     */
    chk('la tienda, sin que el mensaje diga nada, queda pendiente',
      'pendiente', cola.__estadoDePago('tienda', null));
    chk('y si dice que ya está pagado, pagado', 'pagado', cola.__estadoDePago('tienda', false));
    /*
     * Lo que sostiene todo lo demás: para los canales que no informan pago el
     * estado es NULL, no 'pendiente'. Si acá saliera 'pendiente', el depósito se
     * quedaría sin ver un solo pedido de Mercado Libre.
     */
    chk('Mercado Libre no informa pago: NULL, no pendiente',
      [null, null], [cola.__estadoDePago('mercadolibre', null), cola.__estadoDePago('jumpseller', true)]);

    /* Stock conocido, para que los pedidos aparten de verdad. */
    const locales = await localesQueAbastecenOnline(negocio.id);
    const variantes = await variantesPublicables(negocio.id, { soloActivas: true });
    const esperadas = locales.length ? await cantidadesPublicables(negocio.id, locales, variantes) : new Map();
    const variante = variantes.find((v) => Number(esperadas.get(v.id)?.cantidad || 0) > 0) || variantes[0];
    const fila = await VariantStock.findOne({
      where: { productVariantId: variante.id }, order: [['locationId', 'ASC']],
    });
    chk('la prueba arranca con una fila de stock para apartar', true, Boolean(fila));
    restaurarStock = { id: fila.id, stock: fila.stock, reservado: fila.reservado };
    await fila.update({ stock: 30, reservado: 0 });

    const entrar = async (sufijo, datos) => {
      const r = await cola.encolarYProcesar({
        businessId: negocio.id,
        pedidoExterno: `${QA}${sufijo}`,
        items: [{ sku: variante.sku, cantidad: 1 }],
        total: 1000,
        envio: { tipo: 'correo_argentino', despacharAntesDe: new Date().toISOString() },
        ...datos,
      });
      return r.pedido;
    };

    tit('1. EL PAGO SE ESCRIBE AL ENTRAR, NO DESPUÉS');
    /*
     * Dentro del mismo INSERT. Si se escribiera en un update posterior, entre el
     * INSERT y ese update el pedido ya está aceptado y sin marca de pago, y en
     * esa ventana el depósito lo ve despachable.
     */
    const impago = await entrar('001', {
      plataforma: 'tienda', pagoPendiente: true, pagoDetalle: 'Transferencia · vence mañana',
    });
    chk('entra apartado y pendiente de pago', ['aceptado', 'pendiente'],
      [impago.estado, impago.pagoEstado]);
    chk('con el texto para la persona, tal cual lo mandó la tienda',
      'Transferencia · vence mañana', impago.pagoDetalle);
    chk('y con el reloj propio de Stocker puesto', true, Boolean(impago.pagoVenceEn));

    const pagado = await entrar('002', { plataforma: 'tienda', pagoPendiente: false });
    chk('uno que ya venía cobrado entra pagado y sin reloj', ['pagado', null],
      [pagado.pagoEstado, pagado.pagoVenceEn ?? null]);

    const deMl = await entrar('003', { plataforma: 'mercadolibre' });
    chk('Mercado Libre entra sin estado de pago', null, deMl.pagoEstado ?? null);

    tit('2. LA PUERTA DEL DEPÓSITO');
    const vista = await envios.delDia(negocio.id, { filtro: 'para_enviar' });
    const enLaLista = (r, nro) => (r.paquetes || []).some((q) => (q.items || []).length >= 0
      && String(JSON.stringify(q)).includes(nro));
    chk('el impago no está en «para enviar»', false, enLaLista(vista, `${QA}001`));
    chk('el pagado sí', true, enLaLista(vista, `${QA}002`));
    chk('y el de Mercado Libre también: su pago en NULL no lo saca', true,
      enLaLista(vista, `${QA}003`));

    const soloImpagos = await envios.delDia(negocio.id, { filtro: 'sin_pagar' });
    chk('el impago aparece en «sin pagar», no invisible', true, enLaLista(soloImpagos, `${QA}001`));

    const despachar = async (p) => {
      try {
        await envios.despachar({ businessId: negocio.id, pedidoId: p.id, employeeId: null });
        return 'pasó';
      } catch (e) { return { status: e.status, codigo: e.codigo || null }; }
    };

    /*
     * La puerta va DENTRO de despachar. El filtro de la lista es una comodidad:
     * las rutas de despachar toman el id del cuerpo y nunca pasan por la lista,
     * así que alguien con el id —un reintento viejo, una pantalla abierta de
     * antes— despacharía mercadería impaga.
     */
    chk('despachar el impago por su id se corta con SIN_PAGAR',
      { status: 409, codigo: 'SIN_PAGAR' }, await despachar(impago));
    chk('y el mensaje trae el texto del pago, para que la pantalla diga por qué',
      true, await (async () => {
        try { await envios.despachar({ businessId: negocio.id, pedidoId: impago.id, employeeId: null }); return false; } catch (e) { return /Transferencia/.test(e.message); }
      })());
    chk('el pagado se despacha', 'pasó', await despachar(pagado));
    chk('y el de Mercado Libre también', 'pasó', await despachar(deMl));

    tit('3. EL COBRO');
    /*
     * El caso simple: cubre el total y abre la puerta.
     */
    const aCobrar = await entrar('010', {
      plataforma: 'tienda', pagoPendiente: true, pagoDetalle: 'Transferencia · vence mañana',
    });
    const cobrar = (datos) => cola.registrarCobro({
      businessId: negocio.id, plataforma: 'tienda', ...datos,
    });
    const uno = await cobrar({
      movimientoExterno: `${QA}010-C1`, pedidoExterno: `${QA}010`,
      importe: 1000, medio: 'mercadopago', operacion: 'MP-1',
    });
    chk('un cobro que cubre el total deja el pedido pagado', ['pagado', true],
      [uno.pedido.pagoEstado, Boolean(uno.cobro.aplicado)]);
    chk('y el texto del pago se limpia', null, uno.pedido.pagoDetalle);
    chk('y ya no hay plazo que vencer', null, uno.pedido.pagoVenceEn);
    let seDespacha = null;
    try {
      await envios.despachar({ businessId: negocio.id, pedidoId: aCobrar.id, employeeId: null });
      seDespacha = 'pasó';
    } catch (e) { seDespacha = `cortó ${e.status} ${e.codigo || ''}`.trim(); }
    chk('y el depósito ya lo puede despachar', 'pasó', seDespacha);

    /*
     * El mismo cobro reenviado no cobra dos veces. Es la garantía que el contrato
     * promete y la que un aviso repetido de la pasarela pone a prueba.
     */
    const otraVez = await cobrar({
      movimientoExterno: `${QA}010-C1`, pedidoExterno: `${QA}010`,
      importe: 1000, medio: 'mercadopago', operacion: 'MP-1',
    });
    chk('reenviar el mismo cobro no suma de nuevo', [true, 1000],
      [Boolean(otraVez.repetido), Number(otraVez.pedido.cobrado)]);

    /*
     * La seña y el resto: dos cobros del mismo pedido que suman. Es la razón por la
     * que los cobros son una tabla y no dos columnas en el pedido.
     */
    const conSeña = await entrar('011', { plataforma: 'tienda', pagoPendiente: true });
    const senia = await cobrar({
      movimientoExterno: `${QA}011-C1`, pedidoExterno: `${QA}011`, importe: 400, medio: 'transferencia',
    });
    chk('una seña deja el pedido pendiente y lo dice', ['pendiente', true],
      [senia.pedido.pagoEstado, /Cobrado 400 de 1000/.test(senia.pedido.pagoDetalle || '')]);
    let siguePendiente = null;
    try {
      await envios.despachar({ businessId: negocio.id, pedidoId: conSeña.id, employeeId: null });
      siguePendiente = 'PASÓ';
    } catch (e) { siguePendiente = e.codigo; }
    chk('y con la seña sola NO se despacha', 'SIN_PAGAR', siguePendiente);
    const resto = await cobrar({
      movimientoExterno: `${QA}011-C2`, pedidoExterno: `${QA}011`, importe: 600, medio: 'transferencia',
    });
    chk('el resto completa y pasa a pagado', ['pagado', 1000],
      [resto.pedido.pagoEstado, Number(resto.pedido.cobrado)]);

    /*
     * Pagar de más no retiene el paquete: el cliente puso unos pesos extra y eso no
     * es razón para que su pedido no salga.
     */
    const deMas = await entrar('012', { plataforma: 'tienda', pagoPendiente: true });
    const conVuelto = await cobrar({
      movimientoExterno: `${QA}012-C1`, pedidoExterno: `${QA}012`, importe: 1500, medio: 'efectivo',
    });
    chk('pagar de más deja el pedido pagado igual', 'pagado', conVuelto.pedido.pagoEstado);

    tit('4. EL COBRO QUE LLEGA CUANDO YA NO HAY NADA QUE COBRAR');
    /*
     * Lo más importante de esta suite. Vence el plazo, la tienda cancela, y el
     * aviso de Mercado Pago llega dos segundos tarde. Con transferencias a 48 h es
     * rutina, no un caso raro.
     *
     * Si Stocker contestara un error, la tienda —que reintenta sobre todo lo que no
     * sea 2xx— pegaría para siempre y el pago no quedaría anotado en ninguna parte:
     * el cliente pagó y nadie sabría que hay que devolverle la plata.
     */
    const cancelado = await entrar('020', { plataforma: 'tienda', pagoPendiente: true });
    await cola.cancelarPorPlataforma(cancelado.id, 'Venció el plazo');
    /*
     * Se atrapa a propósito: si Stocker contestara un error acá, la prueba tiene
     * que decir QUÉ error y seguir, no morirse y dejar el resto sin correr.
     */
    const tarde = await cobrar({
      movimientoExterno: `${QA}020-C1`, pedidoExterno: `${QA}020`, importe: 1000, medio: 'mercadopago',
    }).catch((e) => ({ cobro: { aplicado: null, motivo: `RECHAZADO con ${e.status}` }, pedido: {} }));
    /* Estricto: un `null` significaría que no se guardó, y `Boolean(null)` lo
     * dejaría pasar como si se hubiera guardado sin aplicar. */
    chk('un cobro sobre un pedido cancelado se GUARDA, sin aplicarse', false,
      tarde.cobro.aplicado === true ? true : tarde.cobro.aplicado);
    chk('con el motivo escrito, que es lo único que avisa que hay que devolver', true,
      /devolver/i.test(tarde.cobro.motivo || ''));
    chk('y el pedido no vuelve a quedar pagado', true,
      tarde.pedido.pagoEstado !== 'pagado');

    /*
     * La misma referencia de pasarela con otro id de movimiento: puede ser un doble
     * cobro, o dos transferencias que alguien anotó igual. Se guarda sin aplicar en
     * vez de rechazarse, porque un índice único acá rechazaría un cobro real.
     */
    const conRefeRepetida = await entrar('021', { plataforma: 'tienda', pagoPendiente: true });
    const repetida = await cobrar({
      movimientoExterno: `${QA}021-C1`, pedidoExterno: `${QA}021`,
      importe: 1000, medio: 'mercadopago', operacion: 'MP-1',
    });
    chk('una operación ya usada no se aplica sola', [false, true],
      [Boolean(repetida.cobro.aplicado), /ya estaba registrada/.test(repetida.cobro.motivo || '')]);

    tit('5. LO QUE SÍ SE RECHAZA');
    const malo = async (datos) => {
      try { await cobrar(datos); return 'PASÓ'; } catch (e) { return e.status; }
    };
    chk('un importe en cero se rechaza', 400,
      await malo({ movimientoExterno: `${QA}x1`, pedidoExterno: `${QA}012`, importe: 0, medio: 'x' }));
    chk('un importe que no es número, también', 400,
      await malo({ movimientoExterno: `${QA}x2`, pedidoExterno: `${QA}012`, importe: 'mil', medio: 'x' }));
    chk('sin medio de pago, también', 400,
      await malo({ movimientoExterno: `${QA}x3`, pedidoExterno: `${QA}012`, importe: 10, medio: '' }));
    chk('un pedido que no existe da 404', 404,
      await malo({ movimientoExterno: `${QA}x4`, pedidoExterno: `${QA}no-existe`, importe: 10, medio: 'x' }));

    tit('5b. EL SOBRE DEL CONTRATO, POR LA RUTA DE VERDAD');
    /*
     * Acá está la trampa que una revisión de diseño encontró antes de que se
     * escribiera esto, y que el resto de la suite no ve porque llama al servicio
     * directo.
     *
     * `abrirSobre` rellena `pedidoExterno` con el `id` del sobre sin prefijo, que
     * para un cobro es el id DEL COBRO ("ISU-1042-C1") y no el del pedido. Un
     * controlador que buscara el pedido con eso daría 404 SIEMPRE y ningún cobro de
     * la tienda se registraría nunca. El pedido tiene que salir de `datos.ventaId`,
     * y encima hay que sacarle el prefijo a mano porque abrirSobre no lo toca.
     */
    const { token } = await integraciones.emitir({
      businessId: negocio.id, origen: 'tienda', nombre: 'QA pago cobros',
    });
    const porSobre = await entrar('040', { plataforma: 'tienda', pagoPendiente: true });
    const r = await llamar({
      token, handler: ctrl.cobroDeTienda,
      body: {
        contrato: 1, tipo: 'cobro', id: `isu:${QA}040-C1`,
        datos: { ventaId: `isu:${QA}040`, importe: 1000, medio: 'mercadopago', operacion: 'MP-SOBRE-1' },
      },
    }).catch((e) => ({ status: e.status, json: null }));
    chk('un cobro en sobre encuentra su pedido y no da 404', 201, r.status);
    chk('y lo deja pagado', ['pagado', true], [r.json?.pagoEstado, Boolean(r.json?.aplicado)]);
    chk('el movimiento se guarda sin el prefijo de la plataforma', `${QA}040-C1`,
      r.json?.movimientoExterno);
    await porSobre.reload();
    chk('y es ESE pedido el que quedó pagado, no otro', 'pagado', porSobre.pagoEstado);

    tit('6. EL RELOJ PROPIO DE STOCKER');
    /*
     * La plataforma dice que va a cancelar cuando el plazo venza. Esto es para el
     * día que no lo haga: si no, la mercadería queda apartada para siempre y
     * desaparece de la vidriera sin que nadie sepa por qué.
     */
    const vencido = await entrar('030', { plataforma: 'tienda', pagoPendiente: true });
    await vencido.update({ pagoVenceEn: new Date(Date.now() - 60 * 60 * 1000) });
    const aTiempo = await entrar('031', { plataforma: 'tienda', pagoPendiente: true });
    await aTiempo.update({ pagoVenceEn: new Date(Date.now() + 60 * 60 * 1000) });
    await cola.liberarPagosVencidos();
    await vencido.reload(); await aTiempo.reload();
    chk('el vencido se cancela y libera la mercadería', 'cancelado', vencido.estado);
    chk('y el que todavía tiene plazo no se toca', 'aceptado', aTiempo.estado);
  } finally {
    tit('Limpieza');
    await limpiar();
    if (restaurarStock) {
      await VariantStock.update(
        { stock: restaurarStock.stock, reservado: restaurarStock.reservado },
        { where: { id: restaurarStock.id } },
      );
    }
    await IntegracionExterna.destroy({ where: { nombre: 'QA pago cobros' } });
    chk('no queda nada de la prueba', 0,
      await PedidoPlataforma.count({ where: { pedidoExterno: { [Op.like]: `${QA}%` } } }));
    await db.close();
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
