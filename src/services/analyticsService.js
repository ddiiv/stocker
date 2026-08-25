/*
 * Análisis del negocio.
 *
 * Todo se agrega EN LA BASE. Es la única decisión de diseño que importa acá:
 * el dashboard anterior traía a memoria todas las ventas del negocio con
 * todos sus items —y una segunda consulta sin filtro de fecha, o sea el
 * historial completo— para después sumar en JavaScript. Con 300 ventas anda;
 * con tres años a 500 ventas por mes son 18.000 ventas y 50.000 líneas
 * cargadas en cada visita al panel, y el panel se abre todo el tiempo.
 *
 * Acá cada pregunta es un GROUP BY que devuelve las filas que se van a
 * mostrar y nada más: doce filas para doce meses, diez para un top. El costo
 * deja de crecer con la historia del negocio y pasa a depender sólo de lo que
 * se pide en pantalla.
 *
 * El costo de la mercadería sale de `sale_items.costoUnitario`, congelado el
 * día de la venta. Leerlo del producto haría que una suba del proveedor
 * cambiara los márgenes de todos los meses anteriores.
 */

const sequelize = require('../config/database');

const esPg = () => sequelize.getDialect() === 'postgres';

/** Cita un identificador según el motor. Sin esto Postgres baja los camelCase. */
const c = (nombre) => (esPg() ? `"${nombre}"` : `[${nombre}]`);

/** El mes de una fecha como 'YYYY-MM', en el dialecto que toque. */
const mesDe = (col) => (esPg() ? `to_char(${col}, 'YYYY-MM')` : `CONVERT(char(7), ${col}, 23)`);

/*
 * El costo de una línea.
 *
 * `costoUnitario` es el del día de la venta. Las líneas anteriores al cambio
 * pueden tenerlo en null: ahí se cae al costo actual del producto, que es la
 * mejor aproximación disponible.
 */
const COSTO_LINEA = `COALESCE(si.${c('costoUnitario')}, p.costo, 0) * si.cantidad`;

/*
 * El filtro de toda consulta: ventas reales del negocio, en el rango.
 *
 * Cotizaciones y anuladas quedan afuera: no son facturación. Va contra el
 * índice idx_sales_analitica (businessId, tipo, estado, fecha).
 */
const DONDE_VENTAS = `
  s.${c('businessId')} = :businessId
  AND s.tipo = 'venta'
  AND s.estado = 'pagado'
  AND s.fecha >= :desde AND s.fecha <= :hasta
`;

const consultar = (sql, replacements) =>
  sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });

const num = (v) => Number(v) || 0;
const pct = (parte, total) => (total ? Math.round((parte / total) * 1000) / 10 : 0);

/* ── Resumen del período ───────────────────────────────────────────
 *
 * Una sola consulta con los agregados. Se pide dos veces —el período elegido y
 * el inmediatamente anterior, del mismo largo— porque un número solo no dice
 * nada: $2.000.000 en el mes es bueno o malo según qué pasó el mes pasado.
 */
async function resumen({ businessId, desde, hasta }) {
  const sql = `
    SELECT
      COUNT(DISTINCT s.id)                    AS tickets,
      COALESCE(SUM(si.subtotal), 0)           AS facturado,
      COALESCE(SUM(${COSTO_LINEA}), 0)        AS costo,
      COALESCE(SUM(si.cantidad), 0)           AS unidades
    FROM sales s
    JOIN sale_items si ON si.${c('saleId')} = s.id
    LEFT JOIN product_variants pv ON pv.id = si.${c('productVariantId')}
    LEFT JOIN products p ON p.id = pv.${c('productId')}
    WHERE ${DONDE_VENTAS}
  `;
  const [fila] = await consultar(sql, { businessId, desde, hasta });

  const facturado = num(fila?.facturado);
  const costo = num(fila?.costo);
  const tickets = num(fila?.tickets);
  const unidades = num(fila?.unidades);

  return {
    facturado, costo,
    margen: facturado - costo,
    margenPct: pct(facturado - costo, facturado),
    tickets, unidades,
    ticketPromedio: tickets ? Math.round(facturado / tickets) : 0,
    unidadesPorTicket: tickets ? Math.round((unidades / tickets) * 10) / 10 : 0,
  };
}

/* ── Serie mensual ─────────────────────────────────────────────────
 *
 * Una fila por mes, agrupada en la base. Es la vista de "cómo viene el negocio
 * a lo largo del tiempo" y cuesta lo mismo pedir doce meses que cinco años:
 * lo que viaja son las filas del resultado, no las ventas.
 */
