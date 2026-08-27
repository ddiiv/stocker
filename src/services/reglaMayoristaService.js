/*
 * Cuándo una venta va a precio mayorista.
 *
 * Existe porque la regla estaba escrita tres veces: una en el controlador de
 * ventas y otra en cada una de las dos pantallas que arman una venta. Tres
 * copias del mismo `>= 3`, y ninguna sabía de las otras. El día que alguien
 * cambiara una, la pantalla mostraría un precio y el servidor cobraría otro —
 * el peor error posible en una caja, porque el cliente ya pagó.
 *
 * Ahora la regla vive en el local y se evalúa acá. El servidor la aplica al
 * cobrar; la pantalla pide la misma función para mostrar el precio mientras se
 * arma la venta. Una sola definición.
 */

const MODOS = ['cantidad', 'monto', 'ambos', 'siempre', 'nunca'];

const POR_DEFECTO = { modo: 'cantidad', cantidad: 3, monto: null };

/** Normaliza lo que venga de la base o del cliente a una regla usable. */
function normalizar(origen) {
  const modo = MODOS.includes(origen?.mayoristaModo ?? origen?.modo)
    ? (origen.mayoristaModo ?? origen.modo)
    : POR_DEFECTO.modo;

  const cantidadCruda = Number(origen?.mayoristaCantidad ?? origen?.cantidad);
  const cantidad = Number.isInteger(cantidadCruda) && cantidadCruda > 0
    ? cantidadCruda
    : POR_DEFECTO.cantidad;

  const montoCrudo = Number(origen?.mayoristaMonto ?? origen?.monto);
  const monto = Number.isFinite(montoCrudo) && montoCrudo > 0 ? montoCrudo : null;

  return { modo, cantidad, monto };
}

/**
 * ¿Esta venta es mayorista?
 *
 * @param regla     lo que devuelve `normalizar` (o el propio local)
 * @param unidades  total de prendas de la venta
 * @param montoLista total de la venta A PRECIOS MINORISTAS
 *
 * El monto va en lista y no en mayorista a propósito: el precio depende del
 * total y el total del precio, así que hay que cortar el círculo por algún
 * lado. Midiendo en lista, el número contra el que se compara es el mismo que
 * el cajero ve mientras carga.
 */
function esMayorista(regla, unidades, montoLista = 0) {
  const r = normalizar(regla);
  const u = Number(unidades) || 0;
  const m = Number(montoLista) || 0;

  switch (r.modo) {
    case 'siempre': return true;
    case 'nunca':   return false;
    case 'monto':   return r.monto !== null && m >= r.monto;
    // Lo que se cumpla primero: llegar por cantidad o por plata son dos formas
    // de la misma decisión comercial, y exigir las dos no la representa.
    case 'ambos':   return u >= r.cantidad || (r.monto !== null && m >= r.monto);
    case 'cantidad':
    default:        return u >= r.cantidad;
  }
}

/** Cómo se le explica la regla a una persona. En la pantalla y en los errores. */
function describir(regla) {
  const r = normalizar(regla);
  const plata = (n) => `$ ${Number(n).toLocaleString('es-AR')}`;
  switch (r.modo) {
    case 'siempre': return 'Siempre a precio mayorista.';
    case 'nunca':   return 'Siempre a precio minorista.';
    case 'monto':   return r.monto ? `Mayorista desde ${plata(r.monto)} en la venta.` : 'Mayorista por monto, sin monto definido.';
    case 'ambos':   return r.monto
      ? `Mayorista desde ${r.cantidad} prenda(s) o ${plata(r.monto)}, lo que pase primero.`
      : `Mayorista desde ${r.cantidad} prenda(s).`;
    case 'cantidad':
    default:        return `Mayorista desde ${r.cantidad} prenda(s).`;
  }
}

/**
 * Valida lo que llega del cliente al configurar un local.
 * @returns {string|null} el motivo del rechazo, o null si está bien.
 */
function validar(cuerpo) {
  const modo = cuerpo?.mayoristaModo;
  if (modo !== undefined && !MODOS.includes(modo)) {
    return `El modo tiene que ser uno de: ${MODOS.join(', ')}.`;
  }
  if (cuerpo?.mayoristaCantidad !== undefined && cuerpo.mayoristaCantidad !== null) {
    const n = Number(cuerpo.mayoristaCantidad);
    if (!Number.isInteger(n) || n < 1) return 'La cantidad tiene que ser un número entero de 1 o más.';
    if (n > 10000) return 'La cantidad no puede pasar de 10.000 prendas.';
  }
  if (cuerpo?.mayoristaMonto !== undefined && cuerpo.mayoristaMonto !== null && cuerpo.mayoristaMonto !== '') {
    const n = Number(cuerpo.mayoristaMonto);
    if (!Number.isFinite(n) || n <= 0) return 'El monto tiene que ser mayor a cero.';
    if (n > 9999999999.99) return 'El monto no puede pasar de 9.999.999.999,99.';
  }
  /*
   * Un modo que necesita monto sin monto cargado no se rechaza en silencio: el
   * local quedaría con una regla que nunca se cumple y todo saldría a precio
   * minorista sin que nadie entienda por qué.
   */
  const necesitaMonto = modo === 'monto' || modo === 'ambos';
  const traeMonto = cuerpo?.mayoristaMonto !== undefined && cuerpo.mayoristaMonto !== null && cuerpo.mayoristaMonto !== '';
  if (necesitaMonto && !traeMonto) {
    return 'Elegiste un umbral por monto: poné desde qué importe la venta pasa a mayorista.';
  }
  return null;
}

module.exports = { MODOS, POR_DEFECTO, normalizar, esMayorista, describir, validar };
