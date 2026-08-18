/*
 * Reglas de confección de SKU y su vista previa.
 *
 * La composición no está acá sino en services/skuService: este archivo sólo
 * traduce pedidos HTTP. Es para que la fórmula tenga un único dueño — la usan
 * también el alta de productos y la importación de Excel.
 */

const { VariantType } = require('../models');
const sku = require('../services/skuService');

// GET /api/sku/regla
const getRegla = async (req, res, next) => {
  try {
    const [regla, ejes] = await Promise.all([
      sku.reglaDe(req.auth.businessId),
      VariantType.findAll({ where: { businessId: req.auth.businessId }, order: [['nombre', 'ASC']] }),
    ]);
    // Los ejes viajan con la regla porque la pantalla los necesita para la
    // vista previa: sin valores reales, previsualizar no muestra nada.
    res.json({
      regla,
      porDefecto: sku.REGLA_POR_DEFECTO,
      ejes: ejes.map((e) => ({ id: e.id, nombre: e.nombre, valores: e.valores })),
    });
  } catch (e) { next(e); }
};

// PUT /api/sku/regla
const putRegla = async (req, res, next) => {
  try {
    const guardada = await sku.guardarRegla(req.auth.businessId, req.body?.regla || {});
    if (!guardada) return res.status(404).json({ message: 'Negocio no encontrado.' });
    res.json({ regla: guardada });
  } catch (e) { next(e); }
};

/*
 * POST /api/sku/vista-previa
 *
 * La regla llega en el cuerpo y no se lee de la base a propósito: la pantalla
 * previsualiza mientras se toca, antes de guardar. Guardar para poder ver el
 * resultado obligaría a pisar la regla en uso para probar una idea.
 */
const vistaPrevia = async (req, res, next) => {
  try {
    const { agrupador = '', ejes = [], regla } = req.body || {};
    if (!Array.isArray(ejes) || ejes.length > 2) {
      return res.status(400).json({ message: 'Máximo 2 dimensiones de variante.' });
    }
    const { filas, ejes: detalle } = await sku.vistaPrevia({ businessId: req.auth.businessId, agrupador, ejes, regla });
    res.json({
      filas,
      ejes: detalle,
      // Se cuentan acá y no en la pantalla: es el número que decide si la regla
      // sirve o no, y tiene que salir de la misma fórmula que armó los SKU.
      choques: filas.filter((f) => f.duplicadoEnLaTabla).length,
      tomados: filas.filter((f) => f.yaExiste).length,
    });
  } catch (e) { next(e); }
};

/*
 * POST /api/sku/sugerir
 *
 * Para el alta de una variante suelta. Devuelve el SKU que sale de la regla y,
 * si está ocupado, el primero libre — pero informa las dos cosas por separado:
 * cambiar el SKU sin avisar es cómo se terminan teniendo dos productos que el
 * dueño cree que son el mismo.
 */
const sugerir = async (req, res, next) => {
  try {
    const { agrupador = '', valores = [], exceptoVariantId = null } = req.body || {};
    const regla = await sku.reglaDe(req.auth.businessId);
    const base = sku.componer({ agrupador, valores, regla });
    const libre = await sku.estaLibre(req.auth.businessId, base, exceptoVariantId);
    const alternativa = libre ? base : await sku.liberar(req.auth.businessId, base, exceptoVariantId);
    res.json({ sku: base, libre, sugerido: alternativa });
  } catch (e) { next(e); }
};

// GET /api/sku/disponible?sku=...&exceptoVariantId=...
const disponible = async (req, res, next) => {
  try {
    const valor = String(req.query.sku || '').trim();
    if (!valor) return res.status(400).json({ message: 'Falta el SKU.' });
    const excepto = req.query.exceptoVariantId ? Number(req.query.exceptoVariantId) : null;
    res.json({ sku: valor, libre: await sku.estaLibre(req.auth.businessId, valor, excepto) });
  } catch (e) { next(e); }
};

module.exports = { getRegla, putRegla, vistaPrevia, sugerir, disponible };
