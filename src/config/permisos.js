/*
 * Catálogo de permisos.
 *
 * Única fuente de verdad de qué módulos existen. Antes la lista vivía repetida
 * en dos componentes del frontend y las rutas usaban strings sueltos, así que
 * era fácil que aparecieran desalineados: `cotizaciones` figuraba en la pantalla
 * de cargos desde siempre y ninguna ruta la exigía — el permiso no hacía nada.
 *
 * Niveles, de menor a mayor:
 *   ninguno → no ve la sección
 *   ver     → entra y consulta, no modifica
 *   editar  → consulta y modifica
 *
 * El dueño del negocio no aparece acá: tiene acceso total por ser dueño, no por
 * un permiso que se le pueda dar o quitar (ver requirePermission).
 */

const NIVELES = { ninguno: 0, ver: 1, editar: 2 };

const MODULOS = [
  { key: 'dashboard',    label: 'Dashboard',      descripcion: 'Métricas del negocio, evolución de ventas y rendimiento de productos.' },
  { key: 'stock',        label: 'Stock',          descripcion: 'Productos, variantes, ajustes de stock y escaneo con lector.' },
  { key: 'ventas',       label: 'Ventas',         descripcion: 'Punto de venta, registro de ventas y cobros.' },
  { key: 'cotizaciones', label: 'Cotizaciones',   descripcion: 'Presupuestos y su conversión en venta.' },
  { key: 'clientes',     label: 'Clientes',       descripcion: 'Alta y edición de clientes, consulta de padrón AFIP.' },
  { key: 'facturacion',  label: 'Facturación',    descripcion: 'Facturas electrónicas, CUITs del negocio y configuración de ARCA.' },
  { key: 'pagos',        label: 'Métodos de pago', descripcion: 'Medios de pago disponibles y sus recargos o descuentos.' },
  { key: 'caja',         label: 'Caja',           descripcion: 'Turnos de caja, movimientos de efectivo y arqueo.' },
  { key: 'empleados',    label: 'Empleados',      descripcion: 'Empleados, cargos y locales del negocio.' },
  { key: 'integraciones',label: 'Integraciones',  descripcion: 'Conexión con MercadoLibre y sincronización de stock.' },
  /*
   * Los tres del circuito depósito → local.
   *
   * Van separados de `stock` porque son trabajos distintos hechos por gente
   * distinta: quien cuenta bultos en el depósito no tiene por qué poder editar
   * precios del catálogo, y quien pide reposición desde el local no tiene por
   * qué poder aprobar su propio pedido.
   */
  { key: 'deposito',     label: 'Depósito',       descripcion: 'Ingreso de mercadería nueva al depósito, conteo y etiquetado.' },
  { key: 'reposicion',   label: 'Reposición',     descripcion: 'Pedidos de reposición del local y preparación de los envíos.' },
  { key: 'aprobaciones', label: 'Aprobaciones',   descripcion: 'Aprobar o rechazar pedidos de reposición e ingresos de mercadería, y anular ingresos mal cargados.' },
];

const CLAVES = MODULOS.map((m) => m.key);

/*
 * Módulos que antes no existían por separado: se atendían con el permiso de
 * otro. Un cargo guardado antes de este cambio no tiene la clave nueva, y sin
 * esto pasaría a 'ninguno' — es decir, empleados que venían trabajando normal
 * se quedarían afuera de su sección apenas se despliegue.
 *
 * La herencia sólo aplica cuando la clave nueva no está definida. En cuanto
 * alguien edita el cargo y guarda, quedan los valores explícitos.
 */
const HEREDA_DE = {
  clientes:      'ventas',
  pagos:         'facturacion',
  integraciones: 'stock',
  cotizaciones:  'ventas',
  caja:          'ventas',
  /*
   * Depósito y reposición heredan de stock: quien ya movía stock a mano sigue
   * pudiendo hacerlo por el circuito nuevo el día que se despliega.
   *
   * Aprobaciones NO hereda de nada, y es a propósito. Es la firma que separa a
   * quien carga del que autoriza; dársela por herencia a todo el que tenía
   * stock:editar anularía el control el mismo día que se enciende.
   */
  deposito:      'stock',
  reposicion:    'stock',
};

