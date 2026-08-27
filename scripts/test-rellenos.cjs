/*
 * Los rellenos de esquema, revisados sin base de datos.
 *
 * Existe por un error que llegó a producción: el relleno del costo de venta
 * estaba escrito con la sintaxis de SQL Server en el campo de Postgres, y allá
 * respondía `relation "si" does not exist`. Como el error se atrapa y se
 * imprime como aviso, el arranque seguía y la aplicación funcionaba —el
 * agregado cae al costo actual del producto—, así que nadie lo notaba salvo
 * mirando los logs del motor.
 *
 * El desarrollo local corre sobre SQL Server, así que la variante de Postgres
 * no se ejecuta nunca acá. Esta comprobación es lo único que la mira: no
 * ejecuta el SQL, revisa que tenga la forma del motor al que va dirigido.
 *
 * Uso:  node scripts/test-rellenos.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const { COLUMNAS_ESPERADAS } = require('../src/database/ensureColumns');
const fuente = require('fs').readFileSync(__dirname + '/../src/database/ensureColumns.js', 'utf8');

let ok = 0, ko = 0;
const chk = (t, cond, detalle) => {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}${detalle ? `\n      ${detalle}` : ''}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/*
 * Se leen del módulo, no del texto: así se comprueba lo que realmente se
 * ejecuta y no una copia que quedó vieja.
 */
const { RELLENOS } = (() => {
  // RELLENOS no se exporta —no hace falta en producción—, así que se evalúa el
  // archivo en un contexto donde sí quede a la vista.
  const mod = { exports: {} };
  const codigo = fuente.replace(
    /module\.exports = \{([^}]*)\}/,
    'module.exports = {$1, RELLENOS, INDICES }',
  );
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', codigo)(mod, mod.exports, require);
  return mod.exports;
})();

(async () => {
  tit('1. TODOS LOS RELLENOS TIENEN LAS DOS VARIANTES');
  for (const r of RELLENOS) {
    chk(`"${r.descripcion}" trae sql y sqlMssql`, Boolean(r.sql && r.sqlMssql));
  }

  tit('2. LA VARIANTE DE POSTGRES NO USA SINTAXIS DE SQL SERVER');
  for (const r of RELLENOS) {
    const sql = String(r.sql);

    /*
     * `UPDATE alias SET alias.columna` es de SQL Server. En Postgres el SET no
     * lleva el alias adelante, y el nombre suelto se lee como una tabla que no
     * existe.
     */
    const setConAlias = /UPDATE\s+\w+\s+SET\s+\w+\./i.test(sql);
    chk(`"${r.descripcion}" — el SET no lleva alias adelante`, !setConAlias,
      setConAlias ? 'Postgres va a responder: relation "..." does not exist' : null);

    /*
     * En Postgres la tabla que se actualiza no puede repetirse en el FROM: se
     * relaciona desde el WHERE. Repetirla la convierte en una segunda copia y
     * el UPDATE toca filas que no corresponden.
     */
    const m = sql.match(/UPDATE\s+([\w"]+)/i);
    if (m && /\bFROM\b/i.test(sql)) {
      const tabla = m[1].replace(/"/g, '');
      /*
       * Sólo la cláusula FROM, cortada antes del WHERE.
       *
       * Mirando la consulta entera daba falso positivo en los rellenos
       * correctos: ahí la tabla actualizada aparece en el WHERE calificando
       * columnas —`WHERE p.id = product_variants."productId"`— que es
       * exactamente como se escribe bien en Postgres.
       */
      const clausulaFrom = (sql.split(/\bFROM\b/i)[1] || '').split(/\bWHERE\b/i)[0];
      const enFrom = new RegExp(`\\b${tabla}\\b`, 'i').test(clausulaFrom);
      chk(`"${r.descripcion}" — la tabla actualizada no se repite en el FROM`, !enFrom,
        enFrom ? `"${tabla}" aparece en el FROM y en el UPDATE` : null);
    }

    // Funciones que sólo existen en SQL Server.
    const soloMssql = /\b(GETDATE|ISNULL|CROSS APPLY|TOP\s+\d+|CONVERT\s*\()/i.exec(sql);
    chk(`"${r.descripcion}" — no usa funciones de SQL Server`, !soloMssql,
      soloMssql ? `usa ${soloMssql[1]}` : null);
  }

  tit('3. LA VARIANTE DE SQL SERVER NO USA SINTAXIS DE POSTGRES');
  for (const r of RELLENOS) {
    const sql = String(r.sqlMssql);
    const soloPg = /\b(NOW\s*\(\)|COALESCE\s*\([^)]*\)\s*::|LATERAL|ILIKE|::\w+)/i.exec(sql);
    chk(`"${r.descripcion}" — no usa funciones de Postgres`, !soloPg,
      soloPg ? `usa ${soloPg[1]}` : null);
    // En SQL Server los identificadores camelCase no se citan con comillas
    // dobles salvo que QUOTED_IDENTIFIER esté en ON; el proyecto usa corchetes.
    chk(`"${r.descripcion}" — no cita con comillas dobles`, !/"[a-zA-Z]\w*"/.test(sql));
  }

  tit('4. CADA RELLENO APUNTA A UNA COLUMNA QUE EXISTE');
  for (const r of RELLENOS) {
    if (!r.cuandoSeAgrega) { chk(`"${r.descripcion}" declara cuandoSeAgrega`, false); continue; }
    const [tabla, columna] = r.cuandoSeAgrega.split('.');
    const declarada = Boolean(COLUMNAS_ESPERADAS[tabla]?.[columna]);
    chk(`"${r.descripcion}" — ${r.cuandoSeAgrega} está en COLUMNAS_ESPERADAS`, declarada,
      declarada ? null : 'el relleno nunca se dispara: esa columna no se agrega desde acá');
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m`);
/*
 * Claves de tabla repetidas en COLUMNAS_ESPERADAS.
 *
 * Un objeto literal de JavaScript acepta la misma clave dos veces sin decir
 * nada: la segunda pisa a la primera y las columnas declaradas arriba
 * desaparecen. Ya pasó dos veces en este archivo —una con `businesses` y otra
 * con `business_locations`— y las dos veces el síntoma apareció lejos: una
 * columna que en una base nueva no se creaba nunca.
 *
 * Para cuando el código corre, el duplicado ya no existe. Hay que mirarlo en el
 * texto fuente.
 */
tit('CLAVES REPETIDAS EN COLUMNAS_ESPERADAS');
{
  const fuente = require('fs').readFileSync(__dirname + '/../src/database/ensureColumns.js', 'utf8');
  const desde = fuente.indexOf('COLUMNAS_ESPERADAS');
  const hasta = fuente.indexOf('const RELLENOS', desde);
  const claves = [...fuente.slice(desde, hasta).matchAll(/^  (\w+): \{/gm)].map((m) => m[1]);
  const repetidas = claves.filter((k, i) => claves.indexOf(k) !== i);
  chk('ninguna tabla declarada dos veces', [], [...new Set(repetidas)]);
}

  console.log(`  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})();
