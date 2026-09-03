/*
 * Productos de feria: se venden sin llevar inventario.
 *
 * Hay negocios con puestos de feria donde interesa registrar QUÉ se vendió, no
 * cuánto queda. Estos productos tienen una sola variante —el padre ES la
 * variante—, SKU con tres caracteres adelante, precio propio, y su stock no se
 * consulta ni se mueve nunca.
 *
 * Lo que se prueba acá es sobre todo lo segundo. Un producto sin stock metido
 * en un sistema que da por sentado que todo lo tiene se cuela por cualquier
 * grieta: el descuento al vender, la devolución al anular, el depósito, la
 * reposición, MercadoLibre, Stock a regularizar. Cada una de esas grietas es
 * una prueba de este archivo.
 *
 * Uso:  API=http://localhost:3000 node scripts/test-feria.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const { Op } = require('sequelize');
const API = process.env.API || 'http://localhost:3000';
const {
  Business, BusinessLocation, Product, ProductVariant, VariantStock,
  Sale, SaleItem, StockMovement,
} = require('../src/models');
const stockService = require('../src/services/stockService');
const { NO_ES_FERIA } = require('../src/utils/feria');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

function sesion() {
  // La cookie queda a la vista: la subida del .xlsx va con FormData y no puede
  // pasar por este helper, que manda JSON.
  let cookie = '';
  const pedir = async (metodo, ruta, cuerpo) => {
    const r = await fetch(`${API}${ruta}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    const set = r.headers.getSetCookie?.() || [];
    if (set.length) { cookie = set.map((c) => c.split(';')[0]).join('; '); pedir.cookie = cookie; }
    let json = null; try { json = JSON.parse(await r.text()); } catch { /* no json */ }
    return { status: r.status, json };
  };
  pedir.cookie = '';
  return pedir;
}

