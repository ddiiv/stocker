/*
 * Lo que de un negocio puede llegar al navegador.
 *
 * ── Por qué una lista de lo permitido y no de lo prohibido ─────────
 *
 * Hasta acá el login, /auth/me y GET /api/account mandaban el negocio entero
 * "menos el passwordHash": `const { passwordHash, ...safe } = b.toJSON()`. Eso
 * es una lista de lo prohibido, y una lista de lo prohibido envejece mal: cada
 * columna que se le agrega a la tabla sale al navegador sola, sin que nadie lo
 * decida.
 *
 * Y es exactamente lo que pasó. Cuando se agregó el doble factor, `totpSecret`
 * —la semilla de la que salen los códigos— empezó a viajar en la respuesta del
 * login. Quien leyera una sola de esas respuestas (una sesión robada, una
 * extensión del navegador, las herramientas de desarrollo en una compu
 * compartida, el log de un proxy) podía generar códigos válidos para siempre: el
 * segundo factor quedaba anulado, y justo para el que se había tomado el trabajo
 * de activarlo. Con él viajaban también los hashes de los códigos de
 * recuperación, la IP desde la que se aceptaron los términos y datos internos
 * del plan.
 *
 * Una lista de lo permitido falla del lado seguro: una columna nueva NO sale
 * hasta que alguien la agrega acá a propósito, y ese alguien tiene que leer este
 * comentario para hacerlo.
 */

/*
 * Los campos que el front usa de verdad, más los de configuración que no son
 * sensibles y que la pantalla de Configuración va a mostrar.
 *
 * Al agregar uno, preguntate: ¿pasa algo si esto lo ve quien se robó la
 * sesión? Si la respuesta es sí, no va acá.
 */
const PERMITIDOS = [
  'id',
  'nombreNegocio',
  'ownerNombre',
  'ownerApellido',
  'ownerTelefono',
  'telefono',
  'email',
  'cuit',
  'condicionIva',
  'arcaSyncEn',
  'createdAt',
  // Preferencias del negocio: no dicen nada que sirva para entrar a la cuenta.
  'ventaSinStock',
  'reglaSku',
  // Cuándo y qué versión de los términos se aceptó. La IP desde la que se
  // aceptaron queda afuera: es un dato personal y la pantalla no la necesita.
  'terminosVersion',
  'terminosAceptadosEn',
  // Desde cuándo está activo el doble factor: una fecha, no el secreto.
  'totpActivadoEn',
  // Cada cuántas horas sin uso se vuelve a pedir: un ajuste, no un secreto.
  'dobleFactorVentanaH',
  'sesionInactividadMin',
];

/**
 * El negocio, listo para mandar al navegador.
 *
 * Acepta tanto una instancia de Sequelize como un objeto plano, para que nadie
 * tenga la tentación de hacer `toJSON()` a mano y saltearse este filtro.
 */
function serializarCuenta(negocio) {
  if (!negocio) return null;
  const crudo = typeof negocio.toJSON === 'function' ? negocio.toJSON() : negocio;
  const salida = {};
  for (const campo of PERMITIDOS) {
    if (campo in crudo) salida[campo] = crudo[campo];
  }
  return salida;
}

module.exports = { serializarCuenta, PERMITIDOS };
