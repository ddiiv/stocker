/*
 * ── La fecha de un comprobante es la de Argentina ─────────────────
 *
 * El servidor corre en UTC (Railway) y Argentina está tres horas atrás. Sacar
 * "hoy" con `toISOString()` da el día UTC: una venta de las 21 a las 24 de acá
 * se le declaraba a ARCA con la fecha del día SIGUIENTE. El comprobante quedaba
 * fechado mañana, el libro de IVA ventas del mes podía cerrar con una factura
 * del mes que viene, y la fecha impresa no coincidía con la del ticket.
 *
 * Todo lo que es una fecha fiscal sale de acá y no de un `Date` suelto.
 *
 * Y se separan dos cosas que parecen lo mismo y no lo son:
 *   · un INSTANTE (cuándo se grabó la factura) se pasa a hora de Argentina;
 *   · un DÍA (el CbteFch de ARCA, el vencimiento del CAE, el inicio de
 *     actividades) ya es un día y se toma tal cual. Pasarlo por la zona
 *     horaria lo corre: `new Date('2026-10-23')` es la medianoche UTC, que acá
 *     es el 22 a las 21.
 */

const ZONA = 'America/Argentina/Buenos_Aires';

/*
 * Argentina no tiene horario de verano desde 2009, así que -3 fijo es la
 * verdad. Se usa sólo si el Node no trae las zonas horarias (un build con ICU
 * recortado tira RangeError): equivocarse de huso es peor que no tenerlo.
 */
const DESFASAJE_MS = -3 * 60 * 60 * 1000;

let formateador = null;
try {
  formateador = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit',
  });
} catch { formateador = null; }

const dos = (n) => String(n).padStart(2, '0');

/** [año, mes, día] de un INSTANTE, en hora de Argentina. */
function partesArgentina(instante = new Date()) {
  const d = instante instanceof Date ? instante : new Date(instante);
  if (Number.isNaN(d.getTime())) return null;
  if (formateador) {
    const p = Object.fromEntries(formateador.formatToParts(d).map((x) => [x.type, x.value]));
    return [p.year, p.month, p.day];
  }
  const corrido = new Date(d.getTime() + DESFASAJE_MS);
  return [String(corrido.getUTCFullYear()), dos(corrido.getUTCMonth() + 1), dos(corrido.getUTCDate())];
}

/*
 * [año, mes, día] de un DÍA: "AAAAMMDD", "AAAA-MM-DD" (con o sin hora pegada)
 * o el Date que arman los drivers para una columna DATE, que es la medianoche
 * UTC de ese día y por eso se lee en UTC.
 */
function partesDelDia(valor) {
  if (valor == null || valor === '') return null;
  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) return null;
    return [String(valor.getUTCFullYear()), dos(valor.getUTCMonth() + 1), dos(valor.getUTCDate())];
  }
  const s = String(valor).trim();
  const m = s.match(/^(\d{4})(\d{2})(\d{2})$/) || s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? [m[1], m[2], m[3]] : null;
}

/** "AAAAMMDD" en hora de Argentina: el CbteFch que se le manda a ARCA. */
function aaaammddArgentina(instante = new Date()) {
  const p = partesArgentina(instante);
  return p ? p.join('') : null;
}

/** "DD/MM/AAAA" de un día. */
function ddmmaaaa(dia) {
  const p = partesDelDia(dia);
  return p ? `${p[2]}/${p[1]}/${p[0]}` : null;
}

/** "AAAA-MM-DD" de un día (lo que pide el QR de la RG 4892). */
function isoDia(dia) {
  const p = partesDelDia(dia);
  return p ? p.join('-') : null;
}

/** "DD/MM/AAAA" de un instante, en hora de Argentina. */
function ddmmaaaaArgentina(instante) {
  const p = partesArgentina(instante);
  return p ? `${p[2]}/${p[1]}/${p[0]}` : null;
}

/** "AAAA-MM-DD" de un instante, en hora de Argentina. */
function isoArgentina(instante) {
  const p = partesArgentina(instante);
  return p ? p.join('-') : null;
}

/** "AAAAMMDD" de un día: como se guarda y se compara el CbteFch. */
function aaaammddDia(dia) {
  const p = partesDelDia(dia);
  return p ? p.join('') : null;
}

/*
 * El primer y el último instante de un DÍA de Argentina, para filtrar una
 * columna que guarda instantes (la fecha de creación de una factura).
 *
 * `new Date('2026-10-01')` es la medianoche UTC, que acá es el 30 a las 21: un
 * filtro de octubre armado así deja afuera las facturas del 31 a la noche y
 * mete las del 30 de septiembre a la noche. El -3 fijo es el de arriba.
 */
function inicioDelDiaArgentina(dia) {
  const iso = isoDia(dia);
  return iso ? new Date(`${iso}T00:00:00.000-03:00`) : null;
}

function finDelDiaArgentina(dia) {
  const iso = isoDia(dia);
  return iso ? new Date(`${iso}T23:59:59.999-03:00`) : null;
}

module.exports = {
  ZONA, aaaammddArgentina, ddmmaaaa, isoDia, ddmmaaaaArgentina, isoArgentina,
  aaaammddDia, inicioDelDiaArgentina, finDelDiaArgentina,
};
