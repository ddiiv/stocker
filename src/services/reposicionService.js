/*
 * Pedidos de reposición: del local al depósito y la mercadería de vuelta.
 *
 * El recorrido completo, con quién interviene en cada paso:
 *
 *   1. LOCAL      arma el pedido con lo que necesita.        → pendiente
 *   2. OFICINA    aprueba, o rechaza con un motivo.          → aprobado | rechazado
 *   3. REPOSICIÓN prepara y despacha lo que hay.             → enviado
 *   4. LOCAL      confirma lo que efectivamente llegó.       → recibido | recibido_parcial
 *
 * El stock sale del depósito al despachar y entra al local recién al confirmar.
 * En el medio queda EN TRÁNSITO: no está en ningún lado, y eso es lo correcto
 * porque físicamente está arriba de una camioneta. La alternativa —mover todo
 * al confirmar— deja al depósito diciendo que tiene mercadería que ya no está,
 * y un faltante se vuelve imposible de ubicar: no se sabe si nunca salió o si
 * se perdió en el camino.
 *
 * Por eso las tres cantidades de cada línea: pedida, enviada y recibida.
 * Pedida vs enviada es lo que el depósito no tenía. Enviada vs recibida es lo
 * que se perdió. Con una sola de las tres, todo faltante es indistinguible de
 * un error de carga.
 */

const { Op } = require('sequelize');
const {
  PedidoReposicion, PedidoReposicionItem, ProductVariant, Product,
  BusinessLocation, Employee, sequelize,
} = require('../models');
const stockService = require('./stockService');
const { ultimoCorrelativo } = require('./invoiceNumberService');
const depositoService = require('./depositoService');

const ABIERTOS = ['pendiente', 'aprobado', 'enviado'];

const error = (mensaje, status = 400, extra = {}) =>
  Object.assign(new Error(mensaje), { status, ...extra });

async function siguienteNumero(businessId, t = null) {
  const now = new Date();
  const prefijo = `REP-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-`;
  // El máximo emitido, no la última fila: el orden de los ids no garantiza el
  // orden de los números en cuanto algo reescribe un `numero` ya guardado.
  const seq = await ultimoCorrelativo(PedidoReposicion, businessId, prefijo, t) + 1;
  return `${prefijo}${String(seq).padStart(5, '0')}`;
}

const INCLUDES = [
  { model: BusinessLocation, as: 'local', attributes: ['id', 'nombre', 'tipo'] },
  { model: BusinessLocation, as: 'deposito', attributes: ['id', 'nombre', 'tipo'] },
  { model: Employee, as: 'solicitadoPor', attributes: ['id', 'nombre', 'apellido'] },
  { model: Employee, as: 'aprobadoPor',   attributes: ['id', 'nombre', 'apellido'] },
  { model: Employee, as: 'enviadoPor',    attributes: ['id', 'nombre', 'apellido'] },
  { model: Employee, as: 'recibidoPor',   attributes: ['id', 'nombre', 'apellido'] },
];

/** Un pedido con sus items, siempre en dos consultas por el corte del JOIN. */
async function traer(pedidoId, businessId, t = null) {
  const pedido = await PedidoReposicion.findOne({
    where: { id: pedidoId, businessId }, include: INCLUDES, transaction: t,
  });
  if (!pedido) throw error('Pedido no encontrado.', 404);
  const items = await PedidoReposicionItem.findAll({
    where: { pedidoId: pedido.id }, order: [['id', 'ASC']], transaction: t,
  });
  return { pedido, items };
}

/*
 * Crea el pedido desde el local.
 *
 * El depósito de origen puede venir elegido o resolverse solo cuando hay uno
 * único: con un solo depósito, preguntarlo es una pregunta sin respuesta
 * posible; con varios hay que decidir y el sistema no puede adivinar.
 */
