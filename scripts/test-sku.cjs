/*
 * Confección de SKU: la fórmula y sus garantías.
 *
 * Es la parte donde un error no se ve hasta que es tarde. Un SKU mal armado no
 * rompe nada en el momento: rompe cuando el empleado escanea una etiqueta y le
 * suma stock a la variante equivocada, o cuando el alta de un producto entero
 * se cae porque dos combinaciones dieron lo mismo.
 *
 * Uso:  node scripts/test-sku.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const sku = require('../src/services/skuService');
const { Business, Product, ProductVariant } = require('../src/models');

let ok = 0, ko = 0;
const chk = (t, esperado, obtuvo) => {
  const a = JSON.stringify(esperado), b = JSON.stringify(obtuvo);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const R = sku.REGLA_POR_DEFECTO;
const comp = (agrupador, pares, regla = R) =>
  sku.componer({ agrupador, valores: pares.map(([eje, valor]) => ({ eje, valor })), regla });

(async () => {
  tit('1. LA REGLA DE FÁBRICA — 3 letras, pegadas, sin separador entre valores');
  chk('un eje',            'BA-010-BEI',    comp('BA-010', [['Color', 'Beige']]));
  chk('dos ejes pegados',  'BA-010-BEIM',   comp('BA-010', [['Color', 'Beige'], ['Talle', 'M']]));
  chk('valor más corto que el tope queda entero', 'BA-010-BEIM', comp('BA-010', [['Color','Beige'],['Talle','M']]));
  chk('sin variantes es el agrupador solo',  'BA-010',       comp('BA-010', []));
  chk('un valor vacío no deja el separador colgando', 'BA-010-BEI', comp('BA-010', [['Color','Beige'],['Talle','']]));

  tit('2. NORMALIZACIÓN');
  chk('acentos fuera, no la letra',   'BA-1-MAR',  comp('BA-1', [['Color', 'Marrón']]));
  chk('espacios fuera',               'BA-1-AZU',  comp('BA-1', [['Color', 'Azul Marino']]));
  chk('mayúsculas',                   'BA-1-ROJ',  comp('BA-1', [['Color', 'rojo']]));
  chk('signos fuera',                 'BA-1-TAL',  comp('BA-1', [['Talle', 'Talle/38']]));
  chk('la ñ sobrevive como N',        'BA-1-NAN',  comp('BA-1', [['Color', 'Ñandú']]));
  chk('un valor sin letras no aporta nada', 'BA-1', comp('BA-1', [['Color', '###']]));

  tit('3. ABREVIATURAS — la salida a los choques de 3 letras');
  const conAbrev = { ...R, abreviaturas: { Color: { 'Azul Marino': 'AZM', 'Azul Claro': 'AZC' } } };
  chk('la excepción manda sobre el corte', 'X-AZM', comp('X', [['Color', 'Azul Marino']], conAbrev));
  chk('y también se normaliza',            'X-AZM', comp('X', [['Color', 'Azul Marino']], { ...conAbrev, abreviaturas: { Color: { 'Azul Marino': 'azm' } } }));
  chk('un valor sin excepción sigue la regla', 'X-VER', comp('X', [['Color', 'Verde']], conAbrev));
  chk('la excepción de otro eje no se aplica', 'X-AZU', comp('X', [['Talle', 'Azul Marino']], conAbrev));

  tit('4. LÍMITES DE LA REGLA — un valor inválido no puede romper el SKU');
  chk('caracteres en 0 se lleva a 1',   1,  sku.reglaCompleta({ caracteres: 0 }).caracteres);
  chk('caracteres negativo se lleva a 1', 1, sku.reglaCompleta({ caracteres: -5 }).caracteres);
  chk('caracteres gigante se topea',    10, sku.reglaCompleta({ caracteres: 999 }).caracteres);
  chk('caracteres no numérico usa el default', 3, sku.reglaCompleta({ caracteres: 'muchos' }).caracteres);
  chk('separador larguísimo se recorta', 3,  sku.reglaCompleta({ separadorAgrupador: '-----' }).separadorAgrupador.length);
  chk('abreviaturas basura se ignoran', {},  sku.reglaCompleta({ abreviaturas: 'no' }).abreviaturas);
  chk('regla nula da la de fábrica',    R.caracteres, sku.reglaCompleta(null).caracteres);

  tit('5. CHOQUES — el motivo de que exista la pantalla');
  const ejesChoque = [{ nombre: 'Color', valores: ['Azul Marino', 'Azul Claro'] }, { nombre: 'Talle', valores: ['S', 'M'] }];
  const tres = await sku.vistaPrevia({ businessId: null, agrupador: 'T', ejes: ejesChoque });
  chk('con 3 letras, los dos azules chocan', 4, tres.filas.filter((f) => f.duplicadoEnLaTabla).length);

  /*
   * Señalar al culpable, no a los acompañantes.
   *
   * Si dos colores chocan, todas sus filas salen repetidas y los talles quedan
   * dentro de filas rojas sin tener la culpa. Abreviar un talle no arregla
   * nada: el detalle por eje tiene que marcar sólo los colores.
   */
  const color = tres.ejes.find((e) => e.nombre === 'Color');
  const talle = tres.ejes.find((e) => e.nombre === 'Talle');
  chk('marca los dos colores como causa', 2, color.valores.filter((v) => v.choca).length);
  chk('no acusa a ningún talle',          0, talle.valores.filter((v) => v.choca).length);
  chk('y dice qué código da cada uno',  'AZU', color.valores[0].codigo);

  const arreglado = await sku.vistaPrevia({
    businessId: null, agrupador: 'T', ejes: ejesChoque,
    regla: { abreviaturas: { Color: { 'Azul Marino': 'AZM', 'Azul Claro': 'AZC' } } },
  });
  chk('con abreviaturas no chocan', 0, arreglado.filas.filter((f) => f.duplicadoEnLaTabla).length);
  chk('y no queda ningún valor acusado', 0,
    arreglado.ejes.flatMap((e) => e.valores).filter((v) => v.choca).length);

  /*
   * El caso que rompía el alta antes de este cambio: el corte a 10 caracteres
   * hacía que dos talles distintos del mismo color dieran el mismo SKU.
   */
  const viejo = (v1, v2) => `Q-${[v1, v2].filter(Boolean).join('').replace(/\s/g, '').toUpperCase().slice(0, 10)}`;
  chk('la fórmula vieja SÍ chocaba (regresión)', true, viejo('Azul Marino', 'XL') === viejo('Azul Marino', 'XXL'));
  chk('la nueva no',                            false, comp('Q', [['C','Azul Marino'],['T','XL']]) === comp('Q', [['C','Azul Marino'],['T','XXL']]));

  tit('6. UNICIDAD CONTRA LA BASE');
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  const existente = await ProductVariant.findOne({ where: { businessId: negocio.id } });
  chk('un SKU del catálogo figura ocupado',  false, await sku.estaLibre(negocio.id, existente.sku));
  chk('uno inventado figura libre',           true, await sku.estaLibre(negocio.id, 'NO-EXISTE-' + Date.now()));
  chk('la propia variante no es su conflicto', true, await sku.estaLibre(negocio.id, existente.sku, existente.id));

  const otro = await Business.findOne({ where: { id: { [require('sequelize').Op.ne]: negocio.id } } });
  if (otro) {
    chk('el mismo SKU está libre en otro negocio', true, await sku.estaLibre(otro.id, existente.sku));
  }

  tit('7. LIBERAR — numera en vez de reventar');
  const libre1 = await sku.liberar(negocio.id, existente.sku);
  chk('sobre uno ocupado devuelve el siguiente', `${existente.sku}-2`, libre1);
  chk('sobre uno libre devuelve el mismo',       'ZZZ-LIBRE', await sku.liberar(negocio.id, 'ZZZ-LIBRE'));
  chk('nunca devuelve algo ya tomado',           true, await sku.estaLibre(negocio.id, libre1));
  chk('respeta el largo de la columna',          true, (await sku.liberar(negocio.id, 'A'.repeat(200))).length <= 100);

  tit('8. VISTA PREVIA CONTRA EL CATÁLOGO REAL');
  const p = await Product.findByPk(existente.productId);
  const contra = await sku.vistaPrevia({
    businessId: negocio.id,
    agrupador: p.skuAgrupador,
    // Los DOS ejes de la variante: con uno solo se arma otro SKU y el test
    // pasaría o fallaría por el motivo equivocado.
    ejes: [
      { nombre: existente.variante1Nombre || 'Color', valores: [existente.variante1Valor] },
      ...(existente.variante2Valor
        ? [{ nombre: existente.variante2Nombre || 'Talle', valores: [existente.variante2Valor] }]
        : []),
    ],
    /*
     * La regla real del negocio, no una inventada.
     *
     * Antes decía `{ caracteres: 50 }` para reproducir SKUs que el demo armaba
     * con el valor entero. Desde que el demo usa la misma regla que la
     * aplicación, forzar otra hace que la vista previa arme un código distinto
     * del guardado y el test falle por el motivo equivocado.
     */
    regla: await sku.reglaDe(negocio.id),
  });
  chk('marca como existente lo que ya está', true, contra.filas.some((f) => f.yaExiste));

  tit('9. BUSCAR PRODUCTOS POR EL SKU DE LA VARIANTE');
  /*
   * Es como se busca en el mostrador: lo impreso en la etiqueta es el SKU de la
   * variante, no el del producto padre. Antes eso no devolvía nada y había que
   * adivinar el nombre del producto.
   */
  const API = process.env.API || 'http://localhost:3000';
  let cookie = '';
  const pedir = async (ruta, cuerpo) => {
    const r = await fetch(`${API}${ruta}`, {
      method: cuerpo ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    const set = r.headers.getSetCookie?.() || [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    return r.json().catch(() => null);
  };
  await pedir('/api/auth/login', { email: 'demo@stocker.app', password: 'Demo2026!!' });

  const buscar = async (q) => (await pedir(`/api/products?search=${encodeURIComponent(q)}&limit=50`))?.total ?? -1;
  const unaVariante = await ProductVariant.findOne({
    where: { businessId: negocio.id, codigoBarras: { [require('sequelize').Op.ne]: null } },
    include: [{ association: 'producto', attributes: ['titulo'] }],
  });

  chk('el SKU completo de la variante encuentra su producto', 1, await buscar(unaVariante.sku));
  chk('un pedazo del SKU también',        true, (await buscar(unaVariante.sku.slice(-6))) >= 1);
  chk('el código de barras encuentra su producto', 1, await buscar(unaVariante.codigoBarras));
  chk('el título sigue funcionando',      true, (await buscar(unaVariante.producto.titulo)) >= 1);
  chk('algo inexistente no devuelve nada',   0, await buscar('NO-EXISTE-' + Date.now()));

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
