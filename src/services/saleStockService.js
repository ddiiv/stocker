const { SaleItem, ProductVariant, Product } = require('../models');
const stockService = require('./stockService');
const packService = require('./packService');

/*
 * Salida de mercadería de una venta.
 *
 * Antes esto vivía suelto dentro del controlador y se disparaba cuando la
 * venta pasaba a "pagado". Con las ventas fiadas cobrar y entregar dejaron de
 * ser el mismo momento: el cliente puede llevarse la ropa hoy y pagar la
 * semana que viene, o dejarla señada y retirarla al pagar. Por eso ahora la
 * verdad la lleva `sale.stockDescontado` y no el estado de la venta.
 *
 * La función es idempotente: si el stock ya salió, no hace nada. Es lo que
 * evita que cobrar una venta fiada descuente por segunda vez lo mismo.
 *
 * ── Faltantes ──────────────────────────────────────────────────────
 *
 * Éste es el ÚNICO lugar que decide qué pasa cuando la venta pide más de lo
 * que el sistema tiene cargado. Antes la decisión estaba también en
 * createSale, sobre un stock leído sin trabar: dos copias de la misma regla
 * sobre dos lecturas distintas. Acá las filas ya están bloqueadas, así que lo
 * que se ve es lo que va a haber cuando se escriba.
 *
 * La regla es una sola:
 *
 *   · Si no falta nada, se descuenta y listo.
 *   · Si falta y el negocio está en "bloquear", se corta. El dueño pidió
 *     expresamente que no se venda lo que no está cargado.
 *   · Si falta y todavía no lo confirmaron, se corta con la lista de lo que
 *     falta para que la pantalla la muestre y pregunte.
 *   · Si falta y ya lo confirmaron, se da de alta la diferencia y RECIÉN
 *     DESPUÉS se descuenta la venta entera.
 *
 * Ese orden —alta primero, egreso después— es lo que deja el libro de
 * movimientos contando la historia real: entraron 3 que no estaban cargadas,
 * salieron 5 por la venta. Descontar en negativo y "arreglarlo" después
 * cuenta la misma plata pero no la misma historia, y es la que alguien va a
 * leer cuando el conteo no cierre.
 */

const MINIMO = 1;

/*
 * Qué mercadería mueve de verdad cada línea de la venta.
 *
 * Un pack no tiene stock propio: vender "Pack x3 Baby Tee" saca tres remeras
 * del estante, no un pack. Si esto no estuviera, vender un pack en el mostrador
 * intentaría descontar de la variante del pack —que siempre está en cero— y
 * terminaría dando de alta un pack fantasma y dejando las tres remeras en el
 * sistema. El inventario quedaría mal de las dos puntas.
 *
 * Se expande ACÁ y no en cada pantalla por el mismo motivo por el que el
 * faltante y el alta se deciden en este archivo: es el único lugar por el que
 * pasan todos los caminos que sacan mercadería —POS, ventas, una cotización que
 * se factura, una fiada que se cobra—. Puesto en el controlador, el primer
 * camino que alguien agregue mañana se lo saltea.
 *
 * Y agrupa por variante, cosa que antes no hacía. Dos líneas de la misma remera
 * —una suelta y otra adentro de un pack— piden seis unidades entre las dos;
 * comparadas por separado contra el mismo stock, las dos parecían alcanzar y el
 * faltante recién aparecía al escribir.
 *
 * @returns {Promise<Map<number, {variant, pide, origenes: Array}>>}
 */