async function crearPedido({
  businessId, locationId, depositoId = null, employeeId = null,
  items = [], notas = null, transaction: t,
}) {
  const local = await BusinessLocation.findOne({
    where: { id: locationId, businessId, activo: true }, transaction: t,
  });
  if (!local) throw error('El local indicado no pertenece a este negocio o está inactivo.', 400);
  if (local.tipo === 'deposito') {
    throw error('Un depósito no pide reposición: la mercadería nueva le entra directo.', 400);
  }

  let destino = depositoId;
  if (destino) {
    await depositoService.exigirDeposito(destino, businessId, t);
  } else {
    const disponibles = await depositoService.depositos(businessId, t);
    if (!disponibles.length) {
      throw error('El negocio no tiene ningún depósito. Marcá uno de tus locales como depósito desde Empleados → Locales.', 409);
    }
    if (disponibles.length > 1) {
      throw error('Elegí de qué depósito querés que salga el pedido.', 400);
    }
    destino = disponibles[0].id;
  }

  const lineas = await depositoService.armarItems(items, businessId, t);

  const pedido = await PedidoReposicion.create({
    businessId, locationId, depositoId: destino,
    solicitadoPorEmployeeId: employeeId,
    numero: await siguienteNumero(businessId, t),
    estado: 'pendiente',
    notas: notas ? String(notas).slice(0, 500) : null,
  }, { transaction: t });

  await PedidoReposicionItem.bulkCreate(
    lineas.map((l) => ({
      pedidoId: pedido.id,
      productVariantId: l.productVariantId,
      cantidadPedida: l.cantidad,
      sku: l.sku,
      descripcion: l.descripcion,
    })),
    { transaction: t },
  );

  return pedido;
}

/*
 * Disponibilidad real del pedido en el depósito, línea por línea.
 *
 * Es lo que convierte la aprobación en una decisión informada. Aprobar sin ver
 * si la mercadería está lleva a que el pedido viaje hasta el depósito, ahí se
 * descubra que falta, y vuelva. Con esto, oficina decide sabiendo qué hay.
 *
 * Se usa en tres lugares y por eso vive acá: la pantalla de aprobación, el
 * detalle del depósito y la comprobación del propio despacho.
 */
async function disponibilidad(pedidoId, businessId, t = null) {
  const { pedido, items } = await traer(pedidoId, businessId, t);

  const lineas = [];
  for (const item of items) {
    const hay = await stockService.stockEn(item.productVariantId, pedido.depositoId, t);
    const disponible = Math.max(0, hay);
    const cubre = Math.min(disponible, item.cantidadPedida);

    const variante = await ProductVariant.findByPk(item.productVariantId, {
      include: [{ model: Product, as: 'producto', attributes: ['titulo', 'categoria'] }],
      transaction: t,
    });

    lineas.push({
      itemId: item.id,
      productVariantId: item.productVariantId,
      sku: item.sku,
      // El EAN del proveedor: el armado escanea por SKU y cae a éste cuando la
      // caja viene con la etiqueta original sin reetiquetar.
      codigoBarras: variante?.codigoBarras || null,
      descripcion: item.descripcion,
      titulo: variante?.producto?.titulo || null,
      categoria: variante?.producto?.categoria || null,
      color: variante?.variante1Valor || null,
      talle: variante?.variante2Valor || null,
      pedida: item.cantidadPedida,
      enDeposito: disponible,
      // Lo que se puede mandar hoy y lo que falta cargar o conseguir.
      cubre,
      falta: item.cantidadPedida - cubre,
      // El total del negocio: si falta acá pero hay en otro local, la salida es
      // transferir y no volver a comprar.
      enOtrosLugares: Math.max(0, (Number(variante?.stock) || 0) - disponible),
      cantidadEnviada: item.cantidadEnviada,
      cantidadRecibida: item.cantidadRecibida,
    });
  }

  const conFalta = lineas.filter((l) => l.falta > 0);
  const sinNada = lineas.filter((l) => l.enDeposito === 0);

  return {
    pedido,
    lineas,
    resumen: {
      lineas: lineas.length,
      completas: lineas.length - conFalta.length,
      conFalta: conFalta.length,
      sinNada: sinNada.length,
      unidadesPedidas: lineas.reduce((s, l) => s + l.pedida, 0),
      unidadesDisponibles: lineas.reduce((s, l) => s + l.cubre, 0),
      unidadesFaltantes: lineas.reduce((s, l) => s + l.falta, 0),
      /*
       * El veredicto, que es lo que la pantalla necesita para decidir qué
       * ofrecer: aprobar entero, aprobar parcial avisando, o rechazar.
       */
      estado: conFalta.length === 0 ? 'completo'
        : sinNada.length === lineas.length ? 'sin_stock'
        : 'parcial',
    },
  };
}

