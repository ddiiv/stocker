import { useEffect, useRef } from "react";

const SELECTOR_FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/*
 * Lo que necesita cualquier overlay que tapa la pantalla entera —modal,
 * escáner de cámara— para no ser una trampa de teclado: Escape cierra, Tab no
 * se escapa a lo que quedó tapado atrás, el foco entra solo al abrir y vuelve
 * a quien lo abrió al cerrar.
 *
 * Un solo lugar para esto: repetido en cada overlay, el día que se corrige un
 * caso (por ejemplo, restaurar el foco también si el componente se desmonta
 * en vez de cerrarse) hay que acordarse de tocarlo en todos.
 */
export function useOverlayKeyboard(contenedorRef, { activo, onCerrar, bloquearScroll = false }) {
  const previoRef = useRef(null);

  useEffect(() => {
    if (!activo) return undefined;

    previoRef.current = document.activeElement;
    const primero = contenedorRef.current?.querySelector(SELECTOR_FOCUSABLE);
    (primero || contenedorRef.current)?.focus();

    const overflowPrevio = document.body.style.overflow;
    if (bloquearScroll) document.body.style.overflow = "hidden";

    function onKey(e) {
      if (e.key === "Escape") {
        onCerrar?.();
        return;
      }
      if (e.key === "Tab" && contenedorRef.current) {
        const focusables = contenedorRef.current.querySelectorAll(SELECTOR_FOCUSABLE);
        if (!focusables.length) return;
        const primeroF = focusables[0];
        const ultimo = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === primeroF) {
          e.preventDefault();
          ultimo.focus();
        } else if (!e.shiftKey && document.activeElement === ultimo) {
          e.preventDefault();
          primeroF.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("keydown", onKey);
      if (bloquearScroll) document.body.style.overflow = overflowPrevio;
      previoRef.current?.focus?.();
    };
  }, [activo, onCerrar, bloquearScroll, contenedorRef]);
}
