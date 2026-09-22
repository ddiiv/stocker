/*
 * Pedidos mayoristas que entran de afuera y esperan que alguien los mire.
 *
 * Hoy el que manda es ISUWAYA: el cliente arma el pedido allá, lo confirma, y
 * acá entra como una solicitud. No es una venta todavía, y esa es toda la
 * idea: la venta la crea la persona que aprueba, con su sesión, su local y su
 * caja. Hasta entonces no se toca inventario ni se numera nada.
 *
 * ── Lo que llega es el pedido entero, no el cambio ───────────────
 *
 * El origen reintenta ante cualquier caída y manda cómo quedó el pedido en
 * cada envío, con un número de secuencia. Guardar el más nuevo y descartar el
 * que llegó tarde es lo que hace que reintentar sea seguro.
 *
 * ── Una vez revisada, no se pisa ─────────────────────────────────
 *
 * Después de aceptar hay una venta con su número y puede estar cobrada.
 * Reescribirla por detrás sería cambiarle el importe a algo ya cerrado. Lo que
 * llega tarde se anota aparte y la bandeja lo muestra.
 */

const { Op } = require('sequelize');
const sequelize = require('../config/database');
const {
  SolicitudMayorista, SolicitudMayoristaItem, ProductVariant, Product,
} = require('../models');
const { log } = require('../utils/logger');

/*
 * Los topes son los mismos que ya usa la cola de venta online: un pedido de
 * afuera no puede voltear el proceso por venir mal armado.
 */
const MAX_LINEAS = 200;
const MAX_CANTIDAD = 10_000;
const LARGO_SKU = 100;

const error = (mensaje, status = 400, extra = {}) =>
  Object.assign(new Error(mensaje), { status, ...extra });

const recortar = (v, largo) => {
  const t = String(v ?? '').trim();
  return t ? t.slice(0, largo) : null;
};

const json = (v) => {
  if (v === undefined || v === null) return null;
  try { return JSON.stringify(v).slice(0, 4000); } catch { return null; }
};

const numero = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/*
 * El estado del pedido EN el origen que significa que ya no va.
 *
 * Una solicitud cancelada allá no se puede aceptar acá: prepararíamos un
 * pedido que el cliente dio de baja.
 */
const CANCELADOS = ['cancelado', 'cancelada', 'anulado'];

/** Valida y normaliza lo que llegó. Tira 400 con el motivo exacto. */
function leerCuerpo(cuerpo = {}) {
  const pedidoExterno = recortar(cuerpo.pedidoExterno, 60);
  if (!pedidoExterno) throw error('El pedido necesita el número que le dio el origen.');

  const crudas = Array.isArray(cuerpo.items) ? cuerpo.items : [];
  if (!crudas.length) throw error('El pedido llegó sin ninguna línea.');
  if (crudas.length > MAX_LINEAS) {
    throw error(`El pedido tiene ${crudas.length} líneas y el máximo es ${MAX_LINEAS}.`);
  }

  const items = [];
  for (const [i, linea] of crudas.entries()) {
    const sku = recortar(linea?.sku, LARGO_SKU);
    if (!sku) throw error(`La línea ${i + 1} llegó sin SKU.`);
    const cantidad = Number(linea?.cantidad);
    if (!Number.isInteger(cantidad) || cantidad <= 0 || cantidad > MAX_CANTIDAD) {
      throw error(`La línea ${i + 1} (${sku}) tiene una cantidad inválida: ${linea?.cantidad}.`);
    }
    /*
     * El precio del origen entra como dato, no como precio.
     *
     * La venta la valoriza Stocker con su lista y la regla del local. Éste se
     * guarda para poder mostrar la diferencia ANTES de aceptar: un pedido que
     * el cliente aceptó por un importe y que acá se registra por otro es un
     * reclamo asegurado.
     */
    const precio = linea?.precioUnitario;
    items.push({
      sku,
      cantidad,
      descripcion: recortar(
        [linea?.producto, linea?.color, linea?.talle].filter(Boolean).join(' · '),
        255,
      ),
      precioOrigen: precio === null || precio === undefined || !Number.isFinite(Number(precio))
        ? null
        : Number(precio),
    });
  }

  const pago = cuerpo.pago || {};
  return {
    pedidoExterno,
    items,
    secuencia: Math.trunc(numero(cuerpo.secuencia)),
    estadoOrigen: recortar(cuerpo.estado, 20),
    total: numero(cuerpo.total),
    unidades: Math.trunc(numero(cuerpo.unidades)),
    pagoCondicion: recortar(pago.condicion, 20),
    pagoForma: recortar(pago.forma, 60),
    comprador: json(cuerpo.comprador),
    cliente: json(cuerpo.cliente),
    envio: json(cuerpo.envio),
    creadoEnOrigen: recortar(cuerpo.creadoEn, 40),
    actualizadoEnOrigen: recortar(cuerpo.actualizadoEn, 40),
  };
}

