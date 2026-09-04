/*
 * Lista de espera de venta online.
 *
 * Todo pedido que llega de una plataforma —Mercado Libre, Jumpseller, la que
 * venga— entra acá ANTES de tocar el inventario, y se procesa de a uno en
 * orden de llegada.
 *
 * ── Por qué una cola y no descontar en el momento ──────────────────
 *
 * Dos plataformas pueden vender la misma última unidad con medio segundo de
 * diferencia. Sin fila, las dos leen "queda 1", las dos descuentan, y el stock
 * queda en −1 con dos clientes esperando la misma prenda. Con fila, la segunda
 * se encuentra con cero y se rechaza: sigue siendo un problema, pero es UNO
 * solo y queda avisado.
 *
 * El orden de llegada es la regla de desempate. Es la única que se puede
 * explicar sin que nadie se sienta perjudicado: vendió primero el que llegó
 * primero.
 *
 * ── Lo que se rechaza no se borra ──────────────────────────────────
 *
 * Un rechazo significa que la plataforma ya vendió algo que no teníamos. Ese es
 * exactamente el caso que hay que poder mirar al día siguiente, y por eso queda
 * en la lista con su motivo en vez de desaparecer.
 *
 * ── Idempotencia ───────────────────────────────────────────────────
 *
 * Un webhook puede llegar dos veces: las plataformas reintentan cuando no ven
 * un 200 a tiempo, y Jumpseller lo hace hasta ocho veces en cuatro días. El
 * índice único sobre (negocio, plataforma, pedido) hace que el segundo intento
 * devuelva el resultado del primero en vez de descontar de nuevo.
 */

const db = require('../config/database');
const {
  PedidoPlataforma, PedidoPlataformaItem, ProductVariant, Product, BusinessLocation,
} = require('../models');
const stockService = require('./stockService');
const packService = require('./packService');
const { log } = require('../utils/logger');

const PLATAFORMAS = ['mercadolibre', 'jumpseller'];

const error = (mensaje, status = 400, extra = {}) =>
  Object.assign(new Error(mensaje), { status, ...extra });

/** Recorta un texto al largo de su columna. Vacío se guarda como null. */
const recortar = (v, largo) => {
  const t = String(v ?? '').trim();
  return t ? t.slice(0, largo) : null;
};

/**
 * Anota un pedido en la lista. No toca stock: sólo lo encola.
 *
 * Separar el registro del descuento es lo que permite responderle rápido a la
 * plataforma —Jumpseller corta a los 15 segundos— y procesar después con
 * calma, en orden y de a uno.
 */
