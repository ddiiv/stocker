/*
 * La versión de los términos vigente.
 *
 * Va en el código y no en la base para que cambiarla sea parte de un despliegue
 * y quede en el historial: el día que se discuta qué decía el texto que alguien
 * aceptó, el commit es la respuesta.
 *
 * Al cambiar el texto de /terminos hay que subir esta versión. Si no, las
 * cuentas nuevas quedan registradas aceptando una versión que ya no es la que
 * leyeron.
 *
 * Vive acá y no adentro del registro porque ahora la leen dos: el registro, que
 * la graba en la cuenta, y la pantalla de Configuración, que muestra al lado de
 * la versión aceptada cuál es la vigente. Con una copia en cada lado, el día que
 * se sube una y no la otra la pantalla le dice al dueño que está al día con un
 * texto que ya cambió.
 */
const TERMINOS_VERSION = '2026-09';

module.exports = { TERMINOS_VERSION };
