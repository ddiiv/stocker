const { CashShift, CashMovement, Employee, Business, BusinessLocation } = require('../models');
const { sendCashDiscrepancyAlert } = require('../services/emailService');
const caja = require('../services/cashService');
const { log } = require('../utils/logger');

/*
 * Caja: turnos y movimientos.
 *
 * El arqueo es del empleado. El dueño no abre turno — no atiende la caja y no
 * tiene efectivo que rendir — pero sí ve los turnos de todos y puede registrar
 * movimientos fuera de turno.
 */

function soloEmpleados(req, res) {
  if (!req.auth.employeeId) {
    res.status(400).json({
      message: 'El arqueo de caja es por empleado. Como dueño no tenés turno propio: podés ver los turnos de tu personal y registrar movimientos fuera de turno.',
    });
    return false;
  }
  return true;
}

// GET /api/cash/turno-actual — turno abierto del empleado y su estado
const turnoActual = async (req, res, next) => {
  try {
    if (!req.auth.employeeId) {
      // Al dueño se le responde sin turno en vez de con error: la pantalla
      // usa esto para decidir qué mostrar y un 400 la rompería.
      return res.json({ turno: null, esDueno: true });
    }
    const turno = await caja.turnoAbierto(req.auth.employeeId, req.auth.businessId);
    if (!turno) {
      const ultimo = await caja.ultimoCierre(req.auth.employeeId, req.auth.businessId);
      return res.json({ turno: null, ultimoCierre: ultimo });
    }
    const estado = await caja.estadoDeTurno(turno);
    res.json(estado);
  } catch (error) { next(error); }
};

// POST /api/cash/abrir
const abrir = async (req, res, next) => {
  try {
    if (!soloEmpleados(req, res)) return;

    // El local sale del empleado, igual que en la venta: no se elige.
    const empleado = await Employee.findOne({
      where: { id: req.auth.employeeId, businessId: req.auth.businessId },
    });

    const turno = await caja.abrirTurno({
      employeeId: req.auth.employeeId,
      businessId: req.auth.businessId,
      locationId: empleado?.locationId || null,
      montoInicial: req.body?.montoInicial,
    });

    log.info('caja', 'turno abierto', { turno: turno.id, empleado: req.auth.employeeId });
    res.status(201).json(await caja.estadoDeTurno(turno));
  } catch (error) { next(error); }
};

// POST /api/cash/cerrar
const cerrar = async (req, res, next) => {
  try {
    if (!soloEmpleados(req, res)) return;

    const turno = await caja.turnoAbierto(req.auth.employeeId, req.auth.businessId);
    if (!turno) return res.status(404).json({ message: 'No tenés ningún turno abierto.' });

    const resultado = await caja.cerrarTurno({
      turno,
      montoDeclarado: req.body?.montoDeclarado,
      notaCierre: req.body?.notaCierre,
    });

    if (resultado.descuadre) {
      // Queda registrado para que el dueño lo vea en el listado. El importe no
      // va al log: es información del negocio.
      log.warn('caja', 'cierre con diferencia', {
        turno: turno.id,
        empleado: req.auth.employeeId,
        signo: resultado.diferencia > 0 ? 'sobrante' : 'faltante',
      });

      // Aviso por mail al dueño, sin bloquear la respuesta: el empleado no
      // tiene que esperar al servidor de correo para terminar su cierre.
      (async () => {
        const negocio  = await Business.findByPk(req.auth.businessId);
        const empleado = await Employee.findByPk(req.auth.employeeId);
        const local    = turno.locationId ? await BusinessLocation.findByPk(turno.locationId) : null;
        if (!negocio?.email) return;
        await sendCashDiscrepancyAlert({
          to: negocio.email,
          ownerName: negocio.ownerNombre,
          businessName: negocio.nombreNegocio,
          turno: resultado.turno,
          empleado: `${empleado?.nombre || ''} ${empleado?.apellido || ''}`.trim() || 'Empleado',
          local: local?.nombre || null,
          desglose: resultado.desglose,
        });
      })().catch((err) => log.error('caja', 'no se pudo avisar el descuadre', { motivo: err.message }));
    }

    res.json(resultado);
  } catch (error) { next(error); }
};

