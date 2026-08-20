const ExcelJS = require('exceljs');
const { Product, ProductVariant } = require('../models');
const stockService = require('./stockService');

const COLUMNS = [
  { header: 'SKU Padre',        key: 'sku',             width: 18 },
  { header: 'SKU Agrupador',    key: 'skuAgrupador',    width: 18 },
  { header: 'Título',           key: 'titulo',          width: 30 },
  { header: 'Descripción',      key: 'descripcion',     width: 30 },
  { header: 'Categoría',        key: 'categoria',       width: 16 },
  { header: 'Género',           key: 'genero',          width: 12 },
  { header: 'Modelo',           key: 'modelo',           width: 14 },
  { header: 'Costo',            key: 'costo',            width: 12 },
  { header: 'Precio Minorista', key: 'precioMinorista', width: 14 },
  { header: 'Precio Mayorista', key: 'precioMayorista', width: 14 },
  { header: 'SKU Variante',     key: 'skuVariante',     width: 18 },
  { header: 'Variante 1 Nombre', key: 'variante1Nombre', width: 16 },
  { header: 'Variante 1 Valor',  key: 'variante1Valor',  width: 16 },
  { header: 'Variante 2 Nombre', key: 'variante2Nombre', width: 16 },
  { header: 'Variante 2 Valor',  key: 'variante2Valor',  width: 16 },
  { header: 'Stock',            key: 'stock',           width: 10 },
  { header: 'Stock Mínimo',     key: 'stockMinimo',     width: 12 },
];

// ── Exportar productos + variantes a un buffer .xlsx ────────────────
async function buildExportWorkbook(businessId) {
  const products = await Product.findAll({
    where: { businessId },
    include: [{ model: ProductVariant, as: 'productVariants' }],
    order: [['titulo', 'ASC']],
  });

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Productos');
  sheet.columns = COLUMNS;
  sheet.getRow(1).font = { bold: true };

  for (const p of products) {
    const base = {
      sku: p.sku, skuAgrupador: p.skuAgrupador, titulo: p.titulo,
      descripcion: p.descripcion || '', categoria: p.categoria || '', genero: p.genero || '',
      modelo: p.modelo || '', costo: Number(p.costo), precioMinorista: Number(p.precioMinorista),
      precioMayorista: Number(p.precioMayorista),
    };
    if (!p.productVariants || p.productVariants.length === 0) {
      sheet.addRow({ ...base, skuVariante: '', variante1Nombre: '', variante1Valor: '', variante2Nombre: '', variante2Valor: '', stock: '', stockMinimo: '' });
      continue;
    }
    for (const v of p.productVariants) {
      sheet.addRow({
        ...base,
        skuVariante: v.sku,
        variante1Nombre: v.variante1Nombre || '', variante1Valor: v.variante1Valor || '',
        variante2Nombre: v.variante2Nombre || '', variante2Valor: v.variante2Valor || '',
        stock: v.stock, stockMinimo: v.stockMinimo,
      });
    }
  }

  return workbook;
}

async function exportProductsXlsx(businessId) {
  const workbook = await buildExportWorkbook(businessId);
  return workbook.xlsx.writeBuffer();
}

// ── Importar productos + variantes desde un buffer .xlsx ────────────
const HEADER_TO_KEY = Object.fromEntries(COLUMNS.map((c) => [c.header.trim().toLowerCase(), c.key]));

function readSheetRows(worksheet) {
  const headerRow = worksheet.getRow(1);
  const colIndexToKey = {};
  headerRow.eachCell((cell, colNumber) => {
    const key = HEADER_TO_KEY[String(cell.value || '').trim().toLowerCase()];
    if (key) colIndexToKey[colNumber] = key;
  });

  const rows = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj = { _row: rowNumber };
    let hasData = false;
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const key = colIndexToKey[colNumber];
      if (!key) return;
      let value = cell.value;
      if (value && typeof value === 'object' && 'result' in value) value = value.result; // fórmulas
      if (value !== null && value !== undefined && value !== '') hasData = true;
      obj[key] = value;
    });
    if (hasData) rows.push(obj);
  });
  return rows;
}

