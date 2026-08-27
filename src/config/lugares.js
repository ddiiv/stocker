/*
 * Los tipos de lugar y qué hace cada uno.
 *
 * Vive acá y no repartido en filtros sueltos porque el criterio "no es
 * depósito" ya se escribió en cinco consultas distintas, y cuando apareció el
 * cuarto tipo —feria— todas esas lo dieron por bueno sin que nadie lo
 * decidiera: un local de evento pasaba a recibir reposición y a ser candidato a
 * local por defecto para movimientos de stock, que es justo lo que no tiene que
 * pasar con un lugar que no lleva inventario.
 *
 *   local     vende · recibe reposición · lleva stock
 *   deposito  NO vende · es la puerta de entrada de la mercadería
 *   online    vende · recibe reposición · lleva stock (el que se publica en ML)
 *   feria     vende · NO lleva stock · sólo productos de evento
 *
 * OJO con `feria`. En la interfaz ese tipo se llama EVENTO, y sus productos son
 * "productos de evento". Adentro sigue diciendo `feria` —acá, en la columna
 * `tipo`, en `esFeria` y en las rutas /api/feria— porque los locales ya creados
 * tienen ese valor grabado y renombrarlo sería migrar datos de producción para
 * no cambiarle nada a nadie. Si hace falta un nombre para mostrar, está en
 * NOMBRES: no se escribe la traducción a mano en cada pantalla.
 */

const TIPOS = ['local', 'deposito', 'online', 'feria'];

/** Cómo se llama cada tipo en pantalla. */
const NOMBRES = {
  local:    'Local de venta',
  deposito: 'Depósito',
  online:   'Online / Envíos',
  feria:    'Evento',
};

/** Dónde se puede registrar una venta. */
const VENDEN = ['local', 'online', 'feria'];

/*
 * Dónde vive mercadería contada.
 *
 * Es el conjunto que importa para reposición, transferencias, el local por
 * defecto de un movimiento y la sincronización con Mercado Libre. El evento
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
  TIPOS, NOMBRES, VENDEN, CON_STOCK, RECIBEN_REPOSICION,
  vende, llevaStock, recibeReposicion, esFeria,
};
