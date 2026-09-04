/*
 * El único lugar donde se escribe stock.
 *
 * Desde que cada local tiene el suyo, un movimiento toca dos cosas que no
 * pueden separarse: la fila del local y el total de la variante. Si un
 * controlador actualizara una sola, el total quedaría mintiendo — y un total
 * equivocado no se nota hasta que alguien va a buscar mercadería que el sistema
 * dice tener.
 *
 * Por eso todo pasa por acá: venta, ajuste manual, escaneo, importación de
 * Excel y devoluciones. Ningún otro archivo hace `variant.update({ stock })`.
 */

const { Op, literal } = require('sequelize');
const { ProductVariant, VariantStock, BusinessLocation, StockMovement, Employee, Product } = require('../models');
const { CON_STOCK } = require('../config/lugares');

/*
 * A qué local va un movimiento que no lo aclara.
 *
 * El primer local activo del negocio. Existe porque hay tres caminos que no
 * siempre saben dónde están parados —el dueño ajustando desde la oficina, una
 * importación de Excel, una venta vieja sin local— y la alternativa sería
 * dejar ese stock fuera de todos los locales, o sea invisible.
 *
 * Un negocio sin locales cargados devuelve null: ahí el stock queda sólo en el
 * total, que es lo que había antes de esta función y sigue siendo correcto.
 */
/*
 * De qué local se trata, comprobando que sea de este negocio.
 *
 * Existe porque el patrón "tomo locationId del cuerpo y si no viene busco uno"
 * estaba copiado en cinco controladores, y en cuatro de ellos el id que mandaba
 * el cliente se usaba tal cual, sin preguntar de quién era. Con eso, un negocio
 * escribía filas de stock contra el local de otro: no leía nada ajeno, pero
 * ensuciaba la contabilidad por local de los dos y podía esconder mercadería en
 * un lugar que su propia pantalla no muestra.
 *
 * El orden de preferencia es el de siempre: lo que se pidió, si no el local del
 * empleado, si no el principal del negocio.
 *
 * @throws si el local pedido no es de este negocio o está inactivo. Es un error
 *   del cliente, no un caso a resolver en silencio eligiendo otro: descartarlo y
 *   seguir con el local por defecto movería stock en un lugar que nadie pidió.
 */
async function resolverLocal({ locationId, businessId, employeeId = null, transaction = null }) {
  if (locationId) {
    const local = await BusinessLocation.findOne({
      where: { id: Number(locationId), businessId, activo: true },
      attributes: ['id'],
      transaction,
    });
    if (!local) {
      throw Object.assign(
        new Error('El local indicado no pertenece a este negocio o está inactivo.'),
        { status: 400 },
      );
    }
    return local.id;
  }

  if (employeeId) {
    const emp = await Employee.findByPk(employeeId, { attributes: ['locationId'], transaction });
    if (emp?.locationId) return emp.locationId;
  }

  return localPorDefecto(businessId, transaction);
}

/*
 * Si la variante pertenece a un producto de feria.
 *
 * Una sola lectura por id de producto. Se usa en el punto más caliente del
 * sistema, así que se piden sólo las dos columnas que hacen falta.
 */
async function esVarianteDeFeria(variantId, transaction = null) {
  const v = await ProductVariant.findByPk(variantId, {
    attributes: ['id', 'productId'],
    include: [{ model: Product, as: 'producto', attributes: ['id', 'esFeria'] }],
    transaction,
  });
  return Boolean(v?.producto?.esFeria);
}

async function localPorDefecto(businessId, transaction = null) {
  /*
   * Se prefiere un local de venta antes que un depósito.
   *
   * Los caminos que caen acá —un ajuste sin local elegido, una importación,
   * una venta vieja— hablan de mercadería que está en el salón. Si el depósito
   * quedó creado con un id más bajo, el orden por id lo elegía a él y el stock
   * aparecía en la bodega. Sólo se cae al depósito cuando no hay otra cosa.
   */
  const local = await BusinessLocation.findOne({
    // Sólo lugares que llevan inventario. Una feria no puede ser el destino por
    // defecto de un movimiento: no anota stock, así que las unidades se
    // perderían sin que nada avise.
    where: { businessId, activo: true, tipo: { [Op.in]: CON_STOCK } },
    order: [['id', 'ASC']],
    transaction,
  });
  if (local) return local.id;

  const cualquiera = await BusinessLocation.findOne({
    where: { businessId, activo: true },
    order: [['id', 'ASC']],
    transaction,
  });
  return cualquiera?.id || null;
}

