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

/*
 * Claves de función. Cada una se chequea en la ruta que la usa —con
 * requireFeature(clave), tieneFeature o requireIntegracion—, y ninguna entra
 * acá sin eso: una función que figura en el plan y que ninguna ruta mira es
 * una promesa que el sistema no cumple (scripts/test-legales.cjs lo controla).
 */
const FEATURES = {
  FACTURACION:          'facturacion',          // emitir comprobantes ARCA
  ECOMMERCE:            'ecommerce',            // Mercado Libre y Jumpseller
  CUENTAS_CORRIENTES:   'cuentasCorrientes',    // fiado / B2B
  /*
   * Las dos conexiones de máquina: una página propia que vende online y el
   * portal donde los clientes mayoristas arman sus pedidos. Las dos entran
   * con una credencial que emite el equipo de Stocker (no el cliente) y las
   * dos las exige requireIntegracion según el origen de esa credencial.
   *
   * Van separadas aunque hoy se vendan juntas: son dos puentes distintos, con
   * rutas distintas, y el día que se cotice uno sin el otro alcanza con
   * destildar una casilla en el backoffice en vez de partir una clave en dos.
   */
  TIENDA_PROPIA:        'tiendaPropia',         // página propia conectada por credencial
  PORTAL_MAYORISTA:     'portalMayorista',      // portal de pedidos mayoristas
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
 * Funciones que el catálogo vendía y el sistema nunca tuvo (decisión 8 del
 * dueño): facturación por lote, proveedores y órdenes de compra, listas de
 * precios por cliente y una API genérica. El "stock separado por local" sí
 * existe, pero en TODOS los planes —cada local lleva su stock desde siempre—,
 * así que venderlo como exclusivo del Superior también era falso.
 *
 * Se sacaron del catálogo y de los planes. La lista queda para limpiar lo que
 * ya está guardado: un plan editado desde el backoffice las trae en su JSON, y
 * la pantalla las mandaría de vuelta al guardar (ver sembrarPlanes y
 * backofficeController.editarPlan). Si algún día se construye una, vuelve a
 * FEATURES con la ruta que la exige, no antes.
 */
const FEATURES_RETIRADAS = ['facturacionMasiva', 'compras', 'multiDeposito', 'listasPrecios', 'api'];

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
  { clave: FEATURES.CUENTAS_CORRIENTES, label: 'Cuentas corrientes y fiado',          ayuda: 'Vender a cuenta y llevar el saldo del cliente.' },
  /*
   * Decía «Mercado Libre» a secas, pero la misma clave abre Jumpseller: un
   * plan que la incluye da las dos, y la tarjeta tiene que decirlo.
   */
  { clave: FEATURES.ECOMMERCE,          label: 'Mercado Libre y Jumpseller',          ayuda: 'Sincronizar el stock y traer las ventas de Mercado Libre y de una tienda Jumpseller.' },
  { clave: FEATURES.TIENDA_PROPIA,      label: 'Tienda online propia conectada',      ayuda: 'Una página propia que pregunta catálogo, precios y stock, y manda sus ventas a Stocker. La credencial la emite el equipo de Stocker.' },
  { clave: FEATURES.PORTAL_MAYORISTA,   label: 'Portal de pedidos mayoristas',        ayuda: 'Los pedidos que arman los clientes mayoristas en su portal llegan a una bandeja para aceptarlos o rechazarlos.' },
  { clave: FEATURES.DEPOSITO,           label: 'Depósito: ingreso de mercadería',     ayuda: 'Recibir mercadería, cargarla por series y generar etiquetas.' },
  { clave: FEATURES.REPOSICION,         label: 'Reposición entre depósito y locales', ayuda: 'Pedidos del local, aprobación y despacho desde el depósito.' },
];

/*
 * `textosViejos`: lo que decían antes la descripción y el soporte de cada plan.
 *
 * Un plan editado desde el backoffice no lo pisa la semilla (ver
 * sembrarPlanes), pero dos de esos textos prometían lo que no existe —soporte
 * por chat y por teléfono, facturación masiva, compras— y tienen que dejar de
 * decirlo YA (decisión 8). Por eso, sólo si el texto guardado es EXACTAMENTE
 * uno de éstos, se reemplaza por el de hoy: si un operador escribió el suyo, no
 * coincide y se respeta.
 */