/**
 * Cruza los SKU contra el catálogo del negocio.
 *
 * Lo que no matchea no se saltea: la línea entra con el SKU en texto y sin
 * variante. Saltearla haría que el pedido se vea completo cuando no lo está, y
 * quien revisa no tendría cómo enterarse de qué falta identificar.
 */
async function resolverVariantes(businessId, items, transaction) {
  const skus = [...new Set(items.map((i) => i.sku))];
  const variantes = await ProductVariant.findAll({
    where: { sku: { [Op.in]: skus } },
    include: [{ model: Product, as: 'producto', required: true, where: { businessId } }],
    transaction,
  });
  const porSku = new Map(variantes.map((v) => [v.sku, v]));
  return items.map((i) => ({ ...i, productVariantId: porSku.get(i.sku)?.id || null }));
}

/**
 * Anota el pedido, o actualiza el que ya estaba.
 *
 * Devuelve `{ solicitud, creada, repetido, ignorado, cambioTardio }` para que
 * quien contesta pueda distinguir "lo tomé" de "ya lo tenía" sin leer estados.
 */
async function recibir({ businessId, origen, cuerpo }) {
  /*
   * Dos entregas del mismo pedido pueden cruzarse en el aire.
   *
   * El origen reintenta solo ante un timeout, así que el caso existe: los dos
   * miran, no encuentran nada, y los dos insertan. El índice único frena al
   * segundo, y acá se vuelve a intentar una vez: en esa segunda vuelta ya
   * existe la fila y entra por el camino de actualizar. Es la diferencia entre
   * un pedido duplicado y ninguno.
   */
  try {
    return await recibirUnaVez({ businessId, origen, cuerpo });
  } catch (e) {
    if (e?.name !== 'SequelizeUniqueConstraintError') throw e;
    return recibirUnaVez({ businessId, origen, cuerpo });
  }
}