/*
 * La fila de stock de una variante en un local, creándola si no existe.
 *
 * Se crea en cero: un local que nunca recibió una prenda tiene cero de ella, no
 * "sin dato". Eso permite mostrar la grilla completa de locales sin huecos.
 */
async function filaDe(variantId, locationId, businessId, t) {
  const [fila] = await VariantStock.findOrCreate({
    where: { productVariantId: variantId, locationId },
    defaults: { productVariantId: variantId, locationId, businessId, stock: 0 },
    transaction: t,
    lock: t ? t.LOCK.UPDATE : undefined,
  });
  return fila;
}

/*
 * Recalcula el total de la variante como la suma de sus locales.
 *
 * Se recalcula en vez de sumar el delta al total anterior. Sumar arrastra
 * cualquier desvío para siempre: si un total quedó mal por una migración a
 * medias o por un bug viejo, el error se propaga a cada movimiento. Recalcular
 * lo corrige solo en el primer movimiento que toque esa variante.
 */
async function recalcularTotal(variantId, t) {
  const filas = await VariantStock.findAll({
    where: { productVariantId: variantId },
    attributes: ['stock'],
    transaction: t,
  });
  const total = filas.reduce((s, f) => s + (Number(f.stock) || 0), 0);
  await ProductVariant.update({ stock: total }, { where: { id: variantId }, transaction: t });
  return total;
}

/**
 * Mueve stock de una variante en un local y deja el movimiento registrado.
 *
 * Una de dos: `delta` (suma o resta) o `fijar` (deja el stock en ese número).
 * Devuelve { stockAnterior, stockNuevo, total, locationId } del LOCAL, no del
 * total: quien llama necesita saber qué pasó donde lo pidió.
 *
 * `permitirNegativo` existe para las devoluciones y correcciones; el resto de
 * los caminos deja que reviente, porque un stock negativo es un dato falso que
 * después nadie sabe de dónde salió.
 */
