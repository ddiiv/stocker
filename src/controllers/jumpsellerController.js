/*
 * Jumpseller por HTTP.
 *
 * La clave de la tienda entra por acá una sola vez y no vuelve a salir: las
 * respuestas dicen si está conectada y cuándo fue la última sincronización,
 * nunca el Login Key ni el Auth Token.
 */

const jumpseller = require('../services/jumpsellerService');

const status = async (req, res, next) => {
  try {
    res.json(await jumpseller.estado(req.auth.businessId));
  } catch (e) { next(e); }
};

const conectar = async (req, res, next) => {
  try {
    const { loginKey, authToken, tienda } = req.body || {};
    res.json(await jumpseller.conectar(req.auth.businessId, { loginKey, authToken, tienda }));
  } catch (e) { next(e); }
};

const desconectar = async (req, res, next) => {
  try {
    res.json(await jumpseller.desconectar(req.auth.businessId));
  } catch (e) { next(e); }
};

const preview = async (req, res, next) => {
  try {
    res.json(await jumpseller.sincronizarStock(req.auth.businessId, { simular: true }));
  } catch (e) { next(e); }
};

const sync = async (req, res, next) => {
  try {
    const skus = Array.isArray(req.body?.skus) && req.body.skus.length
      ? req.body.skus.map(String)
      : null;
    res.json(await jumpseller.sincronizarStock(req.auth.businessId, { simular: false, skus }));
  } catch (e) { next(e); }
};

module.exports = { status, conectar, desconectar, preview, sync };
