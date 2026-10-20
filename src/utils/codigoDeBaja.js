const { ProductVariant } = require('../models');

/*
 * El SKU de lo que se da de baja: el de siempre con "-BAJA<id>" al final.
 *
 * Dar de baja deja la fila (las ventas y los movimientos la siguen nombrando),
 * pero el SKU es único dentro del negocio: sin esto el código quedaba tomado
 * por un producto que ya no existe, y volver a cargar uno igual —mismo SKU
 * padre, mismo agrupador— decía "ya tenés un producto con ese SKU". Las ventas
 * viejas no cambian: cada ítem guarda su propio SKU.
 */
const LARGO = { producto: 80, variante: 100 };

function codigoDeBaja(sku, id, largo) {
  const cola = `-BAJA${id}`;
  const actual = String(sku || '');
  if (actual.endsWith(cola)) return actual;
  return actual.slice(0, largo - cola.length) + cola;
}

/** Libera el SKU del producto y los de sus variantes. No cambia `activo`: eso lo decide quien da de baja. */
async function liberarCodigos({ producto = null, variantes = null }, transaction) {
  const lista = variantes || (producto
    ? await ProductVariant.findAll({ where: { productId: producto.id }, attributes: ['id', 'sku'], transaction })
    : []);
  for (const v of lista) {
    await ProductVariant.update({ sku: codigoDeBaja(v.sku, v.id, LARGO.variante) }, { where: { id: v.id }, transaction });
  }
  if (producto) await producto.update({ sku: codigoDeBaja(producto.sku, producto.id, LARGO.producto) }, { transaction });
}

module.exports = { codigoDeBaja, liberarCodigos, LARGO };
