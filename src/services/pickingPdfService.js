/*
 * La jornada del depósito, en papel A4.
 *
 * Esto se lleva en la mano por el depósito, se apoya en una mesa y se tacha con
 * birome. No es un reporte para mirar en pantalla: es la herramienta con la que
 * se trabaja, y por eso manda el papel y no el diseño.
 *
 * Dos partes, en este orden y no al revés:
 *
 *   1. El CONSOLIDADO. Cuántas unidades de cada SKU hay que bajar del estante,
 *      agrupado por local. Es el recorrido: se camina el depósito UNA vez con
 *      esta hoja, no una vez por pedido. Con veinte pedidos que comparten la
 *      misma remera negra talle M, esa diferencia es despachar a las 14 o a las
 *      18 — y con Flex, que tiene corte horario, se paga en reputación.
 *
 *   2. Los PAQUETES. Qué lleva cada pedido, para armarlos con lo que ya se
 *      bajó, y la checklist de tres casillas por paquete.
 *
 * ── Por qué las casillas están impresas y no en el sistema ────────
 *
 * Porque la mano que arma el paquete tiene cinta y cartón, no un teclado.
 * Pedirle que vuelva a una pantalla por cada casilla es garantizar que las
 * marque todas juntas al final, que es lo mismo que no marcarlas. En papel se
 * tildan en el momento, y lo único que vuelve al sistema es el hecho que sí
 * cambia el stock: el despacho.
 */

const PDFDocument = require('pdfkit');

// A4 vertical en puntos. Vertical y no apaisado: entra en una tablilla.
const ANCHO = 595.28;
const ALTO  = 841.89;
const MARGEN = 32;
const UTIL = ANCHO - MARGEN * 2;

const COLOR = { texto: '#111', suave: '#666', linea: '#d8d8d8', caja: '#333' };

const fechaLarga = (d) => new Intl.DateTimeFormat('es-AR', {
  weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
}).format(new Date(d));

/*
 * La hora en 24, siempre.
 *
 * En 12 horas la lista se lee desordenada aunque esté bien ordenada: "12:14
 * p. m." arriba de "01:14 p. m." parece un error de orden, y quien mira la hoja
 * para saber qué apura no tiene por qué resolver esa ambigüedad. Con 12:14 y
 * 13:14 no hay nada que interpretar.
 */
const hora = (d) => (d
  ? new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(d))
  : null);

/*
 * Una casilla para tildar con birome.
 *
 * 9pt de lado: más chica no se puede tildar con un dedo enguantado, más grande
 * empuja la fila y entran menos paquetes por hoja.
 */
function casilla(doc, x, y, etiqueta = null) {
  doc.rect(x, y, 9, 9).lineWidth(0.8).strokeColor(COLOR.caja).stroke();
  // Sin etiqueta en el consolidado: ahí la casilla es para tachar el renglón
  // buscado y no necesita que le expliquen qué significa.
  if (!etiqueta) return 15;

  doc.font('Helvetica').fontSize(7).fillColor(COLOR.suave)
    .text(etiqueta, x + 12, y + 1.5, { lineBreak: false });
  return 12 + doc.widthOfString(etiqueta) + 10;
}

function encabezado(doc, { nombreNegocio, local, fecha, resumen }, pagina) {
  doc.font('Helvetica-Bold').fontSize(14).fillColor(COLOR.texto)
    .text('Envíos del día', MARGEN, MARGEN, { lineBreak: false });

  doc.font('Helvetica').fontSize(9).fillColor(COLOR.suave)
    .text(`${nombreNegocio}${local ? ` · ${local}` : ''}`, MARGEN, MARGEN + 18, { lineBreak: false });
  doc.text(fechaLarga(fecha), MARGEN, MARGEN + 30, { lineBreak: false });

  // El resumen arriba a la derecha: es lo primero que se mira para saber si la
  // jornada es de diez paquetes o de ochenta.
  const derecha = `${resumen.paquetes} paquete(s) · ${resumen.unidades} unidad(es) · ${resumen.referencias} referencia(s)`;
  doc.font('Helvetica').fontSize(9).fillColor(COLOR.texto)
    .text(derecha, MARGEN, MARGEN + 2, { width: UTIL, align: 'right' });
  if (resumen.flex) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR.texto)
      .text(`${resumen.flex} con horario de corte (Flex)`, MARGEN, MARGEN + 16,
        { width: UTIL, align: 'right' });
  }
  doc.font('Helvetica').fontSize(8).fillColor(COLOR.suave)
    .text(`Hoja ${pagina}`, MARGEN, MARGEN + 30, { width: UTIL, align: 'right' });

  doc.moveTo(MARGEN, MARGEN + 46).lineTo(ANCHO - MARGEN, MARGEN + 46)
    .lineWidth(0.8).strokeColor(COLOR.caja).stroke();

  return MARGEN + 58;
}

