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
const { Product, ProductVariant } = require('../models');
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

module.exports = { precios, TOPE };