/** Oficina aprueba: recién ahí el pedido llega a reposición. */
async function aprobar({ pedidoId, businessId, employeeId = null, aceptarParcial = false, transaction: t }) {
  const pedido = await PedidoReposicion.findOne({ where: { id: pedidoId, businessId }, transaction: t });
  if (!pedido) throw error('Pedido no encontrado.', 404);
  if (pedido.estado !== 'pendiente') {
    throw error(`Este pedido ya está ${pedido.estado}.`, 409);
  }

  /*
   * No se aprueba a ciegas: se mira si la mercadería está.
   *
   * Sin esta comprobación, oficina firmaba y el faltante se descubría recién
   * en el depósito, con el pedido ya en marcha y el local esperando. Ahora la
   * aprobación es una decisión tomada sobre el stock real.
   */
  const { resumen } = await disponibilidad(pedidoId, businessId, t);

  if (resumen.estado === 'sin_stock') {
    throw error(
      'No hay nada de este pedido en el depósito. Lo que corresponde es rechazarlo, '
      + 'o cargar primero la mercadería desde Depósito si está físicamente sin registrar.',
      409,
      // Va en `detalles`: es lo único que el manejador de errores reenvía al
      // cliente, y la pantalla lo necesita para ofrecer la salida correcta.
      { detalles: { codigo: 'SIN_STOCK_TOTAL', resumen } },
    );
  }

  if (resumen.estado === 'parcial' && !aceptarParcial) {
    throw error(
      `De ${resumen.lineas} artículos hay ${resumen.completas} completos y ${resumen.conFalta} con faltante `
      + `(${resumen.unidadesFaltantes} unidades). Podés aprobarlo igual como parcial —el depósito manda lo que hay— o rechazarlo.`,
      409,
      { detalles: { codigo: 'STOCK_PARCIAL', resumen } },
    );
  }

  await pedido.update({
    estado: 'aprobado',
    aprobadoPorEmployeeId: employeeId,
    aprobadoEn: new Date(),
    /*
     * Queda anotado que se aprobó sabiendo que faltaba. Es la diferencia entre
     * "el depósito mandó de menos" y "se aprobó así": sin la nota, el local
     * reclama al depósito por algo que oficina ya había decidido.
     */
    notas: resumen.estado === 'parcial'
      ? [pedido.notas, `Aprobado parcial: faltan ${resumen.unidadesFaltantes} unidades en ${resumen.conFalta} artículo(s).`]
        .filter(Boolean).join(' · ').slice(0, 500)
      : pedido.notas,
  }, { transaction: t });
  return pedido;
}

/** Oficina rechaza, siempre con el porqué. Queda en el historial. */
async function rechazar({ pedidoId, businessId, employeeId = null, motivo, transaction: t }) {
  const limpio = String(motivo || '').trim();
  if (!limpio) throw error('Poné el motivo del rechazo: el local necesita saber por qué no se le manda.', 400);

  const pedido = await PedidoReposicion.findOne({ where: { id: pedidoId, businessId }, transaction: t });
  if (!pedido) throw error('Pedido no encontrado.', 404);
  if (pedido.estado !== 'pendiente') {
    throw error(`Este pedido ya está ${pedido.estado}.`, 409);
  }
  await pedido.update({
    estado: 'rechazado',
    motivoRechazo: limpio.slice(0, 500),
    aprobadoPorEmployeeId: employeeId,
    aprobadoEn: new Date(),
  }, { transaction: t });
  return pedido;
}

