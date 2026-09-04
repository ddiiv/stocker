/*
 * La jornada del depósito: qué sale hoy y qué hay que ir a buscar.
 *
 * Es la segunda mitad de la reserva. Un pedido online aparta la mercadería —la
 * prenda sigue en el estante, comprometida— y acá es donde esa reserva se
 * convierte en salida, cuando el paquete efectivamente sale.
 *
 * Lo que se comprueba:
 *
 *   · El consolidado agrupa: veinte pedidos con la misma remera dan UN renglón
 *     con veinte unidades. Es la diferencia entre caminar el depósito una vez o
 *     veinte, y con Flex esa diferencia se paga en reputación.
 *   · Despachar baja el estante, suelta la reserva y deja el renglón en el
 *     libro. Las tres cosas o ninguna.
 *   · Despachar dos veces no descuenta dos veces.
 *   · El faltante NO toca el stock: el egreso nunca ocurrió.
 *   · Los envíos de otro negocio no se ven ni se despachan.
 *
 * Uso:  API=http://localhost:3000 node scripts/test-envios-dia.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const { Op } = require('sequelize');
const API = process.env.API || 'http://localhost:3000';
const {
  Business, BusinessLocation, Product, ProductVariant, VariantStock, StockMovement,
  PedidoPlataforma, PedidoPlataformaItem,
} = require('../src/models');
const stock = require('../src/services/stockService');
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
    const tipo = r.headers.get('content-type') || '';
    if (tipo.includes('pdf')) {
      return { status: r.status, buffer: Buffer.from(await r.arrayBuffer()), headers: r.headers };
    }
    let json = null; try { json = JSON.parse(await r.text()); } catch { /* no json */ }
    return { status: r.status, json };
  };
}

