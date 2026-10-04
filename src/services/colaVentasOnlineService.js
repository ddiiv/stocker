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
  PedidoPlataforma, PedidoPlataformaItem, PlataformaCobro, ProductVariant, Product, BusinessLocation,
} = require('../models');
const stockService = require('./stockService');
const packService = require('./packService');
const { partesDeItem } = require('../utils/repartoItem');
const { log } = require('../utils/logger');

/*
 * `tienda` es la tienda minorista propia. Entra por la misma cola que Mercado
 * Libre y Jumpseller a propósito: el que aparta mercadería es uno solo, en
 * orden de llegada, y así dos canales no pueden vender la misma última unidad.
 */
const PLATAFORMAS = ['mercadolibre', 'jumpseller', 'tienda'];

/*
 * ── Los estados de pago, y qué significa que no haya ninguno ──────
 *
 * NULL es "este canal no informa pago": Mercado Libre y Jumpseller llegan
 * cobrados, y todas las filas anteriores a esto también. Un pedido con NULL se
 * despacha como siempre, así que el filtro del depósito tiene que preguntar por
 * NULL explícitamente en vez de comparar contra "pagado".
 */
const PAGO_PENDIENTE = 'pendiente';
const PAGO_PAGADO = 'pagado';

// La misma que usa paymentService para que dos partes del sistema no discutan por
// un centavo de redondeo.
const TOLERANCIA_COBRO = 0.02;

/*
 * Qué estado de pago le corresponde a un pedido que entra.
 *
 * Sólo los canales que apartan antes de cobrar tienen estado. Para los demás es
 * NULL y no se les inventa uno "por simetría": no lo informan, y NULL ya dice lo
 * correcto.
 */
function estadoDePago(plataforma, pagoPendiente) {
  if (plataforma !== 'tienda') return null;
  // El default de la tienda es pendiente: falla cerrado.
  return pagoPendiente === false ? PAGO_PAGADO : PAGO_PENDIENTE;
}


const error = (mensaje, status = 400, extra = {}) =>
  Object.assign(new Error(mensaje), { status, ...extra });

/** Recorta un texto al largo de su columna. Vacío se guarda como null. */
/*
 * Hasta cuándo vale una reserva sin pagar.
 *
 * La plataforma lo dice; si no lo dice, Stocker pone su propio reloj. El tope
 * duro existe porque una plataforma podría mandar una fecha a diez años y la
 * mercadería quedaría apartada sin que nadie lo note: lo publicable es
 * stock - reservado, así que la prenda desaparece de la vidriera, de Mercado
 * Libre y de Jumpseller antes de que llegue un peso.
 */
const PAGO_VENCE_H = Number(process.env.PAGO_VENCE_H) || 72;
const PAGO_TOPE_H = 7 * 24;

function vencimientoDePago(valor, desde) {
  const tope = new Date(desde.getTime() + PAGO_TOPE_H * 3600 * 1000);
  if (valor) {
    const d = new Date(valor);
    if (!Number.isNaN(d.getTime())) return d > tope ? tope : d;
  }
  return new Date(desde.getTime() + PAGO_VENCE_H * 3600 * 1000);
}
/*
 * El corte del día, o nada.
 *
 * Viene de afuera y es un texto. Una fecha inválida guardada tal cual hace
 * fallar el INSERT con un error de base que no dice qué pasó, y el pedido —que
 * es una venta real— se perdería por un campo que sólo sirve para ordenar una
 * lista. Si no se entiende, se descarta y el paquete queda sin reloj.
 */