async function porMes({ businessId, desde, hasta }) {
  const mes = mesDe('s.fecha');
  const sql = `
    SELECT
      ${mes}                            AS mes,
      COUNT(DISTINCT s.id)              AS tickets,
      COALESCE(SUM(si.subtotal), 0)     AS facturado,
      COALESCE(SUM(${COSTO_LINEA}), 0)  AS costo,
      COALESCE(SUM(si.cantidad), 0)     AS unidades
    FROM sales s
    JOIN sale_items si ON si.${c('saleId')} = s.id
    LEFT JOIN product_variants pv ON pv.id = si.${c('productVariantId')}
    LEFT JOIN products p ON p.id = pv.${c('productId')}
    WHERE ${DONDE_VENTAS}
    GROUP BY ${mes}
    ORDER BY ${mes}
  `;
  const filas = await consultar(sql, { businessId, desde, hasta });

  const serie = filas.map((f) => {
    const facturado = num(f.facturado);
    const costo = num(f.costo);
    const tickets = num(f.tickets);
    return {
      mes: f.mes,
      facturado, costo,
      margen: facturado - costo,
      margenPct: pct(facturado - costo, facturado),
      unidades: num(f.unidades),
      tickets,
      ticketPromedio: tickets ? Math.round(facturado / tickets) : 0,
    };
  });

  /*
   * Variación contra el mes anterior y media móvil de tres meses.
   *
   * La media móvil está porque el mes a mes de un comercio es ruidoso —un fin
   * de semana largo mueve el número— y la tendencia real se lee mal sobre el
   * dato crudo. Se calcula acá y no en SQL: son doce filas ya en memoria y las
   * funciones de ventana no se escriben igual en los dos motores.
   */
  serie.forEach((m, i) => {
    const previo = i > 0 ? serie[i - 1].facturado : null;
    m.variacionPct = previo ? Math.round(((m.facturado - previo) / previo) * 1000) / 10 : null;

    const ventana = serie.slice(Math.max(0, i - 2), i + 1);
    m.mediaMovil3 = Math.round(ventana.reduce((s, x) => s + x.facturado, 0) / ventana.length);
  });

  return serie;
}

/*
 * Tendencia por mínimos cuadrados sobre la serie mensual.
 *
 * Da la pendiente —cuánto cambia la facturación por mes— y una proyección del
 * mes siguiente. Es una recta, no un pronóstico: sirve para responder "¿esto
 * viene subiendo o bajando?" sin que la respuesta dependa de qué dos meses
 * elija mirar cada uno.
 */
function tendencia(serie) {
  const n = serie.length;
  if (n < 3) return null;

  const xs = serie.map((_, i) => i);
  const ys = serie.map((m) => m.facturado);
  const mediaX = xs.reduce((a, b) => a + b, 0) / n;
  const mediaY = ys.reduce((a, b) => a + b, 0) / n;

  let num0 = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num0 += (xs[i] - mediaX) * (ys[i] - mediaY);
    den += (xs[i] - mediaX) ** 2;
  }
  if (!den) return null;

  const pendiente = num0 / den;
  const ordenada = mediaY - pendiente * mediaX;

  // R²: qué tan bien la recta explica los datos. Con un R² bajo la pendiente
  // existe pero no significa nada, y decirlo evita leer una tendencia donde
  // sólo hay ruido.
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const estimado = ordenada + pendiente * xs[i];
    ssRes += (ys[i] - estimado) ** 2;
    ssTot += (ys[i] - mediaY) ** 2;
  }

  return {
    pendienteMensual: Math.round(pendiente),
    proyeccionProximoMes: Math.max(0, Math.round(ordenada + pendiente * n)),
    r2: ssTot ? Math.round((1 - ssRes / ssTot) * 100) / 100 : null,
    direccion: pendiente > 0 ? 'sube' : pendiente < 0 ? 'baja' : 'plano',
  };
}

/* ── Ranking de productos padre ────────────────────────────────────
 *
 * Se agrupa por `skuAgrupador`, que es el producto padre: al dueño le sirve
 * saber que "la Remera Oversize" es lo que más deja, no que el talle M en
 * negro salió doce veces.
 */
