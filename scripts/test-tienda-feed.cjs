/*
 * El feed de resoluciones: que la tienda se entere de todo y una sola vez.
 *
 * La tienda pregunta "qué cambió desde acá" cada uno o dos minutos y con eso le
 * manda el mail y el WhatsApp al comprador. Las dos formas de fallar son
 * simétricas y las dos son caras: perder un cambio deja a un cliente sin aviso de
 * que su pedido salió, y repetir un cambio le manda el mismo mail dos veces.
 *
 * Lo que esta suite cuida, en orden de lo que más cuesta descubrir después:
 *
 *   1. El cursor compuesto. Dos pedidos pueden tener la MISMA `novedadEn` al
 *      milisegundo —un despacho de varios paquetes del mismo envío lo hace—. Con
 *      un cursor de fecha sola, o se repiten los dos en cada vuelta o se saltea el
 *      segundo.
 *   2. El rezago. El cursor avanza hasta la última fila devuelta; si se devolviera
 *      una fila cuya transacción commiteó recién, otra que empezó antes y commitea
 *      un milisegundo después quedaría con una fecha ANTERIOR al cursor y no se
 *      devolvería nunca.
 *   3. Que la palabra no mienta. Un pedido cancelado que YA había salido existe, y
 *      decirle "cancelado" a alguien que tiene el paquete en camino es peor que no
 *      decirle nada.
 *
 * Corre en proceso, sin HTTP, para no depender de qué backend tenga el 3000.
 */

require('dotenv').config({ path: __dirname + '/../.env' });

const { Op } = require('sequelize');
const db = require('../src/config/database');
const { Business, PedidoPlataforma, PedidoPlataformaItem } = require('../src/models');
const tienda = require('../src/services/tiendaService');

