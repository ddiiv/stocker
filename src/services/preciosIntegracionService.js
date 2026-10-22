/*
 * El precio de cada SKU, para que el portal de afuera cobre lo mismo que acá.
 *
 * El catálogo de ISUWAYA salió de una planilla exportada de Stocker, y desde
 * ese día los dos precios viven por separado: se cambia el precio acá y el
 * portal sigue mostrando el de la exportación. El cliente arma el pedido con
 * ese número, y cuando la venta se registra con la lista de Stocker el total no
 * coincide con el remito que el cliente ya tiene.
 *
 * Por eso el precio se lee de acá y no se carga allá: hay una sola lista.
 *
 * ── Por qué el mayorista ─────────────────────────────────────────
 *
 * El portal es mayorista y punto. La regla de "desde tres prendas" es del
 * mostrador —depende del local y del tamaño de la venta— y no tiene sentido en
 * un pedido que ya es mayorista por definición.
 */

const { Op } = require('sequelize');
const { Product, ProductVariant, VariantStock, BusinessLocation } = require('../models');
const { precioMayorista, precioMinorista } = require('./precioService');

// Un catálogo de indumentaria entra holgado; el tope existe para que una
// consulta no se lleve puesto el proceso si alguien cargó de más.
const TOPE = Number(process.env.INTEGRACION_TOPE_PRECIOS) || 20_000;

/**
 * Todos los SKU del negocio con el precio que corresponde cobrar.
 *
 * `desde` recorta a lo que cambió después de esa fecha, para que el portal no
 * se traiga el catálogo entero cada vez. Se mira la fecha de la variante Y la
 * del producto: un cambio en el precio del padre mueve a todas las variantes
 * que lo heredan, y la variante no se toca.
 */
async function precios({ businessId, desde = null }) {
  const corte = desde ? new Date(desde) : null;
  if (corte && Number.isNaN(corte.getTime())) {
    throw Object.assign(new Error('La fecha "desde" no se entiende.'), { status: 400 });
  }

  const productos = await Product.findAll({
    where: { businessId },
    attributes: ['id', 'sku', 'skuAgrupador', 'precioMinorista', 'precioMayorista', 'updatedAt'],
  });
  if (!productos.length) return { precios: [], truncado: false, generadoEn: new Date() };

  const porId = new Map(productos.map((p) => [p.id, p]));

  const variantes = await ProductVariant.findAll({
    where: { productId: { [Op.in]: [...porId.keys()] }, sku: { [Op.ne]: null } },
    attributes: ['id', 'productId', 'sku', 'precioMinorista', 'precioMayorista', 'updatedAt', 'activo'],
    order: [['id', 'ASC']],
    limit: TOPE + 1,
  });

  const salida = [];
  for (const v of variantes) {
    const producto = porId.get(v.productId);
    if (!producto) continue;
    /*
     * El corte mira las dos fechas: si sólo se mirara la de la variante, subir
     * el precio del producto padre no movería ninguna de las que lo heredan y
     * el portal se quedaría con los precios viejos sin ninguna señal.
     */
    if (corte) {
      const tocado = Math.max(
        new Date(v.updatedAt || 0).getTime(),
        new Date(producto.updatedAt || 0).getTime(),
      );
      if (tocado <= corte.getTime()) continue;
    }
    salida.push({
      sku: v.sku,
      /*
       * El agrupador es la clave con la que el portal junta las variantes en un
       * producto: es por donde reimporta sin duplicar.
       */
      skuAgrupador: producto.skuAgrupador || producto.sku || null,
      precio: precioMayorista(v, producto),
      precioMinorista: precioMinorista(v, producto),
      activo: v.activo !== false,
    });
  }

  const truncado = variantes.length > TOPE;
  return {
    precios: truncado ? salida.slice(0, TOPE) : salida,
    truncado,
    generadoEn: new Date(),
  };
}

/*
 * ── El stock de un local, para el portal ─────────────────────────
 *
 * El portal muestra, al revisar un pedido, cuánto hay de cada talle en el
 * local que despacha (lo elige ISUWAYA desde su panel, o ninguno). Es lo libre:
 * lo apartado para otro pedido no se puede volver a ofrecer.
 */
async function locales({ businessId }) {
  const filas = await BusinessLocation.findAll({
    where: { businessId, activo: true }, attributes: ['id', 'nombre', 'tipo'], order: [['id', 'ASC']],
  });
  return { locales: filas.map((l) => ({ id: l.id, nombre: l.nombre, tipo: l.tipo })) };
}

async function stockDelLocal({ businessId, local }) {
  const id = Number(local);
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('Falta el local.'), { status: 400 });
  // El local tiene que ser de este negocio: el id viaja en la dirección y lo puede cambiar cualquiera.
  const lugar = await BusinessLocation.findOne({ where: { id, businessId }, attributes: ['id'] });
  if (!lugar) throw Object.assign(new Error('Ese local no es de este negocio.'), { status: 404 });

  /*
   * shortcut: se manda todo el local aunque el portal pida "desde": no todos los
   * movimientos de stock tocan la fecha de la fila, y un cambio perdido es peor
   * que unos miles de renglones cada cuarto de hora. Si el catálogo crece mucho,
   * hacer el corte por los movimientos del libro.
   */
  const filas = await VariantStock.findAll({
    where: { businessId, locationId: id },
    attributes: ['productVariantId', 'stock', 'reservado'],
    include: [{ model: ProductVariant, as: 'variante', attributes: ['sku'], required: true, where: { sku: { [Op.ne]: null } } }],
    limit: TOPE + 1,
  });
  const truncado = filas.length > TOPE;
  return {
    stock: filas.slice(0, TOPE).map((f) => ({
      sku: f.variante.sku,
      cantidad: Math.max(0, (Number(f.stock) || 0) - (Number(f.reservado) || 0)),
    })),
    truncado,
    generadoEn: new Date(),
  };
}

module.exports = { precios, locales, stockDelLocal, TOPE };
