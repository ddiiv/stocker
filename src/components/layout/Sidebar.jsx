import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Boxes,
  ShoppingCart,
  Receipt,
  Users,
  Tag,
  UserCircle2,
  Store,
  Tent,
  ScanLine,
  Wallet,
  CreditCard,
  BadgeCheck,
  Warehouse,
  Truck,
  LifeBuoy,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { canView, esAdministradorTotal } from "../../utils/permissions";

const ALL_LINKS = [
  { to: "/dashboard",   label: "Dashboard",             icon: LayoutDashboard, permission: "dashboard" },
  { to: "/stock",       label: "Stock",                 icon: Boxes,           permission: "stock" },
  { to: "/deposito",    label: "Depósito",              icon: Warehouse,       permission: "deposito" },
  { to: "/feria",       label: "Feria",                 icon: Tent,            permission: "stock" },
  { to: "/reposicion",  label: "Reposición",            icon: Truck,           permission: "reposicion" },
  { to: "/ventas/pos",  label: "Punto de venta",        icon: ScanLine,        permission: "ventas" },
  { to: "/ventas",      label: "Ventas y cotizaciones", icon: ShoppingCart,    permission: "ventas" },
  { to: "/facturacion", label: "Facturación",           icon: Receipt,         permission: "facturacion" },
  { to: "/clientes",    label: "Clientes",              icon: UserCircle2,     permission: "clientes" },
  { to: "/caja",        label: "Caja",                  icon: Wallet,          permission: "caja" },
  { to: "/pagos",       label: "Métodos de pago",       icon: CreditCard,      permission: "pagos" },
  { to: "/empleados",   label: "Empleados",             icon: Users,           permission: "empleados" },
  { to: "/integraciones/mercadolibre", label: "MercadoLibre", icon: Store, permission: "integraciones" },
  // La suscripción es del titular de la cuenta: un empleado no decide qué plan
  // paga el negocio, así que se filtra por dueño y no por permiso.
  { to: "/cuenta/suscripcion", label: "Suscripción", icon: BadgeCheck, soloDuenio: true },
  // Soporte va para todos y sin permiso: el que se topa con el problema suele
  // ser quien está atendiendo, y hacerle pedir permiso para avisarlo no tiene
  // sentido.
  { to: "/soporte", label: "Soporte", icon: LifeBuoy, siempre: true },
];

export default function Sidebar({ open, onClose }) {
  const { user } = useAuth();
  // La sesión del empleado no trae `employeeId` sino `id` y `type: "employee"`,
  // así que preguntar por `employeeId` daba dueño siempre y todos veían el link
  // de Suscripción, que después les respondía 403.
  const esDuenio = esAdministradorTotal(user);
  const links = ALL_LINKS.filter((l) =>
    l.siempre ? true : l.soloDuenio ? esDuenio : canView(user, l.permission));
  return (
    <>
      {open && (
        <div className="fixed inset-0 z-30 bg-ink-950/40 md:hidden" onClick={onClose} />
      )}
      <aside
        className={`fixed z-40 flex h-full w-64 flex-col bg-ink-950 text-paper-50 transition-transform md:static md:translate-x-0
        ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex items-center gap-2 border-b border-white/10 px-5 py-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-brass-500 text-ink-950">
            <Tag size={16} strokeWidth={2.5} />
          </div>
          <div>
            <p className="font-display text-sm font-semibold leading-none">Stocker</p>
            <p className="mt-1 text-[11px] text-ink-400">Panel de gestión</p>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-4">
          {links.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              onClick={onClose}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-brass-500 text-ink-950"
                    : "text-paper-100/80 hover:bg-white/5 hover:text-paper-50"
                }`
              }
            >
              <Icon size={17} strokeWidth={2} />
              {label}
            </NavLink>
          ))}
        </nav>

        
      </aside>
    </>
  );
}
