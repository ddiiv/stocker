const { Op } = require('sequelize');

/*
 * Cómo se pregunta "esto NO es de feria".
 *
 * (`feria` es el nombre interno de lo que en la interfaz se llama EVENTO; ver
 * config/lugares.js.)
 *
 * Parece de más tener un helper para un booleano, y no lo es. `esFeria` se
 * agregó a una tabla que ya tenía filas, así que todo lo anterior al cambio
 * quedó en NULL hasta que corre el relleno — y una base recién migrada, o una
 * fila creada por un camino que no pone el valor, vuelve a tener NULLs.
 *
 * En SQL, `NOT (esFeria = 1)` es NULL para una fila con NULL, y una condición
 * que da NULL no incluye la fila. O sea que el filtro "traeme los que no son de
 * feria" dejaba afuera TODO el catálogo viejo, en silencio. Y `Op.not: true`
 * encima genera sintaxis inválida en SQL Server.
 *
 * Preguntarlo con un OR explícito funciona igual en los dos motores y no
 * depende de que el relleno haya corrido.
 */
/*
 * OJO al mezclarlo con otra condición.
 *
 * Esto ES un `Op.or`. Volcarlo en un `where` que ya tenga el suyo —con
 * `Object.assign` o con spread— hace que uno pise al otro en silencio, y el
 * que se pierde no deja rastro: la consulta corre igual y devuelve de más.
 * Pasó en el listado de productos, donde la búsqueda por texto también usa
 * `Op.or`: bastaba con escribir algo en el buscador para que los de evento se
 * colaran en el catálogo normal.
 *
 * Si el `where` puede tener otro `Op.or`, junten las dos condiciones bajo un
 * `Op.and` en vez de asignarlas sueltas.
 */
const NO_ES_FERIA = { [Op.or]: [{ esFeria: false }, { esFeria: null }] };

/** Para un `where` que ya usa la columna: `{ ...soloNormales() }`. */
const soloNormales = () => ({ [Op.or]: [{ esFeria: false }, { esFeria: null }] });

module.exports = { NO_ES_FERIA, soloNormales };
