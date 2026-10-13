/*
 * El logo de la factura, por CUIT emisor.
 *
 * Lo que se prueba es lo que lo rompe si sale mal:
 *   · Que el tipo lo decidan los BYTES del archivo y no el nombre ni lo que
 *     diga el navegador: un SVG (puede traer código) no entra nunca, tampoco
 *     llamándose logo.png, y un archivo que dice ser PNG y no lo es tampoco.
 *   · Que un PNG roto no llegue a PDFKit: lo decodifica en un callback de zlib
 *     fuera de todo try y se cae el PROCESO, no la descarga. Ni subiéndolo, ni
 *     si aparece en la base por otro camino.
 *   · Que lo que se guarda sea un PNG rearmado que PDFKit dibuja bien (las
 *     paletas de 4 bits con transparencia, el RGB con color clave y el
 *     entrelazado los dibujaba mal) y sin bloques de texto.
 *   · 300 KB y 2000 píxeles por lado.
 *   · Que un negocio no pueda ver, cambiar ni borrar el logo de otro, y que
 *     subirlo pida el permiso de la pantalla de CUIT.
 *   · Que el listado de CUITs no le mande la imagen al navegador.
 *   · Que la factura lo dibuje en el recuadro del emisor, arriba, sin
 *     deformarlo, adentro de su caja aunque sea muy alto o muy ancho, y que
 *     siga entrando en UNA hoja.
 *
 * Corre EN PROCESO: la API se monta con el router real (mismo multer, mismos
 * permisos, mismo requireAuth con sesiones de verdad) en un puerto que elige
 * el sistema, y las facturas se generan con el mismo PDFKit. Los negocios, los
 * CUITs y las imágenes son inventados y se borran al terminar.
 *
 * Uso:  node scripts/test-logo-factura.cjs
 * (necesita pdftoppm y pdftotext, de poppler-utils)
 */
// El SQL de cada consulta tapa el resultado. Si se quiere verlo, LOG_LEVEL=debug.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
process.env.TZ = 'UTC';
// FormData y Blob avisan en Node 18 que son experimentales; no es de esta prueba.
const emitirAviso = process.emitWarning;
process.emitWarning = (aviso, ...resto) => (/buffer\.File/.test(String(aviso)) ? undefined : emitirAviso.call(process, aviso, ...resto));
require('dotenv').config({ path: __dirname + '/../.env' });

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const express = require('express');
const PDFDocument = require('pdfkit');
const { PNG } = require('pngjs');
const crc32 = require('pngjs/lib/crc').crc32;
const { Op } = require('sequelize');

const logo = require('../src/utils/logoFactura');
const facturaPdf = require('../src/services/facturaPdf');
const pdfService = require('../src/services/pdfService');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/* ── Imágenes inventadas ───────────────────────────────────────────── */

const MAGENTA = [255, 0, 255, 255];
const TRANSPARENTE = [0, 0, 0, 0];

/* Un PNG armado con pngjs a partir de una función de píxel. */
function png(ancho, alto, pixel, { colorType = 6 } = {}) {
  const img = new PNG({ width: ancho, height: alto });
  for (let y = 0; y < alto; y += 1) {
    for (let x = 0; x < ancho; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      const i = (y * ancho + x) * 4;
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = a;
    }
  }
  return PNG.sync.write(img, { colorType });
}

// Un rectángulo magenta con un borde transparente de `borde` píxeles.
const conBorde = (ancho, alto, borde) => png(ancho, alto, (x, y) =>
  (x < borde || y < borde || x >= ancho - borde || y >= alto - borde ? TRANSPARENTE : MAGENTA));

/*
 * Un PNG armado a mano, bloque por bloque, para las variantes que pngjs no
 * escribe (paletas de 4 bits, 16 bits, entrelazado) y para los rotos.
 * `filas` es lo que va comprimido en IDAT, ya con el byte de filtro de cada fila.
 */
function bloque(tipo, datos = Buffer.alloc(0)) {
  const tipoYDatos = Buffer.concat([Buffer.from(tipo, 'latin1'), datos]);
  const largo = Buffer.alloc(4); largo.writeUInt32BE(datos.length);
  const crc = Buffer.alloc(4); crc.writeInt32BE(crc32(tipoYDatos));
  return Buffer.concat([largo, tipoYDatos, crc]);
}
const FIRMA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngCrudo({ ancho, alto, bits = 8, color = 0, entrelazado = 0, filas, previos = [], idat = null, sinFin = false }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ancho, 0); ihdr.writeUInt32BE(alto, 4);
  ihdr[8] = bits; ihdr[9] = color; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = entrelazado;
  return Buffer.concat([
    FIRMA, bloque('IHDR', ihdr), ...previos,
    bloque('IDAT', idat || zlib.deflateSync(filas)),
    ...(sinFin ? [] : [bloque('IEND')]),
  ]);
}

