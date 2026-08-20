/*
 * El precio efectivo de una variante.
 *
 * La regla es una sola y vive acá: si la variante tiene precio propio, manda
 * ése; si no, el del producto. Nulo significa "heredar", no "cero".
 *
 * Existe como servicio y no como un `??` suelto en cada controlador porque son
 * cuatro los lugares que deciden un precio —la venta, el buscador del punto de
 * venta, el detalle del producto y la exportación a Excel— y basta que uno
 * quede leyendo el precio del padre para que el sistema cobre de menos sin que
 * nadie se entere hasta cerrar la caja.
 */

/*
 * Un precio propio se distingue del heredado por ser distinto de null, no por
 * ser mayor a cero: una variante de regalo o de muestra puede valer 0 y eso es
 * una decisión, no un campo vacío.
 */
const tieneValor = (v) => v !== null && v !== undefined && v !== '';

/** El precio minorista que corresponde cobrar. */
function precioMinorista(variante, producto) {
  const propio = variante?.precioMinorista;
  return Number(tieneValor(propio) ? propio : producto?.precioMinorista) || 0;
}

/** El precio mayorista que corresponde cobrar. */
function precioMayorista(variante, producto) {
  const propio = variante?.precioMayorista;
  return Number(tieneValor(propio) ? propio : producto?.precioMayorista) || 0;
}

/** El costo que corresponde imputar. */
function costo(variante, producto) {
  const propio = variante?.costo;
  return Number(tieneValor(propio) ? propio : producto?.costo) || 0;
}

/**
 * El precio de venta según la modalidad.
 *
 * `producto` puede omitirse si la variante trae su `producto` incluido, que es
 * como llega en casi todas las consultas.
 */
function precioDeVenta(variante, esMayorista, producto = null) {
  const padre = producto || variante?.producto;
  return esMayorista ? precioMayorista(variante, padre) : precioMinorista(variante, padre);
}

/** Los tres precios juntos, con el dato de si son propios o heredados. */
function resumenDe(variante, producto = null) {
  const padre = producto || variante?.producto;
  return {
    precioMinorista: precioMinorista(variante, padre),
    precioMayorista: precioMayorista(variante, padre),
    costo: costo(variante, padre),
    // Para que la pantalla pueda mostrar cuáles se apartan del padre: es lo que
    // permite entender de un vistazo por qué dos talles valen distinto.
    propio: {
      precioMinorista: tieneValor(variante?.precioMinorista),
      precioMayorista: tieneValor(variante?.precioMayorista),
      costo: tieneValor(variante?.costo),
    },
  };
}

module.exports = { precioMinorista, precioMayorista, costo, precioDeVenta, resumenDe, tieneValor };
