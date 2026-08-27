const { Op } = require('sequelize');
const { cuitValido, emailValido } = require('../utils/identificadores');
const { sanitizarPermisos } = require('../config/permisos');
const bcrypt = require('bcryptjs');
const { BusinessLocation, Role, Client, Sale, SaleItem, Invoice, ProductVariant, Product, StockMovement } = require('../models');
const { ilikeOperator } = require('../utils/sqlHelpers');

/*
 * Toma del body sólo los campos permitidos.
 *
 * Los `update(req.body)` y los spreads `{ ...req.body }` dejan que el cliente
 * escriba cualquier columna del modelo, incluida businessId. Con eso, alguien
 * con permiso de edición puede mover un registro a otro negocio o pisar el
 * businessId que el servidor acababa de fijar. Ver informe QA F-02.
 */
function soloCampos(body, permitidos) {
  const patch = {};
  for (const campo of permitidos) {
    if (body?.[campo] !== undefined) patch[campo] = body[campo];
  }
  return patch;
}

const CAMPOS_LOCAL   = ['nombre', 'direccion', 'telefono', 'activo', 'tipo'];
const CAMPOS_CLIENTE = ['nombre', 'apellido', 'email', 'telefono', 'whatsapp',
  'cuit', 'dni', 'direccion', 'tipo', 'notas'];


// ─── LOCATIONS ────────────────────────────────────────────────────
const getLocations = async (req, res, next) => {
  try {
    const locs = await BusinessLocation.findAll({ where: { businessId: req.auth.businessId }, order: [['nombre', 'ASC']] });
    res.json(locs);
  } catch (e) { next(e); }
};
/*
 * Local o depósito, y nada más.
 *
 * Se valida acá porque de este campo cuelga todo el circuito: un tipo mal
 * escrito haría que el lugar no aparezca ni como local de venta ni como
 * depósito, y sería invisible en las dos pantallas a la vez.
 */
const TIPOS_LOCAL = ['local', 'deposito', 'online'];

const createLocation = async (req, res, next) => {
  try {
    const { nombre, direccion, telefono, tipo } = req.body;
    if (!nombre || !direccion) return res.status(400).json({ message: 'Nombre y dirección son obligatorios.' });
    if (tipo && !TIPOS_LOCAL.includes(tipo)) {
      return res.status(400).json({ message: 'El tipo tiene que ser "local", "deposito" u "online".' });
    }
    const loc = await BusinessLocation.create({
      businessId: req.auth.businessId, nombre, direccion, telefono, tipo: tipo || 'local',
    });
    res.status(201).json(loc);
  } catch (e) { next(e); }
};
const updateLocation = async (req, res, next) => {
  try {
    const loc = await BusinessLocation.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!loc) return res.status(404).json({ message: 'Local no encontrado.' });

    const { tipo } = req.body;
    if (tipo && !TIPOS_LOCAL.includes(tipo)) {
      return res.status(400).json({ message: 'El tipo tiene que ser "local", "deposito" u "online".' });
    }
    /*
     * Convertir un local de venta en depósito no es un cambio de etiqueta: de
     * un depósito no se vende. Si tiene mercadería, avisar antes es mejor que
     * dejar al cajero descubriéndolo con un cliente adelante.
     */
    if (tipo === 'deposito' && loc.tipo !== 'deposito') {
      const { VariantStock } = require('../models');
      const conStock = await VariantStock.count({ where: { locationId: loc.id, stock: { [Op.gt]: 0 } } });
      if (conStock && req.body.confirmar !== true) {
        return res.status(409).json({
          message: `"${loc.nombre}" tiene ${conStock} artículo(s) con stock y desde un depósito no se vende. `
            + 'Confirmá si querés convertirlo igual: la mercadería queda ahí y sale por transferencia.',
          codigo: 'LOCAL_CON_STOCK',
          articulos: conStock,
        });
      }
    }

    await loc.update(soloCampos(req.body, CAMPOS_LOCAL));
    res.json(loc);
  } catch (e) { next(e); }
};
const deleteLocation = async (req, res, next) => {
  try {
    const loc = await BusinessLocation.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!loc) return res.status(404).json({ message: 'Local no encontrado.' });
    await loc.destroy();
    res.status(204).send();
  } catch (e) { next(e); }
};

