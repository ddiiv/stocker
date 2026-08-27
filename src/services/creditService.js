const { Op } = require('sequelize');
const { Client, ClientAccountEntry, Sale } = require('../models');
const { descontarStockVenta } = require('./saleStockService');

/*
 * Cuenta corriente de clientes.
 *
 * El saldo es lo que el cliente debe: positivo debe, cero está al día. Nunca
 * baja de cero: un pago no puede superar la deuda. Sin ese tope, tipear un
 * cero de más en el importe deja al cliente con un saldo a favor de millones
 * y sin forma de corregirlo, porque el saldo no se edita a mano.
 *
 * Toda escritura pasa por acá y siempre dentro de una transacción, porque son
 * dos cambios que tienen que viajar juntos: el movimiento en el libro y el
 * saldo en la ficha del cliente. Si se guardara sólo uno, el límite de crédito
 * pasaría a validar contra un número inventado.
 *
 * El bloqueo de fila (`lock`) es lo que evita que dos ventas simultáneas al
 * mismo cliente lean el mismo saldo y las dos entren bajo el límite.
 */

const redondear = (n) => Math.round(Number(n) * 100) / 100;

class ErrorCredito extends Error {
  constructor(mensaje, status = 400) {
    super(mensaje);
    this.status = status;
  }
}

const nombreCliente = (c) => [c.nombre, c.apellido].filter(Boolean).join(' ');

/**
 * Registra un movimiento y deja el saldo del cliente actualizado.
 *
 * @param {object} datos { clientId, businessId, tipo, monto, ... }
 * @param {object} t     transacción de Sequelize (obligatoria)
 */
async function registrarMovimiento(datos, t) {
  const { businessId, clientId, tipo, monto, saleId = null, employeeId = null,
          paymentMethodId = null, medioPago = null, notas = null } = datos;

  const importe = redondear(monto);
  if (!Number.isFinite(importe) || importe <= 0) {
    throw new ErrorCredito('El importe del movimiento tiene que ser mayor a cero.');
  }

  const cliente = await Client.findOne({
    where: { id: clientId, businessId },
    lock: t.LOCK.UPDATE,
    transaction: t,
  });
  if (!cliente) throw new ErrorCredito('El cliente no pertenece a este negocio.', 404);

  const saldoPrevio = redondear(cliente.saldoCuenta || 0);
  const saldoNuevo  = tipo === 'cargo'
    ? redondear(saldoPrevio + importe)
    : redondear(saldoPrevio - importe);

  if (tipo === 'cargo') {
    if (!cliente.cuentaHabilitada) {
      throw new ErrorCredito(`${nombreCliente(cliente)} no tiene cuenta corriente habilitada.`);
    }
    const limite = redondear(cliente.limiteCredito || 0);
    if (saldoNuevo > limite) {
      const disponible = redondear(limite - saldoPrevio);
      throw new ErrorCredito(
        `Supera el límite de crédito de ${nombreCliente(cliente)}. ` +
        `Disponible: $${disponible.toLocaleString('es-AR')} sobre un límite de $${limite.toLocaleString('es-AR')}.`
      );
    }
  } else if (saldoPrevio <= 0) {
    throw new ErrorCredito(`${nombreCliente(cliente)} no tiene deuda pendiente.`);
  } else if (saldoNuevo < 0) {
    throw new ErrorCredito(
      `El pago supera la deuda: ${nombreCliente(cliente)} debe $${saldoPrevio.toLocaleString('es-AR')}.`
    );
  }

  const movimiento = await ClientAccountEntry.create({
    businessId, clientId, saleId, employeeId, tipo,
    monto: importe,
    saldoPosterior: saldoNuevo,
    paymentMethodId, medioPago, notas,
  }, { transaction: t });

  await cliente.update({ saldoCuenta: saldoNuevo }, { transaction: t });

  return { movimiento, saldoPrevio, saldoNuevo, cliente };
}

/**
 * Deuda que nace de una venta fiada.
 *
 * Fiar es una condición de la venta, no un medio de pago: se debe el total de
 * la mercadería y el medio recién se elige al cobrar. Por eso acá no hay
 * líneas de pago que mirar, sólo el total.
 */
