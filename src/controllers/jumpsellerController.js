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

/*
 * Traer las ventas anteriores. Como la sincronización: contesta que arrancó.
 */
const importar = async (req, res, next) => {
  try {
    const { businessId } = req.auth;
    const opciones = { dias: req.body?.dias, tope: req.body?.tope };
    const trabajo = trabajos.iniciar(`jumpseller-import:${businessId}`, (avisar) => jumpseller
      .importarPedidos(businessId, { ...opciones, onProgreso: avisar })
      .then((r) => ({ ok: true, ...r, mensaje: mensajeDeImportacion(r) })));
    res.status(202).json(trabajo);
  } catch (e) { next(e); }
};

/** Cómo viene la importación que está corriendo, o cómo terminó la última. */
const importarEstado = async (req, res, next) => {
  try {
    res.json(trabajos.estado(`jumpseller-import:${req.auth.businessId}`));
  } catch (e) { next(e); }
};

/*
 * El resumen cuenta lo que se salteó y por qué: "se importaron 3" sobre veinte
 * ventas encontradas hace pensar que algo se rompió.
 */
function mensajeDeImportacion(r) {
  const partes = [`${r.importados} pedido(s) importado(s)`];
  if (r.repetidos) partes.push(`${r.repetidos} ya estaban`);
  if (r.sinStock) partes.push(`${r.sinStock} sin stock para apartar`);
  if (r.conAvisos) partes.push(`${r.conAvisos} apartado(s) a medias`);
  if (r.sinSku) partes.push(`${r.sinSku} con líneas sin SKU`);
  if (r.sinLineas) partes.push(`${r.sinLineas} sin líneas para apartar`);
  if (r.errores.length) partes.push(`${r.errores.length} con error`);
  return `Se revisaron ${r.encontrados} venta(s) pagadas y sin despachar desde el `
    + `${new Date(r.desde).toLocaleDateString('es-AR')}: ${partes.join(', ')}.`
    + (r.truncado ? ' Quedaron ventas sin revisar: pedí un rango más corto para traer el resto.' : '');
}

/** Cómo viene la sincronización que está corriendo, o cómo terminó la última. */
const syncEstado = async (req, res, next) => {
  try {
    res.json(trabajos.estado(claveDe(req.auth.businessId)));
  } catch (e) { next(e); }
};

module.exports = { status, conectar, desconectar, preview, sync, syncEstado, importar, importarEstado };
