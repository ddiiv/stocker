// Puntos de venta y empleados de ejemplo. En el backend real esto
// pasaría a ser dos tablas: `pos` y `employees` (con FK a `business`).

export const seedPos = [
  { id: "pos_deposito", nombre: "Depósito Central", direccion: "Av. Warnes 2450, CABA" },
  { id: "pos_local1", nombre: "Local Once", direccion: "Av. Rivadavia 5120, CABA" },
  { id: "pos_local2", nombre: "Local Flores", direccion: "Av. Rivadavia 7300, CABA" },
  { id: "pos_online", nombre: "Ventas Online", direccion: "—" },
];

export const PERMISSION_MODULES = [
  { key: "stock", label: "Stock" },
  { key: "ventas", label: "Ventas / Cotizaciones" },
  { key: "facturacion", label: "Facturación" },
  { key: "empleados", label: "Empleados" },
  { key: "dashboard", label: "Dashboard" },
];

export const ROLES = ["Administrador", "Encargado", "Vendedor", "Depósito", "Cajero"];

function perms({ stock = "ninguno", ventas = "ninguno", facturacion = "ninguno", empleados = "ninguno", dashboard = "ninguno" } = {}) {
  return { stock, ventas, facturacion, empleados, dashboard };
}
// niveles posibles por módulo: "ninguno" | "ver" | "editar"

export const seedEmployees = [
  {
    id: "emp_1",
    nombre: "Marina",
    apellido: "Sosa",
    email: "marina.sosa@stocker.local",
    telefono: "1122334455",
    rol: "Administrador",
    posIds: ["pos_deposito", "pos_local1", "pos_local2", "pos_online"],
    permisos: perms({ stock: "editar", ventas: "editar", facturacion: "editar", empleados: "editar", dashboard: "ver" }),
    activo: true,
    creadoEl: "2026-02-10",
  },
  {
    id: "emp_2",
    nombre: "Federico",
    apellido: "Luna",
    email: "federico.luna@stocker.local",
    telefono: "1133445566",
    rol: "Vendedor",
    posIds: ["pos_local1"],
    permisos: perms({ stock: "ver", ventas: "editar", facturacion: "ver" }),
    activo: true,
    creadoEl: "2026-03-02",
  },
  {
    id: "emp_3",
    nombre: "Camila",
    apellido: "Rearte",
    email: "camila.rearte@stocker.local",
    telefono: "1144556677",
    rol: "Vendedor",
    posIds: ["pos_local2"],
    permisos: perms({ stock: "ver", ventas: "editar" }),
    activo: true,
    creadoEl: "2026-03-18",
  },
  {
    id: "emp_4",
    nombre: "Nahuel",
    apellido: "Peralta",
    email: "nahuel.peralta@stocker.local",
    telefono: "1155667788",
    rol: "Depósito",
    posIds: ["pos_deposito"],
    permisos: perms({ stock: "editar" }),
    activo: true,
    creadoEl: "2026-04-05",
  },
  {
    id: "emp_5",
    nombre: "Yamila",
    apellido: "Godoy",
    email: "yamila.godoy@stocker.local",
    telefono: "1166778899",
    rol: "Cajero",
    posIds: ["pos_online"],
    permisos: perms({ ventas: "editar", facturacion: "editar" }),
    activo: false,
    creadoEl: "2026-05-01",
  },
];
