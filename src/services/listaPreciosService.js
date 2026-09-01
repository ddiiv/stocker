/*
 * Lista de precios del evento, en PDF e imprimible.
 *
 * Es el papel que se apoya sobre la mesa del puesto. Cumple dos funciones a la
 * vez y por eso tiene la forma que tiene:
 *
 *   · Se LEE: quién atiende necesita ver el precio y, sobre todo, qué colores y
 *     qué talles existen de ese modelo, para saber si vale la pena revolver la
 *     pila o el cliente pide algo que no se trajo.
 *   · Se ESCANEA: cada renglón lleva el código del producto de evento, así que
 *     con el lector apuntado al papel se carga la venta sin buscar la prenda.
 *
 * Eso segundo condiciona todo el diseño. Un código de barras impreso angosto no
 * se lee, y un renglón que no se lee convierte la lista en un adorno.
 */

const PDFDocument = require('pdfkit');
const { Op } = require('sequelize');
const { Product, ProductVariant } = require('../models');
const { __patron: patron, MODULO_MINIMO_MM } = require('./labelService');

// pdfkit trabaja en puntos tipográficos.
const MM = 72 / 25.4;

/*
 * A4 apaisado, y no vertical.
 *
 * En vertical las cinco columnas entran, pero al código de barras le quedan
 * 45 mm y a un SKU largo eso lo deja con módulos de 0,2 mm — abajo del mínimo
 * que la impresora puede resolver, o sea un código que a veces lee y a veces
 * no. Apaisado le sobran 60 mm y el margen de lectura deja de ser un problema.
 *
 * Se paga con hojas: unas once filas por página. Es una lista de precios, no un
 * catálogo; se imprime una vez por evento.
 */
const ANCHO = 297 * MM;
const ALTO  = 210 * MM;
const MARGEN = 12 * MM;

const FILA_ALTO   = 15.5 * MM;
const BARRAS_ALTO = 10 * MM;

/*
 * Las columnas, en milímetros. Suman el ancho útil (273 mm).
 *
 * El título se lleva la parte del león porque es lo que se busca con la vista;
 * el código, lo segundo, porque de su ancho depende que el lector funcione.
 */
const COLUMNAS = [
  { clave: 'titulo',  titulo: 'Producto',   ancho: 78 },
  { clave: 'precio',  titulo: 'Precio',     ancho: 42 },
  { clave: 'var1',    titulo: 'Variante 1', ancho: 45 },
  { clave: 'var2',    titulo: 'Variante 2', ancho: 40 },
  { clave: 'codigo',  titulo: 'Código',     ancho: 68 },
];

const plata = (n) => '$ ' + Math.round(Number(n) || 0).toLocaleString('es-AR');

/*
 * Recorta al ancho disponible en vez de dejar que el texto se monte sobre la
 * columna de al lado. Mejor un nombre incompleto que dos datos pisados.
 */
function recortar(doc, texto, maxAncho) {
  let t = String(texto || '');
  if (doc.widthOfString(t) <= maxAncho) return t;
  while (t.length > 1 && doc.widthOfString(t + '…') > maxAncho) t = t.slice(0, -1);
  return t + '…';
}

/*
 * Los datos de la lista.
 *
 * Una fila por producto de EVENTO —son los que tienen código escaneable— pero
 * las variantes salen de su producto ORIGINAL. Es la vuelta que hace útil a la
 * lista: el de evento no tiene ni color ni talle, por definición, y lo que el
 * vendedor necesita saber es justamente qué colores y qué talles hay en la pila.
 *
 * Un producto de evento cargado a mano no tiene original, así que sus columnas
 * de variante quedan vacías. Se muestra igual: existe, tiene precio y se
 * escanea, que es lo que la lista promete.
 */
/*
 * El orden de los talles no es alfabético.
 *
 * Ordenar con localeCompare da "L, M, S" — que es correcto para una máquina y
 * absurdo para cualquiera que haya visto una pila de ropa. Y "10, 2, 4" para
 * los talles de niño, que es peor todavía porque parece un error de carga.
 *
 * Se ordena por la escala real: primero la de letras, después los números por
 * su valor, y lo que no entra en ninguna —un color, un "Único"— alfabético al
 * final. Así "S, M, L, XL" sale como se lee y "36, 38, 40" también.
 */
const ESCALA = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '2XL', '3XL', '4XL'];

