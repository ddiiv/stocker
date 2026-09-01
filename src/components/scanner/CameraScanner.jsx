import { useCallback, useEffect, useRef, useState } from "react";
import { SwitchCamera, Flashlight, FlashlightOff, Maximize2 } from "lucide-react";
import { recorteFuente, ajustar } from "../../utils/recorte";
import { obtenerDetector, hayNativo, camaraDisponible } from "../../utils/detectorCodigos";

/*
 * Lector de códigos con la cámara del dispositivo.
 *
 * Pensado para recorrer la tienda con el celular: no hay PC ni lector USB en el
 * pasillo, pero sí un teléfono en el bolsillo. Se apoya en BarcodeDetector, que
 * es nativo del navegador — el análisis pasa entero en el dispositivo, no se
 * sube ninguna imagen a ningún lado.
 *
 * Lo que hace distinto a este lector: SÓLO lee lo que queda dentro del
 * recuadro. El recuadro se mueve y se estira con el dedo.
 *
 * Esto no es un adorno. Una góndola tiene diez etiquetas a la vista y el
 * detector, mirando el cuadro entero, devuelve la que encuentra primero — que
 * no es la que uno está apuntando. Recortando, el empleado elige el código
 * apuntando, que es como espera que funcione. Además el recorte se analiza a la
 * resolución original: al mirar una porción chica de un cuadro grande, se leen
 * códigos más lejanos o más chicos que mirando todo.
 *
 * Dos limitaciones que explican casi todos los "no me anda":
 *
 *   · Requiere contexto seguro. En HTTP no se puede pedir la cámara; sólo
 *     localhost está exceptuado. En producción ya vamos por HTTPS.
 *   · El decodificador puede ser el nativo del navegador o uno en WebAssembly
 *     que se descarga al vuelo. De elegir uno u otro se encarga
 *     utils/detectorCodigos; acá da igual cuál tocó.
 *
 * Un código leído se ignora durante REPETIR_MS: sostener la cámara frente a la
 * etiqueta no tiene que cargar veinte unidades sin querer.
 */

/*
 * Cuánto se ignora un código ya leído, por defecto.
 *
 * La cámara mira cuatro veces por segundo y no se dispara con un gatillo: si
 * queda apoyada sobre una etiqueta, sin esto carga una unidad tras otra. Dos
 * segundos es lo que tarda una persona en pasar a la prenda siguiente.
 *
 * Quien necesite otro número lo pasa por `repetirMs`. En el mostrador, por
 * ejemplo, dos prendas iguales seguidas son de lo más común.
 */
const REPETIR_MS = 2000;
const MS_ENTRE_LECTURAS = 250;   // 4 por segundo: instantáneo para la mano, y no calienta el teléfono
const GUARDADO = "stocker.scanner.recuadro";

/*
 * Recuadro por defecto: ancho y bajo.
 *
 * Un código de barras es una tira horizontal. Un recuadro cuadrado obliga a
 * alejar el teléfono para que entre, y de lejos las barras finas se pierden.
 */
const POR_DEFECTO = { x: 0.10, y: 0.36, w: 0.80, h: 0.28 };

export { camaraDisponible };

function recuadroGuardado() {
  try {
    const g = JSON.parse(localStorage.getItem(GUARDADO));
    if (g && [g.x, g.y, g.w, g.h].every((n) => typeof n === "number" && n >= 0 && n <= 1)) return g;
  } catch { /* localStorage bloqueado o JSON viejo: se usa el de fábrica */ }
  return POR_DEFECTO;
}

