/*
 * ══ El logo que sale en la factura ═══════════════════════════════════
 *
 * Qué se acepta y cómo se comprueba. Lo usan dos lados: la subida (el dueño
 * elige un archivo en la pantalla de CUIT) y el PDF (que lo vuelve a mirar
 * antes de dibujarlo).
 *
 * SÓLO PNG o JPEG. Nunca SVG: un SVG es un documento, puede traer código
 * adentro, y la pantalla lo muestra en el navegador. El tipo se decide por los
 * primeros bytes del archivo (la firma), no por la extensión ni por lo que
 * diga el navegador: esas dos cosas las escribe quien sube el archivo.
 *
 * Que la firma diga PNG no alcanza. El PNG lo decodifica PDFKit recién al
 * armar la factura, y lo hace en un callback de zlib que, si los datos están
 * rotos, TIRA LA EXCEPCIÓN FUERA DE TODO try: se cae el proceso entero, no la
 * descarga. Por eso el PNG se lee entero acá —estructura, descompresión con
 * tope y decodificación, que verifica el CRC de cada bloque— y lo que se
 * guarda no es el archivo que llegó sino uno rearmado (8 bits, sin
 * entrelazar, sin bloques de texto ni metadatos). El lector de PDFKit tiene además errores conocidos con
 * la transparencia de algunos PNG (paletas de menos de 8 bits, transparencia
 * por color clave en RGB) que con el rearmado no se presentan nunca.
 *
 * El JPEG PDFKit no lo decodifica: lo copia tal cual al PDF. Alcanza con que
 * la estructura sea la de un JPEG que un visor de PDF sabe mostrar.
 */

const zlib = require('zlib');
const PDFDocument = require('pdfkit');
const { PNG } = require('pngjs');

// Lo que el dueño puede subir: 300 KB. Un logo para imprimir a 6 cm de ancho
// entra holgado; más que eso es una foto, y viaja en cada factura que se baja.
const LOGO_MAX_BYTES = 300 * 1024;
/*
 * Píxeles por lado. En la factura el logo ocupa a lo sumo unos 9 × 1,6 cm: con
 * 2000 px sobra para imprimirlo nítido. El tope está para que un archivo chico
 * no se convierta en una imagen enorme al descomprimirla —un PNG de 300 KB
 * puede decir que mide 50.000 × 50.000—, que es memoria que se pide en cada
 * factura.
 */
const LOGO_MAX_LADO = 2000;
/*
 * Lo que se guarda puede pesar más que lo que se subió: el rearmado pasa una
 * paleta de colores a color con transparencia. Esto es el techo de lo que se
 * acepta guardar, para que una imagen que comprime mal no termine siendo un
 * megabyte en cada lectura del CUIT para facturar.
 */
const LOGO_MAX_GUARDADO = 1024 * 1024;

const TIPOS = { png: 'image/png', jpeg: 'image/jpeg' };

const FIRMA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function errorLogo(codigo, message, status = 400) {
  return Object.assign(new Error(message), { status, codigo, detalles: { codigo } });
}

const danado = (formato) => errorLogo('LOGO_DANADO',
  `El archivo dice ser ${formato} pero no se puede leer: puede estar dañado o ser otro tipo de archivo con el nombre cambiado. Volvé a exportarlo desde el programa en que lo hiciste.`);

/* Qué es el archivo según sus primeros bytes. Nada más los mira a ellos. */
function tipoPorFirma(datos) {
  if (!Buffer.isBuffer(datos) || datos.length < 8) return null;
  if (datos.subarray(0, 8).equals(FIRMA_PNG)) return 'png';
  if (datos[0] === 0xff && datos[1] === 0xd8 && datos[2] === 0xff) return 'jpeg';
  return null;
}

/*
 * Un SVG (o cualquier XML) empieza con "<", a veces después de espacios o de
 * la marca de UTF-8. Sólo sirve para dar un mensaje más claro: el rechazo es
 * por no tener la firma de PNG ni de JPEG.
 */
function pareceSvg(datos) {
  const inicio = datos.subarray(0, 512).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  return inicio.startsWith('<') && (inicio.includes('<svg') || inicio.startsWith('<?xml'));
}

function exigirMedidas(ancho, alto, formato) {
  if (!ancho || !alto) throw danado(formato);
  if (ancho > LOGO_MAX_LADO || alto > LOGO_MAX_LADO) {
    throw errorLogo('LOGO_MEDIDAS',
      `El logo mide ${ancho} × ${alto} píxeles y el máximo es ${LOGO_MAX_LADO} de cada lado. `
      + 'Exportalo más chico: para la factura, con 1000 píxeles de ancho alcanza.');
  }
}

