/*
 * La representación impresa de la factura, como la de Farmacity.
 *
 * Lo que se prueba es lo que el dueño vio mal en una factura real y lo que el
 * modelo exige:
 *   · que una factura corta entre en UNA hoja (salía una segunda con el pie),
 *   · que una larga pagine y el cierre —totales, Ley 27.743, QR, CAE— vaya
 *     entero en la ÚLTIMA y adentro de la hoja (con ~11 renglones el QR se
 *     dibujaba fuera),
 *   · que la B no discrimine el IVA y que los números cierren,
 *   · que la fecha sea la que autorizó ARCA, en hora de Argentina,
 *   · que el QR diga, campo por campo, lo que se le mandó a ARCA,
 *   · que la cabecera lleve lo del CUIT y del local, y que no se imprima
 *     basura ("≥") ni rayas en lugar de datos,
 *   · que nada se monte sobre otra cosa: el domicilio largo sobre el Email o
 *     el IVA, un SKU largo sobre el renglón de abajo. Se mira lo que de verdad
 *     se dibujó (dónde terminó cada texto, y las cajas de cada palabra en el
 *     PDF), no las constantes del código,
 *   · que una reimpresión diga lo mismo que el original, y que de una factura
 *     vieja no se imprima una condición del receptor adivinada.
 *
 * Corre en proceso y sin base: se genera el PDF de verdad con PDFKit y se
 * anota qué texto e imagen se dibujó, dónde y en qué hoja. Los datos son
 * inventados.
 *
 * Uso:  node scripts/test-factura-impresa.cjs
 */

// El servidor corre en UTC (Railway): se prueba en las mismas condiciones.
process.env.TZ = 'UTC';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const PDFDocument = require('pdfkit');

const pdfService = require('../src/services/pdfService');
const facturaPdf = require('../src/services/facturaPdf');
const { aaaammddArgentina, ddmmaaaa } = require('../src/utils/fechaFiscal');
const { docTipoFromCliente } = require('../src/services/arcaService');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/*
 * ── El espía ─────────────────────────────────────────────────────────
 *
 * Se envuelven `text` e `image` del PDFDocument real. Sólo se anota lo del
 * documento que se entrega (el que tiene `bufferPages`); el borrador con el que
 * se mide el cierre no cuenta.
 */
let anotados = null;
const textoOriginal = PDFDocument.prototype.text;
const imagenOriginal = PDFDocument.prototype.image;
function hojaActual(doc) {
  return doc._pageBuffer ? doc._pageBuffer.indexOf(doc.page) + 1 : 0;
}
PDFDocument.prototype.text = function (texto, x, y, opciones) {
  let fila = null;
  if (anotados && this.options.bufferPages) {
    const conXY = typeof x === 'number';
    fila = {
      s: String(texto ?? ''), x: conXY ? x : this.x, y: conXY ? y : this.y,
      ancho: (conXY ? opciones : x)?.width ?? null, hoja: hojaActual(this),
    };
    anotados.textos.push(fila);
  }
  const r = textoOriginal.apply(this, arguments);
  /*
   * Dónde terminó: la `y` que deja PDFKit después de escribirlo, con todos los
   * renglones en que lo partió. Es lo que permite saber si lo de abajo empieza
   * después o encima.
   */
  if (fila) fila.yFin = this.y;
  return r;
};
PDFDocument.prototype.image = function (src, x, y, opciones) {
  if (anotados && this.options.bufferPages) {
    anotados.imagenes.push({ x, y, alto: opciones?.height ?? opciones?.width ?? 0, hoja: hojaActual(this), altoHoja: this.page.height });
  }
  return imagenOriginal.apply(this, arguments);
};

const contarHojas = (buf) => (buf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;

/*
 * Las palabras que se encima con otra, mirando el PDF ya hecho: las cajas que
 * da pdftotext -bbox, hoja por hoja. Un roce de hasta 1,5 pt no cuenta: el
 * "ARCA" grande del pie y su leyenda chica se rozan 1,3 pt a propósito, como
 * en el modelo. Dos textos montados de verdad se encima varios puntos.
 */
function encimadas(buf) {
  const html = execFileSync('pdftotext', ['-bbox', '-', '-'], { input: buf }).toString('utf8');
  const hojas = html.split(/<page /).slice(1);
  const malas = [];
  hojas.forEach((h, n) => {
    const ps = [...h.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
      .map((m) => ({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], s: m[5] }));
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i], b = ps[j];
        const enX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const enY = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        if (enX > 0.5 && enY > 1.5) malas.push(`hoja ${n + 1}: "${a.s}" / "${b.s}"`);
      }
    }
  });
  return malas;
}