/*
 * Despacha: la mercadería sale del depósito.
 *
 * `envios` es [{ itemId, cantidad }]. Lo que no venga se manda en cero, que es
 * lo que corresponde cuando el depósito no tenía nada de esa línea.
 *
 * Se valida todo el pedido antes de mover la primera unidad. Descontar la mitad
 * y frenar dejaría un despacho a medias, con stock ya descontado y un documento
 * que dice que no salió.
 */
async function despachar({ pedidoId, businessId, employeeId = null, envios = [], transaction: t }) {
  const { pedido, items } = await traer(pedidoId, businessId, t);
  if (pedido.estado !== 'aprobado') {
    throw error(
      pedido.estado === 'pendiente'
        ? 'Este pedido todavía no está aprobado por oficina.'
        : `Este pedido está ${pedido.estado} y no se puede despachar.`,
      409,
    );
  }

  const pedidos = new Map(items.map((i) => [i.id, i]));
  const aEnviar = [];
  for (const e of Array.isArray(envios) ? envios : []) {
    const item = pedidos.get(Number(e?.itemId));
    if (!item) continue;
    const cantidad = Number(e?.cantidad);
    if (!Number.isInteger(cantidad) || cantidad < 0) {
      throw error('Las cantidades a enviar tienen que ser números enteros.', 400);
    }
    /*
     * Se puede mandar menos de lo pedido —es lo normal cuando falta stock—
     * pero nunca más: el local pidió 10 y recibir 40 le descuadra el depósito
     * a él y a todos los demás pedidos de la semana.
     */
    if (cantidad > item.cantidadPedida) {
      throw error(
        `De ${item.descripcion || item.sku} se pidieron ${item.cantidadPedida} y estás enviando ${cantidad}.`,
        400,
      );
    }
    if (cantidad > 0) aEnviar.push({ item, cantidad });
  }

  if (!aEnviar.length) throw error('No hay ninguna línea con cantidad para enviar.', 400);

  // Comprobación completa antes de tocar nada.
  const sinStock = [];
  for (const { item, cantidad } of aEnviar) {
    const hay = await stockService.stockEn(item.productVariantId, pedido.depositoId, t);
    if (hay < cantidad) sinStock.push({ sku: item.sku, descripcion: item.descripcion, hay, pide: cantidad });
  }
  if (sinStock.length) {
    const detalle = sinStock.map((s) => `${s.descripcion || s.sku}: hay ${s.hay} y estás enviando ${s.pide}`).join('; ');
    throw error(
      `No alcanza el stock del depósito. ${detalle}. Si la mercadería está físicamente pero sin cargar, ingresala primero desde Depósito.`,
      409,
      { faltantes: sinStock },
    );
  }

  for (const { item, cantidad } of aEnviar) {
    await stockService.mover({
      variantId: item.productVariantId,
      businessId,
      locationId: pedido.depositoId,
      delta: -cantidad,
      tipo: 'egreso',
      motivo: `Despacho del pedido ${pedido.numero}`,
      employeeId,
      transaction: t,
    });
    await item.update({ cantidadEnviada: cantidad }, { transaction: t });
  }
  // Las que no se despacharon quedan explícitamente en cero enviado.
  for (const item of items) {
    if (!aEnviar.some((e) => e.item.id === item.id) && item.cantidadEnviada !== 0) {
      await item.update({ cantidadEnviada: 0 }, { transaction: t });
    }
  }

  await pedido.update({
    estado: 'enviado',
    enviadoPorEmployeeId: employeeId,
    enviadoEn: new Date(),
  }, { transaction: t });
  return pedido;
}

/*
 * El local confirma lo que llegó: recién acá entra el stock a la góndola.
 *
 * `recepciones` es [{ itemId, cantidad, notaFaltante }]. Si no coincide con lo
 * enviado, se registra lo que hay y el faltante queda anotado con su nota: el
 * pedido cierra como `recibido_parcial` y la diferencia queda visible para
 * oficina en vez de perderse en un mensaje de WhatsApp.
 */
