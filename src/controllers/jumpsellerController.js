/*
 * Jumpseller por HTTP.
 *
 * La clave de la tienda entra por acá una sola vez y no vuelve a salir: las
 * respuestas dicen si está conectada y cuándo fue la última sincronización,
 * nunca el Login Key ni el Auth Token.
 */

const jumpseller = require('../services/jumpsellerService');
const trabajos = require('../services/trabajosService');

const claveDe = (businessId) => `jumpseller:${businessId}`;

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

/*
 * Sincronizar no contesta la sincronización: contesta que arrancó.
 *
 * Con novecientos productos y sus variantes son miles de escrituras, minutos
 * de trabajo. Adentro del pedido, el proxy lo corta a la mitad —"la aplicación
 * no respondió"— y nadie sabe qué alcanzó a mandarse. Ahora corre en el
 * servidor y la pantalla pregunta cómo viene.
 */
const sync = async (req, res, next) => {
  try {
    const { businessId } = req.auth;
    const skus = Array.isArray(req.body?.skus) && req.body.skus.length
      ? req.body.skus.map(String)
      : null;
    const trabajo = trabajos.iniciar(claveDe(businessId), (avisar) => jumpseller.sincronizarStock(
      businessId, { simular: false, skus, onProgreso: avisar },
    ));
    res.status(202).json(trabajo);
  } catch (e) { next(e); }
};

/** Cómo viene la sincronización que está corriendo, o cómo terminó la última. */
const syncEstado = async (req, res, next) => {
  try {
    res.json(trabajos.estado(claveDe(req.auth.businessId)));
  } catch (e) { next(e); }
};

module.exports = { status, conectar, desconectar, preview, sync, syncEstado };
