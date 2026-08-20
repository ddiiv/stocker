/*
 * Etiquetas de góndola en PDF, una por página de 50 × 25 mm.
 *
 * El tamaño no es decorativo: es el de los rollos de etiquetas térmicas que usa
 * la impresora, y cada etiqueta tiene que ser su propia página para que el
 * cabezal corte donde corresponde. Un PDF A4 con etiquetas acomodadas en grilla
 * sirve para tijera, no para una impresora de etiquetas.
 *
 * El código de barras se dibuja con rectángulos, no como imagen. Una etiqueta
 * de 5 cm tiene barras de menos de medio milímetro: rasterizada, el redondeo de
 * píxeles ensancha unas y angosta otras, y el lector empieza a fallar de a
 * ratos — que es peor que fallar siempre, porque nadie sabe por qué. En
 * vectores, la impresora resuelve cada barra a su máxima resolución.
 */

const PDFDocument = require('pdfkit');
const bwip = require('bwip-js');

// pdfkit trabaja en puntos tipográficos.
const MM = 72 / 25.4;

const ANCHO = 50 * MM;
const ALTO  = 25 * MM;
const PAD   = 1.6 * MM;

/*
 * Geometría interna, en milímetros desde el borde.
 *
 * Los tres bloques —encabezado, barras, código— están medidos sobre las
 * etiquetas que ya se venían imprimiendo, para que un rollo nuevo salga igual
 * que los anteriores y no haya que reconfigurar la impresora.
 */
/*
 * Medidas tomadas de las etiquetas que este negocio ya imprime, en milímetros
 * desde el borde superior. No llevan línea divisoria: las originales no la
 * tienen.
 *
 * Las barras miden 13,7 mm de alto. La altura importa tanto como el ancho del
 * módulo: un código bajo obliga a apuntar con el lector justo, y en una góndola
 * se escanea de apuro y en ángulo.
 */
const CABECERA_Y   = 2.7;
const BARRAS_Y     = 7.8;
const BARRAS_ALTO  = 13.7;
const CODIGO_Y     = 23.0;

/*
 * Margen a los lados del código de barras, en milímetros.
 *
 * Es más angosto que el del texto a propósito: el código usa casi todo el
 * ancho de la etiqueta, y esa es la única variable que hace que se pueda leer.
 *
 * Un SKU de quince caracteres son 200 módulos. En 47,6 mm cada módulo mide
 * 0,24 mm, que a los 203 dpi de una impresora térmica son 1,9 puntos. Si se le
 * roba ancho al símbolo —por ejemplo reservando aparte los 10 módulos de zona
 * muda que pide la norma— el módulo baja a 1,7 puntos, el redondeo de la
 * impresora ensancha unas barras y angosta otras, y el lector deja de
 * reconocerlo. Medido: con margen de 1,6 mm más zona muda aparte, de cuatro
 * etiquetas se leyó una; con este margen, las cuatro.
 *
 * El blanco que queda a los lados hace de zona muda. Son menos de los 10
 * módulos del estándar, pero es la geometría de las etiquetas que este negocio
 * viene imprimiendo y escaneando sin problemas, y prevalece lo que funciona
 * sobre lo que dice el papel.
 */
const MARGEN_BARRAS = 1.2;

/*
 * El patrón de barras de un Code 128.
 *
 * `sbs` alterna ancho de barra y ancho de espacio, en módulos, empezando por
 * barra. Se pide una sola vez por código y se dibuja a la escala que entre en
 * la etiqueta.
 */
function patron(texto) {
  const [salida] = bwip.raw({ bcid: 'code128', text: String(texto) });
  const anchos = String(salida.sbs).split(',').map(Number);
  return { anchos, modulos: anchos.reduce((a, b) => a + b, 0) };
}

/*
 * Recorta un texto al ancho disponible.
 *
 * Sin esto, un título largo se monta sobre el talle y las dos cosas quedan
 * ilegibles. Se corta con puntos suspensivos: mejor un nombre incompleto que
 * dos datos pisados.
 */
function recortar(doc, texto, maxAncho) {
  let t = String(texto || '');
  if (doc.widthOfString(t) <= maxAncho) return t;
  while (t.length > 1 && doc.widthOfString(`${t}…`) > maxAncho) t = t.slice(0, -1);
  return `${t}…`;
}