// ─── ROLES ───────────────────────────────────────────────────────
const getRoles = async (req, res, next) => {
  try {
    const roles = await Role.findAll({ where: { businessId: req.auth.businessId }, order: [['nombre', 'ASC']] });
    res.json(roles);
  } catch (e) { next(e); }
};
const createRole = async (req, res, next) => {
  try {
    const { nombre, permisos } = req.body;
    if (!nombre) return res.status(400).json({ message: 'El nombre del cargo es obligatorio.' });
    // Se normaliza siempre: descarta módulos inventados y niveles inválidos, y
    // completa los que falten. Un permiso mal escrito no da acceso y no avisa,
    // así que conviene no dejarlo entrar.
    const role = await Role.create({
      businessId: req.auth.businessId,
      nombre,
      permisos: sanitizarPermisos(permisos),
    });
    res.status(201).json(role);
  } catch (e) { next(e); }
};
const updateRole = async (req, res, next) => {
  try {
    const role = await Role.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!role) return res.status(404).json({ message: 'Cargo no encontrado.' });
    // businessId nunca se toma del body: mover un cargo a otro negocio sería
    // regalarle acceso a datos ajenos.
    const patch = {};
    if (req.body?.nombre !== undefined) patch.nombre = req.body.nombre;
    if (req.body?.permisos !== undefined) patch.permisos = sanitizarPermisos(req.body.permisos);
    await role.update(patch);
    res.json(role);
  } catch (e) { next(e); }
};
const deleteRole = async (req, res, next) => {
  try {
    const role = await Role.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!role) return res.status(404).json({ message: 'Cargo no encontrado.' });
    await role.destroy();
    res.status(204).send();
  } catch (e) { next(e); }
};

// ─── CLIENTS ─────────────────────────────────────────────────────
const getClients = async (req, res, next) => {
  try {
    const { search } = req.query;
    const where = { businessId: req.auth.businessId };
    if (search) {
      const like = ilikeOperator();
      where[Op.or] = [
        { nombre:   { [like]: `%${search}%` } },
        { apellido: { [like]: `%${search}%` } },
        { cuit:     { [like]: `%${search}%` } },
        { email:    { [like]: `%${search}%` } },
      ];
    }
    const clients = await Client.findAll({ where, order: [['nombre', 'ASC']] });
    res.json(clients);
  } catch (e) { next(e); }
};
/*
 * Valida los identificadores de un cliente.
 *
 * El CUIT es el dato con el que se emite la factura: mal cargado, el rechazo
 * llega de ARCA con el cliente esperando el comprobante. El email es por donde
 * se manda ese comprobante; con un error de tipeo no llega y nadie se entera.
 */
function errorDeIdentificadores(body) {
  if (body?.cuit && String(body.cuit).trim() && !cuitValido(body.cuit)) {
    return 'El CUIT no es válido: revisá los números. Son 11 dígitos y el último es verificador.';
  }
  if (body?.email && String(body.email).trim() && !emailValido(body.email)) {
    return 'El email no tiene un formato válido.';
  }
  return null;
}

const createClient = async (req, res, next) => {
  try {
    const { nombre } = req.body;
    if (!nombre) return res.status(400).json({ message: 'El nombre es obligatorio.' });
    const malIdent = errorDeIdentificadores(req.body);
    if (malIdent) return res.status(400).json({ message: malIdent });
    // El businessId va DESPUÉS del spread a propósito: al revés, un businessId
    // enviado por el cliente pisaba el de la sesión y el cliente nacía en otro
    // negocio.
    const client = await Client.create({
      ...soloCampos(req.body, CAMPOS_CLIENTE),
      businessId: req.auth.businessId,
    });
    res.status(201).json(client);
  } catch (e) { next(e); }
};
const updateClient = async (req, res, next) => {
  try {
    const malIdent = errorDeIdentificadores(req.body);
    if (malIdent) return res.status(400).json({ message: malIdent });
    const client = await Client.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!client) return res.status(404).json({ message: 'Cliente no encontrado.' });
    await client.update(soloCampos(req.body, CAMPOS_CLIENTE));
    res.json(client);
  } catch (e) { next(e); }
};
const deleteClient = async (req, res, next) => {
  try {
    const client = await Client.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!client) return res.status(404).json({ message: 'Cliente no encontrado.' });
    await client.destroy();
    res.status(204).send();
  } catch (e) { next(e); }
};