async function generar(inv, items, ctx = CTX, negocio = NEGOCIO) {
  anotados = { textos: [], imagenes: [] };
  const buf = await pdfService.generateInvoicePdfBuffer(inv, items, negocio, ctx);
  const r = { buf, hojas: contarHojas(buf), ...anotados };
  anotados = null;
  r.hay = (re) => r.textos.some((t) => (re instanceof RegExp ? re.test(t.s) : t.s === re));
  r.donde = (re) => r.textos.filter((t) => (re instanceof RegExp ? re.test(t.s) : t.s === re));
  return r;
}

// ── Datos inventados ─────────────────────────────────────────────────
const NEGOCIO = { nombreNegocio: 'Tienda QA', cuit: '30712345678', condicionIva: 'Responsable Inscripto' };
const CTX = {
  emisor: {
    ingresosBrutos: 'C.M. 901-000000-1', inicioActividades: '2019-03-01',
    domicilio: 'Local QA [Av. Siempre Viva 742, CABA]', condicionIva: 'Responsable Inscripto',
  },
  descuentoPct: 0,
};
const r2 = (v) => Math.round(v * 100) / 100;
const renglon = (i, precio = 6000, cantidad = 2) => ({
  titulo: `Remera QA ${i}`, sku: `QA-REM-${String(i).padStart(3, '0')}-NEG-XL`,
  variante1Nombre: 'Color', variante1Valor: 'Negro', variante2Nombre: 'Talle', variante2Valor: 'XL',
  cantidad, precioUnitario: precio, subtotal: precio * cantidad,
});
const renglones = (n) => Array.from({ length: n }, (_, i) => renglon(i + 1, 1000 + i * 10, 1 + (i % 3)));
function factura(items, extra = {}) {
  const tipo = extra.tipo || 'B';
  const total = r2(items.reduce((s, i) => s + i.subtotal, 0) - (extra.descuentoVenta || 0));
  const neto = tipo === 'C' ? total : r2(total / 1.21);
  const { descuentoVenta, ...resto } = extra;
  return {
    id: 7, businessId: 1, numero: '2610-00007', tipo, clase: 'factura',
    emisorCuit: '30712345678', emisorNombre: 'QA S.R.L.',
    clienteNombre: 'Cliente QA', clienteCuit: '30111222', clienteDireccion: 'Calle QA 123',
    clienteEmail: 'cliente.qa@ejemplo.test',
    fechaEmision: new Date('2026-10-13T02:30:00Z'),     // 23:30 del 12 en Argentina
    cbteFchArca: '20261012',
    subtotal: neto, iva: r2(total - neto), total,
    cae: '86400000000017', caeVencimiento: '2026-10-22',
    ambiente: 'produccion', simulado: false,
    ptoVtaArca: 15, cbteNroArca: 7, cbteTipoArca: { A: 1, B: 6, C: 11 }[tipo],
    // Como toda factura nueva: con la condición del receptor que se declaró.
    condicionIvaReceptorId: tipo === 'A' ? 1 : 5,
    esMayorista: false,
    ...resto,
  };
}

