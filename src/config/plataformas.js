/*
 * Las formas de conectar un negocio con un canal de venta, y nada más.
 *
 * Es la única lista: la pantalla Plataformas, la puerta de las rutas de
 * máquina y el resumen salen de acá. Con el catálogo de funciones pasó que la
 * misma lista escrita a mano en tres lados se desincronizó; ésta no se repite.
 *
 * Sólo lo que existe de verdad. Lo que una pantalla muestra como "se puede
 * conectar" es una promesa al cliente, y una plataforma que no está construida
 * no va en esta lista aunque se piense hacer.
 *
 *   mercadolibre  El negocio autoriza su cuenta de Mercado Libre (OAuth) y
 *                 Stocker va a buscar las ventas y publica el stock.
 *   jumpseller    El negocio carga la clave de su tienda Jumpseller.
 *   tienda        Una página propia que habla el contrato de movimientos con
 *                 una credencial de máquina (origen 'tienda').
 *   mayorista     El portal de pedidos mayoristas, con una credencial de
 *                 máquina (origen 'isuwaya') y la bandeja de solicitudes.
 *
 * Una tienda propia y un portal por negocio, como hoy: la credencial nueva
 * apaga la anterior del mismo origen (integracionesService.emitir).
 */

const { FEATURES } = require('./planes');

const PLATAFORMAS = [
  { clave: 'mercadolibre', nombre: 'Mercado Libre',    feature: FEATURES.ECOMMERCE },
  { clave: 'jumpseller',   nombre: 'Jumpseller',       feature: FEATURES.ECOMMERCE },
  { clave: 'tienda',       nombre: 'Tienda propia',    feature: FEATURES.TIENDA_PROPIA,    origen: 'tienda' },
  { clave: 'mayorista',    nombre: 'Portal mayorista', feature: FEATURES.PORTAL_MAYORISTA, origen: 'isuwaya' },
];

/*
 * Qué función del plan abre cada origen de credencial.
 *
 * 'isuwaya' es el nombre histórico del origen del portal mayorista (el primer
 * portal fue el de ISUWAYA) y no se renombra: el portal lo manda en cada
 * pedido y las rutas /integraciones/isuwaya/* las llama otro repositorio.
 */
const FEATURE_POR_ORIGEN = Object.fromEntries(
  PLATAFORMAS.filter((p) => p.origen).map((p) => [p.origen, p.feature]),
);

module.exports = { PLATAFORMAS, FEATURE_POR_ORIGEN };
