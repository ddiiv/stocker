/*
 * Confección de los SKU de las variantes.
 *
 * Toda la composición vive acá y en ningún otro lado. Es tentador repetir la
 * fórmula en el front para la vista previa, pero dos copias de la misma regla
 * se separan en el primer retoque y el resultado es peor que no tener vista
 * previa: la pantalla muestra un SKU y la base guarda otro. El front pide la
 * vista previa a la API.
 *
 * La regla es por negocio y sale de businesses.reglaSku. Sin nada cargado
 * valen las de fábrica, que reproducen la convención que ya se usaba: el SKU
 * agrupador, un guión, y los códigos de cada valor pegados uno atrás del otro.
 */

const { Op } = require('sequelize');
const { Business, ProductVariant } = require('../models');

const REGLA_POR_DEFECTO = {
  // Cuántas letras se toman de cada valor. Tres alcanzan para leerlo de un
  // vistazo sin que el SKU se vuelva ilegible.
  caracteres: 3,
  // Entre el agrupador y los códigos. Con guión, para no romper la lectura de
  // los SKU que ya existen.
  separadorAgrupador: '-',
  // Entre un código y el siguiente: nada, van pegados.
  separadorValores: '',
  mayusculas: true,
  quitarAcentos: true,
  /*
   * Excepciones por valor: { "Color": { "Azul Marino": "AZM" } }.
   *
   * Existen porque tres letras chocan seguido y de forma predecible: "Azul
   * Marino" y "Azul Claro" dan las dos "AZU". La pantalla de confección detecta
   * esos choques y ofrece corregirlos acá, que es la única forma de arreglarlo
   * sin alargar todos los SKU del catálogo.
   */
  abreviaturas: {},
};

function reglaCompleta(guardada) {
  const r = { ...REGLA_POR_DEFECTO, ...(guardada || {}) };
  /*
   * Los límites no son estéticos: `sku` es STRING(100), y de un SKU de una
   * letra por valor no se entiende nada.
   *
   * El cero se trata aparte porque `Number(0) || 3` devuelve 3: el `||` no
   * distingue "no vino nada" de "vino un cero", y un campo numérico vaciado a
   * mano manda exactamente eso. Sin esto, borrar el campo salta en silencio de
   * 0 a 3 mientras el usuario ve el casillero vacío.
   */
  const chars = Number(r.caracteres);
  r.caracteres = Number.isFinite(chars)
    ? Math.min(10, Math.max(1, Math.trunc(chars)))
    : REGLA_POR_DEFECTO.caracteres;
  r.separadorAgrupador = String(r.separadorAgrupador ?? '').slice(0, 3);
  r.separadorValores = String(r.separadorValores ?? '').slice(0, 3);
  r.mayusculas = r.mayusculas !== false;
  r.quitarAcentos = r.quitarAcentos !== false;
  r.abreviaturas = (r.abreviaturas && typeof r.abreviaturas === 'object') ? r.abreviaturas : {};
  return r;
}

/*
 * Deja un texto en condiciones de entrar en un SKU.
 *
 * Fuera lo que no sea letra o número. Los acentos se sacan antes de filtrar:
 * si no, "Marrón" perdería la Ó y quedaría "MARRN", que es peor que "MARRON".
 */
function normalizar(texto, regla) {
  let t = String(texto ?? '').trim();
  if (regla.quitarAcentos) t = t.normalize('NFD').replace(/[̀-ͯ]/g, '');
  t = t.replace(/[^a-zA-Z0-9]/g, '');
  return regla.mayusculas ? t.toUpperCase() : t;
}

/** El código de un valor: su excepción si tiene, o sus primeras N letras. */
function codigoDe(nombreEje, valor, regla) {
  if (!valor) return '';
  const excepcion = regla.abreviaturas?.[nombreEje]?.[valor];
  if (excepcion) return normalizar(excepcion, regla);
  return normalizar(valor, regla).slice(0, regla.caracteres);
}

/**
 * Arma el SKU de una combinación.
 *
 * `valores` es [{ eje, valor }] en el orden en que van.
 */
function componer({ agrupador, valores = [], regla }) {
  const r = reglaCompleta(regla);
  const codigos = valores
    .map(({ eje, valor }) => codigoDe(eje, valor, r))
    .filter(Boolean);

  const base = normalizar(agrupador, { ...r, quitarAcentos: true });
  const cola = codigos.join(r.separadorValores);

  // Un producto sin variantes es su propio SKU: sin cola no se agrega el
  // separador, que quedaría colgando al final.
  if (!cola) return String(agrupador || base);
  return `${agrupador || base}${r.separadorAgrupador}${cola}`;
}