async function recibirUnaVez({ businessId, origen, cuerpo }) {
  const datos = leerCuerpo(cuerpo);
  const cancelado = CANCELADOS.includes(String(datos.estadoOrigen || '').toLowerCase());

  return sequelize.transaction(async (t) => {
    const existente = await SolicitudMayorista.findOne({
      where: { businessId, origen, pedidoExterno: datos.pedidoExterno },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!existente) {
      const items = await resolverVariantes(businessId, datos.items, t);
      const solicitud = await SolicitudMayorista.create({
        businessId,
        origen,
        pedidoExterno: datos.pedidoExterno,
        secuencia: datos.secuencia,
        estado: cancelado ? 'cancelada' : 'pendiente',
        estadoOrigen: datos.estadoOrigen,
        total: datos.total,
        unidades: datos.unidades,
        pagoCondicion: datos.pagoCondicion,
        pagoForma: datos.pagoForma,
        comprador: datos.comprador,
        cliente: datos.cliente,
        envio: datos.envio,
        creadoEnOrigen: datos.creadoEnOrigen,
        actualizadoEnOrigen: datos.actualizadoEnOrigen,
      }, { transaction: t });

      await SolicitudMayoristaItem.bulkCreate(
        items.map((i) => ({ ...i, solicitudId: solicitud.id })),
        { transaction: t },
      );
      const sinIdentificar = items.filter((i) => !i.productVariantId).length;
      log.info('solicitud-mayorista', 'entró un pedido', {
        businessId, origen, pedido: datos.pedidoExterno, lineas: items.length, sinIdentificar,
      });
      return { solicitud, creada: true, repetido: false, ignorado: false, cambioTardio: false };
    }

    /*
     * Llegó algo de un pedido que ya está acá.
     *
     * Tres casos y cada uno hace algo distinto:
     *   · vino con una secuencia vieja → es un reintento que llegó tarde, se descarta;
     *   · la solicitud ya se revisó    → no se pisa, se anota el cambio aparte;
     *   · sigue pendiente              → se reemplaza por cómo quedó el pedido.
     */
    if (datos.secuencia && datos.secuencia < existente.secuencia) {
      return { solicitud: existente, creada: false, repetido: true, ignorado: true, cambioTardio: false };
    }

    if (existente.estado !== 'pendiente') {
      /*
       * Que el pedido siga su curso allá no es un cambio del pedido.
       *
       * El origen manda el pedido entero cada vez que pasa algo suyo —lo marca
       * enviado, entregado—, y eso llega igual que una modificación. Avisar
       * "el portal cambió este pedido" cuando sólo cambió su estado convierte
       * el aviso en ruido, y el día que cambie de verdad nadie lo va a mirar.
       *
       * Una cancelación sí importa siempre: la venta ya existe.
       */
      const mismoContenido = Number(existente.total) === Number(datos.total)
        && Number(existente.unidades) === Number(datos.unidades);
      if (!cancelado && mismoContenido) {
        await existente.update({
          estadoOrigen: datos.estadoOrigen,
          actualizadoEnOrigen: datos.actualizadoEnOrigen,
        }, { transaction: t });
        return { solicitud: existente, creada: false, repetido: true, ignorado: false, cambioTardio: false };
      }

      const cambio = {
        secuencia: datos.secuencia,
        estadoOrigen: datos.estadoOrigen,
        total: datos.total,
        unidades: datos.unidades,
        recibidoEn: new Date().toISOString(),
      };
      await existente.update({ cambioPosterior: json(cambio) }, { transaction: t });
      log.warn('solicitud-mayorista', 'el origen cambió un pedido ya revisado', {
        businessId, origen, pedido: datos.pedidoExterno, estado: existente.estado,
      });
      return { solicitud: existente, creada: false, repetido: true, ignorado: false, cambioTardio: true };
    }

    const items = await resolverVariantes(businessId, datos.items, t);
    await existente.update({
      secuencia: datos.secuencia,
      estado: cancelado ? 'cancelada' : 'pendiente',
      estadoOrigen: datos.estadoOrigen,
      total: datos.total,
      unidades: datos.unidades,
      pagoCondicion: datos.pagoCondicion,
      pagoForma: datos.pagoForma,
      comprador: datos.comprador,
      cliente: datos.cliente,
      envio: datos.envio,
      actualizadoEnOrigen: datos.actualizadoEnOrigen,
    }, { transaction: t });

    // Las líneas se reemplazan enteras: lo que llegó ES el pedido, no un parche.
    await SolicitudMayoristaItem.destroy({ where: { solicitudId: existente.id }, transaction: t });
    await SolicitudMayoristaItem.bulkCreate(
      items.map((i) => ({ ...i, solicitudId: existente.id })),
      { transaction: t },
    );

    return { solicitud: existente, creada: false, repetido: true, ignorado: false, cambioTardio: false };
  });
}

/*
 * ══ La bandeja: lo que ve quien revisa ═══════════════════════════
 */

/** Las solicitudes del negocio, las pendientes primero. */
async function listar({ businessId, estado = null, limite = 100 }) {
  const where = { businessId };
  if (estado) where.estado = estado;
  const filas = await SolicitudMayorista.findAll({
    where,
    include: [{ model: SolicitudMayoristaItem, as: 'items' }],
    order: [['estado', 'ASC'], ['id', 'DESC']],
    limit: Math.min(Number(limite) || 100, 500),
  });
  const pendientes = await SolicitudMayorista.count({ where: { businessId, estado: 'pendiente' } });
  return { pendientes, solicitudes: filas.map(comoSeVe) };
}

const leerJson = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };

function comoSeVe(fila) {
  const j = fila.toJSON();
  return {
    ...j,
    total: Number(j.total),
    comprador: leerJson(j.comprador),
    cliente: leerJson(j.cliente),
    envio: leerJson(j.envio),
    cambioPosterior: leerJson(j.cambioPosterior),
    items: (j.items || []).map((i) => ({ ...i, precioOrigen: i.precioOrigen === null ? null : Number(i.precioOrigen) })),
  };
}