async function recibir({ pedidoId, businessId, employeeId = null, recepciones = [], nota = null, transaction: t }) {
  const { pedido, items } = await traer(pedidoId, businessId, t);
  if (pedido.estado !== 'enviado') {
    throw error(`Sólo se puede confirmar la recepción de un pedido enviado. Este está ${pedido.estado}.`, 409);
  }

  const porId = new Map(items.map((i) => [i.id, i]));
  const aRecibir = [];
  for (const r of Array.isArray(recepciones) ? recepciones : []) {
    const item = porId.get(Number(r?.itemId));
    if (!item) continue;
    const cantidad = Number(r?.cantidad);
    if (!Number.isInteger(cantidad) || cantidad < 0) {
      throw error('Las cantidades recibidas tienen que ser números enteros.', 400);
    }
    if (cantidad > item.cantidadEnviada) {
      throw error(
        `De ${item.descripcion || item.sku} salieron ${item.cantidadEnviada} del depósito y estás recibiendo ${cantidad}. `
        + 'Si llegó de más, avisá a oficina: puede ser mercadería de otro pedido.',
        400,
      );
    }
    aRecibir.push({ item, cantidad, notaFaltante: String(r?.notaFaltante || '').trim().slice(0, 300) || null });
  }

  for (const { item, cantidad, notaFaltante } of aRecibir) {
    if (cantidad > 0) {
      await stockService.mover({
        variantId: item.productVariantId,
        businessId,
        locationId: pedido.locationId,
        delta: cantidad,
        tipo: 'ingreso',
        motivo: `Recepción del pedido ${pedido.numero}`,
        employeeId,
        transaction: t,
      });
    }
    await item.update({ cantidadRecibida: cantidad, notaFaltante }, { transaction: t });
  }

  /*
   * Un faltante NO se descuenta de ningún lado y es a propósito.
   *
   * Salió del depósito y no llegó al local: es una pérdida en tránsito, y ya
   * está reflejada en que el depósito descontó y el local sumó menos. Cerrar
   * el hueco con un ajuste automático borraría justamente la evidencia de que
   * algo se perdió.
   */
  const frescos = await PedidoReposicionItem.findAll({ where: { pedidoId: pedido.id }, transaction: t });
  const faltan = frescos.some((i) => i.cantidadRecibida < i.cantidadEnviada);

  /*
   * El saldo: lo que se pidió y nunca salió del depósito.
   *
   * Se calcula sobre `enviada` y no sobre `recibida` a propósito. Lo que salió
   * y no llegó es una pérdida en tránsito —hay que averiguar qué pasó, no
   * volver a mandarla—; lo que nunca salió sigue haciendo falta en el local.
   * Mezclarlas haría despachar dos veces la misma prenda.
   */
  const saldo = frescos.reduce((s, i) => s + Math.max(0, i.cantidadPedida - i.cantidadEnviada), 0);

  await pedido.update({
    estado: faltan ? 'recibido_parcial' : 'recibido',
    recibidoPorEmployeeId: employeeId,
    recibidoEn: new Date(),
    notaRecepcion: nota ? String(nota).slice(0, 500) : null,
    // Queda asentado y esperando decisión. La bandeja lo pone primero.
    saldoEstado: saldo > 0 ? 'pendiente' : null,
  }, { transaction: t });

  return { pedido, faltan, saldo };
}

/*
 * Resuelve el saldo de un pedido: se manda lo que faltó, o se da de baja.
 *
 * Aceptar NO reabre el pedido viejo: crea uno nuevo con lo que quedó
 * pendiente. Es lo que mantiene honestas las tres cantidades de cada línea —
 * pedida, enviada, recibida— que si no habría que ir acumulando despachos
 * sucesivos sobre la misma fila y ya no se sabría qué pasó en cada viaje. El
 * pedido nuevo arranca pendiente y vuelve a pasar por oficina, que va a ver la
 * disponibilidad de hoy y no la de la semana pasada.
 *
 * Rechazar cierra el tema con un motivo. El local se entera de que eso no
 * llega, en vez de quedar esperando algo que nadie iba a mandar.
 */