// Gris de 8 bits entrelazado (Adam7), con filtro 0 en cada fila de cada pasada.
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
function grisEntrelazado(ancho, alto, gris) {
  const partes = [];
  for (const [x0, y0, dx, dy] of ADAM7) {
    for (let y = y0; y < alto; y += dy) {
      const fila = [0];
      for (let x = x0; x < ancho; x += dx) fila.push(gris(x, y));
      if (fila.length > 1) partes.push(Buffer.from(fila));
    }
  }
  return pngCrudo({ ancho, alto, entrelazado: 1, filas: Buffer.concat(partes) });
}

/* Ruido: no comprime, así que el archivo pesa lo que miden sus píxeles. */
function ruido(ancho, alto) {
  const azar = crypto.randomBytes(ancho * alto * 3);
  return png(ancho, alto, (x, y) => { const i = (y * ancho + x) * 3; return [azar[i], azar[i + 1], azar[i + 2], 255]; }, { colorType: 2 });
}

const leerPixeles = (buf) => PNG.sync.read(buf);
const ihdrDe = (buf) => ({ color: buf[25], bits: buf[24], entrelazado: buf[28] });
const bloquesDe = (buf) => {
  const tipos = [];
  for (let pos = 8; pos + 8 <= buf.length;) {
    const largo = buf.readUInt32BE(pos);
    tipos.push(buf.toString('latin1', pos + 4, pos + 8));
    pos += 12 + largo;
  }
  return tipos;
};

// Un JPEG de 48 × 16 todo magenta, hecho para esta prueba.
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAQADADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDgqKKK/uA/0dCiiigAooooA//Z',
  'base64',
);
const posSof = JPEG.indexOf(Buffer.from([0xff, 0xc0]));
const jpegCon = (cambio) => { const b = Buffer.from(JPEG); cambio(b); return b; };

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>fetch("/api/account")</script><rect width="10" height="10"/></svg>');

/* Qué contesta leerLogo / prepararLogo: el código del error, o 'ok'. */
const codigo = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.codigo || `sin código: ${e.message}`; } };

/* ── La API, en proceso ───────────────────────────────────────────── */

const CUIT_A = '20999777423';
const CUIT_B = '20999777449';
const PATRON = 'qa.logo.%@stocker.test';
const SUF = `${process.pid}${Date.now().toString(36)}`;

let base = null;
async function api(token, metodo, ruta, { archivo, nombre = 'logo.png', tipo = 'image/png', json, dosArchivos = false } = {}) {
  const opciones = { method: metodo, headers: { authorization: `Bearer ${token}`, 'user-agent': 'qa-logo' } };
  if (archivo) {
    const form = new FormData();
    form.append('logo', new Blob([archivo], { type: tipo }), nombre);
    if (dosArchivos) form.append('logo', new Blob([archivo], { type: tipo }), `otro-${nombre}`);
    opciones.body = form;
  } else if (json) {
    opciones.headers['content-type'] = 'application/json';
    opciones.body = JSON.stringify(json);
  }
  const r = await fetch(`${base}/api${ruta}`, opciones);
  const crudo = Buffer.from(await r.arrayBuffer());
  const tipoResp = r.headers.get('content-type') || '';
  let cuerpo = null;
  if (tipoResp.includes('json')) { try { cuerpo = JSON.parse(crudo.toString('utf8')); } catch { cuerpo = null; } }
  return { status: r.status, cuerpo, crudo, tipo: tipoResp, headers: r.headers };
}

/* ── La factura ───────────────────────────────────────────────────── */

