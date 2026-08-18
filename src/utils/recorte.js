/*
 * Geometría del recuadro de lectura del escáner con cámara.
 *
 * Vive acá y no adentro del componente porque es lo único de todo el lector que
 * puede estar mal sin que se note: el recorte queda corrido unos píxeles, el
 * código igual se lee la mitad de las veces, y el problema se atribuye a la luz
 * o a la etiqueta. Separado, se prueba con números.
 */

export const MINIMO = 0.10;   // el recuadro no puede achicarse más que esto

/*
 * Del recuadro dibujado en pantalla al recorte dentro del cuadro de video.
 *
 * No son el mismo sistema de coordenadas. El video se dibuja con object-cover:
 * se agranda hasta tapar la caja entera y lo que sobra se recorta a los
 * costados. Si no se descuenta ese sobrante, el recorte queda desplazado — y el
 * desplazamiento crece cuanto más difieren las proporciones de la cámara y de
 * la pantalla, que es siempre el caso en un celular vertical con una cámara
 * 16:9.
 *
 * `roi` viene en fracciones (0..1) de la caja mostrada; devuelve píxeles del
 * cuadro original.
 */
export function recorteFuente({ vw, vh, dw, dh }, roi) {
  if (!vw || !vh || !dw || !dh) return null;

  const escala = Math.max(dw / vw, dh / vh);   // object-cover toma la mayor
  const sobraX = (vw * escala - dw) / 2;
  const sobraY = (vh * escala - dh) / 2;

  const sx = (roi.x * dw + sobraX) / escala;
  const sy = (roi.y * dh + sobraY) / escala;
  const sw = (roi.w * dw) / escala;
  const sh = (roi.h * dh) / escala;

  return {
    sx: Math.max(0, Math.round(sx)),
    sy: Math.max(0, Math.round(sy)),
    sw: Math.max(1, Math.min(vw, Math.round(sw))),
    sh: Math.max(1, Math.min(vh, Math.round(sh))),
  };
}

/*
 * Mueve o estira el recuadro sin dejarlo salirse de la pantalla ni desaparecer.
 *
 * `tipo` es "mover" o una esquina: i/d (izquierda/derecha) + a/b (arriba/abajo).
 * `dx`/`dy` son fracciones de la caja, no píxeles, para que el arrastre se
 * comporte igual en un celular que en un monitor.
 */
export function ajustar(tipo, base, dx, dy) {
  const r = { ...base };

  if (tipo === "mover") {
    r.x = Math.min(Math.max(0, base.x + dx), 1 - base.w);
    r.y = Math.min(Math.max(0, base.y + dy), 1 - base.h);
    return limpiar(r);
  }

  const izq = tipo.includes("i"), arr = tipo.includes("a");

  if (izq) {
    // Al tirar del borde izquierdo se mueve el origen y el ancho compensa; el
    // tope evita que el borde pase de largo al derecho y lo invierta.
    const x = Math.min(Math.max(0, base.x + dx), base.x + base.w - MINIMO);
    r.w = base.w + (base.x - x); r.x = x;
  } else {
    r.w = Math.min(Math.max(MINIMO, base.w + dx), 1 - base.x);
  }

  if (arr) {
    const y = Math.min(Math.max(0, base.y + dy), base.y + base.h - MINIMO);
    r.h = base.h + (base.y - y); r.y = y;
  } else {
    r.h = Math.min(Math.max(MINIMO, base.h + dy), 1 - base.y);
  }

  return limpiar(r);
}

/*
 * Redondea a cuatro decimales y vuelve a asegurar el mínimo.
 *
 * Estirando desde un borde el tamaño sale de una resta —`w + (x - x')`— y en
 * coma flotante eso deja restos: 0.8 + (0.1 - 0.8) da 0.09999999999999998, un
 * pelo por debajo del mínimo. En un arrastre suelto no se ve, pero el recuadro
 * se guarda en localStorage y vuelve como base del siguiente, así que el resto
 * se arrastra de sesión en sesión.
 *
 * Cuatro decimales son la diezmilésima parte de la pantalla: bastante menos que
 * un píxel en cualquier teléfono, y deja un JSON guardado que se puede leer.
 */
function limpiar(r) {
  const n = (v) => Math.round(v * 1e4) / 1e4;
  return { x: n(r.x), y: n(r.y), w: Math.max(MINIMO, n(r.w)), h: Math.max(MINIMO, n(r.h)) };
}