async function cargarVenta({ saleId, clientId, businessId, employeeId, monto, numero }, t) {
  if (!clientId) {
    throw new ErrorCredito(
      'Para fiar hay que identificar al cliente: no se puede vender en cuenta corriente a consumidor final.'
    );
  }

  return registrarMovimiento({
    businessId, clientId, saleId, employeeId,
    tipo: 'cargo',
    monto,
    notas: numero ? `Venta ${numero} fiada` : 'Venta fiada',
  }, t);
}

/**
 * Reparte un pago a cuenta entre las ventas fiadas que siguen abiertas.
 *
 * Cuando el cliente paga "a cuenta" y no una venta puntual, hay que decidir
 * qué cancela. Se imputa de la más vieja a la más nueva, que es como se lleva
 * una libreta: si no, el saldo del cliente bajaría pero sus ventas seguirían
 * figurando impagas para siempre.
 *
 * No toca el stock: entregar la mercadería es un momento distinto de pagarla,
 * y lo maneja el cobro de la venta.
 *
 * @returns {Array} ventas que quedaron saldadas con este pago
 */
async function imputarPago({ businessId, clientId, monto, medioPago = null, employeeId = null }, t) {
  let restante = redondear(monto);
  const saldadas = [];

  const abiertas = await Sale.findAll({
    where: {
      businessId, clientId,
      condicionPago: 'cuenta_corriente',
      saldoPendiente: { [Op.gt]: 0 },
    },
    order: [['fecha', 'ASC'], ['id', 'ASC']],
    transaction: t,
    lock: t.LOCK.UPDATE,
  });

  for (const venta of abiertas) {
    if (restante <= 0) break;
    const pendiente = redondear(venta.saldoPendiente);
    const aplica    = Math.min(restante, pendiente);
    const queda     = redondear(pendiente - aplica);

    await venta.update({
      saldoPendiente: queda,
      /*
       * Recién con la venta entera cubierta pasa a pagada: un pago parcial la
       * deja pendiente con menos saldo, no cobrada a medias.
       *
       * Y se completa `totalCobrado`. Sin esto la venta figuraba pagada con cero
       * cobrado, y toda métrica de facturación la contaba en $0 — un pago a
       * cuenta desaparecía de los ingresos. Sobre un pago a cuenta no hay
       * recargo, así que lo cobrado es el total de la venta.
       *
       * `cobradoPorEmployeeId` se deja SIN completar a propósito: el efectivo de
       * este cobro ya entró al arqueo como CashMovement desde la ficha del
       * cliente, y completarlo acá haría que el turno lo cuente dos veces.
       */
      ...(queda <= 0 ? {
        estado: 'pagado',
        cobradoEn: venta.cobradoEn || new Date(),
        totalCobrado: redondear(venta.total),
        medioPago: venta.medioPago || medioPago,
      } : {}),
    }, { transaction: t });

    /*
     * Al saldarse, la mercadería sale.
     *
     * Una venta fiada puede haberse hecho sin entregar nada —una seña, algo
     * reservado—, y ahí `stockDescontado` queda en false a propósito. Pero
     * cuando el cliente termina de pagar se lleva la ropa, y hasta ahora este
     * camino la daba por pagada sin tocar el inventario: la prenda seguía
     * figurando en el local para siempre.
     *
     * Pasaba sólo cobrando desde la ficha del cliente. Cobrando desde la venta
     * el stock sí se descontaba, así que el mismo cobro dejaba el inventario en
     * un estado u otro según por qué pantalla se hiciera.
     *
     * `descontarStockVenta` no hace nada si ya se había descontado, así que la
     * venta fiada que sí entregó al momento no se toca dos veces.
     */
    if (queda <= 0) {
      await descontarStockVenta(venta, t, {
        employeeId,
        motivo: `Cobro de cuenta corriente ${venta.numero}`,
      });
      saldadas.push(venta);
    }
    restante = redondear(restante - aplica);
  }

  return saldadas;
}

module.exports = { registrarMovimiento, cargarVenta, imputarPago, ErrorCredito, redondear };