let anotados = null;
const textoOriginal = PDFDocument.prototype.text;
const imagenOriginal = PDFDocument.prototype.image;
PDFDocument.prototype.text = function (texto) {
  if (anotados && this.options.bufferPages) anotados.textos.push(String(texto ?? ''));
  return textoOriginal.apply(this, arguments);
};
PDFDocument.prototype.image = function (src, x, y, opciones) {
  if (anotados && this.options.bufferPages) anotados.imagenes.push({ x, y, fit: opciones?.fit || null });
  return imagenOriginal.apply(this, arguments);
};
const contarHojas = (buf) => (buf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;

const r2 = (v) => Math.round(v * 100) / 100;
const renglon = (i, precio = 6000, cantidad = 2) => ({
  titulo: `Remera QA ${i}`, sku: `QA-REM-${String(i).padStart(3, '0')}`,
  cantidad, precioUnitario: precio, subtotal: precio * cantidad,
});
const renglones = (n) => Array.from({ length: n }, (_, i) => renglon(i + 1, 1000 + i * 10, 1 + (i % 3)));
function factura(items, extra = {}) {
  const tipo = extra.tipo || 'B';
  const total = r2(items.reduce((s, i) => s + i.subtotal, 0));
  const neto = tipo === 'C' ? total : r2(total / 1.21);
  return {
    id: 7, numero: '2610-00007', tipo, clase: 'factura',
    emisorCuit: CUIT_A, emisorNombre: 'QA Logo S.R.L.',
    clienteNombre: 'Cliente QA', clienteCuit: '30111222', clienteDireccion: 'Calle QA 123',
    fechaEmision: new Date('2026-10-13T15:00:00Z'), cbteFchArca: '20261013',
    subtotal: neto, iva: r2(total - neto), total,
    cae: '86400000000017', caeVencimiento: '2026-10-23',
    ambiente: 'produccion', simulado: false,
    ptoVtaArca: 15, cbteNroArca: 7, cbteTipoArca: { A: 1, B: 6, C: 11 }[tipo],
    ...extra,
  };
}
const NEGOCIO = { nombreNegocio: 'Marca QA Logo', cuit: CUIT_A, condicionIva: 'Responsable Inscripto' };

/* La factura de verdad: el contexto sale de la base, como en la descarga. */
async function generar(inv, items) {
  const contexto = await facturaPdf.contextoDeImpresion(inv);
  anotados = { textos: [], imagenes: [] };
  const buf = await pdfService.generateInvoicePdfBuffer(inv, items, NEGOCIO, contexto);
  const r = { buf, hojas: contarHojas(buf), ...anotados, contexto };
  anotados = null;
  r.hay = (s) => r.textos.includes(s);
  return r;
}

/*
 * Dónde quedó lo magenta en la hoja, en puntos. Se renderiza la primera hoja
 * con pdftoppm a 144 dpi (2 píxeles por punto) y se busca el rectángulo que
 * encierra los píxeles magenta: es el logo, tal como se ve impreso.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-logo-'));
function dondeQuedoElMagenta(pdf, nombre) {
  const base = path.join(TMP, nombre);
  fs.writeFileSync(`${base}.pdf`, pdf);
  execFileSync('pdftoppm', ['-r', '144', '-f', '1', '-l', '1', '-png', '-singlefile', `${base}.pdf`, base]);
  const img = PNG.sync.read(fs.readFileSync(`${base}.png`));
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      const i = (y * img.width + x) * 4;
      const [r, g, b] = [img.data[i], img.data[i + 1], img.data[i + 2]];
      if (r > 200 && g < 70 && b > 200) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const k = 72 / 144;
  return { x0: x0 * k, y0: y0 * k, x1: (x1 + 1) * k, y1: (y1 + 1) * k, png: `${base}.png` };
}
const dentro = (caja, r, margen = 0.6) => Boolean(r)
  && r.x0 >= caja.x0 - margen && r.x1 <= caja.x1 + margen && r.y0 >= caja.y0 - margen && r.y1 <= caja.y1 + margen;
const proporcion = (r) => (r.x1 - r.x0) / (r.y1 - r.y0);

(async () => {
  const db = require('../src/config/database');
  const { ensureColumns } = require('../src/database/ensureColumns');
  const {
    Business, BusinessCuit, Subscription, SesionCuenta, Employee, Role,
  } = require('../src/models');
  const planService = require('../src/services/planService');
  const sesiones = require('../src/services/sesionesService');
  const routes = require('../src/routes');
  const { errorHandler } = require('../src/middleware/errorHandler');

  await ensureColumns(db);

  async function limpiar() {
    const restos = await Business.findAll({
      where: { [Op.or]: [{ email: { [Op.like]: PATRON } }, { cuit: [CUIT_A, CUIT_B] }] },
    });
    for (const b of restos) {
      await SesionCuenta.destroy({ where: { businessId: b.id } });
      await Employee.destroy({ where: { businessId: b.id } });
      await Role.destroy({ where: { businessId: b.id } });
      await Subscription.destroy({ where: { businessId: b.id } });
      await BusinessCuit.destroy({ where: { businessId: b.id } });
      await b.destroy();
    }
  }
  await limpiar();

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', routes);
  app.use(errorHandler);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;

  try {
    tit('1. EL TIPO LO DECIDEN LOS BYTES, NO EL NOMBRE');
    const pngValido = conBorde(600, 160, 10);
    chk('un PNG de verdad entra', ['image/png', 600, 160],
      (() => { const l = logo.leerLogo(pngValido); return [l.tipo, l.ancho, l.alto]; })());
    chk('un JPEG de verdad entra', ['image/jpeg', 48, 16],
      (() => { const l = logo.leerLogo(JPEG); return [l.tipo, l.ancho, l.alto]; })());
    chk('un SVG no entra nunca', 'LOGO_FORMATO', codigo(() => logo.leerLogo(SVG)));
    let msgSvg = ''; try { logo.leerLogo(SVG); } catch (e) { msgSvg = e.message; }
    chk('   y el mensaje dice por qué (SVG)', true, /SVG/.test(msgSvg) && /código/.test(msgSvg));
    chk('   tampoco con la marca de UTF-8 y espacios adelante', 'LOGO_FORMATO',
      codigo(() => logo.leerLogo(Buffer.concat([Buffer.from('﻿  \n'), SVG]))));
    chk('un texto cualquiera no entra', 'LOGO_FORMATO', codigo(() => logo.leerLogo(Buffer.from('esto no es un png, aunque se llame logo.png'))));
    chk('un GIF no entra', 'LOGO_FORMATO', codigo(() => logo.leerLogo(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'))));
    chk('un WebP no entra', 'LOGO_FORMATO', codigo(() => logo.leerLogo(Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1'))));
    chk('nada no es un logo', 'LOGO_FALTA', codigo(() => logo.leerLogo(Buffer.alloc(0))));

    tit('2. UN ARCHIVO QUE DICE SER PNG Y NO LO ES');
    chk('la firma de PNG y después cualquier cosa', 'LOGO_DANADO',
      codigo(() => logo.leerLogo(Buffer.concat([FIRMA, Buffer.from('<svg><script>x()</script></svg>')]))));
    const roto = Buffer.from(pngValido); roto[roto.length - 20] ^= 0xff;
    chk('un PNG con un byte cambiado (el CRC no cierra)', 'LOGO_DANADO', codigo(() => logo.leerLogo(roto)));
    const filas3x2 = Buffer.from([0, 10, 20, 30, 0, 40, 50, 60]);
    chk('un PNG armado a mano y sano entra (control del armador)', 'ok',
      codigo(() => logo.leerLogo(pngCrudo({ ancho: 3, alto: 2, filas: filas3x2 }))));
    chk('sin el bloque final (IEND)', 'LOGO_DANADO',
      codigo(() => logo.leerLogo(pngCrudo({ ancho: 3, alto: 2, filas: filas3x2, sinFin: true }))));
    /*
     * El caso que tiraba abajo el proceso: estructura y CRC perfectos, pero un
     * filtro de fila que no existe. PDFKit lo descubre recién en el callback
     * de zlib, donde ya no hay try que lo ataje.
     */
    // Con transparencia, que es el caso en que PDFKit sí lo decodifica.
    const filtroInvalido = pngCrudo({
      ancho: 2, alto: 2, color: 6,
      filas: Buffer.from([0, 255, 0, 255, 255, 255, 0, 255, 0, 9, 255, 0, 255, 255, 255, 0, 255, 0]),
    });
    chk('un filtro de fila que no existe', 'LOGO_DANADO', codigo(() => logo.leerLogo(filtroInvalido)));
    chk('menos datos que los que dicen sus medidas', 'LOGO_DANADO',
      codigo(() => logo.leerLogo(pngCrudo({ ancho: 3, alto: 2, filas: Buffer.from([0, 10, 20, 30]) }))));
    // Uno solo de menos: el lector de PNG lo acepta y rellena; acá no se acepta.
    chk('   aunque sea un byte (el último píxel)', 'LOGO_DANADO',
      codigo(() => logo.leerLogo(pngCrudo({ ancho: 3, alto: 2, filas: filas3x2.subarray(0, 7) }))));
    chk('más datos que los que dicen sus medidas', 'LOGO_DANADO',
      codigo(() => logo.leerLogo(pngCrudo({ ancho: 3, alto: 2, filas: Buffer.concat([filas3x2, Buffer.alloc(4000)]) }))));
    // La "bomba": unos KB que se descomprimen en 30 MB. Entrelazada, que es
    // donde el lector de PNG no pone tope.
    const bomba = pngCrudo({ ancho: 8, alto: 8, entrelazado: 1, filas: Buffer.alloc(30 * 1024 * 1024) });
    const memAntes = process.memoryUsage().rss;
    chk(`una bomba de ${Math.round(bomba.length / 1024)} KB que se descomprime en 30 MB`, 'LOGO_DANADO', codigo(() => logo.leerLogo(bomba)));
    chk('   y no se descomprime entera para descubrirlo', true, process.memoryUsage().rss - memAntes < 25 * 1024 * 1024);
    chk('una paleta sin su tabla de colores', 'LOGO_DANADO',
      codigo(() => logo.leerLogo(pngCrudo({ ancho: 3, alto: 2, color: 3, filas: filas3x2 }))));
    chk('un JPEG cortado antes de sus medidas', 'LOGO_DANADO', codigo(() => logo.leerLogo(JPEG.subarray(0, posSof))));
    chk('un JPEG sin pérdida (no se imprime en un PDF)', 'LOGO_NO_SOPORTADO',
      codigo(() => logo.leerLogo(jpegCon((b) => { b[posSof + 1] = 0xc3; }))));

    tit('3. TAMAÑO Y MEDIDAS');
    const pesado = ruido(340, 340);
    chk(`un PNG válido de ${Math.round(pesado.length / 1024)} KB (más de 300) no entra`, ['LOGO_PESADO', true],
      [codigo(() => logo.leerLogo(pesado)), pesado.length > logo.LOGO_MAX_BYTES]);
    let statusPesado = null; try { logo.leerLogo(pesado); } catch (e) { statusPesado = e.status; }
    chk('   y es un 413', 413, statusPesado);
    chk('justo 300 KB sí entra (el tope es "hasta")', 'LOGO_DANADO',
      codigo(() => logo.leerLogo(Buffer.concat([FIRMA, Buffer.alloc(logo.LOGO_MAX_BYTES - 8)]))));
    chk('2000 píxeles de ancho entra', 'ok', codigo(() => logo.leerLogo(png(2000, 1, () => MAGENTA))));
    chk('2001 no', 'LOGO_MEDIDAS', codigo(() => logo.leerLogo(png(2001, 1, () => MAGENTA))));
    chk('2001 de alto tampoco', 'LOGO_MEDIDAS', codigo(() => logo.leerLogo(png(1, 2001, () => MAGENTA))));
    chk('un JPEG de 2001 de ancho tampoco', 'LOGO_MEDIDAS',
      codigo(() => logo.leerLogo(jpegCon((b) => b.writeUInt16BE(2001, posSof + 7)))));
    chk('un PNG que dice medir cero', 'LOGO_DANADO',
      codigo(() => logo.leerLogo(pngCrudo({ ancho: 0, alto: 2, filas: Buffer.from([0, 0]) }))));

    tit('4. LO QUE SE GUARDA ES UN PNG REARMADO');
    // Paleta de 4 bits con transparencia: el lector de PDFKit arma mal la máscara.
    const PALETA = Buffer.from([255, 0, 255, 255, 255, 255, 0, 0, 0]);
    const paleta4 = pngCrudo({
      ancho: 5, alto: 2, bits: 4, color: 3,
      previos: [bloque('PLTE', PALETA), bloque('tRNS', Buffer.from([255, 0, 255]))],
      filas: Buffer.from([0, 0x01, 0x20, 0x10, 0, 0x22, 0x01, 0x00]),
    });
    const g4 = logo.prepararLogo(paleta4);
    chk('paleta de 4 bits con transparencia → color con transparencia de 8 bits', [6, 8, 0],
      Object.values(ihdrDe(g4.datos)));
    chk('   con los mismos píxeles', true, leerPixeles(g4.datos).data.equals(leerPixeles(paleta4).data));
    // RGB con color clave (tRNS de 6 bytes): PDFKit arma una máscara inválida.
    const clave = pngCrudo({
      ancho: 2, alto: 1, color: 2, previos: [bloque('tRNS', Buffer.from([0, 255, 0, 0, 0, 255]))],
      filas: Buffer.from([0, 255, 0, 255, 255, 255, 255]),
    });
    const gClave = logo.prepararLogo(clave);
    const pxClave = [...leerPixeles(gClave.datos).data];
    chk('RGB con color clave → la transparencia pasa a ser un canal (el magenta transparente, el blanco no)',
      [6, 0, [255, 255, 255, 255]], [ihdrDe(gClave.datos).color, pxClave[3], pxClave.slice(4)]);
    const entrelazado = grisEntrelazado(9, 7, (x, y) => (x * 20 + y * 7) % 256);
    chk('un PNG entrelazado entra', 'ok', codigo(() => logo.leerLogo(entrelazado)));
    const gEnt = logo.prepararLogo(entrelazado);
    chk('   y se guarda sin entrelazar, con los mismos píxeles', [0, true],
      [ihdrDe(gEnt.datos).entrelazado, leerPixeles(gEnt.datos).data.equals(leerPixeles(entrelazado).data)]);
    const dieciseis = pngCrudo({ ancho: 1, alto: 1, bits: 16, color: 6, filas: Buffer.from([0, 255, 255, 0, 0, 255, 255, 255, 255]) });
    chk('16 bits → 8', [8, [255, 0, 255, 255]], [ihdrDe(logo.prepararLogo(dieciseis).datos).bits, [...leerPixeles(logo.prepararLogo(dieciseis).datos).data]]);
    // Un bloque de texto con código adentro: se va con el rearmado.
    const conTexto = Buffer.concat([
      pngValido.subarray(0, 33), bloque('tEXt', Buffer.from('Comment\0<script>fetch("/api")</script>')), pngValido.subarray(33),
    ]);
    chk('el PNG con un bloque de texto entra (control: el bloque está)', ['ok', true],
      [codigo(() => logo.leerLogo(conTexto)), bloquesDe(conTexto).includes('tEXt')]);
    chk('   y lo guardado no lo lleva: sólo cabecera, imagen y fin', ['IHDR', 'IDAT', 'IEND'],
      bloquesDe(logo.prepararLogo(conTexto).datos));
    chk('un logo sin transparencia se guarda sin canal de transparencia (PDFKit no lo decodifica)', 2,
      ihdrDe(logo.prepararLogo(png(30, 10, () => MAGENTA)).datos).color);
    chk('el JPEG se guarda tal cual', true, logo.prepararLogo(JPEG).datos.equals(JPEG));

    tit('5. LA API: SUBIR, VER, REEMPLAZAR, QUITAR');
    const negocioA = await Business.create({
      nombreNegocio: 'QA Logo A', ownerNombre: 'Ana', ownerApellido: 'Prueba',
      cuit: CUIT_A, email: `qa.logo.a.${SUF}@stocker.test`, passwordHash: 'x',
    });
    const negocioB = await Business.create({
      nombreNegocio: 'QA Logo B', ownerNombre: 'Beto', ownerApellido: 'Prueba',
      cuit: CUIT_B, email: `qa.logo.b.${SUF}@stocker.test`, passwordHash: 'x',
    });
    await planService.iniciarTrial(negocioA.id, { plan: 'pro' });
    await planService.iniciarTrial(negocioB.id, { plan: 'pro' });
    const cuitA = await BusinessCuit.create({
      businessId: negocioA.id, nombre: 'QA Logo S.R.L.', cuit: CUIT_A, esPrincipal: true,
      condicionIva: 'Responsable Inscripto', domicilio: 'Av. QA 100, CABA',
    });
    const cuitA2 = await BusinessCuit.create({
      businessId: negocioA.id, nombre: 'QA Otra Razón S.A.', cuit: '30999777426', esPrincipal: false,
    });
    const cuitB = await BusinessCuit.create({ businessId: negocioB.id, nombre: 'QA B S.A.', cuit: CUIT_B, esPrincipal: true });
    const cargoCaja = await Role.create({ businessId: negocioA.id, nombre: 'QA Caja', permisos: { ventas: 'editar' } });
    const cargoVer = await Role.create({ businessId: negocioA.id, nombre: 'QA Ver facturas', permisos: { facturacion: 'ver' } });
    const empleado = (cargo, n) => Employee.create({
      businessId: negocioA.id, roleId: cargo.id, dni: `3911122${n}`, nombre: `Emp${n}`, apellido: 'Prueba',
      email: `qa.logo.emp${n}.${SUF}@stocker.test`, passwordHash: 'x', activo: true,
    });
    const cajero = await empleado(cargoCaja, 1);
    const veFacturas = await empleado(cargoVer, 2);
    const reqFalso = { headers: { 'user-agent': 'qa-logo' }, ip: '127.0.0.1' };
    const tokA = await sesiones.abrir(reqFalso, { type: 'business', businessId: negocioA.id });
    const tokB = await sesiones.abrir(reqFalso, { type: 'business', businessId: negocioB.id });
    const tokCaja = await sesiones.abrir(reqFalso, { type: 'employee', businessId: negocioA.id, employeeId: cajero.id, roleId: cargoCaja.id });
    const tokVer = await sesiones.abrir(reqFalso, { type: 'employee', businessId: negocioA.id, employeeId: veFacturas.id, roleId: cargoVer.id });
    const rutaA = `/business-cuits/${cuitA.id}/logo`;

    let r = await api(tokA, 'PUT', rutaA, { archivo: pngValido });
    chk('el dueño sube un PNG: 200, con tieneLogo y el tipo comprobado', [200, true, 'image/png'],
      [r.status, r.cuerpo?.tieneLogo, r.cuerpo?.logoTipo]);
    chk('   la respuesta no trae la imagen', false, r.cuerpo ? 'logo' in r.cuerpo : null);
    const lista = await api(tokA, 'GET', '/business-cuits');
    chk('el listado de CUITs no trae la imagen', [200, false],
      [lista.status, (lista.cuerpo || []).some((c) => 'logo' in c)]);
    chk('   y dice cuál tiene logo', [[cuitA.id, true], [cuitA2.id, false]],
      (lista.cuerpo || []).map((c) => [c.id, c.tieneLogo]).sort((a, b) => a[0] - b[0]));
    chk('   (y pesa lo que pesan los datos, no la imagen)', true, lista.crudo.length < 4000);
    r = await api(tokA, 'GET', rutaA);
    chk('verlo: 200, image/png, sin que el navegador adivine otro tipo', [200, 'image/png', 'nosniff'],
      [r.status, r.tipo, r.headers.get('x-content-type-options')]);
    chk('   son los mismos píxeles que se subieron', true, leerPixeles(r.crudo).data.equals(leerPixeles(pngValido).data));
    const guardado = await BusinessCuit.unscoped().findByPk(cuitA.id);
    chk('en la base: el binario, el tipo y la fecha', [true, 'image/png', true],
      [Buffer.isBuffer(guardado.logo) && guardado.logo.length > 100, guardado.logoTipo, guardado.logoActualizadoEn instanceof Date]);
    chk('una lectura común del CUIT no trae el binario', false, 'logo' in (await BusinessCuit.findByPk(cuitA.id)).dataValues);

    r = await api(tokA, 'PUT', rutaA, { archivo: JPEG, nombre: 'logo.jpg', tipo: 'image/jpeg' });
    chk('reemplazarlo por un JPEG', [200, 'image/jpeg'], [r.status, r.cuerpo?.logoTipo]);
    r = await api(tokA, 'GET', rutaA);
    chk('   y se ve el JPEG, tal cual', ['image/jpeg', true], [r.tipo, r.crudo.equals(JPEG)]);

    const sigueJpeg = async () => (await api(tokA, 'GET', rutaA)).crudo.equals(JPEG);
    r = await api(tokA, 'PUT', rutaA, { archivo: SVG, nombre: 'logo.svg', tipo: 'image/svg+xml' });
    chk('un SVG: 400 LOGO_FORMATO', [400, 'LOGO_FORMATO'], [r.status, r.cuerpo?.codigo]);
    r = await api(tokA, 'PUT', rutaA, { archivo: SVG, nombre: 'logo.png', tipo: 'image/png' });
    chk('un SVG que se llama logo.png y dice ser image/png: 400 LOGO_FORMATO', [400, 'LOGO_FORMATO'], [r.status, r.cuerpo?.codigo]);
    r = await api(tokA, 'PUT', rutaA, { archivo: filtroInvalido, nombre: 'logo.png' });
    chk('un PNG roto: 400 LOGO_DANADO', [400, 'LOGO_DANADO'], [r.status, r.cuerpo?.codigo]);
    r = await api(tokA, 'PUT', rutaA, { archivo: pesado, nombre: 'logo.png' });
    chk('uno de más de 300 KB: 413 LOGO_PESADO', [413, 'LOGO_PESADO'], [r.status, r.cuerpo?.codigo]);
    chk('   cortado por multer, antes de leerlo entero', true, /que es el máximo/.test(r.cuerpo?.message || ''));
    r = await api(tokA, 'PUT', rutaA, { json: { logo: 'iVBORw0KGgo=' } });
    chk('sin archivo: 400 LOGO_FALTA', [400, 'LOGO_FALTA'], [r.status, r.cuerpo?.codigo]);
    r = await api(tokA, 'PUT', rutaA, { archivo: pngValido, dosArchivos: true });
    chk('dos archivos: 400', 400, r.status);
    chk('después de todo eso el logo sigue siendo el JPEG', true, await sigueJpeg());

    tit('6. UN NEGOCIO NO TOCA EL LOGO DE OTRO; SUBIRLO PIDE EL PERMISO DE LA PANTALLA');
    chk('B no puede verlo: 404 (como si no existiera)', 404, (await api(tokB, 'GET', rutaA)).status);
    chk('B no puede reemplazarlo: 404', 404, (await api(tokB, 'PUT', rutaA, { archivo: pngValido })).status);
    chk('B no puede borrarlo: 404', 404, (await api(tokB, 'DELETE', rutaA)).status);
    chk('   y el de A sigue intacto', true, await sigueJpeg());
    chk('B sí con el suyo', 200, (await api(tokB, 'PUT', `/business-cuits/${cuitB.id}/logo`, { archivo: conBorde(300, 100, 4) })).status);
    chk('   y A no puede ver el de B', 404, (await api(tokA, 'GET', `/business-cuits/${cuitB.id}/logo`)).status);
    chk('un id que no es un número: 404', 404, (await api(tokA, 'GET', '/business-cuits/abc/logo')).status);
    chk('un cajero (sólo ventas) no lo ve ni lo sube: 403', [403, 403],
      [(await api(tokCaja, 'GET', rutaA)).status, (await api(tokCaja, 'PUT', rutaA, { archivo: pngValido })).status]);
    chk('quien ve facturación lo ve, pero no lo cambia ni lo quita', [200, 403, 403],
      [(await api(tokVer, 'GET', rutaA)).status, (await api(tokVer, 'PUT', rutaA, { archivo: pngValido })).status,
        (await api(tokVer, 'DELETE', rutaA)).status]);
    chk('   y sigue siendo el JPEG', true, await sigueJpeg());

    tit('7. LA FACTURA LO LLEVA EN EL RECUADRO DEL EMISOR');
    await api(tokA, 'PUT', rutaA, { archivo: pngValido });
    const { INTERIOR, ALTO_LOGO } = facturaPdf.__medidas;
    const anchoCaja = (INTERIOR.x1 - INTERIOR.x0) / 2;
    const invA = (items, extra = {}) => factura(items, { businessId: negocioA.id, businessCuitId: cuitA.id, ...extra });
    const tres = [renglon(1), renglon(2, 8500, 1), renglon(3, 4200, 3)];
    const conLogo = await generar(invA(tres), tres);
    chk('el contexto trae el logo del CUIT que emite', 'image/png', conLogo.contexto.emisor.logo?.tipo);
    chk('una hoja', 1, conLogo.hojas);
    chk('se dibujan dos imágenes: el logo y el QR', 2, conLogo.imagenes.length);
    chk('   el logo con fit en la caja del modelo (sin deformarlo)', [r2(anchoCaja - 20), ALTO_LOGO], (conLogo.imagenes[0].fit || []).map(r2));
    chk('el nombre grande ya no se imprime; la razón social sí', [false, true],
      [conLogo.hay('Marca QA Logo'), conLogo.hay('Razón Social: QA Logo S.R.L.')]);
    /*
     * La caja del logo: arriba del recuadro izquierdo, con su margen, y hasta
     * donde empiezan las líneas de abajo (razón social, domicilio, IVA).
     */
    const top = 36 + 53;
    const caja = { x0: INTERIOR.x0 + 10, x1: INTERIOR.x0 + anchoCaja - 10, y0: top, y1: top + 2 + ALTO_LOGO };
    const visto = dondeQuedoElMagenta(conLogo.buf, 'b-con-logo');
    chk('en la hoja impresa el logo queda adentro del recuadro del emisor, arriba', true, dentro(caja, visto));
    // 580 × 140 es la parte magenta (el resto del PNG es borde transparente).
    chk('   sin deformarse (580 × 140 → misma proporción)', true, Boolean(visto) && Math.abs(proporcion(visto) - 580 / 140) < 0.1);
    chk('   del alto del modelo (45,5 pt la imagen, 140/160 de eso lo magenta)', true,
      Boolean(visto) && Math.abs((visto.y1 - visto.y0) - ALTO_LOGO * 140 / 160) < 1.2);
    chk('   centrado como en el modelo', true,
      Boolean(visto) && Math.abs((visto.x0 + visto.x1) / 2 - (INTERIOR.x0 + anchoCaja / 2)) < 1);
    if (visto) fs.copyFileSync(visto.png, path.join(TMP, 'para-mirar.png'));

    const veinte = renglones(20);
    chk('con 20 renglones y logo: una hoja', 1, (await generar(invA(veinte), veinte)).hojas);
    const dos = [renglon(1), renglon(2, 8500, 4)];
    chk('una A con logo: una hoja', 1, (await generar(invA(dos, { tipo: 'A', clienteCuit: '30709998887' }), dos)).hojas);
    const homo = await generar(invA(dos, { ambiente: 'homologacion' }), dos);
    chk('homologación (con la franja roja arriba) y logo: una hoja, con el logo', [1, 1], [homo.hojas, homo.imagenes.length]);

    for (const [nombre, img, ancho, alto] of [
      ['muy ancho (2000 × 40)', png(2000, 40, () => MAGENTA), 2000, 40],
      ['muy alto (200 × 2000)', png(200, 2000, () => MAGENTA), 200, 2000],
      ['cuadrado (500 × 500)', png(500, 500, () => MAGENTA), 500, 500],
    ]) {
      await api(tokA, 'PUT', rutaA, { archivo: img });
      const g = await generar(invA(tres), tres);
      const v = dondeQuedoElMagenta(g.buf, `forma-${ancho}x${alto}`);
      chk(`un logo ${nombre}: una hoja, adentro de su caja`, [1, true], [g.hojas, dentro(caja, v)]);
      chk('   sin deformarse', true, Boolean(v) && Math.abs(proporcion(v) - ancho / alto) / (ancho / alto) < 0.15);
    }

    await api(tokA, 'PUT', rutaA, { archivo: JPEG, nombre: 'logo.jpg', tipo: 'image/jpeg' });
    const conJpeg = await generar(invA(tres), tres);
    chk('un JPEG también: una hoja, adentro de su caja', [1, true], [conJpeg.hojas, dentro(caja, dondeQuedoElMagenta(conJpeg.buf, 'jpeg'))]);

    const deLaOtraRazon = await generar(invA(tres, { businessCuitId: cuitA2.id, emisorCuit: '30999777426' }), tres);
    chk('el logo es del CUIT: una factura del otro CUIT del negocio sale con el nombre', [1, true],
      [deLaOtraRazon.imagenes.length, deLaOtraRazon.hay('Marca QA Logo')]);
    const cruzada = await generar(factura(tres, { businessId: negocioB.id, businessCuitId: cuitA.id, emisorCuit: CUIT_B }), tres);
    // El CUIT de A no es de B: se busca el de B por el CUIT emisor, que tiene el suyo.
    const logoDeB = (await BusinessCuit.unscoped().findByPk(cuitB.id)).logo;
    chk('una factura de B que apunta al CUIT de A no se lleva el logo de A, sino el de B', true,
      Boolean(cruzada.contexto.emisor.logo?.datos?.equals(logoDeB)));

    await api(tokA, 'DELETE', rutaA);
    const sinLogo = await generar(invA(tres), tres);
    chk('quitarlo: la factura vuelve a llevar el nombre grande, y sólo el QR', [true, 1, 1],
      [sinLogo.hay('Marca QA Logo'), sinLogo.imagenes.length, sinLogo.hojas]);
    chk('   y verlo da 404', 404, (await api(tokA, 'GET', rutaA)).status);

    tit('8. UN LOGO ROTO EN LA BASE NO TIRA ABAJO NADA');
    /*
     * Lo que pasa si algo llega a la base sin pasar por la subida. Sin la
     * comprobación de facturaPdf, este PNG hace caer el proceso entero al
     * generar la factura (y esta prueba con él).
     */
    for (const [nombre, datos, tipo] of [
      ['un PNG con un filtro que no existe', filtroInvalido, 'image/png'],
      ['un SVG', SVG, 'image/png'],
      ['basura', Buffer.from('nada que ver'), 'image/jpeg'],
    ]) {
      await BusinessCuit.unscoped().update({ logo: datos, logoTipo: tipo }, { where: { id: cuitA.id } });
      const g = await generar(invA(tres), tres);
      await new Promise((ok2) => setTimeout(ok2, 150));     // por si el callback de zlib explota después
      chk(`${nombre}: la factura sale igual, con el nombre, en una hoja`, [1, true, 1], [g.hojas, g.hay('Marca QA Logo'), g.imagenes.length]);
    }
  } finally {
    server.close();
    await limpiar();
    console.log(`\n  La primera hoja con logo, renderizada: ${path.join(TMP, 'para-mirar.png')}`);
    console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
    await db.close().catch(() => {});
    process.exit(ko ? 1 : 0);
  }
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