async function porProducto({ businessId, desde, hasta }) {
  const sql = `
    SELECT
      COALESCE(si.${c('skuAgrupador')}, si.sku)  AS agrupador,
      MIN(si.titulo)                             AS titulo,
      COUNT(DISTINCT s.id)                       AS tickets,
      COALESCE(SUM(si.cantidad), 0)              AS unidades,
      COALESCE(SUM(si.subtotal), 0)              AS facturado,
      COALESCE(SUM(${COSTO_LINEA}), 0)           AS costo
    FROM sales s
    JOIN sale_items si ON si.${c('saleId')} = s.id
    LEFT JOIN product_variants pv ON pv.id = si.${c('productVariantId')}
    LEFT JOIN products p ON p.id = pv.${c('productId')}
    WHERE ${DONDE_VENTAS}
    GROUP BY COALESCE(si.${c('skuAgrupador')}, si.sku)
  `;
  const filas = await consultar(sql, { businessId, desde, hasta });

  return filas.map((f) => {
    const facturado = num(f.facturado);
    const costo = num(f.costo);
    return {
      agrupador: f.agrupador,
      titulo: f.titulo,
      unidades: num(f.unidades),
      tickets: num(f.tickets),
      facturado, costo,
      margen: facturado - costo,
      margenPct: pct(facturado - costo, facturado),
    };
  });
}

/*
 * El catálogo con su stock, para cruzar contra las ventas.
 *
 * Hace falta para los que NO vendieron: por definición no aparecen en las
 * ventas, así que ninguna consulta sobre `sales` los puede encontrar. Y el
 * stock es lo que convierte "vendió poco" en "vendió poco y hay 40 guardadas",
 * que es el dato que duele.
 */
async function catalogoConStock({ businessId }) {
  const sql = `
    SELECT
      COALESCE(p.${c('skuAgrupador')}, p.sku)      AS agrupador,
      MIN(p.titulo)                                AS titulo,
      MIN(p.categoria)                             AS categoria,
      COALESCE(SUM(pv.stock), 0)                   AS stock,
      COALESCE(SUM(pv.stock * COALESCE(p.costo, 0)), 0) AS capital
    FROM products p
    JOIN product_variants pv ON pv.${c('productId')} = p.id AND pv.activo = ${esPg() ? 'true' : '1'}
    WHERE p.${c('businessId')} = :businessId AND p.activo = ${esPg() ? 'true' : '1'}
    GROUP BY COALESCE(p.${c('skuAgrupador')}, p.sku)
  `;
  const filas = await consultar(sql, { businessId });
  return filas.map((f) => ({
    agrupador: f.agrupador,
    titulo: f.titulo,
    categoria: f.categoria,
    stock: num(f.stock),
    capital: num(f.capital),
  }));
}

/*
 * Clasificación ABC (Pareto).
 *
 * Ordena por facturación y corta donde el acumulado pasa 80% (A) y 95% (B).
 * Es el análisis que dice en qué mirar: los A son un puñado de productos que
 * hacen la mayor parte de la facturación y no pueden faltar nunca; los C son la
 * cola larga, que ocupa lugar y capital para lo que aporta.
 */
function clasificarABC(productos) {
  const orden = [...productos].sort((a, b) => b.facturado - a.facturado);
  const total = orden.reduce((s, p) => s + p.facturado, 0);
  let acumulado = 0;

  return orden.map((p) => {
    acumulado += p.facturado;
    const acumPct = pct(acumulado, total);
    return {
      ...p,
      participacionPct: pct(p.facturado, total),
      acumuladoPct: acumPct,
      clase: acumPct <= 80 ? 'A' : acumPct <= 95 ? 'B' : 'C',
    };
  });
}

/* ── Los tops ──────────────────────────────────────────────────────
 *
 * Tres preguntas distintas, y cada una necesita su propio orden:
 *
 *   más vendidos   lo que sostiene el negocio. Por facturación, no por
 *                  unidades: vender 200 medias no es vender 20 camperas.
 *   menos vendidos capital dormido. No es "el que menos facturó" sino el que
 *                  tiene mercadería parada: un producto sin stock que no vendió
 *                  no es un problema, es un producto que no está.
 *   con pérdida    se vendió por debajo del costo. Es el que hay que ver hoy:
 *                  cada unidad que sale agranda el agujero.
 */