/** La regla de un negocio, ya completada con los valores de fábrica. */
async function reglaDe(businessId) {
  const b = await Business.findByPk(businessId, { attributes: ['id', 'reglaSku'] });
  return reglaCompleta(b?.reglaSku);
}

async function guardarRegla(businessId, regla) {
  const b = await Business.findByPk(businessId);
  if (!b) return null;
  const limpia = reglaCompleta(regla);
  await b.update({ reglaSku: limpia });
  return limpia;
}

/**
 * ¿Está libre este SKU en el negocio?
 *
 * `exceptoVariantId` es para la edición: al guardar sin cambiar el SKU, la
 * propia variante no puede contarse como su propio conflicto.
 */
async function estaLibre(businessId, sku, exceptoVariantId = null) {
  const where = { businessId, sku: String(sku).trim() };
  if (exceptoVariantId) where.id = { [Op.ne]: exceptoVariantId };
  return (await ProductVariant.count({ where })) === 0;
}

/**
 * Devuelve un SKU libre partiendo de `base`.
 *
 * Si está tomado prueba base-2, base-3… Se corta a los 50 intentos y devuelve
 * null: llegar ahí significa que la regla produce choques en masa y hay que
 * arreglar la regla, no seguir numerando.
 */
async function liberar(businessId, base, exceptoVariantId = null) {
  const raiz = String(base).trim().slice(0, 90);
  if (await estaLibre(businessId, raiz, exceptoVariantId)) return raiz;
  for (let i = 2; i <= 50; i++) {
    const intento = `${raiz}-${i}`;
    if (await estaLibre(businessId, intento, exceptoVariantId)) return intento;
  }
  return null;
}

/*
 * Vista previa de todas las combinaciones, con los choques marcados.
 *
 * Los choques se calculan entre sí y contra lo que ya está en la base: un SKU
 * puede ser único dentro de este producto y estar tomado por otro.
 */
async function vistaPrevia({ businessId, agrupador, ejes = [], regla }) {
  const r = reglaCompleta(regla);
  const [eje1, eje2] = ejes;
  const valores1 = eje1?.valores?.length ? eje1.valores : [null];
  const valores2 = eje2?.valores?.length ? eje2.valores : [null];

  const filas = [];
  for (const v1 of valores1) {
    for (const v2 of valores2) {
      const combo = [
        eje1 && v1 ? { eje: eje1.nombre, valor: v1 } : null,
        eje2 && v2 ? { eje: eje2.nombre, valor: v2 } : null,
      ].filter(Boolean);
      filas.push({ valores: combo, sku: componer({ agrupador, valores: combo, regla: r }) });
    }
  }

  // Choques dentro de la propia tabla.
  const cuenta = new Map();
  for (const f of filas) cuenta.set(f.sku, (cuenta.get(f.sku) || 0) + 1);

  // Y contra el catálogo. Una sola consulta con todos los SKU: uno por fila
  // serían cientos de consultas para una pantalla que se redibuja al tipear.
  const tomados = new Set();
  if (businessId && filas.length) {
    const existentes = await ProductVariant.findAll({
      where: { businessId, sku: { [Op.in]: [...new Set(filas.map((f) => f.sku))] } },
      attributes: ['sku'],
    });
    existentes.forEach((v) => tomados.add(v.sku));
  }

  /*
   * Qué valores son la causa del choque, eje por eje.
   *
   * No alcanza con marcar las filas repetidas: en una tabla de Color × Talle,
   * si dos colores dan el mismo código, TODAS sus filas salen repetidas y los
   * talles aparecen involucrados sin tener nada que ver. Abreviar un talle no
   * arregla nada — hay que abreviar el color.
   *
   * Acá se agrupa por código dentro de cada eje: los valores que comparten
   * código son los culpables, y son los únicos que conviene ofrecer.
   */
  const detalleEjes = [];
  for (const eje of [eje1, eje2]) {
    if (!eje?.valores?.length) continue;
    const porCodigo = new Map();
    const codigos = eje.valores.map((valor) => {
      const codigo = codigoDe(eje.nombre, valor, r);
      porCodigo.set(codigo, (porCodigo.get(codigo) || 0) + 1);
      return { valor, codigo };
    });
    detalleEjes.push({
      nombre: eje.nombre,
      valores: codigos.map((c) => ({ ...c, choca: porCodigo.get(c.codigo) > 1 })),
    });
  }

  return {
    filas: filas.map((f) => ({
      ...f,
      duplicadoEnLaTabla: cuenta.get(f.sku) > 1,
      yaExiste: tomados.has(f.sku),
    })),
    ejes: detalleEjes,
  };
}

module.exports = {
  REGLA_POR_DEFECTO, reglaCompleta, normalizar, codigoDe,
  componer, reglaDe, guardarRegla, estaLibre, liberar, vistaPrevia,
};