async function requerimientos(items, t, { trabar = false } = {}) {
  /*
   * Primera pasada sin trabar: sólo para saber QUÉ variantes entran en juego.
   *
   * Trabar en el orden en que vienen las líneas es pedir un abrazo mortal: dos
   * ventas simultáneas con los mismos artículos en distinto orden se quedan
   * cada una esperando la fila que tiene la otra. Con packs deja de ser
   * hipotético —un pack y una prenda suelta comparten variante— así que primero
   * se junta el conjunto y después se traba en orden de id, siempre igual.
   */
  const pedidos = [];
  for (const item of items) {
    if (!item.productVariantId) continue;

    /*
     * Las líneas de evento no mueven inventario.
     *
     * Un producto de evento se vende sin llevar stock: lo único que importa es
     * que quede registrado qué salió. Saltear acá es lo que hace que una venta
     * mixta no rompa y, sobre todo, que la venta nunca llegue a
     * `stockService.mover`, que rechaza estas variantes como último resguardo.
     */
    if (await stockService.esVarianteDeFeria(item.productVariantId, t)) continue;

    const variant = await ProductVariant.findByPk(item.productVariantId, { transaction: t });
    if (!variant) continue;

    if (!variant.esPack) {
      pedidos.push({ variantId: variant.id, cantidad: item.cantidad, item, pack: null });
      continue;
    }

    const componentes = (await packService.componentesDe([variant.id], t)).get(variant.id) || [];
    /*
     * Un pack sin composición no se puede vender.
     *
     * Podría dejarse pasar como "no descuenta nada", pero eso es exactamente lo
     * que no se quiere: la venta saldría, el cliente se llevaría tres remeras y
     * el inventario no se enteraría. Que reviente acá, con el nombre del pack,
     * es la única forma de que alguien lo arregle.
     */
    if (!componentes.length) {
      throw Object.assign(
        new Error(`El pack ${variant.sku} no tiene componentes cargados, así que no se sabe `
          + 'qué mercadería sacar. Cargá su composición en Stock › Packs antes de venderlo.'),
        { status: 409, codigo: 'PACK_SIN_COMPONENTES' },
      );
    }
    for (const c of componentes) {
      pedidos.push({
        variantId: c.componenteVariantId,
        cantidad: item.cantidad * c.cantidad,
        item,
        pack: variant,
      });
    }
  }

  // Ahora sí: trabadas en orden de id, el mismo para todas las ventas.
  const ids = [...new Set(pedidos.map((p) => p.variantId))].sort((a, b) => a - b);
  const porId = new Map();
  for (const id of ids) {
    const v = await ProductVariant.findByPk(id, {
      transaction: t, ...(trabar ? { lock: t.LOCK.UPDATE } : {}),
    });
    if (v) porId.set(id, v);
  }

  const mapa = new Map();
  for (const p of pedidos) {
    const variant = porId.get(p.variantId);
    if (!variant) continue;
    if (!mapa.has(p.variantId)) mapa.set(p.variantId, { variant, pide: 0, origenes: [] });
    const fila = mapa.get(p.variantId);
    fila.pide += p.cantidad;
    fila.origenes.push({ item: p.item, cantidad: p.cantidad, pack: p.pack });
  }
  return mapa;
}

/**
 * Descuenta el stock de la venta si todavía no salió.
 *
 * @param {object}  sale
 * @param {object}  t                       transacción en curso (obligatoria en la práctica)
 * @param {number}  [opts.employeeId]
 * @param {string}  [opts.motivo]
 * @param {boolean} [opts.confirmarAltaStock] la persona ya confirmó dar de alta lo que falta
 * @returns {Promise<{descontado: boolean, altas: Array}>}
 */
