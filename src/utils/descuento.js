/*
 * El descuento de una venta: en porcentaje o en plata.
 *
 * En el mostrador se regatea de las dos maneras. "Te hago el 10%" y "te lo dejo
 * en 45.000" son la misma conversación, y las dos pantallas que arman una venta
 * —el punto de venta y Ventas y Cotizaciones— tienen que resolverla igual.
 *
 * Vive acá y no en cada pantalla por lo mismo que `reglaMayorista`: son dos
 * lugares que muestran un total y un servidor que cobra otro. El día que las
 * copias se separen, la pantalla diría un número y la caja cobraría otro, que
 * en un mostrador es lo peor que puede pasar porque el cliente ya pagó.
 *
 * El servidor recalcula todo esto por su cuenta y guarda las dos formas —el
 * importe porque es lo que se descontó de verdad, el porcentaje porque es como
 * se lee de un vistazo—. Lo de acá es para mostrar el total antes de cobrar.
 */

const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * @param {"pct"|"monto"} modo   cómo lo cargó la persona
 * @param {string|number} valor  lo que escribió
 * @param {number} subtotal      la venta antes del descuento
 */
export function calcularDescuento(modo, valor, subtotal) {
  const base = redondear(subtotal);
  const pedido = Math.max(0, Number(valor) || 0);

  /*
   * Se recorta al subtotal: más allá de ahí el total se iría a negativo, y una
   * venta en negativo es una devolución que nadie pidió. El servidor lo rechaza
   * igual; acá se frena antes para que el número grande nunca muestre un
   * imposible mientras la persona todavía está escribiendo.
   */
  const descuento = modo === "pct"
    ? redondear(base * Math.min(pedido, 100) / 100)
    : Math.min(redondear(pedido), base);

  return {
    pedido,
    descuento,
    total: redondear(base - descuento),
    // La equivalencia, para poder mostrar la unidad que NO se cargó: quien puso
    // pesos quiere saber qué porcentaje regaló, y al revés.
    pctEquivale: base > 0 ? redondear(descuento / base * 100) : 0,
    /*
     * Escribió más de lo que vale la venta. No es un error —se aplica el
     * máximo— pero hay que decírselo, o el total no coincide con lo que puso.
     *
     * Con la venta todavía vacía no se avisa nada: "el descuento supera la
     * venta" sobre un carrito sin artículos es verdad y no significa nada, y
     * aparecería apenas alguien escribe el primer número.
     */
    excede: modo === "monto" && base > 0 && pedido > base,
  };
}

/**
 * Lo que va en el cuerpo del pedido.
 *
 * Una sola de las dos formas, nunca las dos: el servidor rechaza que lleguen
 * juntas, porque decidir cuál gana en silencio es lo que hace que el ticket
 * diga una cosa y la caja otra.
 */
export function descuentoParaApi(modo, valor, subtotal) {
  const { pedido, descuento } = calcularDescuento(modo, valor, subtotal);
  if (descuento <= 0) return {};
  return modo === "pct"
    ? { descuentoPct: Math.min(pedido, 100) }
    : { descuentoMonto: descuento };
}
