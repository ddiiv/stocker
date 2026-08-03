const { Op } = require('sequelize');
const bcrypt = require('bcryptjs');
const { BusinessLocation, Role, Client, Sale, SaleItem, Invoice, ProductVariant, Product, StockMovement } = require('../models');

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
    const role = await Role.create({ businessId: req.auth.businessId, nombre, permisos });
    res.status(201).json(role);
  } catch (e) { next(e); }
};
const updateRole = async (req, res, next) => {
  try {
    const role = await Role.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!role) return res.status(404).json({ message: 'Cargo no encontrado.' });
    await role.update(req.body);
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
    if (search) where[Op.or] = [
      { nombre:   { [Op.like]: `%${search}%` } },
      { apellido: { [Op.like]: `%${search}%` } },
      { cuit:     { [Op.like]: `%${search}%` } },
      { email:    { [Op.like]: `%${search}%` } },
    ];
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

    const byDay = new Map();
    for (const s of paid) byDay.set(s.fecha, (byDay.get(s.fecha) || 0) + Number(s.total));

    const invoices = await Invoice.findAll({ where: { businessId, estado: 'emitida' } });
    const stockBajo = await ProductVariant.findAll({ include: [{ model: Product, as: 'producto', where: { businessId } }], order: [['stock', 'ASC']], limit: 200 });

    res.json({
      revenue, cogs, margin: revenue - cogs,
      marginPct: revenue ? Math.round(((revenue - cogs) / revenue) * 100) : 0,
      pendingAmount: pending,
      salesCount: paid.length,
      ticketPromedio: paid.length ? Math.round(revenue / paid.length) : 0,
      topProducts: Array.from(byGroup.entries()).map(([k, v]) => ({ skuAgrupador: k, ...v })).sort((a, b) => b.unidades - a.unidades).slice(0, 8),
      revenueSeries: Array.from(byDay.entries()).map(([fecha, total]) => ({ fecha, total })).sort((a, b) => a.fecha > b.fecha ? 1 : -1),
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