async function mover({
  variantId, businessId, locationId = null,
  delta = null, fijar = null,
  tipo, motivo = null, employeeId = null, saleItemId = null,
  transaction: t,
  permitirNegativo = false,
  registrarMovimiento = true,
}) {
  if (delta === null && fijar === null) throw new Error('mover() necesita delta o fijar.');

  /*
   * Un producto de feria no mueve stock. Nunca.
   *
   * Esta es la garantía, no una validación más: `mover` es el único lugar del
   * sistema que escribe inventario, así que cortando acá ningún camino —venta,
   * anulación, ajuste, escáner, importación, transferencia, reposición— puede
   * dejarle stock a un producto que por definición no lo lleva. Los caminos
   * normales ni siquiera llegan hasta acá: la venta saltea las líneas de feria
   * antes. Esto es lo que atrapa al camino que alguien agregue mañana y se
   * olvide de saltearlas.
   *
   * Corta con error y no en silencio: que un producto de feria llegue hasta acá
   * significa que hay un camino mal escrito, y un no-op lo dejaría escondido
   * hasta que alguien notara números raros meses después.
   */
  const deFeria = await esVarianteDeFeria(variantId, t);
  if (deFeria) {
    const err = new Error('Los productos de evento no llevan stock: no se les puede registrar un movimiento.');
    err.status = 409;
    err.codigo = 'FERIA_SIN_STOCK';
    throw err;
  }

  const local = locationId || await localPorDefecto(businessId, t);
  if (!local) {
    /*
     * Sin locales cargados no hay dónde poner el stock. Antes esto no podía
     * pasar porque el stock no tenía lugar; ahora sí, y hay que decirlo en vez
     * de perder el movimiento en silencio.
     */
    const err = new Error('El negocio no tiene ningún local cargado. Creá al menos uno para poder mover stock.');
    err.status = 409;
    throw err;
  }

  const fila = await filaDe(variantId, local, businessId, t);
  let stockAnterior = Number(fila.stock) || 0;
  let stockNuevo = fijar !== null ? Number(fijar) : stockAnterior + Number(delta);

  if (stockNuevo < 0 && !permitirNegativo) {
    const err = new Error(`Quedaría en ${stockNuevo}: no se puede sacar más de lo que hay en el local.`);
    err.status = 409;
    err.disponible = stockAnterior;
    throw err;
  }

  const saca = fijar === null && Number(delta) < 0 && !permitirNegativo;
  if (saca) {
    /*
     * ── No vender dos veces la misma prenda ──────────────────────
     *
     * La resta se hace en la base y condicionada: bajá tanto, pero sólo si
     * todavía hay tanto. Si no queda, no se actualiza ninguna fila y ahí nos
     * enteramos.
     *
     * Antes esto era leer, restar en JavaScript y escribir. Alcanzaba mientras
     * las ventas entraran de a una, pero con dos entrando juntas —una del salón
     * y una de Mercado Libre, o dos plataformas sobre la última unidad— las dos
     * leían "queda 1", las dos escribían 0, y se despachaban dos prendas que no
     * existían. Se probó con el lock del SELECT y no alcanzó: sirve en un
     * script suelto y no se aplicaba corriendo dentro del servidor.
     *
     * Con la resta condicionada no hay lectura de la que fiarse. Es la base la
     * que decide, en la misma operación en la que escribe, y no hay ventana
     * entre una cosa y la otra. Vale igual en SQL Server que en Postgres y no
     * depende de en qué nivel de aislamiento esté la conexión.
     *
     * `permitirNegativo` sigue por el camino de siempre: ahí bajar de cero es
     * justamente lo que se pidió.
     */
    const pide = -Number(delta);
    /*
     * La condición es sobre lo DISPONIBLE, no sobre el stock.
     *
     * Si hay 3 en el estante y 2 están apartados para un pedido online, el
     * mostrador puede vender 1. Preguntando por `stock` vendería las 3 y el
     * pedido online se quedaría sin la mercadería que ya tenía prometida —que
     * es exactamente el problema que la reserva vino a resolver, mudado de
     * lugar.
     */
    const [filasTocadas] = await VariantStock.update(
      { stock: literal(`stock - ${pide}`) },
      {
        where: { id: fila.id, [Op.and]: [literal(`stock - reservado >= ${pide}`)] },
        transaction: t,
      },
    );

    if (!filasTocadas) {
      await fila.reload({ transaction: t });
      const hay = Number(fila.stock) || 0;
      const apartado = Number(fila.reservado) || 0;
      const libre = Math.max(0, hay - apartado);
      /*
       * El mensaje distingue los dos casos. "No alcanza" cuando hay 1 y se
       * piden 3 es una cosa; cuando hay 3 pero 2 están apartados para pedidos
       * online es otra, y mandan a hacer cosas distintas: en el primero hay que
       * conseguir mercadería, en el segundo hay que mirar los pedidos.
       */
      const err = new Error(apartado > 0
        ? `Quedaría en ${libre - pide}: hay ${hay} en el local pero ${apartado} `
          + 'están apartadas para pedidos online que todavía no se despacharon.'
        : `Quedaría en ${libre - pide}: no se puede sacar más de lo que hay en el local.`);
      err.status = 409;
      err.disponible = libre;
      err.enElLocal = hay;
      err.reservado = apartado;
      throw err;
    }

    // El movimiento tiene que contar lo que pasó de verdad, no lo que se
    // suponía al leer: entre la lectura y la resta el stock pudo haber cambiado.
    await fila.reload({ transaction: t });
    stockNuevo = Number(fila.stock) || 0;
    stockAnterior = stockNuevo + pide;
  } else {
    /*
     * Un recuento no puede dejar el estante con menos de lo que está apartado.
     *
     * Si el conteo dice 2 y hay 3 comprometidas para pedidos online, el
     * problema no es el número: es que uno de esos pedidos no se va a poder
     * despachar. Ajustar en silencio dejaría la invariante rota y el faltante
     * apareciendo recién cuando el pickeador no encuentre la prenda.
     */
    if (fijar !== null) {
      await fila.reload({ transaction: t });
      const apartado = Number(fila.reservado) || 0;
      if (stockNuevo < apartado) {
        const err = new Error(
          `No se puede dejar el stock en ${stockNuevo}: hay ${apartado} unidad(es) apartadas `
          + 'para pedidos online sin despachar. Resolvé esos pedidos primero.',
        );
        err.status = 409;
        err.reservado = apartado;
        throw err;
      }
    }
    await fila.update({ stock: stockNuevo }, { transaction: t });
  }
  const total = await recalcularTotal(variantId, t);

  if (registrarMovimiento) {
    await StockMovement.create({
      productVariantId: variantId,
      locationId: local,
      employeeId,
      saleItemId,
      tipo,
      cantidad: fijar !== null ? Number(fijar) : Math.abs(Number(delta)),
      stockAnterior, stockNuevo,
      motivo: motivo || '',
      fechaMovimiento: new Date(),
    }, { transaction: t });
  }

  /*
   * MercadoLibre se entera de que este SKU cambió.
   *
   * Va acá porque es el único lugar donde se escribe stock: enganchado en el
   * controlador de ventas se perdería lo que mueven las transferencias, los
   * ingresos y los ajustes, y la publicación quedaría desactualizada
   * justamente cuando entra mercadería nueva.
   *
   * Sin await y con el error atrapado: la venta no puede depender de que
   * MercadoLibre responda. Adentro se agrupa unos segundos y se descarta solo
   * si el negocio no tiene la integración conectada.
   */
  if (registrarMovimiento) {
    try {
      const variante = await ProductVariant.findByPk(variantId, {
        attributes: ['id', 'sku'], transaction: t,
      });
      if (variante?.sku) require('./mercadolibreService').marcarParaSync(businessId, variante.sku);
    } catch { /* avisarle a ML nunca puede tumbar un movimiento de stock */ }
  }

  return { stockAnterior, stockNuevo, total, locationId: local };
}

