import { useCallback, useEffect, useRef, useState } from "react";

/*
 * Captura lecturas de un lector de código de barras.
 *
 * Los lectores se comportan como un teclado: "tipean" el código muy rápido y
 * marcan el final de la lectura. El problema es que cada modelo lo marca
 * distinto — unos mandan Enter, otros Tab, y algunos no mandan nada — y suele
 * ser configurable desde el propio lector. Por eso se contemplan las tres:
 *
 *   · Enter o Tab → se emite la lectura en el momento.
 *   · Sin terminador → se emite tras `finLecturaMs` sin teclas nuevas.
 *   · Pegado (algunos trabajan en modo portapapeles) → se emite el texto.
 *
 * La velocidad es lo que distingue al lector de una persona: si entre teclas
 * pasan más de `maxIntervaloMs` se descarta el buffer y se arranca de nuevo.
 * Como consecuencia, tipear a mano nunca dispara una lectura — para eso está
 * el formulario de carga manual de cada pantalla.
 *
 * Escucha a nivel documento, así el operador no necesita hacer foco en ningún
 * campo: apunta, gatilla y listo. No hay que "activar" nada.
 */
export function useBarcodeScanner({
  onScan,
  activo = true,
  minLargo = 3,
  maxIntervaloMs = 50,
  finLecturaMs = 120,
  ventanaActividadMs = 10000,
  /*
   * Enfriamiento entre lecturas del MISMO código.
   *
   * Un lector apoyado sobre la etiqueta dispara varias veces por segundo, y
   * algunos mandan la lectura dos veces por configuración. Sin esto, pasar una
   * prenda sumaba tres unidades al carrito, y cada lectura además pegaba un
   * pedido al servidor: el mostrador terminaba corrigiendo cantidades a mano.
   *
   * Se enfría por CÓDIGO y no en general: escanear dos prendas distintas
   * seguidas es lo normal y frenar eso sería peor que el problema. Escanear la
   * misma dos veces a propósito —dos unidades iguales— pide medio segundo de
   * espera, o el botón + de la línea, que es más rápido.
   */
  enfriamientoMs = 500,
} = {}) {
  const buffer = useRef("");
  const ultimaTecla = useRef(0);
  const timerFin = useRef(null);
  const timerActividad = useRef(null);
  // Último código emitido y cuándo, para el enfriamiento.
  const ultimaEmision = useRef({ codigo: "", en: 0 });

  const [ultimoCodigo, setUltimoCodigo] = useState("");
  const [scannerActivo, setScannerActivo] = useState(false);
  const [lecturas, setLecturas] = useState(0);

  // El callback vive en una ref para no re-suscribir el listener en cada
  // render: si se re-suscribiera, se perdería el buffer a mitad de una lectura.
  const onScanRef = useRef(onScan);
  useEffect(() => { onScanRef.current = onScan; }, [onScan]);

  const marcarActividad = useCallback(() => {
    setScannerActivo(true);
    clearTimeout(timerActividad.current);
    timerActividad.current = setTimeout(() => setScannerActivo(false), ventanaActividadMs);
  }, [ventanaActividadMs]);

  useEffect(() => {
    if (!activo) return;

    // Punto único de emisión: lo llaman los tres caminos (Enter/Tab, silencio
    // y pegado) para que la lógica de validación no se duplique.
    function emitir(codigo, limpiarInput) {
      clearTimeout(timerFin.current);
      buffer.current = "";
      const limpio = String(codigo || "").trim();
      if (limpio.length < minLargo) return false;

      /*
       * La misma lectura, dos veces seguidas, es una sola.
       *
       * Se limpia el input igual y se cuenta como actividad: para quien está
       * gatillando, el lector "anduvo". Lo único que no pasa es el segundo
       * pedido al servidor.
       */
      const ahora = Date.now();
      if (ultimaEmision.current.codigo === limpio
        && ahora - ultimaEmision.current.en < enfriamientoMs) {
        if (limpiarInput) limpiarInput.value = "";
        marcarActividad();
        return false;
      }
      ultimaEmision.current = { codigo: limpio, en: ahora };

      if (limpiarInput) limpiarInput.value = "";
      setUltimoCodigo(limpio);
      setLecturas((n) => n + 1);
      marcarActividad();
      onScanRef.current?.(limpio);
      return true;
    }

    function handleKeyDown(e) {
      // No interferir mientras escriben en un campo normal, salvo que sea el
      // input dedicado al escaneo (data-scanner).
      const target = e.target;
      const enCampo = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      const esInputDeScanner = Boolean(target?.dataset?.scanner);
      if (enCampo && !esInputDeScanner) return;

      const ahora = Date.now();
      if (ahora - ultimaTecla.current > maxIntervaloMs) buffer.current = "";
      ultimaTecla.current = ahora;

      // Terminadores. Tab es el que usan muchos lectores por defecto; sin
      // preventDefault el foco saltaría al siguiente campo en cada lectura.
      if (e.key === "Enter" || e.key === "Tab") {
        const codigo = buffer.current;
        if (emitir(codigo, esInputDeScanner ? target : null)) e.preventDefault();
        return;
      }

      // Sólo caracteres imprimibles sueltos (ignora Shift, flechas, F1…)
      if (e.key.length === 1) {
        buffer.current += e.key;

        // Red de seguridad para lectores sin terminador: si no llega ninguna
        // tecla más, se cierra la lectura sola.
        clearTimeout(timerFin.current);
        const capturado = target;
        timerFin.current = setTimeout(() => {
          emitir(buffer.current, esInputDeScanner ? capturado : null);
        }, finLecturaMs);
      }
    }

    // Algunos lectores se configuran para pegar el código en vez de tipearlo.
    function handlePaste(e) {
      const target = e.target;
      const enCampo = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      const esInputDeScanner = Boolean(target?.dataset?.scanner);
      if (enCampo && !esInputDeScanner) return;

      const texto = (e.clipboardData || window.clipboardData)?.getData("text") || "";
      // Un código es una sola línea sin espacios; si trae otra cosa es un
      // pegado normal del usuario y no hay que tocarlo.
      const limpio = texto.trim();
      if (!limpio || /\s/.test(limpio)) return;
      if (emitir(limpio, esInputDeScanner ? target : null)) e.preventDefault();
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("paste", handlePaste);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("paste", handlePaste);
      clearTimeout(timerFin.current);
    };
  }, [activo, minLargo, maxIntervaloMs, finLecturaMs, enfriamientoMs, marcarActividad]);

  // Limpia los temporizadores al desmontar, para no dejar un setState colgado.
  useEffect(() => () => {
    clearTimeout(timerFin.current);
    clearTimeout(timerActividad.current);
  }, []);

  return { ultimoCodigo, scannerActivo, lecturas };
}
