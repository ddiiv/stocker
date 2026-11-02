/*
 * Importar un Excel que trae sólo algunas columnas.
 *
 * El caso que lo motivó: cargar las descripciones de todo el catálogo con una
 * planilla de tres columnas (SKU Padre, Título, Descripción). Antes, a cada
 * producto que tocaba le dejaba los precios en cero y la categoría en blanco,
 * y pedía el título aunque el producto ya existiera.
 *
 * Lo que se prueba: a un producto existente sólo se le cambia lo que el archivo
 * trae con valor; el stock y el libro de movimientos no se mueven; y un
 * producto nuevo sigue exigiendo título y tomando los valores por defecto.
 *
 * Uso:  API=http://localhost:3000 node scripts/test-import-descripciones.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const ExcelJS = require('exceljs');
const API = process.env.API || 'http://localhost:3000';
const {
  Business, BusinessLocation, Product, ProductVariant, VariantStock, StockMovement,
} = require('../src/models');
const stockService = require('../src/services/stockService');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

(async () => {
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  const local = await BusinessLocation.findOne({ where: { businessId: negocio.id, tipo: 'local', activo: true } });

  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: negocio.email, password: 'Demo2026!!' }),
  });
  if (login.status !== 200) { console.log('No se pudo entrar:', login.status); process.exit(1); }
  const cookie = (login.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');

  const importar = async (filas) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Descripciones');
    for (const f of filas) ws.addRow(f);
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(await wb.xlsx.writeBuffer())], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }), 'descripciones.xlsx');
    const r = await fetch(`${API}/api/products/import`, { method: 'POST', headers: { Cookie: cookie }, body: form });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  const marca = Date.now();
  const skuNuevo = `QA-DESC-NUEVO-${marca}`;
  const creados = { productos: [], variantes: [] };

  try {
    const prod = await Product.create({
      businessId: negocio.id, sku: `QA-DESC-${marca}`, skuAgrupador: `QA-DESC-AG-${marca}`,
      titulo: `QA Descripción ${marca}`, descripcion: 'vieja', categoria: 'Remeras', genero: 'Unisex',
      modelo: 'Oversize', costo: 4000, precioMinorista: 17000, precioMayorista: 12000, activo: true,
    });
    creados.productos.push(prod.id);
    for (const talle of ['S', 'M']) {
      const v = await ProductVariant.create({
        productId: prod.id, businessId: negocio.id, sku: `QA-DESC-${marca}-${talle}`,
        variante1Nombre: 'Talle', variante1Valor: talle, precioMinorista: talle === 'M' ? 18000 : null,
        codigoBarras: `QA${marca}${talle}`, stock: 0, stockMinimo: 2,
      });
      creados.variantes.push(v.id);
      await stockService.mover({
        variantId: v.id, businessId: negocio.id, locationId: local.id, fijar: 7, tipo: 'ajuste', motivo: 'QA descripciones',
      });
    }

    const foto = async () => {
      const p = (await Product.findByPk(prod.id)).toJSON();
      const vs = await ProductVariant.findAll({ where: { productId: prod.id }, order: [['id', 'ASC']], raw: true });
      return {
        producto: [p.sku, p.skuAgrupador, p.titulo, p.categoria, p.genero, p.modelo,
          Number(p.costo), Number(p.precioMinorista), Number(p.precioMayorista)],
        variantes: vs.map((v) => [v.sku, v.variante1Valor, v.precioMinorista == null ? null : Number(v.precioMinorista),
          v.codigoBarras, v.stockMinimo, Number(v.stock)]),
        stockPorLocal: (await VariantStock.findAll({ where: { productVariantId: creados.variantes }, raw: true }))
          .map((f) => [f.productVariantId, f.locationId, Number(f.stock)]).sort(),
        movimientos: await StockMovement.count({ where: { productVariantId: creados.variantes } }),
      };
    };
    const antes = await foto();

    tit('1. UN ARCHIVO DE SÓLO DESCRIPCIONES');
    // Título vacío a propósito: el producto existe y no hace falta repetirlo.
    const imp = await importar([
      ['SKU Padre', 'Título', 'Descripción'],
      [prod.sku, '', 'Remera de algodón peinado 24/1'],
      [skuNuevo, '', 'Sin título no se crea'],
    ]);
    chk('la importación entra', 200, imp.status);
    chk('actualiza el existente', 1, imp.json?.productsUpdated);
    chk('no crea variantes ni toca las existentes', [0, 0], [imp.json?.variantsCreated, imp.json?.variantsUpdated]);
    chk('ni mueve stock', undefined, imp.json?.stockAjustado);

    const despues = await foto();
    chk('cambió la descripción', 'Remera de algodón peinado 24/1', (await Product.findByPk(prod.id)).descripcion);
    chk('precios, categoría, título y agrupador quedaron igual', antes.producto, despues.producto);
    chk('las variantes quedaron igual', antes.variantes, despues.variantes);
    chk('el stock por local quedó igual', antes.stockPorLocal, despues.stockPorLocal);
    chk('y no hay movimientos nuevos', antes.movimientos, despues.movimientos);

    tit('2. UN PRODUCTO NUEVO SIGUE PIDIENDO TÍTULO');
    chk('sin título, avisa y no lo crea', [true, 0], [
      (imp.json?.errors || []).some((e) => e.includes('falta "Título"') && e.includes(skuNuevo)),
      await Product.count({ where: { businessId: negocio.id, sku: skuNuevo } }),
    ]);

    const imp2 = await importar([
      ['SKU Padre', 'Título', 'Descripción'],
      [skuNuevo, 'QA nuevo por planilla', 'Recién cargado'],
    ]);
    const nuevo = await Product.findOne({ where: { businessId: negocio.id, sku: skuNuevo } });
    if (nuevo) creados.productos.push(nuevo.id);
    chk('con título, se crea', [200, 1], [imp2.status, imp2.json?.productsCreated]);
    chk('con los valores por defecto de siempre', [skuNuevo, 'QA nuevo por planilla', 'Recién cargado', 0, 0],
      [nuevo?.skuAgrupador, nuevo?.titulo, nuevo?.descripcion, Number(nuevo?.precioMinorista), Number(nuevo?.precioMayorista)]);

    tit('3. UNA CELDA CON VALOR SÍ SE ESCRIBE');
    const imp3 = await importar([
      ['SKU Padre', 'Título', 'Descripción', 'Precio Minorista', 'Categoría'],
      // Con el título repetido, como viene de un export: antes eso alcanzaba para que los precios vacíos quedaran en 0.
      [prod.sku, prod.titulo, '', 19000, ''],
    ]);
    const p3 = await Product.findByPk(prod.id);
    chk('cambia el precio y deja lo demás', [200, 19000, 'Remera de algodón peinado 24/1', 'Remeras', 12000],
      [imp3.status, Number(p3.precioMinorista), p3.descripcion, p3.categoria, Number(p3.precioMayorista)]);
  } finally {
    tit('Limpieza');
    await StockMovement.destroy({ where: { productVariantId: creados.variantes } });
    await VariantStock.destroy({ where: { productVariantId: creados.variantes } });
    await ProductVariant.destroy({ where: { id: creados.variantes } });
    await Product.destroy({ where: { id: creados.productos } });
    chk('no queda nada de la prueba', 0, await Product.count({ where: { id: creados.productos } }));
  }

  console.log(`\n\x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