/** Cuánto hay de una variante en un local. */
/*
 * ── De dónde sale lo que se vende por internet ─────────────────────
 *
 * De los locales marcados como `abasteceOnline`, y de ninguno más.
 *
 * No de la tienda `online`: ésa identifica el CANAL —sirve para saber que una
 * venta vino de internet y no del mostrador— pero en la práctica no lleva
 * inventario. Publicando su stock se ofrecían quince unidades teniendo dos mil
 * ochocientas en los locales.
 *
 * Tampoco del depósito: su mercadería está para reponer los locales y puede
 * salir hacia una sucursal en cualquier momento. Publicarla es ofrecer online
 * algo que quizá ya esté en un camión.
 */
async function localesQueAbastecenOnline(businessId, t = null) {
  const { BusinessLocation } = require('../models');
  return BusinessLocation.findAll({
    where: { businessId, activo: true, abasteceOnline: true },
    attributes: ['id', 'nombre'],
    order: [['id', 'ASC']],
    transaction: t,
  });
}

/**
 * Cuántas unidades de una variante se pueden ofrecer online.
 *
 * Es la SUMA de los locales que abastecen. Publicar sólo el de uno dejaría sin
 * ofrecer lo que hay en el otro, y el negocio pierde ventas que sí podía hacer.
 */
async function stockOnline(variantId, businessId, t = null) {
  const locales = await localesQueAbastecenOnline(businessId, t);
  if (!locales.length) return { total: 0, porLocal: [], sinLocales: true };

  const porLocal = [];
  let total = 0;
  for (const l of locales) {
    const n = await stockEn(variantId, l.id, t);
    porLocal.push({ locationId: l.id, nombre: l.nombre, stock: n });
    total += n;
  }
  return { total, porLocal, sinLocales: false };
}

