const ExcelJS = require('exceljs');
const { Op } = require('sequelize');
const { Product, ProductVariant, BusinessLocation } = require('../models');
const { exigirCupo } = require('./planService');
const stockService = require('./stockService');
const precioService = require('./precioService');

/*
 * Columnas fijas de la planilla.
 *
 * Las de stock se agregan aparte, una por local, porque dependen de cómo esté
 * armado cada negocio.
 *
 * Los precios aparecen dos veces y no es redundancia: las columnas "del
 * producto" llevan el precio de lista del padre, y las "de la variante" sólo se
 * completan cuando esa variante tiene precio propio. Una variante que hereda
 * queda con esas celdas vacías, y así el archivo se puede exportar, editar y
 * volver a importar sin que la herencia se pierda por el camino.
 */
const COLUMNS = [
  { header: 'SKU Padre',        key: 'sku',             width: 18 },
  { header: 'SKU Agrupador',    key: 'skuAgrupador',    width: 18 },
  { header: 'Título',           key: 'titulo',          width: 30 },
  { header: 'Descripción',      key: 'descripcion',     width: 30 },
  { header: 'Categoría',        key: 'categoria',       width: 16 },
  { header: 'Género',           key: 'genero',          width: 12 },
  { header: 'Modelo',           key: 'modelo',          width: 14 },
  { header: 'Costo',            key: 'costo',           width: 12 },
  { header: 'Precio Minorista', key: 'precioMinorista', width: 14 },
  { header: 'Precio Mayorista', key: 'precioMayorista', width: 14 },
  { header: 'SKU Variante',     key: 'skuVariante',     width: 20 },
  { header: 'Código de Barras', key: 'codigoBarras',    width: 18 },
  { header: 'Variante 1 Nombre', key: 'variante1Nombre', width: 16 },
  { header: 'Variante 1 Valor',  key: 'variante1Valor',  width: 16 },
  { header: 'Variante 2 Nombre', key: 'variante2Nombre', width: 16 },
  { header: 'Variante 2 Valor',  key: 'variante2Valor',  width: 16 },
  // Vacías = hereda del producto.
  { header: 'Costo Variante',            key: 'costoVariante',           width: 14 },
  { header: 'Precio Minorista Variante', key: 'precioMinoristaVariante', width: 20 },
  { header: 'Precio Mayorista Variante', key: 'precioMayoristaVariante', width: 20 },
  { header: 'Stock Mínimo',     key: 'stockMinimo',     width: 12 },
];

// El prefijo con el que se reconocen las columnas de stock al importar.
const PREFIJO_STOCK = 'Stock ';

/*
 * Una celda vacía no es un cero.
 *
 * Al importar, vacío significa "esto no se toca". Es la diferencia entre editar
 * tres filas de una planilla exportada y vaciar el stock de todo lo demás.
 */
const vacia = (v) => v === '' || v === null || v === undefined;

