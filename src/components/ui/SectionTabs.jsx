import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";

/*
 * Las pestañas de una sección.
 *
 * Stock tiene ocho y no entran en un teléfono. La tira ya se podía arrastrar,
 * pero nada lo decía: la barra de scroll está oculta a propósito —queda fea
 * cruzando la pastilla— así que las pestañas de la derecha simplemente no
 * existían para quien no probara arrastrar. Y en una notebook con mouse ni
 * siquiera hay gesto: sin barra y sin flechas no había forma de llegar.
 *
 * Tres cosas resuelven eso, y las tres son necesarias:
 *
 *   El degradado en los bordes dice que hay más. Es la única señal que se ve
 *   sin interactuar, y aparece sólo del lado donde efectivamente queda algo.
 *
 *   Las flechas dan la forma de moverse con mouse. Van de `sm` para arriba: en
 *   un teléfono se arrastra con el dedo y ahí el ancho hace falta para las
 *   pestañas, no para dos botones.
 *
 *   La pestaña activa se trae sola a la vista. Entrar a Etiquetas —la última—
 *   y ver la tira arrancando en Productos, sin nada marcado, hace pensar que
 *   la pantalla cargó mal.
 */
export default function SectionTabs({ tabs, className = "" }) {
  const cinta = useRef(null);
  const [puedeIzq, setPuedeIzq] = useState(false);
  const [puedeDer, setPuedeDer] = useState(false);
  const { pathname } = useLocation();

  /* De qué lado queda algo por ver. El margen de 1px es por los anchos
     fraccionarios: sin él el degradado parpadea al final del recorrido. */
  const medir = useCallback(() => {
    const el = cinta.current;
    if (!el) return;
    setPuedeIzq(el.scrollLeft > 1);
    setPuedeDer(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  /*
   * Traer la activa a la vista.
   *
   * Se mueve `scrollLeft` a mano en vez de usar scrollIntoView: ese arrastra
   * también el scroll vertical de la página y da un salto al entrar a la
   * sección.
   */
  const centrarActiva = useCallback(() => {
    const el = cinta.current;
    const activa = el?.querySelector("[aria-current='page']");
    if (!el || !activa || !el.clientWidth) return;

    const margen = 12;
    const izqTab = activa.offsetLeft;
    const derTab = izqTab + activa.offsetWidth;

    /*
     * Sin animación, a propósito.
     *
     * Esto corre al entrar a la pantalla: la pestaña tiene que estar donde
     * corresponde desde el primer cuadro. Animarla hace que la tira se deslice
     * sola apenas aparece la página, que se lee como un defecto y no como una
     * ayuda. El deslizamiento suave queda para las flechas, donde el
     * movimiento es respuesta a un clic.
     */
    if (izqTab < el.scrollLeft + margen) {
      el.scrollLeft = Math.max(0, izqTab - margen);
    } else if (derTab > el.scrollLeft + el.clientWidth - margen) {
      el.scrollLeft = derTab - el.clientWidth + margen;
    }
  }, []);

  /*
   * Se centra una sola vez por pestaña, y recién cuando la tira mide de verdad.
   *
   * Al montar, la tipografía todavía no cargó: las pestañas miden menos, entran
   * todas y no hay nada que centrar. Cuando la fuente llega y se ensanchan, un
   * efecto atado sólo a la ruta ya corrió, y la activa queda fuera de vista —
   * que es exactamente lo que pasaba al entrar directo a Etiquetas. Por eso el
   * que centra es el ResizeObserver, y el candado se cierra sólo cuando hubo
   * desborde real.
   *
   * El candado además evita pelearle al usuario: una vez centrada, arrastrar la
   * tira no la devuelve a su lugar.
   */
  const centradaEn = useRef(null);
  useEffect(() => { centradaEn.current = null; }, [pathname]);

  const ajustar = useCallback(() => {
    medir();
    const el = cinta.current;
    if (!el || centradaEn.current === pathname) return;
    centrarActiva();
    if (el.scrollWidth > el.clientWidth) centradaEn.current = pathname;
  }, [medir, centrarActiva, pathname]);

  useLayoutEffect(() => {
    const el = cinta.current;
    if (!el) return;
    ajustar();
    const ro = new ResizeObserver(ajustar);
    ro.observe(el);
    // Los hijos también: la tipografía al cargar los ensancha, y ese es el
    // momento en que aparece el desborde.
    for (const hijo of el.children) ro.observe(hijo);
    return () => ro.disconnect();
  }, [ajustar, tabs]);

  // Un salto de poco menos de una pantalla: deja una pestaña a la vista como
  // referencia de dónde estaba.
  const correr = (signo) => {
    const el = cinta.current;
    if (!el) return;
    el.scrollBy({ left: signo * Math.max(120, el.clientWidth * 0.8), behavior: "smooth" });
  };

  const flecha = "hidden shrink-0 rounded p-1 text-ink-600 transition-colors hover:bg-paper-200 hover:text-ink-950 sm:block";

  return (
    <div className={`relative mb-5 flex w-fit max-w-full items-center rounded-md border border-line bg-paper-50 p-1 ${className}`}>
      {puedeIzq && (
        <button type="button" className={flecha} onClick={() => correr(-1)} aria-label="Ver pestañas anteriores">
          <ChevronLeft size={16} />
        </button>
      )}

      <div className="relative min-w-0 flex-1">
        <div
          ref={cinta}
          onScroll={medir}
          className="flex overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              className={({ isActive }) =>
                `shrink-0 whitespace-nowrap rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                  isActive ? "bg-ink-950 text-paper-50" : "text-ink-600 hover:bg-paper-200"
                }`
              }
            >
              {t.label}
            </NavLink>
          ))}
        </div>

        {/* Los degradados no reciben clics: tapan la tira, no la bloquean. */}
        {puedeIzq && (
          <div className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-paper-50 to-transparent" />
        )}
        {puedeDer && (
          <div className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-paper-50 to-transparent" />
        )}
      </div>

      {puedeDer && (
        <button type="button" className={flecha} onClick={() => correr(1)} aria-label="Ver más pestañas">
          <ChevronRight size={16} />
        </button>
      )}
    </div>
  );
}
