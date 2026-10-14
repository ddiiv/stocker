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
/*
 * 2026-10: los Términos suman las integraciones (Jumpseller, tienda propia,
 * portal mayorista), las credenciales de máquina, el límite de dispositivos
 * del dueño, los cambios de plan (prorrateo, bajada con empleados suspendidos,
 * débito automático), los desarrollos a medida, la reserva de stock de un
 * pedido sin pagar y el logo de la factura. La Privacidad, las sesiones y las
 * cotizaciones, y deja de decir que las claves de Mercado Libre y Jumpseller se
 * guardan cifradas. La landing muestra este mismo número arriba de las dos
 * páginas (scripts/test-legales.cjs controla que coincidan).
 */
const TERMINOS_VERSION = '2026-10';

module.exports = { TERMINOS_VERSION };