const PLANES = [
  {
    codigo: 'inicial',
    nombre: 'Plan Inicial',
    descripcion: 'Para arrancar a facturar y ordenar el stock de un negocio chico.',
    precioMensual: 48400,
    maxCuits: 1,
    maxEmpleados: 2,
    maxLocales: 2,
    maxSkus: 5000,
    maxComprobantes: 2000,
    // Sesiones del DUEÑO a la vez; un celular cuenta como una más. Dos alcanzan
    // para la PC del local y el teléfono, que es el uso normal de un local solo.
    maxSesiones: 2,
    /*
     * Soporte: lo que de verdad hay. Se contesta por mail (el formulario de
     * Soporte del sistema también llega como mail); chat y teléfono no tienen
     * herramienta atrás y se dejaron de prometer.
     */
    soporte: 'Por mail',
    orden: 1,
    textosViejos: {
      descripcion: ['Para arrancar a facturar y ordenar el stock de un local.'],
      soporte: ['Email y chat'],
    },
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
      [FEATURES.ECOMMERCE]:          false,
      [FEATURES.CUENTAS_CORRIENTES]: false,
      [FEATURES.TIENDA_PROPIA]:      false,
      [FEATURES.PORTAL_MAYORISTA]:   false,
      // Depósito y reposición sólo tienen sentido con más de un punto de
      // venta, que es lo que empieza a pasar recién en el Pro.
      [FEATURES.DEPOSITO]:           false,
      [FEATURES.REPOSICION]:         false,
    },
  },
  {
    codigo: 'pro',
    nombre: 'Plan Pro',
    descripcion: 'Para vender por varios canales: depósito, Mercado Libre, Jumpseller, tienda propia y portal mayorista.',
    precioMensual: 97800,
    maxCuits: 2,
    maxEmpleados: 10,
    maxLocales: 4,
    maxSkus: 10000,
    maxComprobantes: 5000,
    maxSesiones: 3,
    soporte: 'Por mail, con prioridad',
    orden: 2,
    textosViejos: {
      descripcion: ['Venta multicanal con facturación masiva y control de compras.'],
      soporte: ['Chat prioritario'],
    },
    features: {
      [FEATURES.FACTURACION]:        true,
      [FEATURES.ECOMMERCE]:          true,
      [FEATURES.IMPORTACION_MASIVA]: true,
      [FEATURES.CUENTAS_CORRIENTES]: true,
      [FEATURES.EVENTOS]:            true,
      [FEATURES.DEPOSITO]:           true,
      [FEATURES.REPOSICION]:         true,
      /*
       * Tienda propia y portal mayorista entran desde el Pro (decisión del
       * dueño): es el plan de quien ya vende por más de un canal. Quien tenía
       * la credencial antes de que existiera la puerta la conserva aunque su
       * plan no la incluya (ver ensureColumns.heredarConexionesPropias).
       */
      [FEATURES.TIENDA_PROPIA]:      true,
      [FEATURES.PORTAL_MAYORISTA]:   true,
    },
  },
  {
    codigo: 'superior',
    nombre: 'Plan Superior',
    descripcion: 'Todo lo del Pro con más capacidad, para varias sucursales y razones sociales.',
    precioMensual: 178000,
    maxCuits: 3,
    maxEmpleados: 40,
    maxLocales: 20,
    maxSkus: 20000,
    maxComprobantes: 10000,
    maxSesiones: 5,
    soporte: 'Por mail, con prioridad',
    orden: 3,
    textosViejos: {
      descripcion: ['Varias sucursales y razones sociales, con todo el sistema abierto.'],
      soporte: ['Chat prioritario y teléfono'],
    },
    /*
     * Todas las funciones, que hoy son las mismas que las del Pro: lo que
     * separa al Superior es cuánta operación soporta, no qué hace el sistema.
     * Se vendía por multi-depósito, listas de precios, API y facturación por
     * lote, y ninguna de esas existía.
     */
    features: Object.fromEntries(Object.values(FEATURES).map((f) => [f, true])),
  },
  {
    codigo: 'enterprise',
    nombre: 'Plan Enterprise',
    descripcion: 'Mayoristas y distribuidores: sin topes y con precio acordado.',
    precioMensual: null,          // a cotizar
    requiereCotizacion: true,
    maxCuits: null,
    maxEmpleados: null,
    maxLocales: null,
    maxSkus: null,
    maxComprobantes: null,
    maxSesiones: null,
    soporte: 'Ejecutivo dedicado',
    orden: 4,
    textosViejos: {
      descripcion: ['Mayoristas y distribuidores: multi-CUIT, multi-depósito y B2B.'],
      soporte: ['Ejecutivo dedicado + teléfono'],
    },
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

module.exports = {
  FEATURES, FEATURES_RETIRADAS, CATALOGO_FEATURES, PLANES, PLAN_POR_DEFECTO, DIAS_TRIAL, DIAS_GRACIA,
};
