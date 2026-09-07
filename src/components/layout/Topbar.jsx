import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Menu, LogOut, UserCog, Sun, Moon } from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { initials } from "../../utils/formatters";
import { temaEfectivo, elegirTema, seguirAlSistema } from "../../utils/tema";

export default function Topbar({ title, onMenuClick }) {
  const { user, negocio: datosNegocio, logout } = useAuth();

  // El dueño trae su nombre en ownerNombre; el empleado, en nombre.
  const nombre   = user?.ownerNombre   || user?.nombre   || "";
  const apellido = user?.ownerApellido || user?.apellido || "";
  // El nombre del negocio viene del contexto y ya no depende del rol: antes lo
  // tenía sólo el dueño y a los empleados les aparecía "Mi negocio".
  const negocio  = datosNegocio?.nombreNegocio || user?.nombreNegocio || "Mi negocio";
  // Al empleado le sirve ver en qué local está parado.
  const subtitulo = user?.type === "employee" && user?.local?.nombre
    ? `${nombre} ${apellido} · ${user.local.nombre}`
    : `${nombre} ${apellido}`;

  return (
    <header className="sticky top-0 z-20 flex items-center justify-between border-b border-line bg-paper-50/90 px-4 py-3 backdrop-blur md:px-8">
      <div className="flex items-center gap-3">
        {/* En un teléfono este botón es la ÚNICA forma de llegar a la
            navegación, y sin nombre un lector de pantalla lo anuncia como
            "botón" a secas. */}
        <button
          type="button"
          className="rounded-md p-1.5 text-ink-700 hover:bg-paper-200 md:hidden"
          onClick={onMenuClick}
          aria-label="Abrir el menú de secciones"
          title="Menú"
        >
          <Menu size={20} />
        </button>
        <h1 className="font-display text-lg font-semibold text-ink-950 md:text-xl">{title}</h1>
      </div>
      <div className="flex items-center gap-3">
        <BotonTema />
        <div className="hidden text-right sm:block">
          <p className="text-sm font-medium leading-none text-ink-900">{negocio}</p>
          <p className="mt-1 text-xs text-ink-400">{subtitulo}</p>
        </div>
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-ink-950 text-xs font-semibold text-paper-50">
          {initials(nombre, apellido)}
        </div>
        {user?.type === "business" && (
          <Link to="/cuenta" className="rounded-md p-2 text-ink-600 hover:bg-paper-200" title="Mi cuenta">
            <UserCog size={17} />
          </Link>
        )}
        <button onClick={logout} className="rounded-md p-2 text-ink-600 hover:bg-paper-200 hover:text-brick-500" title="Cerrar sesión">
          <LogOut size={17} />
        </button>
      </div>
    </header>
  );
}

/*
 * Claro / oscuro, a un clic.
 *
 * Va en la barra de arriba y no adentro de Configuración porque no es un ajuste
 * que se toca una vez: en un local cambia la luz a lo largo del día, y quien
 * está seis horas frente a la pantalla lo cambia cuando le molesta, no cuando
 * se acuerda de ir a buscarlo.
 *
 * Antes de que alguien toque el botón, Stocker sigue al sistema: quien tiene el
 * celular en oscuro lo abre en oscuro sin elegir nada. El primer clic fija una
 * preferencia y a partir de ahí manda ésa.
 */
function BotonTema() {
  const [tema, setTema] = useState(() => temaEfectivo());

  useEffect(() => seguirAlSistema(setTema), []);

  function alternar() {
    const nuevo = tema === "oscuro" ? "claro" : "oscuro";
    elegirTema(nuevo);
    setTema(nuevo);
  }

  const esOscuro = tema === "oscuro";
  return (
    <button
      type="button"
      onClick={alternar}
      className="rounded-md p-2 text-ink-600 transition-colors hover:bg-paper-200 hover:text-ink-900"
      /*
       * El nombre dice a qué se va a cambiar, no en cuál se está: es lo que
       * pasa al tocarlo, que es lo único que se pregunta quien lo mira.
       */
      aria-label={esOscuro ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
      title={esOscuro ? "Modo claro" : "Modo oscuro"}
    >
      {esOscuro ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}
