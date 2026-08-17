const { exigirLibre } = require('../services/cuitRegistry');
const { BusinessCuit, sequelize } = require('../models');
const seq = require('../config/database');
const { exigirCupo } = require('../services/planService');

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
    // Multi-CUIT es parte de lo que separa un plan del otro: Inicial 1,
    // Pro 2, Enterprise sin tope.
    await exigirCupo(req.auth.businessId, 'cuits');

    const { nombre, cuit, condicionIva, domicilio, esPrincipal } = req.body;
    if (!nombre?.trim() || !cuit?.trim()) {
      await t.rollback();
      return res.status(400).json({ message: 'Nombre y CUIT son obligatorios.' });
    }
    /*
     * El CUIT no puede estar en uso en ningún otro negocio — ni como cuenta,
     * ni como principal, ni como secundario. Dos negocios facturando con el
     * mismo CUIT se pisan la numeración de comprobantes ante AFIP.
     */
    await exigirLibre(cuit, { businessId: req.auth.businessId });

    // Repetido dentro del propio negocio: exigirLibre lo excluye a propósito
    // (para poder editar sin chocar consigo mismo), así que este caso llegaba
    // hasta la restricción de la base y devolvía su nombre interno al usuario.
    const cuitLimpio = String(cuit).replace(/[^0-9]/g, '');
    const yaEnEsteNegocio = await BusinessCuit.findOne({
      where: { businessId: req.auth.businessId, cuit: cuitLimpio },
      transaction: t,
    });
    if (yaEnEsteNegocio) {
      await t.rollback();
      return res.status(409).json({ message: `Ya tenés cargado el CUIT ${cuitLimpio} en este negocio.` });
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
    /*
     * El CUIT principal es el de la cuenta: se fijó al registrarse y no se
     * toca. Cambiarlo dejaría la cuenta facturando con un CUIT distinto del
     * que la identifica, y las facturas ya emitidas quedarían huérfanas.
     * Los datos descriptivos (nombre, domicilio, condición) sí se editan.
     */
    const patch = {};
    if (req.body.nombre !== undefined)       patch.nombre = String(req.body.nombre).trim();
    if (req.body.condicionIva !== undefined) patch.condicionIva = req.body.condicionIva || null;
    if (req.body.domicilio !== undefined)    patch.domicilio = req.body.domicilio || null;

    const cuitPedido = req.body.cuit !== undefined ? String(req.body.cuit).replace(/[^0-9]/g, '') : null;
    if (cuitPedido && cuitPedido !== String(row.cuit).replace(/[^0-9]/g, '')) {
      if (row.esPrincipal) {
        await t.rollback();
        return res.status(400).json({
          message: 'El CUIT principal es el de la cuenta y no se puede cambiar. Si necesitás facturar con otro CUIT, agregalo como CUIT adicional.',
        });
      }
      await exigirLibre(cuitPedido, { businessId: req.auth.businessId, businessCuitId: row.id });
      patch.cuit = cuitPedido;
    }

    // Cambiar cuál es el principal también movería el CUIT de facturación de
    // la cuenta: el principal lo define el registro, no esta pantalla.
    if (req.body.esPrincipal === true && !row.esPrincipal) {
      await t.rollback();
      return res.status(400).json({
        message: 'El CUIT principal es el de la cuenta y no se puede reasignar desde acá.',
      });
    }

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