/** Nivel efectivo de un cargo para un módulo, aplicando la herencia. */
function nivelDe(permisos, modulo) {
  if (!permisos) return 'ninguno';
  if (permisos[modulo]) return permisos[modulo];
  const origen = HEREDA_DE[modulo];
  if (origen && permisos[origen]) return permisos[origen];
  return 'ninguno';
}

/** ¿El cargo alcanza el nivel pedido en ese módulo? */
function alcanza(permisos, modulo, minimo = 'ver') {
  return NIVELES[nivelDe(permisos, modulo)] >= NIVELES[minimo];
}

/**
 * Normaliza lo que llega del cliente al guardar un cargo: descarta claves que
 * no son módulos y niveles inventados. Sin esto, un permiso mal escrito se
 * guardaría en silencio y nunca daría acceso, que es de lo más difícil de
 * diagnosticar después.
 */
function sanitizarPermisos(entrada) {
  const salida = {};
  for (const key of CLAVES) {
    const valor = entrada?.[key];
    salida[key] = Object.hasOwn(NIVELES, valor) ? valor : nivelDe(entrada, key);
  }
  return salida;
}

/** Permisos de los cargos que se crean junto con el negocio. */
const PRESETS = {
  Administrador: {
    dashboard: 'editar', stock: 'editar', ventas: 'editar', cotizaciones: 'editar',
    clientes: 'editar', facturacion: 'editar', pagos: 'editar', caja: 'editar',
    empleados: 'editar', integraciones: 'editar',
    deposito: 'editar', reposicion: 'editar', aprobaciones: 'editar',
  },
  Vendedor: {
    dashboard: 'ver', stock: 'ver', ventas: 'editar', cotizaciones: 'editar',
    clientes: 'editar', facturacion: 'ver', pagos: 'ver', caja: 'editar',
    empleados: 'ninguno', integraciones: 'ninguno',
    // Pide reposición para su local, no aprueba ni toca el depósito.
    deposito: 'ninguno', reposicion: 'editar', aprobaciones: 'ninguno',
  },
  'Depósito': {
    dashboard: 'ver', stock: 'ver', ventas: 'ninguno', cotizaciones: 'ninguno',
    clientes: 'ninguno', facturacion: 'ninguno', pagos: 'ninguno', caja: 'ninguno',
    empleados: 'ninguno', integraciones: 'ver',
    // Ingresa mercadería y prepara envíos. No aprueba: para eso está oficina.
    deposito: 'editar', reposicion: 'editar', aprobaciones: 'ninguno',
  },
  /*
   * Oficina: no carga mercadería, autoriza. Ve todo para poder decidir y tiene
   * la firma; el trabajo de contar y etiquetar es de depósito.
   */
  Oficina: {
    dashboard: 'ver', stock: 'ver', ventas: 'ver', cotizaciones: 'ver',
    clientes: 'ver', facturacion: 'ver', pagos: 'ver', caja: 'ver',
    empleados: 'ninguno', integraciones: 'ninguno',
    deposito: 'ver', reposicion: 'ver', aprobaciones: 'editar',
  },
  Cajero: {
    dashboard: 'ver', stock: 'ver', ventas: 'editar', cotizaciones: 'ver',
    clientes: 'editar', facturacion: 'editar', pagos: 'ver', caja: 'editar',
    empleados: 'ninguno', integraciones: 'ninguno',
    deposito: 'ninguno', reposicion: 'ver', aprobaciones: 'ninguno',
  },
};

module.exports = { MODULOS, CLAVES, NIVELES, HEREDA_DE, nivelDe, alcanza, sanitizarPermisos, PRESETS };
