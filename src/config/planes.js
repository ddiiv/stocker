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
  /*
   * El circuito de mercadería, que hasta ahora no estaba en ningún plan.
   *
   * Son tres funciones grandes que cualquier cuenta usaba sin importar qué
   * pagara. Van separadas y no como una sola porque se compran distinto: un
   * negocio de una sucursal que hace ferias quiere EVENTOS y no necesita
   * depósito; uno de cinco sucursales necesita DEPOSITO y REPOSICION y capaz
   * nunca pisa una feria.
   */
  DEPOSITO:             'deposito',             // ingreso de mercadería y series
  REPOSICION:           'reposicion',           // pedidos local ↔ depósito
  EVENTOS:              'eventos',              // catálogo de evento (venta sin stock)
};

/*
 * Las funciones como se muestran: orden, nombre y para qué sirven.
 *
 * Existe porque la misma lista estaba escrita a mano en tres lugares —el
 * backoffice, la pantalla de suscripción y la landing— y las tres se
 * desincronizaron. El backoffice se quedó en nueve funciones cuando ya eran
 * doce: un operador no podía ver ni tocar Eventos, Depósito ni Reposición, y
 * la tarjeta de un plan mostraba menos de lo que el plan realmente daba.
 *
 * El orden es el comercial, no el alfabético: de lo que trae el plan más
 * barato hacia lo que justifica el más caro. Es el orden en que se leen las
 * tarjetas comparándolas de izquierda a derecha.
 *
 * `ayuda` es para el backoffice, donde quien tilda la casilla no siempre sabe
 * qué habilita.
 */
const CATALOGO_FEATURES = [
  { clave: FEATURES.FACTURACION,        label: 'Facturación electrónica ARCA',        ayuda: 'Emitir comprobantes fiscales.' },
  { clave: FEATURES.IMPORTACION_MASIVA, label: 'Alta y edición por planilla',         ayuda: 'Cargar y actualizar el catálogo desde Excel.' },
  { clave: FEATURES.EVENTOS,            label: 'Eventos: vender sin llevar stock',    ayuda: 'Catálogo de evento: se registra qué se vendió, no cuánto queda.' },
  { clave: FEATURES.FACTURACION_MASIVA, label: 'Facturación por lote',                ayuda: 'Emitir muchos comprobantes de una vez.' },
  { clave: FEATURES.CUENTAS_CORRIENTES, label: 'Cuentas corrientes y fiado',          ayuda: 'Vender a cuenta y llevar el saldo del cliente.' },
  { clave: FEATURES.ECOMMERCE,          label: 'Mercado Libre',                       ayuda: 'Publicar y sincronizar el stock con Mercado Libre.' },
  { clave: FEATURES.COMPRAS,            label: 'Proveedores y órdenes de compra',     ayuda: 'Registrar compras y llevar el circuito con proveedores.' },
  { clave: FEATURES.DEPOSITO,           label: 'Depósito: ingreso de mercadería',     ayuda: 'Recibir mercadería, cargarla por series y generar etiquetas.' },
  { clave: FEATURES.REPOSICION,         label: 'Reposición entre depósito y locales', ayuda: 'Pedidos del local, aprobación y despacho desde el depósito.' },
  { clave: FEATURES.MULTI_DEPOSITO,     label: 'Stock separado por local',            ayuda: 'Cada sucursal con su propio inventario.' },
  { clave: FEATURES.LISTAS_PRECIOS,     label: 'Listas de precios por cliente',       ayuda: 'Precios distintos según el cliente o el canal.' },
  { clave: FEATURES.API,                label: 'API para integraciones',              ayuda: 'Acceso programático para sistemas a medida.' },
];

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
      /*
       * Eventos entra desde el plan más barato a propósito: el que vende en
       * ferias suele ser justamente el negocio chico de un solo local, y es la
       * función que le resuelve el día. Cobrársela aparte sería empujarlo a
       * anotar las ventas en un cuaderno.
       */
      [FEATURES.EVENTOS]:            true,
      [FEATURES.FACTURACION_MASIVA]: false,
      [FEATURES.ECOMMERCE]:          false,
      [FEATURES.COMPRAS]:            false,
      [FEATURES.CUENTAS_CORRIENTES]: false,
      [FEATURES.MULTI_DEPOSITO]:     false,
      [FEATURES.LISTAS_PRECIOS]:     false,
      [FEATURES.API]:                false,
      // Depósito y reposición sólo tienen sentido con más de un punto de
      // venta, que es lo que empieza a pasar recién en el Pro.
      [FEATURES.DEPOSITO]:           false,
      [FEATURES.REPOSICION]:         false,
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
      [FEATURES.EVENTOS]:            true,
      [FEATURES.DEPOSITO]:           true,
      [FEATURES.REPOSICION]:         true,
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

module.exports = { FEATURES, CATALOGO_FEATURES, PLANES, PLAN_POR_DEFECTO, DIAS_TRIAL, DIAS_GRACIA };
