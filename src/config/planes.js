/*
 * Catálogo comercial de Stocker.
 *
 * Esto es la semilla, no la verdad: al arrancar se copia a la tabla `plans` si
 * falta, y de ahí en más manda la base. Subir el tope de empleados del Pro o
 * cotizarle un precio distinto a un Enterprise es una edición de datos, no un
 * deploy.
 *
 * `null` en un tope significa sin límite. Cero no serviría: cero es un tope
 * real (ningún empleado) y hay que poder expresarlo.
 *
 * Dos clases de tope, que se controlan distinto:
 *
 *   Acumulativos (cuits, empleados, locales, skus) → se mide lo que hay hoy.
 *     Borrar un producto libera lugar. Es capacidad de almacenamiento.
 *
 *   Por período (comprobantes) → se mide el MES CORRIENTE y arranca de cero
 *     el día 1. Es consumo, no capacidad: un negocio que factura 2000 por mes
 *     no ocupa más espacio en el mes 12 que en el mes 1.
 */

// Claves de función. Cada una se chequea con requireFeature(clave) en la ruta
// que la usa; agregar una acá y no usarla no rompe nada.
const FEATURES = {
  FACTURACION:          'facturacion',          // emitir comprobantes ARCA
  FACTURACION_MASIVA:   'facturacionMasiva',    // por lote
  ECOMMERCE:            'ecommerce',            // Mercado Libre y afines
  COMPRAS:              'compras',              // proveedores y órdenes de compra
  CUENTAS_CORRIENTES:   'cuentasCorrientes',    // fiado / B2B
  MULTI_DEPOSITO:       'multiDeposito',        // stock por local
  LISTAS_PRECIOS:       'listasPrecios',        // precios por cliente
  API:                  'api',                  // API para integraciones a medida
  IMPORTACION_MASIVA:   'importacionMasiva',    // alta/edición por Excel
};

const PLANES = [
  {
    codigo: 'inicial',
    nombre: 'Plan Inicial',
    descripcion: 'Para arrancar a facturar y ordenar el stock de un local.',
    precioMensual: 48400,
    maxCuits: 1,
    maxEmpleados: 2,
    maxLocales: 2,
    maxSkus: 5000,
    maxComprobantes: 2000,
    soporte: 'Email y chat',
    orden: 1,
    features: {
      [FEATURES.FACTURACION]:        true,
      [FEATURES.IMPORTACION_MASIVA]: true,   // carga por planilla
      [FEATURES.FACTURACION_MASIVA]: false,
      [FEATURES.ECOMMERCE]:          false,
      [FEATURES.COMPRAS]:            false,
      [FEATURES.CUENTAS_CORRIENTES]: false,
      [FEATURES.MULTI_DEPOSITO]:     false,
      [FEATURES.LISTAS_PRECIOS]:     false,
      [FEATURES.API]:                false,
    },
  },
  {
    codigo: 'pro',
    nombre: 'Plan Pro',
    descripcion: 'Venta multicanal con facturación masiva y control de compras.',
    precioMensual: 97800,
    maxCuits: 2,
    maxEmpleados: 10,
    maxLocales: 4,
    maxSkus: 10000,
    maxComprobantes: 5000,
    soporte: 'Chat prioritario',
    orden: 2,
    features: {
      [FEATURES.FACTURACION]:        true,
      [FEATURES.FACTURACION_MASIVA]: true,
      [FEATURES.ECOMMERCE]:          true,
      [FEATURES.COMPRAS]:            true,
      [FEATURES.IMPORTACION_MASIVA]: true,
      [FEATURES.CUENTAS_CORRIENTES]: true,
      [FEATURES.MULTI_DEPOSITO]:     false,
      [FEATURES.LISTAS_PRECIOS]:     false,
      [FEATURES.API]:                false,
    },
  },
  {
    codigo: 'superior',
    nombre: 'Plan Superior',
    descripcion: 'Varias sucursales y razones sociales, con todo el sistema abierto.',
    precioMensual: 178000,
    maxCuits: 3,
    maxEmpleados: 40,
    maxLocales: 20,
    maxSkus: 20000,
    maxComprobantes: 10000,
    soporte: 'Chat prioritario y teléfono',
    orden: 3,
    // Todas las funciones. Lo que lo separa del Enterprise no es qué hace el
    // sistema sino cuánta operación soporta: topes en vez de funciones.
    features: Object.fromEntries(Object.values(FEATURES).map((f) => [f, true])),
  },
  {
    codigo: 'enterprise',
    nombre: 'Plan Enterprise',
    descripcion: 'Mayoristas y distribuidores: multi-CUIT, multi-depósito y B2B.',
    precioMensual: null,          // a cotizar
    requiereCotizacion: true,
    maxCuits: null,
    maxEmpleados: null,
    maxLocales: null,
    maxSkus: null,
    maxComprobantes: null,
    soporte: 'Ejecutivo dedicado + teléfono',
    orden: 4,
    features: Object.fromEntries(Object.values(FEATURES).map((f) => [f, true])),
  },
];

// Con qué plan nace una cuenta nueva y cuánto dura la prueba.
const PLAN_POR_DEFECTO = 'pro';
const DIAS_TRIAL = 14;

// Días de tolerancia después de vencer el período antes de bajar a lectura.
// Existe porque una transferencia tarda en acreditarse y cortar el servicio
// mientras la plata está en camino es un problema de soporte, no de cobranza.
const DIAS_GRACIA = 3;

module.exports = { FEATURES, PLANES, PLAN_POR_DEFECTO, DIAS_TRIAL, DIAS_GRACIA };