async function encolar({ businessId, plataforma, pedidoExterno, items, comprador = {}, total = null }) {
  const cual = String(plataforma || '').toLowerCase();
  if (!PLATAFORMAS.includes(cual)) {
    throw error(`Plataforma desconocida: ${plataforma}. Las válidas son ${PLATAFORMAS.join(', ')}.`);
  }
  const externo = String(pedidoExterno || '').trim();
  if (!externo) throw error('El pedido necesita el id que le dio la plataforma.');
  /*
   * Los topes existen para que un pedido no pueda voltear el proceso.
   *
   * El descuento corre entero adentro de una transacción y de a un pedido por
   * negocio: un pedido con cien mil líneas dejaría esa transacción abierta
   * minutos, con las filas de stock trabadas, y detrás toda la cola del negocio
   * esperando. No hace falta mala intención —un webhook mal armado alcanza—,
   * pero con un token válido es un pedido y el mostrador deja de vender.
   *
   * Los números son holgados a propósito: una venta online real de doscientas
   * líneas no existe, y si algún día existe, el mensaje dice qué pasó en vez de
   * cortar por tiempo de espera.
   */
  const MAX_LINEAS = 200;
  const MAX_UNIDADES = 10000;
  if (externo.length > 60) {
    throw error('El id del pedido de la plataforma no puede pasar de 60 caracteres.');
  }
  if (!Array.isArray(items) || !items.length) throw error('El pedido llegó sin artículos.');
  if (items.length > MAX_LINEAS) {
    throw error(`El pedido trae ${items.length} artículos y el máximo es ${MAX_LINEAS}.`);
  }

  for (const i of items) {
    const sku = String(i?.sku || '').trim();
    if (!sku) throw error('Cada artículo necesita su SKU.');
    if (sku.length > 80) throw error(`El SKU "${sku.slice(0, 20)}…" es más largo de lo que puede existir en Stocker.`);
    const n = Number(i?.cantidad);
    if (!Number.isInteger(n) || n <= 0) {
      throw error(`La cantidad de "${sku}" tiene que ser un entero mayor a cero.`);
    }
    if (n > MAX_UNIDADES) {
      throw error(`La cantidad de "${sku}" (${n}) supera el máximo de ${MAX_UNIDADES} por línea.`);
    }
  }

  /*
   * Si ya estaba, se devuelve tal cual y no se vuelve a encolar.
   *
   * Es el reintento del webhook. Devolver el estado que ya tenía es lo correcto
   * —la plataforma quiere saber si lo tomamos— y sobre todo evita descontar dos
   * veces la misma venta.
   */
  const yaEstaba = await PedidoPlataforma.findOne({
    where: { businessId, plataforma: cual, pedidoExterno: externo },
    include: [{ model: PedidoPlataformaItem, as: 'items' }],
  });
  if (yaEstaba) return { pedido: yaEstaba, repetido: true };

  const t = await db.transaction();
  try {
    const pedido = await PedidoPlataforma.create({
      businessId, plataforma: cual, pedidoExterno: externo,
      estado: 'pendiente',
      /*
       * Los datos del comprador se recortan al tamaño de su columna.
       *
       * Vienen de la plataforma y no de nosotros: un nombre de mil caracteres
       * haría fallar el INSERT con un error de base que no dice qué pasó, y el
       * pedido —que es una venta real— se perdería por un campo informativo.
       */
      compradorNombre:    recortar(comprador.nombre, 150),
      compradorDocumento: recortar(comprador.documento, 20),
      compradorEmail:     recortar(comprador.email, 150),
      total: total != null ? total : null,
      recibidoEn: new Date(),
    }, { transaction: t });

    await PedidoPlataformaItem.bulkCreate(items.map((i) => ({
      pedidoId: pedido.id,
      sku: String(i.sku).trim(),
      cantidad: Number(i.cantidad),
      precioUnitario: i.precioUnitario != null ? Number(i.precioUnitario) : null,
    })), { transaction: t });

    await t.commit();
    const completo = await PedidoPlataforma.findByPk(pedido.id, {
      include: [{ model: PedidoPlataformaItem, as: 'items' }],
    });
    return { pedido: completo, repetido: false };
  } catch (e) {
    await t.rollback().catch(() => {});
    throw e;
  }
}

/*
 * El pedido no se puede despachar porque no hay stock.
 *
 * Se marca con una bandera propia para distinguirlo de un error de verdad: uno
 * termina en un 409 con motivo, el otro en un 500 que hay que ir a mirar.
 */
function sinStock(mensaje) {
  const err = new Error(mensaje);
  err.sinStock = true;
  return err;
}

/*
 * Resuelve los SKU de unas líneas y aparta su mercadería.
 *
 * Está afuera de `procesarUno` porque hay DOS caminos que tienen que decidir
 * exactamente igual: el pedido que entra por primera vez, y el que se
 * reprocesa porque su SKU no existía todavía cuando entró. Con la lógica
 * escrita dos veces, el segundo camino se iba a quedar viejo la primera vez
 * que cambiara una regla —lo de los packs, sin ir más lejos— y nadie lo iba a
 * notar hasta que un despacho no descontara nada.
 *
 * Sólo toca las líneas que se le pasan. Quien llama decide cuáles: todas, o
 * las que quedaron sin resolver.
 *
 * @returns {Promise<{desconocidos: string[], deEvento: string[]}>}
 */