// POST /api/cash/movimientos
const registrarMovimiento = async (req, res, next) => {
  try {
    const { tipo, monto, motivo, entregadoPor, recibidoPor } = req.body || {};

    if (!['ingreso', 'egreso', 'retiro'].includes(tipo)) {
      return res.status(400).json({ message: 'El tipo debe ser ingreso, egreso o retiro.' });
    }
    const importe = Math.round(Number(monto) * 100) / 100;
    if (!Number.isFinite(importe) || importe <= 0) {
      return res.status(400).json({ message: 'El importe tiene que ser mayor a cero.' });
    }

    // El destino del retiro es opcional: qué se hace con esa plata es asunto
    // del dueño, no del sistema. Lo que sí queda registrado siempre es cuánto
    // salió, de qué turno y cuándo — que es lo que hace falta para arquear.

    let cashShiftId = null;
    if (req.auth.employeeId) {
      // El empleado sólo mueve plata dentro de su turno: si no hay turno
      // abierto, el movimiento no tendría contra qué arquearse.
      const turno = await caja.turnoAbierto(req.auth.employeeId, req.auth.businessId);
      if (!turno) {
        return res.status(409).json({
          message: 'Necesitás un turno de caja abierto para registrar movimientos.',
        });
      }
      cashShiftId = turno.id;

      /*
       * No se puede sacar más plata de la que hay.
       *
       * Sin este control, un cero de más en un retiro dejaba el arqueo en
       * negativo —"debería haber -$99.994.999"—, que es un número que no
       * existe y que quien cierra la caja no tiene forma de justificar. El
       * error de tipeo es el caso común; el arqueo imposible, la consecuencia.
       *
       * Los ingresos no se validan: meter plata en la caja siempre se puede.
       */
      if (tipo === 'retiro' || tipo === 'egreso') {
        const { desglose } = await caja.estadoDeTurno(turno);
        if (importe > desglose.montoEsperado) {
          return res.status(409).json({
            message: `En la caja hay $${desglose.montoEsperado.toLocaleString('es-AR')} y estás sacando `
              + `$${importe.toLocaleString('es-AR')}. Si el número de la caja está mal, registrá primero el ingreso que falta.`,
            disponible: desglose.montoEsperado,
            solicitado: importe,
          });
        }
      }
    }

    const mov = await CashMovement.create({
      businessId: req.auth.businessId,
      cashShiftId,                      // null si lo registra el dueño
      employeeId: req.auth.employeeId || null,
      tipo,
      monto: importe,
      motivo: motivo || null,
      entregadoPor: entregadoPor?.trim() || null,
      recibidoPor: recibidoPor?.trim() || null,
      fecha: new Date(),
    });

    res.status(201).json(mov);
  } catch (error) { next(error); }
};

// GET /api/cash/turnos — historial. El empleado ve los suyos; el dueño, todos.
const listarTurnos = async (req, res, next) => {
  try {
    const where = { businessId: req.auth.businessId };
    if (req.auth.employeeId) where.employeeId = req.auth.employeeId;
    else if (req.query.employeeId) where.employeeId = req.query.employeeId;

    if (req.query.soloDescuadres === 'true') {
      const { Op } = require('sequelize');
      where.estado = 'cerrado';
      where.diferencia = { [Op.ne]: 0 };
    }

    const turnos = await CashShift.findAll({
      where,
      include: [
        { association: 'empleado', attributes: ['id', 'nombre', 'apellido'] },
        { association: 'local', attributes: ['id', 'nombre'] },
      ],
      order: [['abiertoEn', 'DESC']],
      limit: Math.min(Number(req.query.limit) || 50, 200),
    });

    /*
     * Los turnos cerrados ya tienen calculado el esperado y la diferencia. Los
     * abiertos no: esos valores se fijan recién al cerrar. Para que el dueño
     * pueda mirar una caja en curso —cuánto debería haber ahora mismo— se
     * calcula el desglose al vuelo sólo para los que siguen abiertos.
     */
    const conEstado = await Promise.all(turnos.map(async (t) => {
      const base = t.toJSON();
      if (t.estado !== 'abierto') return base;
      const { desglose, movimientos } = await caja.estadoDeTurno(t);
      return { ...base, desglose, cantidadMovimientos: movimientos.length };
    }));

    res.json(conEstado);
  } catch (error) { next(error); }
};