// ── Exportar productos + variantes a un buffer .xlsx ────────────────
async function buildExportWorkbook(businessId) {
  const [products, locales] = await Promise.all([
    Product.findAll({
      where: { businessId },
      include: [{ model: ProductVariant, as: 'productVariants' }],
      order: [['titulo', 'ASC']],
    }),
    BusinessLocation.findAll({
      where: { businessId, activo: true },
      attributes: ['id', 'nombre'],
      order: [['id', 'ASC']],
    }),
  ]);

  /*
   * Una columna de stock por local.
   *
   * Una sola columna "Stock" ya no alcanza: el stock vive en cada local y
   * exportar el total haría que reimportar el archivo lo cargara todo en uno,
   * vaciando los demás. Con una columna por local el archivo dice dónde está
   * cada unidad y se puede editar como una planilla de inventario.
   */
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Productos');
  sheet.columns = [
    ...COLUMNS,
    ...locales.map((l) => ({ header: `${PREFIJO_STOCK}${l.nombre}`, key: `loc_${l.id}`, width: 14 })),
    { header: 'Stock Total', key: 'stockTotal', width: 12 },
  ];
  sheet.getRow(1).font = { bold: true };

  const idsVariantes = products.flatMap((p) => p.productVariants.map((v) => v.id));
  const desglose = await stockService.desglosePorVariante(idsVariantes, businessId);

  for (const p of products) {
    const base = {
      sku: p.sku, skuAgrupador: p.skuAgrupador, titulo: p.titulo,
      descripcion: p.descripcion || '', categoria: p.categoria || '', genero: p.genero || '',
      modelo: p.modelo || '',
      // Los del producto, tal cual: son los que heredan sus variantes.
      costo: Number(p.costo), precioMinorista: Number(p.precioMinorista),
      precioMayorista: Number(p.precioMayorista),
    };

    if (!p.productVariants || p.productVariants.length === 0) {
      sheet.addRow({ ...base, stockTotal: 0 });
      continue;
    }

    for (const v of p.productVariants) {
      const porLocal = Object.fromEntries(
        (desglose.get(v.id) || []).map((f) => [`loc_${f.locationId}`, f.stock]),
      );
      // Los locales sin fila van en cero: la planilla de inventario se lee
      // mejor completa que con huecos.
      for (const l of locales) if (porLocal[`loc_${l.id}`] === undefined) porLocal[`loc_${l.id}`] = 0;

      sheet.addRow({
        ...base,
        skuVariante: v.sku,
        codigoBarras: v.codigoBarras || '',
        variante1Nombre: v.variante1Nombre || '', variante1Valor: v.variante1Valor || '',
        variante2Nombre: v.variante2Nombre || '', variante2Valor: v.variante2Valor || '',
        /*
         * Sólo se escribe el precio de la variante si es propio. Vacío
         * significa que hereda, y es lo que hay que preservar al reimportar:
         * poniendo el precio efectivo, toda variante quedaría con precio propio
         * después del primer viaje de ida y vuelta y dejaría de seguir al padre.
         */
        costoVariante:           precioService.tieneValor(v.costo) ? Number(v.costo) : '',
        precioMinoristaVariante: precioService.tieneValor(v.precioMinorista) ? Number(v.precioMinorista) : '',
        precioMayoristaVariante: precioService.tieneValor(v.precioMayorista) ? Number(v.precioMayorista) : '',
        stockMinimo: v.stockMinimo,
        ...porLocal,
        stockTotal: Number(v.stock) || 0,
      });
    }
  }

  /*
   * El total es informativo y se marca como tal.
   *
   * Es la suma de las columnas de local; si alguien lo edita esperando que
   * cambie el stock, no pasa nada, y conviene que se note antes de intentarlo.
   */
  const colTotal = sheet.getColumn('stockTotal');
  colTotal.font = { italic: true, color: { argb: 'FF888888' } };

  return workbook;
}

async function exportProductsXlsx(businessId) {
  const workbook = await buildExportWorkbook(businessId);
  return workbook.xlsx.writeBuffer();
}

/*
 * Encabezado del archivo → clave interna.
 *
 * Se deriva de COLUMNS en vez de escribirse a mano: son las mismas columnas que
 * se exportan, y una lista aparte se desincroniza en cuanto alguien agrega una.
 * Se compara en minúsculas para que un "SKU padre" tipeado distinto entre igual.
 */
const HEADER_TO_KEY = Object.fromEntries(COLUMNS.map((c) => [c.header.trim().toLowerCase(), c.key]));

/*
 * Tope de filas por importación. Ver el comentario en importProductsXlsx.
 * Se exporta para que la pantalla lo diga ANTES de que alguien arme el archivo.
 */
const MAX_FILAS = 2000;

