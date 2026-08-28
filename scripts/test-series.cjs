/*
 * Series: sobre qué variante se arma el conjunto.
 *
 * Una serie es un conjunto de artículos del mismo modelo que comparten una
 * variante y se diferencian en la otra. Cuál se fija cambia por completo lo
 * que entra al depósito, y ésa es la razón de este archivo:
 *
 *   Remera · colores Negro/Blanco · talles S/M/L
 *   3 series fijando el COLOR Negro → 3 de cada talle  = 9 unidades
 *   3 series fijando el TALLE M     → 3 de cada color  = 6 unidades
 *
 * Hasta hace poco el eje estaba cableado: siempre se fijaba la primera
 * variante. El que compra "diez de cada color en talle M" no tenía forma de
 * cargarlo, y lo peor es que no había ningún error: entraba otra cosa.
 *
 * Uso:  API=http://localhost:3000 node scripts/test-series.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const API = process.env.API || 'http://localhost:3000';
const {
  Business, BusinessLocation, Product, ProductVariant, VariantStock,
  StockIngreso, StockIngresoItem, StockMovement,
} = require('../src/models');
const deposito = require('../src/services/depositoService');
const stock = require('../src/services/stockService');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

function sesion() {
  let cookie = '';
  return async (m, ruta, cuerpo) => {
    const r = await fetch(`${API}${ruta}`, {
      method: m,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    const set = r.headers.getSetCookie?.() || [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    let json = null; try { json = JSON.parse(await r.text()); } catch { /* no json */ }
    return { status: r.status, json };
  };
}

const fallo = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