// GET /api/cash/turnos/:id — detalle con desglose y movimientos
const detalleTurno = async (req, res, next) => {
  try {
    const where = { id: req.params.id, businessId: req.auth.businessId };
    // Un empleado no puede mirar el arqueo de un compañero.
    if (req.auth.employeeId) where.employeeId = req.auth.employeeId;

    const turno = await CashShift.findOne({
      where,
      include: [
        { association: 'empleado', attributes: ['id', 'nombre', 'apellido'] },
        { association: 'local', attributes: ['id', 'nombre'] },
      ],
    });
    if (!turno) return res.status(404).json({ message: 'Turno no encontrado.' });

    // Si ya cerró, el esperado quedó congelado: recalcularlo mostraría otro
    // número si después se tocó algo, y el arqueo dejaría de ser un registro.
    if (turno.estado === 'cerrado') {
      const { movimientos } = await require('../services/cashService').estadoDeTurno(turno);
      return res.json({
        turno,
        desglose: {
          montoInicial:  Number(turno.montoInicial),
          montoEsperado: Number(turno.montoEsperado),
          montoDeclarado: Number(turno.montoDeclarado),
          diferencia:    Number(turno.diferencia),
        },
        movimientos,
      });
    }

    res.json(await caja.estadoDeTurno(turno));
  } catch (error) { next(error); }
};

/*
 * GET /api/cash/retiros — cuánto efectivo salió de las cajas y de dónde.
 *
 * Qué se hace después con esa plata no lo maneja el sistema; lo que sí tiene
 * que quedar es la trazabilidad: importe, turno, empleado, fecha y hora, y la
 * nota si la cargaron. Con eso el dueño puede reconstruir cualquier faltante.
 */
const listarRetiros = async (req, res, next) => {
  try {
    const { Op } = require('sequelize');
    const { desde, hasta, employeeId } = req.query;

    const where = { businessId: req.auth.businessId, tipo: 'retiro' };
    // Un empleado sólo ve lo que sacó él; el dueño ve todo y puede filtrar.
    if (req.auth.employeeId) where.employeeId = req.auth.employeeId;
    else if (employeeId) where.employeeId = employeeId;

    if (desde || hasta) {
      where.fecha = {};
      if (desde) where.fecha[Op.gte] = new Date(desde);
      if (hasta) where.fecha[Op.lte] = new Date(`${hasta}T23:59:59`);
    }

    const retiros = await CashMovement.findAll({
      where,
      include: [
        { association: 'empleado', attributes: ['id', 'nombre', 'apellido'] },
        { association: 'turno', attributes: ['id', 'abiertoEn', 'cerradoEn', 'estado'] },
      ],
      order: [['fecha', 'DESC']],
      limit: 500,
    });

    const total = retiros.reduce((s, r) => s + Number(r.monto), 0);

    res.json({
      total: Math.round(total * 100) / 100,
      cantidad: retiros.length,
      retiros: retiros.map((r) => ({
        id: r.id,
        monto: Number(r.monto),
        fecha: r.fecha,
        nota: r.motivo || null,
        entregadoPor: r.entregadoPor || null,
        recibidoPor: r.recibidoPor || null,
        turnoId: r.cashShiftId,
        turnoAbiertoEn: r.turno?.abiertoEn || null,
        empleado: r.empleado ? `${r.empleado.nombre} ${r.empleado.apellido}` : 'Dueño',
      })),
    });
  } catch (error) { next(error); }
};

module.exports = { turnoActual, abrir, cerrar, registrarMovimiento, listarTurnos, detalleTurno, listarRetiros };