/**
 * Una solicitud con todo lo que hace falta para decidir sin adivinar.
 *
 * Aprobar a ciegas es el problema que el circuito de reposición ya tuvo: se
 * aprobaba, y el faltante aparecía recién cuando el local reclamaba. Acá quien
 * revisa ve, antes de firmar, qué líneas no se pudieron identificar y con qué
 * cliente de Stocker matchea el CUIT que mandó el origen.
 */
async function detalle({ businessId, id }) {
  const { Client } = require('../models');
  const fila = await SolicitudMayorista.findOne({
    where: { id, businessId },
    include: [{ model: SolicitudMayoristaItem, as: 'items' }],
  });
  if (!fila) throw error('Esa solicitud no existe.', 404);

  const vista = comoSeVe(fila);
  const cuit = String(vista.cliente?.cuit || vista.comprador?.documento || '').replace(/\D/g, '');
  /*
   * El cliente se sugiere, no se crea solo.
   *
   * Crear una ficha por cada pedido que entra llena la lista de clientes de
   * fichas que nadie miró. Quien revisa elige: la existente, una nueva, o
   * ninguna —salvo que fíe, que ahí Stocker ya exige cliente.
   */
  let clienteSugerido = null;
  if (cuit) {
    const candidatos = await Client.findAll({ where: { businessId }, attributes: ['id', 'nombre', 'cuit', 'tipo'] });
    clienteSugerido = candidatos.find((c) => String(c.cuit || '').replace(/\D/g, '') === cuit)?.toJSON() || null;
  }

  return {
    ...vista,
    clienteSugerido,
    sinIdentificar: vista.items.filter((i) => !i.productVariantId).map((i) => ({ sku: i.sku, descripcion: i.descripcion })),
  };
}

/**
 * Se queda con la solicitud antes de crear la venta.
 *
 * El cambio de estado se hace con un UPDATE condicionado: si dos personas
 * aprietan aceptar a la vez, una sola se la lleva. Al revés —crear la venta y
 * después marcar— las dos crearían su venta y el cliente recibiría el pedido
 * dos veces.
 */
async function reservarParaAceptar({ businessId, id, employeeId }) {
  const fila = await SolicitudMayorista.findOne({ where: { id, businessId } });
  if (!fila) throw error('Esa solicitud no existe.', 404);
  if (fila.estado === 'aceptada') {
    throw error(`Esta solicitud ya se aceptó${fila.saleId ? ` (venta ${fila.saleId})` : ''}.`, 409);
  }
  if (fila.estado !== 'pendiente') {
    throw error(`Esta solicitud está ${fila.estado} y ya no se puede aceptar.`, 409);
  }

  const items = await SolicitudMayoristaItem.findAll({ where: { solicitudId: fila.id }, order: [['id', 'ASC']] });
  const sinIdentificar = items.filter((i) => !i.productVariantId);
  if (sinIdentificar.length) {
    throw Object.assign(
      new Error('Hay líneas que Stocker no reconoce y no se pueden vender: '
        + sinIdentificar.map((i) => i.sku).join(', ')
        + '. Corregí el catálogo del origen y volvé a mandar el pedido.'),
      /*
       * El código viaja plano y también dentro de `detalles`: el manejador de
       * errores del proyecto arma la respuesta desde `detalles`, y sin eso la
       * pantalla recibe un 409 sin saber cuál es.
       */
      {
        status: 409,
        codigo: 'SIN_IDENTIFICAR',
        faltantes: sinIdentificar.map((i) => ({ sku: i.sku, descripcion: i.descripcion })),
        detalles: {
          codigo: 'SIN_IDENTIFICAR',
          faltantes: sinIdentificar.map((i) => ({ sku: i.sku, descripcion: i.descripcion })),
        },
      },
    );
  }

  const [tomadas] = await SolicitudMayorista.update(
    { estado: 'aceptada', revisadoPorEmployeeId: employeeId || null, revisadoEn: new Date() },
    { where: { id: fila.id, businessId, estado: 'pendiente' } },
  );
  if (!tomadas) throw error('Otra persona está revisando esta solicitud en este momento.', 409);

  return { solicitud: fila, items };
}

/** La venta salió: se anota cuál. */
async function anotarVenta({ businessId, id, saleId }) {
  await SolicitudMayorista.update({ saleId }, { where: { id, businessId } });
}

