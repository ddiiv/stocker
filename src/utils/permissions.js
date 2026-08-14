/*
 * Permisos del lado del cliente.
 *
 * Esto sólo decide qué se muestra: quién puede hacer qué lo resuelve el
 * backend en cada endpoint. Ocultar un botón es comodidad, no seguridad.
 *
 * La lista tiene que reflejar la de back/stocker/src/config/permisos.js. Si
 * agregás un módulo allá, sumalo acá o no va a aparecer en la matriz de cargos.
 */

// Debe coincidir con MODULOS del backend.
export const PERM_MODULES = [
  { key: "dashboard",     label: "Dashboard",       descripcion: "Métricas del negocio, evolución de ventas y rendimiento de productos." },
  { key: "stock",         label: "Stock",           descripcion: "Productos, variantes, ajustes de stock y escaneo con lector." },
  { key: "ventas",        label: "Ventas",          descripcion: "Punto de venta, registro de ventas y cobros." },
  { key: "cotizaciones",  label: "Cotizaciones",    descripcion: "Presupuestos y su conversión en venta." },
  { key: "clientes",      label: "Clientes",        descripcion: "Alta y edición de clientes, consulta de padrón AFIP." },
  { key: "facturacion",   label: "Facturación",     descripcion: "Facturas electrónicas, CUITs del negocio y configuración de ARCA." },
  { key: "pagos",         label: "Métodos de pago", descripcion: "Medios de pago disponibles y sus recargos o descuentos." },
  { key: "caja",          label: "Caja",            descripcion: "Turnos de caja, movimientos de efectivo y arqueo." },
  { key: "empleados",     label: "Empleados",       descripcion: "Empleados, cargos y locales del negocio." },
  { key: "integraciones", label: "Integraciones",   descripcion: "Conexión con MercadoLibre y sincronización de stock." },
];

export const NIVELES = [
  { value: "ninguno", label: "Sin acceso", ayuda: "No ve la sección." },
  { value: "ver",     label: "Sólo ver",   ayuda: "Entra y consulta, no puede modificar." },
  { value: "editar",  label: "Ver y editar", ayuda: "Consulta y modifica." },
];

const ORDEN = { ninguno: 0, ver: 1, editar: 2 };

/*
 * Módulos que antes se cubrían con el permiso de otro. Un cargo guardado antes
 * de que existieran no tiene la clave nueva; sin esta herencia el empleado
 * vería la sección desaparecer de un día para el otro. Igual que en el backend.
 */
const HEREDA_DE = {
  clientes:      "ventas",
  pagos:         "facturacion",
  integraciones: "stock",
  cotizaciones:  "ventas",
  caja:          "ventas",
};

export function nivelDe(user, moduleKey) {
  const permisos = user?.permisos;
  if (!permisos) return "ninguno";
  if (permisos[moduleKey]) return permisos[moduleKey];
  const origen = HEREDA_DE[moduleKey];
  if (origen && permisos[origen]) return permisos[origen];
  return "ninguno";
}

/*
 * El dueño es ADMINISTRADOR TOTAL: acceso a todo por ser dueño de la cuenta,
 * no por un permiso que se le pueda dar o quitar. Por eso no figura en la
 * matriz de cargos ni se le puede asignar a un empleado.
 */
export function esAdministradorTotal(user) {
  return user?.type === "business";
}

export function canView(user, moduleKey) {
  if (!user) return false;
  if (esAdministradorTotal(user)) return true;
  return ORDEN[nivelDe(user, moduleKey)] >= ORDEN.ver;
}

export function canEdit(user, moduleKey) {
  if (!user) return false;
  if (esAdministradorTotal(user)) return true;
  return ORDEN[nivelDe(user, moduleKey)] >= ORDEN.editar;
}

/** Permisos vacíos para un cargo nuevo. */
export const permisosVacios = () =>
  Object.fromEntries(PERM_MODULES.map((m) => [m.key, "ninguno"]));