async function resolverYApartar(pedido, items, t) {
  /*
   * ── Resolver los SKU ─────────────────────────────────────────
   *
   * Un SKU que no existe en Stocker no se puede descontar. La línea se marca
   * y el pedido queda `parcial`: la venta ocurrió igual, y no descontar lo
   * que sí conocemos haría la diferencia todavía más grande.
   */
  const skus = [...new Set(items.map((i) => i.sku))];
  const variantes = await ProductVariant.findAll({
    where: { businessId: pedido.businessId, sku: skus },
    include: [{ model: Product, as: 'producto', attributes: ['id', 'esFeria'], required: true }],
    transaction: t,
  });
  const porSku = new Map(variantes.map((v) => [v.sku, v]));

  const desconocidos = [];
  const deEvento = [];
  const aDescontar = [];

  for (const item of items) {
    const v = porSku.get(item.sku);
    if (!v) { desconocidos.push(item.sku); continue; }
    /*
     * Un producto de evento no lleva stock y no se vende por internet.
     * Que llegue uno significa que alguien publicó online un SKU de feria:
     * se avisa en vez de intentar descontarle algo que no tiene.
     */
    if (v.producto?.esFeria) { deEvento.push(item.sku); continue; }
    aDescontar.push({ item, variante: v });
  }

  /*
   * ── ¿Alcanza el stock? Se pregunta por TODO antes de mover nada ──
   *
   * Frenar en la mitad dejaría medio pedido descontado, y el vendedor sin
   * forma de saber qué salió y qué no.
   *
   * Ojo con qué garantiza esta consulta: es un atajo, no el candado. Dos
   * pedidos que entran juntos por el mismo artículo leen los dos "queda 1" y
   * los dos pasan por acá. Lo que los ordena es `mover`, más abajo, que traba
   * la fila de stock y hace que el segundo lea el cero que dejó el primero.
   * Este chequeo existe para rechazar temprano y barato el caso normal —el
   * pedido que ya nace sin stock—, y para no descontar medio pedido cuando
   * falta una línea de varias.
   */
  const faltantes = [];
  const repartos = [];
  for (const { item, variante } of aDescontar) {
    /*
     * Un pack se reparte por packs enteros, no por unidades.
     *
     * Preguntarle a `repartirDescuentoOnline` por un pack daría cero siempre:
     * un pack no tiene fila en `variant_stocks` porque no lleva stock propio.
     * Lo que hay de un pack es lo que alcance para armarlo con lo que tiene
     * adentro, y eso lo sabe packService.
     */
    const r = variante.esPack
      ? await packService.repartirPackOnline(variante.id, pedido.businessId, item.cantidad, t)
      : await stockService.repartirDescuentoOnline(
        variante.id, pedido.businessId, item.cantidad, t,
      );
    if (!r.alcanza) {
      faltantes.push({ sku: item.sku, pide: item.cantidad, falta: r.falta });
    }
    repartos.push({ item, variante, reparto: r.reparto });
  }

  if (faltantes.length) {
    const detalle = faltantes
      .map((f) => `${f.sku}: pide ${f.pide} y faltan ${f.falta}`)
      .join('; ');
    throw sinStock(`Sin stock para despachar. ${detalle}.`);
  }

  /*
   * ── Apartar, no descontar ────────────────────────────────────
   *
   * La prenda sigue en el estante hasta que alguien la pickee y la despache.
   * Lo que cambia ahora es que nadie más la puede vender: ni el mostrador, ni
   * la otra plataforma, ni un segundo pedido de ésta.
   *
   * Antes acá se hacía el egreso. El inventario decía que la prenda no estaba
   * mientras seguía colgada esperando el picking, y el que iba a buscarla no
   * tenía forma de saber si la habían despachado o si nunca estuvo. Ahora el
   * egreso ocurre en Envíos del Día, cuando sale de verdad.
   *
   * `reservar` puede devolver false aunque el reparto haya dicho que alcanza:
   * entre que se calculó y se aparta, otro pedido pudo llevarse la unidad. Es
   * la misma carrera de siempre y se resuelve igual —el que llega segundo se
   * rechaza—, sólo que ahora se detecta acá en vez de adentro de `mover`.
   */
  const apartadas = [];
  for (const { item, variante, reparto } of repartos) {
    for (const parte of reparto) {
      /*
       * Apartar un pack es apartar lo que lleva adentro: tres remeras, no un
       * pack. Todo o nada — media reserva deja mercadería comprometida para
       * un pack que nunca se va a poder armar.
       */
      const pudo = variante.esPack
        ? await packService.reservarPack(
          variante.id, parte.locationId, pedido.businessId, parte.unidades, t,
        )
        : await stockService.reservar(
          variante.id, parte.locationId, pedido.businessId, parte.unidades, t,
        );
      if (!pudo) {
        throw sinStock(
          `Sin stock para despachar. ${item.sku}: se apartó para otro pedido mientras se procesaba éste.`,
        );
      }
      apartadas.push({ variante, parte });
    }
    // De qué local sale, para poder pickearlo sin recalcular nada.
    await item.update({
      productVariantId: variante.id,
      locationId: reparto[0]?.locationId || null,
    }, { transaction: t });
  }

  return { desconocidos, deEvento };
}