function readSheetRows(worksheet, columnasStock = [], columnaStockSimple = null) {
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
    /*
     * El stock por local va aparte del resto de las claves: las columnas son
     * dinámicas y no tienen una `key` fija en COLUMNS.
     */
    obj._stockPorLocal = [];
    for (const c of columnasStock) {
      if (!c.locationId) continue;
      const celda = row.getCell(c.columna).value;
      if (vacia(celda)) continue;   // vacío = ese local no se toca
      obj._stockPorLocal.push({ locationId: c.locationId, unidades: celda });
      hasData = true;
    }
    if (columnaStockSimple) {
      const celda = row.getCell(columnaStockSimple).value;
      if (!vacia(celda)) { obj._stockSimple = celda; hasData = true; }
    }

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
  // Local de respaldo: para archivos con una sola columna "Stock", sin nombre
  // de local. Sin indicarlo, el principal.
  // El local llega desde el formulario de importación: hay que comprobar que
  // sea de este negocio antes de cargarle mil filas de stock encima.
  locationId = await stockService.resolverLocal({ locationId, businessId });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error('El archivo no tiene hojas.');

  /*
   * Qué columnas de stock trae el archivo.
   *
   * Se reconocen por el encabezado "Stock <nombre del local>" y se resuelven
   * contra los locales del negocio. Un nombre que no existe se avisa como error
   * en vez de descartarse: alguien renombró un local o escribió mal, y perder
   * ese stock en silencio es peor que rechazar la columna.
   */
  const locales = await BusinessLocation.findAll({ where: { businessId }, attributes: ['id', 'nombre'] });
  const porNombre = new Map(locales.map((l) => [l.nombre.trim().toLowerCase(), l.id]));

  const columnasStock = [];      // { columna, locationId }
  let columnaStockSimple = null; // la vieja "Stock" a secas
  const encabezados = worksheet.getRow(1).values || [];
  encabezados.forEach((texto, i) => {
    const h = String(texto ?? '').trim();
    if (!h) return;
    if (h.toLowerCase() === 'stock') { columnaStockSimple = i; return; }
    if (h.toLowerCase() === 'stock total' || h.toLowerCase() === 'stock mínimo' || h.toLowerCase() === 'stock minimo') return;
    if (!h.startsWith(PREFIJO_STOCK)) return;
    const nombre = h.slice(PREFIJO_STOCK.length).trim().toLowerCase();
    const id = porNombre.get(nombre);
    if (id) columnasStock.push({ columna: i, locationId: id });
    else columnasStock.push({ columna: i, locationId: null, nombre: h.slice(PREFIJO_STOCK.length).trim() });
  });

  const rows = readSheetRows(worksheet, columnasStock, columnaStockSimple);

  /*
   * Cuántas filas entran de una.
   *
   * Cada fila es un producto×variante y cuesta varias consultas: buscar el
   * padre, buscar la variante, escribirla y mover stock por cada local. Todo
   * eso pasa dentro de UN pedido HTTP, con el archivo entero en memoria.
   *
   * Sin tope, un .xlsx de 10 MB —lo que deja pasar el límite de subida— puede
   * traer más de cien mil filas. Eso no es una importación lenta: es el
   * proceso reteniendo el archivo, agotando el pool de conexiones y dejando
   * sin sistema a TODOS los negocios mientras dura. Y el que la mandó ni se
   * entera, porque su pedido muere por timeout mucho antes de terminar.
   *
   * Dos mil es una carga de catálogo completa para la enorme mayoría, y entra
   * cómoda en el tiempo de un pedido. Más que eso se parte en varios archivos:
   * es una molestia chica comparada con el servidor caído.
   */
  if (rows.length > MAX_FILAS) {
    throw Object.assign(
      new Error(
        `El archivo tiene ${rows.length.toLocaleString('es-AR')} filas y el máximo por importación es `
        + `${MAX_FILAS.toLocaleString('es-AR')}. Cada fila es un producto con su variante. `
        + 'Partilo en varios archivos y subilos de a uno.'
      ),
      /*
       * En `detalles` porque es lo que el manejador de errores vuelca en la
       * respuesta. Puesto suelto en el error, la pantalla recibe el 413 sin
       * saber que es por el tope y no puede decir cuántas filas sobran.
       */
      { status: 413, detalles: { codigo: 'ARCHIVO_MUY_GRANDE', filas: rows.length, maximo: MAX_FILAS } },
    );
  }

  const summary = { productsCreated: 0, productsUpdated: 0, variantsCreated: 0, variantsUpdated: 0, errors: [] };

  for (const c of columnasStock) {
    if (!c.locationId) summary.errors.push(`La columna "${PREFIJO_STOCK}${c.nombre}" no coincide con ningún local: se ignoró.`);
  }

  // Agrupamos filas por SKU padre para actualizar el producto una sola vez
  // y acumular las dimensiones de variante encontradas.
  const bySku = new Map();
  for (const row of rows) {
    const sku = toStr(row.sku);
    if (!sku) { summary.errors.push(`Fila ${row._row}: falta "SKU Padre".`); continue; }
    if (!bySku.has(sku)) bySku.set(sku, []);
    bySku.get(sku).push(row);
  }

  /*
   * El tope de SKUs del plan, antes de escribir nada.
   *
   * La importación era la única puerta que no lo miraba: se podía entrar por
   * acá con veinte mil variantes en un plan de cinco mil. Se cuenta sólo lo
   * que va a NACER —lo que ya existe se actualiza y no ocupa lugar nuevo— así
   * que una corrección masiva de precios sobre el catálogo entero no rebota.
   */
  const skusEnArchivo = [...new Set(rows.map((r) => {
    const padre = toStr(r.sku);
    if (!padre) return null;
    const v1 = toStr(r.variante1Valor), v2 = toStr(r.variante2Valor);
    return toStr(r.skuVariante) || (v1 || v2 ? `${padre}-${[v1, v2].filter(Boolean).join('-')}` : padre);
  }).filter(Boolean))];

  if (skusEnArchivo.length) {
    const yaExisten = await ProductVariant.count({
      where: { businessId, sku: { [Op.in]: skusEnArchivo } },
    });
    const nuevas = skusEnArchivo.length - yaExisten;
    if (nuevas > 0) await exigirCupo(businessId, 'skus', nuevas);
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

      /*
       * El stock a aplicar, por local.
       *
       * Con columnas por local se usan ésas. Un archivo viejo con una sola
       * columna "Stock" sigue funcionando: entra al local de destino, que es lo
       * que hacía antes.
       */
      const stockPorLocal = (row._stockPorLocal || []).map((x) => ({
        locationId: x.locationId, unidades: toNumber(x.unidades, 0),
      }));
      if (!stockPorLocal.length && !vacia(row._stockSimple) && locationId) {
        stockPorLocal.push({ locationId, unidades: toNumber(row._stockSimple, 0) });
      }
      const hasStock = stockPorLocal.length > 0;

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
          codigoBarras: toStr(row.codigoBarras) || null,
        };

        /*
         * Los precios propios de la variante.
         *
         * Sólo se tocan si la columna existe en el archivo: una planilla vieja
         * no las trae y no tiene por qué borrar precios que alguien cargó a
         * mano. Si la columna está y la celda está vacía, la variante vuelve a
         * heredar — que es cómo se deshace un precio propio desde el Excel.
         */
        for (const [columna, campo] of [
          ['costoVariante', 'costo'],
          ['precioMinoristaVariante', 'precioMinorista'],
          ['precioMayoristaVariante', 'precioMayorista'],
        ]) {
          if (!(columna in row)) continue;
          variantFields[campo] = vacia(row[columna]) ? null : toNumber(row[columna], 0);
        }
        /*
         * El stock del Excel no se escribe en la variante: se aplica más abajo
         * como ajuste sobre cada local.
         *
         * Poniéndolo directo en `product_variants.stock` el total diría una
         * cosa y la suma de los locales otra, y el primer movimiento posterior
         * recalcularía el total y haría desaparecer lo importado sin dejar
         * rastro. Además así la importación queda en el libro de movimientos,
         * que es donde se busca cuando un conteo no cierra.
         */
        if (variant) {
          await variant.update(Object.fromEntries(Object.entries(variantFields).filter(([, v]) => v !== undefined)));
          summary.variantsUpdated++;
        } else {
          variant = await ProductVariant.create({
            productId: product.id, businessId, sku: skuVariante,
            variante1Nombre: v1n || null, variante1Valor: v1v || null,
            variante2Nombre: v2n || null, variante2Valor: v2v || null,
            codigoBarras: variantFields.codigoBarras,
            costo: variantFields.costo ?? null,
            precioMinorista: variantFields.precioMinorista ?? null,
            precioMayorista: variantFields.precioMayorista ?? null,
            stock: 0,
            stockMinimo: variantFields.stockMinimo ?? 5,
          });
          summary.variantsCreated++;
        }

        /*
         * El stock se aplica local por local, como ajuste.
         *
         * Es un ajuste y no un ingreso porque la planilla dice cuánto HAY, no
         * cuánto entró: es el resultado de un conteo. Anotarlo como ingreso
         * inflaría las etiquetas del día con mercadería que ya estaba.
         *
         * Y sólo se toca lo que efectivamente cambia. Importar el archivo
         * recién exportado, sin editar una celda, escribía un ajuste por cada
         * variante y local —231 movimientos que no movieron nada— y eso llena
         * el libro de ruido justo donde se busca una diferencia. Peor: deja
         * filas de stock en cero para locales que nunca tuvieron esa prenda.
         */
        for (const { locationId: destino, unidades } of stockPorLocal) {
          const actual = await stockService.stockEn(variant.id, destino);
          if (actual === unidades) continue;
          await stockService.mover({
            variantId: variant.id,
            businessId,
            locationId: destino,
            fijar: unidades,
            tipo: 'ajuste',
            motivo: 'Importación de Excel',
          });
          summary.stockAjustado = (summary.stockAjustado || 0) + 1;
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

module.exports = { exportProductsXlsx, importProductsXlsx, MAX_FILAS };