/**
 * Reparte un descuento online entre los locales que abastecen.
 *
 * Se saca primero del que MÁS tiene, y se sigue con el siguiente si no alcanza.
 *
 * Por qué del que más tiene y no por un orden fijo: con una prioridad fija, el
 * primer local se vacía mientras el segundo queda intacto, y el vendedor del
 * primero se queda sin nada para ofrecer en el salón. Sacando del más cargado
 * los locales se emparejan solos, sin que nadie tenga que mantener un orden.
 *
 * Devuelve el reparto SIN escribir nada. Quien lo llama decide si mueve.
 *
 * @returns {{alcanza: boolean, falta: number, reparto: Array<{locationId, nombre, unidades}>}}
 */
async function repartirDescuentoOnline(variantId, businessId, cantidad, t = null) {
  const { porLocal } = await stockOnline(variantId, businessId, t);
  const candidatos = porLocal.filter((l) => l.stock > 0).sort((a, b) => b.stock - a.stock);

  const reparto = [];
  let restante = cantidad;
  for (const l of candidatos) {
    if (restante <= 0) break;
    const toma = Math.min(l.stock, restante);
    reparto.push({ locationId: l.locationId, nombre: l.nombre, unidades: toma });
    restante -= toma;
  }
  return { alcanza: restante <= 0, falta: restante, reparto };
}

/* ═══════════════════════════════════════════════════════════════════
 * Reservas
 *
 * Una venta online aparta la unidad en el momento en que entra. Nadie más la
 * puede vender, pero sigue en el estante hasta que alguien la pickea: recién
 * ahí la reserva se convierte en egreso.
 *
 * Las tres operaciones se hacen con la MISMA técnica que la resta de `mover`:
 * una sola sentencia condicionada, sin leer antes. No hay ventana entre mirar
 * y escribir, así que dos pedidos simultáneos por la última unidad no pueden
 * reservarla los dos, y no depende del nivel de aislamiento de la conexión.
 *
 * Son el único lugar que escribe `reservado`. La invariante
 * `0 <= reservado <= stock` la sostienen las condiciones de cada UPDATE.
 * ═══════════════════════════════════════════════════════════════════ */

/** Cuánto se puede comprometer en un local: lo que hay menos lo apartado. */
async function disponibleEn(variantId, locationId, t = null) {
  if (!locationId) return 0;
  const fila = await VariantStock.findOne({
    where: { productVariantId: variantId, locationId },
    transaction: t,
  });
  if (!fila) return 0;
  return Math.max(0, (Number(fila.stock) || 0) - (Number(fila.reservado) || 0));
}

/**
 * Aparta unidades. Devuelve true si se pudo, false si no alcanzaba.
 *
 * La condición es sobre lo DISPONIBLE, no sobre el stock: si hay 3 en el
 * estante y 2 ya están apartados para otro pedido, sólo queda 1 para reservar.
 */
async function reservar(variantId, locationId, businessId, cantidad, t = null) {
  const n = Number(cantidad);
  if (!Number.isInteger(n) || n <= 0) {
    const err = new Error('La cantidad a reservar tiene que ser un entero mayor a cero.');
    err.status = 400;
    throw err;
  }
  const fila = await filaDe(variantId, locationId, businessId, t);
  const [tocadas] = await VariantStock.update(
    { reservado: literal(`reservado + ${n}`) },
    {
      where: { id: fila.id, [Op.and]: [literal(`stock - reservado >= ${n}`)] },
      transaction: t,
    },
  );
  return tocadas > 0;
}

/**
 * Suelta una reserva sin mover mercadería. Es lo que corresponde cuando el
 * pedido se cancela: la prenda nunca salió, así que vuelve a estar vendible.
 */
async function liberarReserva(variantId, locationId, businessId, cantidad, t = null) {
  const n = Number(cantidad);
  if (!Number.isInteger(n) || n <= 0) return false;
  const fila = await filaDe(variantId, locationId, businessId, t);
  const [tocadas] = await VariantStock.update(
    { reservado: literal(`reservado - ${n}`) },
    {
      where: { id: fila.id, reservado: { [Op.gte]: n } },
      transaction: t,
    },
  );
  return tocadas > 0;
}

