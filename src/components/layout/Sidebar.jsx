import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Boxes,
  ShoppingCart,
  ScanLine,
  Wallet,
  UserCircle2,
  Receipt,
  Truck,
  PackageCheck,
  Warehouse,
  Tent,
  Users,
  CreditCard,
  Store,
  BadgeCheck,
  LifeBuoy,
  Tag,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { canView, esAdministradorTotal } from "../../utils/permissions";

/*
 * El menú, agrupado y en el orden en que se trabaja.
 *
 * Son quince secciones. En una lista plana hay que leer las quince para saber
 * dónde está lo que se busca; con los grupos alcanza con leer cinco títulos y
 * después mirar dos o tres renglones. Los grupos NO alteran el orden: son
 * carteles puestos sobre la misma secuencia, de arriba hacia abajo.
 *
 * `activo` va sólo donde el prefijo no alcanza. Si no se aclara, una sección
 * se prende también en sus subpáginas —/stock/movimientos prende Stock, que es
 * lo que se quiere—, pero el punto de venta cuelga de /ventas y sin la
 * excepción se prendían las dos opciones al mismo tiempo.
 */
const GRUPOS = [
  {
    titulo: null,
    items: [
      { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard, permission: "dashboard" },
      { to: "/stock",     label: "Stock",     icon: Boxes,           permission: "stock" },
    ],
  },
  {
    titulo: "Vender",
    items: [
      {
        to: "/ventas",
        label: "Ventas y cotizaciones",
        icon: ShoppingCart,
        permission: "ventas",
        activo: (p) => (p === "/ventas" || p.startsWith("/ventas/")) && p !== "/ventas/pos",
      },
      { to: "/ventas/pos",  label: "Punto de venta (POS)", icon: ScanLine,    permission: "ventas" },
      { to: "/caja",        label: "Caja",                 icon: Wallet,      permission: "caja" },
      { to: "/clientes",    label: "Clientes",             icon: UserCircle2, permission: "clientes" },
      { to: "/facturacion", label: "Facturación",          icon: Receipt,     permission: "facturacion" },
    ],
  },
  {
    titulo: "Mercadería",
    items: [
      { to: "/reposicion", label: "Reposición", icon: Truck,     permission: "reposicion" },
      { to: "/deposito",   label: "Depósito",   icon: Warehouse, permission: "deposito" },
      // Va con Mercadería y no con Ventas: lo mira quien arma paquetes en el
      // depósito, no quien atiende el mostrador.
      { to: "/envios",     label: "Envíos del día", icon: PackageCheck, permission: "stock" },
      { to: "/evento",     label: "Evento",     icon: Tent,      permission: "stock" },
    ],
  },
  {
    titulo: "Configuración",
    items: [
      { to: "/empleados", label: "Empleados",       icon: Users,      permission: "empleados" },
      { to: "/pagos",     label: "Métodos de pago", icon: CreditCard, permission: "pagos" },
      { to: "/integraciones/mercadolibre", label: "Mercado Libre", icon: Store, permission: "integraciones" },
    ],
  },
  {
    titulo: "Cuenta",
    items: [
      // La suscripción es del titular de la cuenta: un empleado no decide qué
      // plan paga el negocio, así que se filtra por dueño y no por permiso.
      { to: "/cuenta/suscripcion", label: "Suscripción", icon: BadgeCheck, soloDuenio: true },
      // Soporte va para todos y sin permiso: el que se topa con el problema
      // suele ser quien está atendiendo, y hacerle pedir permiso para avisarlo
      // no tiene sentido.
      { to: "/soporte", label: "Soporte", icon: LifeBuoy, siempre: true },
    ],
  },
];

