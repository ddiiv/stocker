import { useEffect, useRef } from "react";

/*
 * Cierra la sesión cuando el usuario deja de interactuar.
 *
 * El corte de verdad lo hace el backend (rechaza el token vencido); esto es
 * para que la pantalla no se quede mostrando ventas, clientes y márgenes en un
 * monitor del local mientras no hay nadie. Sin esto la sesión muere igual, pero
 * los datos siguen a la vista hasta que alguien toca algo.
 *
 * Avisa un minuto antes para que quien esté leyendo algo pueda quedarse.
 */
const EVENTOS = ["mousedown", "keydown", "touchstart", "scroll", "wheel"];
const AVISO_MS = 60 * 1000;

export function useIdleLogout({ minutos, activo, onTimeout, onAviso }) {
  // En refs para que reprogramar el temporizador no dependa de la identidad
  // de los callbacks: si no, cada render lo reiniciaría y nunca vencería.
  const cbTimeout = useRef(onTimeout);
  const cbAviso   = useRef(onAviso);
  useEffect(() => { cbTimeout.current = onTimeout; cbAviso.current = onAviso; });

  useEffect(() => {
    if (!activo || !minutos) return;
    const limite = minutos * 60 * 1000;
    let tIdle, tAviso;

    const reiniciar = () => {
      clearTimeout(tIdle);
      clearTimeout(tAviso);
      if (limite > AVISO_MS) {
        tAviso = setTimeout(() => cbAviso.current?.(Math.round(AVISO_MS / 1000)), limite - AVISO_MS);
      }
      tIdle = setTimeout(() => cbTimeout.current?.(), limite);
    };

    // Volver a la pestaña cuenta como actividad; salir no la congela, así que
    // el tiempo con la pestaña en segundo plano sigue corriendo.
    const alVolver = () => { if (document.visibilityState === "visible") reiniciar(); };

    EVENTOS.forEach((e) => window.addEventListener(e, reiniciar, { passive: true }));
    document.addEventListener("visibilitychange", alVolver);
    reiniciar();

    return () => {
      clearTimeout(tIdle);
      clearTimeout(tAviso);
      EVENTOS.forEach((e) => window.removeEventListener(e, reiniciar));
      document.removeEventListener("visibilitychange", alVolver);
    };
  }, [minutos, activo]);
}
