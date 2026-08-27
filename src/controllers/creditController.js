const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { Client, ClientAccountEntry, PaymentMethod, Employee, Sale } = require('../models');
const { registrarMovimiento, imputarPago, redondear } = require('../services/creditService');

/*
 * Cuentas corrientes de clientes.
 *
 * Todo lo de acá filtra por `req.auth.businessId` y valida el cliente contra
 * ese negocio antes de tocarlo: un id de cliente en la URL no alcanza para
 * llegar a la cuenta de otro negocio.
 */

const resumenCliente = (c) => {
  const limite = redondear(c.limiteCredito || 0);
  const saldo  = redondear(c.saldoCuenta || 0);
  return {
    id: c.id,
    nombre: c.nombre,
    apellido: c.apellido,
    telefono: c.telefono,
    email: c.email,
    cuentaHabilitada: c.cuentaHabilitada,
    limiteCredito: limite,
    saldoCuenta: saldo,
    // Lo que todavía puede llevarse fiado. Nunca menos que cero, aunque el
    // saldo haya superado el límite por un ajuste manual.
    disponible: Math.max(0, redondear(limite - saldo)),
    // Sobre el límite: pasa si bajaron el límite con deuda ya tomada.
    excedido: saldo > limite,
  };
};

// GET /api/clients/cuentas → panel de cuentas corrientes
const getCuentas = async (req, res, next) => {
  try {
    const soloDeudores = req.query.soloDeudores !== 'false';
    const where = { businessId: req.auth.businessId };
    // Un cliente con la cuenta apagada pero con saldo sigue debiendo: se lista
    // igual, si no la deuda desaparecería de la vista al deshabilitarlo.
    if (soloDeudores) {
      where[Op.or] = [{ cuentaHabilitada: true }, { saldoCuenta: { [Op.ne]: 0 } }];
    }

    const clientes = await Client.findAll({ where, order: [['nombre', 'ASC']] });
    const cuentas  = clientes.map(resumenCliente);

    res.json({
      cuentas,
      totales: {
        deudaTotal:    redondear(cuentas.reduce((s, c) => s + Math.max(0, c.saldoCuenta), 0)),
        creditoTotal:  redondear(cuentas.reduce((s, c) => s + c.limiteCredito, 0)),
        conDeuda:      cuentas.filter((c) => c.saldoCuenta > 0).length,
        excedidos:     cuentas.filter((c) => c.excedido).length,
      },
    });
  } catch (e) { next(e); }
};

// GET /api/clients/:id/cuenta → estado + extracto
const getCuenta = async (req, res, next) => {
  try {
    const cliente = await Client.findOne({
      where: { id: req.params.id, businessId: req.auth.businessId },
    });
    if (!cliente) return res.status(404).json({ message: 'Cliente no encontrado.' });

    const movimientos = await ClientAccountEntry.findAll({
      where: { clientId: cliente.id, businessId: req.auth.businessId },
      include: [
        { model: Sale, as: 'venta', attributes: ['id', 'numero', 'fecha'] },
        { model: Employee, as: 'empleado', attributes: ['id', 'nombre', 'apellido'] },
      ],
      order: [['fecha', 'DESC'], ['id', 'DESC']],
      limit: Math.min(Number(req.query.limit) || 100, 300),
    });

    res.json({ cuenta: resumenCliente(cliente), movimientos });
  } catch (e) { next(e); }
};

// PUT /api/clients/:id/cuenta → habilitar cuenta y fijar límite
const updateCuentaConfig = async (req, res, next) => {
  try {
    const cliente = await Client.findOne({
      where: { id: req.params.id, businessId: req.auth.businessId },
    });
    if (!cliente) return res.status(404).json({ message: 'Cliente no encontrado.' });

    const patch = {};
    if (req.body?.cuentaHabilitada !== undefined) {
      patch.cuentaHabilitada = Boolean(req.body.cuentaHabilitada);
    }
    if (req.body?.limiteCredito !== undefined) {
      const limite = redondear(req.body.limiteCredito);
      if (!Number.isFinite(limite) || limite < 0) {
        return res.status(400).json({ message: 'El límite de crédito no puede ser negativo.' });
      }
      patch.limiteCredito = limite;
    }
    // El saldo nunca se edita a mano desde acá: se mueve con cargos y pagos,
    // que dejan rastro en el extracto. Un saldo escrito a dedo no se puede
    // auditar después.
    await cliente.update(patch);
    res.json(resumenCliente(cliente));
  } catch (e) { next(e); }
};

// POST /api/clients/:id/cuenta/pagos → el cliente cancela parte de la deuda
const registrarPago = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const { monto, paymentMethodId, notas } = req.body;

    let metodo = null;
    if (paymentMethodId) {
      metodo = await PaymentMethod.findOne({
        where: { id: paymentMethodId, businessId: req.auth.businessId },
        transaction: t,
      });
      if (!metodo) throw Object.assign(new Error('El medio de pago no pertenece a este negocio.'), { status: 400 });
    }

    const { saldoNuevo, movimiento, cliente } = await registrarMovimiento({
      businessId: req.auth.businessId,
      clientId:   req.params.id,
      employeeId: req.auth.employeeId || null,
      tipo:       'pago',
      monto,
      paymentMethodId: metodo?.id || null,
      medioPago:  metodo?.nombre || null,
      notas:      notas || null,
    }, t);

    /*
     * Un pago "a cuenta" no dice qué venta cancela, así que se imputa de la
     * más vieja a la más nueva. Sin esto el saldo del cliente bajaría pero sus
     * ventas fiadas seguirían figurando impagas para siempre.
     */
    const saldadas = await imputarPago({
      businessId: req.auth.businessId,
      clientId:   cliente.id,
      monto:      movimiento.monto,
      // Con qué se cobró, para que la venta saldada no quede sin medio de pago.
      medioPago:  metodo?.nombre || 'Pago a cuenta',
      // Quién cobró: queda en el movimiento de stock de la mercadería que sale.
      employeeId: req.auth.employeeId || null,
    }, t);

    /*
     * Si cobró un empleado en efectivo, la plata entra a su caja: sin esto el
     * arqueo le daría sobrante al cerrar el turno. Va en la misma transacción
     * que el movimiento de cuenta — o entran los dos o no entra ninguno.
     */
    if (metodo?.esEfectivo && req.auth.employeeId) {
      const { turnoAbierto } = require('../services/cashService');
      const turno = await turnoAbierto(req.auth.employeeId, req.auth.businessId, t);
      if (turno) {
        const { CashMovement } = require('../models');
        await CashMovement.create({
          businessId:  req.auth.businessId,
          cashShiftId: turno.id,
          employeeId:  req.auth.employeeId,
          tipo:        'ingreso',
          monto:       movimiento.monto,
          motivo:      `Cobro de cuenta corriente — ${[cliente.nombre, cliente.apellido].filter(Boolean).join(' ')}`,
        }, { transaction: t });
      }
    }

    await t.commit();
    res.status(201).json({
      movimiento,
      saldo: saldoNuevo,
      // Para poder avisar "con esto quedaron saldadas las ventas X e Y".
      ventasSaldadas: saldadas.map((v) => ({ id: v.id, numero: v.numero })),
    });
  } catch (e) {
    await t.rollback().catch(() => {});
    next(e);
  }
};

module.exports = { getCuentas, getCuenta, updateCuentaConfig, registrarPago };