function fechaDeCorte(valor) {
  if (!valor) return null;
  const d = new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d;
}

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
async function encolar({
  businessId, plataforma, pedidoExterno, items, comprador = {}, total = null, envio = null,
  pagoPendiente = null, pagoDetalle = null, pagoVenceEn = null,
}) {
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

  const ahora = new Date();
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
      /*
       * Con qué sale, si la plataforma lo sabe al vender.
       *
       * Las columnas ya existían para Mercado Libre y `encolar` las ignoraba, así
       * que un pedido de la tienda entraba sin tipo de envío y sin corte: para el
       * depósito era un paquete sin reloj y sin forma de despacho, al final de
       * una lista que se ordena justamente por el corte.
       *
       * `envioTipo` es texto libre a propósito: la pantalla sólo le da un
       * significado especial a 'flex' (el de Mercado Libre, que tiene reloj) y
       * deja pasar el resto. Así los de la tienda —retiro, envio,
       * correo_argentino, andreani, oca, mercado_envios, cabify— entran sin que
       * haya que tocar nada allá.
       */
      envioTipo:        recortar(envio?.tipo, 30),
      despacharAntesDe: fechaDeCorte(envio?.despacharAntesDe),
      // El seguimiento normalmente llega después, cuando se genera la etiqueta.
      envioId:          recortar(envio?.seguimiento, 60),
      /*
       * ── El pago, escrito acá y no en un update posterior ──────
       *
       * Mercado Libre escribe su envío con un update después de encolar, y para
       * el envío da igual. Para el pago no: entre el INSERT y ese update el
       * pedido ya está aceptado, con la mercadería apartada y sin marca de
       * pago, y en esa ventana el depósito lo ve despachable. Si alguien abre
       * Envíos del Día justo ahí, o si el proceso se muere entre las dos
       * escrituras, el paquete queda despachable para siempre sin que nadie
       * haya pagado: exactamente el agujero que esto viene a cerrar.
       *
       * El default de la tienda cuando el mensaje no dice nada es "pendiente",
       * no NULL. Falla cerrado a propósito: un paquete retenido se destraba con
       * un clic, uno despachado sin cobrar no vuelve.
       */
      pagoEstado:  estadoDePago(cual, pagoPendiente),
      pagoDetalle: recortar(pagoDetalle, 120),
      // El reloj propio sólo existe si hay algo que esperar.
      pagoVenceEn: estadoDePago(cual, pagoPendiente) === PAGO_PENDIENTE
        ? vencimientoDePago(pagoVenceEn, ahora)
        : null,
      recibidoEn: ahora,
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
    /*
     * Perdió la carrera contra el índice único, y ése es un final correcto.
     *
     * El SELECT de arriba no lo encontró porque el otro todavía no había
     * commiteado. Ahora sí está: contestar "ya lo tenía" es exactamente lo que
     * la plataforma necesita oír, y lo contrario —un 500— la haría reintentar
     * para siempre contra un pedido que ya entró.
     */
    if (e?.name === 'SequelizeUniqueConstraintError') {
      const ganador = await PedidoPlataforma.findOne({
        where: { businessId, plataforma: cual, pedidoExterno: externo },
        include: [{ model: PedidoPlataformaItem, as: 'items' }],
      });
      if (ganador) return { pedido: ganador, repetido: true };
    }
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
    // De qué local sale, para poder pickearlo sin recalcular nada. Y el
    // reparto entero: si la reserva se partió entre locales, despachar y
    // devolver necesitan saber cuánto se apartó en cada uno, no sólo dónde
    // empezó.
    await item.update({
      productVariantId: variante.id,
      locationId: reparto[0]?.locationId || null,
      reparto: JSON.stringify(reparto.map((p) => ({ locationId: p.locationId, unidades: p.unidades }))),
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
      /*
       * La novedad, en el MISMO update que el cambio.
       *
       * Es el cursor del feed de resoluciones. Va acá y no en un update aparte
       * porque un segundo update vuelve a abrir la carrera que la transacción
       * cierra: el cambio commitearía sin su marca y la plataforma no se
       * enteraría nunca de ese pedido.
       */
      novedadEn: new Date(),
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
      /*
       * La novedad, en el MISMO update que el cambio.
       *
       * Es el cursor del feed de resoluciones. Va acá y no en un update aparte
       * porque un segundo update vuelve a abrir la carrera que la transacción
       * cierra: el cambio commitearía sin su marca y la plataforma no se
       * enteraría nunca de ese pedido.
       */
      novedadEn: new Date(),
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

/**
 * La plataforma canceló el pedido: se devuelve lo apartado y queda anotado.
 *
 * Antes una cancelación de Mercado Libre se descartaba sin tocar nada: el
 * pedido quedaba "aceptado" y su mercadería APARTADA PARA SIEMPRE, sin venta
 * detrás. No se veía en ninguna pestaña y el stock disponible —el que se
 * publica— quedaba más bajo de lo real hasta que alguien lo encontrara a mano.
 *
 * Todo en una transacción con el pedido trabado: la notificación de la orden,
 * la del envío y la reconciliación periódica pueden traer la MISMA cancelación
 * a la vez, y devolver dos veces la reserva liberaría mercadería de otro
 * pedido. El segundo que llega encuentra `cancelado` y no hace nada.
 *
 * Si ya se había despachado, no se toca el stock: la mercadería ya salió, y si
 * vuelve, vuelve por devolución —con su reclamo— y no por acá.
 */
async function cancelarPorPlataforma(pedidoId, motivo = 'Cancelado en la plataforma') {
  const t = await db.transaction();
  try {
    const pedido = await PedidoPlataforma.findByPk(pedidoId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!pedido) { await t.rollback(); return { accion: 'no_existe' }; }
    if (pedido.estado === 'cancelado') { await t.rollback(); return { accion: 'ya_cancelado', pedidoId }; }

    const yaSalio = pedido.estadoEnvio === 'despachado';
    const habiaApartado = ['aceptado', 'parcial'].includes(pedido.estado) && !yaSalio;
    let liberadas = 0;

    if (habiaApartado) {
      const items = await PedidoPlataformaItem.findAll({ where: { pedidoId }, transaction: t });
      const ids = items.map((i) => i.productVariantId).filter(Boolean);
      const packs = new Set((ids.length
        ? await ProductVariant.findAll({ where: { id: ids, esPack: true }, attributes: ['id'], transaction: t })
        : []).map((v) => v.id));

      for (const item of items) {
        if (!item.productVariantId) continue;
        for (const parte of partesDeItem(item)) {
          const pudo = packs.has(item.productVariantId)
            ? await packService.liberarPack(item.productVariantId, parte.locationId, pedido.businessId, parte.unidades, t)
            : await stockService.liberarReserva(item.productVariantId, parte.locationId, pedido.businessId, parte.unidades, t);
          /*
           * Que no se pueda liberar no frena la cancelación: la venta ya no
           * existe y marcarla cancelada es lo correcto igual. Pero se anota,
           * porque significa que lo apartado no coincidía con lo que dice el
           * pedido y alguien tiene que mirarlo.
           */
          if (pudo) liberadas += parte.unidades;
          else {
            log.warn('cola-online', 'cancelación: una reserva no estaba para devolver', {
              pedido: pedidoId, sku: item.sku, local: parte.locationId, unidades: parte.unidades,
            });
          }
        }
      }
    }

    await pedido.update({
      estado: 'cancelado',
      motivo: String(yaSalio
        ? `${motivo}. Ya se había despachado: si vuelve, entra por devolución.`
        : motivo).slice(0, 500),
      canceladoEn: new Date(),
      // El cursor del feed: ver la nota de arriba.
      novedadEn: new Date(),
    }, { transaction: t });
    await t.commit();

    log.info('cola-online', 'pedido cancelado por la plataforma', {
      pedido: pedidoId, liberadas, yaSalio,
    });
    return { accion: 'cancelado', pedidoId, liberadas, yaSalio };
  } catch (e) {
    await t.rollback().catch(() => {});
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
      // El cursor del feed: ver la nota de arriba.
      novedadEn: new Date(),
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

/*
 * La red de abajo: los pedidos que quedaron 'pendiente' y nadie volvió a tocar.
 *
 * Un pedido se queda así cuando la fila se commiteó y el procesamiento no llegó
 * a correr: un deploy de Railway en el medio, un deadlock, el pool agotado. El
 * reenvío de la plataforma ahora lo levanta, pero no todas reenvían, y la
 * plataforma puede no volver nunca. Sin esto, ese pedido no existe para nadie:
 * no está en Envíos del Día —que sólo lista aceptado y parcial— y no hay botón
 * que lo rescate.
 *
 * La gracia existe para no pelearle el lock al pedido que se está procesando en
 * este mismo momento. `procesarUno` relee con lock y sale si ya no está
 * 'pendiente', así que tomarlo de más sería correcto igual, sólo que inútil.
 */
const GRACIA_PENDIENTE_MS = Number(process.env.COLA_GRACIA_MS) || 2 * 60 * 1000;

async function rescatarPendientes({ gracia = GRACIA_PENDIENTE_MS, tope = 200 } = {}) {
  const { Op } = require('sequelize');
  const colgados = await PedidoPlataforma.findAll({
    where: {
      estado: 'pendiente',
      recibidoEn: { [Op.lt]: new Date(Date.now() - gracia) },
    },
    order: [['recibidoEn', 'ASC'], ['id', 'ASC']],
    limit: tope,
    attributes: ['id', 'businessId'],
  });
  if (!colgados.length) return { negocios: 0, procesados: 0 };

  const porNegocio = new Set(colgados.map((p) => p.businessId));
  let procesados = 0;
  /*
   * De a uno, y SÓLO los que pasaron la gracia.
   *
   * Pasarle el negocio a `procesarCola` sería más corto pero se llevaría puesta
   * la gracia: esa función toma todos los pendientes del negocio, incluido el
   * que está entrando en este segundo. La consulta de arriba ya viene ordenada
   * por fecha de llegada, así que recorrerla en orden respeta la regla de toda
   * la cola —el que entró primero se lleva la última unidad— dentro de cada
   * negocio y entre negocios.
   */
  for (const p of colgados) {
    const r = await procesarUno(p.id);
    if (r) procesados += 1;
  }
  if (procesados) {
    log.warn('cola-online', 'pedidos rescatados de pendiente', {
      negocios: porNegocio.size, procesados,
    });
  }
  return { negocios: porNegocio.size, procesados };
}

/*
 * ══ El cobro de un pedido que entró sin pagar ════════════════════
 *
 * La tienda minorista aparta la prenda y cobra después. Esta función registra
 * ese cobro y, si alcanza, abre la puerta del depósito.
 *
 * ── Lo que esto NO es ───────────────────────────────────────────
 *
 * No es un asiento contable. El dinero no entra a la caja ni a una venta, porque
 * un pedido de plataforma no llega a ser `Sale`. Es un registro de recepción y
 * una compuerta de despacho: alcanza para no despachar sin cobrar y para
 * conciliar contra el resumen de la pasarela, y no alcanza para ningún reporte
 * de facturación. Está dicho así en el contrato, § 3.5.
 *
 * ── Por qué nunca contesta un error cuando entiende el cobro ─────
 *
 * La plataforma reintenta sobre cualquier cosa que no sea 2xx. Un cobro que
 * llega sobre un pedido ya cancelado —el plazo venció y el webhook de la pasarela
 * llegó dos segundos tarde, que con transferencias a 48 h es rutina— se guarda
 * con `aplicado: false` y el motivo escrito. Contestarle 409 la haría reintentar
 * para siempre y el pago no quedaría anotado en ninguna parte: el cliente pagó y
 * nadie sabría que hay que devolverle la plata.
 */
async function registrarCobro({
  businessId, plataforma, movimientoExterno, pedidoExterno,
  importe, medio, operacion = null, ocurrioEn = null,
}) {
  const cual = String(plataforma || '').toLowerCase();
  if (!PLATAFORMAS.includes(cual)) throw error(`Plataforma desconocida: ${plataforma}.`);

  const mov = String(movimientoExterno || '').trim();
  if (!mov) throw error('El cobro necesita el id del movimiento.');
  if (mov.length > 60) throw error('El id del movimiento no puede pasar de 60 caracteres.');
  const externo = String(pedidoExterno || '').trim();
  if (!externo) throw error('El cobro tiene que nombrar el pedido (ventaId).');

  /*
   * El importe es lo único que se valida de verdad, y sólo como número.
   *
   * No se compara contra el `total` del pedido: ese número llega crudo de la
   * plataforma —nunca se verifica contra la suma de las líneas— y la tienda le
   * aplica sus descuentos y le suma el envío. Rechazar la diferencia frenaría un
   * despacho por un número que nunca fue autoridad.
   */
  const monto = Number(importe);
  if (!Number.isFinite(monto) || monto <= 0) {
    throw error(`El importe del cobro tiene que ser un número mayor a cero y llegó "${importe}".`);
  }
  const comoSeCobro = String(medio || '').trim().slice(0, 30);
  if (!comoSeCobro) throw error('El cobro necesita decir con qué medio se pagó.');
  const refe = operacion == null ? null : String(operacion).trim().slice(0, 60) || null;

  const t = await db.transaction();
  try {
    /*
     * El pedido se relee con lock antes de decidir cualquier cosa.
     *
     * Es la misma carrera que cuida `cancelarPorPlataforma`: el vencimiento del
     * plazo y un aviso tardío de la pasarela pueden llegar en el mismo segundo, y
     * sin el candado el pedido podría quedar cancelado y pagado a la vez, con la
     * reserva ya liberada.
     */
    const pedido = await PedidoPlataforma.findOne({
      where: { businessId, plataforma: cual, pedidoExterno: externo },
      transaction: t, lock: t.LOCK.UPDATE,
    });
    if (!pedido) {
      await t.rollback();
      throw error('Ese pedido no está en la cola.', 404);
    }

    // El mismo cobro reenviado: se contesta lo de antes y no se toca nada.
    const yaEstaba = await PlataformaCobro.findOne({
      where: { businessId, plataforma: cual, movimientoExterno: mov }, transaction: t,
    });
    if (yaEstaba) {
      await t.commit();
      return { cobro: yaEstaba, pedido, repetido: true };
    }

    const avisos = [];
    let aplicado = true;

    /*
     * La misma referencia de pasarela con otro id de movimiento.
     *
     * Puede ser un doble cobro de verdad, o dos transferencias que una persona
     * anotó con la misma referencia. Se guarda sin aplicar y con el motivo, que es
     * lo que permite revisarlo; una restricción de unicidad acá rechazaría un
     * cobro real y la plataforma reintentaría para siempre.
     */
    if (refe) {
      const mismaRefe = await PlataformaCobro.findOne({
        where: { businessId, operacion: refe }, transaction: t,
      });
      if (mismaRefe) {
        aplicado = false;
        avisos.push(`La operación ${refe} ya estaba registrada en otro cobro (${mismaRefe.movimientoExterno}): revisar antes de dar por cobrado.`);
      }
    }

    /*
     * Un cobro sobre un pedido que ya no espera plata se anota igual.
     *
     * Y NO se vuelve a reservar: la mercadería ya se liberó y re-reservarla le
     * robaría stock a otro pedido que sí está esperando.
     */
    if (pedido.estado === 'cancelado') {
      aplicado = false;
      avisos.push('Cobró sobre un pedido cancelado: la mercadería ya se liberó y hay que devolver el dinero.');
    } else if (pedido.estado === 'rechazado') {
      aplicado = false;
      avisos.push('Cobró sobre un pedido rechazado por falta de stock: hay que devolver el dinero.');
    }

    const cobro = await PlataformaCobro.create({
      businessId, pedidoId: pedido.id, plataforma: cual,
      movimientoExterno: mov,
      importe: monto, medio: comoSeCobro, operacion: refe,
      recibidoEn: new Date(),
      ocurrioEn: fechaDeCorte(ocurrioEn),
      aplicado,
      estadoPedidoAlCobrar: pedido.estado,
      motivo: avisos.join(' ').slice(0, 500) || null,
    }, { transaction: t });

    if (aplicado) {
      const cobradoAhora = Number(pedido.cobrado || 0) + monto;
      const total = pedido.total == null ? null : Number(pedido.total);
      /*
       * Alcanza si no hay con qué comparar, o si llega al total con la misma
       * tolerancia que usa el resto del sistema. Si pagó de más, paga igual: nunca
       * se retiene un paquete porque el cliente puso unos pesos extra.
       */
      const alcanza = total == null || cobradoAhora >= total - TOLERANCIA_COBRO;
      const detalle = alcanza
        ? null
        : `Cobrado ${cobradoAhora} de ${total}`.slice(0, 120);
      await pedido.update({
        cobrado: cobradoAhora,
        pagoEstado: alcanza ? PAGO_PAGADO : PAGO_PENDIENTE,
        // Deja de haber plazo que vencer cuando ya está pagado.
        pagoVenceEn: alcanza ? null : pedido.pagoVenceEn,
        pagoDetalle: alcanza ? null : (detalle || pedido.pagoDetalle),
        // La novedad, para que la plataforma lo vea en el feed.
        novedadEn: new Date(),
      }, { transaction: t });
    }

    await t.commit();
    if (!aplicado) {
      log.warn('cola-online', 'cobro registrado sin aplicar', {
        pedido: externo, movimiento: mov, motivo: avisos.join(' '),
      });
    }
    return { cobro, pedido: await PedidoPlataforma.findByPk(pedido.id), repetido: false };
  } catch (e) {
    await t.rollback().catch(() => {});
    /*
     * Perdió la carrera contra el índice único: dos avisos de la pasarela en
     * vuelo al mismo tiempo. El otro ya lo registró, así que se contesta eso.
     */
    if (e?.name === 'SequelizeUniqueConstraintError') {
      const ganador = await PlataformaCobro.findOne({
        where: { businessId, plataforma: cual, movimientoExterno: mov },
      });
      if (ganador) {
        return {
          cobro: ganador,
          pedido: await PedidoPlataforma.findByPk(ganador.pedidoId),
          repetido: true,
        };
      }
    }
    throw e;
  }
}

/*
 * ══ Los pedidos a los que se les venció el plazo de pago ═════════
 *
 * Es la contracara de guardar el pago pendiente. Mientras un pedido espera, la
 * mercadería está apartada y lo publicable es `stock - reservado`: la prenda ya
 * desapareció de la vidriera, de Mercado Libre y de Jumpseller.
 *
 * La plataforma dice que va a cancelar cuando el plazo venza, y seguramente lo
 * haga. Pero si se cae, se desconecta o se le pierde el trabajo del vencimiento,
 * esa reserva queda para siempre y el stock desaparece sin que nadie sepa por
 * qué. Esto es el reloj propio de Stocker, que no depende de que nadie cumpla.
 *
 * `cancelarPorPlataforma` ya hace todo lo necesario: traba el pedido, sale
 * temprano si ya estaba cancelado —así que correr en varias instancias no
 * duplica nada—, libera la reserva o el pack, y escribe la cancelación. Y el
 * pedido aparece en la pestaña Cancelados el día que venció.
 */
const GRACIA_VENCIMIENTO_MS = Number(process.env.PAGO_GRACIA_MS) || 5 * 60 * 1000;

async function liberarPagosVencidos({ gracia = GRACIA_VENCIMIENTO_MS, tope = 200 } = {}) {
  const { Op } = require('sequelize');
  const vencidos = await PedidoPlataforma.findAll({
    where: {
      pagoEstado: PAGO_PENDIENTE,
      pagoVenceEn: { [Op.ne]: null, [Op.lt]: new Date(Date.now() - gracia) },
      canceladoEn: null,
    },
    order: [['pagoVenceEn', 'ASC'], ['id', 'ASC']],
    limit: tope,
    attributes: ['id', 'pedidoExterno'],
  });
  if (!vencidos.length) return { liberados: 0 };

  let liberados = 0;
  for (const p of vencidos) {
    try {
      await cancelarPorPlataforma(p.id, 'Venció el plazo de pago: se liberó la mercadería apartada');
      liberados += 1;
    } catch (e) {
      /*
       * Uno que falla no se lleva a los demás: cada pedido vencido es mercadería
       * distinta esperando volver a la vidriera.
       */
      log.warn('cola-online', 'no se pudo liberar un pago vencido', {
        pedido: p.pedidoExterno, motivo: e.message,
      });
    }
  }
  if (liberados) {
    log.warn('cola-online', 'pagos vencidos liberados', { liberados });
  }
  return { liberados };
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
  /*
   * Lo que decide si hay que procesar es el ESTADO, no si el pedido es nuevo.
   *
   * Antes alcanzaba con que fuera un reenvío para devolverlo sin tocar: si el
   * primer intento había commiteado la fila 'pendiente' y se moría ahí —un
   * deploy de Railway en el medio, un deadlock, el pool agotado—, el reintento
   * contestaba "ya lo tenía" y nadie volvía a mirar ese pedido nunca. La
   * plataforma lo daba por entregado, en Stocker no había una sola unidad
   * apartada, y el pedido no aparecía en ninguna pantalla.
   *
   * `procesarUno` relee con lock y sale solo si ya no está 'pendiente', así que
   * llamarlo de más no cuesta nada ni aparta dos veces.
   */
  if (pedido.estado !== 'pendiente') return { pedido, repetido };
  const procesado = await procesarUno(pedido.id);
  return { pedido: procesado || pedido, repetido };
}

module.exports = {
  encolar, procesarUno, procesarCola, encolarYProcesar, reprocesar, PLATAFORMAS,
  rescatarPendientes, PAGO_PENDIENTE, PAGO_PAGADO, __estadoDePago: estadoDePago,
  registrarCobro, liberarPagosVencidos,
  partesDeItem, cancelarPorPlataforma,
};
