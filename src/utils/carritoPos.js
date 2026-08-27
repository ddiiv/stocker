/*
 * El carrito del punto de venta, guardado entre pantallas.
 *
 * PosPage se desmonta entero al navegar a otra sección —React Router reemplaza
 * el elemento, no lo esconde— y con él se iba todo el carrito. La cajera que
 * salía a mirar la ficha de un cliente volvía a un mostrador vacío y tenía que
 * escanear de nuevo, con la persona esperando.
 *
 * Se guarda en localStorage y no en un contexto de React porque el requisito
 * es que sobreviva también a un refresh o a un cierre accidental de la pestaña,
 * que es cuando más duele. Lo que se guarda son códigos, cantidades y precios
 * de lista: nada que no esté ya impreso en la etiqueta colgada de la prenda.
 *
 * ── Los cinco minutos ──────────────────────────────────────────────
 *
 * El carrito vive cinco minutos desde la última vez que la pantalla estuvo
 * activa. Mientras la cajera está en el POS un latido lo mantiene fresco, así
 * que puede tener el carrito abierto una hora sin que se venza; en cuanto se
 * va, empieza la cuenta.
 *
 * El latido existe por el caso feo: si sólo se marcara la salida, una pestaña
 * que muere de golpe —se cierra el navegador, se corta la luz— no llegaría a
 * marcar nada, y el carrito quedaría vivo para siempre esperando a que alguien
 * vuelva. Con el latido, ese carrito huérfano se vence solo.
 *
 * ── Una terminal, varias personas ──────────────────────────────────
 *
 * En un local la misma máquina la usan todos. El carrito guarda de quién es, y
 * si al abrir el POS no coincide con la sesión, se borra sin leerlo. No alcanza
 * con no mostrarlo: los datos no tienen por qué quedar ahí después de que esa
 * persona cerró sesión.
 */

const CLAVE = 'stocker.pos.carrito.v1';

/** Cinco minutos, en milisegundos. */
export const VIDA_MS = 5 * 60 * 1000;

/** Cada cuánto la pantalla abierta dice "sigo acá". */
export const LATIDO_MS = 60 * 1000;

/*
 * De quién es este carrito.
 *
 * Lleva el negocio Y la persona: dos empleados del mismo local son dos cuentas
 * distintas, y el dueño entrando a mirar tampoco tiene por qué encontrarse el
 * carrito a medio armar de su cajera.
 */
export function identidad(user) {
  if (!user) return null;
  return `${user.type || '?'}:${user.businessId ?? user.id ?? '?'}:${user.id ?? '?'}`;
}

function leerCrudo() {
  try {
    const txt = localStorage.getItem(CLAVE);
    if (!txt) return null;
    const dato = JSON.parse(txt);
    return dato && dato.v === 1 ? dato : null;
  } catch {
    /*
     * JSON roto, localStorage deshabilitado, modo privado lleno. Nada de eso
     * puede tumbar el punto de venta: sin carrito guardado se arranca vacío,
     * que es exactamente como se arrancaba antes de que esto existiera.
     */
    return null;
  }
}

export function borrarCarrito() {
  try { localStorage.removeItem(CLAVE); } catch { /* ver leerCrudo */ }
}

/**
 * Guarda el carrito y refresca el reloj.
 *
 * Se llama en cada cambio, en el latido y al salir de la pantalla: las tres
 * cosas significan lo mismo para el vencimiento —"la pantalla estaba viva
 * hasta acá"— así que no hace falta distinguirlas.
 */
export function guardarCarrito(user, carrito) {
  const duenio = identidad(user);
  if (!duenio) return;

  // Un carrito sin líneas no es un carrito: guardarlo dejaría basura que
  // después hay que salir a limpiar.
  if (!carrito?.items?.length) return borrarCarrito();

  try {
    localStorage.setItem(CLAVE, JSON.stringify({
      v: 1,
      duenio,
      visto: Date.now(),
      carrito,
    }));
  } catch { /* ver leerCrudo */ }
}

/**
 * Devuelve el carrito guardado, o null.
 *
 * Borra lo que no sirve —de otra persona, o vencido— en vez de simplemente
 * ignorarlo: un dato que no se va a usar más no tiene por qué seguir en el
 * disco de una máquina que está en un mostrador.
 *
 * @returns {{carrito: object, minutos: number}|null}
 */
export function leerCarrito(user) {
  const dato = leerCrudo();
  if (!dato) return null;

  if (dato.duenio !== identidad(user)) {
    borrarCarrito();
    return null;
  }

  const afuera = Date.now() - (Number(dato.visto) || 0);
  if (afuera > VIDA_MS) {
    borrarCarrito();
    return null;
  }

  if (!dato.carrito?.items?.length) {
    borrarCarrito();
    return null;
  }

  return { carrito: dato.carrito, minutos: Math.max(0, Math.round(afuera / 60000)) };
}

/*
 * Se llama al cerrar sesión, pase lo que pase.
 *
 * No mira de quién es el carrito ni si venció: el que se va puede ser
 * cualquiera, y dejarle el carrito armado a quien entre después en la misma
 * terminal no es una comodidad, es una filtración.
 */
export function limpiarPorCierreDeSesion() {
  borrarCarrito();
}