// ── PNG ──────────────────────────────────────────────────────────────

// Canales por tipo de color y las profundidades que el estándar admite para cada uno.
const CANALES = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const PROFUNDIDADES = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
// Las siete pasadas del entrelazado Adam7: [x0, y0, paso x, paso y].
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

/*
 * Cuántos bytes TIENE que dar la descompresión: cada fila lleva un byte de
 * filtro adelante y los píxeles empaquetados. Con entrelazado, lo mismo por
 * cada una de las siete subimágenes que no quede vacía.
 */
function bytesEsperados({ ancho, alto, bits, color, entrelazado }) {
  const bitsPorPixel = bits * CANALES[color];
  const fila = (w) => 1 + Math.ceil((w * bitsPorPixel) / 8);
  if (!entrelazado) return alto * fila(ancho);
  return ADAM7.reduce((total, [x0, y0, dx, dy]) => {
    const w = ancho > x0 ? Math.ceil((ancho - x0) / dx) : 0;
    const h = alto > y0 ? Math.ceil((alto - y0) / dy) : 0;
    return w && h ? total + h * fila(w) : total;
  }, 0);
}

/*
 * Recorre los bloques del PNG y los exige EN ORDEN, sin repetir los críticos.
 *
 * El estándar fija un único orden: IHDR primero y una sola vez, después (si
 * hay) una sola PLTE, después uno o más IDAT TODOS SEGUIDOS, y IEND al final,
 * sin nada atrás. No alcanza con leer el primer IHDR y seguir: un archivo con
 * DOS IHDR era el agujero. Nuestro validador se quedaba con el PRIMERO (con
 * el que calcula cuántos bytes tienen que salir de la descompresión), pero
 * tanto pngjs como el lector de PDFKit se quedan con el ÚLTIMO. Con el primero
 * chico (gris) y el segundo grande (RGBA), la descompresión da menos datos de
 * los que el segundo espera y pngjs completa el resto con memoria sin
 * inicializar del proceso —tokens, claves o datos de otros negocios—, que
 * terminaba guardada como logo y impresa en las facturas. Comprobado: el mismo
 * archivo de 95 bytes se aceptaba ~1 de cada 3 veces, cada vez con otros bytes.
 * Por eso: un solo IHDR, un solo orden, y después se compara lo que leyó cada
 * lector contra ESTE IHDR, no sólo las medidas.
 */
