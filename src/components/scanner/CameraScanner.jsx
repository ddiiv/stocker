import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CameraOff, SwitchCamera, CheckCircle2 } from "lucide-react";

/*
 * Lector de códigos usando la cámara del dispositivo.
 *
 * Pensado para el depósito, donde no hay una PC con lector USB pero sí un
 * celular en el bolsillo. Se apoya en BarcodeDetector, que es nativo del
 * navegador: no hay que descargar ninguna librería de decodificación ni
 * mandar la imagen a ningún lado, el análisis pasa entero en el dispositivo.
 *
 * Dos limitaciones que conviene tener presentes, porque explican casi todos
 * los "no me anda":
 *
 *   · Requiere contexto seguro. En HTTP la cámara no se puede pedir; sólo
 *     localhost está exceptuado. En producción ya vamos por HTTPS.
 *   · BarcodeDetector hoy está en Chrome/Edge de Android y escritorio, no en
 *     Firefox ni en Safari de iOS. Cuando falta, se avisa y queda el lector
 *     USB y la carga manual, que siguen funcionando en cualquier navegador.
 *
 * Un código leído se ignora durante `repetirMs` para que sostener la cámara
 * frente a la etiqueta no cargue veinte unidades sin querer.
 */

const FORMATOS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "codabar", "qr_code"];
const REPETIR_MS = 2000;

export function camaraDisponible() {
  return typeof window !== "undefined"
    && "BarcodeDetector" in window
    && !!navigator.mediaDevices?.getUserMedia;
}

export default function CameraScanner({ onScan, activo = true }) {
  const videoRef  = useRef(null);
  const streamRef = useRef(null);
  const loopRef   = useRef(null);
  const ultimo    = useRef({ codigo: "", ts: 0 });
  const onScanRef = useRef(onScan);
  useEffect(() => { onScanRef.current = onScan; }, [onScan]);

  const [estado, setEstado]   = useState("idle"); // idle | pidiendo | leyendo | error
  const [error, setError]     = useState("");
  const [camaraTrasera, setCamaraTrasera] = useState(true);
  const [ultimaLectura, setUltimaLectura] = useState("");

  const detener = useCallback(() => {
    clearInterval(loopRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setEstado("idle");
  }, []);

  const arrancar = useCallback(async () => {
    if (!camaraDisponible()) {
      setEstado("error");
      setError("Este navegador no puede leer códigos con la cámara. Probá con Chrome en Android, o usá el lector USB.");
      return;
    }
    setEstado("pidiendo"); setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: camaraTrasera ? "environment" : "user" },
        audio: false,
      });
      streamRef.current = stream;
      if (!videoRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      videoRef.current.srcObject = stream;
      await videoRef.current.play();

      const detector = new window.BarcodeDetector({ formats: FORMATOS });
      setEstado("leyendo");

      // Un intervalo alcanza y sobra: leer 4 veces por segundo detecta al
      // instante para la mano humana y no calienta el teléfono como haría un
      // requestAnimationFrame a 60fps.
      loopRef.current = setInterval(async () => {
        const video = videoRef.current;
        if (!video || video.readyState < 2) return;
        try {
          const [codigo] = await detector.detect(video);
          if (!codigo?.rawValue) return;
          const valor = codigo.rawValue.trim();
          const ahora = Date.now();
          if (valor === ultimo.current.codigo && ahora - ultimo.current.ts < REPETIR_MS) return;
          ultimo.current = { codigo: valor, ts: ahora };
          setUltimaLectura(valor);
          navigator.vibrate?.(60);
          onScanRef.current?.(valor);
        } catch {
          // Un frame que no se pudo analizar no es un problema: viene otro.
        }
      }, 250);
    } catch (e) {
      setEstado("error");
      setError(
        e.name === "NotAllowedError"
          ? "No diste permiso para usar la cámara. Habilitalo desde el candado de la barra de direcciones."
          : e.name === "NotFoundError"
            ? "No se encontró ninguna cámara en este dispositivo."
            : "No se pudo abrir la cámara. Verificá que ninguna otra app la esté usando."
      );
    }
  }, [camaraTrasera]);

  // Al desmontar hay que soltar la cámara sí o sí: si no, el celular queda con
  // la luz del sensor prendida hasta que se cierra la pestaña.
  useEffect(() => detener, [detener]);

  // Cambiar de cámara con el lector prendido: se reinicia el stream.
  useEffect(() => {
    if (estado === "leyendo") { detener(); arrancar(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camaraTrasera]);

  const leyendo = estado === "leyendo";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={leyendo ? "btn btn-ghost" : "btn btn-primary"}
          onClick={leyendo ? detener : arrancar}
          disabled={!activo || estado === "pidiendo"}
        >
          {leyendo ? <CameraOff size={16} /> : <Camera size={16} />}
          {leyendo ? "Apagar cámara" : estado === "pidiendo" ? "Abriendo cámara…" : "Escanear con la cámara"}
        </button>
        {leyendo && (
          <button type="button" className="btn btn-ghost" onClick={() => setCamaraTrasera((v) => !v)}>
            <SwitchCamera size={16} />
            {camaraTrasera ? "Cámara frontal" : "Cámara trasera"}
          </button>
        )}
      </div>

      {error && <p className="text-sm text-brick-600">{error}</p>}

      <div className={leyendo ? "relative overflow-hidden rounded-lg bg-ink-950" : "hidden"}>
        <video ref={videoRef} playsInline muted className="aspect-[4/3] w-full object-cover" />
        {/* Guía visual: encuadrar el código dentro del recuadro. */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-1/3 w-4/5 rounded-lg border-2 border-white/70 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
        </div>
        {ultimaLectura && (
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-ink-950/80 px-3 py-2 text-sm text-white">
            <CheckCircle2 size={16} className="text-teal-300" />
            <span className="font-mono">{ultimaLectura}</span>
          </div>
        )}
      </div>

      {leyendo && (
        <p className="text-xs text-ink-500">
          Apuntá al código de barras. Se aplica el modo y la cantidad elegidos arriba en cada lectura.
        </p>
      )}
    </div>
  );
}
