/*
 * Depósito: ingreso de mercadería nueva.
 *
 * Las decisiones de negocio viven en depositoService; acá sólo se resuelve
 * quién pregunta, con qué permiso y en qué depósito trabaja.
 */

const sequelize = require('../config/database');
const {
  StockIngreso, StockIngresoItem, BusinessLocation, Employee, ProductVariant, Product,
} = require('../models');
const deposito = require('../services/depositoService');
const { generarEtiquetas } = require('../services/labelService');

/*
 * En qué depósito trabaja quien pide.
 *
 * El empleado de depósito tiene el suyo asignado y no elige. El dueño elige, y
 * con un solo depósito se resuelve solo. Mandar al principal por descarte
 * cargaría la mercadería en una bodega donde no está, y eso después se busca a
 * mano contra los estantes.
 */
async function depositoDe(req, pedido = null) {
  const businessId = req.auth.businessId;
  if (pedido) {
    await deposito.exigirDeposito(pedido, businessId);
    return Number(pedido);
  }
  if (req.auth.employeeId) {
    const emp = await Employee.findByPk(req.auth.employeeId, { attributes: ['locationId'] });
    if (emp?.locationId) {
      const local = await BusinessLocation.findByPk(emp.locationId);
      if (local?.tipo === 'deposito') return local.id;
    }
  }
  const disponibles = await deposito.depositos(businessId);
  if (!disponibles.length) {
    throw Object.assign(
      new Error('El negocio no tiene ningún depósito. Marcá uno de tus locales como depósito desde Empleados → Locales.'),
      { status: 409 },
    );
  }
  if (disponibles.length === 1) return disponibles[0].id;
  throw Object.assign(new Error('Elegí en qué depósito estás cargando la mercadería.'), { status: 400 });
}

// GET /api/deposito/ingresos
const listar = async (req, res, next) => {
  try {
    const { estado, locationId, desde, hasta, page, limit } = req.query;
    res.json(await deposito.listarIngresos({
      businessId: req.auth.businessId,
      estado: estado || undefined,
      locationId: locationId ? Number(locationId) : undefined,
      desde, hasta, page, limit,
    }));
  } catch (e) { next(e); }
};

// GET /api/deposito/locales — depósitos y locales, para los selectores
const lugares = async (req, res, next) => {
  try {
    const [deps, locs] = await Promise.all([
      deposito.depositos(req.auth.businessId),
      deposito.locales(req.auth.businessId),
    ]);
    res.json({ depositos: deps, locales: locs });
  } catch (e) { next(e); }
};

/*
 * POST /api/deposito/ingresos
 *
 * Plan A (`origen: 'etiquetas'`): sube el stock en el acto.
 * Plan B (`origen: 'conteo'`): queda pendiente de que oficina lo acepte.
 */
/*
 * GET /api/deposito/curva?productId=..&valor=Negro
 *
 * Qué talles abre una curva de ese producto y ese color, para que la pantalla
 * muestre la corrida antes de confirmar. Sin esto habría que adivinar cuántas
 * unidades son 20 curvas.
 */
const curva = async (req, res, next) => {
  try {
    const productId = Number(req.query.productId);
    if (!productId) return res.status(400).json({ message: 'Falta el producto.' });
    const data = await deposito.ejeDeCurva(productId, req.auth.businessId, req.query.valor, null, { exigirValor: false });
    res.json({
      ...data,
      // Lo que entra si se cargan N curvas parejas, para poder mostrarlo antes.
      unidadesPorCurva: data.valores.length,
    });
  } catch (e) { next(e); }
};

const crear = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    // `curvas` es la forma corta de cargar corridas completas; conviven con las
    // líneas sueltas en el mismo remito. Ver expandirCurvas en el servicio.
    const { items = [], curvas = [], notas, origen = 'etiquetas', pedidoId = null } = req.body;
    const locationId = await depositoDe(req, req.body.locationId);

    const { ingreso } = await deposito.registrarIngreso({
      businessId: req.auth.businessId,
      locationId,
      employeeId: req.auth.employeeId || null,
      origen, items, curvas, notas, pedidoId,
      transaction: t,
    });
    await t.commit();

    const full = await StockIngreso.findByPk(ingreso.id, {
      include: [
        { model: StockIngresoItem, as: 'items' },
        { model: BusinessLocation, as: 'deposito', attributes: ['id', 'nombre', 'tipo'] },
      ],
    });
    res.status(201).json(full);
  } catch (e) { await t.rollback().catch(() => {}); next(e); }
};