export default function CameraScanner({ onScan, activo = true, onEstado, repetirMs = REPETIR_MS }) {
  const videoRef  = useRef(null);
  const contRef   = useRef(null);
  const streamRef = useRef(null);
  const lienzoRef = useRef(null);
  const loopRef   = useRef(null);
  const ultimo    = useRef({ codigo: "", ts: 0 });
  const fallos    = useRef(0);

  // onScan y activo se leen adentro del intervalo, que se arma una sola vez.
  // Sin las refs quedarían congelados en el valor del primer render.
  const onScanRef = useRef(onScan);   useEffect(() => { onScanRef.current = onScan; }, [onScan]);
  const activoRef = useRef(activo);   useEffect(() => { activoRef.current = activo; }, [activo]);
  const repetirRef = useRef(repetirMs); useEffect(() => { repetirRef.current = repetirMs; }, [repetirMs]);

  const [roi, setRoi] = useState(recuadroGuardado);
  const roiRef = useRef(roi);
  useEffect(() => { roiRef.current = roi; }, [roi]);

  const [estado, setEstado] = useState("pidiendo");   // pidiendo | bajando | leyendo | error
  const [error, setError] = useState("");
  const [trasera, setTrasera] = useState(true);
  const [linterna, setLinterna] = useState(false);
  const [tieneLinterna, setTieneLinterna] = useState(false);
  const [destello, setDestello] = useState(false);

  useEffect(() => { onEstado?.(estado, error); }, [estado, error, onEstado]);

  const detener = useCallback(() => {
    clearInterval(loopRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const arrancar = useCallback(async () => {
    if (!camaraDisponible()) {
      setEstado("error");
      setError("Este navegador no puede leer códigos con la cámara. Probá con Chrome en Android, o usá el lector USB.");
      return;
    }
    setEstado("pidiendo"); setError("");
    try {
      /*
       * El decodificador primero, la cámara después.
       *
       * En un iPhone hay que bajar un megabyte de WebAssembly, y si se pidiera
       * la cámara antes quedaría prendida —con su luz y su consumo— mirando
       * una pantalla negra durante toda la descarga.
       */
      if (!hayNativo()) setEstado("bajando");
      const detector = await obtenerDetector();

      /*
       * Se pide la mayor resolución que dé la cámara. Es lo que hace que el
       * recorte sirva: de un cuadro de 1920 una franja angosta todavía tiene
       * píxeles de sobra para resolver barras finas. De un cuadro de 640 esa
       * misma franja queda borrosa y no lee nada.
       */
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: trasera ? "environment" : "user",
          width:  { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      streamRef.current = stream;
      if (!videoRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      videoRef.current.srcObject = stream;
      await videoRef.current.play();

      const track = stream.getVideoTracks()[0];
      setTieneLinterna(!!track?.getCapabilities?.().torch);
      setLinterna(false);

      const lienzo = lienzoRef.current || (lienzoRef.current = document.createElement("canvas"));
      const ctx = lienzo.getContext("2d", { willReadFrequently: true });
      setEstado("leyendo");

      loopRef.current = setInterval(async () => {
        const video = videoRef.current;
        if (!video || video.readyState < 2 || !activoRef.current) return;

        const corte = recorteFuente({
          vw: video.videoWidth, vh: video.videoHeight,
          dw: video.clientWidth, dh: video.clientHeight,
        }, roiRef.current);
        if (!corte) return;

        // El recorte se dibuja a tamaño original: reescalar sólo perdería
        // definición, que es justo lo que necesita el detector.
        lienzo.width = corte.sw; lienzo.height = corte.sh;
        ctx.drawImage(video, corte.sx, corte.sy, corte.sw, corte.sh, 0, 0, corte.sw, corte.sh);

        try {
          const [codigo] = await detector.detect(lienzo);
          fallos.current = 0;
          if (!codigo?.rawValue) return;
          const valor = codigo.rawValue.trim();
          const ahora = Date.now();
          if (valor === ultimo.current.codigo && ahora - ultimo.current.ts < repetirRef.current) return;
          ultimo.current = { codigo: valor, ts: ahora };
          setDestello(true); setTimeout(() => setDestello(false), 220);
          navigator.vibrate?.(60);
          onScanRef.current?.(valor);
        } catch (e) {
          /*
           * Un cuadro suelto que no se pudo analizar no es un problema: viene
           * otro. Pero si fallan todos, la pantalla se ve idéntica a "todavía no
           * apunté bien" y el empleado se queda moviendo el teléfono frente a la
           * etiqueta sin que nada se lo diga.
           *
           * Diez seguidos son dos segundos y medio: bastante para descartar un
           * cuadro movido, poco para hacer perder tiempo.
           */
          if (++fallos.current >= 10) {
            clearInterval(loopRef.current);
            console.error("[escáner] el decodificador falla en todos los cuadros", e);
            setEstado("error");
            setError("El lector de códigos dejó de responder. Cerrá y volvé a abrir el escáner.");
          }
        }
      }, MS_ENTRE_LECTURAS);
    } catch (e) {
      setEstado("error");
      setError(
        e.name === "TypeError" || /import|fetch|network/i.test(e.message || "")
          ? "No se pudo descargar el lector de códigos. Revisá la conexión y volvé a intentar."
        : e.name === "NotAllowedError"
          ? "No diste permiso para usar la cámara. Habilitalo desde el candado de la barra de direcciones."
          : e.name === "NotFoundError"
            ? "No se encontró ninguna cámara en este dispositivo."
            : "No se pudo abrir la cámara. Verificá que ninguna otra app la esté usando."
      );
    }
  }, [trasera]);

  // Arranca al montarse y suelta la cámara al desmontarse. Si no se soltara, el
  // celular queda con el sensor prendido hasta que se cierra la pestaña.
  useEffect(() => { arrancar(); return detener; }, [arrancar, detener]);

  /*
   * Pantalla despierta mientras se escanea.
   *
   * Escanear es sostener el teléfono sin tocarlo: a los treinta segundos se
   * apaga la pantalla, se corta el video y hay que desbloquear con las manos
   * ocupadas. Se vuelve a pedir al volver de segundo plano, porque el bloqueo
   * se suelta solo cuando la pestaña se oculta.
   */
  useEffect(() => {
    let lock = null;
    const pedir = async () => {
      if (document.visibilityState !== "visible") return;
      try { lock = await navigator.wakeLock?.request("screen"); } catch { /* sin soporte o negado */ }
    };
    pedir();
    document.addEventListener("visibilitychange", pedir);
    return () => {
      document.removeEventListener("visibilitychange", pedir);
      lock?.release().catch(() => {});
    };
  }, []);

  async function alternarLinterna() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !linterna }] });
      setLinterna((v) => !v);
    } catch {
      setTieneLinterna(false);   // la anunciaba y no la aplica: se saca el botón
    }
  }

  /*
   * Arrastre del recuadro.
   *
   * Con eventos de puntero, que cubren dedo y mouse con el mismo código. El
   * movimiento se escucha en la ventana y no en el elemento: el dedo se sale
   * del recuadro todo el tiempo mientras se lo achica, y escuchando sólo
   * adentro el arrastre se corta a mitad de camino.
   */
  function arrastrar(e, tipo) {
    e.preventDefault(); e.stopPropagation();
    const caja = contRef.current?.getBoundingClientRect();
    if (!caja) return;
    const base = roiRef.current;
    const x0 = e.clientX, y0 = e.clientY;

    /*
     * El valor final se lleva acá y no se lee de la ref al soltar.
     *
     * La ref la actualiza un efecto después de que React vuelve a dibujar, así
     * que en un movimiento corto y rápido —un toque que arrastra y suelta en el
     * mismo cuadro— todavía tiene el valor anterior cuando llega el pointerup, y
     * lo que se guarda es el recuadro viejo. El empleado acomoda el recuadro,
     * vuelve a entrar, y lo encuentra donde estaba.
     */
    let ultimo = base;

    const mover = (ev) => {
      ultimo = ajustar(tipo, base, (ev.clientX - x0) / caja.width, (ev.clientY - y0) / caja.height);
      setRoi(ultimo);
    };
    const soltar = () => {
      window.removeEventListener("pointermove", mover);
      window.removeEventListener("pointerup", soltar);
      window.removeEventListener("pointercancel", soltar);
      try { localStorage.setItem(GUARDADO, JSON.stringify(ultimo)); } catch { /* no es crítico */ }
    };
    window.addEventListener("pointermove", mover);
    window.addEventListener("pointerup", soltar);
    window.addEventListener("pointercancel", soltar);
  }

  const marco = { left: `${roi.x * 100}%`, top: `${roi.y * 100}%`, width: `${roi.w * 100}%`, height: `${roi.h * 100}%` };
  const esquinas = [
    ["ia", "-left-3 -top-3    cursor-nwse-resize"],
    ["da", "-right-3 -top-3   cursor-nesw-resize"],
    ["ib", "-left-3 -bottom-3 cursor-nesw-resize"],
    ["db", "-right-3 -bottom-3 cursor-nwse-resize"],
  ];

  return (
    <div ref={contRef} className="relative h-full w-full select-none overflow-hidden bg-ink-950">
      <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />

      {estado === "leyendo" && (
        <>
          {/* Todo lo de afuera se oscurece: se ve de un vistazo qué se está
              leyendo y qué no, sin tener que explicarlo. */}
          <div
            className={`absolute touch-none transition-colors ${destello ? "bg-teal-400/25" : ""}`}
            style={{ ...marco, boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)" }}
            onPointerDown={(e) => arrastrar(e, "mover")}
          >
            <div className={`h-full w-full rounded border-2 ${destello ? "border-teal-300" : "border-white/90"}`} />

            {esquinas.map(([tipo, clases]) => (
              <button
                key={tipo}
                type="button"
                aria-label="Cambiar el tamaño del recuadro"
                onPointerDown={(e) => arrastrar(e, tipo)}
                className={`absolute ${clases} flex h-9 w-9 touch-none items-center justify-center`}
              >
                {/* El área táctil es de 36 px aunque el punto se vea de 14: con
                    el dedo, un blanco de 14 px se falla más de lo que se acierta. */}
                <span className="h-3.5 w-3.5 rounded-sm border-2 border-white bg-ink-950/60" />
              </button>
            ))}
          </div>

          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 pb-2 text-[11px] text-white/70">
            <Maximize2 size={12} /> Arrastrá el recuadro o sus esquinas
          </div>

          <div className="absolute right-3 top-3 flex flex-col gap-2">
            {tieneLinterna && (
              <button type="button" onClick={alternarLinterna} aria-pressed={linterna}
                aria-label={linterna ? "Apagar la linterna" : "Prender la linterna"}
                className={`rounded-full p-2.5 backdrop-blur ${linterna ? "bg-white text-ink-950" : "bg-ink-950/60 text-white"}`}>
                {linterna ? <Flashlight size={18} /> : <FlashlightOff size={18} />}
              </button>
            )}
            <button type="button" onClick={() => setTrasera((v) => !v)} aria-label="Cambiar de cámara"
              className="rounded-full bg-ink-950/60 p-2.5 text-white backdrop-blur">
              <SwitchCamera size={18} />
            </button>
          </div>
        </>
      )}

      {(estado === "pidiendo" || estado === "bajando") && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-8 text-center">
          <p className="text-sm text-white/80">
            {estado === "bajando" ? "Preparando el lector…" : "Abriendo la cámara…"}
          </p>
          {/* Sólo la primera vez y sólo en los navegadores sin lector propio.
              Una espera de varios segundos sin explicación se lee como que se
              colgó, y el empleado cierra y vuelve a abrir. */}
          {estado === "bajando" && (
            <p className="text-xs text-white/50">Se descarga una sola vez y queda guardado.</p>
          )}
        </div>
      )}
      {estado === "error" && (
        <p className="absolute inset-0 flex items-center justify-center px-8 text-center text-sm text-white/90">{error}</p>
      )}
    </div>
  );
}