/*
 * Arma el encabezado sacrificando el nombre, nunca el color.
 *
 * Recortando la cadena entera se pierde lo último, que es el color — y en una
 * percha el color es lo que se busca; el nombre completo ya se ve en la prenda.
 * Con un producto sin modelo cargado el título es largo y el resultado era
 * "Buzo Canguro Oversize  Buzos  B…", justo el dato que hacía falta.
 *
 * Así que se acorta el nombre hasta que entren categoría y color enteros, y
 * sólo si aun con el nombre en su mínimo no alcanza, se recorta el resto.
 */
function armarEncabezado(doc, partes, maxAncho) {
  const [nombre, ...resto] = partes.filter(Boolean);
  if (!nombre) return '';

  const cola = resto.join('  ');
  const completo = cola ? `${nombre}  ${cola}` : nombre;
  if (doc.widthOfString(completo) <= maxAncho) return completo;

  // El nombre cede hasta un mínimo legible; menos que eso no identifica nada.
  const MINIMO = 6;
  let corto = nombre;
  while (corto.length > MINIMO) {
    corto = corto.slice(0, -1);
    const intento = cola ? `${corto}…  ${cola}` : `${corto}…`;
    if (doc.widthOfString(intento) <= maxAncho) return intento;
  }

  // Ni así entra: se recorta todo junto, que es lo último que queda.
  return recortar(doc, completo, maxAncho);
}

/*
 * Dibuja una etiqueta en la página actual.
 *
 * `etiqueta` = { encabezado, talle, codigo }. El código es lo que va en las
 * barras y, debajo, en texto: se imprimen los dos para que un operario pueda
 * tipearlo a mano cuando la etiqueta se raya o se despega.
 */
function dibujar(doc, { encabezado, talle, codigo }) {
  const izq = PAD;
  const der = ANCHO - PAD;
  const util = der - izq;

  // ── Encabezado: descripción a la izquierda, talle a la derecha ──
  doc.font('Helvetica-Bold').fontSize(7);
  const anchoTalle = talle ? doc.widthOfString(talle) : 0;
  if (talle) {
    doc.fontSize(11).text(talle, der - doc.widthOfString(talle), CABECERA_Y * MM, { lineBreak: false });
  }

  doc.font('Helvetica-Bold').fontSize(6.6);
  const espacioTexto = util - (talle ? doc.fontSize(11).widthOfString(talle) + 3 * MM : 0);
  doc.fontSize(6.6);
  doc.text(armarEncabezado(doc, encabezado, espacioTexto), izq, (CABECERA_Y + 0.9) * MM, { lineBreak: false });

  // ── Barras ──
  const { anchos, modulos } = patron(codigo);
  // Todo el ancho disponible para el símbolo: es lo que da el módulo más ancho
  // y, con eso, la lectura más tolerante.
  const izqBarras = MARGEN_BARRAS * MM;
  const anchoBarras = ANCHO - 2 * izqBarras;
  const modulo = anchoBarras / modulos;
  let x = izqBarras;
  doc.fillColor('#000');
  for (let i = 0; i < anchos.length; i++) {
    const w = anchos[i] * modulo;
    // Índices pares = barra; impares = espacio.
    if (i % 2 === 0) doc.rect(x, BARRAS_Y * MM, w, BARRAS_ALTO * MM).fill();
    x += w;
  }

  // ── El código en texto, centrado ──
  doc.font('Helvetica').fontSize(5.6).fillColor('#000');
  const anchoCodigo = doc.widthOfString(codigo);
  doc.text(codigo, izq + (util - anchoCodigo) / 2, CODIGO_Y * MM, { lineBreak: false });
}

/*
 * Arma el encabezado de una variante: modelo, categoría y color.
 *
 * `modelo` va primero porque es lo que identifica la prenda de un vistazo en la
 * góndola; si el producto no tiene modelo cargado se usa el título, que siempre
 * está.
 */
function encabezadoDe(producto, variante) {
  return [
    producto.modelo || producto.titulo,
    producto.categoria,
    variante.variante1Valor,
  ].filter(Boolean);
}

const TOPE = 5000;

