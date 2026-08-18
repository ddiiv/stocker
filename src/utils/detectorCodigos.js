/*
 * De dónde sale el lector de códigos de barras.
 *
 * Hay dos caminos y se elige en tiempo de ejecución:
 *
 *   · Chrome y Edge traen BarcodeDetector nativo. Ese se usa tal cual: lo
 *     resuelve el sistema operativo, es rápido y no descarga nada.
 *   · Safari de iOS y Firefox no lo tienen. Ahí se carga un reemplazo en
 *     WebAssembly (ZXing) que implementa exactamente la misma interfaz.
 *
 * Que la interfaz sea la misma es todo el punto de haber elegido esta librería
 * y no una cualquiera: el componente de la cámara llama `detect()` y no se
 * entera de cuál de los dos le tocó. Sin eso habría dos caminos de lectura que
 * se van separando con cada cambio, y los errores aparecerían en uno solo.
 *
 * El reemplazo se carga sólo cuando hace falta. Son 1,1 MB de WebAssembly:
 * cargarlo siempre le costaría esa descarga a los Android, que no lo necesitan.
 */

const FORMATOS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "codabar", "qr_code"];

export const hayNativo = () => typeof window !== "undefined" && "BarcodeDetector" in window;

/*
 * La cámara alcanza para intentarlo.
 *
 * Antes esto exigía BarcodeDetector nativo, y por eso el botón no aparecía en
 * iPhone. Ahora el que falte se resuelve descargando el reemplazo, así que lo
 * único que no tiene arreglo desde acá es que el navegador no dé la cámara: sin
 * HTTPS no se puede pedir (salvo en localhost) y en un WebView incrustado
 * —el navegador de adentro de Instagram, por ejemplo— puede estar vedada.
 */
export function camaraDisponible() {
  return typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

let promesa = null;

/*
 * Devuelve un detector listo para usar.
 *
 * Se cachea la promesa y no el resultado: si dos partes lo piden mientras la
 * descarga está en curso, esperan la misma y el WebAssembly se baja una sola
 * vez.
 */
export function obtenerDetector() {
  if (promesa) return promesa;

  promesa = (async () => {
    if (hayNativo()) return new window.BarcodeDetector({ formats: FORMATOS });

    const { BarcodeDetector, prepareZXingModule } = await import("barcode-detector/pure");

    /*
     * El WebAssembly se sirve desde nuestro propio dominio.
     *
     * La librería, si no se le dice nada, lo baja de un CDN público. Eso no
     * sirve acá por tres razones, y la primera sola ya alcanza: el wifi de un
     * local con el proxy del proveedor bloqueando dominios raros deja el lector
     * muerto y sin explicación. Además le avisa a un tercero cada vez que un
     * empleado abre el escáner, y ata el escáner a que ese CDN esté en pie.
     *
     * Con `?url`, Vite copia el archivo al build con su hash y devuelve la ruta
     * final, así que se cachea para siempre como el resto de los assets.
     */
    const { default: urlWasm } = await import("zxing-wasm/reader/zxing_reader.wasm?url");
    prepareZXingModule({ overrides: { locateFile: () => urlWasm }, fireImmediately: false });

    return new BarcodeDetector({ formats: FORMATOS });
  })();

  // Si falla la descarga se limpia la cache: un wifi que se cayó un segundo no
  // tiene que dejar el escáner roto hasta que se recargue la página.
  promesa.catch(() => { promesa = null; });

  return promesa;
}
