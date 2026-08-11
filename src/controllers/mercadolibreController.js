const ml = require('../services/mercadolibreService');
const { MercadoLibreAccount, MercadoLibreLink } = require('../models');

// GET /api/mercadolibre/status
const status = async (req, res, next) => {
  try {
    if (!ml.estaConfigurado()) {
      return res.json({
        configurado: false,
        conectado: false,
        hint: 'Faltan las variables ML_CLIENT_ID, ML_CLIENT_SECRET y ML_REDIRECT_URI en el servidor. Creá una app en developers.mercadolibre.com.ar y cargalas.',
      });
    }
    const cuenta = await MercadoLibreAccount.findOne({ where: { businessId: req.auth.businessId } });
    if (!cuenta) return res.json({ configurado: true, conectado: false });

    const vinculos = await MercadoLibreLink.count({ where: { businessId: req.auth.businessId } });
    res.json({
      configurado: true,
      conectado: Boolean(cuenta.refreshToken),
      nickname:    cuenta.nickname,
      mlUserId:    cuenta.mlUserId,
      syncActiva:  cuenta.syncActiva,
      ultimaSync:  cuenta.ultimaSync,
      ultimoError: cuenta.ultimoError,
      vinculosManuales: vinculos,
    });
  } catch (e) { next(e); }
};

// GET /api/mercadolibre/auth-url  → devuelve la URL de autorización de ML
const authUrl = async (req, res, next) => {
  try {
    if (!ml.estaConfigurado()) {
      return res.status(400).json({ message: 'La integración con MercadoLibre no está configurada en el servidor.' });
    }
    res.json({ url: ml.urlAutorizacion(req.auth.businessId) });
  } catch (e) { next(e); }
};

// GET /api/mercadolibre/callback?code=...&state=businessId
// ML redirige acá después de que el usuario autoriza. Es una ruta pública
// (ML no manda nuestro JWT), por eso el businessId viaja en `state`.
const callback = async (req, res, next) => {
  try {
    const { code, state, error, error_description: errorDescription } = req.query;
    const frontUrl = process.env.FRONTEND_URL || '';
    const volver = (params) => res.redirect(`${frontUrl}/integraciones/mercadolibre?${new URLSearchParams(params)}`);

    if (error) return volver({ ml_error: errorDescription || error });
    if (!code || !state) return volver({ ml_error: 'Faltan parámetros en la respuesta de MercadoLibre.' });

    // El state tiene que ser uno que hayamos firmado nosotros: si no, alguien
    // está intentando enganchar su cuenta de ML a un negocio ajeno.
    const businessId = ml.leerState(state);
    if (!businessId) {
      return volver({ ml_error: 'La autorización no es válida o venció. Reintentá desde la app.' });
    }

    await ml.conectarConCodigo({ businessId, code });
    volver({ ml_ok: '1' });
  } catch (e) {
    const frontUrl = process.env.FRONTEND_URL || '';
    const detalle = e.response?.data?.message || e.message;
    res.redirect(`${frontUrl}/integraciones/mercadolibre?${new URLSearchParams({ ml_error: detalle })}`);
  }
};

// DELETE /api/mercadolibre/disconnect
const disconnect = async (req, res, next) => {
  try {
    await MercadoLibreAccount.destroy({ where: { businessId: req.auth.businessId } });
    res.status(204).send();
  } catch (e) { next(e); }
};

// GET /api/mercadolibre/preview  → qué cambiaría una sincronización (sin enviar nada)
const preview = async (req, res, next) => {
  try {
    const resultado = await ml.sincronizarStock(req.auth.businessId, { simular: true });
    res.json(resultado);
  } catch (e) { next(e); }
};

// POST /api/mercadolibre/sync  → sincroniza de verdad
const sync = async (req, res, next) => {
  try {
    const { skus } = req.body || {};
    const resultado = await ml.sincronizarStock(req.auth.businessId, {
      simular: false,
      skus: Array.isArray(skus) && skus.length ? skus : null,
    });
    res.json(resultado);
  } catch (e) { next(e); }
};

// ── Vínculos manuales SKU ↔ publicación ──────────────────────────
const listLinks = async (req, res, next) => {
  try {
    const links = await MercadoLibreLink.findAll({
      where: { businessId: req.auth.businessId }, order: [['sku', 'ASC']],
    });
    res.json(links);
  } catch (e) { next(e); }
};

const upsertLink = async (req, res, next) => {
  try {
    const { sku, mlItemId, mlVariationId, titulo } = req.body;
    if (!sku || !mlItemId) return res.status(400).json({ message: 'sku y mlItemId son obligatorios.' });

    const valores = {
      businessId: req.auth.businessId,
      sku: String(sku).trim(),
      mlItemId: String(mlItemId).trim(),
      mlVariationId: mlVariationId ? String(mlVariationId).trim() : null,
      titulo: titulo || null,
    };
    const [link, creado] = await MercadoLibreLink.findOrCreate({
      where: { businessId: valores.businessId, sku: valores.sku }, defaults: valores,
    });
    if (!creado) await link.update(valores);
    res.status(creado ? 201 : 200).json(link);
  } catch (e) { next(e); }
};

const deleteLink = async (req, res, next) => {
  try {
    const borrados = await MercadoLibreLink.destroy({
      where: { id: req.params.id, businessId: req.auth.businessId },
    });
    if (!borrados) return res.status(404).json({ message: 'Vínculo no encontrado.' });
    res.status(204).send();
  } catch (e) { next(e); }
};

module.exports = { status, authUrl, callback, disconnect, preview, sync, listLinks, upsertLink, deleteLink };
