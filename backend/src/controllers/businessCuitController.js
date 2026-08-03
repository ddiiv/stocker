const { BusinessCuit, sequelize } = require('../models');
const seq = require('../config/database');

const MAX_CUITS = 3;

// GET /api/business-cuits
const list = async (req, res, next) => {
  try {
    const rows = await BusinessCuit.findAll({
      where: { businessId: req.auth.businessId },
      order: [['esPrincipal', 'DESC'], ['nombre', 'ASC']],
    });
    res.json(rows);
  } catch (e) { next(e); }
};

// POST /api/business-cuits
const create = async (req, res, next) => {
  const t = await seq.transaction();
  try {
    const count = await BusinessCuit.count({ where: { businessId: req.auth.businessId }, transaction: t });
    if (count >= MAX_CUITS) {
      await t.rollback();
      return res.status(400).json({ message: `Máximo ${MAX_CUITS} CUITs por negocio.` });
    }
    const { nombre, cuit, condicionIva, domicilio, esPrincipal } = req.body;
    if (!nombre?.trim() || !cuit?.trim()) {
      await t.rollback();
      return res.status(400).json({ message: 'Nombre y CUIT son obligatorios.' });
    }
    // Si viene esPrincipal=true, primero limpio los otros principales
    if (esPrincipal) {
      await BusinessCuit.update({ esPrincipal: false }, { where: { businessId: req.auth.businessId }, transaction: t });
    }
    const created = await BusinessCuit.create({
      businessId:   req.auth.businessId,
      nombre:       nombre.trim(),
      cuit:         String(cuit).replace(/[^0-9]/g, ''),
      condicionIva: condicionIva || null,
      domicilio:    domicilio || null,
      esPrincipal:  !!esPrincipal || count === 0,
    }, { transaction: t });
    await t.commit();
    res.status(201).json(created);
  } catch (e) { await t.rollback(); next(e); }
};

// PUT /api/business-cuits/:id
const update = async (req, res, next) => {
  const t = await seq.transaction();
  try {
    const row = await BusinessCuit.findOne({ where: { id: req.params.id, businessId: req.auth.businessId }, transaction: t });
    if (!row) { await t.rollback(); return res.status(404).json({ message: 'CUIT no encontrado.' }); }
    if (req.body.esPrincipal === true && !row.esPrincipal) {
      await BusinessCuit.update({ esPrincipal: false }, { where: { businessId: req.auth.businessId }, transaction: t });
    }
    const patch = { ...req.body };
    if (patch.cuit) patch.cuit = String(patch.cuit).replace(/[^0-9]/g, '');
    await row.update(patch, { transaction: t });
    await t.commit();
    res.json(row);
  } catch (e) { await t.rollback(); next(e); }
};

// DELETE /api/business-cuits/:id
const remove = async (req, res, next) => {
  try {
    const row = await BusinessCuit.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!row) return res.status(404).json({ message: 'CUIT no encontrado.' });
    if (row.esPrincipal) {
      const count = await BusinessCuit.count({ where: { businessId: req.auth.businessId } });
      if (count === 1) return res.status(400).json({ message: 'No podés eliminar el único CUIT del negocio.' });
      return res.status(400).json({ message: 'Marcá otro CUIT como principal antes de eliminar éste.' });
    }
    await row.destroy();
    res.status(204).send();
  } catch (e) { next(e); }
};

module.exports = { list, create, update, remove, MAX_CUITS };