(async () => {
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  const dep = await BusinessLocation.findOne({ where: { businessId: negocio.id, tipo: 'deposito' } });

  /*
   * Un producto de dos dimensiones, chico y asimétrico a propósito.
   *
   * 2 colores × 3 talles = 6 variantes. Asimétrico importa: si fueran 3 y 3,
   * fijar uno u otro daría el mismo total y un error de eje pasaría
   * desapercibido.
   */
  const prod = await Product.create({
    businessId: negocio.id, sku: 'QA-SER', skuAgrupador: 'QA-SER', titulo: 'QA Serie',
    precioMinorista: 100, precioMayorista: 80, costo: 40, activo: true,
  });
  const variantes = {};
  for (const color of ['Negro', 'Blanco']) {
    for (const talle of ['S', 'M', 'L']) {
      variantes[`${color}-${talle}`] = await ProductVariant.create({
        productId: prod.id, businessId: negocio.id, sku: `QA-SER-${color[0]}${talle}`,
        variante1Nombre: 'Color', variante1Valor: color,
        variante2Nombre: 'Talle', variante2Valor: talle,
        stock: 0, stockMinimo: 0, activo: true,
      });
    }
  }

  // Un producto de una sola dimensión, para la otra rama.
  const simple = await Product.create({
    businessId: negocio.id, sku: 'QA-SER1', skuAgrupador: 'QA-SER1', titulo: 'QA Serie simple',
    precioMinorista: 100, precioMayorista: 80, costo: 40, activo: true,
  });
  const simples = [];
  for (const color of ['Rojo', 'Verde', 'Azul', 'Gris']) {
    simples.push(await ProductVariant.create({
      productId: simple.id, businessId: negocio.id, sku: `QA-SER1-${color[0]}`,
      variante1Nombre: 'Color', variante1Valor: color, stock: 0, stockMinimo: 0, activo: true,
    }));
  }

  const api = sesion();
  const login = await api('POST', '/api/auth/login', { email: negocio.email, password: 'Demo2026!!' });
  if (login.status !== 200) { console.log('No se pudo entrar:', login.status); process.exit(1); }

  const ingresos = [];
  const en = async (v) => stock.stockEn(v.id, dep.id);

  try {
    // ─────────────────────────────────────────────────────────────
    tit('1. QUÉ SE PUEDE FIJAR');
    const porColor = await deposito.ejeDeCurva(prod.id, negocio.id, null, null,
      { exigirValor: false, eje: 'variante1' });
    chk('fijando la primera, pide el color', true, porColor.necesitaValor);
    chk('y ofrece los dos colores', ['Negro', 'Blanco'], porColor.opciones);
    chk('diciendo que recorre los talles', 'Talle', porColor.ejeRecorrido);

    const porTalle = await deposito.ejeDeCurva(prod.id, negocio.id, null, null,
      { exigirValor: false, eje: 'variante2' });
    chk('fijando la segunda, pide el talle', true, porTalle.necesitaValor);
    chk('y ofrece los tres talles', ['S', 'M', 'L'], porTalle.opciones);
    chk('diciendo que recorre los colores', 'Color', porTalle.ejeRecorrido);

    // ─────────────────────────────────────────────────────────────
    tit('2. EL EJE CAMBIA LO QUE ENTRA');
    const abiertoColor = await deposito.ejeDeCurva(prod.id, negocio.id, 'Negro', null, { eje: 'variante1' });
    chk('fijando Negro salen 3 valores', 3, abiertoColor.valores.length);
    chk('que son los talles', ['S', 'M', 'L'], abiertoColor.valores.map((v) => v.valor));

    const abiertoTalle = await deposito.ejeDeCurva(prod.id, negocio.id, 'M', null, { eje: 'variante2' });
    chk('fijando M salen 2 valores', 2, abiertoTalle.valores.length);
    chk('que son los colores', ['Negro', 'Blanco'], abiertoTalle.valores.map((v) => v.valor));

    // ─────────────────────────────────────────────────────────────
    tit('3. TRES SERIES POR COLOR = 9 UNIDADES');
    const r1 = await api('POST', '/api/deposito/ingresos', {
      locationId: dep.id, origen: 'etiquetas',
      curvas: [{ productId: prod.id, valor: 'Negro', eje: 'variante1', cantidad: 3 }],
    });
    if (r1.json?.id) ingresos.push(r1.json.id);
    chk('el ingreso entra', 201, r1.status);
    chk('Negro S queda en 3', 3, await en(variantes['Negro-S']));
    chk('Negro M queda en 3', 3, await en(variantes['Negro-M']));
    chk('Negro L queda en 3', 3, await en(variantes['Negro-L']));
    chk('y Blanco sin tocar', 0, await en(variantes['Blanco-M']));

    // ─────────────────────────────────────────────────────────────
    tit('4. TRES SERIES POR TALLE = 6 UNIDADES');
    /*
     * El mismo número —3— sobre el otro eje. Si el eje no se respetara, esto
     * volvería a cargar los talles del primer color y el error sería mudo.
     */
    const r2 = await api('POST', '/api/deposito/ingresos', {
      locationId: dep.id, origen: 'etiquetas',
      curvas: [{ productId: prod.id, valor: 'M', eje: 'variante2', cantidad: 3 }],
    });
    if (r2.json?.id) ingresos.push(r2.json.id);
    chk('el ingreso entra', 201, r2.status);
    chk('Negro M sube a 6', 6, await en(variantes['Negro-M']));
    chk('Blanco M queda en 3', 3, await en(variantes['Blanco-M']));
    chk('Negro S no se movió', 3, await en(variantes['Negro-S']));
    chk('Blanco S sigue en cero', 0, await en(variantes['Blanco-S']));

    // ─────────────────────────────────────────────────────────────
    tit('5. SIN EJE, SE COMPORTA COMO ANTES');
    // Las series ya cargadas y cualquier integración vieja siguen significando lo
    // mismo: si no se dice nada, se fija la primera variante.
    const r3 = await api('POST', '/api/deposito/ingresos', {
      locationId: dep.id, origen: 'etiquetas',
      curvas: [{ productId: prod.id, valor: 'Blanco', cantidad: 1 }],
    });
    if (r3.json?.id) ingresos.push(r3.json.id);
    chk('el ingreso entra', 201, r3.status);
    chk('Blanco S sube a 1', 1, await en(variantes['Blanco-S']));
    chk('Blanco L sube a 1', 1, await en(variantes['Blanco-L']));

    // ─────────────────────────────────────────────────────────────
    tit('6. SERIE DESPAREJA');
    const r4 = await api('POST', '/api/deposito/ingresos', {
      locationId: dep.id, origen: 'etiquetas',
      curvas: [{ productId: prod.id, valor: 'M', eje: 'variante2', porValor: { Negro: 5, Blanco: 2 } }],
    });
    if (r4.json?.id) ingresos.push(r4.json.id);
    chk('el ingreso entra', 201, r4.status);
    chk('Negro M suma 5', 11, await en(variantes['Negro-M']));
    // Blanco M venía de 3 (paso 4) + 1 (paso 5, serie por color) = 4, más estas 2.
    chk('Blanco M suma 2', 6, await en(variantes['Blanco-M']));

    // ─────────────────────────────────────────────────────────────
    tit('7. UNA SOLA DIMENSIÓN: NO HAY NADA QUE ELEGIR');
    const uno = await deposito.ejeDeCurva(simple.id, negocio.id, null, null, { exigirValor: false, eje: 'variante2' });
    chk('no pide valor', undefined, uno.necesitaValor);
    chk('lo dice explícitamente', true, uno.unaDimension);
    chk('y recorre las cuatro variantes', 4, uno.valores.length);

    const r5 = await api('POST', '/api/deposito/ingresos', {
      locationId: dep.id, origen: 'etiquetas',
      curvas: [{ productId: simple.id, cantidad: 2, eje: 'variante2' }],
    });
    if (r5.json?.id) ingresos.push(r5.json.id);
    chk('se puede cargar igual', 201, r5.status);
    chk('2 de cada color', [2, 2, 2, 2], await Promise.all(simples.map(en)));

    // ─────────────────────────────────────────────────────────────
    tit('8. LO QUE NO EXISTE SE RECHAZA');
    const msgValor = await fallo(() => deposito.ejeDeCurva(prod.id, negocio.id, 'Violeta', null, { eje: 'variante1' }));
    chk('un color que no está', true, /No hay variantes de "Violeta"/.test(msgValor || ''));

    const msgTalle = await fallo(() => deposito.ejeDeCurva(prod.id, negocio.id, 'XXL', null, { eje: 'variante2' }));
    chk('un talle que no está', true, /No hay variantes de "XXL"/.test(msgTalle || ''));

    /*
     * Un eje inventado no rompe: cae al de siempre.
     *
     * Es una decisión, no un descuido. Un cliente de la API que mande basura
     * en ese campo tiene que recibir el comportamiento anterior, no un 500.
     */
    const raro = await deposito.ejeDeCurva(prod.id, negocio.id, 'Negro', null, { eje: 'cualquier-cosa' });
    chk('un eje inventado cae al de siempre', 'variante1', raro.ejeUsado);
    chk('y abre los talles', 3, raro.valores.length);

    // ─────────────────────────────────────────────────────────────
    tit('9. UNA SERIE VACÍA NO PASA');
    const vacia = await api('POST', '/api/deposito/ingresos', {
      locationId: dep.id, origen: 'etiquetas',
      curvas: [{ productId: prod.id, valor: 'Negro', eje: 'variante1', porValor: { S: 0, M: 0, L: 0 } }],
    });
    if (vacia.json?.id) ingresos.push(vacia.json.id);
    chk('se rechaza', 400, vacia.status);
    chk('y dice por qué', true, /quedó sin ninguna unidad/.test(vacia.json?.message || ''));
  } finally {
    tit('Limpieza');
    for (const id of ingresos) {
      await StockIngresoItem.destroy({ where: { ingresoId: id } });
      await StockIngreso.destroy({ where: { id } });
    }
    const ids = [...Object.values(variantes), ...simples].map((v) => v.id);
    await StockMovement.destroy({ where: { productVariantId: ids } });
    await VariantStock.destroy({ where: { productVariantId: ids } });
    await ProductVariant.destroy({ where: { id: ids } });
    await Product.destroy({ where: { id: [prod.id, simple.id] } });
    chk('no quedan variantes de prueba', 0, await ProductVariant.count({ where: { id: ids } }));
  }

  console.log(`\n\x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
