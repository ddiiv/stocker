const { Op, literal } = require('sequelize');
const { citar } = require('./sqlHelpers');
const sequelize = require('../config/database');

/*
 * `true` escrito como lo entiende cada motor.
 *
 * SQL Server no tiene booleano: `esPack` es un BIT y se compara contra 1.
 * Postgres sí lo tiene y rechaza `boolean = integer`. En una subconsulta
 * escrita a mano no hay Sequelize que traduzca, así que se elige acá.
 */
const VERDADERO = () => (sequelize.getDialect() === 'postgres' ? 'true' : '1');

/*
 * Cómo se pregunta "esto NO es un pack".
 *
 * Un pack no es un artículo más del catálogo. Es la forma de vender de a N
 * unidades de otra cosa: una tabla intermedia con SKU propio, para que Mercado
 * Libre pueda publicarlo y el mostrador escanearlo. No tiene stock, no se
 * ingresa, no se transfiere, no se cuenta en un inventario.
 *
 * Por eso desaparece de todas las pantallas que hablan de mercadería —el
 * catálogo, el stock por local, el depósito, la reposición— y aparece sólo
 * donde se vende y en su propia pantalla. Mezclarlo con las prendas hace que
 * el mismo par de medias se cuente dos veces: una suelta y otra adentro de un
 * pack que no existe hasta que alguien lo arma.
 *
 * `esPack` es NOT NULL con valor por defecto, así que acá no hace falta el OR
 * contra NULL que sí necesita `esFeria`.
 */

/** Para un `where` sobre product_variants. */
const NO_ES_PACK = { esPack: false };

/*
 * Para un `where` sobre products.
 *
 * Un producto de packs sólo tiene variantes de pack —lo garantiza la regla que
 * impide mezclar un pack con prendas sueltas en el mismo producto— así que
 * alcanza con preguntar si alguna de sus variantes lo es.
 *
 * Va como subconsulta y no como una columna en `products` para no tener el dato
 * escrito en dos lugares: la verdad está en la variante, y una copia en el
 * producto se desincroniza la primera vez que alguien desarma un pack por un
 * camino que no la actualice.
 */
const productoNoEsPack = (alias = 'Product') => literal(
  '(NOT EXISTS (SELECT 1 FROM product_variants pv '
  + `WHERE pv.${citar('productId')} = ${citar(alias)}.${citar('id')} `
  + `AND pv.${citar('esPack')} = ${VERDADERO()}))`,
);

module.exports = { NO_ES_PACK, productoNoEsPack, Op };
