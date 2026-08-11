import { useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Clock } from "lucide-react";
import Sidebar from "./Sidebar";
import Topbar from "./Topbar";
import { useAuth } from "../../context/AuthContext";

const TITLES = {
  "/dashboard": "Dashboard",
  "/stock": "Stock",
  "/ventas": "Ventas y cotizaciones",
  "/ventas/nueva": "Nueva venta / cotización",
  "/facturacion": "Facturación",
  "/empleados": "Empleados",
};

function titleFor(pathname) {
  if (TITLES[pathname]) return TITLES[pathname];
  if (pathname.startsWith("/stock/")) return "Detalle de producto";
  if (pathname.startsWith("/empleados/")) return "Perfil de empleado";
  if (pathname.startsWith("/ventas/")) return "Detalle de venta";
  return "Stocker";
}

export default function AppLayout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();
  const { avisoInactividad } = useAuth();

  return (
    <div className="flex h-screen overflow-hidden bg-paper-100">
      <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Aviso previo al cierre por inactividad: cualquier tecla o clic lo cancela. */}
        {avisoInactividad && (
          <div className="flex items-center justify-center gap-2 bg-brass-500 px-4 py-2 text-sm font-medium text-ink-950">
            <Clock size={15} />
            Tu sesión se va a cerrar por inactividad. Movés el mouse o tocás una tecla y seguís.
          </div>
        )}
        <Topbar title={titleFor(pathname)} onMenuClick={() => setMenuOpen(true)} />
        <main className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
