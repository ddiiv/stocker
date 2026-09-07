/*
 * Aplica el tema ANTES de que React pinte.
 *
 * Va en un archivo aparte y no como script embebido en el HTML por la Política
 * de Seguridad de Contenido: permitir scripts embebidos obliga a poner
 * 'unsafe-inline' en script-src, que es exactamente el permiso que convierte
 * cualquier inyección de HTML en ejecución de código. Un archivo con `src`
 * propio no necesita ese permiso.
 *
 * Sigue siendo bloqueante y está en el <head>, así que corre antes del primer
 * pixel: sin esto, en modo oscuro cada recarga arranca con un flash blanco a
 * pantalla completa.
 */
(function () {
  try {
    var guardado = localStorage.getItem('stocker:tema');
    var oscuro = guardado === 'oscuro'
      || (!guardado && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', oscuro ? 'dark' : 'light');
    document.documentElement.style.colorScheme = oscuro ? 'dark' : 'light';
  } catch (e) {
    /* Sin localStorage —ventana privada, cookies bloqueadas— se queda en claro. */
  }
})();