// POST /api/deposito/ingresos/:id/aceptar
const aceptar = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const ingreso = await deposito.aceptarIngreso({
      ingresoId: req.params.id,
      businessId: req.auth.businessId,
      employeeId: req.auth.employeeId || null,
      transaction: t,
    });
    await t.commit();
    res.json({ ok: true, ingreso, mensaje: `Ingreso ${ingreso.numero} aceptado: el stock ya está en el depósito.` });
  } catch (e) { await t.rollback().catch(() => {}); next(e); }
};

// POST /api/deposito/ingresos/:id/rechazar
const rechazar = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const ingreso = await deposito.rechazarIngreso({
      ingresoId: req.params.id,
      businessId: req.auth.businessId,
      employeeId: req.auth.employeeId || null,
      motivo: req.body?.motivo,
      transaction: t,
    });
    await t.commit();
    res.json({ ok: true, ingreso, mensaje: `Ingreso ${ingreso.numero} rechazado.` });
  } catch (e) { await t.rollback().catch(() => {}); next(e); }
};

/*
 * POST /api/deposito/ingresos/:id/anular
 *
 * La salida del Plan A: el stock sube solo al generar etiquetas, así que tiene
 * que haber forma de deshacerlo cuando el conteo salió mal.
 */
const anular = async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const ingreso = await deposito.anularIngreso({
      ingresoId: req.params.id,
      businessId: req.auth.businessId,
      employeeId: req.auth.employeeId || null,
      motivo: req.body?.motivo,
      transaction: t,
    });
    await t.commit();
    res.json({ ok: true, ingreso, mensaje: `Ingreso ${ingreso.numero} anulado: el stock volvió a como estaba.` });
  } catch (e) { await t.rollback().catch(() => {}); next(e); }
};

/*
 * POST /api/deposito/ingresos/:id/etiquetas
 *
 * Una etiqueta por unidad ingresada. Es el Plan A cerrado: se contó una vez, y
 * de esa misma cuenta salen el stock y las etiquetas que se van a pegar en cada
 * prenda.
 */
const etiquetas = async (req, res, next) => {
  try {
    const ingreso = await StockIngreso.findOne({
      where: { id: req.params.id, businessId: req.auth.businessId },
      include: [{ model: StockIngresoItem, as: 'items' }],
    });
    if (!ingreso) return res.status(404).json({ message: 'Ingreso no encontrado.' });
    if (ingreso.estado === 'rechazado' || ingreso.estado === 'anulado') {
      return res.status(409).json({
        message: `Este ingreso está ${ingreso.estado}: sus etiquetas no corresponden a mercadería que esté en el depósito.`,
      });
    }

    /*
     * Las variantes se traen filtrando por negocio.
     *
     * El ingreso ya es de este negocio, pero el filtro va igual: es la misma
     * defensa que en el generador de etiquetas del catálogo, y quitarla acá
     * dejaría un segundo camino sin ella.
     */
    const ids = [...new Set(ingreso.items.map((i) => i.productVariantId))];
    const variantes = await ProductVariant.findAll({
      where: { id: ids, businessId: req.auth.businessId },
      include: [{ model: Product, as: 'producto', required: true, where: { businessId: req.auth.businessId } }],
    });
    const porId = new Map(variantes.map((v) => [v.id, v]));

    const items = ingreso.items
      .map((i) => ({ variante: porId.get(i.productVariantId), cantidad: i.cantidad }))
      .filter((x) => x.variante && x.cantidad > 0)
      .map((x) => ({ producto: x.variante.producto, variante: x.variante, cantidad: x.cantidad }));

    if (!items.length) {
      return res.status(409).json({ message: 'Este ingreso no tiene ninguna línea con cantidad.' });
    }

    const { doc, total } = generarEtiquetas(items);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="etiquetas-${ingreso.numero}-${total}.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    next(error);
  }
};

module.exports = {
  curva, listar, lugares, crear, aceptar, rechazar, anular, etiquetas };