function leerPng(datos) {
  let pos = 8;
  let ihdr = null;
  let paleta = false;
  let fin = false;
  let idatAbierto = false;   // ya empezaron los IDAT (van todos seguidos)
  let idatCerrado = false;   // y después vino otro bloque: no pueden volver
  const idat = [];
  while (pos + 12 <= datos.length) {
    const largo = datos.readUInt32BE(pos);
    if (largo > datos.length - pos - 12) throw danado('PNG');
    const tipo = datos.toString('latin1', pos + 4, pos + 8);
    const cuerpo = datos.subarray(pos + 8, pos + 8 + largo);
    if (!ihdr) {
      // El primer bloque TIENE que ser IHDR, de 13 bytes.
      if (tipo !== 'IHDR' || largo !== 13) throw danado('PNG');
      ihdr = {
        ancho: cuerpo.readUInt32BE(0), alto: cuerpo.readUInt32BE(4),
        bits: cuerpo[8], color: cuerpo[9], compresion: cuerpo[10], filtro: cuerpo[11], entrelazado: cuerpo[12],
      };
    } else if (tipo === 'IHDR') {
      // Un segundo IHDR es el agujero descrito arriba.
      throw danado('PNG');
    } else if (tipo === 'PLTE') {
      // Una sola paleta, antes de los datos, y sólo en los tipos que la
      // admiten (indexado la exige; color verdadero la permite; gris no).
      if (paleta || idatAbierto || ![2, 3, 6].includes(ihdr.color)) throw danado('PNG');
      paleta = true;
    } else if (tipo === 'IDAT') {
      // Los IDAT van todos seguidos: si ya se cortaron, no pueden reaparecer.
      if (idatCerrado) throw danado('PNG');
      idatAbierto = true;
      idat.push(cuerpo);
    } else if (tipo === 'IEND') {
      // IEND cierra el archivo: sin cuerpo y sin nada después.
      if (largo !== 0) throw danado('PNG');
      fin = true;
      pos += 12 + largo;
      break;
    } else {
      // Cualquier otro bloque (texto, gamma, etc.) corta la racha de IDAT.
      if (idatAbierto) idatCerrado = true;
    }
    pos += 12 + largo;
  }
  // Tiene que haber terminado en IEND y no quedar ni un byte atrás.
  if (!ihdr || !fin || !idat.length || pos !== datos.length) throw danado('PNG');
  if (!PROFUNDIDADES[ihdr.color]?.includes(ihdr.bits) || ihdr.compresion !== 0 || ihdr.filtro !== 0
      || ihdr.entrelazado > 1 || (ihdr.color === 3 && !paleta)) {
    throw danado('PNG');
  }
  exigirMedidas(ihdr.ancho, ihdr.alto, 'PNG');

  /*
   * La descompresión, con tope. Antes de dársela a nadie: un PNG chico puede
   * descomprimirse en cientos de megas (la "bomba" de zlib), y el lector de
   * PNG que se usa abajo no pone tope cuando la imagen está entrelazada. Y
   * tiene que dar el tamaño EXACTO que dicen las medidas: con menos datos,
   * ese lector completa la imagen con memoria sin inicializar del servidor
   * (lo comprobó la prueba: a veces la acepta, a veces no), y eso terminaría
   * guardado en el logo rearmado.
   */
  const esperado = bytesEsperados(ihdr);
  let crudo;
  try {
    crudo = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: esperado });
  } catch {
    throw danado('PNG');
  }
  if (crudo.length !== esperado) throw danado('PNG');

  // La decodificación entera: el CRC de cada bloque, los filtros de cada
  // fila, la paleta y la transparencia.
  let png;
  try {
    png = PNG.sync.read(datos);
  } catch {
    throw danado('PNG');
  }
  /*
   * Lo que pngjs entendió tiene que ser EXACTAMENTE nuestro IHDR, no sólo las
   * medidas: si difiere la profundidad, el tipo de color o el entrelazado, los
   * dos lectores no están viendo la misma imagen y los píxeles no son de fiar.
   * Y el buffer de píxeles tiene que medir lo que tiene que medir: así ningún
   * byte del rearmado sale de otro lado que no sea decodificar este archivo.
   */
  if (png.width !== ihdr.ancho || png.height !== ihdr.alto
      || png.depth !== ihdr.bits || png.colorType !== ihdr.color
      || png.interlace !== Boolean(ihdr.entrelazado)
      || png.data.length !== ihdr.ancho * ihdr.alto * 4) {
    throw danado('PNG');
  }
  return {
    formato: 'png', ancho: ihdr.ancho, alto: ihdr.alto,
    bits: ihdr.bits, color: ihdr.color, entrelazado: ihdr.entrelazado, rgba: png.data,
  };
}

// ── JPEG ─────────────────────────────────────────────────────────────

/*
 * Los marcadores que abren un cuadro (SOF). De todos, un PDF sabe mostrar el
 * JPEG común (C0), el secuencial extendido (C1) y el progresivo (C2); el sin
 * pérdida y el aritmético no los muestra ningún visor de PDF, y la factura
 * saldría con un recuadro vacío o con error.
 */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const SOF_IMPRIMIBLE = new Set([0xc0, 0xc1, 0xc2]);

function leerJpeg(datos) {
  let pos = 2;
  while (pos + 4 <= datos.length) {
    if (datos[pos] !== 0xff) throw danado('JPG');
    const marca = datos[pos + 1];
    if (marca === 0xff) { pos += 1; continue; }            // bytes de relleno
    pos += 2;
    if (marca === 0x01 || (marca >= 0xd0 && marca <= 0xd7)) continue; // marcadores sin largo
    // Otro inicio, el fin o los datos de la imagen antes de saber sus medidas: no es un JPEG.
    if (marca === 0xd8 || marca === 0xd9 || marca === 0xda) throw danado('JPG');
    const largo = datos.readUInt16BE(pos);
    if (largo < 2 || pos + largo > datos.length) throw danado('JPG');
    if (SOF.has(marca)) {
      if (largo < 8) throw danado('JPG');
      const bits = datos[pos + 2];
      const alto = datos.readUInt16BE(pos + 3);
      const ancho = datos.readUInt16BE(pos + 5);
      const componentes = datos[pos + 7];
      if (!SOF_IMPRIMIBLE.has(marca) || bits !== 8 || ![1, 3, 4].includes(componentes)) {
        throw errorLogo('LOGO_NO_SOPORTADO',
          'Ese JPG está guardado en una variante que no se puede imprimir en la factura. '
          + 'Exportalo de nuevo como JPG común, o mejor como PNG.');
      }
      exigirMedidas(ancho, alto, 'JPG');
      return { formato: 'jpeg', ancho, alto };
    }
    pos += largo;
  }
  throw danado('JPG');
}

