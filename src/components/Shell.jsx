import { NavLink, Outlet } from "react-router-dom";
import { LayoutDashboard, Building2, Layers, SlidersHorizontal, LogOut, Menu, Wallet, ShieldCheck, Globe, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import * as api from "../lib/api";
import { useAdmin } from "../context/AdminAuth";

const LINKS = [
  { to: "/",         label: "Panel",    icono: LayoutDashboard, exact: true },
  { to: "/cuentas",  label: "Cuentas",  icono: Building2 },
  { to: "/planes",   label: "Planes",   icono: Layers },
  { to: "/cobros",   label: "Cobros",   icono: Wallet },
  { to: "/seguridad", label: "Seguridad", icono: ShieldCheck },
  { to: "/ajustes",  label: "Página pública", icono: SlidersHorizontal },
];

export default function Shell() {
  const { admin, salir } = useAdmin();
  const [abierto, setAbierto] = useState(false);
  const [paginaPublica, setPaginaPublica] = useState(null);

  /*
   * La URL sale de la configuración del backend (LANDING_DOMAIN), no escrita
   * acá: el dominio cambia y un enlace fijo queda viejo sin que nadie lo note.
   * Si no está configurada, no se muestra el acceso.
   */
  useEffect(() => {
    api.getAjustes()
      .then((r) => setPaginaPublica(Array.isArray(r) ? null : r.paginaPublica))
      .catch(() => {});
  }, []);

  return (
    <div className="flex min-h-screen">
      {abierto && (
        <div className="fixed inset-0 z-30 bg-deep/70 md:hidden" onClick={() => setAbierto(false)} />
      )}

      <aside className={`fixed z-40 flex h-full w-56 flex-col border-r border-line bg-deep transition-transform md:static md:translate-x-0
        ${abierto ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-[4px] bg-brass font-mono text-base font-bold text-deep">
            B
          </div>
          <div className="min-w-0">
            <p className="font-mono text-xs font-bold tracking-[0.14em]">BACKOFFICE</p>
            <p className="truncate text-[11px] text-faint">Stocker</p>
          </div>
        </div>

        <nav className="flex-1 space-y-0.5 p-2">
          {LINKS.map(({ to, label, icono: Icono, exact }) => (
            <NavLink
              key={to} to={to} end={exact}
              onClick={() => setAbierto(false)}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-[3px] px-3 py-2 text-sm transition-colors ${
                  isActive ? "bg-surface2 text-brass" : "text-dim hover:bg-surface hover:text-text"
                }`}
            >
              <Icono size={16} /> {label}
            </NavLink>
          ))}
        </nav>

        {/* Acceso a la página pública, separado del menú: no es una sección del
            panel, es salir a ver lo que ve un visitante. */}
        {paginaPublica && (
          <a
            href={paginaPublica}
            target="_blank" rel="noopener noreferrer"
            className="mx-2 mb-2 flex items-center gap-2.5 rounded-[3px] px-3 py-2 text-sm text-dim transition-colors hover:bg-surface hover:text-brass"
          >
            <Globe size={16} /> Ver la página
            <ExternalLink size={11} className="ml-auto opacity-60" />
          </a>
        )}

        <div className="border-t border-line p-3">
          <p className="truncate text-sm text-text">{admin?.nombre}</p>
          {/* El rol define qué botones aparecen; el backend lo vuelve a
              chequear igual, esto sólo evita ofrecer lo que va a fallar. */}
          <p className="font-mono text-[11px] uppercase tracking-wider text-faint">{admin?.rol}</p>
          <button onClick={salir} className="btn-ghost btn-sm mt-3 w-full">
            <LogOut size={13} /> Salir
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-line px-4 py-3 md:hidden">
          <button onClick={() => setAbierto(true)} className="text-dim" aria-label="Menú">
            <Menu size={20} />
          </button>
          <span className="font-mono text-sm font-bold tracking-[0.14em]">BACKOFFICE</span>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8">
          <div className="mx-auto max-w-6xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
