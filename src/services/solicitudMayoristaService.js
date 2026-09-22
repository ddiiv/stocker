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

module.exports = { recibir, __leerCuerpo: leerCuerpo, MAX_LINEAS, MAX_CANTIDAD };