/*
 * Procesa UN pedido: resuelve los SKU, descuenta y lo cierra.
 *
 * Todo pasa dentro de una transacción. O el pedido queda aceptado con su stock
 * descontado, o no cambia nada: un pedido a medio descontar sería la peor
 * versión del problema que esto viene a resolver.
 */
async function procesarUno(pedidoId) {
  const t = await db.transaction();
  try {
    /*
     * Se relee con lock. Dos procesadores corriendo a la vez —el automático y
     * alguien apretando "procesar" en la pantalla— tomarían el mismo pedido.
     */
    const pedido = await PedidoPlataforma.findOne({
      where: { id: pedidoId }, transaction: t, lock: t.LOCK.UPDATE,
    });
    if (!pedido) { await t.rollback(); return null; }
    if (pedido.estado !== 'pendiente') { await t.rollback(); return pedido; }

    const items = await PedidoPlataformaItem.findAll({
      where: { pedidoId: pedido.id }, transaction: t,
    });

    const { desconocidos, deEvento } = await resolverYApartar(pedido, items, t);

    const avisos = [];
    if (desconocidos.length) {
      avisos.push(`No están en Stocker y no se descontaron: ${desconocidos.join(', ')}.`);
    }
    if (deEvento.length) {
      avisos.push(`Son productos de evento y no llevan stock: ${deEvento.join(', ')}.`);
    }

    /*
     * `aceptado` ahora significa "apartado", no "despachado".
     *
     * El egreso lo hace Envíos del Día cuando el paquete sale. Hasta entonces
     * el pedido está comprometido y la mercadería está en el estante, que es
     * exactamente lo que el pickeador va a encontrar.
     */
    await pedido.update({
      estado: avisos.length ? 'parcial' : 'aceptado',
      motivo: avisos.join(' ') || null,
      procesadoEn: new Date(),
    }, { transaction: t });

    await t.commit();
    return await PedidoPlataforma.findByPk(pedido.id, {
      include: [{ model: PedidoPlataformaItem, as: 'items' }],
    });
  } catch (e) {
    await t.rollback().catch(() => {});
    /*
     * Faltó stock: eso no es una falla, es una respuesta.
     *
     * Puede venir del chequeo de arriba —el caso normal, el pedido que ya nace
     * sin stock— o de `mover`, cuando dos pedidos entraron juntos y el segundo
     * se encontró con el cero que dejó el primero. Los dos terminan igual: el
     * pedido queda rechazado, con el motivo escrito, y quien integra recibe un
     * 409 que puede accionar. Dejarlo salir como excepción devolvía un 500, y
     * un 500 no le dice a nadie que tiene que cancelar antes de despachar.
     *
     * Se abre una transacción nueva a propósito: la anterior ya se deshizo, y
     * escribir el rechazo sobre una transacción muerta lo perdería.
     */
    if (e.sinStock || e.status === 409) {
      return rechazar(pedidoId, e.message);
    }
    throw e;
  }
}

/*
 * Vuelve a intentar las líneas que quedaron sin resolver.
 *
 * El caso que lo motiva: un pedido de Mercado Libre entra con el SKU de un
 * pack que todavía no existía en Stocker —porque el pack se armó después, o
 * porque la venta se trajo con el backfill de pedidos viejos—. La línea queda
 * marcada "no está en Stocker", el pedido en `parcial`, y NADA se aparta.
 *
 * Hasta acá eso era definitivo: `procesarUno` sólo trabaja sobre pedidos
 * `pendiente`, así que crear el pack después no cambiaba nada. El pedido se
 * quedaba para siempre diciendo que un SKU que sí existe no existe, y —lo
 * peor— al despacharlo no se descontaba ninguna prenda, porque despachar
 * saltea las líneas sin variante. El paquete salía y el inventario no se
 * enteraba.
 *
 * Sólo se tocan las líneas SIN resolver. Las que ya apartaron mercadería se
 * dejan como están: volver a apartarlas comprometería el doble de stock para
 * la misma venta.
 */
