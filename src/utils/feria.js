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
const NO_ES_FERIA = { [Op.or]: [{ esFeria: false }, { esFeria: null }] };

/** Para un `where` que ya usa la columna: `{ ...soloNormales() }`. */
const soloNormales = () => ({ [Op.or]: [{ esFeria: false }, { esFeria: null }] });

module.exports = { NO_ES_FERIA, soloNormales };
