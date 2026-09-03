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

/**
 * El precio mayorista que corresponde cobrar.
 *
 * Sin precio mayorista en ningún lado se cobra el de lista, no cero.
 *
 * Antes esto terminaba en `|| 0`: un producto al que nadie le cargó precio
 * mayorista se vendía GRATIS en cuanto la venta cruzaba el umbral del local.
 * Con la regla de fábrica —tres prendas— alcanzaba con que un cliente llevara
 * tres remeras de un producto recién cargado. La venta quedaba registrada, el
 * stock descontado, la caja cuadrada en cero y nadie se enteraba hasta contar
 * la plata.
 *
 * Cobrar el precio de lista es lo peor que puede pasar ahora: se cobra de más
 * respecto de lo que el negocio quizás quería, el cliente lo ve en el ticket y
 * se corrige. Cobrar cero no se corrige, porque la mercadería ya salió.
 */
function precioMayorista(variante, producto) {
  // Un cero propio de la VARIANTE se respeta: ahí sí es una decisión, la misma
  // que documenta `tieneValor` —una muestra, un regalo, un artículo de canje.
  const propio = variante?.precioMayorista;
  if (tieneValor(propio)) return Number(propio) || 0;

  /*
   * En el PRODUCTO, en cambio, un cero es un campo vacío.
   *
   * La columna no acepta null, así que "sin precio mayorista" y "vale cero" se
   * escriben igual. Y un producto entero regalado no es una decisión que alguien
   * tome: si el número es cero, es que nadie lo cargó.
   */
  const delPadre = Number(producto?.precioMayorista);
  if (tieneValor(producto?.precioMayorista) && delPadre > 0) return delPadre;

  return precioMinorista(variante, producto);
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
