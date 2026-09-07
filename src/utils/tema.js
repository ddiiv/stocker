/*
 * Modo claro y modo oscuro.
 *
 * ── Cómo funciona ─────────────────────────────────────────────────
 *
 * Los colores viven en variables CSS (`--color-ink-900`, `--color-paper-50`…)
 * y Tailwind genera cada utilidad apuntando a esas variables. Así que cambiar
 * de tema es redefinir las variables, no reescribir los componentes: ni una
 * clase de las que ya están escritas cambia.
 *
 * Eso funciona porque la paleta está armada por ROL y no por color: `paper` es
 * "superficie" e `ink` es "texto y superficie fuerte". En claro paper es casi
 * blanco e ink casi negro; en oscuro se dan vuelta, y `bg-paper-50 text-ink-900`
 * sigue queriendo decir lo mismo en los dos.
 *
 * ── Los tres estados ──────────────────────────────────────────────
 *
 * "sistema" es el estado inicial y no es lo mismo que claro: quien tiene el
 * celular en oscuro espera abrir Stocker en oscuro sin elegir nada. Recién
 * cuando alguien toca el botón se guarda una preferencia, y a partir de ahí
 * manda esa aunque el sistema cambie.
 */

const CLAVE = "stocker:tema";

/** Lo que eligió la persona, o null si nunca eligió. */
export function temaGuardado() {
  try {
    const v = localStorage.getItem(CLAVE);
    return v === "claro" || v === "oscuro" ? v : null;
  } catch {
    // Ventana privada o cookies bloqueadas: se sigue con el del sistema.
    return null;
  }
}

/** Lo que dice el sistema operativo. */
export function temaDelSistema() {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "oscuro" : "claro";
  } catch {
    return "claro";
  }
}

/** El que corresponde ahora: el elegido si hay, si no el del sistema. */
export function temaEfectivo() {
  return temaGuardado() || temaDelSistema();
}

/*
 * Se escribe en el <html> y no en el <body>.
 *
 * El fondo de la página lo pinta el elemento raíz: puesto en el body, al
 * scrollear más allá del contenido aparece una franja blanca abajo en modo
 * oscuro. Y `color-scheme` tiene que ir ahí para que el navegador pinte de
 * oscuro lo que dibuja él —el selector de fecha, las casillas, la barra de
 * scroll—, que si no quedan blancas en medio de una pantalla oscura.
 */
export function aplicarTema(tema) {
  const raiz = document.documentElement;
  raiz.setAttribute("data-theme", tema === "oscuro" ? "dark" : "light");
  raiz.style.colorScheme = tema === "oscuro" ? "dark" : "light";
}

/** Guarda la elección y la aplica. */
export function elegirTema(tema) {
  try { localStorage.setItem(CLAVE, tema); } catch { /* se aplica igual */ }
  aplicarTema(tema);
}

/*
 * Sigue al sistema mientras nadie haya elegido.
 *
 * Sin esto, alguien que tiene el celular en automático ve Stocker en claro a
 * las nueve de la noche hasta que recarga la página.
 */
export function seguirAlSistema(alCambiar) {
  try {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (temaGuardado()) return;   // eligió: manda su elección
      const t = temaDelSistema();
      aplicarTema(t);
      alCambiar?.(t);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  } catch {
    return () => {};
  }
}
