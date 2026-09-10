import { useEffect, useRef } from "react";

const SELECTOR_FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/*
 * Los focusables que además están a la vista.
 *
 * `querySelectorAll` también trae los que están ocultos —una sección plegada,
 * un campo con `hidden`—, y `focus()` sobre uno de ésos no hace nada: el Tab
 * se queda clavado sin que se vea por qué.
 */
function focusablesVisibles(contenedor) {
  return Array.from(contenedor.querySelectorAll(SELECTOR_FOCUSABLE))
    .filter((el) => el.getClientRects().length > 0);
}

/*
 * Lo que necesita cualquier overlay que tapa la pantalla entera —modal,
 * escáner de cámara— para no ser una trampa de teclado: Escape cierra, Tab no
 * se escapa a lo que quedó tapado atrás, el foco entra solo al abrir y vuelve
 * a quien lo abrió al cerrar.
 *
 * Un solo lugar para esto: repetido en cada overlay, el día que se corrige un
 * caso hay que acordarse de tocarlo en todos.
 *
 * ── Por qué `onCerrar` va por referencia y NO en las dependencias ──
 *
 * Casi todos los usos pasan una flecha nueva en cada render
 * (`onClose={() => setAbierto(false)}`). Si el efecto depende de su identidad,
 * se desmonta y se vuelve a montar en CADA render: al desmontarse devuelve el
 * foco a quien abrió, y al montarse lo mete de nuevo en el overlay. Como cada
 * tecla en un campo re-renderiza al padre, el resultado medido era que se
 * podía escribir UNA sola letra y el foco saltaba al botón de cerrar. La
 * referencia mantiene el handler siempre fresco sin re-disparar el efecto.
 *
 * `trampaDeTab` se puede apagar para lo que tapa la pantalla sólo a veces: el
 * cajón lateral del teléfono es modal con su fondo oscuro, pero en escritorio
 * el mismo componente es una columna fija al lado del contenido, y ahí
 * encerrar el Tab dejaría el resto de la página inalcanzable.
 */
export function useOverlayKeyboard(
  contenedorRef,
  { activo, onCerrar, bloquearScroll = false, trampaDeTab = true },
) {
  const previoRef = useRef(null);
  const cerrarRef = useRef(onCerrar);
  cerrarRef.current = onCerrar;

  useEffect(() => {
    if (!activo) return undefined;
    const contenedor = contenedorRef.current;

    previoRef.current = document.activeElement;

    /*
     * Entra el foco al panel, no al primer focusable.
     *
     * El primero suele ser la "X" de cerrar, y dejar el foco ahí invita a
     * cerrar sin querer con Enter o Espacio. Parado en el panel —que lleva
     * `tabIndex={-1}` y `aria-labelledby`— el lector de pantalla anuncia el
     * título del diálogo, y el primer Tab recién lleva al primer control.
     */
    if (contenedor) {
      if (typeof contenedor.focus === "function") contenedor.focus();
      if (!contenedor.contains(document.activeElement)) focusablesVisibles(contenedor)[0]?.focus();
    }

    const overflowPrevio = document.body.style.overflow;
    if (bloquearScroll) document.body.style.overflow = "hidden";

    function onKey(e) {
      if (e.key === "Escape") {
        cerrarRef.current?.();
        return;
      }
      if (!trampaDeTab || e.key !== "Tab" || !contenedorRef.current) return;
      const focusables = focusablesVisibles(contenedorRef.current);
      if (!focusables.length) {
        // Sin nada que enfocar adentro, el Tab igual no puede irse atrás.
        e.preventDefault();
        return;
      }
      const primero = focusables[0];
      const ultimo = focusables[focusables.length - 1];
      const activoAhora = document.activeElement;
      if (e.shiftKey && (activoAhora === primero || activoAhora === contenedorRef.current)) {
        e.preventDefault();
        ultimo.focus();
      } else if (!e.shiftKey && activoAhora === ultimo) {
        e.preventDefault();
        primero.focus();
      }
    }
    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("keydown", onKey);
      if (bloquearScroll) document.body.style.overflow = overflowPrevio;

      /*
       * Devolver el foco sólo si al cerrar seguía adentro del overlay.
       *
       * Si el usuario ya se había ido a otra parte de la página, mandarle el
       * foco de vuelta al botón que abrió el modal es arrancarle el teclado de
       * las manos.
       */
      const activoAlCerrar = document.activeElement;
      const seguiaAdentro = !activoAlCerrar
        || activoAlCerrar === document.body
        || contenedor?.contains(activoAlCerrar);
      if (seguiaAdentro && previoRef.current?.isConnected) previoRef.current.focus?.();
    };
  }, [activo, bloquearScroll, trampaDeTab, contenedorRef]);
}