/**
 * La reserva se convierte en salida: baja el stock y suelta el apartado, en la
 * misma sentencia.
 *
 * En dos pasos —liberar y después `mover`— habría un instante en el que la
 * unidad vuelve a estar disponible, y en ese instante el mostrador puede
 * venderla. Es el mismo hueco que la reserva vino a cerrar.
 *
 * El movimiento se registra aparte, con `registrarSalidaReservada`, para que el
 * libro de movimientos siga siendo la única fuente de qué pasó.
 */
async function consumirReserva(variantId, locationId, businessId, cantidad, t = null) {
  const n = Number(cantidad);
  if (!Number.isInteger(n) || n <= 0) return false;
  const fila = await filaDe(variantId, locationId, businessId, t);
  const [tocadas] = await VariantStock.update(
    {
      stock:     literal(`stock - ${n}`),
      reservado: literal(`reservado - ${n}`),
    },
    {
      where: {
        id: fila.id,
        [Op.and]: [literal(`reservado >= ${n}`), literal(`stock >= ${n}`)],
      },
      transaction: t,
    },
  );
  if (!tocadas) return false;
  await recalcularTotal(variantId, t);
  return true;
}

async function stockEn(variantId, locationId, t = null) {
  if (!locationId) return null;
  const fila = await VariantStock.findOne({
    where: { productVariantId: variantId, locationId },
    transaction: t,
  });
  return Number(fila?.stock) || 0;
}

/**
 * El desglose por local de varias variantes, en una consulta.
 *
 * Una consulta por variante convertiría el listado de un producto de veinte
 * variantes en veinte viajes a la base.
 */
async function desglosePorVariante(variantIds, businessId) {
  if (!variantIds.length) return new Map();
  const filas = await VariantStock.findAll({
    where: { productVariantId: { [Op.in]: variantIds }, businessId },
    include: [{ association: 'local', attributes: ['id', 'nombre', 'activo'] }],
    order: [['locationId', 'ASC']],
  });
  const mapa = new Map();
  for (const f of filas) {
    if (!mapa.has(f.productVariantId)) mapa.set(f.productVariantId, []);
    mapa.get(f.productVariantId).push({
      locationId: f.locationId,
      local: f.local?.nombre || null,
      activo: f.local?.activo ?? true,
      stock: Number(f.stock) || 0,
      stockMinimo: f.stockMinimo,
    });
  }
  return mapa;
}

/*
 * Mueve stock de un local a otro.
 *
 * Son dos movimientos con el mismo motivo, no uno: en el libro tiene que
 * quedar la salida de un local y la entrada en el otro, porque es lo que se
 * mira cuando falta mercadería en el destino.
 */
async function transferir({ variantId, businessId, desde, hacia, cantidad, employeeId = null, motivo = null, transaction: t }) {
  const n = Number(cantidad);
  if (!Number.isFinite(n) || n <= 0) {
    const err = new Error('La cantidad a transferir tiene que ser mayor a cero.'); err.status = 400; throw err;
  }
  if (!desde || !hacia || Number(desde) === Number(hacia)) {
    const err = new Error('Elegí un local de origen y otro de destino distintos.'); err.status = 400; throw err;
  }

  const nota = motivo || 'Transferencia entre locales';
  const salida = await mover({
    variantId, businessId, locationId: desde, delta: -n,
    tipo: 'egreso', motivo: `${nota} (sale)`, employeeId, transaction: t,
  });
  const entrada = await mover({
    variantId, businessId, locationId: hacia, delta: n,
    tipo: 'ingreso', motivo: `${nota} (entra)`, employeeId, transaction: t,
  });
  return { salida, entrada };
}

module.exports = {
  // Reservas: apartar al vender, consumir al despachar. Ver el bloque de arriba.
  disponibleEn, reservar, liberarReserva, consumirReserva,
  mover, stockEn, desglosePorVariante, transferir, localPorDefecto, resolverLocal,
  recalcularTotal, esVarianteDeFeria,
  localesQueAbastecenOnline, stockOnline, repartirDescuentoOnline,
};