function armarTops(productos, catalogo, limite = 8) {
  const porAgrupador = new Map(productos.map((p) => [p.agrupador, p]));

  const masVendidos = [...productos]
    .sort((a, b) => b.facturado - a.facturado)
    .slice(0, limite);

  const conPerdida = productos
    .filter((p) => p.margen < 0)
    .sort((a, b) => a.margen - b.margen)
    .slice(0, limite);

  /*
   * Los que menos se mueven, entre los que efectivamente tienen mercadería.
   *
   * Se ordena por capital inmovilizado y no por unidades vendidas: veinte
   * remeras baratas paradas molestan menos que tres camperas caras. Los que
   * nunca vendieron entran con unidades en cero, que es justamente el caso
   * peor y el que una consulta sobre ventas no puede ver.
   */
  const menosVendidos = catalogo
    .filter((c2) => c2.stock > 0)
    .map((c2) => {
      const v = porAgrupador.get(c2.agrupador);
      return {
        agrupador: c2.agrupador,
        titulo: c2.titulo,
        categoria: c2.categoria,
        stock: c2.stock,
        capitalInmovilizado: c2.capital,
        unidades: v ? v.unidades : 0,
        facturado: v ? v.facturado : 0,
        // Cuántas veces se vendió el stock que hay. Bajo = mercadería parada.
        rotacion: c2.stock ? Math.round(((v ? v.unidades : 0) / c2.stock) * 100) / 100 : null,
      };
    })
    .sort((a, b) => (a.rotacion - b.rotacion) || (b.capitalInmovilizado - a.capitalInmovilizado))
    .slice(0, limite);

  return { masVendidos, menosVendidos, conPerdida };
}

/* ── Por local y por categoría ─────────────────────────────────────
 *
 * Las dos son el mismo GROUP BY con otra columna, pero responden preguntas
 * distintas: el local dice qué sucursal deja plata —y una que factura mucho
 * con margen flaco puede estar rematando—, y la categoría dice de qué vive el
 * negocio, que casi nunca coincide con lo que el dueño cree.
 */
async function porDimension({ businessId, desde, hasta, dimension }) {
  const campos = {
    local: {
      clave: `s.${c('locationId')}`,
      nombre: 'MAX(bl.nombre)',
      join: `LEFT JOIN business_locations bl ON bl.id = s.${c('locationId')}`,
    },
    categoria: {
      clave: 'p.categoria',
      nombre: 'MAX(p.categoria)',
      join: '',
    },
  }[dimension];

  const sql = `
    SELECT
      ${campos.clave}                    AS clave,
      ${campos.nombre}                   AS nombre,
      COUNT(DISTINCT s.id)               AS tickets,
      COALESCE(SUM(si.subtotal), 0)      AS facturado,
      COALESCE(SUM(${COSTO_LINEA}), 0)   AS costo,
      COALESCE(SUM(si.cantidad), 0)      AS unidades
    FROM sales s
    JOIN sale_items si ON si.${c('saleId')} = s.id
    LEFT JOIN product_variants pv ON pv.id = si.${c('productVariantId')}
    LEFT JOIN products p ON p.id = pv.${c('productId')}
    ${campos.join}
    WHERE ${DONDE_VENTAS}
    GROUP BY ${campos.clave}
  `;
  const filas = await consultar(sql, { businessId, desde, hasta });
  const total = filas.reduce((acc, f) => acc + num(f.facturado), 0);

  return filas
    .map((f) => {
      const facturado = num(f.facturado);
      const costo = num(f.costo);
      const tickets = num(f.tickets);
      return {
        clave: f.clave,
        nombre: f.nombre || '(sin asignar)',
        facturado, costo,
        margen: facturado - costo,
        margenPct: pct(facturado - costo, facturado),
        unidades: num(f.unidades),
        tickets,
        ticketPromedio: tickets ? Math.round(facturado / tickets) : 0,
        participacionPct: pct(facturado, total),
      };
    })
    .sort((a, b) => b.facturado - a.facturado);
}

/*
 * Compara cada mes contra el mismo mes del año anterior.
 *
 * En indumentaria el mes contra mes engaña: enero siempre cae y julio siempre
 * sube, así que la variación mensual mide la estación, no el negocio. Lo que
 * dice si el negocio mejoró es enero contra enero.
 *
 * La serie del año anterior ya viene en la misma consulta —se pide el rango
 * extendido una sola vez—, así que esto no cuesta una consulta más.
 */
function compararInteranual(serie, serieExtendida) {
  const previo = new Map(serieExtendida.map((m) => [m.mes, m]));

  /*
   * El mes en curso va marcado.
   *
   * Comparar veintidós días contra un mes entero da una caída que no existe.
   * Es el error más fácil de cometer leyendo un panel, así que el dato viaja
   * marcado y la pantalla lo aclara en vez de mostrar un -40% inventado.
   */
  const mesActual = new Date().toISOString().slice(0, 7);

  return serie.map((m) => {
    const [a, mm] = m.mes.split('-');
    const claveAnterior = `${Number(a) - 1}-${mm}`;
    const anterior = previo.get(claveAnterior);

    return {
      ...m,
      parcial: m.mes === mesActual,
      interanual: anterior
        ? {
            mes: claveAnterior,
            facturado: anterior.facturado,
            margen: anterior.margen,
            variacionPct: anterior.facturado
              ? Math.round(((m.facturado - anterior.facturado) / anterior.facturado) * 1000) / 10
              : null,
          }
        : null,
    };
  });
}