/*
 * Que PDFKit lo abra y vea lo mismo. Es él quien lo mete en el PDF, y su
 * lector de JPEG es más simple que el de arriba: si entendiera otras medidas,
 * lo que se imprime no sería lo que se comprobó. Abrir es sólo leer la
 * cabecera; no dibuja nada.
 */
function exigirQuePdfkitLoLea(datos, leido) {
  const formato = leido.formato === 'png' ? 'PNG' : 'JPG';
  let img;
  try {
    img = new PDFDocument({ autoFirstPage: false }).openImage(datos);
  } catch {
    throw danado(formato);
  }
  if (img.width !== leido.ancho || img.height !== leido.alto) throw danado(formato);
  /*
   * Para el PNG, además de las medidas: que el lector de PDFKit (png-js) haya
   * leído la MISMA profundidad, tipo de color y entrelazado que nosotros. Es
   * el mismo motivo que arriba —si los lectores divergen, lo impreso no es lo
   * que se comprobó— y cierra cualquier variante del agujero del doble IHDR
   * que se nos escape: png-js también se queda con el último IHDR.
   */
  if (leido.formato === 'png'
      && (img.image.bits !== leido.bits || img.image.colorType !== leido.color
        || img.image.interlaceMethod !== leido.entrelazado)) {
    throw danado('PNG');
  }
}

/*
 * Lee y comprueba un logo. Devuelve { formato, tipo, ancho, alto } —y, para un
 * PNG, los píxeles— o tira un error con `status` y `codigo` que el controlador
 * contesta tal cual.
 *
 * `maxBytes` es el tope de lo que se SUBE. Al leer lo ya guardado (para la
 * factura) se pasa el de lo guardado, que es otro: ver LOGO_MAX_GUARDADO.
 */
function leerLogo(datos, { maxBytes = LOGO_MAX_BYTES } = {}) {
  if (!Buffer.isBuffer(datos) || !datos.length) {
    throw errorLogo('LOGO_FALTA', 'No llegó ningún archivo. Elegí la imagen del logo.');
  }
  if (datos.length > maxBytes) {
    throw errorLogo('LOGO_PESADO',
      `El logo pesa ${Math.ceil(datos.length / 1024)} KB y el máximo es ${Math.round(maxBytes / 1024)} KB. `
      + 'Exportalo más chico o como JPG.', 413);
  }
  const formato = tipoPorFirma(datos);
  if (!formato) {
    throw pareceSvg(datos)
      ? errorLogo('LOGO_FORMATO',
        'Los logos en SVG no se aceptan: un SVG puede llevar código adentro. Exportalo como PNG (mejor con fondo transparente) o como JPG.')
      : errorLogo('LOGO_FORMATO',
        'El logo tiene que ser una imagen PNG o JPG. Otros formatos (SVG, WebP, GIF, PDF) no se aceptan, aunque el archivo se llame .png.');
  }
  const leido = formato === 'png' ? leerPng(datos) : leerJpeg(datos);
  exigirQuePdfkitLoLea(datos, leido);
  return { ...leido, tipo: TIPOS[formato] };
}

/*
 * Lo que se guarda en la base a partir de lo que se subió.
 *
 * El PNG se rearma desde los píxeles: sin color de 16 bits, sin entrelazado,
 * sin paleta y sin ningún bloque que no sea imagen. Si no tiene ni un píxel
 * transparente se guarda sin canal de transparencia: así PDFKit lo copia al
 * PDF sin tener que decodificarlo en cada factura. El JPEG se guarda tal cual.
 */
function prepararLogo(datos) {
  const leido = leerLogo(datos);
  if (leido.formato === 'jpeg') {
    return { datos, tipo: leido.tipo, ancho: leido.ancho, alto: leido.alto };
  }
  const { rgba, ancho, alto } = leido;
  let opaco = true;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) { opaco = false; break; }
  }
  const rearmado = PNG.sync.write({ width: ancho, height: alto, data: rgba }, { colorType: opaco ? 2 : 6 });
  if (rearmado.length > LOGO_MAX_GUARDADO) {
    throw errorLogo('LOGO_MEDIDAS',
      'El logo tiene demasiado detalle para sus medidas. Exportalo con menos píxeles (con 1000 de ancho alcanza) o como JPG.');
  }
  return { datos: rearmado, tipo: leido.tipo, ancho, alto };
}

module.exports = {
  leerLogo,
  prepararLogo,
  tipoPorFirma,
  LOGO_MAX_BYTES,
  LOGO_MAX_LADO,
  LOGO_MAX_GUARDADO,
  // Para las pruebas.
  __bytesEsperados: bytesEsperados,
};
