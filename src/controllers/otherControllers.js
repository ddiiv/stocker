const { Op } = require('sequelize');
const { sanitizarPermisos } = require('../config/permisos');
const bcrypt = require('bcryptjs');
const { BusinessLocation, Role, Client, Sale, SaleItem, Invoice, ProductVariant, Product, StockMovement } = require('../models');
const { ilikeOperator } = require('../utils/sqlHelpers');

// ─── LOCATIONS ────────────────────────────────────────────────────
const getLocations = async (req, res, next) => {
  try {
    const locs = await BusinessLocation.findAll({ where: { businessId: req.auth.businessId }, order: [['nombre', 'ASC']] });
    res.json(locs);
  } catch (e) { next(e); }
};
const createLocation = async (req, res, next) => {
  try {
    const { nombre, direccion, telefono } = req.body;
    if (!nombre || !direccion) return res.status(400).json({ message: 'Nombre y dirección son obligatorios.' });
    const loc = await BusinessLocation.create({ businessId: req.auth.businessId, nombre, direccion, telefono });
    res.status(201).json(loc);
  } catch (e) { next(e); }
};
const updateLocation = async (req, res, next) => {
  try {
    const loc = await BusinessLocation.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!loc) return res.status(404).json({ message: 'Local no encontrado.' });
    await loc.update(req.body);
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
const createClient = async (req, res, next) => {
  try {
    const { nombre } = req.body;
    if (!nombre) return res.status(400).json({ message: 'El nombre es obligatorio.' });
    const client = await Client.create({ businessId: req.auth.businessId, ...req.body });
    res.status(201).json(client);
  } catch (e) { next(e); }
};
const updateClient = async (req, res, next) => {
  try {
    const client = await Client.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!client) return res.status(404).json({ message: 'Cliente no encontrado.' });
    await client.update(req.body);
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
    const variants = allSkus.length ? await ProductVariant.findAll({ where: { sku: allSkus }, include: [{ model: Product, as: 'producto' }] }) : [];
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
