const { exigirLibre } = require('../services/cuitRegistry');
const { BusinessCuit, sequelize } = require('../models');
const seq = require('../config/database');
const { exigirCupo } = require('../services/planService');
const { prepararLogo } = require('../utils/logoFactura');

const MAX_CUITS = 3;

/*
 * Ingresos Brutos e Inicio de Actividades, como los acepta la base.
 *
 * Vacío es null y no "": el PDF de la factura no imprime el renglón cuando el
 * dato falta, y un string vacío lo dejaría con la etiqueta sola. La fecha se
 * exige AAAA-MM-DD porque es lo que manda el selector de fecha; otra cosa es
 * un error de quien llama, y se dice en vez de guardar una fecha inventada.
 */
function datosFiscales(body) {
  const patch = {};
  if (body.ingresosBrutos !== undefined) {
    const iibb = String(body.ingresosBrutos ?? '').trim().slice(0, 40);
    patch.ingresosBrutos = iibb || null;
  }
  if (body.inicioActividades !== undefined) {
    const f = String(body.inicioActividades ?? '').trim();
    if (!f) patch.inicioActividades = null;
    else {
      const m = f.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
      if (!d || d.getUTCDate() !== +m[3] || d.getUTCMonth() !== +m[2] - 1) {
        throw Object.assign(new Error('La fecha de inicio de actividades no es válida (AAAA-MM-DD).'), { status: 400 });
      }
      patch.inicioActividades = f;
    }
  }
  return patch;
}

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
    const fiscales = datosFiscales(req.body);
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
      ...fiscales,
      esPrincipal:  !!esPrincipal || count === 0,
    }, { transaction: t });
    await t.commit();
    res.status(201).json(created);
  } catch (e) { await t.rollback().catch(() => {}); next(e); }
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
    Object.assign(patch, datosFiscales(req.body));

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
  } catch (e) { await t.rollback().catch(() => {}); next(e); }
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

/*
 * ── El logo de la factura ───────────────────────────────────────────
 *
 * Tres caminos (subir o reemplazar, ver, quitar), siempre sobre un CUIT del
 * negocio de la SESIÓN: el id de la URL sólo elige entre los CUITs propios.
 * Un CUIT de otro negocio contesta 404, igual que uno que no existe, para no
 * confirmar que existe.
 */
function cuitDeLaSesion(req, { conLogo = false } = {}) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const modelo = conLogo ? BusinessCuit.unscoped() : BusinessCuit;
  return modelo.findOne({ where: { id, businessId: req.auth.businessId } });
}

// PUT /api/business-cuits/:id/logo  (multipart, campo "logo")
const subirLogo = async (req, res, next) => {
  try {
    const row = await cuitDeLaSesion(req);
    if (!row) return res.status(404).json({ message: 'CUIT no encontrado.' });
    // Lo que se guarda no es el archivo que llegó: ver prepararLogo.
    const logo = prepararLogo(req.file?.buffer);
    await row.update({ logo: logo.datos, logoTipo: logo.tipo, logoActualizadoEn: new Date() });
    res.json(row);
  } catch (e) { next(e); }
};

// GET /api/business-cuits/:id/logo  → la imagen
const verLogo = async (req, res, next) => {
  try {
    const row = await cuitDeLaSesion(req, { conLogo: true });
    if (!row?.logo || !row.logoTipo) return res.status(404).json({ message: 'Este CUIT no tiene logo.' });
    /*
     * El tipo es el que se comprobó al subirlo, nunca uno que haya mandado el
     * navegador, y con nosniff el navegador no adivina otro. index.js ya lo
     * pone en todas las respuestas; acá va igual porque ésta es la que sirve
     * un archivo subido por un usuario. `no-cache`: al reemplazarlo, la
     * pantalla tiene que ver el nuevo y no el que quedó guardado.
     */
    res.set('Content-Type', row.logoTipo);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, no-cache');
    res.send(Buffer.from(row.logo));
  } catch (e) { next(e); }
};

// DELETE /api/business-cuits/:id/logo  → la factura vuelve a llevar el nombre
const quitarLogo = async (req, res, next) => {
  try {
    const row = await cuitDeLaSesion(req);
    if (!row) return res.status(404).json({ message: 'CUIT no encontrado.' });
    /*
     * NULL escrito como SQL y no como parámetro: SQL Server recibe un null de
     * JavaScript como texto (nvarchar), no lo convierte solo a binario y la
     * actualización falla. Postgres lo acepta de las dos formas.
     */
    await row.update({ logo: seq.literal('NULL'), logoTipo: null, logoActualizadoEn: null });
    res.json(row);
  } catch (e) { next(e); }
};

module.exports = {
  list, create, update, remove, subirLogo, verLogo, quitarLogo, MAX_CUITS, __datosFiscales: datosFiscales,
};