function rango(valor) {
  const t = String(valor || '').trim().toUpperCase();
  const enEscala = ESCALA.indexOf(t);
  if (enEscala !== -1) return { grupo: 0, peso: enEscala, texto: t };
  const numero = Number(t.replace(',', '.'));
  if (Number.isFinite(numero) && t !== '') return { grupo: 1, peso: numero, texto: t };
  return { grupo: 2, peso: 0, texto: t };
}

function ordenarValores(valores) {
  return valores.slice().sort((a, b) => {
    const ra = rango(a), rb = rango(b);
    if (ra.grupo !== rb.grupo) return ra.grupo - rb.grupo;
    if (ra.grupo === 2) return String(a).localeCompare(String(b), 'es');
    return ra.peso - rb.peso;
  });
}

async function datosDeLista(businessId) {
  const deEvento = await Product.findAll({
    where: { businessId, esFeria: true, activo: true },
    order: [['titulo', 'ASC']],
  });
  if (!deEvento.length) return [];

  /*
   * Las variantes de los originales, en UNA consulta.
   *
   * Una por producto convertiría una lista de doscientos modelos en doscientos
   * viajes a la base para imprimir un papel.
   */
  const origenes = [...new Set(deEvento.map((p) => p.origenProductId).filter(Boolean))];
  const variantes = origenes.length
    ? await ProductVariant.findAll({
      where: { productId: { [Op.in]: origenes }, businessId, activo: true },
      attributes: ['productId', 'variante1Nombre', 'variante1Valor', 'variante2Nombre', 'variante2Valor'],
    })
    : [];

  const porOrigen = new Map();
  for (const v of variantes) {
    if (!porOrigen.has(v.productId)) {
      porOrigen.set(v.productId, { n1: null, n2: null, v1: new Set(), v2: new Set() });
    }
    const acc = porOrigen.get(v.productId);
    if (v.variante1Nombre && !acc.n1) acc.n1 = v.variante1Nombre;
    if (v.variante2Nombre && !acc.n2) acc.n2 = v.variante2Nombre;
    if (v.variante1Valor) acc.v1.add(v.variante1Valor);
    if (v.variante2Valor) acc.v2.add(v.variante2Valor);
  }

  return deEvento.map((p) => {
    const acc = porOrigen.get(p.origenProductId) || null;
    const orden = (s) => ordenarValores([...s]);
    return {
      titulo: p.titulo,
      sku: p.sku,
      precioMinorista: Number(p.precioMinorista) || 0,
      precioMayorista: Number(p.precioMayorista) || 0,
      var1Nombre: acc?.n1 || null,
      var1: acc ? orden(acc.v1) : [],
      var2Nombre: acc?.n2 || null,
      var2: acc ? orden(acc.v2) : [],
    };
  });
}

function encabezado(doc, negocio, pagina) {
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#000');
  doc.text(`Lista de precios · Evento`, MARGEN, MARGEN, { lineBreak: false });

  doc.font('Helvetica').fontSize(8).fillColor('#555');
  const sub = [negocio?.nombreNegocio, new Date().toLocaleDateString('es-AR')].filter(Boolean).join(' · ');
  doc.text(sub, MARGEN, MARGEN + 15, { lineBreak: false });
  doc.text(`Página ${pagina}`, ANCHO - MARGEN - 60, MARGEN + 15, { width: 60, align: 'right' });

  // Cabecera de la tabla.
  const y = MARGEN + 32;
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#000');
  let x = MARGEN;
  for (const c of COLUMNAS) {
    doc.text(c.titulo.toUpperCase(), x, y, { width: c.ancho * MM, lineBreak: false });
    x += c.ancho * MM;
  }
  doc.moveTo(MARGEN, y + 11).lineTo(ANCHO - MARGEN, y + 11).lineWidth(0.7).strokeColor('#000').stroke();
  return y + 17;
}