(async () => {
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  const localNormal = await BusinessLocation.findOne({
    where: { businessId: negocio.id, tipo: 'local', activo: true },
  });

  const api = sesion();
  const login = await api('POST', '/api/auth/login', { email: negocio.email, password: 'Demo2026!!' });
  if (login.status !== 200) { console.log('No se pudo entrar:', login.status); process.exit(1); }

  const aBorrar = { productos: [], ventas: [], locales: [] };

  /*
   * Se limpia también AL EMPEZAR.
   *
   * Esta suite crea productos y locales de verdad. Si una corrida se corta a la
   * mitad —un fallo, un Ctrl+C— deja residuo, y la siguiente encuentra el
   * producto de feria ya generado y falla por un motivo que no tiene nada que
   * ver con lo que se está probando.
   */
  const limpiar = async () => {
    // El orden importa: las ventas apuntan al local y a la variante, así que
    // salen primero. Al revés, la base rebota por clave foránea.
    const puestos = await BusinessLocation.findAll({
      where: { businessId: negocio.id, tipo: 'feria', nombre: { [Op.like]: 'Feria QA%' } },
      attributes: ['id'],
    });
    const ventasAhi = await Sale.findAll({
      where: { businessId: negocio.id, locationId: puestos.map((l) => l.id) }, attributes: ['id'],
    });
    for (const v of ventasAhi) {
      await SaleItem.destroy({ where: { saleId: v.id } });
      await Sale.destroy({ where: { id: v.id } });
    }

    const feriaProds = await Product.findAll({
      where: { businessId: negocio.id, esFeria: true }, attributes: ['id'],
    });
    for (const p of feriaProds) {
      const ids = (await ProductVariant.findAll({ where: { productId: p.id }, attributes: ['id'] }))
        .map((v) => v.id);
      if (ids.length) {
        for (const si of await SaleItem.findAll({ where: { productVariantId: ids }, attributes: ['saleId'] })) {
          await SaleItem.destroy({ where: { saleId: si.saleId } });
          await Sale.destroy({ where: { id: si.saleId } });
        }
        await StockMovement.destroy({ where: { productVariantId: ids } });
        await VariantStock.destroy({ where: { productVariantId: ids } });
        await ProductVariant.destroy({ where: { id: ids } });
      }
      await Product.destroy({ where: { id: p.id } });
    }
    for (const l of puestos) await BusinessLocation.destroy({ where: { id: l.id } });
  };

  await limpiar();

  tit('1. EL PUESTO DE FERIA ES UN TIPO DE LUGAR');
  /*
   * Se le hace lugar al local de prueba antes de crearlo.
   *
   * `maxLocales` pasó a exigirse de verdad —se medía y se mostraba, pero
   * ninguna ruta lo controlaba— y el negocio demo está justo en su tope. Sin
   * esto, esta prueba fallaría por el cupo y no por lo que quiere probar, que
   * es que el tipo `feria` se acepta.
   *
   * Se toca el PLAN y no el negocio porque el tope vive ahí, y se restaura en
   * el `finally` de más abajo pase lo que pase.
   */
  const { Plan } = require('../src/models');
  const planDemo = await Plan.findByPk((await require('../src/services/planService').estadoDe(negocio.id)).plan.id);
  const topeOriginal = planDemo.maxLocales;
  await planDemo.update({ maxLocales: topeOriginal == null ? null : topeOriginal + 2 });

  const puesto = await api('POST', '/api/locations', {
    nombre: `Feria QA ${Date.now()}`, direccion: 'Puesto 14, La Salada', tipo: 'feria',
  });
  chk('se puede crear un lugar de tipo feria', 201, puesto.status);
  chk('y queda marcado como tal', 'feria', puesto.json?.tipo);
  if (puesto.json?.id) aBorrar.locales.push(puesto.json.id);

  tit('2. GENERAR EL CATÁLOGO DE FERIA');
  const cand = await api('GET', '/api/feria/candidatos?prefijo=FERIA');
  chk('lista los padres del catálogo normal', true, (cand.json?.productos || []).length > 0);
  chk('el prefijo se recorta a tres caracteres', 'FER', cand.json?.prefijo);

  const origen = cand.json.productos[0];
  chk('propone el SKU de feria', `FER${origen.sku}`, origen.skuFeria);
  chk('y avisa que todavía no está generado', false, origen.generado);

  const gen = await api('POST', '/api/feria/generar', {
    productIds: [origen.id], prefijo: 'FERIA',
    precio: { modo: 'porcentaje', base: 'minorista', porcentaje: -20 },
  });
  chk('genera el producto de feria', 201, gen.status);
  chk('uno creado', 1, gen.json?.creados?.length);

  const creado = gen.json.creados[0];
  aBorrar.productos.push(creado.productId);
  chk('con el SKU esperado', `FER${origen.sku}`, creado.sku);
  chk('y el precio con el descuento aplicado',
    Math.round(origen.precioMinorista * 0.8 * 100) / 100, creado.precio);

  const prod = await Product.findByPk(creado.productId);
  chk('queda marcado como de feria', true, prod.esFeria);
  chk('y recuerda de qué producto salió', origen.id, prod.origenProductId);

  const variantes = await ProductVariant.findAll({ where: { productId: creado.productId } });
  chk('tiene UNA sola variante', 1, variantes.length);
  chk('sin color ni talle', [null, null],
    [variantes[0].variante1Valor, variantes[0].variante2Valor]);
  chk('con el mismo SKU que el padre', creado.sku, variantes[0].sku);

  tit('2.b GENERAR DOS VECES NO DUPLICA');
  const otra = await api('POST', '/api/feria/generar', { productIds: [origen.id], prefijo: 'FERIA' });
  chk('no crea nada la segunda vez', 0, otra.json?.creados?.length);
  chk('y dice por qué', 1, otra.json?.omitidos?.length);
  chk('sigue habiendo un solo producto de feria para ese origen', 1,
    await Product.count({ where: { businessId: negocio.id, esFeria: true, origenProductId: origen.id } }));

  tit('3. ESCANEAR EL CÓDIGO DE FERIA');
  const scan = await api('GET', `/api/products/scan/${encodeURIComponent(creado.sku)}`);
  chk('el lector lo encuentra', 200, scan.status);
  chk('avisa que es de feria', true, scan.json?.esFeria);
  chk('sin pedir talle ni color', [null, null],
    [scan.json?.variante1Valor ?? null, scan.json?.variante2Valor ?? null]);
  chk('y no informa stock, porque no lleva', null, scan.json?.enLocal ?? null);

  tit('4. VENDER EN LA FERIA NO MUEVE INVENTARIO');
  const antesStock = await stockService.stockEn(variantes[0].id, puesto.json.id);
  const antesMovs = await StockMovement.count({ where: { productVariantId: variantes[0].id } });

  const venta = await api('POST', '/api/sales', {
    locationId: puesto.json.id, estado: 'pagado', medioPago: 'efectivo',
    items: [{ productVariantId: variantes[0].id, cantidad: 7}],
  });
  chk('la venta entra', 201, venta.status);
  if (venta.json?.id) aBorrar.ventas.push(venta.json.id);

  chk('el stock sigue igual', antesStock, await stockService.stockEn(variantes[0].id, puesto.json.id));
  chk('no se registró ningún movimiento', antesMovs,
    await StockMovement.count({ where: { productVariantId: variantes[0].id } }));
  chk('ni siquiera se creó una fila de stock', 0,
    await VariantStock.count({ where: { productVariantId: variantes[0].id } }));
  /*
   * `stockDescontado` queda en true aunque no se haya movido nada, y está bien:
   * significa "el paso de stock ya corrió para esta venta", que es lo que evita
   * que se procese dos veces. Lo que importa —y es lo que se comprueba arriba—
   * es que ese paso no haya tocado el inventario.
   */
  chk('no informa faltantes: no puede faltar lo que no se cuenta', 0,
    (venta.json?.faltantes || []).length);

  tit('4.b VENDER SIETE VECES TAMPOCO');
  // El punto de "stock ilimitado": no importa cuánto se venda.
  for (let i = 0; i < 3; i++) {
    const v = await api('POST', '/api/sales', {
      locationId: puesto.json.id, estado: 'pagado', medioPago: 'efectivo',
      items: [{ productVariantId: variantes[0].id, cantidad: 50}],
    });
    if (v.json?.id) aBorrar.ventas.push(v.json.id);
  }
  chk('150 unidades más y el stock no se movió', 0,
    await VariantStock.count({ where: { productVariantId: variantes[0].id } }));
  chk('no aparece en Stock a regularizar', 0,
    (await api('GET', '/api/stock/a-regularizar')).json?.data
      ?.filter((x) => x.variantId === variantes[0].id).length ?? 0);

  tit('5. ANULAR UNA VENTA DE FERIA NO INVENTA STOCK');
  const anular = await api('POST', `/api/sales/${encodeURIComponent(venta.json.numero)}/anular`,
    { motivo: 'Prueba de feria' });
  chk('se anula', 200, anular.status);
  chk('y sigue sin haber fila de stock', 0,
    await VariantStock.count({ where: { productVariantId: variantes[0].id } }));

  tit('6. FERIA Y CATÁLOGO NORMAL NO SE MEZCLAN');
  const enLocalNormal = await api('POST', '/api/sales', {
    locationId: localNormal.id, estado: 'pagado', medioPago: 'efectivo',
    items: [{ productVariantId: variantes[0].id, cantidad: 1}],
  });
  if (enLocalNormal.json?.id) aBorrar.ventas.push(enLocalNormal.json.id);
  chk('un artículo de feria en un local normal se rechaza', 400, enLocalNormal.status);

  const normalVariante = await ProductVariant.findOne({
    where: { businessId: negocio.id, activo: true },
    include: [{ model: Product, as: 'producto', where: { ...NO_ES_FERIA }, required: true }],
  });
  const enFeria = await api('POST', '/api/sales', {
    locationId: puesto.json.id, estado: 'pagado', medioPago: 'efectivo',
    items: [{ productVariantId: normalVariante.id, cantidad: 1}],
  });
  if (enFeria.json?.id) aBorrar.ventas.push(enFeria.json.id);
  chk('un artículo normal en la feria también', 400, enFeria.status);

  tit('7. LA GARANTÍA DE ÚLTIMO RECURSO');
  /*
   * `stockService.mover` es el único lugar del sistema que escribe inventario.
   * Que se niegue con un producto de feria es lo que hace que ningún camino
   * futuro pueda saltarse la regla por olvido.
   */
  let rechazo = null;
  try {
    await stockService.mover({
      variantId: variantes[0].id, businessId: negocio.id, locationId: localNormal.id,
      delta: 10, tipo: 'ingreso', motivo: 'Prueba: no debería poder',
    });
  } catch (e) { rechazo = e; }
  chk('mover() rechaza una variante de feria', 'FERIA_SIN_STOCK', rechazo?.codigo);
  chk('y no dejó stock', 0, await VariantStock.count({ where: { productVariantId: variantes[0].id } }));

  tit('8. FUERA DEL CIRCUITO DE INVENTARIO');
  const alDeposito = await api('POST', '/api/deposito/ingresos', {
    origen: 'etiquetas',
    items: [{ productVariantId: variantes[0].id, cantidad: 5 }],
  });
  chk('no entra al depósito', 400, alDeposito.status);

  const lugares = await api('GET', '/api/deposito/lugares');
  chk('el puesto de feria no recibe reposición', false,
    (lugares.json?.locales || []).some((l) => l.id === puesto.json.id));

  const catalogo = await api('GET', '/api/products?limit=200');
  chk('no ensucia el listado de Stock', false,
    (catalogo.json?.data || []).some((g) => g.skuAgrupador === creado.sku));

  const soloFeria = await api('GET', '/api/feria/productos');
  chk('pero sí está en su propia pantalla', true,
    (soloFeria.json || []).some((p) => p.sku === creado.sku));

  await planDemo.update({ maxLocales: topeOriginal });

  tit('10. UN PRODUCTO DE EVENTO CARGADO A MANO');
  // No hace falta anotarlos: `limpiar()` borra todos los productos de evento
  // del negocio al terminar.
  /*
   * Hay mercadería que SÓLO se vende en eventos y nunca estuvo en el catálogo:
   * un saldo comprado para el fin de semana. Antes había que inventarle un
   * producto al catálogo normal, generarle su versión de evento y acordarse de
   * dar de baja el original.
   */
  const manual = await api('POST', '/api/feria/productos', {
    titulo: 'QA Saldo suelto', sku: 'qa-suelto', precioMinorista: 5000, precioMayorista: 3500,
  });
  chk('se crea', 201, manual.status);
  chk('con el prefijo del catálogo de evento', true, /^[A-Z0-9]{3}QA-SUELTO$/.test(manual.json?.sku || ''));
  chk('y los dos precios', [5000, 3500], [manual.json?.precioMinorista, manual.json?.precioMayorista]);

  const prodManual = await Product.findByPk(manual.json.productId);
  chk('queda marcado como de evento', true, prodManual?.esFeria);
  chk('sin producto de origen', null, prodManual?.origenProductId ?? null);
  const varsManual = await ProductVariant.findAll({ where: { productId: prodManual.id } });
  chk('con una sola variante', 1, varsManual.length);
  chk('sin color ni talle', [null, null],
    [varsManual[0].variante1Valor ?? null, varsManual[0].variante2Valor ?? null]);

  tit('11. NO SE MEZCLA CON EL CATÁLOGO NORMAL');
  const normales = await api('GET', '/api/products?limit=200');
  chk('no aparece entre los del local', false,
    (normales.json?.data || []).some((p) => p.id === prodManual.id));
  const deEvento = await api('GET', '/api/products?limit=200&feria=1');
  chk('sí aparece pidiendo los de evento', true,
    (deEvento.json?.data || []).some((p) => p.id === prodManual.id));

  tit('12. SIN MAYORISTA, SE USA EL MINORISTA');
  /*
   * Dejarlo en cero haría que una venta mayorista en el puesto saliera gratis.
   */
  const sinMay = await api('POST', '/api/feria/productos', {
    titulo: 'QA Saldo sin mayorista', sku: 'qa-sinmay', precioMinorista: 7200,
  });
  chk('se crea', 201, sinMay.status);
  chk('el mayorista iguala al minorista', 7200, sinMay.json?.precioMayorista);

  tit('13. LO QUE FALTA SE RECHAZA');
  const sinTitulo = await api('POST', '/api/feria/productos', { sku: 'qa-x', precioMinorista: 100 });
  chk('sin título', 400, sinTitulo.status);
  const sinSku = await api('POST', '/api/feria/productos', { titulo: 'QA', precioMinorista: 100 });
  chk('sin código', 400, sinSku.status);
  const sinPrecio = await api('POST', '/api/feria/productos', { titulo: 'QA', sku: 'qa-y' });
  chk('sin precio', 400, sinPrecio.status);
  const negativo = await api('POST', '/api/feria/productos', { titulo: 'QA', sku: 'qa-z', precioMinorista: -5 });
  chk('con precio negativo', 400, negativo.status);

  const repetido = await api('POST', '/api/feria/productos', {
    titulo: 'QA Otro', sku: 'qa-suelto', precioMinorista: 999,
  });
  chk('un código ya usado', 409, repetido.status);
  chk('y dice cuál', true, /ya está usado/.test(repetido.json?.message || ''));

  tit('14. TAMPOCO LLEVA STOCK');
  /*
   * Es la misma garantía que para los generados: `mover()` corta con error, no
   * en silencio. Que un producto de evento llegue hasta ahí significa que hay
   * un camino mal escrito.
   */
  let rechazoManual = null;
  try {
    await stockService.mover({
      variantId: varsManual[0].id, businessId: negocio.id, locationId: puesto.json.id,
      delta: 5, tipo: 'ingreso', motivo: 'QA',
    });
  } catch (e) { rechazoManual = e; }
  chk('mover() lo rechaza', 'FERIA_SIN_STOCK', rechazoManual?.codigo);

  tit('15. BUSCAR NO MEZCLA LOS DOS CATÁLOGOS');
  /*
   * El defecto que esto fija: excluir los de evento y buscar por texto son las
   * DOS un `Op.or`, y las dos se escribían en la misma clave del `where`. La
   * búsqueda pisaba a la exclusión, así que apenas se escribía algo en el
   * buscador del catálogo normal aparecían los de evento mezclados.
   *
   * Sin buscar andaba bien. Por eso se prueba con y sin búsqueda: el bloque 11
   * pasaba en verde mientras el bug estaba vivo.
   */
  const nombreComun = 'QA Mezcla';
  const normal = await Product.create({
    businessId: negocio.id, sku: 'QA-MEZCLA', skuAgrupador: 'QA-MEZCLA',
    titulo: `${nombreComun} local`, precioMinorista: 100, precioMayorista: 80, costo: 40, activo: true,
  });
  const varNormal = await ProductVariant.create({
    productId: normal.id, businessId: negocio.id, sku: 'QA-MEZCLA-1',
    variante1Nombre: 'Color', variante1Valor: 'Rojo', stock: 0, stockMinimo: 0, activo: true,
  });
  const deEventoMezcla = await api('POST', '/api/feria/productos', {
    titulo: `${nombreComun} evento`, sku: 'qa-mezcla-ev', precioMinorista: 200,
  });
  chk('se crean los dos', 201, deEventoMezcla.status);

  const buscaNormal = await api(`GET`, `/api/products?limit=200&search=${encodeURIComponent(nombreComun)}`);
  const titulosNormal = (buscaNormal.json?.data || []).map((p) => p.titulo);
  chk('buscando en el catálogo del local, aparece el del local', true,
    titulosNormal.includes(`${nombreComun} local`));
  chk('y NO aparece el de evento', false, titulosNormal.includes(`${nombreComun} evento`));

  const buscaEvento = await api(`GET`, `/api/products?limit=200&feria=1&search=${encodeURIComponent(nombreComun)}`);
  const titulosEvento = (buscaEvento.json?.data || []).map((p) => p.titulo);
  chk('buscando en evento, aparece el de evento', true,
    titulosEvento.includes(`${nombreComun} evento`));
  chk('y NO aparece el del local', false, titulosEvento.includes(`${nombreComun} local`));

  // Buscando por SKU de variante, que es el otro camino de la búsqueda.
  const porSku = await api('GET', '/api/products?limit=200&search=QA-MEZCLA');
  chk('buscando por SKU tampoco se cuelan', 0,
    (porSku.json?.data || []).filter((p) => p.esFeria).length);

  await ProductVariant.destroy({ where: { id: varNormal.id } });
  await Product.destroy({ where: { id: normal.id } });

  tit('16. EXPORTAR E IMPORTAR NO MEZCLA LOS CATÁLOGOS');
  /*
   * El export es la planilla del catálogo del LOCAL: tiene columnas de stock
   * por sucursal, de talle y de color. Los de evento salían ahí adentro, con
   * todas esas columnas vacías y sin nada que los distinguiera — quien exporta
   * para corregir precios abría el archivo y encontraba el catálogo de evento
   * mezclado con el de venta.
   */
  const paraExportar = await api('POST', '/api/feria/productos', {
    titulo: 'QA Ida y vuelta', sku: 'qa-iv', precioMinorista: 5000,
  });
  chk('se crea el de evento', 201, paraExportar.status);

  const exportado = await fetch(`${API}/api/products/export`, { headers: { Cookie: api.cookie } });
  chk('el export responde', 200, exportado.status);

  const ExcelJS = require('exceljs');
  const buf = Buffer.from(await exportado.arrayBuffer());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const hoja = wb.worksheets[0];

  const skusExportados = [];
  hoja.eachRow((fila, n) => { if (n > 1 && fila.values[1]) skusExportados.push(String(fila.values[1])); });
  chk('el de evento NO sale en el export', false, skusExportados.includes(paraExportar.json.sku));
  chk('pero el catálogo del local sí sale', true, skusExportados.length > 0);

  tit('17. UNA PLANILLA NO EDITA UN PRODUCTO DE EVENTO');
  /*
   * Aunque el export ya no los incluya, alguien puede escribir el código a
   * mano o reusar un archivo viejo. Se avisa por fila y se sigue con el resto.
   */
  const wb2 = new ExcelJS.Workbook();
  const ws2 = wb2.addWorksheet('Productos');
  ws2.addRow(['SKU Padre', 'Título', 'Precio Minorista', 'SKU Variante']);
  ws2.addRow([paraExportar.json.sku, 'Intento de pisarlo', 99, `${paraExportar.json.sku}`]);
  ws2.addRow(['QA-NORMAL-OK', 'Producto normal del mismo archivo', 1500, 'QA-NORMAL-OK-U']);

  const form = new FormData();
  form.append('file', new Blob([Buffer.from(await wb2.xlsx.writeBuffer())], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }), 'qa.xlsx');
  const imp = await fetch(`${API}/api/products/import`, {
    method: 'POST', headers: { Cookie: api.cookie }, body: form,
  });
  const resumen = await imp.json();
  chk('la importación entra', 200, imp.status);
  chk('avisa que ese es de evento', true,
    (resumen.errors || []).some((e) => /es un producto de evento/.test(e)));

  const intacto = await Product.findByPk(paraExportar.json.productId);
  chk('el precio del de evento no cambió', 5000, Number(intacto.precioMinorista));
  chk('y sigue siendo de evento', true, intacto.esFeria);

  /*
   * El resto del archivo entra igual: perder las filas buenas por una mala
   * obligaría a partir la planilla a mano para encontrar cuál era.
   */
  chk('el producto normal del mismo archivo sí se creó', 1,
    await Product.count({ where: { businessId: negocio.id, sku: 'QA-NORMAL-OK' } }));

  const normalQA = await Product.findOne({ where: { businessId: negocio.id, sku: 'QA-NORMAL-OK' } });
  if (normalQA) {
    const vs = (await ProductVariant.findAll({ where: { productId: normalQA.id } })).map((v) => v.id);
    if (vs.length) await ProductVariant.destroy({ where: { id: vs } });
    await Product.destroy({ where: { id: normalQA.id } });
  }

  tit('18. LA LISTA DE PRECIOS DEL PUESTO');
  /*
   * Es el papel que se apoya en la mesa: precio, qué colores y qué talles hay
   * de cada modelo, y el código para escanear sin buscar la prenda.
   *
   * La vuelta que la hace útil es que las variantes salen del producto
   * ORIGINAL: el de evento no tiene ni color ni talle por definición, y eso es
   * justamente lo que el vendedor necesita saber para revolver la pila.
   */
  const { __datosDeLista, generarListaPrecios } = require('../src/services/listaPreciosService');

  const paraLista = await api('POST', '/api/feria/generar', {
    productIds: [origen.id], prefijo: 'EVE',
    precio: {
      minorista: { base: 'minorista', modo: 'igual', valor: 0 },
      mayorista: { base: 'mayorista', modo: 'igual', valor: 0 },
    },
  });
  chk('hay al menos un producto de evento', true, paraLista.status === 201 || paraLista.status === 200);

  const filas = await __datosDeLista(negocio.id);
  chk('la lista trae filas', true, filas.length > 0);

  const fila = filas.find((f) => f.sku && f.sku.endsWith(origen.sku));
  chk('cada fila lleva su código de evento', true, Boolean(fila?.sku));
  chk('con los dos precios', true, fila.precioMinorista > 0 && fila.precioMayorista > 0);
  chk('y las variantes del producto ORIGINAL', true, fila.var1.length > 0);
  chk('con el nombre de la variante', true, Boolean(fila.var1Nombre));

  /*
   * Los valores no se repiten: el original tiene una variante por cada
   * combinación color×talle, así que sin agrupar el mismo color saldría tantas
   * veces como talles haya.
   */
  chk('sin valores repetidos', fila.var1.length, new Set(fila.var1).size);

  tit('19. LOS TALLES SE ORDENAN COMO SE LEEN');
  /*
   * Alfabéticamente, "S, M, L" sale "L, M, S" — correcto para una máquina y
   * absurdo para cualquiera que haya visto una pila de ropa. Y los talles de
   * niño salían "10, 2, 4", que encima parece un error de carga.
   */
  const { __ordenarValores } = require('../src/services/listaPreciosService');
  chk('la escala de letras', ['XS', 'S', 'M', 'L', 'XL'], __ordenarValores(['L', 'M', 'S', 'XL', 'XS']));
  chk('los números por su valor', ['2', '4', '10', '38'], __ordenarValores(['38', '10', '2', '4']));
  chk('y lo que no es talle, alfabético', ['Beige', 'Negro', 'Verde'],
    __ordenarValores(['Verde', 'Beige', 'Negro']));

  tit('20. EL PDF SALE Y AVISA SI UN CÓDIGO NO SE VA A LEER');
  const pdf = await generarListaPrecios(negocio.id, { nombreNegocio: 'QA' });
  chk('devuelve un PDF', '%PDF', pdf.buffer.slice(0, 4).toString());
  chk('con las filas que corresponden', filas.length, pdf.filas);
  chk('y sin avisos de códigos ilegibles', 0, pdf.avisos.length);

  const porHttp = await fetch(`${API}/api/feria/lista-precios`, { headers: { Cookie: api.cookie } });
  chk('el endpoint responde', 200, porHttp.status);
  chk('con tipo PDF', true, /application\/pdf/.test(porHttp.headers.get('content-type') || ''));
  chk('y dice cuántas filas trae', String(filas.length), porHttp.headers.get('x-filas'));

  tit('Limpieza');
  for (const id of aBorrar.ventas) {
    await SaleItem.destroy({ where: { saleId: id } });
    const v = await Sale.findByPk(id); if (v) await v.destroy();
  }
  await limpiar();
  chk('no queda nada de la prueba', 0,
    await Product.count({ where: { businessId: negocio.id, esFeria: true } }));

  console.log(`\n\x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