async function descontarStockVenta(sale, t, { employeeId = null, motivo = null, confirmarAltaStock = false } = {}) {
  if (sale.stockDescontado) return { descontado: false, altas: [] };

  /*
   * Qué hace el negocio cuando falta stock: se puede dar de alta con
   * confirmación (por defecto) o no se vende. Se lee una vez, no por línea.
   */
  const { Business } = require('../models');
  const negocio = await Business.findByPk(sale.businessId, {
    attributes: ['id', 'ventaSinStock'], transaction: t,
  });
  const politica = negocio?.ventaSinStock === 'bloquear' ? 'bloquear' : 'permitir';

  const items = sale.items?.length
    ? sale.items
    : await SaleItem.findAll({ where: { saleId: sale.id }, transaction: t });

  /*
   * El stock sale del local donde se hizo la venta.
   *
   * Antes se descontaba del total de la variante, que era el único que había.
   * Ahora la mercadería está en algún lado: vender en Palermo tiene que bajar
   * el stock de Palermo, no el del depósito. Sin local en la venta —ventas
   * viejas, o un negocio de un solo punto— cae al local principal.
   */
  const local = sale.locationId || await stockService.localPorDefecto(sale.businessId, t);

  /*
   * ── Primera vuelta: mirar, con las filas trabadas ────────────────
   *
   * Se recorre todo ANTES de escribir nada. Frenar en la mitad dejaría media
   * venta descontada, y sobre todo: la pantalla necesita la lista COMPLETA de
   * lo que falta para preguntarlo de una sola vez. Preguntar prenda por prenda
   * con un cliente adelante no es una opción.
   *
   * El lock se toma acá y se suelta recién en el commit, así que lo que se lee
   * en esta vuelta sigue valiendo en la segunda: dos cajas vendiendo la última
   * unidad a la vez no pueden leer las dos el mismo stock.
   */
  const requerido = await requerimientos(items, t, { trabar: true });

  const lineas = [];
  for (const fila of requerido.values()) {
    /*
     * Se compara contra el stock DEL LOCAL, no contra el total.
     *
     * Que el total alcance no significa que la prenda esté en este local.
     * Vender lo que está en la otra sucursal deja el stock de acá mal y a un
     * cliente esperando algo que no está.
     */
    const disponible = await stockService.stockEn(fila.variant.id, local, t);
    lineas.push({ ...fila, disponible, falta: fila.pide - disponible });
  }

  const faltantes = lineas.filter((l) => l.falta > 0);

  if (faltantes.length) {
    const puedeConfirmar = politica !== 'bloquear';
    const detalle = await Promise.all(faltantes.map(async (l) => ({
      productVariantId: l.variant.id,
      sku:      l.variant.sku,
      nombre:   await nombreDeVariante(l.variant, l.origenes[0].item, t),
      pide:     l.pide,
      hay:      l.disponible,
      falta:    l.falta,
      enOtrosLocales: Math.max(0, (Number(l.variant.stock) || 0) - l.disponible),
      /*
       * De qué pack viene, si viene de uno.
       *
       * Sin esto el cartel dice que falta una remera que la cajera no ve en la
       * pantalla: en el carrito dice "Pack x3", no "Baby Tee negra M". Nombrar
       * el pack es lo que conecta las dos cosas.
       */
      dentroDePack: [...new Set(l.origenes.map((o) => o.pack?.sku).filter(Boolean))].join(', ') || null,
    })));

    if (!puedeConfirmar || !confirmarAltaStock) {
      const nombreLocal = local ? await nombreDeLocal(local, t) : 'este local';
      throw Object.assign(new Error(mensajeFaltantes(detalle, nombreLocal, puedeConfirmar)), {
        status: 409,
        codigo: 'SIN_STOCK',
        /*
         * Viaja plano y también dentro de `detalles`.
         *
         * El manejador de errores del proyecto arma la respuesta desde
         * `detalles`, pero varios lugares leen `error.codigo` directo. Mandar
         * los dos evita que la pantalla reciba un 409 sin saber cuál es.
         */
        puedeConfirmar,
        faltantes: detalle,
        detalles: { codigo: 'SIN_STOCK', puedeConfirmar, faltantes: detalle, local: nombreLocal },
      });
    }

    /*
     * ── El alta, antes que el egreso ─────────────────────────────
     *
     * Sólo se da de alta la DIFERENCIA, calculada acá adentro con la fila
     * trabada. Nunca una cantidad que haya mandado el navegador: si el número
     * viniera de afuera, cualquiera con la sesión abierta podría inventarse
     * inventario mandando un `falta` grande en el cuerpo del pedido.
     */
    for (const l of faltantes) {
      await stockService.mover({
        variantId:  l.variant.id,
        businessId: sale.businessId,
        locationId: local,
        delta:      l.falta,
        tipo:       'ingreso',
        /*
         * El motivo dice que esto lo declaró una persona, no un remito.
         *
         * Es la diferencia entre un ingreso de depósito y esto: acá alguien
         * miró la percha y dijo "está". Que el libro lo distinga es lo que
         * permite, más adelante, preguntarse por qué un producto se declara
         * a mano todas las semanas.
         */
        motivo: `Alta confirmada al vender ${sale.numero}: había ${l.disponible} y se vendieron ${l.pide}`.slice(0, 255),
        employeeId,
        saleItemId: l.origenes[0].item.id,
        transaction: t,
      });
      /*
       * Cuánto se dio de alta, guardado antes de que se pierda.
       *
       * Se anota en un campo aparte en vez de modificar `falta`: la primera
       * versión ponía `falta = 0` después de dar el alta, y el aviso que la
       * pantalla le muestra a la cajera terminaba diciendo "se dieron de alta
       * 0 unidades". El dato que hace falta después no es el estado nuevo,
       * es cuánto entró.
       */
      l.agregadas = l.falta;
    }
  }

  /*
   * ── Segunda vuelta: escribir ─────────────────────────────────────
   *
   * Ya no puede faltar nada: o alcanzaba, o se acaba de dar de alta. Por eso
   * `permitirNegativo` no se pasa: si algo quedara en negativo acá sería un
   * error de este archivo, y prefiero que reviente a que lo tape.
   */
  /*
   * Un movimiento por línea de venta, no uno por variante.
   *
   * Se agrupó para MIRAR —ahí importaba el total contra el estante— pero el
   * libro tiene que poder decir de qué línea salió cada unidad. Con un solo
   * movimiento por variante, una venta con un pack y la misma remera suelta
   * dejaría un renglón de 6 sin forma de saber que 3 eran del pack.
   */
  for (const l of lineas) {
    for (const o of l.origenes) {
      await stockService.mover({
        variantId:  l.variant.id,
        businessId: sale.businessId,
        locationId: local,
        delta:      -o.cantidad,
        tipo:       'egreso',
        motivo: (motivo || `Venta ${sale.numero}`)
          + (o.pack ? ` · pack ${o.pack.sku}` : ''),
        employeeId,
        saleItemId: o.item.id,
        transaction: t,
      });
    }
  }

  await sale.update({ stockDescontado: true }, { transaction: t });

  return {
    descontado: true,
    altas: faltantes.map((l) => ({
      sku: l.variant.sku,
      productVariantId: l.variant.id,
      unidades: l.agregadas || 0,
    })),
  };
}