function toNumber(v, fallback = 0) {
  if (v === '' || v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toStr(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

async function importProductsXlsx(businessId, buffer, { locationId = null } = {}) {
  // A qué local entra lo importado. Sin indicarlo, al principal.
  locationId = locationId || await stockService.localPorDefecto(businessId);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error('El archivo no tiene hojas.');

  const rows = readSheetRows(worksheet);
  const summary = { productsCreated: 0, productsUpdated: 0, variantsCreated: 0, variantsUpdated: 0, errors: [] };

  // Agrupamos filas por SKU padre para actualizar el producto una sola vez
  // y acumular las dimensiones de variante encontradas.
  const bySku = new Map();
  for (const row of rows) {
    const sku = toStr(row.sku);
    if (!sku) { summary.errors.push(`Fila ${row._row}: falta "SKU Padre".`); continue; }
    if (!bySku.has(sku)) bySku.set(sku, []);
    bySku.get(sku).push(row);
  }

  for (const [sku, productRows] of bySku) {
    const first = productRows[0];
    const skuAgrupador = toStr(first.skuAgrupador) || sku;
    const titulo = toStr(first.titulo);
    if (!titulo) { summary.errors.push(`Fila ${first._row}: falta "Título" para SKU ${sku}.`); continue; }

    const fields = {
      skuAgrupador, titulo,
      descripcion: toStr(first.descripcion),
      categoria: toStr(first.categoria),
      genero: toStr(first.genero),
      modelo: toStr(first.modelo),
      costo: toNumber(first.costo, 0),
      precioMinorista: toNumber(first.precioMinorista, 0),
      precioMayorista: toNumber(first.precioMayorista, 0),
      fechaActualizacion: new Date(),
    };

    let product = await Product.findOne({ where: { businessId, sku } });
    if (product) {
      await product.update(fields);
      summary.productsUpdated++;
    } else {
      product = await Product.create({ businessId, sku, variantes: {}, ...fields });
      summary.productsCreated++;
    }

    // Variantes de dimensión detectadas en el archivo, para guardarlas como referencia en el producto.
    const dims = {};

    for (const row of productRows) {
      const v1n = toStr(row.variante1Nombre), v1v = toStr(row.variante1Valor);
      const v2n = toStr(row.variante2Nombre), v2v = toStr(row.variante2Valor);
      const skuVariante = toStr(row.skuVariante) || (v1v || v2v ? `${sku}-${[v1v, v2v].filter(Boolean).join('-')}` : sku);
      const stockRaw = row.stock;
      const hasStock = stockRaw !== '' && stockRaw !== null && stockRaw !== undefined;

      if (v1n && v1v) (dims[v1n] ||= new Set()).add(v1v);
      if (v2n && v2v) (dims[v2n] ||= new Set()).add(v2v);

      if (!hasStock && !v1v && !v2v && !toStr(row.skuVariante)) continue; // fila solo con datos del producto

      try {
        // Buscar variante SÓLO dentro del producto actual — dos productos distintos
        // (incluso de otros negocios) pueden tener variantes con el mismo SKU.
        let variant = await ProductVariant.findOne({ where: { productId: product.id, sku: skuVariante } });
        const variantFields = {
          variante1Nombre: v1n || null, variante1Valor: v1v || null,
          variante2Nombre: v2n || null, variante2Valor: v2v || null,
          stockMinimo: row.stockMinimo !== '' && row.stockMinimo !== undefined ? toNumber(row.stockMinimo, 5) : undefined,
        };
        /*
         * El stock del Excel no se escribe en la variante: se aplica como un
         * ajuste sobre el local de destino.
         *
         * Poniéndolo directo en `product_variants.stock` el total diría una
         * cosa y la suma de los locales otra, y el primer movimiento posterior
         * recalcularía el total y haría desaparecer lo importado sin dejar
         * rastro. Además así la importación queda en el libro de movimientos,
         * que es donde se busca cuando un conteo no cierra.
         */
        const stockImportado = hasStock ? toNumber(stockRaw, 0) : null;

        if (variant) {
          await variant.update(Object.fromEntries(Object.entries(variantFields).filter(([, v]) => v !== undefined)));
          summary.variantsUpdated++;
        } else {
          variant = await ProductVariant.create({
            productId: product.id, sku: skuVariante,
            variante1Nombre: v1n || null, variante1Valor: v1v || null,
            variante2Nombre: v2n || null, variante2Valor: v2v || null,
            stock: 0,
            stockMinimo: variantFields.stockMinimo ?? 5,
          });
          summary.variantsCreated++;
        }

        if (stockImportado !== null) {
          await stockService.mover({
            variantId: variant.id,
            businessId,
            locationId,
            fijar: stockImportado,
            tipo: 'ajuste',
            motivo: 'Importación de Excel',
          });
        }
      } catch (e) {
        summary.errors.push(`Fila ${row._row}: ${e.message}`);
      }
    }

    if (Object.keys(dims).length > 0) {
      const variantes = Object.fromEntries(
        Object.entries(dims).slice(0, 2).map(([k, v]) => [k, Array.from(v).slice(0, 20)])
      );
      await product.update({ variantes });
    }
  }

  return summary;
}

module.exports = { exportProductsXlsx, importProductsXlsx };