/*
 * Ancho mínimo de módulo, en milímetros.
 *
 * Una impresora térmica de 203 dpi imprime en puntos de 0,125 mm. Un módulo de
 * 0,225 mm son 1,8 puntos: el piso a partir del cual el redondeo del cabezal
 * todavía deja barras distinguibles.
 *
 * El número no es teórico. Se generaron etiquetas con SKU de 10 a 26
 * caracteres, se rasterizaron a 203 dpi y se leyeron con un decodificador real:
 * hasta 16 caracteres (1,80 puntos por módulo) leen siempre; de 17 en adelante
 * dejan de leer. Uno de 20 leyó de casualidad por cómo cayeron los píxeles, y
 * es justamente el caso que no hay que tomar por bueno.
 */
const MODULO_MINIMO_MM = 0.225;

/*
 * Los códigos que no entran legibles en 50 mm.
 *
 * Se devuelven para frenar la generación en vez de imprimirlos igual. Una
 * etiqueta ilegible no se descubre al imprimirla: se descubre semanas después,
 * en la caja, con la prenda ya en la góndola y el cliente esperando.
 */
function codigosDemasiadoLargos(items) {
  const anchoBarras = ANCHO - 2 * MARGEN_BARRAS * MM;
  const vistos = new Map();
  for (const { variante } of items) {
    const codigo = variante.codigoBarras || variante.sku;
    if (vistos.has(codigo)) continue;
    const { modulos } = patron(codigo);
    const moduloMm = (anchoBarras / modulos) / MM;
    if (moduloMm < MODULO_MINIMO_MM) vistos.set(codigo, moduloMm);
  }
  return [...vistos.keys()];
}

/**
 * PDF con las etiquetas pedidas.
 *
 * `items` = [{ producto, variante, cantidad }]. Cada variante se repite tantas
 * veces como diga `cantidad`, que es lo que permite imprimir "una etiqueta por
 * unidad en stock" sin que el llamador tenga que duplicar filas.
 */
function generarEtiquetas(items) {
  const total = items.reduce((s, i) => s + Math.max(0, Number(i.cantidad) || 0), 0);
  if (total === 0) {
    const err = new Error('No hay ninguna etiqueta para generar: todas las cantidades están en cero.');
    err.status = 400;
    throw err;
  }
  if (total > TOPE) {
    // Un tope alto pero real: 5000 páginas ya son varios rollos y una espera
    // larga. Es mejor decirlo que fabricar un PDF que nadie va a poder imprimir.
    const err = new Error(`Son ${total} etiquetas y el máximo por PDF es ${TOPE}. Generá el lote en partes.`);
    err.status = 400;
    throw err;
  }

  const largos = codigosDemasiadoLargos(items.filter((i) => Number(i.cantidad) > 0));
  if (largos.length) {
    const err = new Error(
      `${largos.length} código(s) no entran legibles en una etiqueta de 50 mm: ${largos.slice(0, 5).join(', ')}`
      + `${largos.length > 5 ? '…' : ''}. Máximo 16 caracteres. `
      + `Acortalos desde Stock → Confección de SKU y volvé a generar.`
    );
    err.status = 400;
    err.codigos = largos;
    throw err;
  }

  const doc = new PDFDocument({ size: [ANCHO, ALTO], margin: 0, autoFirstPage: false });

  for (const { producto, variante, cantidad } of items) {
    const n = Math.max(0, Number(cantidad) || 0);
    if (!n) continue;
    const etiqueta = {
      encabezado: encabezadoDe(producto, variante),
      talle: variante.variante2Valor || null,
      // Si la variante tiene código propio se imprime ése: es el que va a leer
      // el escáner. Sin código, el SKU, que el lector también resuelve.
      codigo: variante.codigoBarras || variante.sku,
    };
    for (let i = 0; i < n; i++) {
      doc.addPage({ size: [ANCHO, ALTO], margin: 0 });
      dibujar(doc, etiqueta);
    }
  }

  return { doc, total };
}

module.exports = {
  generarEtiquetas, MM, ANCHO, ALTO, MODULO_MINIMO_MM,
  __patron: patron, __encabezadoDe: encabezadoDe, __codigosDemasiadoLargos: codigosDemasiadoLargos,
};