(async () => {
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  const local = await BusinessLocation.findOne({
    where: { businessId: negocio.id, tipo: 'local', abasteceOnline: true, activo: true },
  });
  if (!local) { console.log('Hace falta un local que abastezca ventas online.'); process.exit(1); }

  const limpiar = async () => {
    const p = await PedidoPlataforma.findAll({ where: { pedidoExterno: { [Op.like]: 'QA-ENV-%' } } });
    await PedidoPlataformaItem.destroy({ where: { pedidoId: p.map((x) => x.id) } });
    await PedidoPlataforma.destroy({ where: { id: p.map((x) => x.id) } });
  };
  await limpiar();
  await ProductVariant.destroy({ where: { sku: { [Op.like]: 'QA-ENV-%' } } });
  await Product.destroy({ where: { sku: { [Op.like]: 'QA-ENV%' } } });

  const prod = await Product.create({
    businessId: negocio.id, sku: 'QA-ENV', skuAgrupador: 'QA-ENV', titulo: 'QA Remera',
    precioMinorista: 1000, precioMayorista: 1000, costo: 300, activo: true,
  });
  const vA = await ProductVariant.create({
    productId: prod.id, businessId: negocio.id, sku: 'QA-ENV-M',
    variante1Nombre: 'Talle', variante1Valor: 'M', stock: 0, stockMinimo: 0,
  });
  const vB = await ProductVariant.create({
    productId: prod.id, businessId: negocio.id, sku: 'QA-ENV-L',
    variante1Nombre: 'Talle', variante1Valor: 'L', stock: 0, stockMinimo: 0,
  });
  for (const v of [vA, vB]) {
    await stock.mover({ variantId: v.id, businessId: negocio.id, locationId: local.id,
      delta: 30, tipo: 'ingreso', motivo: 'QA envíos' });
  }

  const api = sesion();
  const entro = await api('POST', '/api/auth/login', { email: negocio.email, password: 'Demo2026!!' });
  if (entro.status !== 200) { console.log('No se pudo entrar:', entro.status); process.exit(1); }

  const estante = (v) => stock.stockEn(v.id, local.id);
  const apartado = async (v) => {
    const f = await VariantStock.findOne({ where: { productVariantId: v.id, locationId: local.id } });
    return Number(f?.reservado) || 0;
  };

  const fijarStock = async (v, n) => {
    const f = await VariantStock.findOne({ where: { productVariantId: v.id, locationId: local.id } });
    const ap = Number(f?.reservado) || 0;
    if (ap > 0) await stock.liberarReserva(v.id, local.id, negocio.id, ap);
    await stock.mover({ variantId: v.id, businessId: negocio.id, locationId: local.id,
      fijar: n, tipo: 'ajuste', motivo: 'QA envíos' });
  };

  /*
   * Un paquete ya no ES una venta: puede llevar varias, porque Mercado Libre
   * junta compras del mismo comprador en un solo envío. Buscarlo por el número
   * de una de sus ventas es lo que se hace en la pantalla también.
   */
  const paqueteDe = (j, externo) =>
    (j?.json?.paquetes || j?.paquetes || []).find(
      (p) => (p.ventas || []).some((v) => v.pedidoExterno === externo),
    );
  const esDeQA = (p) => (p.ventas || []).some((v) => v.pedidoExterno?.startsWith('QA-ENV-'));

  const pedir = async (externo, items, extra = {}) => {
    const r = await api('POST', '/api/online/pedidos', {
      plataforma: 'mercadolibre', pedidoExterno: externo,
      comprador: { nombre: `Comprador ${externo}` },
      items, ...extra,
    });
    return r;
  };

  try {
    tit('1. LOS PEDIDOS DEL DÍA APARECEN, Y APARTAN SIN DESCONTAR');
    const antes = await estante(vA);
    const p1 = await pedir('QA-ENV-1', [{ sku: 'QA-ENV-M', cantidad: 2 }]);
    const p2 = await pedir('QA-ENV-2', [{ sku: 'QA-ENV-M', cantidad: 3 }, { sku: 'QA-ENV-L', cantidad: 1 }]);
    chk('los dos pedidos entran', [201, 201], [p1.status, p2.status]);
    chk('el estante NO se movió', antes, await estante(vA));
    chk('pero quedaron 5 apartadas del talle M', 5, await apartado(vA));

    const jornada = await api('GET', '/api/envios/del-dia');
    chk('la jornada responde', 200, jornada.status);
    const mios = (jornada.json?.paquetes || []).filter(esDeQA);
    chk('y trae los dos paquetes', 2, mios.length);
    chk('con el comprador', 'Comprador QA-ENV-1', paqueteDe(jornada, 'QA-ENV-1')?.comprador);
    chk('y en estado pendiente', ['pendiente', 'pendiente'], mios.map((p) => p.estadoEnvio));

    tit('2. EL CONSOLIDADO AGRUPA: UN RECORRIDO, NO UNO POR PEDIDO');
    /*
     * Es el punto de la lista. Dos pedidos con la misma remera talle M dan UN
     * renglón de 5, no dos renglones de 2 y 3.
     */
    const cons = (jornada.json?.consolidado || []).filter((l) => l.sku.startsWith('QA-ENV-'));
    const eme = cons.find((l) => l.sku === 'QA-ENV-M');
    chk('el talle M queda en un solo renglón', 1, cons.filter((l) => l.sku === 'QA-ENV-M').length);
    chk('con las 5 unidades sumadas', 5, eme?.unidades);
    chk('y dice en cuántos paquetes se reparte', 2, eme?.enPaquetes);
    chk('el talle L va aparte', 1, cons.find((l) => l.sku === 'QA-ENV-L')?.unidades);
    chk('cada renglón dice de qué local sale', local.nombre, eme?.local);

    tit('3. DESPACHAR: LA RESERVA SE CONVIERTE EN SALIDA');
    const idP1 = paqueteDe(jornada, 'QA-ENV-1').id;
    const estanteAntes = await estante(vA);
    const apartadoAntes = await apartado(vA);

    const desp = await api('POST', `/api/envios/${idP1}/despachar`);
    chk('el despacho entra', 200, desp.status);
    chk('y dice cuántas unidades salieron', 2, desp.json?.unidades);
    chk('el estante baja 2', estanteAntes - 2, await estante(vA));
    chk('y la reserva se suelta', apartadoAntes - 2, await apartado(vA));

    const mov = await StockMovement.findOne({
      where: { productVariantId: vA.id, motivo: { [Op.like]: '%QA-ENV-1%' } },
      order: [['id', 'DESC']],
    });
    chk('quedó el renglón en el libro', 'egreso', mov?.tipo);
    chk('con las unidades que salieron', 2, Number(mov?.cantidad));
    chk('y los números del antes y el después', [estanteAntes, estanteAntes - 2],
      [Number(mov?.stockAnterior), Number(mov?.stockNuevo)]);

    tit('4. DESPACHAR DOS VECES NO DESCUENTA DOS VECES');
    /*
     * El botón se toca dos veces, la conexión del depósito se corta y se
     * reintenta. Descontar de nuevo sería sacar del estante mercadería que ya
     * salió.
     */
    const trasUno = await estante(vA);
    const otra = await api('POST', `/api/envios/${idP1}/despachar`);
    chk('la segunda vez responde igual', 200, otra.status);
    chk('avisando que ya estaba', true, otra.json?.repetido);
    chk('y sin mover el estante', trasUno, await estante(vA));

    tit('5. LO DESPACHADO SALE DEL RECORRIDO');
    const jornada2 = await api('GET', '/api/envios/del-dia');
    const sigue = (jornada2.json?.consolidado || []).find((l) => l.sku === 'QA-ENV-M');
    chk('el consolidado baja a lo que falta buscar', 3, sigue?.unidades);
    chk('y el paquete despachado ya no está en la lista', false,
      (jornada2.json?.paquetes || []).some((p) => p.id === idP1));

    const conTodo = await api('GET', '/api/envios/del-dia?incluirDespachados=1');
    const elDespachado = (conTodo.json?.paquetes || []).find((p) => p.id === idP1);
    chk('pero se puede ver la jornada completa', 'despachado', elDespachado?.estadoEnvio);

    tit('6. EL FALTANTE NO TOCA EL STOCK');
    /*
     * El egreso nunca ocurrió, así que el estante sigue diciendo la verdad. La
     * diferencia entre lo que el sistema cree y lo que se encontró se resuelve
     * con un recuento, no desde la pantalla de picking.
     */
    const idP2 = paqueteDe(jornada, 'QA-ENV-2').id;
    const antesFalta = [await estante(vA), await apartado(vA)];
    const falt = await api('POST', `/api/envios/${idP2}/faltante`, { nota: 'No está en la percha' });
    chk('se marca el faltante', 200, falt.status);
    chk('sin mover el estante ni la reserva', antesFalta, [await estante(vA), await apartado(vA)]);
    chk('y se dice explícitamente que no se tocó el stock', true,
      /stock no se modificó/i.test(falt.json?.mensaje || ''));
    const releido = await PedidoPlataforma.findByPk(idP2);
    chk('el paquete queda marcado', 'con_faltante', releido.estadoEnvio);
    chk('con la nota de quien lo buscó', true, /No está en la percha/.test(releido.motivo || ''));

    chk('un paquete ya despachado no se puede marcar como faltante', 409,
      (await api('POST', `/api/envios/${idP1}/faltante`, { nota: 'tarde' })).status);

    tit('7. UN SKU QUE NO ESTÁ EN STOCKER SE MUESTRA MARCADO');
    /*
     * No se puede pickear lo que el sistema no conoce, pero esconderlo es peor:
     * el paquete lleva esa prenda igual y alguien tiene que darla de alta o
     * cancelar la venta.
     */
    const conRaro = await pedir('QA-ENV-3', [
      { sku: 'QA-ENV-L', cantidad: 1 },
      { sku: 'NO-EXISTE-EN-STOCKER', cantidad: 1 },
    ]);
    chk('el pedido entra como parcial', 200, conRaro.status);
    const j3 = await api('GET', '/api/envios/del-dia');
    const elRaro = paqueteDe(j3, 'QA-ENV-3');
    chk('el paquete aparece en la jornada', true, Boolean(elRaro));
    const lineaRara = (elRaro?.items || []).find((i) => i.sku === 'NO-EXISTE-EN-STOCKER');
    chk('y la línea desconocida viene marcada', true, lineaRara?.sinResolver);

    tit('8. EL PDF SALE Y DICE QUÉ TRAE');
    const pdf = await api('GET', '/api/envios/del-dia/pdf');
    chk('responde 200', 200, pdf.status);
    chk('y es un PDF', '%PDF', pdf.buffer?.slice(0, 4).toString());
    /*
     * La hoja imprime lo que hay que preparar, no la jornada entera: es la
     * herramienta con la que se camina el depósito, y un entregado de ayer en
     * el medio es ruido que se lee parado y con las manos ocupadas.
     */
    chk('con la cuenta de paquetes en la cabecera', true,
      Number(pdf.headers.get('x-paquetes')) >= 1);
    chk('y de unidades', true, Number(pdf.headers.get('x-unidades')) >= 1);

    // Y respeta el filtro: pidiendo todo, trae más que pidiendo lo pendiente.
    const pdfTodo = await api('GET', '/api/envios/del-dia/pdf?filtro=todos');
    chk('el PDF respeta el filtro', true,
      Number(pdfTodo.headers.get('x-paquetes')) >= Number(pdf.headers.get('x-paquetes')));

    tit('9. LOS ENVÍOS DE OTRO NEGOCIO NO SE TOCAN');
    const otroNegocio = await Business.findOne({ where: { id: { [Op.ne]: negocio.id } } });
    if (otroNegocio) {
      const ajeno = await PedidoPlataforma.create({
        businessId: otroNegocio.id, plataforma: 'mercadolibre',
        pedidoExterno: 'QA-ENV-AJENO', estado: 'aceptado', recibidoEn: new Date(),
      });
      const j = await api('GET', '/api/envios/del-dia?incluirDespachados=1');
      chk('no aparece en la jornada', false,
        (j.json?.paquetes || []).some((p) => p.id === ajeno.id));
      chk('no se puede despachar', 404,
        (await api('POST', `/api/envios/${ajeno.id}/despachar`)).status);
      chk('ni marcar como faltante', 404,
        (await api('POST', `/api/envios/${ajeno.id}/faltante`, {})).status);
      await ajeno.destroy();
    } else {
      console.log('  (no hay otro negocio cargado: se saltea)');
    }

    tit('10. UNA RESERVA QUE YA NO ESTÁ SE AVISA, NO SE INVENTA');
    /*
     * Si alguien soltó la reserva por afuera —una cancelación, un ajuste—,
     * despachar no puede descontar igual: sería sacar del estante mercadería
     * que ya no estaba comprometida.
     */
    const p4 = await pedir('QA-ENV-4', [{ sku: 'QA-ENV-L', cantidad: 1 }]);
    const j4 = await api('GET', '/api/envios/del-dia');
    const idP4 = paqueteDe(j4, 'QA-ENV-4')?.id;
    chk('el pedido entra', 201, p4.status);

    /*
     * Se sueltan TODAS las reservas de esa variante, no una.
     *
     * `reservado` es un total por variante y local, no una etiqueta por pedido:
     * soltar una sola dejaba las de los pedidos anteriores, y `consumirReserva`
     * tomaba una de ésas. El número quedaba bien —lo apartado y lo despachado
     * cierran igual— pero no era lo que esta prueba quería probar.
     *
     * Que sea un total y no una etiqueta es a propósito: qué pedido tiene
     * apartado qué ya está en sus ítems, y duplicarlo en la fila de stock sería
     * dos verdades que se pueden separar.
     */
    const apartadoB = await apartado(vB);
    if (apartadoB > 0) await stock.liberarReserva(vB.id, local.id, negocio.id, apartadoB);
    chk('no queda nada apartado de esa variante', 0, await apartado(vB));
    const estanteB = await estante(vB);
    const err = await api('POST', `/api/envios/${idP4}/despachar`);
    chk('el despacho se frena', 409, err.status);
    chk('con su código', 'RESERVA_PERDIDA', err.json?.codigo);
    chk('y sin haber movido el estante', estanteB, await estante(vB));

    tit('11. LOS FILTROS DEL CIRCUITO');
    /*
     * Quien mira esta pantalla no pregunta "¿incluyo los despachados?":
     * pregunta qué le falta enviar, qué está en camino, qué se canceló. Son
     * estados de un circuito y mezclan dos campos —el del depósito y el que
     * informa ML—, y por eso se resuelven acá y no en la pantalla.
     */
    const jFiltros = await api('GET', '/api/envios/del-dia?filtro=todos');
    chk('el filtro "todos" trae la jornada entera', true,
      (jFiltros.json?.paquetes || []).length >= 3);
    chk('y viene la cuenta por estado', true,
      typeof jFiltros.json?.porEstado?.para_enviar === 'number');

    const paraEnviar = await api('GET', '/api/envios/del-dia?filtro=para_enviar');
    chk('"para enviar" no trae los despachados', false,
      (paraEnviar.json?.paquetes || []).some((p) => p.situacion !== 'para_enviar'));

    const enCamino = await api('GET', '/api/envios/del-dia?filtro=en_camino');
    chk('"en camino" trae el que despachamos', true,
      (enCamino.json?.paquetes || []).some((p) => p.id === idP1));

    const conFaltante = await api('GET', '/api/envios/del-dia?filtro=con_faltante');
    chk('"con faltante" trae el que no se encontró', true,
      (conFaltante.json?.paquetes || []).some((p) => p.id === idP2));

    /*
     * Lo que informa ML manda sobre lo nuestro: un paquete que despachamos y
     * que ML dice entregado ya no está "en camino".
     */
    await PedidoPlataforma.update({ estadoEnvioMl: 'delivered' }, { where: { id: idP1 } });
    const entregados = await api('GET', '/api/envios/del-dia?filtro=entregado');
    chk('un despachado que ML da por entregado pasa a "entregado"', true,
      (entregados.json?.paquetes || []).some((p) => p.id === idP1));
    const enCamino2 = await api('GET', '/api/envios/del-dia?filtro=en_camino');
    chk('y sale de "en camino"', false,
      (enCamino2.json?.paquetes || []).some((p) => p.id === idP1));

    await PedidoPlataforma.update({ estadoEnvioMl: 'cancelled' }, { where: { id: idP2 } });
    const cancelados = await api('GET', '/api/envios/del-dia?filtro=cancelado');
    chk('un cancelado en ML aparece como cancelado', true,
      (cancelados.json?.paquetes || []).some((p) => p.id === idP2));

    tit('12. EL ALCANCE: HOY Y LOS PRÓXIMOS DÍAS');
    /*
     * Un pedido con corte mañana no es de otro estado, es de otro día. Sin
     * alcance, prepararlo con tiempo es imposible: no se ve hasta que ya apura.
     */
    const manana = new Date(Date.now() + 26 * 3600 * 1000);
    await PedidoPlataforma.update(
      { despacharAntesDe: manana },
      { where: { pedidoExterno: 'QA-ENV-3' } },
    );
    const soloHoy = await api('GET', '/api/envios/del-dia?filtro=todos');
    chk('con alcance de hoy, el de mañana no aparece', false,
      Boolean(paqueteDe(soloHoy, 'QA-ENV-3')));

    const conManana = await api('GET', '/api/envios/del-dia?filtro=todos&diasAdelante=7');
    chk('mirando la semana, sí', true,
      Boolean(paqueteDe(conManana, 'QA-ENV-3')));
    chk('y el alcance viene en la respuesta', 7, conManana.json?.dias);

    // El tope existe para que nadie pida el año entero y barra la tabla.
    const exagerado = await api('GET', '/api/envios/del-dia?filtro=todos&diasAdelante=9999');
    chk('un alcance disparatado se acota a 30 días', 30, exagerado.json?.dias);

    tit('12b. LOS QUE SE PASARON DE LA HORA');
    /*
     * Flex tiene hora de corte. Pasada esa hora el envío se cae del día y hay
     * que reprogramarlo con el comprador, así que hay que verlo.
     *
     * Antes la pantalla mostraba la hora y nada más: a las 21:00 un corte de
     * las 18:00 se veía igual que uno de las 23:00, y sólo se notaba comparando
     * cada envío contra el reloj, de a uno, en la hoja impresa.
     */
    const hacePocasHoras = new Date(Date.now() - 3 * 3600 * 1000);
    /*
     * Se lo pone explícitamente en "pendiente": bloques anteriores lo
     * despacharon, y un paquete que ya salió no se marca atrasado a propósito.
     */
    await PedidoPlataforma.update(
      { despacharAntesDe: hacePocasHoras, envioTipo: 'flex',
        estadoEnvio: 'pendiente', estadoEnvioMl: null },
      { where: { pedidoExterno: 'QA-ENV-1' } },
    );
    const conAtraso = await api('GET', '/api/envios/del-dia?filtro=todos&diasAdelante=7');
    const tarde = paqueteDe(conAtraso, 'QA-ENV-1');
    chk('el que se pasó de hora viene marcado', true, tarde?.atrasado);
    chk('y dice cuánto hace, en minutos negativos', true,
      tarde?.minutosParaElCorte < -170 && tarde?.minutosParaElCorte > -190);
    chk('el resumen lo cuenta', 1, conAtraso.json?.resumen?.atrasados);

    // Uno con el corte más tarde no está atrasado.
    const enUnRato = new Date(Date.now() + 3 * 3600 * 1000);
    await PedidoPlataforma.update(
      { despacharAntesDe: enUnRato },
      { where: { pedidoExterno: 'QA-ENV-2' } },
    );
    const otro = paqueteDe(
      await api('GET', '/api/envios/del-dia?filtro=todos&diasAdelante=7'), 'QA-ENV-2',
    );
    chk('el que todavía tiene tiempo, no', false, otro?.atrasado);
    chk('y le faltan minutos, en positivo', true, otro?.minutosParaElCorte > 170);

    /*
     * Un paquete ya despachado no se marca atrasado. Salió tarde, sí, pero hoy
     * ya no hay nada que hacer con eso, y pintarlo tapa los que sí se salvan.
     */
    await PedidoPlataforma.update(
      { estadoEnvio: 'despachado' },
      { where: { pedidoExterno: 'QA-ENV-1' } },
    );
    const yaSalio = paqueteDe(
      await api('GET', '/api/envios/del-dia?filtro=todos&diasAdelante=7'), 'QA-ENV-1',
    );
    chk('el despachado no se marca atrasado', false, yaSalio?.atrasado);
    chk('y el resumen deja de contarlo', 0,
      (await api('GET', '/api/envios/del-dia?filtro=todos&diasAdelante=7'))
        .json?.resumen?.atrasados);
    await PedidoPlataforma.update(
      { estadoEnvio: 'pendiente', despacharAntesDe: null, envioTipo: null },
      { where: { pedidoExterno: 'QA-ENV-1' } },
    );
    await PedidoPlataforma.update(
      { despacharAntesDe: null },
      { where: { pedidoExterno: 'QA-ENV-2' } },
    );

    tit('13. UN ENVÍO QUE JUNTA VARIAS VENTAS ES UNA SOLA CAJA');
    /*
     * Mercado Libre agrupa varias compras del mismo comprador en un solo envío.
     * Si la lista mostrara una caja por venta, el depósito prepararía tres
     * bultos donde va uno: tres etiquetas y un comprador que recibe su compra
     * partida en pedazos.
     *
     * Y despachar tiene que sacarlas a todas: la caja sale una sola vez, y
     * marcar una dejaría a las otras con la mercadería apartada para siempre,
     * esperando un despacho que ya ocurrió.
     */
    await fijarStock(vA, 20);
    const a1 = await pedir('QA-ENV-J1', [{ sku: 'QA-ENV-M', cantidad: 1 }]);
    const a2 = await pedir('QA-ENV-J2', [{ sku: 'QA-ENV-M', cantidad: 2 }]);
    chk('las dos ventas entran', [201, 201], [a1.status, a2.status]);

    // Las dos comparten envío, como las manda ML.
    await PedidoPlataforma.update(
      { envioId: '9001', envioTipo: 'flex' },
      { where: { pedidoExterno: ['QA-ENV-J1', 'QA-ENV-J2'] } },
    );

    const jJunta = await api('GET', '/api/envios/del-dia?filtro=todos');
    const caja = (jJunta.json?.paquetes || []).find((p) => p.envioId === '9001');
    chk('las dos ventas salen en UNA caja', true, Boolean(caja));
    chk('con las dos adentro', 2, caja?.ventas?.length);
    chk('y todo lo que hay que juntar junto', 3,
      (caja?.items || []).reduce((n, i) => n + i.cantidad, 0));
    chk('sin aparecer también por separado', 1,
      (jJunta.json?.paquetes || []).filter((p) => p.envioId === '9001').length);

    const antesJunta = await estante(vA);
    const despJunta = await api('POST', `/api/envios/${caja.id}/despachar`);
    chk('despachar la caja entra', 200, despJunta.status);
    chk('y avisa que salieron dos ventas', 2, despJunta.json?.ventas);
    chk('el estante baja las 3 de una', antesJunta - 3, await estante(vA));

    const lasDos = await PedidoPlataforma.findAll({
      where: { pedidoExterno: ['QA-ENV-J1', 'QA-ENV-J2'] },
    });
    chk('las dos ventas quedan despachadas', ['despachado', 'despachado'],
      lasDos.map((p) => p.estadoEnvio).sort());
    chk('sin dejar reservas colgadas', 0, await apartado(vA));

  } finally {
    tit('Limpieza');
    await limpiar();
    await StockMovement.destroy({ where: { productVariantId: [vA.id, vB.id] } });
    await VariantStock.destroy({ where: { productVariantId: [vA.id, vB.id] } });
    await ProductVariant.destroy({ where: { id: [vA.id, vB.id] } });
    await Product.destroy({ where: { id: prod.id } });
    chk('no quedan pedidos de prueba', 0,
      await PedidoPlataforma.count({ where: { pedidoExterno: { [Op.like]: 'QA-ENV-%' } } }));
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
