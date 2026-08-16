const { Op } = require('sequelize');
const { CashShift, CashMovement, Sale, SalePayment } = require('../models');

/*
 * Arqueo de caja.
 *
 * El turno es del empleado que atiende la caja: abre con un monto inicial de
 * cambio, durante la jornada entra y sale efectivo, y al cerrar cuenta lo que
 * hay físicamente. La diferencia entre lo contado y lo que el sistema calcula
 * es lo que se revisa.
 *
 * Sólo se arquea EFECTIVO. Lo cobrado con tarjeta, transferencia o QR no pasa
 * por el cajón, así que meterlo en la cuenta haría que toda caja cierre mal.
 *
 * El dueño no tiene turno: no está detrás del mostrador y no rinde efectivo.
 * Sí puede registrar movimientos fuera de turno (por ejemplo, un retiro para
 * llevar al banco), que quedan asociados al negocio sin turno.
 */

const redondear = (n) => Math.round(Number(n || 0) * 100) / 100;

// Respaldo para cobros anteriores al flag `esEfectivo`, que no lo tienen
// guardado. Para todo lo nuevo manda la casilla del medio de pago.
const PARECE_EFECTIVO = /efectivo|contado|cash/i;

function cuentaComoEfectivo(pago) {
  if (pago.esEfectivo === true) return true;
  if (pago.esEfectivo === false) return false;
  return PARECE_EFECTIVO.test(pago.nombre || '');
}

class ErrorCaja extends Error {
  constructor(mensaje, status = 400) {
    super(mensaje);
    this.status = status;
  }
}

/** Turno abierto del empleado, o null. */
// La transacción es opcional: quien registra un movimiento dentro de una
// transacción necesita leer el turno con la misma vista de la base.
async function turnoAbierto(employeeId, businessId, transaction = null) {
  return CashShift.findOne({
    where: { employeeId, businessId, estado: 'abierto' },
    order: [['abiertoEn', 'DESC']],
    ...(transaction ? { transaction } : {}),
  });
}

/**
 * Suma del efectivo cobrado durante el turno.
 *
 * Se mira el detalle de pagos y no `medioPago`, porque en una venta combinada
 * sólo una parte entró en efectivo y es esa la que llega a la caja. Se toma
 * `montoFinal` (con el ajuste aplicado): es la plata que realmente se recibió.
 *
 * El filtro es por CUÁNDO SE COBRÓ y por QUIÉN COBRÓ, no por cuándo se hizo la
 * venta. Con las ventas fiadas los dos momentos se separaron: una venta de la
 * semana pasada que se cobra hoy entra a la caja de hoy, y la puede cobrar un
 * empleado distinto del que vendió.
 */
async function efectivoCobrado(turno) {
  const hasta = turno.cerradoEn || new Date();
  const ventas = await Sale.findAll({
    where: {
      businessId: turno.businessId,
      cobradoPorEmployeeId: turno.employeeId,
      estado: 'pagado',
      cobradoEn: { [Op.gte]: turno.abiertoEn, [Op.lte]: hasta },
    },
    include: [{ model: SalePayment, as: 'pagos' }],
  });

  let total = 0;
  for (const venta of ventas) {
    if (venta.pagos?.length) {
      for (const pago of venta.pagos) {
        if (cuentaComoEfectivo(pago)) total += Number(pago.montoFinal);
      }
    } else if (PARECE_EFECTIVO.test(venta.medioPago || '')) {
      // Ventas sin detalle de pagos (las de antes de esta función).
      total += Number(venta.totalCobrado) || Number(venta.total);
    }
  }
  return redondear(total);
}

/** Ingresos, egresos y retiros cargados a mano en el turno. */
async function movimientosDelTurno(cashShiftId) {
  const movs = await CashMovement.findAll({ where: { cashShiftId }, order: [['fecha', 'ASC']] });
  let ingresos = 0, egresos = 0, retiros = 0;
  for (const m of movs) {
    const monto = Number(m.monto);
    if (m.tipo === 'ingreso') ingresos += monto;
    else if (m.tipo === 'egreso') egresos += monto;
    else if (m.tipo === 'retiro') retiros += monto;
  }
  return {
    movimientos: movs,
    ingresos: redondear(ingresos),
    egresos: redondear(egresos),
    retiros: redondear(retiros),
  };
}

/**
 * Estado completo del turno: cuánto debería haber en la caja y de dónde sale
 * ese número. Se devuelve desglosado para que el empleado pueda entender la
 * diferencia en vez de ver sólo un total que no cierra.
 */
async function estadoDeTurno(turno) {
  const efectivoVentas = await efectivoCobrado(turno);
  const { movimientos, ingresos, egresos, retiros } = await movimientosDelTurno(turno.id);

  const montoEsperado = redondear(
    Number(turno.montoInicial) + efectivoVentas + ingresos - egresos - retiros
  );

  return {
    turno,
    desglose: {
      montoInicial: redondear(turno.montoInicial),
      efectivoVentas,
      ingresos,
      egresos,
      retiros,
      montoEsperado,
    },
    movimientos,
  };
}

/** Abre un turno. Falla si el empleado ya tiene uno sin cerrar. */
async function abrirTurno({ employeeId, businessId, locationId, montoInicial }) {
  const abierto = await turnoAbierto(employeeId, businessId);
  if (abierto) {
    // El turno pendiente viaja en el error para que la pantalla pueda ofrecer
    // cerrarlo en el momento, en vez de dejar al empleado sin salida.
    const err = new ErrorCaja(
      `Quedó un turno abierto desde el ${new Date(abierto.abiertoEn).toLocaleString('es-AR')}. Cerralo para poder abrir uno nuevo.`,
      409
    );
    err.detalles = { turnoPendiente: abierto };
    throw err;
  }

  const monto = redondear(montoInicial);
  if (!Number.isFinite(monto) || monto < 0) {
    throw new ErrorCaja('El monto inicial no puede ser negativo.');
  }

  return CashShift.create({
    businessId, employeeId, locationId: locationId || null,
    montoInicial: monto,
    abiertoEn: new Date(),
    estado: 'abierto',
  });
}

/** Cierra el turno con el conteo físico y deja registrada la diferencia. */
async function cerrarTurno({ turno, montoDeclarado, notaCierre }) {
  if (turno.estado !== 'abierto') throw new ErrorCaja('Este turno ya está cerrado.');

  const declarado = redondear(montoDeclarado);
  if (!Number.isFinite(declarado) || declarado < 0) {
    throw new ErrorCaja('El monto contado no puede ser negativo.');
  }

  const { desglose } = await estadoDeTurno(turno);
  const diferencia = redondear(declarado - desglose.montoEsperado);

  await turno.update({
    cerradoEn: new Date(),
    montoEsperado: desglose.montoEsperado,
    montoDeclarado: declarado,
    diferencia,
    estado: 'cerrado',
    notaCierre: notaCierre || null,
  });

  return { turno, desglose, diferencia, descuadre: diferencia !== 0 };
}

/** Último turno cerrado del empleado — el "cierre del día anterior". */
async function ultimoCierre(employeeId, businessId) {
  return CashShift.findOne({
    where: { employeeId, businessId, estado: 'cerrado' },
    order: [['cerradoEn', 'DESC']],
  });
}

module.exports = {
  turnoAbierto, estadoDeTurno, abrirTurno, cerrarTurno, ultimoCierre,
  efectivoCobrado, ErrorCaja, cuentaComoEfectivo,
};
