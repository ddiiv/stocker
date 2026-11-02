/*
 * Catálogo descargable: una fila por producto padre, para compartir.
 *
 * Lo delicado es la columna "Precios distintos": tiene que decir en una línea
 * qué talle o color vale más sin que nadie tenga que abrir el producto. Esa
 * parte es una función pura y se prueba aunque la base no esté; el resto —qué
 * entra al catálogo y qué no— se prueba contra el negocio demo.
 *
 * Uso:  API=http://localhost:3000 node scripts/test-catalogo.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const API = process.env.API || 'http://localhost:3000';
const { preciosDistintos } = require('../src/services/catalogoService');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const fin = () => {
  console.log(`\n\x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
};

(async () => {
  tit('1. PRECIOS DISTINTOS (función pura)');
  chk('todas iguales: vacío', '', preciosDistintos([
    { v1: 'Negro', v2: 'S', precio: 100 }, { v1: 'Negro', v2: 'M', precio: 100 },
  ]));
  chk('sin variantes: vacío', '', preciosDistintos([{ v1: null, v2: null, precio: 100 }]));

  const talles = ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'];
  const porTalle = ['Negro', 'Melang'].flatMap((color) => talles.map((t) => ({
    v1: color, v2: t, precio: ['3XL', '4XL'].includes(t) ? 21000 : 17000,
  })));
  chk('agrupa por la variante 2 cuando es la que separa, con los talles en orden',
    '$ 17.000 (S, M, L, XL, 2XL) · $ 21.000 (3XL, 4XL)', preciosDistintos(porTalle));

  chk('si la que separa es la variante 1, agrupa por ésa',
    '$ 100 (Negro) · $ 120 (Rojo)',
    preciosDistintos([
      { v1: 'Rojo', v2: 'S', precio: 120 }, { v1: 'Negro', v2: 'S', precio: 100 },
      { v1: 'Rojo', v2: 'M', precio: 120 }, { v1: 'Negro', v2: 'M', precio: 100 },
    ]));

  chk('si ninguna sola lo explica, lista combinaciones',
    '$ 100 (Negro / S, Rojo / M) · $ 120 (Rojo / S, Negro / M)',
    preciosDistintos([
      { v1: 'Negro', v2: 'S', precio: 100 }, { v1: 'Rojo', v2: 'S', precio: 120 },
      { v1: 'Negro', v2: 'M', precio: 120 }, { v1: 'Rojo', v2: 'M', precio: 100 },
    ]));

  const muchas = Array.from({ length: 9 }, (_, i) => ({ v1: `C${i}`, v2: 'U', precio: 10 }))
    .concat([{ v1: 'C1', v2: 'X', precio: 20 }, { v1: 'C2', v2: 'X', precio: 10 }]);
  chk('y las recorta cuando son muchas',
    '$ 10 (C0 / U, C1 / U, C2 / U, C3 / U, C4 / U, C5 / U y 4 más) · $ 20 (C1 / X)', preciosDistintos(muchas));

  /*
   * Lo que sigue necesita la base. Sin ella se dice y se termina con lo que
   * se pudo probar, en vez de fallar por algo que no es el catálogo.
   */
  let negocio, models;
  try {
    models = require('../src/models');
    negocio = await models.Business.findOne({ where: { email: 'demo@stocker.app' } });
    if (!negocio) throw new Error('no está el negocio demo');
  } catch (e) {
    console.log(`\n(base no disponible: ${e.message}; se saltan las pruebas contra la base)`);
    return fin();
  }
  const { Product, ProductVariant } = models;
  const { datosDeCatalogo } = require('../src/services/catalogoService');

  const marca = Date.now();
  const creados = { productos: [], variantes: [] };
  const producto = async (datos, variantes = []) => {
    const p = await Product.create({
      businessId: negocio.id, skuAgrupador: datos.sku, precioMayorista: 0, costo: 0, activo: true, ...datos,
    });
    creados.productos.push(p.id);
    for (const v of variantes) {
      const pv = await ProductVariant.create({
        productId: p.id, businessId: negocio.id, stock: 0, stockMinimo: 0, ...v,
      });
      creados.variantes.push(pv.id);
    }
    return p;
  };

  try {
    tit('2. QUÉ ENTRA AL CATÁLOGO');
    const remera = await producto({
      sku: `QA-CAT-R-${marca}`, titulo: `QA Catálogo Remera ${marca}`,
      precioMinorista: 17000, precioMayorista: 12000, descripcion: 'Algodón peinado',
    }, ['Negro', 'Melang'].flatMap((color) => ['M', 'S', '3XL'].map((talle) => ({
      sku: `QA-CAT-R-${marca}-${color}-${talle}`,
      variante1Nombre: 'Color', variante1Valor: color, variante2Nombre: 'Talle', variante2Valor: talle,
      precioMinorista: talle === '3XL' ? 21000 : null,
    }))));
    // La variante "Oferta" no entra: si entrara, su precio aparecería en "Precios distintos".
    await producto({
      sku: `QA-CAT-B-${marca}`, titulo: `QA Catálogo Buzo ${marca}`, precioMinorista: 30000,
    }, [
      { sku: `QA-CAT-B-${marca}-U`, variante1Nombre: 'Talle', variante1Valor: 'Único' },
      { sku: `QA-CAT-B-${marca}-O`, variante1Nombre: 'Talle', variante1Valor: 'OFERTA', precioMinorista: 1000 },
      { sku: `QA-CAT-B-${marca}-I`, variante1Nombre: 'Talle', variante1Valor: 'XL', precioMinorista: 2000, activo: false },
    ]);
    await producto({ sku: `QA-CAT-O-${marca}`, titulo: `QA Catálogo Oferta ${marca}`, precioMinorista: 1 });
    await producto({ sku: `QA-CAT-X-${marca}-BAJA1`, titulo: `QA Catálogo Baja ${marca}`, precioMinorista: 1 });
    await producto({ sku: `QA-CAT-I-${marca}`, titulo: `QA Catálogo Inactivo ${marca}`, precioMinorista: 1, activo: false });
    await producto({ sku: `QA-CAT-F-${marca}`, titulo: `QA Catálogo Evento ${marca}`, precioMinorista: 1, esFeria: true });

    const filas = (await datosDeCatalogo(negocio.id)).filter((f) => f.producto.includes(String(marca)));
    chk('sólo la remera y el buzo (sin oferta, baja, inactivo ni evento)',
      [`QA Catálogo Buzo ${marca}`, `QA Catálogo Remera ${marca}`], filas.map((f) => f.producto).sort());

    const fr = filas.find((f) => f.producto === remera.titulo) || {};
    chk('dimensiones con nombre y valores ordenados', ['Color: Melang, Negro', 'Talle: S, M, 3XL'], [fr.variante1, fr.variante2]);
    chk('precio minorista = el menor', 17000, fr.precioMinorista);
    chk('precio mayorista = el del padre', 12000, fr.precioMayorista);
    chk('aclara el precio distinto por talle (el mayorista es parejo)',
      'Minorista: $ 17.000 (S, M) · $ 21.000 (3XL)', fr.preciosDistintos);
    chk('lleva la descripción', 'Algodón peinado', fr.descripcion);

    const fb = filas.find((f) => f.producto.startsWith('QA Catálogo Buzo')) || {};
    chk('el buzo: sin la variante oferta ni la inactiva', ['Talle: Único', 30000, ''],
      [fb.variante1, fb.precioMinorista, fb.preciosDistintos]);
    chk('sin precio mayorista cargado, se informa el minorista', 30000, fb.precioMayorista);

    tit('3. EL ENDPOINT');
    const login = await fetch(`${API}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: negocio.email, password: 'Demo2026!!' }),
    });
    chk('se entra como el demo', 200, login.status);
    const cookie = (login.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');

    const r = await fetch(`${API}/api/products/catalogo`, { headers: { Cookie: cookie } });
    chk('responde', 200, r.status);
    chk('como planilla', true, /spreadsheetml/.test(r.headers.get('content-type') || ''));

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
    const hoja = wb.getWorksheet('Catálogo');
    chk('hoja Catálogo con sus columnas',
      ['SKU agrupador', 'Producto padre', 'Variante 1', 'Variante 2', 'Precio minorista',
        'Precio mayorista', 'Precios distintos', 'Descripción'],
      hoja?.getRow(1).values.slice(1));
    chk('cabecera congelada y con autofiltro', ['frozen', 1, true],
      [hoja?.views?.[0]?.state, hoja?.views?.[0]?.ySplit, Boolean(hoja?.autoFilter)]);
    let filaRemera = null;
    hoja?.eachRow((f, n) => { if (n > 1 && f.getCell(2).value === remera.titulo) filaRemera = f; });
    chk('la remera sale con precio en pesos', [17000, '"$" #,##0'],
      [filaRemera?.getCell(5).value, filaRemera?.getCell(5).numFmt]);

    const sinSesion = await fetch(`${API}/api/products/catalogo`);
    chk('sin sesión no se descarga', 401, sinSesion.status);
  } finally {
    tit('Limpieza');
    await ProductVariant.destroy({ where: { id: creados.variantes } });
    await Product.destroy({ where: { id: creados.productos } });
    chk('no queda nada de la prueba', 0, await Product.count({ where: { id: creados.productos } }));
  }
  fin();
})().catch((e) => { console.error(e); process.exit(1); });
