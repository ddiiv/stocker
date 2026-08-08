import { useEffect, useRef, useState } from "react";

/*
 * Captura lecturas de un lector de código de barras.
 *
 * Los lectores se comportan como un teclado: "tipean" el código muy rápido y
 * mandan Enter al final. Eso permite distinguirlos de una persona escribiendo:
 * si entre teclas pasan más de `maxIntervaloMs`, asumimos que es un humano y
 * descartamos el buffer.
 *
 * Escucha a nivel documento, así el operador no necesita hacer foco en ningún
 * campo: apunta, gatilla y listo.
 */
export function useBarcodeScanner({
  onScan,
  activo = true,
  minLargo = 3,
  maxIntervaloMs = 50,
} = {}) {
  const buffer = useRef("");
  const ultimaTecla = useRef(0);
  const [ultimoCodigo, setUltimoCodigo] = useState("");
  // Guardamos el callback en una ref para no re-suscribir el listener en cada
  // render (si no, se pierde el buffer a mitad de una lectura).
  const onScanRef = useRef(onScan);
  useEffect(() => { onScanRef.current = onScan; }, [onScan]);

  useEffect(() => {
    if (!activo) return;

    function handleKeyDown(e) {
      // No interferir mientras escriben en un campo de texto normal,
      // salvo que sea el input dedicado al escaneo.
      const target = e.target;
      const enCampo = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if (enCampo && !target.dataset?.scanner) return;

      const ahora = Date.now();
      if (ahora - ultimaTecla.current > maxIntervaloMs) buffer.current = "";
      ultimaTecla.current = ahora;

      if (e.key === "Enter") {
        const codigo = buffer.current.trim();
        buffer.current = "";
        if (codigo.length >= minLargo) {
          e.preventDefault();
          setUltimoCodigo(codigo);
          onScanRef.current?.(codigo);
        }
        return;
      }

      // Solo caracteres imprimibles sueltos (ignora Shift, Tab, flechas…)
      if (e.key.length === 1) buffer.current += e.key;
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [activo, minLargo, maxIntervaloMs]);

  return { ultimoCodigo };
}