let ok = 0;
let ko = 0;
const chk = (t, esperado, obtenido) => {
  const igual = JSON.stringify(esperado) === JSON.stringify(obtenido);
  console.log(`  ${igual ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${t}`);
  if (!igual) console.log(`      esperaba ${JSON.stringify(esperado)} · vino ${JSON.stringify(obtenido)}`);
  igual ? (ok += 1) : (ko += 1);
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const QA = 'QA-FEED-';
const haceRato = (minutos) => new Date(Date.now() - minutos * 60 * 1000);

(async () => {
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } })
    || await Business.findOne({ order: [['id', 'ASC']] });

  const limpiar = async () => {
    const filas = await PedidoPlataforma.findAll({
      where: { pedidoExterno: { [Op.like]: `${QA}%` } }, attributes: ['id'],
    });
    if (filas.length) {
      await PedidoPlataformaItem.destroy({ where: { pedidoId: filas.map((f) => f.id) } });
      await PedidoPlataforma.destroy({ where: { id: filas.map((f) => f.id) } });
    }
  };
  await limpiar();

  /*
   * Los pedidos se arman con la fecha de novedad puesta a mano: es la única forma
   * de probar el cursor y el rezago sin esperar en la pared.
   */
  const armar = (sufijo, extra) => PedidoPlataforma.create({
    businessId: negocio.id,
    plataforma: 'tienda',
    pedidoExterno: `${QA}${sufijo}`,
    estado: 'aceptado',
    recibidoEn: haceRato(60),
    ...extra,
  });

  const leer = (desde, limite) => tienda.resoluciones({
    businessId: negocio.id, plataforma: 'tienda', desde, limite,
  });

  try {
    tit('1. LA PRIMERA VUELTA NO TRAE HISTORIA');
    await armar('001', { novedadEn: haceRato(120), estado: 'aceptado' });
    const primera = await leer(null);
    chk('sin cursor no devuelve nada, y da uno para empezar', [0, true],
      [primera.cambios.length, typeof primera.cursor === 'string' && primera.cursor.includes('|')]);
    /*
     * Es a propósito: una tienda que pregunta por primera vez no tiene que
     * enterarse de seis meses de cambios y mandar un mail por cada uno.
     */
    const desdeElPrincipio = await leer(`${new Date(0).toISOString()}|0`);
    chk('pero con un cursor viejo sí trae lo anterior', true,
      desdeElPrincipio.cambios.some((c) => c.pedidoExterno === `${QA}001`));

    tit('2. EL CURSOR COMPUESTO: DOS CAMBIOS EN EL MISMO MILISEGUNDO');
    /*
     * El caso real: el depósito despacha tres paquetes del mismo envío de una vez
     * y los tres quedan con la misma marca al milisegundo.
     */
    const mismoInstante = haceRato(30);
    const a = await armar('010', { novedadEn: mismoInstante, despachadoEn: mismoInstante, estadoEnvio: 'despachado' });
    const b = await armar('011', { novedadEn: mismoInstante, despachadoEn: mismoInstante, estadoEnvio: 'despachado' });
    const c = await armar('012', { novedadEn: mismoInstante, despachadoEn: mismoInstante, estadoEnvio: 'despachado' });

    const base = `${new Date(mismoInstante.getTime() - 1000).toISOString()}|0`;
    const deUnoEnUno = [];
    let cursor = base;
    for (let i = 0; i < 4; i += 1) {
      const v = await leer(cursor, 1);
      if (!v.cambios.length) break;
      deUnoEnUno.push(v.cambios[0].pedidoExterno);
      cursor = v.cursor;
    }
    chk('leyendo de a uno salen los tres, sin repetir ninguno',
      [`${QA}010`, `${QA}011`, `${QA}012`], deUnoEnUno);
    chk('y la vuelta siguiente ya no trae nada', 0, (await leer(cursor, 10)).cambios.length);

    tit('3. EL REZAGO');
    /*
     * Un cambio de este instante NO se devuelve todavía: hay que dejar que
     * commiteen las transacciones que están en vuelo, o una de ellas quedaría con
     * una fecha anterior al cursor y se perdería para siempre.
     */
    await armar('020', { novedadEn: new Date() });
    const reciente = await leer(`${haceRato(1).toISOString()}|0`, 50);
    chk('un cambio de ahora mismo todavía no se devuelve', false,
      reciente.cambios.some((x) => x.pedidoExterno === `${QA}020`));

    tit('4. QUE LA PALABRA NO MIENTA');
    const salioYSeCanceló = await armar('030', {
      novedadEn: haceRato(20),
      estado: 'cancelado',
      despachadoEn: haceRato(25),
      canceladoEn: haceRato(20),
      estadoEnvio: 'despachado',
    });
    const conFaltante = await armar('031', { novedadEn: haceRato(19), estadoEnvio: 'con_faltante' });
    const feed = await leer(`${haceRato(21).toISOString()}|0`, 50);
    const cambioDe = (nro) => feed.cambios.find((x) => x.pedidoExterno === `${QA}${nro}`);
    chk('un cancelado que YA había salido dice despachado, no cancelado',
      'despachado', cambioDe('030')?.cambio);
    chk('y manda las DOS fechas, para que la tienda decida qué decirle al cliente',
      [true, true], [Boolean(cambioDe('030')?.despachadoEn), Boolean(cambioDe('030')?.canceladoEn)]);
    chk('un faltante se informa como faltante', 'faltante', cambioDe('031')?.cambio);

    tit('5. EL CURSOR MALO Y EL TOPE');
    let malo = null;
    try { await leer('cualquier cosa', 10); } catch (e) { malo = e.status; }
    chk('un cursor que no se entiende da 400 y no una lista vacía', 400, malo);
    const conTope = await leer(`${new Date(0).toISOString()}|0`, 2);
    chk('el límite se respeta y avisa que hay más', [2, true],
      [conTope.cambios.length, conTope.hayMas]);
    chk('y un límite enorme se recorta al tope', true,
      (await leer(`${new Date(0).toISOString()}|0`, 99999)).cambios.length <= tienda.TOPE_RESOLUCIONES);

    tit('6. LA ETIQUETA');
    /*
     * El seguimiento llega después, cuando la tienda la genera, y tiene que
     * aparecer en el feed: así la tienda confirma que quedó cargada sin tener que
     * acordarse de que la mandó.
     */
    await salioYSeCanceló.update({ seguimiento: 'CA123456789AR', novedadEn: haceRato(10) });
    const conEtiqueta = await leer(`${haceRato(11).toISOString()}|0`, 50);
    chk('el seguimiento viaja en el feed', 'CA123456789AR',
      conEtiqueta.cambios.find((x) => x.pedidoExterno === `${QA}030`)?.seguimiento);
  } finally {
    tit('Limpieza');
    await limpiar();
    chk('no queda nada de la prueba', 0,
      await PedidoPlataforma.count({ where: { pedidoExterno: { [Op.like]: `${QA}%` } } }));
    await db.close();
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
