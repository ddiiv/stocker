/*
 * Los tipos de lugar y qué hace cada uno.
 *
 * Vive acá y no repartido en filtros sueltos porque el criterio "no es
 * depósito" ya se escribió en cinco consultas distintas, y cuando apareció el
 * cuarto tipo —feria— todas esas lo dieron por bueno sin que nadie lo
 * decidiera: un puesto de feria pasaba a recibir reposición y a ser candidato a
 * local por defecto para movimientos de stock, que es justo lo que no tiene que
 * pasar con un lugar que no lleva inventario.
 *
 *   local     vende · recibe reposición · lleva stock
 *   deposito  NO vende · es la puerta de entrada de la mercadería
 *   online    vende · recibe reposición · lleva stock (el que se publica en ML)
 *   feria     vende · NO lleva stock · sólo productos de feria
 */

const TIPOS = ['local', 'deposito', 'online', 'feria'];

/** Dónde se puede registrar una venta. */
const VENDEN = ['local', 'online', 'feria'];

/*
 * Dónde vive mercadería contada.
 *
 * Es el conjunto que importa para reposición, transferencias, el local por
 * defecto de un movimiento y la sincronización con MercadoLibre. La feria
 * queda afuera a propósito: pedirle stock a un lugar que no lo lleva devuelve
 * siempre cero y ensucia toda cuenta que lo incluya.
 */
const CON_STOCK = ['local', 'online'];

/** Los que reciben un pedido de reposición desde el depósito. */
const RECIBEN_REPOSICION = ['local', 'online'];

const vende            = (tipo) => VENDEN.includes(tipo);
const llevaStock       = (tipo) => CON_STOCK.includes(tipo);
const recibeReposicion = (tipo) => RECIBEN_REPOSICION.includes(tipo);
const esFeria          = (tipo) => tipo === 'feria';

module.exports = {
  TIPOS, VENDEN, CON_STOCK, RECIBEN_REPOSICION,
  vende, llevaStock, recibeReposicion, esFeria,
};