async function reprocesar(pedidoId) {
  const t = await db.transaction();
  try {
    const pedido = await PedidoPlataforma.findOne({
      where: { id: pedidoId }, transaction: t, lock: t.LOCK.UPDATE,
    });
    if (!pedido) { await t.rollback(); return null; }

    /*
     * Un pedido cancelado no se reprocesa: apartaría mercadería para una venta
     * que ya no existe. Uno `pendiente` tampoco: ése lo toma `procesarUno`, y
     * hacerlo acá duplicaría el apartado si los dos corren a la vez.
     */
    if (!['parcial', 'rechazado'].includes(pedido.estado)) {
      await t.rollback();
      return pedido;
    }

    const todos = await PedidoPlataformaItem.findAll({
      where: { pedidoId: pedido.id }, transaction: t,
    });
    const pendientes = todos.filter((i) => !i.productVariantId);
    if (!pendientes.length) {
      await t.rollback();
      return pedido;
    }

    const { desconocidos, deEvento } = await resolverYApartar(pedido, pendientes, t);

    const avisos = [];
    if (desconocidos.length) {
      avisos.push(`No están en Stocker y no se descontaron: ${desconocidos.join(', ')}.`);
    }
    if (deEvento.length) {
      avisos.push(`Son productos de evento y no llevan stock: ${deEvento.join(', ')}.`);
    }

    await pedido.update({
      estado: avisos.length ? 'parcial' : 'aceptado',
      motivo: avisos.join(' ') || null,
      procesadoEn: new Date(),
    }, { transaction: t });

    await t.commit();
    return await PedidoPlataforma.findByPk(pedido.id, {
      include: [{ model: PedidoPlataformaItem, as: 'items' }],
    });
  } catch (e) {
    await t.rollback().catch(() => {});
    /*
     * Faltó stock al reintentar. No se marca el pedido como rechazado —ya
     * existía y puede tener líneas apartadas— pero sí se avisa: el SKU ahora
     * se reconoce, lo que falta es mercadería.
     */
    if (e.sinStock || e.status === 409) {
      const err = new Error(e.message);
      err.status = 409;
      err.codigo = 'SIN_STOCK';
      throw err;
    }
    throw e;
  }
}

/*
 * Marca un pedido como rechazado, en su propia transacción.
 */
async function rechazar(pedidoId, motivo) {
  const t = await db.transaction();
  try {
    const pedido = await PedidoPlataforma.findByPk(pedidoId, { transaction: t });
    if (!pedido) { await t.rollback(); return null; }
    await pedido.update({
      estado: 'rechazado',
      motivo: String(motivo).slice(0, 500),
      procesadoEn: new Date(),
    }, { transaction: t });
    await t.commit();
  } catch (e) {
    await t.rollback().catch(() => {});
    throw e;
  }
  log.warn('cola-online', 'pedido rechazado por falta de stock', { pedido: pedidoId });
  return PedidoPlataforma.findByPk(pedidoId, {
    include: [{ model: PedidoPlataformaItem, as: 'items' }],
  });
}

/**
 * Procesa la cola pendiente de un negocio, en orden de llegada.
 *
 * De a uno y en serie a propósito: procesar en paralelo devolvería el problema
 * que la cola resuelve, dos pedidos leyendo el mismo stock a la vez.
 *
 * @param {number} tope  cuántos procesar como máximo en esta pasada. Existe
 *   para que una cola larga no monopolice el proceso: lo que queda se toma en
 *   la pasada siguiente, sin perder el orden.
 */
async function procesarCola(businessId, { tope = 50 } = {}) {
  const pendientes = await PedidoPlataforma.findAll({
    where: { businessId, estado: 'pendiente' },
    order: [['recibidoEn', 'ASC'], ['id', 'ASC']],
    limit: tope,
    attributes: ['id'],
  });

  const resultado = { procesados: 0, aceptados: 0, parciales: 0, rechazados: 0 };
  for (const { id } of pendientes) {
    const p = await procesarUno(id);
    if (!p) continue;
    resultado.procesados += 1;
    if (p.estado === 'aceptado')  resultado.aceptados  += 1;
    if (p.estado === 'parcial')   resultado.parciales   += 1;
    if (p.estado === 'rechazado') resultado.rechazados += 1;
  }
  return resultado;
}

/**
 * Encola y procesa en el mismo pedido HTTP.
 *
 * Es lo que necesita quien llama por API y espera un sí o un no —la decisión 2
 * pide que el POST devuelva el aviso de falta de stock— a diferencia de un
 * webhook, que sólo quiere un 200 rápido.
 */
async function encolarYProcesar(datos) {
  const { pedido, repetido } = await encolar(datos);
  if (repetido || pedido.estado !== 'pendiente') return { pedido, repetido };
  const procesado = await procesarUno(pedido.id);
  return { pedido: procesado || pedido, repetido: false };
}

module.exports = {
  encolar, procesarUno, procesarCola, encolarYProcesar, reprocesar, PLATAFORMAS,
};