async function resolverSaldo({ pedidoId, businessId, employeeId = null, aceptar, motivo = null, transaction: t }) {
  const { pedido, items } = await traer(pedidoId, businessId, t);
  if (pedido.saldoEstado !== 'pendiente') {
    throw error(
      pedido.saldoEstado
        ? `El saldo de este pedido ya está ${pedido.saldoEstado}.`
        : 'Este pedido no tiene saldo pendiente.',
      409,
    );
  }

  const faltantes = items
    .map((i) => ({ item: i, cantidad: Math.max(0, i.cantidadPedida - i.cantidadEnviada) }))
    .filter((x) => x.cantidad > 0);

  if (!aceptar) {
    const limpio = String(motivo || '').trim();
    if (!limpio) throw error('Poné el motivo: el local necesita saber por qué eso no le va a llegar.', 400);
    await pedido.update({
      saldoEstado: 'rechazado',
      saldoMotivo: limpio.slice(0, 500),
      saldoResueltoPorEmployeeId: employeeId,
      saldoResueltoEn: new Date(),
    }, { transaction: t });
    return { pedido, nuevo: null };
  }

  const nuevo = await PedidoReposicion.create({
    businessId,
    locationId: pedido.locationId,
    depositoId: pedido.depositoId,
    solicitadoPorEmployeeId: employeeId || pedido.solicitadoPorEmployeeId,
    numero: await siguienteNumero(businessId, t),
    estado: 'pendiente',
    pedidoOrigenId: pedido.id,
    notas: `Saldo de ${pedido.numero}${motivo ? `: ${String(motivo).trim()}` : ''}`.slice(0, 500),
  }, { transaction: t });

  await PedidoReposicionItem.bulkCreate(
    faltantes.map(({ item, cantidad }) => ({
      pedidoId: nuevo.id,
      productVariantId: item.productVariantId,
      cantidadPedida: cantidad,
      sku: item.sku,
      descripcion: item.descripcion,
    })),
    { transaction: t },
  );

  await pedido.update({
    saldoEstado: 'aceptado',
    saldoMotivo: `Rearmado como ${nuevo.numero}.`,
    saldoResueltoPorEmployeeId: employeeId,
    saldoResueltoEn: new Date(),
  }, { transaction: t });

  return { pedido, nuevo };
}

/*
 * Los saldos esperando decisión.
 *
 * Va aparte del listado normal porque es lo que no puede esperar: un pedido
 * cerrado con saldo sin resolver es mercadería que el local sigue necesitando
 * y que nadie está preparando.
 */
async function saldosPendientes(businessId, { locationId = null } = {}) {
  const where = { businessId, saldoEstado: 'pendiente' };
  if (locationId) where.locationId = locationId;

  const pedidos = await PedidoReposicion.findAll({ where, include: INCLUDES, order: [['id', 'DESC']] });
  if (!pedidos.length) return [];

  const items = await PedidoReposicionItem.findAll({
    where: { pedidoId: { [Op.in]: pedidos.map((p) => p.id) } }, order: [['id', 'ASC']],
  });

  return pedidos.map((p) => {
    const propios = items.filter((i) => i.pedidoId === p.id);
    const faltantes = propios
      .map((i) => ({
        sku: i.sku, descripcion: i.descripcion,
        pedida: i.cantidadPedida, enviada: i.cantidadEnviada,
        saldo: Math.max(0, i.cantidadPedida - i.cantidadEnviada),
      }))
      .filter((x) => x.saldo > 0);
    return {
      ...p.toJSON(),
      faltantes,
      unidadesPendientes: faltantes.reduce((s, x) => s + x.saldo, 0),
    };
  });
}