export default function Sidebar({ open, onClose }) {
  const { user } = useAuth();
  const { pathname } = useLocation();

  // La sesión del empleado no trae `employeeId` sino `id` y `type: "employee"`,
  // así que preguntar por `employeeId` daba dueño siempre y todos veían el link
  // de Suscripción, que después les respondía 403.
  const esDuenio = esAdministradorTotal(user);
  const puedeVer = (l) =>
    l.siempre ? true : l.soloDuenio ? esDuenio : canView(user, l.permission);

  /*
   * Un grupo sin nada adentro no se dibuja.
   *
   * Un cargo con permiso sólo de ventas no tiene ninguna sección de
   * "Mercadería": dejar el título solo, sin renglones debajo, parece una parte
   * del sistema que se rompió.
   */
  const grupos = GRUPOS
    .map((g) => ({ ...g, items: g.items.filter(puedeVer) }))
    .filter((g) => g.items.length > 0);

  const estaActivo = (item) =>
    item.activo ? item.activo(pathname) : pathname === item.to || pathname.startsWith(`${item.to}/`);

  /*
   * Aviso de que la lista sigue más abajo.
   *
   * Con quince secciones el menú no entra en una notebook baja ni en un
   * teléfono apaisado, y una lista cortada al ras del borde parece terminada.
   * La sombra aparece sólo cuando queda algo por ver, y se apaga al llegar al
   * final.
   */
  const navRef = useRef(null);
  const [hayMas, setHayMas] = useState(false);
  const revisar = useCallback(() => {
    const n = navRef.current;
    if (!n) return;
    // Margen de 4px: con zoom o pantallas HiDPI el scroll queda con decimales
    // y la comparación exacta deja la sombra prendida estando ya abajo de todo.
    setHayMas(n.scrollHeight - n.scrollTop - n.clientHeight > 4);
  }, []);

  useEffect(() => {
    const n = navRef.current;
    if (!n) return;
    revisar();
    /*
     * Dos cosas cambian si hay o no más para ver: el alto de la ventana y el
     * alto de la lista. Se observan las dos —la caja del nav y su contenido—
     * porque mirar sólo una deja la sombra mintiendo en la otra mitad de los
     * casos.
     */
    const ro = new ResizeObserver(revisar);
    ro.observe(n);
    if (n.firstElementChild) ro.observe(n.firstElementChild);
    return () => ro.disconnect();
  }, [revisar, grupos.length]);

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-30 bg-ink-950/40 md:hidden" onClick={onClose} />
      )}
      <aside
        aria-label="Menú principal"
        /*
         * `h-dvh` y no `h-full`: en el teléfono la barra del navegador aparece
         * y desaparece, y con `100%` el menú quedaba más alto que la pantalla,
         * dejando las últimas secciones abajo del borde sin forma de llegar.
         * En escritorio manda el alto del contenedor, que ya es la pantalla.
         *
         * `invisible` cuando está cerrado saca los quince links del tabulador:
         * corridos fuera de pantalla se seguían pudiendo enfocar a ciegas.
         */
        className={`fixed z-40 flex h-dvh w-64 flex-col bg-ink-950 text-paper-50 transition-transform md:static md:h-full md:visible md:translate-x-0
        ${open ? "translate-x-0" : "invisible -translate-x-full"}`}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-5 py-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-brass-500 text-ink-950">
            <Tag size={16} strokeWidth={2.5} />
          </div>
          <div>
            <p className="font-display text-sm font-semibold leading-none">Stocker</p>
            <p className="mt-1 text-[11px] text-ink-400">Panel de gestión</p>
          </div>
        </div>

        {/* `min-h-0` es lo que permite que el nav se achique y muestre barra:
            sin eso un hijo flex nunca baja del alto de su contenido y la lista
            se desborda en vez de scrollear. */}
        <div className="relative min-h-0 flex-1">
          <nav
            ref={navRef}
            onScroll={revisar}
            aria-label="Secciones"
            className="h-full overflow-y-auto overscroll-contain px-3 py-4 [scrollbar-color:rgba(255,255,255,0.22)_transparent] [scrollbar-width:thin]"
          >
            <div className="space-y-4">
              {grupos.map((g) => (
                <div key={g.titulo || "principal"}>
                  {g.titulo && (
                    <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
                      {g.titulo}
                    </p>
                  )}
                  <div className="space-y-1">
                    {g.items.map(({ to, label, icon: Icon, ...item }) => {
                      const activo = estaActivo({ to, ...item });
                      return (
                        <Link
                          key={to}
                          to={to}
                          onClick={onClose}
                          aria-current={activo ? "page" : undefined}
                          className={`flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors ${
                            activo
                              ? "bg-brass-500 text-ink-950"
                              : "text-paper-100/80 hover:bg-white/5 hover:text-paper-50"
                          }`}
                        >
                          <Icon size={17} strokeWidth={2} className="shrink-0" />
                          {label}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </nav>

          {hayMas && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-ink-950 via-ink-950/85 to-transparent" />
          )}
        </div>
      </aside>
    </>
  );
}