/* ── La foto completa ──────────────────────────────────────────────
 *
 * Un solo endpoint para el panel: cuatro consultas agregadas en vez de traer
 * la historia entera. El período anterior se calcula del mismo largo que el
 * elegido, así la comparación es contra algo equivalente.
 */
async function panel({ businessId, desde, hasta, limite = 8 }) {
  const d1 = new Date(`${desde}T00:00:00`);
  const d2 = new Date(`${hasta}T00:00:00`);
  const dias = Math.max(1, Math.round((d2 - d1) / 86400000) + 1);

  const antesHasta = new Date(d1); antesHasta.setDate(antesHasta.getDate() - 1);
  const antesDesde = new Date(antesHasta); antesDesde.setDate(antesDesde.getDate() - dias + 1);
  const iso = (d) => d.toISOString().slice(0, 10);

  /*
   * El mismo período del año pasado.
   *
   * Es la comparación que vale en un comercio de temporada: contra el período
   * anterior, un verano siempre parece peor que la primavera que lo precede.
   */
  const anioAtras = (f) => {
    const d = new Date(`${f}T00:00:00`);
    d.setFullYear(d.getFullYear() - 1);
    return iso(d);
  };

  // La serie se pide desde un año antes: sirve para el mes a mes del período y
  // para tener contra qué comparar cada mes, en una sola consulta.
  const [actual, previo, mismoPeriodoAnioPasado, serieExtendida, productos, catalogo, locales, categorias] =
    await Promise.all([
      resumen({ businessId, desde, hasta }),
      resumen({ businessId, desde: iso(antesDesde), hasta: iso(antesHasta) }),
      resumen({ businessId, desde: anioAtras(desde), hasta: anioAtras(hasta) }),
      porMes({ businessId, desde: anioAtras(desde), hasta }),
      porProducto({ businessId, desde, hasta }),
      catalogoConStock({ businessId }),
      porDimension({ businessId, desde, hasta, dimension: 'local' }),
      porDimension({ businessId, desde, hasta, dimension: 'categoria' }),
    ]);

  // Del rango extendido nos quedamos con los meses del período pedido.
  const desdeMes = desde.slice(0, 7);
  const serie = compararInteranual(
    serieExtendida.filter((m) => m.mes >= desdeMes),
    serieExtendida,
  );

  const variacion = (a, b) => (b ? Math.round(((a - b) / b) * 1000) / 10 : null);

  const abc = clasificarABC(productos);
  const cuenta = (clase) => abc.filter((p) => p.clase === clase).length;

  /*
   * Si el rango llega hasta hoy, el último mes está incompleto y la
   * comparación contra un período cerrado se lee peor de lo que es.
   */
  const hoyIso = new Date().toISOString().slice(0, 10);

  return {
    periodo: { desde, hasta, dias, incluyeMesEnCurso: hasta >= hoyIso.slice(0, 7) + '-01' && desde <= hoyIso },
    resumen: {
      ...actual,
      comparado: {
        desde: iso(antesDesde), hasta: iso(antesHasta),
        facturado: previo.facturado,
        margen: previo.margen,
        tickets: previo.tickets,
        variacionFacturado: variacion(actual.facturado, previo.facturado),
        variacionMargen: variacion(actual.margen, previo.margen),
        variacionTickets: variacion(actual.tickets, previo.tickets),
      },
      // Y contra el mismo período del año pasado, que es la comparación que
      // no se deja engañar por la estación.
      interanual: {
        desde: anioAtras(desde), hasta: anioAtras(hasta),
        facturado: mismoPeriodoAnioPasado.facturado,
        margen: mismoPeriodoAnioPasado.margen,
        tickets: mismoPeriodoAnioPasado.tickets,
        variacionFacturado: variacion(actual.facturado, mismoPeriodoAnioPasado.facturado),
        variacionMargen: variacion(actual.margen, mismoPeriodoAnioPasado.margen),
        variacionTickets: variacion(actual.tickets, mismoPeriodoAnioPasado.tickets),
      },
    },
    serieMensual: serie,
    tendencia: tendencia(serie),
    tops: armarTops(productos, catalogo, limite),
    abc: {
      resumen: { A: cuenta('A'), B: cuenta('B'), C: cuenta('C') },
      productos: abc.slice(0, 40),
    },
    porLocal: locales,
    porCategoria: categorias,
  };
}

module.exports = { panel, resumen, porMes, porDimension, compararInteranual, porProducto, catalogoConStock, clasificarABC, armarTops, tendencia };