/** El local se arrepiente antes de que oficina lo mire. */
async function cancelar({ pedidoId, businessId, employeeId = null, motivo = null, transaction: t }) {
  const pedido = await PedidoReposicion.findOne({ where: { id: pedidoId, businessId }, transaction: t });
  if (!pedido) throw error('Pedido no encontrado.', 404);
  if (pedido.estado !== 'pendiente') {
    throw error(`Este pedido ya está ${pedido.estado} y no se puede cancelar desde el local.`, 409);
  }
  await pedido.update({
    estado: 'cancelado',
    motivoRechazo: motivo ? String(motivo).slice(0, 500) : 'Cancelado por el local.',
    aprobadoPorEmployeeId: employeeId,
    aprobadoEn: new Date(),
  }, { transaction: t });
  return pedido;
}

/*
 * Lo que salió del depósito y todavía no llegó, por variante y local destino.
 *
 * Es la respuesta a "el sistema dice que no tengo y yo lo pedí la semana
 * pasada": sin esto, la mercadería en viaje simplemente no aparece.
 */
async function enTransito(businessId, { locationId = null } = {}) {
  const where = { businessId, estado: 'enviado' };
  if (locationId) where.locationId = locationId;
  const pedidos = await PedidoReposicion.findAll({
    where, attributes: ['id', 'numero', 'locationId', 'depositoId', 'enviadoEn'],
  });
  if (!pedidos.length) return [];

  const items = await PedidoReposicionItem.findAll({
    where: { pedidoId: { [Op.in]: pedidos.map((p) => p.id) } },
  });
  const porPedido = new Map(pedidos.map((p) => [p.id, p]));

  return items
    .filter((i) => i.cantidadEnviada - i.cantidadRecibida > 0)
    .map((i) => {
      const p = porPedido.get(i.pedidoId);
      return {
        productVariantId: i.productVariantId,
        sku: i.sku,
        descripcion: i.descripcion,
        cantidad: i.cantidadEnviada - i.cantidadRecibida,
        pedidoId: p.id, numero: p.numero,
        locationId: p.locationId, depositoId: p.depositoId,
        enviadoEn: p.enviadoEn,
      };
    });
}

/** Listado con filtros para las tres pantallas (local, reposición, oficina). */
async function listar({ businessId, estado, locationId, depositoId, desde, hasta, limit = 50, page = 1 }) {
  const where = { businessId };
  if (estado) where.estado = Array.isArray(estado) ? { [Op.in]: estado } : estado;
  if (locationId) where.locationId = locationId;
  if (depositoId) where.depositoId = depositoId;
  if (desde || hasta) {
    where.createdAt = {};
    if (desde) where.createdAt[Op.gte] = new Date(`${desde}T00:00:00`);
    if (hasta) where.createdAt[Op.lte] = new Date(`${hasta}T23:59:59.999`);
  }

  const tope = Math.min(200, Number(limit) || 50);
  const { rows, count } = await PedidoReposicion.findAndCountAll({
    where, include: INCLUDES,
    order: [['id', 'DESC']],
    limit: tope,
    offset: (Math.max(1, Number(page) || 1) - 1) * tope,
    distinct: true,
  });

  const items = rows.length
    ? await PedidoReposicionItem.findAll({
        where: { pedidoId: { [Op.in]: rows.map((r) => r.id) } }, order: [['id', 'ASC']],
      })
    : [];
  const porPedido = new Map();
  for (const it of items) {
    if (!porPedido.has(it.pedidoId)) porPedido.set(it.pedidoId, []);
    porPedido.get(it.pedidoId).push(it);
  }

  return {
    total: count,
    data: rows.map((r) => ({ ...r.toJSON(), items: porPedido.get(r.id) || [] })),
  };
}

module.exports = {
  ABIERTOS, siguienteNumero, traer, crearPedido, disponibilidad,
  aprobar, rechazar, despachar, recibir, cancelar, enTransito, listar,
  resolverSaldo, saldosPendientes,
};