function dibujarFila(doc, fila, y) {
  let x = MARGEN;
  const col = (clave) => COLUMNAS.find((c) => c.clave === clave).ancho * MM;

  // ── Producto ──
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000');
  doc.text(recortar(doc, fila.titulo, col('titulo') - 4), x, y + 2, { lineBreak: false });
  doc.font('Helvetica').fontSize(6.5).fillColor('#666');
  doc.text(fila.sku, x, y + 13, { lineBreak: false });
  x += col('titulo');

  // ── Precios: los dos, porque en el puesto se cobra de las dos formas ──
  doc.font('Helvetica').fontSize(7.5).fillColor('#000');
  doc.text(`Mayorista  ${plata(fila.precioMayorista)}`, x, y + 2, { lineBreak: false });
  doc.text(`Minorista  ${plata(fila.precioMinorista)}`, x, y + 11, { lineBreak: false });
  x += col('precio');

  // ── Variantes del producto original ──
  const listar = (nombre, valores, ancho) => {
    doc.font('Helvetica-Bold').fontSize(6.2).fillColor('#666');
    doc.text((nombre || '—').toUpperCase(), x, y + 2, { lineBreak: false });
    doc.font('Helvetica').fontSize(7).fillColor('#000');
    const texto = valores.length ? valores.join(', ') : '—';
    /*
     * Dos renglones como máximo. Un modelo con quince colores desbordaría la
     * fila y se comería la de abajo; con dos alcanza para el caso normal y lo
     * que sobra se corta con puntos suspensivos, que es una señal honesta de
     * que hay más.
     */
    doc.text(texto, x, y + 10, { width: ancho - 4, height: 16, ellipsis: true, lineGap: -1 });
  };
  listar(fila.var1Nombre, fila.var1, col('var1'));
  x += col('var1');
  listar(fila.var2Nombre, fila.var2, col('var2'));
  x += col('var2');

  // ── Código de barras, en vectores ──
  /*
   * Se dibuja con rectángulos y no como imagen, por la misma razón que las
   * etiquetas: rasterizado, el redondeo de píxeles ensancha unas barras y
   * angosta otras, y el lector empieza a fallar de a ratos — que es peor que
   * fallar siempre, porque nadie sabe por qué.
   */
  const { anchos, modulos } = patron(fila.sku);
  const anchoBarras = col('codigo') - 6 * MM;
  const modulo = anchoBarras / modulos;
  let bx = x + 2 * MM;
  doc.fillColor('#000');
  for (let i = 0; i < anchos.length; i++) {
    const w = anchos[i] * modulo;
    if (i % 2 === 0) doc.rect(bx, y + 1, w, BARRAS_ALTO).fill();
    bx += w;
  }
  doc.font('Helvetica').fontSize(6).fillColor('#000');
  doc.text(fila.sku, x, y + BARRAS_ALTO + 3, { width: col('codigo'), align: 'center', lineBreak: false });

  return modulo / MM;   // ancho de módulo en mm, para poder avisar si quedó fino
}

/**
 * Genera el PDF de la lista de precios del evento.
 *
 * @returns {Promise<{buffer: Buffer, filas: number, avisos: string[]}>}
 */
async function generarListaPrecios(businessId, negocio = null) {
  const filas = await datosDeLista(businessId);

  const doc = new PDFDocument({ size: [ANCHO, ALTO], margin: 0 });
  const trozos = [];
  doc.on('data', (d) => trozos.push(d));
  const listo = new Promise((res) => doc.on('end', res));

  const avisos = [];

  if (!filas.length) {
    encabezado(doc, negocio, 1);
    doc.font('Helvetica').fontSize(10).fillColor('#555');
    doc.text('Todavía no hay productos de evento. Se generan o se cargan desde la sección Evento.',
      MARGEN, MARGEN + 60, { lineBreak: false });
  } else {
    let pagina = 1;
    let y = encabezado(doc, negocio, pagina);
    /*
     * El módulo más angosto de todo el documento.
     *
     * Se avisa una sola vez y con el peor caso: si el SKU más largo quedó por
     * debajo del mínimo que resuelve la impresora, ESE es el que va a fallar, y
     * enterarse en el puesto con gente esperando es tarde.
     */
    let moduloMinimo = Infinity;

    for (const fila of filas) {
      if (y + FILA_ALTO > ALTO - MARGEN) {
        doc.addPage({ size: [ANCHO, ALTO], margin: 0 });
        pagina += 1;
        y = encabezado(doc, negocio, pagina);
      }
      const mm = dibujarFila(doc, fila, y);
      if (mm < moduloMinimo) moduloMinimo = mm;

      y += FILA_ALTO;
      doc.moveTo(MARGEN, y - 3).lineTo(ANCHO - MARGEN, y - 3)
        .lineWidth(0.3).strokeColor('#ccc').stroke();
    }

    if (moduloMinimo < MODULO_MINIMO_MM) {
      avisos.push(
        `Algún código quedó con barras de ${moduloMinimo.toFixed(3)} mm, por debajo de los `
        + `${MODULO_MINIMO_MM} mm que resuelve una impresora térmica. Puede costar leerlo: `
        + 'conviene acortar el prefijo o el código de esos productos.',
      );
    }
  }

  doc.end();
  await listo;
  return { buffer: Buffer.concat(trozos), filas: filas.length, avisos };
}

module.exports = { generarListaPrecios, __datosDeLista: datosDeLista, __ordenarValores: ordenarValores };