/* Los caracteres que las fuentes estándar del PDF (WinAnsi) pueden escribir. */
const WINANSI_EXTRA = new Set([...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ']);
const escribible = (s) => [...s].every((c) => {
  const n = c.charCodeAt(0);
  return (n >= 32 && n <= 126) || (n >= 160 && n <= 255) || WINANSI_EXTRA.has(c) || c === '\n';
});

(async () => {
  tit('1. UNA FACTURA QUE ENTRA, ENTRA EN UNA HOJA');
  const corta = await generar(factura([renglon(1), renglon(2, 8500, 1), renglon(3, 4200, 3)]), [renglon(1), renglon(2, 8500, 1), renglon(3, 4200, 3)]);
  chk('B corta: una hoja', 1, corta.hojas);
  chk('   con el pie (CAE) en esa hoja', [1], corta.donde(/^CAE N°/).map((t) => t.hoja));
  const veinte = renglones(20);
  chk('B con 20 renglones: una hoja', 1, (await generar(factura(veinte), veinte)).hojas);
  const dos = [renglon(1), renglon(2, 8500, 4)];
  chk('A corta: una hoja', 1, (await generar(factura(dos, { tipo: 'A', clienteCuit: '30709998887' }), dos)).hojas);
  chk('C corta: una hoja', 1, (await generar(factura(dos, { tipo: 'C' }), dos)).hojas);
  const larga = await generar(factura(dos, {
    clienteNombre: 'María de las Mercedes Fernández Rodríguez de la Torre y Alvear',
    clienteDireccion: 'Avenida Hipólito Yrigoyen 12345, Piso 14, Departamento B (entre Avenida Pavón y Calle Doctor Melo), Lomas de Zamora, Provincia de Buenos Aires, CP 1832',
    clienteEmail: 'maria.de.las.mercedes.fernandez.rodriguez.compras@empresaconnombremuylargo.com.ar',
  }), dos);
  chk('domicilio y mail muy largos: una hoja', 1, larga.hojas);

  tit('2. EL DOMICILIO NO PISA EL CAMPO DE AL LADO NI EL DE ABAJO, Y EL MAIL NO SE CORTA');
  /*
   * Con lo que de verdad se dibujó: la x del campo IVA que salió en la hoja
   * (no la constante del código) y la y donde terminó el domicilio partido,
   * contra la y del Email. Un renglón de más o de menos en la cuenta de la
   * fila monta el Email sobre el domicilio, y eso es lo que se mira.
   */
  const etiqueta = (g, e) => g.textos.findIndex((t) => t.s === `${e}: `);
  const dom = larga.textos[etiqueta(larga, 'Domicilio')];
  const domValor = larga.textos[etiqueta(larga, 'Domicilio') + 1];
  const ivaCliente = larga.textos[etiqueta(larga, 'IVA')];
  const emailLargo = larga.textos[etiqueta(larga, 'Email')];
  chk('el domicilio de la prueba ocupa tres renglones o más', true, Boolean(domValor) && domValor.yFin - dom.y >= 3 * 9);
  chk('el domicilio se parte antes del IVA que se dibujó al lado', true,
    Boolean(dom && ivaCliente) && dom.y === ivaCliente.y && dom.x + dom.ancho <= ivaCliente.x);
  chk('el Email empieza debajo de donde terminó el domicilio', true,
    Boolean(domValor && emailLargo) && emailLargo.y >= domValor.yFin);
  chk('ninguna palabra de la hoja se encima con otra', [], encimadas(larga.buf));
  const textoLargo = execFileSync('pdftotext', ['-layout', '-', '-'], { input: larga.buf }).toString('utf8');
  chk('el mail sale entero en un renglón', true,
    textoLargo.split('\n').some((l) => l.includes('maria.de.las.mercedes.fernandez.rodriguez.compras@empresaconnombremuylargo.com.ar')));

  tit('3. UNA FACTURA LARGA PAGINA Y EL CIERRE VA ENTERO EN LA ÚLTIMA HOJA');
  const { MARCO } = facturaPdf.__medidas;
  for (const n of [11, 28, 35, 60]) {
    const items = renglones(n);
    const g = await generar(factura(items, { esMayorista: true }), items);
    const ultima = g.hojas;
    const qr = g.imagenes[0];
    chk(`${n} renglones (${ultima} hoja/s): el QR está en la última hoja`, ultima, qr?.hoja);
    chk(`   y adentro del marco`, true, Boolean(qr) && qr.y >= 0 && qr.y + qr.alto <= MARCO.abajo);
    chk('   el CAE, el Total y la Ley 27.743 también en la última', [ultima, ultima, ultima],
      [g.donde(/^CAE N°/)[0]?.hoja, g.donde('Total $')[0]?.hoja, g.donde(/27\.743/)[0]?.hoja]);
    chk('   ningún texto se dibuja fuera de la hoja', [], g.textos.filter((t) => t.y < 0 || t.y > 832).map((t) => t.s));
    chk('   se imprimen todos los renglones', n, g.donde(/^QA-REM-\d{3}-NEG-XL$/).length);
  }
  const treintaYCinco = renglones(35);
  const g35 = await generar(factura(treintaYCinco), treintaYCinco);
  chk('35 renglones: dos hojas', 2, g35.hojas);
  chk('   y la última trae detalle, no sólo los totales', true,
    g35.donde(/^QA-REM-\d{3}-NEG-XL$/).some((t) => t.hoja === 2));
  chk('   numeradas', true, g35.hay('Hoja 1 de 2') && g35.hay('Hoja 2 de 2'));

  tit('4. LA B NO DISCRIMINA EL IVA');
  chk('la B no lleva renglón de IVA ni de neto', [],
    corta.textos.filter((t) => /^IVA \d+% \$$|Neto|IVA \(21%\)/.test(t.s)).map((t) => t.s));
  chk('   el IVA contenido va sólo en el recuadro de la Ley 27.743', true, corta.hay('IVA Contenido: $'));
  const fa = factura(dos, { tipo: 'A', clienteCuit: '30709998887' });
  const a = await generar(fa, dos);
  chk('la A sí: neto gravado e IVA, los que se declararon a ARCA', true,
    a.hay('Importe Neto Gravado $') && a.hay('IVA 21% $')
      && a.hay(new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2 }).format(fa.subtotal))
      && a.hay(new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2 }).format(fa.iva)));
  chk('   y no lleva el recuadro de la Ley 27.743', false, a.hay(/27\.743/));
  const c = await generar(factura(dos, { tipo: 'C' }), dos);
  chk('la C no tiene columna IVA ni recuadro', [false, false], [c.hay('IVA'), c.hay(/27\.743/)]);

  tit('5. LOS NÚMEROS CIERRAN');
  const vB = facturaPdf.__vista(factura(dos), dos, NEGOCIO, CTX);
  chk('los renglones suman el subtotal', vB.subtotal, r2(vB.renglones.reduce((s, x) => s + x.total, 0)));
  chk('   el precio unitario va sin IVA y el total del renglón con IVA', [4958.68, 12000],
    [vB.renglones[0].unitario, vB.renglones[0].total]);
  chk('   sin descuento: subtotal = total y no hay renglón de Descuentos', [vB.subtotal, false],
    [vB.total, corta.hay('Descuentos')]);
  const fd = factura(dos, { descuentoVenta: 4000 });
  const vD = facturaPdf.__vista(fd, dos, NEGOCIO, { ...CTX, descuentoPct: 10 });
  chk('con descuento: el descuento es el de la venta', 4000, vD.descuento);
  chk('   subtotal menos descuentos da el total facturado', fd.total, r2(vD.subtotal - vD.descuento));
  const gD = await generar(fd, dos, { ...CTX, descuentoPct: 10 });
  chk('   y se imprime en negativo, con su porcentaje', true,
    gD.hay('Descuentos') && gD.hay('-4.000,00') && gD.hay('Descuento (10%)'));
  /*
   * El renglón, como el del modelo: el mismo importe en Precio Unitario y en
   * Precio Total, y la columna IVA vacía. No es un producto con su neto.
   */
  const renglonDesc = gD.donde('Descuento (10%)')[0];
  chk('   el renglón del descuento: unidades, el importe dos veces y sin alícuota',
    ['Descuento (10%)', '1', '-4.000,00', '-4.000,00'],
    gD.textos.filter((t) => renglonDesc && Math.abs(t.y - renglonDesc.y) < 1).map((t) => t.s));
  const vA = facturaPdf.__vista(fa, dos, NEGOCIO, CTX);
  chk('en la A, neto + IVA = total', vA.total, r2(vA.neto + vA.iva));

  tit('6. LA FECHA ES LA QUE AUTORIZÓ ARCA, EN HORA ARGENTINA');
  chk('una venta a las 23:30 de Argentina es de ese día', '20261012', aaaammddArgentina(new Date('2026-10-13T02:30:00Z')));
  chk('   a las 00:30 ya es el día siguiente', '20261013', aaaammddArgentina(new Date('2026-10-13T03:30:00Z')));
  chk('se imprime la fecha autorizada', true, corta.hay('Fecha de Emisión: 12/10/2026'));
  /*
   * Lo que pasó con las facturas emitidas antes de este arreglo: la fila es de
   * las 23:04 del 12 y a ARCA se le declaró el 13 (día UTC). El papel tiene que
   * decir lo que dice ARCA, no lo que dice la fila.
   */
  const declarada13 = factura(dos, { fechaEmision: new Date('2026-10-13T02:04:00Z'), cbteFchArca: '20261013' });
  chk('   si ARCA tiene otro día que la fila, manda ARCA', ['13/10/2026', '2026-10-13'],
    [facturaPdf.__vista(declarada13, dos, NEGOCIO, CTX).fecha, pdfService.__qr.datosQr(declarada13).fecha]);
  const sinFch = facturaPdf.__vista(factura(dos, { cbteFchArca: null }), dos, NEGOCIO, CTX);
  chk('   sin fecha de ARCA, la de creación en hora argentina', '12/10/2026', sinFch.fecha);
  chk('   el vencimiento del CAE sale tal cual', true, corta.hay('Fecha de Vto de CAE: 22/10/2026'));
  /*
   * Un DÍA no se pasa por la zona horaria: el Date que arma el driver para una
   * columna DATE es la medianoche UTC, que acá es el día anterior a las 21.
   */
  chk('un día que llega como Date del driver, o con hora pegada, no se corre',
    ['01/03/2019', '01/03/2019', '01/03/2019'],
    [ddmmaaaa(new Date(Date.UTC(2019, 2, 1))), ddmmaaaa('2019-03-01T00:00:00.000Z'), ddmmaaaa('20190301')]);

  tit('7. EL QR DICE LO QUE SE LE MANDÓ A ARCA (RG 4892)');
  const q = pdfService.__qr.datosQr(factura(dos));
  chk('los campos, en el orden de la especificación',
    ['ver', 'fecha', 'cuit', 'ptoVta', 'tipoCmp', 'nroCmp', 'importe', 'moneda', 'ctz', 'tipoDocRec', 'nroDocRec', 'tipoCodAut', 'codAut'],
    Object.keys(q));
  chk('   la fecha es la autorizada (CbteFch), no la de la fila', '2026-10-12', q.fecha);
  chk('   y los valores', [1, 30712345678, 15, 6, 7, 46000, 'PES', 1, 96, 30111222, 'E', 86400000000017],
    [q.ver, q.cuit, q.ptoVta, q.tipoCmp, q.nroCmp, q.importe, q.moneda, q.ctz, q.tipoDocRec, q.nroDocRec, q.tipoCodAut, q.codAut]);
  for (const doc of ['123456', '123456789', '20111111112']) {
    const d = pdfService.__qr.datosQr(factura(dos, { clienteCuit: doc }));
    chk(`documento ${doc.length} dígitos: el mismo tipo que recibió ARCA (${docTipoFromCliente(doc)})`,
      [docTipoFromCliente(doc), Number(doc)], [d.tipoDocRec, d.nroDocRec]);
  }
  const cf = pdfService.__qr.datosQr(factura(dos, { clienteCuit: null }));
  chk('consumidor final sin documento: no se inventa uno', [false, false], ['tipoDocRec' in cf, 'nroDocRec' in cf]);
  chk('el QR se dibuja en la factura de producción', 1, corta.imagenes.length);

  tit('8. LA CABECERA: EL CUIT Y EL LOCAL QUE EMITEN');
  chk('ORIGINAL, la letra y su código', true, corta.hay('ORIGINAL') && corta.hay('B') && corta.hay('COD. 06'));
  chk('Nro. de comprobante de ARCA y C.U.I.T con guiones', true,
    corta.hay('Nro. Comprobante: 00015-00000007') && corta.hay('C.U.I.T: 30-71234567-8'));
  chk('Ingresos Brutos e Inicio de Actividades, cuando están cargados', true,
    corta.hay('ING. BRUTOS: C.M. 901-000000-1') && corta.hay('Inicio Actividades: 01/03/2019'));
  const sinIibb = await generar(factura(dos), dos, { ...CTX, emisor: { ...CTX.emisor, ingresosBrutos: null, inicioActividades: null } });
  chk('   y si no lo están, el renglón no sale (ni una raya)', [false, false, false],
    [sinIibb.hay(/ING\. BRUTOS/), sinIibb.hay(/Inicio Actividades/), sinIibb.hay(/—/)]);
  chk('el domicilio comercial es el del local', true, corta.hay('Domicilio Comercial: Local QA [Av. Siempre Viva 742, CABA]'));
  const conFoto = await generar(factura(dos, { emisorDomicilio: 'Local Viejo [Calle Antigua 1]' }), dos);
  chk('   el guardado en la factura manda sobre el de hoy', true, conFoto.hay('Domicilio Comercial: Local Viejo [Calle Antigua 1]'));
  chk('domicilioComercial: el local, con su nombre', 'Centro [Av. QA 1]',
    facturaPdf.domicilioComercial({ local: { nombre: 'Centro', direccion: 'Av. QA 1', tipo: 'local' }, cuit: { domicilio: 'Fiscal 2' } }));
  chk('   la tienda online no es un lugar: va el del CUIT', 'Fiscal 2',
    facturaPdf.domicilioComercial({ local: { nombre: 'Online', direccion: 'Web', tipo: 'online' }, cuit: { domicilio: 'Fiscal 2' } }));
  chk('   sin ninguno, nada', null, facturaPdf.domicilioComercial({}));
  chk('la condición del emisor según la letra', ['IVA Responsable Inscripto', 'Responsable Monotributo'],
    [facturaPdf.__vista(factura(dos), dos, NEGOCIO, CTX).emisor.condicionIva,
      facturaPdf.__vista(factura(dos, { tipo: 'C', emisorCondicionIva: 'Monotributo' }), dos, NEGOCIO, CTX).emisor.condicionIva]);

  tit('8b. INGRESOS BRUTOS E INICIO: LOS DE LA FACTURA, NO LOS DEL CUIT DE HOY');
  /*
   * Se guardan al emitir. La reimpresión tiene que decir lo mismo que el papel
   * que recibió el cliente, aunque después se cargue o se cambie el dato del
   * CUIT (pasar a Convenio Multilateral cambia el número).
   */
  const ctxHoy = { ...CTX, emisor: { ...CTX.emisor, ingresosBrutos: 'C.M. 902-999999-9', inicioActividades: '2024-01-01' } };
  const conFotoIibb = await generar(factura(dos, {
    emisorIngresosBrutos: 'C.M. 901-000000-1', emisorInicioActividades: '2019-03-01',
  }), dos, ctxHoy);
  chk('la reimpresión dice lo que se guardó al emitir, no lo del CUIT de hoy', [true, true, false, false],
    [conFotoIibb.hay('ING. BRUTOS: C.M. 901-000000-1'), conFotoIibb.hay('Inicio Actividades: 01/03/2019'),
      conFotoIibb.hay(/902-999999-9/), conFotoIibb.hay(/01\/01\/2024/)]);
  const emitidaSinIibb = await generar(factura(dos, { emisorIngresosBrutos: '', emisorInicioActividades: '' }), dos, ctxHoy);
  chk('   una emitida sin esos datos sigue sin ellos aunque después se carguen', [false, false],
    [emitidaSinIibb.hay(/ING\. BRUTOS/), emitidaSinIibb.hay(/Inicio Actividades/)]);
  const anteriorALaFoto = await generar(factura(dos, { emisorIngresosBrutos: null, emisorInicioActividades: null }), dos, ctxHoy);
  chk('   una anterior a la foto (null) cae a los del CUIT, que es lo único que hay', [true, true],
    [anteriorALaFoto.hay('ING. BRUTOS: C.M. 902-999999-9'), anteriorALaFoto.hay('Inicio Actividades: 01/01/2024')]);
  chk('la foto: lo del CUIT, y vacío (no null) lo que no tiene cargado',
    [{ emisorIngresosBrutos: 'C.M. 901-000000-1', emisorInicioActividades: '2019-03-01' },
      { emisorIngresosBrutos: '', emisorInicioActividades: '' }, { emisorIngresosBrutos: '', emisorInicioActividades: '' }],
    [facturaPdf.fotoDelEmisor({ ingresosBrutos: ' C.M. 901-000000-1 ', inicioActividades: '2019-03-01' }),
      facturaPdf.fotoDelEmisor({ ingresosBrutos: null, inicioActividades: null }), facturaPdf.fotoDelEmisor(null)]);

  tit('9. EL CLIENTE, CON SU CONDICIÓN FRENTE AL IVA (RG 5616)');
  chk('Apellido y Nombre, DNI, Domicilio e IVA', true,
    corta.hay('Apellido y Nombre: ') && corta.hay('DNI: ') && corta.hay('Domicilio: ') && corta.hay('Consumidor Final'));
  const mono = facturaPdf.__vista(factura(dos, { clienteCuit: '20111111112', condicionIvaReceptorId: 6 }), dos, NEGOCIO, CTX);
  chk('la guardada al emitir', ['Responsable Monotributo', 'CUIT', '20-11111111-2'],
    [mono.receptor.condicionIva, mono.receptor.documento.etiqueta, mono.receptor.documento.valor]);
  /*
   * Una factura anterior a que se guardara la condición (null). Con CUIT, el
   * código de entonces declaraba lo que contestaba el padrón —monotributo,
   * exento—: imprimir "Consumidor Final" ahí sería un dato fiscal falso. Sólo
   * se imprime lo que se sabe seguro.
   */
  const vieja = (extra) => facturaPdf.__vista(factura(dos, { condicionIvaReceptorId: null, ...extra }), dos, NEGOCIO, CTX)
    .receptor.condicionIva;
  chk('una factura vieja sin documento: Consumidor Final, que era lo único posible', 'Consumidor Final',
    vieja({ clienteCuit: null }));
  chk('   una A vieja: Responsable Inscripto, que era a lo único que se emitía', 'IVA Responsable Inscripto',
    vieja({ tipo: 'A', clienteCuit: '30709998887' }));
  chk('   una B o una C vieja con documento: no se adivina', [null, null, null],
    [vieja({ clienteCuit: '20111111112' }), vieja({ clienteCuit: '30111222' }), vieja({ tipo: 'C', clienteCuit: '20111111112' })]);
  const viejaPdf = await generar(factura(dos, { condicionIvaReceptorId: null, clienteCuit: '20111111112' }), dos);
  chk('   y en el papel no sale el renglón del IVA del cliente', [false, false],
    [viejaPdf.hay('IVA: '), viejaPdf.hay('Consumidor Final')]);

  tit('10. TEXTO QUE LA FUENTE PUEDE ESCRIBIR');
  const may = await generar(factura(dos, { esMayorista: true }), dos);
  chk('"Precio mayorista aplicado", sin el "≥" que salía como basura', true, may.hay('Precio mayorista aplicado.'));
  chk('   nada de lo que se dibuja en la factura está fuera de la fuente', [],
    [...may.textos, ...larga.textos, ...g35.textos].filter((t) => !escribible(t.s)).map((t) => t.s));
  // El comprobante de venta comparte los totales viejos: ahí también estaba el "≥".
  anotados = { textos: [], imagenes: [] };
  const textosVenta = [];
  const espiaVenta = PDFDocument.prototype.text;
  PDFDocument.prototype.text = function (t) { textosVenta.push(String(t ?? '')); return espiaVenta.apply(this, arguments); };
  const rutaVenta = await pdfService.generateSalePdf(
    { id: 9, numero: 'QA-1', tipo: 'venta', fecha: '2026-10-12', subtotal: 12000, total: 12000, esMayorista: true },
    [renglon(1)], NEGOCIO,
  );
  PDFDocument.prototype.text = espiaVenta;
  anotados = null;
  fs.rmSync(path.resolve(rutaVenta), { force: true });
  chk('   ni en el comprobante de venta', [true, []],
    [textosVenta.includes('Precio mayorista aplicado'), textosVenta.filter((t) => !escribible(t))]);

  tit('11. UN COMPROBANTE QUE NO ES FISCAL SIGUE DICIÉNDOLO');
  const homo = await generar(factura(treintaYCinco, { ambiente: 'homologacion' }), treintaYCinco);
  chk('homologación: la franja roja en cada hoja', [1, 2], homo.donde('COMPROBANTE SIN VALIDEZ FISCAL').map((t) => t.hoja));
  chk('   sin QR y sin "Comprobante Autorizado"', [0, false], [homo.imagenes.length, homo.hay('Comprobante Autorizado')]);
  const sim = await generar(factura(dos, { simulado: true }), dos);
  chk('simulado: dice que el CAE es simulado', true, sim.hay(/CAE SIMULADO/));
  chk('producción: sin franja y con "Comprobante Autorizado"', [false, true],
    [corta.hay('COMPROBANTE SIN VALIDEZ FISCAL'), corta.hay('Comprobante Autorizado')]);
  const nc = await generar(factura(dos, { clase: 'nota_credito', cbteTipoArca: 8, motivo: 'Devolución' }), dos,
    { ...CTX, asociada: { tipo: 'B', clase: 'factura', ptoVtaArca: 15, cbteNroArca: 7, cbteFchArca: '20261012' } });
  chk('una nota de crédito se titula y se codifica como tal, y dice a qué factura revierte', true,
    nc.hay('Nota de Crédito') && nc.hay('COD. 08') && nc.hay('Factura B N° 00015-00000007 del 12/10/2026'));

  tit('12. UN SKU LARGO NO SE MONTA SOBRE EL RENGLÓN DE ABAJO');
  /*
   * La columna admite hasta 100 caracteres y con unos 25 el SKU ya no entra en
   * una línea ni con la letra más chica: se parte, y el renglón tiene que
   * crecer lo que ocupe. Se mira que todo lo que se escribe en un renglón
   * termine antes de que empiece lo del siguiente.
   */
  const SKU_30 = 'REMERA-OVERSIZE-NEGRO-XXL-0001';
  const SKU_100 = `${'REMERAOVERSIZENEGRO'.repeat(5)}XXXXX`;
  const conSku = (sku, i) => ({ ...renglon(i, 1000, 1), sku, titulo: `Prenda QA ${i}` });
  const largos = [conSku(SKU_30, 1), conSku(SKU_30.replace(/1$/, '2'), 2), conSku('QA-CORTO', 3), conSku(SKU_100, 4), conSku('QA-ULTIMO', 5)];
  const gSku = await generar(factura(largos), largos);
  chk('los SKU de prueba miden lo que tienen que medir', [30, 100], [SKU_30.length, SKU_100.length]);
  const filas = largos.map((it) => gSku.textos.filter((t) => t.s === it.sku || t.s.startsWith(`${it.titulo} (`)));
  chk('   cada renglón tiene su SKU entero y su producto', largos.map(() => 2), filas.map((f) => f.length));
  const pisadas = [];
  for (let i = 0; i + 1 < filas.length; i++) {
    const termina = Math.max(...filas[i].map((t) => t.yFin));
    const empieza = Math.min(...filas[i + 1].map((t) => t.y));
    if (!(termina <= empieza)) pisadas.push(`${largos[i].sku} termina en ${termina.toFixed(1)} y el de abajo empieza en ${empieza.toFixed(1)}`);
  }
  chk('   lo de cada renglón termina antes de que empiece el siguiente', [], pisadas);
  chk('   ninguna palabra se encima con otra', [], encimadas(gSku.buf));
  chk('   y sigue entrando en una hoja', 1, gSku.hojas);

  tit('13. UNA SOLA IMPLEMENTACIÓN: EL ARCHIVO ES EL MISMO PDF QUE SE DESCARGA');
  const ruta = await pdfService.generateInvoicePdf(factura(dos), dos, NEGOCIO, CTX);
  const delArchivo = execFileSync('pdftotext', ['-layout', path.resolve(ruta), '-']).toString('utf8');
  const delBuffer = execFileSync('pdftotext', ['-layout', '-', '-'],
    { input: await pdfService.generateInvoicePdfBuffer(factura(dos), dos, NEGOCIO, CTX) }).toString('utf8');
  fs.rmSync(path.resolve(ruta), { force: true });
  chk('mismo texto, mismas hojas', true, delArchivo === delBuffer && delArchivo.length > 200);

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