/** La venta no salió: la solicitud vuelve a la bandeja. */
async function devolverALaBandeja({ businessId, id }) {
  await SolicitudMayorista.update(
    { estado: 'pendiente', revisadoPorEmployeeId: null, revisadoEn: null },
    { where: { id, businessId, saleId: null } },
  );
}

/**
 * Rechazar exige motivo.
 *
 * Del otro lado hay un cliente que armó un pedido: "rechazado" sin decir por
 * qué obliga a levantar el teléfono, y el que atiende tampoco sabe.
 */
async function rechazar({ businessId, id, motivo, employeeId }) {
  const texto = recortar(motivo, 500);
  if (!texto) throw error('Decí por qué se rechaza: del otro lado hay un cliente esperando.');
  const fila = await SolicitudMayorista.findOne({ where: { id, businessId } });
  if (!fila) throw error('Esa solicitud no existe.', 404);
  if (fila.estado === 'aceptada') throw error('Esta solicitud ya se aceptó: anulá la venta si hace falta.', 409);

  const [tocadas] = await SolicitudMayorista.update(
    { estado: 'rechazada', motivoRechazo: texto, revisadoPorEmployeeId: employeeId || null, revisadoEn: new Date() },
    { where: { id, businessId, estado: { [Op.in]: ['pendiente', 'cancelada'] } } },
  );
  if (!tocadas) throw error('Esta solicitud ya no está para revisar.', 409);
  log.info('solicitud-mayorista', 'rechazada', { businessId, id, motivo: texto.slice(0, 80) });
  return detalle({ businessId, id });
}

/*
 * ══ La vuelta: lo que el origen necesita saber ═══════════════════
 *
 * El origen pregunta; Stocker no avisa. Es a propósito:
 *
 *   · El origen ya tiene un reloj corriendo y reintentos escritos. Avisar
 *     desde acá significaría una segunda cola, con su propia credencial, su
 *     propio reintento y una URL pública del otro lado que hoy no existe.
 *   · Si el origen está caído, preguntando no se pierde nada: cuando vuelve,
 *     pregunta desde donde quedó. Avisando habría que guardar lo que no se
 *     pudo entregar y reintentarlo, que es la cola de nuevo.
 *
 * El corte es por `revisadoEn` y el que pregunta manda hasta dónde ya leyó.
 */
async function resoluciones({ businessId, origen, desde = null, limite = 200 }) {
  const { Sale } = require('../models');
  const corte = desde ? new Date(desde) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(corte.getTime())) throw error('La fecha "desde" no se entiende.');

  const filas = await SolicitudMayorista.findAll({
    where: {
      businessId,
      origen,
      estado: { [Op.in]: ['aceptada', 'rechazada'] },
      revisadoEn: { [Op.gt]: corte },
    },
    order: [['revisadoEn', 'ASC'], ['id', 'ASC']],
    limit: Math.min(Number(limite) || 200, 500),
  });

  const ventas = new Map();
  const ids = filas.map((f) => f.saleId).filter(Boolean);
  if (ids.length) {
    const encontradas = await Sale.findAll({
      where: { id: ids, businessId },
      attributes: ['id', 'numero', 'total', 'condicionPago', 'estado'],
    });
    for (const v of encontradas) ventas.set(v.id, v);
  }

  const salida = filas.map((f) => {
    const venta = f.saleId ? ventas.get(f.saleId) : null;
    return {
      pedidoExterno: f.pedidoExterno,
      estado: f.estado,
      motivo: f.motivoRechazo || null,
      revisadoEn: f.revisadoEn,
      venta: venta ? {
        numero: venta.numero,
        total: Number(venta.total),
        condicionPago: venta.condicionPago,
        estado: venta.estado,
      } : null,
    };
  });

  /*
   * `hasta` es el cursor para la próxima vuelta, y sale de lo que se devolvió y
   * no del reloj de acá: con el reloj se saltearían las que se revisaron entre
   * la consulta y la respuesta.
   */
  return {
    resoluciones: salida,
    hasta: salida.length ? salida[salida.length - 1].revisadoEn : (desde || null),
    truncado: salida.length >= Math.min(Number(limite) || 200, 500),
  };
}

module.exports = {
  recibir, listar, detalle, rechazar, resoluciones,
  reservarParaAceptar, anotarVenta, devolverALaBandeja,
  __leerCuerpo: leerCuerpo, MAX_LINEAS, MAX_CANTIDAD,
};
