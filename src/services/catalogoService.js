/*
 * Catálogo descargable: una fila por producto padre.
 *
 * No es el export de productos. Aquél es una planilla de trabajo —una fila por
 * variante, con stock por local— pensada para editar y reimportar. Éste es para
 * mandarle a un cliente o pasarle a quien arma la tienda: qué modelos hay, en
 * qué colores y talles, cuánto valen y qué dicen. Por eso no lleva stock, ni
 * SKUs de variante, ni nada que no se pueda leer de un vistazo.
 */

const ExcelJS = require('exceljs');
const { Op } = require('sequelize');
const { Product, ProductVariant } = require('../models');
const { NO_ES_FERIA } = require('../utils/feria');
const { NO_ES_PACK, productoNoEsPack } = require('../utils/packs');
const { __ordenarValores: ordenarValores } = require('./listaPreciosService');
const precioService = require('./precioService');

// Lo que se carga como "oferta" es una liquidación puntual, no parte del catálogo que se comparte.
const OFERTA = /oferta/i;

const plata = (n) => '$ ' + Math.round(Number(n) || 0).toLocaleString('es-AR');

// Cuántas combinaciones se listan por precio cuando ninguna dimensión sola explica la diferencia.
const MAX_COMBINACIONES = 6;

/*
 * Qué precio tiene cada variante, dicho en una línea.
 *
 * `filas` son { v1, v2, precio }. Devuelve '' si todas valen lo mismo, que es
 * el caso común y no tiene por qué ensuciar la planilla.
 *
 * Si los grupos se explican por una sola dimensión —el talle grande vale más—
 * se nombran sus valores: "$ 17.000 (S, M, L) · $ 21.000 (3XL, 4XL)". Se prueba
 * primero la variante 2 porque en el catálogo suele ser el talle, que es lo que
 * cambia el precio; el color casi nunca. Si ni una ni otra lo explican, se
 * listan las combinaciones, recortadas para que la celda siga siendo legible.
 */
function preciosDistintos(filas) {
  const precios = [...new Set(filas.map((f) => Number(f.precio) || 0))].sort((a, b) => a - b);
  if (precios.length <= 1) return '';

  for (const dim of ['v2', 'v1']) {
    const precioDe = new Map();
    const separa = filas.every((f) => {
      const valor = f[dim];
      if (!valor) return false;
      const precio = Number(f.precio) || 0;
      if (precioDe.has(valor) && precioDe.get(valor) !== precio) return false;
      precioDe.set(valor, precio);
      return true;
    });
    if (!separa) continue;
    return precios.map((precio) => {
      const valores = [...precioDe].filter(([, p]) => p === precio).map(([v]) => v);
      return `${plata(precio)} (${ordenarValores(valores).join(', ')})`;
    }).join(' · ');
  }

  return precios.map((precio) => {
    const combos = [...new Set(filas
      .filter((f) => (Number(f.precio) || 0) === precio)
      .map((f) => [f.v1, f.v2].filter(Boolean).join(' / ') || 'sin variante'))];
    const visibles = combos.slice(0, MAX_COMBINACIONES).join(', ');
    const resto = combos.length - MAX_COMBINACIONES;
    return `${plata(precio)} (${visibles}${resto > 0 ? ` y ${resto} más` : ''})`;
  }).join(' · ');
}

// "Talle: S, M, L". Sin nombre de dimensión, sólo los valores.
function dimension(nombre, valores) {
  if (!valores.size) return '';
  const lista = ordenarValores([...valores]).join(', ');
  return nombre ? `${nombre}: ${lista}` : lista;
}

async function datosDeCatalogo(businessId) {
  const productos = await Product.findAll({
    where: {
      businessId,
      activo: true,
      // Los combos se arman con otros productos: listarlos repite mercadería.
      definicionCombo: null,
      // Un SKU dado de baja queda renombrado con -BAJA<id> (ver codigoDeBaja).
      sku: { [Op.notLike]: '%-BAJA%' },
      // NO_ES_FERIA es un Op.or: va dentro del Op.and para no pisarse con otro.
      [Op.and]: [NO_ES_FERIA, productoNoEsPack()],
    },
    include: [{
      model: ProductVariant, as: 'productVariants', required: false,
      where: { businessId, activo: true, ...NO_ES_PACK },
    }],
    order: [['titulo', 'ASC']],
  });

  const filas = [];
  for (const p of productos) {
    if (OFERTA.test(p.titulo || '')) continue;
    const variantes = (p.productVariants || []).filter((v) => ![
      v.variante1Nombre, v.variante1Valor, v.variante2Nombre, v.variante2Valor,
    ].some((t) => OFERTA.test(t || '')));

    let n1 = null, n2 = null;
    const v1 = new Set(), v2 = new Set();
    for (const v of variantes) {
      n1 ||= v.variante1Nombre; n2 ||= v.variante2Nombre;
      if (v.variante1Valor) v1.add(v.variante1Valor);
      if (v.variante2Valor) v2.add(v.variante2Valor);
    }

    // Sin variantes, el precio es el del padre.
    const precios = (variantes.length ? variantes : [null]).map((v) => ({
      v1: v?.variante1Valor || null,
      v2: v?.variante2Valor || null,
      minorista: precioService.precioMinorista(v, p),
      mayorista: precioService.precioMayorista(v, p),
    }));

    const distintoMin = preciosDistintos(precios.map((x) => ({ ...x, precio: x.minorista })));
    const distintoMay = preciosDistintos(precios.map((x) => ({ ...x, precio: x.mayorista })));

    filas.push({
      skuAgrupador: p.skuAgrupador || p.sku,
      producto: p.titulo,
      variante1: dimension(n1, v1),
      variante2: dimension(n2, v2),
      // El menor: es el "desde" que se le dice al cliente; el detalle va en la columna de al lado.
      precioMinorista: Math.min(...precios.map((x) => x.minorista)),
      precioMayorista: Math.min(...precios.map((x) => x.mayorista)),
      preciosDistintos: [
        distintoMin && `Minorista: ${distintoMin}`,
        distintoMay && `Mayorista: ${distintoMay}`,
      ].filter(Boolean).join(' | '),
      descripcion: p.descripcion || '',
    });
  }
  return filas;
}

async function generarCatalogoXlsx(businessId) {
  const filas = await datosDeCatalogo(businessId);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Catálogo', { views: [{ state: 'frozen', ySplit: 1 }] });
  const pesos = { numFmt: '"$" #,##0' };
  sheet.columns = [
    { header: 'SKU agrupador',     key: 'skuAgrupador',     width: 16 },
    { header: 'Producto padre',    key: 'producto',         width: 34 },
    { header: 'Variante 1',        key: 'variante1',        width: 30 },
    { header: 'Variante 2',        key: 'variante2',        width: 30 },
    { header: 'Precio minorista',  key: 'precioMinorista',  width: 16, style: pesos },
    { header: 'Precio mayorista',  key: 'precioMayorista',  width: 16, style: pesos },
    { header: 'Precios distintos', key: 'preciosDistintos', width: 50 },
    { header: 'Descripción',       key: 'descripcion',      width: 60 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };
  sheet.addRows(filas);
  return workbook.xlsx.writeBuffer();
}

module.exports = { datosDeCatalogo, generarCatalogoXlsx, preciosDistintos };