/**
 * Devuelve al inventario la mercadería de una venta anulada.
 * Igual de idempotente: si el stock nunca salió, no entra nada.
 *
 * Se devuelve lo que se descontó, sin mirar si en su momento hubo que darlo de
 * alta: la prenda que el cliente trae de vuelta existe, y el alta de entonces
 * ya quedó registrada aparte. Restarla acá sería cobrarle dos veces al
 * inventario el mismo faltante.
 */
async function devolverStockVenta(sale, t, { employeeId = null, motivo = null } = {}) {
  if (!sale.stockDescontado) return false;

  const items = sale.items?.length
    ? sale.items
    : await SaleItem.findAll({ where: { saleId: sale.id }, transaction: t });

  // Vuelve al mismo local del que salió: es donde el cliente devuelve la prenda.
  const local = sale.locationId || await stockService.localPorDefecto(sale.businessId, t);

  /*
   * Se devuelve lo mismo que salió, expandido igual.
   *
   * Anular la venta de un pack tiene que devolver las tres remeras al estante,
   * no un pack: es la mercadería que el cliente trae de vuelta. Usar la misma
   * función que el egreso es lo que garantiza que entre exactamente lo que
   * salió, aunque después alguien cambie cómo se expande.
   */
  const requerido = await requerimientos(items, t, { trabar: false });

  for (const fila of requerido.values()) {
    for (const o of fila.origenes) {
      await stockService.mover({
        variantId: fila.variant.id,
        businessId: sale.businessId,
        locationId: local,
        delta: o.cantidad,
        tipo: 'ingreso',
        motivo: (motivo || `Anulación venta ${sale.numero}`)
          + (o.pack ? ` · pack ${o.pack.sku}` : ''),
        employeeId,
        saleItemId: o.item.id,
        transaction: t,
      });
    }
  }

  await sale.update({ stockDescontado: false }, { transaction: t });
  return true;
}

/*
 * El texto del faltante.
 *
 * Dice qué falta, dónde, y qué se puede hacer. Las dos variantes son distintas
 * a propósito: cuando se puede confirmar, la frase termina en una pregunta que
 * la pantalla va a hacer; cuando el negocio lo bloqueó, termina en la única
 * salida que queda, que es cargar el stock.
 */
function mensajeFaltantes(detalle, nombreLocal, puedeConfirmar) {
  const lista = detalle
    .map((f) => `${f.nombre || f.sku} (${f.sku})`
      + (f.dentroDePack ? `, que va dentro del pack ${f.dentroDePack},` : '')
      + `: ${f.hay === 0 ? 'no hay ninguna' : `hay ${f.hay}`} y se venden ${f.pide}`)
    .join('; ');
  const enOtros = detalle.some((f) => f.enOtrosLocales > 0);

  if (!puedeConfirmar) {
    return `Falta stock en ${nombreLocal}. ${lista}. `
      + (enOtros ? 'Hay unidades en otros locales: transferilas desde Stock. ' : '')
      + 'El negocio está configurado para no vender sin stock cargado.';
  }
  return `Falta stock en ${nombreLocal}. ${lista}.`;
}

/*
 * El nombre de la prenda, para el mensaje.
 *
 * Se arma con el título del producto y los valores de variante. Si el producto
 * no se puede leer se cae al título que quedó grabado en la línea de venta:
 * peor nombre, pero nunca "undefined" en un cartel que mira una persona.
 */
async function nombreDeVariante(variant, item, t) {
  let titulo = null;
  try {
    const p = await Product.findByPk(variant.productId, { attributes: ['titulo'], transaction: t });
    titulo = p?.titulo || null;
  } catch { /* se usa el de la línea */ }
  const partes = [titulo || item.titulo, variant.variante1Valor, variant.variante2Valor].filter(Boolean);
  return partes.join(' · ') || item.titulo || variant.sku;
}

/*
 * El nombre del local, sólo para el mensaje de error.
 *
 * Decir "no hay stock" sin decir dónde obliga a adivinar en cuál de las
 * sucursales falta.
 */
async function nombreDeLocal(locationId, t) {
  const { BusinessLocation } = require('../models');
  const l = await BusinessLocation.findByPk(locationId, { attributes: ['nombre'], transaction: t });
  return l?.nombre || 'este local';
}

module.exports = { descontarStockVenta, devolverStockVenta, MINIMO };
