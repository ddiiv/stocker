import { useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Clock } from "lucide-react";
import Sidebar from "./Sidebar";
import Topbar from "./Topbar";
import { useAuth } from "../../context/AuthContext";

/*
 * El título de la barra superior, por ruta.
 *
 * Están TODAS las rutas, una por una. Antes había seis y el resto caía en
 * reglas por prefijo: cualquier cosa bajo /stock/ se anunciaba como "Detalle
 * de producto", así que Etiquetas, Movimientos y Escanear stock decían ser una
 * ficha de producto, y el punto de venta —/ventas/pos— decía "Detalle de
 * venta". Las que no entraban en ningún prefijo mostraban "Stocker", que no
 * dice nada.
 *
 * El orden importa: las rutas con parámetro se resuelven al final, después de
 * que fallaron todas las exactas.
 */
const TITLES = {
  "/dashboard": "Dashboard",
  "/dashboard/ventas": "Ventas en el tiempo",
  "/dashboard/productos": "Métricas por producto",
  "/dashboard/analisis": "Análisis del negocio",
  "/stock": "Stock",
  "/stock/por-local": "Stock por local",
  "/stock/variantes": "Tipos de variante",
  "/stock/sku": "Confección de SKU",
  "/stock/escanear": "Escanear stock",
  "/stock/movimientos": "Movimientos de stock",
  "/stock/a-regularizar": "Stock a regularizar",
  "/stock/packs": "Packs",
  "/stock/etiquetas": "Etiquetas",
  "/deposito": "Depósito",
  "/evento": "Evento",
  "/reposicion": "Reposición",
  "/ventas": "Ventas y cotizaciones",
  "/ventas/nueva": "Nueva venta / cotización",
  "/ventas/pos": "Punto de venta (POS)",
  "/facturacion": "Facturación",
  "/facturacion/cuits": "CUITs del negocio",
  "/clientes": "Clientes",
  "/clientes/cuentas": "Cuentas corrientes",
  "/caja": "Caja",
  "/pagos": "Métodos de pago",
  "/empleados": "Empleados",
  "/integraciones/mercadolibre": "Mercado Libre",
  "/cuenta": "Mi cuenta",
  "/cuenta/suscripcion": "Suscripción",
  "/soporte": "Soporte",
};

function titleFor(pathname) {
  if (TITLES[pathname]) return TITLES[pathname];
  if (pathname.startsWith("/facturacion/cuits/")) return "Configuración de ARCA";
  if (pathname.startsWith("/empleados/")) return "Perfil de empleado";
  if (pathname.startsWith("/ventas/")) return "Detalle de venta";
  if (pathname.startsWith("/stock/")) return "Detalle de producto";
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