// ─── DASHBOARD ───────────────────────────────────────────────────
const getDashboard = async (req, res, next) => {
  try {
    const rangeDays = Math.min(parseInt(req.query.rangeDays, 10) || 30, 365);
    const cutoff    = new Date();
    cutoff.setDate(cutoff.getDate() - rangeDays);
    const businessId = req.auth.businessId;

    const sales = await Sale.findAll({
      where: { businessId, tipo: 'venta', fecha: { [Op.gte]: cutoff.toISOString().slice(0,10) } },
      include: [{ model: SaleItem, as: 'items' }],
    });

    const paid    = sales.filter((s) => s.estado === 'pagado');
    const revenue = paid.reduce((s, v) => s + Number(v.total), 0);
    const pending = sales.filter((s) => s.estado === 'pendiente').reduce((s, v) => s + Number(v.total), 0);

    // Costo de mercadería
    const allSkus = [...new Set(paid.flatMap((s) => s.items.map((i) => i.sku)))];
    // El SKU es único por negocio, no en toda la plataforma: el índice es
    // (businessId, sku). Sin filtrar, dos inquilinos que usen el mismo código
    // —"REMERA-M", "001"— se pisan y el margen sale con el costo del otro.
    const variants = allSkus.length ? await ProductVariant.findAll({
      where: { sku: allSkus, businessId: req.auth.businessId },
      include: [{ model: Product, as: 'producto' }],
    }) : [];
    const costMap  = new Map(variants.map((v) => [v.sku, Number(v.producto.costo)]));

    let cogs = 0;
    const byGroup = new Map();
    for (const s of paid) {
      for (const i of s.items) {
        cogs += (costMap.get(i.sku) || 0) * i.cantidad;
        const key = i.skuAgrupador || i.sku;
        const acc = byGroup.get(key) || { titulo: i.titulo, unidades: 0, facturado: 0 };
        acc.unidades  += i.cantidad;
        acc.facturado += Number(i.subtotal);
        byGroup.set(key, acc);
      }
    }

    // Top de variantes individuales (SKU exacto), además del agrupado por padre.
    // Sirve para ver qué talle/color concreto tiene más salida.
    const byVariant = new Map();
    for (const s of paid) {
      for (const i of s.items) {
        const acc = byVariant.get(i.sku) || {
          sku: i.sku, titulo: i.titulo, skuAgrupador: i.skuAgrupador,
          variante1Nombre: i.variante1Nombre, variante1Valor: i.variante1Valor,
          variante2Nombre: i.variante2Nombre, variante2Valor: i.variante2Valor,
          unidades: 0, facturado: 0,
        };
        acc.unidades  += i.cantidad;
        acc.facturado += Number(i.subtotal);
        byVariant.set(i.sku, acc);
      }
    }

    const byDay = new Map();
    for (const s of paid) byDay.set(s.fecha, (byDay.get(s.fecha) || 0) + Number(s.total));

    const invoices = await Invoice.findAll({ where: { businessId, estado: 'emitida' } });
    const stockBajo = await ProductVariant.findAll({ include: [{ model: Product, as: 'producto', where: { businessId } }], order: [['stock', 'ASC']], limit: 200 });

    // ── Progreso histórico ──────────────────────────────────────────
    // Query aparte sin filtro de fecha: el rango de arriba solo aplica a los
    // KPIs del período, pero la evolución anual necesita todo el historial.
    const historicas = await Sale.findAll({
      where: { businessId, tipo: 'venta', estado: 'pagado' },
      include: [{ model: SaleItem, as: 'items' }],
    });

    const byYear  = new Map();
    const byMonth = new Map();
    for (const s of historicas) {
      const anio = String(s.fecha).slice(0, 4);
      const mes  = String(s.fecha).slice(0, 7); // YYYY-MM
      const unidades = s.items.reduce((n, i) => n + i.cantidad, 0);

      const ay = byYear.get(anio) || { anio, total: 0, ventas: 0, unidades: 0 };
      ay.total += Number(s.total); ay.ventas += 1; ay.unidades += unidades;
      byYear.set(anio, ay);

      const am = byMonth.get(mes) || { mes, total: 0, ventas: 0, unidades: 0 };
      am.total += Number(s.total); am.ventas += 1; am.unidades += unidades;
      byMonth.set(mes, am);
    }

    const serieAnual = Array.from(byYear.values()).sort((a, b) => a.anio.localeCompare(b.anio));
    // Variación año contra año, para mostrar si el negocio crece o cae.
    serieAnual.forEach((a, idx) => {
      const previo = idx > 0 ? serieAnual[idx - 1].total : 0;
      a.variacionPct = previo ? Math.round(((a.total - previo) / previo) * 100) : null;
    });

    res.json({
      revenue, cogs, margin: revenue - cogs,
      marginPct: revenue ? Math.round(((revenue - cogs) / revenue) * 100) : 0,
      pendingAmount: pending,
      salesCount: paid.length,
      ticketPromedio: paid.length ? Math.round(revenue / paid.length) : 0,
      topProducts: Array.from(byGroup.entries()).map(([k, v]) => ({ skuAgrupador: k, ...v })).sort((a, b) => b.unidades - a.unidades).slice(0, 8),
      topVariants: Array.from(byVariant.values()).sort((a, b) => b.unidades - a.unidades).slice(0, 10),
      revenueSeries: Array.from(byDay.entries()).map(([fecha, total]) => ({ fecha, total })).sort((a, b) => a.fecha > b.fecha ? 1 : -1),
      serieAnual,
      serieMensual: Array.from(byMonth.values()).sort((a, b) => a.mes.localeCompare(b.mes)),
      lowStock: stockBajo.filter((v) => v.stock <= v.stockMinimo).slice(0, 10).map((v) => ({ sku: v.sku, titulo: v.producto.titulo, talle: v.variante2Valor, color: v.variante1Valor, stock: v.stock, stockMinimo: v.stockMinimo })),
      invoicesCount: invoices.length,
      invoicesTotal: invoices.reduce((s, i) => s + Number(i.total), 0),
    });
  } catch (e) { next(e); }
};

module.exports = {
  getLocations, createLocation, updateLocation, deleteLocation,
  getRoles, createRole, updateRole, deleteRole,
  getClients, createClient, updateClient, deleteClient,
  getDashboard,
};