/** Salta de hoja si lo que viene no entra. */
function espacio(doc, y, alto, cab, pagina) {
  if (y + alto <= ALTO - MARGEN - 10) return { y, pagina };
  doc.addPage({ size: [ANCHO, ALTO], margin: 0 });
  const nueva = pagina + 1;
  return { y: encabezado(doc, cab, nueva), pagina: nueva };
}

function tituloSeccion(doc, y, texto, bajada) {
  doc.font('Helvetica-Bold').fontSize(11).fillColor(COLOR.texto)
    .text(texto, MARGEN, y, { lineBreak: false });
  if (bajada) {
    doc.font('Helvetica').fontSize(8).fillColor(COLOR.suave)
      .text(bajada, MARGEN, y + 14, { width: UTIL });
    return y + 30;
  }
  return y + 18;
}

/**
 * @param {object} jornada  lo que devuelve enviosDelDiaService.delDia
 */
async function generarPickingPdf(jornada, { nombreNegocio = 'Stocker', local = null } = {}) {
  const cab = { nombreNegocio, local, fecha: jornada.fecha, resumen: jornada.resumen };

  const doc = new PDFDocument({ size: [ANCHO, ALTO], margin: 0 });
  const trozos = [];
  doc.on('data', (d) => trozos.push(d));
  const listo = new Promise((res) => doc.on('end', res));

  let pagina = 1;
  let y = encabezado(doc, cab, pagina);

  if (!jornada.pedidos.length) {
    doc.font('Helvetica').fontSize(10).fillColor(COLOR.suave)
      .text('No hay envíos para despachar en esta jornada.', MARGEN, y, { width: UTIL });
    doc.end();
    await listo;
    return Buffer.concat(trozos);
  }

  // ── 1. Consolidado ────────────────────────────────────────────
  y = tituloSeccion(doc, y, '1 · Qué bajar del estante',
    'Recorrido único. Se junta todo esto primero y después se arman los paquetes.');

  let localActual = null;
  for (const linea of jornada.consolidado) {
    ({ y, pagina } = espacio(doc, y, 20, cab, pagina));

    // El local sólo cuando cambia: repetirlo en cada renglón es ruido, y el
    // recorrido va local por local.
    if (linea.local !== localActual) {
      localActual = linea.local;
      ({ y, pagina } = espacio(doc, y, 26, cab, pagina));
      doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR.texto)
        .text(localActual || 'Sin local asignado', MARGEN, y, { lineBreak: false });
      y += 14;
    }

    /*
     * Posiciones fijas y no calculadas a partir del ancho de la casilla.
     *
     * Con el número pegado al recuadro no se distingue cuál es la casilla que
     * hay que tildar y cuál el número que hay que contar, que son las dos cosas
     * que se miran en este renglón.
     */
    const X_CANT = MARGEN + 26;
    const X_NOMBRE = MARGEN + 52;
    casilla(doc, MARGEN + 6, y);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(COLOR.texto)
      .text(`${linea.unidades}`, X_CANT, y - 2, { width: 20, align: 'right', lineBreak: false });

    const nombre = `${linea.titulo || linea.sku}${linea.variante ? ` · ${linea.variante}` : ''}`;
    doc.font('Helvetica').fontSize(9.5).fillColor(COLOR.texto)
      .text(nombre, X_NOMBRE, y - 1, { width: UTIL - 200, lineBreak: false });

    doc.font('Courier').fontSize(8).fillColor(COLOR.suave)
      .text(linea.sku, MARGEN, y - 1, { width: UTIL - 40, align: 'right' });
    // En cuántos paquetes se reparte: dice si conviene contar de una y repartir.
    doc.font('Helvetica').fontSize(7).fillColor(COLOR.suave)
      .text(`${linea.enPaquetes}p`, MARGEN, y, { width: UTIL, align: 'right' });

    if (linea.sinResolver) {
      y += 11;
      doc.font('Helvetica-Bold').fontSize(7).fillColor('#a33')
        .text('Este SKU no está en Stocker: no figura el stock ni se descuenta.',
          X_NOMBRE, y, { width: UTIL - 120, lineBreak: false });
    }

    y += 19;
    doc.moveTo(MARGEN, y - 5).lineTo(ANCHO - MARGEN, y - 5)
      .lineWidth(0.3).strokeColor(COLOR.linea).stroke();
  }

  // ── 2. Paquetes ───────────────────────────────────────────────
  y += 14;
  ({ y, pagina } = espacio(doc, y, 60, cab, pagina));
  y = tituloSeccion(doc, y, '2 · Armado de paquetes',
    'Un bloque por pedido. Se tilda a medida que se arma, se etiqueta y se despacha.');

  for (const p of jornada.pedidos) {
    /*
     * Un paquete no se parte entre dos hojas.
     *
     * Con la checklist en una hoja y los ítems en la otra, se tilda "armado"
     * sin ver qué llevaba. Se estima el alto y si no entra, se salta.
     */
    const alto = 46 + p.items.length * 13 + (p.motivo ? 12 : 0);
    ({ y, pagina } = espacio(doc, y, Math.min(alto, ALTO - MARGEN * 2), cab, pagina));

    doc.rect(MARGEN, y, UTIL, alto - 6).lineWidth(0.6).strokeColor(COLOR.linea).stroke();

    const dentro = MARGEN + 8;
    let yy = y + 7;

    // Cabecera del paquete: plataforma, número y comprador.
    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLOR.texto)
      .text(`${p.plataforma.toUpperCase()} · ${p.pedidoExterno}`, dentro, yy, { lineBreak: false });

    const etiquetas = [
      p.envioTipo === 'flex' ? 'FLEX' : (p.envioTipo || null),
      p.despacharAntesDe ? `antes de ${hora(p.despacharAntesDe)}` : null,
      p.envioId ? `envío ${p.envioId}` : null,
    ].filter(Boolean).join('  ·  ');
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR.texto)
      .text(etiquetas, MARGEN, yy, { width: UTIL - 8, align: 'right' });

    yy += 13;
    doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.suave)
      .text(p.comprador || 'Sin nombre de comprador', dentro, yy,
        { width: UTIL - 200, lineBreak: false });

    // Las tres casillas de la checklist, en la misma línea del comprador.
    let xc = MARGEN + UTIL - 220;
    xc += casilla(doc, xc, yy - 1, 'Armado');
    xc += casilla(doc, xc, yy - 1, 'Etiquetado');
    casilla(doc, xc, yy - 1, 'Despachado');

    yy += 14;

    for (const i of p.items) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR.texto)
        .text(`${i.cantidad} ×`, dentro, yy, { width: 24, lineBreak: false });
      doc.font('Helvetica').fontSize(9).fillColor(COLOR.texto)
        .text(`${i.titulo || i.sku}${i.variante ? ` · ${i.variante}` : ''}`,
          dentro + 26, yy, { width: UTIL - 200, lineBreak: false });
      doc.font('Courier').fontSize(7.5).fillColor(COLOR.suave)
        .text(`${i.sku}${i.local ? `  ${i.local}` : ''}`, MARGEN, yy + 1,
          { width: UTIL - 8, align: 'right' });
      yy += 13;
    }

    if (p.motivo) {
      doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#a33')
        .text(p.motivo, dentro, yy, { width: UTIL - 16, lineBreak: false });
    }

    y += alto + 6;
  }

  doc.end();
  await listo;
  return Buffer.concat(trozos);
}

module.exports = { generarPickingPdf };
