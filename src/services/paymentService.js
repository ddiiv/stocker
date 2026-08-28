const { PaymentMethod } = require('../models');

/*
 * Cálculo de los pagos de una venta.
 *
 * Una venta puede cobrarse con varios medios a la vez: por ejemplo $6.000 en
 * efectivo y $4.000 por transferencia.
 *
 * Definiciones, porque es fácil confundirlas:
 *   monto       → parte del total de mercadería que cubre ese medio
 *   ajusteMonto → recargo (o descuento) que le corresponde a esa parte
 *   montoFinal  → lo que efectivamente entra por ese medio
 *
 * La suma de los `monto` tiene que dar el total de la venta. Los ajustes van
 * por encima: no se cubre mercadería con el recargo.
 *
 * Sobre el ajuste configurado en cada medio:
 *
 * Se aplica SIEMPRE, sobre el importe de su propia línea. Pagar $300 por
 * transferencia con 5% de recargo cuesta $315, sea la transferencia sola o
 * combinada con efectivo.
 *
 * Antes no era así: con dos o más medios no se aplicaba ninguno. La intención
 * era buena —no castigar al que reparte— pero dejaba una puerta abierta:
 * dividir el pago era la forma de no pagar el recargo, y el negocio terminaba
 * absorbiendo el costo de la transferencia sin enterarse. Y sobre todo era
 * difícil de explicar, porque el mismo medio costaba distinto según con qué se
 * lo combinara.
 *
 * El operador puede fijar un ajuste explícito por línea, y ese gana siempre:
 * los descuentos por efectivo, por ejemplo, se dan a mano.
 */

const redondear = (n) => Math.round(Number(n) * 100) / 100;

// Tolerancia para comparar sumas de decimales: dividir un total en tres partes
// deja diferencias de centavos que no son un error del usuario.
const TOLERANCIA = 0.02;

class ErrorPagos extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.status = 400;
  }
}

/**
 * Valida y calcula las líneas de pago de una venta.
 *
 * @param {Array}  pagos      [{ paymentMethodId?, nombre?, monto, ajustePct? }]
 * @param {number} totalVenta total de mercadería a cubrir
 * @param {number} businessId para no aceptar medios de pago de otro negocio
 * @returns {{ lineas, recargoPagos, totalCobrado, resumen }}
 */
async function calcularPagos(pagos, totalVenta, businessId) {
  const total = redondear(totalVenta);

  // Sin detalle de pagos la venta se cobra en un solo medio sin ajuste: es el
  // comportamiento de siempre, y lo que usan las ventas que no pasan por el POS.
  if (!Array.isArray(pagos) || pagos.length === 0) {
    return { lineas: [], recargoPagos: 0, totalCobrado: total, resumen: null };
  }

  // Se traen todos los métodos del negocio de una sola vez: así se valida la
  // pertenencia sin una consulta por línea.
  const metodos = await PaymentMethod.findAll({ where: { businessId } });
  const porId = new Map(metodos.map((m) => [m.id, m]));

  const lineas = [];
  let sumaMontos = 0;
  let recargoPagos = 0;

  for (const [i, pago] of pagos.entries()) {
    const monto = redondear(pago?.monto);
    if (!Number.isFinite(monto) || monto <= 0) {
      throw new ErrorPagos(`El importe del pago ${i + 1} tiene que ser mayor a cero.`);
    }

    let metodo = null;
    if (pago?.paymentMethodId) {
      metodo = porId.get(Number(pago.paymentMethodId));
      if (!metodo) {
        throw new ErrorPagos(`El medio de pago del cobro ${i + 1} no existe en este negocio.`);
      }
    }

    const nombre = String(pago?.nombre || metodo?.nombre || '').trim();
    if (!nombre) throw new ErrorPagos(`Falta indicar con qué se cobra el pago ${i + 1}.`);

    /*
     * El ajuste del medio, sobre el importe de ESTA línea.
     *
     * No importa con cuántos medios se reparta el cobro: cada parte lleva el
     * ajuste de su propio medio, calculado sobre lo que se paga con él. Es la
     * única forma de que el recargo de la transferencia sea el mismo número
     * siempre y de que el cajero pueda explicarlo en el mostrador.
     *
     * Un ajuste explícito en la línea gana: el operador puede ponerlo o
     * sacarlo sin tocar la configuración del medio.
     */
    const vieneExplicito = pago?.ajustePct !== undefined && pago?.ajustePct !== null && pago?.ajustePct !== '';
    const ajustePct = vieneExplicito ? Number(pago.ajustePct) : Number(metodo?.ajustePct || 0);

    if (!Number.isFinite(ajustePct) || Math.abs(ajustePct) > 100) {
      throw new ErrorPagos(`El ajuste del pago ${i + 1} debe estar entre -100% y 100%.`);
    }

    const ajusteMonto = redondear(monto * ajustePct / 100);
    const montoFinal  = redondear(monto + ajusteMonto);

    sumaMontos   = redondear(sumaMontos + monto);
    recargoPagos = redondear(recargoPagos + ajusteMonto);

    lineas.push({
      paymentMethodId: metodo?.id || null,
      nombre,
      monto,
      ajustePct: redondear(ajustePct),
      ajusteMonto,
      montoFinal,
      // Se congela al cobrar: si mañana desmarcan el medio como efectivo, un
      // arqueo ya cerrado no puede cambiar de resultado.
      esEfectivo: Boolean(metodo?.esEfectivo),
    });
  }

  if (Math.abs(sumaMontos - total) > TOLERANCIA) {
    const dif = redondear(total - sumaMontos);
    throw new ErrorPagos(
      dif > 0
        ? `Faltan $${dif.toLocaleString('es-AR')} por asignar: los pagos suman $${sumaMontos.toLocaleString('es-AR')} y el total es $${total.toLocaleString('es-AR')}.`
        : `Los pagos suman $${sumaMontos.toLocaleString('es-AR')}, que supera el total de $${total.toLocaleString('es-AR')} en $${Math.abs(dif).toLocaleString('es-AR')}.`
    );
  }

  // Texto corto para listados y tickets, donde no entra el detalle completo.
  const resumen = lineas.length === 1
    ? lineas[0].nombre
    : lineas.map((l) => l.nombre).join(' + ');

  return {
    lineas,
    recargoPagos,
    totalCobrado: redondear(total + recargoPagos),
    resumen: resumen.slice(0, 60), // el campo medioPago es STRING(60)
  };
}

module.exports = { calcularPagos, ErrorPagos };
