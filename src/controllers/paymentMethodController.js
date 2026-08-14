const { PaymentMethod, SalePayment } = require('../models');

/*
 * Medios de pago del negocio.
 *
 * Cada uno lleva un ajuste porcentual que se aplica sobre la parte del total
 * que se cobra por ese medio: positivo recarga (el 5% típico de transferencia),
 * negativo descuenta (el 10% off por pagar en efectivo).
 */

const LIMITE_AJUSTE = 100; // ±100%: más que eso es siempre un error de tipeo.

function normalizarAjuste(valor) {
  if (valor === undefined || valor === null || valor === '') return 0;
  const n = Number(valor);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) > LIMITE_AJUSTE) return null;
  return Math.round(n * 100) / 100;
}

// GET /api/payment-methods
const list = async (req, res, next) => {
  try {
    const soloActivos = req.query.activos === 'true';
    const where = { businessId: req.auth.businessId };
    if (soloActivos) where.activo = true;
    const metodos = await PaymentMethod.findAll({
      where,
      order: [['orden', 'ASC'], ['nombre', 'ASC']],
    });
    res.json(metodos);
  } catch (error) { next(error); }
};

// POST /api/payment-methods
const create = async (req, res, next) => {
  try {
    const nombre = String(req.body?.nombre || '').trim();
    if (!nombre) return res.status(400).json({ message: 'El nombre es obligatorio.' });

    const ajustePct = normalizarAjuste(req.body?.ajustePct);
    if (ajustePct === null) {
      return res.status(400).json({ message: `El ajuste debe ser un número entre -${LIMITE_AJUSTE} y ${LIMITE_AJUSTE}.` });
    }

    // Dos medios con el mismo nombre confunden al cobrar y al leer reportes.
    const repetido = await PaymentMethod.findOne({ where: { businessId: req.auth.businessId, nombre } });
    if (repetido) return res.status(409).json({ message: `Ya existe un medio de pago llamado "${nombre}".` });

    const metodo = await PaymentMethod.create({
      businessId: req.auth.businessId,
      nombre,
      ajustePct,
      activo: req.body?.activo !== false,
      esEfectivo: Boolean(req.body?.esEfectivo),
      orden: Number(req.body?.orden) || 0,
      notas: req.body?.notas || null,
    });
    res.status(201).json(metodo);
  } catch (error) { next(error); }
};

// PUT /api/payment-methods/:id
const update = async (req, res, next) => {
  try {
    const metodo = await PaymentMethod.findOne({
      where: { id: req.params.id, businessId: req.auth.businessId },
    });
    if (!metodo) return res.status(404).json({ message: 'Medio de pago no encontrado.' });

    const patch = {};
    if (req.body?.nombre !== undefined) {
      const nombre = String(req.body.nombre).trim();
      if (!nombre) return res.status(400).json({ message: 'El nombre es obligatorio.' });
      const repetido = await PaymentMethod.findOne({ where: { businessId: req.auth.businessId, nombre } });
      if (repetido && repetido.id !== metodo.id) {
        return res.status(409).json({ message: `Ya existe un medio de pago llamado "${nombre}".` });
      }
      patch.nombre = nombre;
    }
    if (req.body?.ajustePct !== undefined) {
      const ajustePct = normalizarAjuste(req.body.ajustePct);
      if (ajustePct === null) {
        return res.status(400).json({ message: `El ajuste debe ser un número entre -${LIMITE_AJUSTE} y ${LIMITE_AJUSTE}.` });
      }
      patch.ajustePct = ajustePct;
    }
    if (req.body?.activo !== undefined) patch.activo = Boolean(req.body.activo);
    if (req.body?.esEfectivo !== undefined) patch.esEfectivo = Boolean(req.body.esEfectivo);
    if (req.body?.orden !== undefined)  patch.orden = Number(req.body.orden) || 0;
    if (req.body?.notas !== undefined)  patch.notas = req.body.notas || null;

    await metodo.update(patch);
    res.json(metodo);
  } catch (error) { next(error); }
};

// DELETE /api/payment-methods/:id
const remove = async (req, res, next) => {
  try {
    const metodo = await PaymentMethod.findOne({
      where: { id: req.params.id, businessId: req.auth.businessId },
    });
    if (!metodo) return res.status(404).json({ message: 'Medio de pago no encontrado.' });

    // Si ya se cobró con él, borrarlo dejaría el historial sin explicación.
    // Se desactiva: deja de ofrecerse al cobrar pero las ventas viejas siguen
    // mostrando con qué se pagaron.
    const usos = await SalePayment.count({ where: { paymentMethodId: metodo.id } });
    if (usos > 0) {
      await metodo.update({ activo: false });
      return res.json({
        desactivado: true,
        message: `"${metodo.nombre}" se usó en ${usos} venta(s), así que se desactivó en lugar de borrarse. No vas a verlo al cobrar, y el historial queda intacto.`,
      });
    }

    await metodo.destroy();
    res.status(204).send();
  } catch (error) { next(error); }
};

module.exports = { list, create, update, remove };
