/*
 * ══ La representación impresa de la factura ═══════════════════════
 *
 * UNA sola implementación del comprobante. Antes había dos —una que escribía
 * el archivo y otra que armaba el buffer que se descarga y se manda por mail—
 * y cada cambio tocaba una y se olvidaba la otra: pasó con la leyenda de la
 * Ley 27.743, que la prueba cazó de casualidad. Ahora el archivo es el buffer
 * escrito a disco, y lo que se dibuja se dibuja acá y en ningún otro lado.
 *
 * El diseño copia el de una factura electrónica de un gran emisor (Farmacity)
 * que el dueño eligió como modelo: es el formato que la gente ya reconoce como
 * "una factura de verdad". Las medidas salen de ese PDF —mismo marco, misma
 * franja de ORIGINAL, misma tabla— y las fuentes son las mismas Helvetica.
 *
 * Lo que este archivo NO decide son los números fiscales: el neto, el IVA, el
 * total, la fecha y el receptor son los que se le declararon a ARCA y vienen
 * guardados en la factura. Acá sólo se los dice.
 */

const PDFDocument = require('pdfkit');
const bwip = require('bwip-js');
const {
  CBTE_TIPO, ALICUOTA_IVA, CONDICIONES_IVA_RECEPTOR, condicionIvaReceptorId, docTipoFromCliente,
} = require('./arcaService');
const { ddmmaaaa, isoDia, ddmmaaaaArgentina, isoArgentina } = require('../utils/fechaFiscal');
const { log } = require('../utils/logger');

// ── Medidas y colores del modelo (A4, en puntos, origen arriba a la izquierda) ─
const AZUL_CLARO = '#D2E4F5';
const AZUL = '#81BEF7';
const NEGRO = '#000000';
const GRIS = '#444444';
const ROJO = '#b3432d';
const ROJO_FONDO = '#f8e9e4';

const MARCO = { x0: 11.83, x1: 583.17, arriba: 36, abajo: 806 };
const INTERIOR = { x0: 18.19, x1: 576.8 };
const TABLA = { x0: 20.34, x1: 574.66 };
const CLIENTE = { x0: 23.19, xDer: 299.5, anchoIzq: 268, anchoDer: 272 };

/*
 * Hasta dónde puede bajar el detalle en una hoja que sigue: deja lugar para el
 * "continúa" y el número de hoja adentro del marco.
 */
const LIMITE_DETALLE = 784;
// Hasta dónde puede bajar el cierre (totales, Ley 27.743, QR y CAE) en la última.
const LIMITE_CIERRE = MARCO.abajo - 8;

const ALTO_RENGLON = 12;
const ALTO_CELDA = 16;

// ── Formatos ─────────────────────────────────────────────────────────
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const soloDigitos = (v) => String(v ?? '').replace(/\D/g, '');

/*
 * Los importes van con centavos y sin el signo pesos, como en el modelo: el "$"
 * está en la etiqueta ("Total $"), no repetido en cada celda. Formato argentino,
 * que es como se leen los números acá.
 */
function numero(v) {
  return new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(r2(v));
}

function porcentaje(v) {
  return new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 }).format(Number(v) || 0);
}

function cuitConGuiones(v) {
  const d = soloDigitos(v);
  return d.length === 11 ? `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}` : String(v || '');
}

// ── El comprobante como lo autorizó ARCA ────────────────────────────

/*
 * El número que Stocker lleva adentro (2609-00001) NO es el del comprobante:
 * el que vale es el punto de venta y el número que devolvió ARCA al dar el
 * CAE, y es el que hay que imprimir y el que va adentro del QR. Salen de la
 * respuesta guardada; si el comprobante no llegó a tener CAE, no hay ninguno.
 */
function comprobanteArca(invoice) {
  const r = invoice.arcaRespuesta || {};
  /*
   * Primero las columnas, después el JSON.
   *
   * El tipo NO se adivina por la letra: con notas de crédito en juego, caer al
   * mapa por letra convertiría una nota en la FACTURA del mismo número, y el
   * QR de ese papel verificaría contra un comprobante que no es. Si no se sabe
   * el tipo, va cero y el QR no se dibuja: un papel sin QR es un problema
   * menor que un papel con el QR de otro.
   */
  const porClase = CBTE_TIPO[invoice?.clase || 'factura'] || {};
  return {
    ptoVta: Number(invoice.ptoVtaArca || r.puntoVenta || r.PtoVta || 0),
    nroCmp: Number(invoice.cbteNroArca || r.numero || r.CbteDesde || 0),
    tipoCmp: Number(invoice.cbteTipoArca || r.cbteTipo || porClase[invoice.tipo] || 0),
  };
}

/** "00003-00000123", como se imprime. Null si no tiene número de ARCA. */
function numeroArca(invoice) {
  const { ptoVta, nroCmp } = comprobanteArca(invoice);
  if (!ptoVta || !nroCmp) return null;
  return `${String(ptoVta).padStart(5, '0')}-${String(nroCmp).padStart(8, '0')}`;
}

/*
 * La fecha del comprobante es la que ARCA autorizó (CbteFch), no la de cuando
 * se grabó la fila: son distintas justo en las ventas de la noche, y la que
 * vale ante ARCA es la primera. Las facturas sin ese dato —simuladas o de
 * antes de que se guardara— caen a la de creación, en hora de Argentina.
 */
function fechaDelComprobante(invoice) {
  return {
    impresa: ddmmaaaa(invoice.cbteFchArca) || ddmmaaaaArgentina(invoice.fechaEmision || new Date()),
    iso: isoDia(invoice.cbteFchArca) || isoArgentina(invoice.fechaEmision || new Date()),
  };
}

// La URL que manda la especificación vigente del QR (RG 4892).
const URL_QR = 'https://www.arca.gob.ar/fe/qr/';

/*
 * El QR que la RG 4892 exige en la representación impresa.
 *
 * Es lo que le permite a cualquiera —el comprador, un inspector— verificar el
 * comprobante contra ARCA sin depender de lo que diga el papel: codifica una
 * URL de AFIP con los datos del comprobante en base64.
 *
 * No se dibuja si el CAE no es real: un QR sobre un comprobante de
 * homologación lleva a una consulta que no existe, y sería peor que no tener
 * QR, porque el papel parecería válido.
 *
 * Los campos van en el orden de la especificación y cada uno sale de lo que se
 * le mandó a ARCA, no de una regla parecida: la fecha es el CbteFch autorizado
 * y el documento del receptor se decide con la MISMA función que armó el
 * pedido. Antes el QR tenía su propia regla (sólo DNI de 7 u 8 dígitos) y un
 * documento que ARCA sí había recibido como DNI quedaba afuera del QR.
 */
function datosQr(invoice) {
  if (!invoice.cae || invoice.simulado || invoice.ambiente !== 'produccion') return null;
  const { ptoVta, nroCmp, tipoCmp } = comprobanteArca(invoice);
  if (!ptoVta || !nroCmp || !tipoCmp) return null;

  const cuitEmisor = soloDigitos(invoice.emisorCuit);
  if (!cuitEmisor) return null;

  const datos = {
    ver: 1,
    fecha: fechaDelComprobante(invoice).iso,
    cuit: Number(cuitEmisor),
    ptoVta,
    tipoCmp,
    nroCmp,
    importe: Number(Number(invoice.total || 0).toFixed(2)),
    moneda: 'PES',
    ctz: 1,
  };
  /*
   * El documento del receptor va "de corresponder": en un consumidor final sin
   * datos (DocTipo 99, número cero) no se manda nada, en vez de inventarlo.
   */
  const docTipo = docTipoFromCliente(invoice.clienteCuit);
  const docNro = Number(soloDigitos(invoice.clienteCuit));
  if (docTipo !== 99 && docNro > 0) {
    datos.tipoDocRec = docTipo;
    datos.nroDocRec = docNro;
  }
  // "E" es CAE. "A" sería CAEA, que Stocker no usa.
  datos.tipoCodAut = 'E';
  datos.codAut = Number(soloDigitos(invoice.cae));
  return datos;
}

/** El texto que se codifica: la URL de ARCA con los datos en base64. */
function urlQr(invoice) {
  const datos = datosQr(invoice);
  if (!datos) return null;
  return `${URL_QR}?p=${Buffer.from(JSON.stringify(datos), 'utf8').toString('base64')}`;
}

async function qrDelComprobante(invoice) {
  const url = urlQr(invoice);
  if (!url) return null;
  try {
    return await bwip.toBuffer({ bcid: 'qrcode', text: url, scale: 3, includetext: false });
  } catch {
    /*
     * Sin QR se sigue. El comprobante ya está autorizado y el CAE impreso lo
     * respalda: quedarse sin PDF por no poder dibujar un cuadrito sería peor.
     */
    return null;
  }
}

// ── Qué se imprime: la vista de la factura ──────────────────────────

const TITULO_CLASE = { factura: 'Factura', nota_credito: 'Nota de Crédito', nota_debito: 'Nota de Débito' };

/*
 * El domicilio comercial que va en la cabecera: el del LOCAL donde se vendió.
 *
 * Es lo que la RG 1415 pide y lo que hace el modelo ("Ciudadela [Av. Militar
 * 4106]"): el comprador tiene que poder saber en qué local le facturaron, y la
 * casa central no se lo dice. La tienda `online` no es un lugar —identifica el
 * canal—, así que ahí va el domicilio del CUIT; y si no hay ninguno de los dos,
 * nada, antes que una dirección inventada.
 */
function domicilioComercial({ local = null, cuit = null } = {}) {
  const dir = String(local?.direccion || '').trim();
  if (local && local.tipo !== 'online' && dir) {
    const nombre = String(local.nombre || '').trim();
    const conNombre = nombre && nombre.toLowerCase() !== dir.toLowerCase() ? `${nombre} [${dir}]` : dir;
    return conNombre.slice(0, 300);
  }
  const fiscal = String(cuit?.domicilio || '').trim();
  if (fiscal) return fiscal.slice(0, 300);
  return dir ? dir.slice(0, 300) : null;
}

/*
 * La condición frente al IVA del emisor, como la nombra ARCA.
 *
 * La letra manda: sólo un responsable inscripto puede emitir A o B —ARCA lo
 * rechaza desde un punto de venta de monotributo—, así que un A o un B dice
 * "IVA Responsable Inscripto" aunque el dato cargado diga otra cosa. En una C
 * se imprime lo cargado, y si no es una condición de C, no se imprime nada.
 */
function condicionDelEmisor(condicion, letra) {
  if (letra === 'A' || letra === 'B') return 'IVA Responsable Inscripto';
  const c = String(condicion || '').toLowerCase();
  if (/monotribut/.test(c)) return 'Responsable Monotributo';
  if (/exento/.test(c)) return 'IVA Sujeto Exento';
  if (/no alcanzado/.test(c)) return 'IVA No Alcanzado';
  return null;
}

function descripcion(item) {
  const variantes = [
    item.variante1Valor && `${item.variante1Nombre || 'Variante'}: ${item.variante1Valor}`,
    item.variante2Valor && `${item.variante2Nombre || 'Variante'}: ${item.variante2Valor}`,
  ].filter(Boolean);
  const titulo = String(item.titulo || '').trim();
  return variantes.length ? `${titulo} (${variantes.join(', ')})` : titulo;
}

/*
 * Todo lo que el papel dice, ya calculado. Se separa del dibujo para que las
 * pruebas puedan mirar los números sin leer un PDF.
 *
 * ── Los números ─────────────────────────────────────────────────────
 *
 * Como en el modelo, el precio unitario va SIN IVA y el total del renglón CON
 * IVA. El total del renglón es el que se cobró y está guardado; el unitario
 * sin IVA es una cuenta para mostrar. Así los renglones suman exactamente el
 * Subtotal, y el Subtotal menos los Descuentos da exactamente el Total que se
 * le declaró a ARCA.
 *
 * Los Descuentos son la diferencia entre lo que suman los renglones y el total
 * facturado: es el descuento de la venta (el porcentaje o el monto que se le
 * hizo al cliente), que antes quedaba fijo en cero y el papel no cerraba.
 *
 * En una B el IVA NO se discrimina: va adentro de los precios y se informa
 * sólo en el recuadro de la Ley 27.743. Imprimir "Subtotal neto + IVA 21%" en
 * una B —como hacía la versión anterior— es discriminarlo, y además ese neto
 * no coincidía con la suma de los renglones. En una A sí se discrimina, con el
 * neto y el IVA que se le declararon a ARCA. En una C no hay IVA.
 */
function armarVista(invoice, items = [], business = {}, contexto = {}) {
  const letra = String(invoice.tipo || 'B').toUpperCase();
  const clase = TITULO_CLASE[invoice.clase] ? invoice.clase : 'factura';
  const conIva = letra !== 'C';
  const alicuota = conIva ? ALICUOTA_IVA.porcentaje : null;
  const divisor = conIva ? 1 + ALICUOTA_IVA.porcentaje / 100 : 1;

  const renglones = (Array.isArray(items) ? items : []).map((it) => {
    const unidades = Number(it.cantidad) || 0;
    const total = r2(it.subtotal);
    const unitario = it.precioUnitario != null && it.precioUnitario !== ''
      ? Number(it.precioUnitario)
      : (unidades ? total / unidades : 0);
    return {
      sku: String(it.sku || ''),
      producto: descripcion(it),
      unidades,
      unitario: r2(unitario / divisor),
      alicuota,
      total,
    };
  });

  const total = r2(invoice.total);
  const subtotal = r2(renglones.reduce((s, r) => s + r.total, 0));
  const diferencia = r2(subtotal - total);
  const hayRenglones = renglones.length > 0;
  const descuento = hayRenglones && diferencia >= 0.01 ? diferencia : 0;
  // Un total mayor que los renglones no debería pasar; si pasa, se dice, para que cierre.
  const ajuste = hayRenglones && diferencia <= -0.01 ? -diferencia : 0;
  const descuentoPct = Number(contexto.descuentoPct) || 0;

  const { tipoCmp } = comprobanteArca(invoice);
  const codigo = tipoCmp || CBTE_TIPO[clase]?.[letra] || 0;
  const emisorCtx = contexto.emisor || {};
  const docTipo = docTipoFromCliente(invoice.clienteCuit);
  const docNro = soloDigitos(invoice.clienteCuit);
  const condReceptor = Number(invoice.condicionIvaReceptorId)
    || condicionIvaReceptorId({ tipo: letra, clienteCuit: invoice.clienteCuit });

  const esFiscal = Boolean(invoice.cae) && invoice.ambiente === 'produccion' && !invoice.simulado;
  const asociada = contexto.asociada || null;

  return {
    letra,
    clase,
    titulo: TITULO_CLASE[clase],
    codigo: codigo ? String(codigo).padStart(2, '0') : '',
    numero: numeroArca(invoice) || String(invoice.numero || ''),
    fecha: fechaDelComprobante(invoice).impresa,
    cae: invoice.cae || null,
    caeVencimiento: ddmmaaaa(invoice.caeVencimiento),
    esFiscal,
    motivoNoFiscal: invoice.simulado
      ? 'CAE SIMULADO — no se pidió a ARCA'
      : 'EMITIDO EN HOMOLOGACIÓN (AMBIENTE DE PRUEBA)',
    emisor: {
      marca: String(business.nombreNegocio || invoice.emisorNombre || '').trim(),
      razonSocial: String(invoice.emisorNombre || business.nombreNegocio || '').trim(),
      domicilio: invoice.emisorDomicilio || emisorCtx.domicilio || null,
      condicionIva: condicionDelEmisor(
        invoice.emisorCondicionIva || emisorCtx.condicionIva || business.condicionIva, letra,
      ),
      cuit: cuitConGuiones(invoice.emisorCuit || business.cuit),
      ingresosBrutos: String(emisorCtx.ingresosBrutos || '').trim() || null,
      inicioActividades: ddmmaaaa(emisorCtx.inicioActividades),
    },
    receptor: {
      nombre: String(invoice.clienteNombre || 'Consumidor Final').trim(),
      documento: docTipo === 99 || !docNro ? null
        : { etiqueta: docTipo === 80 ? 'CUIT' : 'DNI', valor: docTipo === 80 ? cuitConGuiones(docNro) : docNro },
      domicilio: String(invoice.clienteDireccion || '').trim() || null,
      email: String(invoice.clienteEmail || '').trim() || null,
      condicionIva: CONDICIONES_IVA_RECEPTOR[condReceptor] || null,
    },
    asociada: asociada ? {
      texto: `${TITULO_CLASE[asociada.clase] || 'Factura'} ${String(asociada.tipo || letra).toUpperCase()} `
        + `N° ${numeroArca(asociada) || asociada.numero || ''}`
        + `${fechaDelComprobante(asociada).impresa ? ` del ${fechaDelComprobante(asociada).impresa}` : ''}`,
    } : null,
    motivo: clase !== 'factura' && invoice.motivo ? String(invoice.motivo) : null,
    renglones,
    conIva,
    alicuota,
    subtotal,
    descuento,
    descuentoEtiqueta: descuentoPct > 0 ? `Descuento (${porcentaje(descuentoPct)}%)` : 'Descuento',
    ajuste,
    total,
    discriminaIva: letra === 'A',
    neto: r2(invoice.subtotal),
    iva: r2(invoice.iva),
    transparencia: letra === 'B',
    notas: [
      invoice.esMayorista ? 'Precio mayorista aplicado.' : null,
      invoice.cobroDestino ? `Cobro acreditado en: ${invoice.cobroDestino}` : null,
    ].filter(Boolean),
  };
}

// ── Dibujo ───────────────────────────────────────────────────────────

/* Achica la letra hasta que el texto entre en una línea, sin bajar del mínimo. */
function tamanoQueEntra(doc, texto, { fuente, tamano, minimo, ancho }) {
  doc.font(fuente);
  let t = tamano;
  while (t > minimo && doc.fontSize(t).widthOfString(texto) > ancho) t -= 0.5;
  return t;
}

/*
 * La franja de "esto no es una factura".
 *
 * Un comprobante de homologación —o uno simulado— sale idéntico a uno real:
 * mismo formato de CAE, mismo número, mismo diseño. Impreso y archivado, nadie
 * puede distinguirlo, y el día que alguien lo busque por CAE en ARCA no va a
 * estar. Un papel que parece una factura y no lo es hace más daño que no tener
 * ninguno, porque se archiva y se deja de pensar en él.
 *
 * Por eso va arriba de todo, en rojo, ocupando el ancho entero, y en CADA hoja:
 * la información más importante de ese papel no es el total, es que no sirve
 * para respaldar nada.
 *
 * Devuelve la nueva `y`, para que el resto del comprobante baje.
 */
function dibujarAvisoNoFiscal(doc, vista, y) {
  if (vista.esFiscal) return y;
  const ancho = MARCO.x1 - MARCO.x0;
  doc.save();
  doc.rect(MARCO.x0, y, ancho, 34).fill(ROJO_FONDO);
  doc.rect(MARCO.x0, y, 4, 34).fill(ROJO);
  doc.fillColor(ROJO).font('Helvetica-Bold').fontSize(11)
    .text('COMPROBANTE SIN VALIDEZ FISCAL', MARCO.x0 + 14, y + 6, { width: ancho - 24 });
  doc.font('Helvetica').fontSize(8.5)
    .text(`${vista.motivoNoFiscal}. Este comprobante NO existe en ARCA y no sirve como respaldo `
      + 'de la operación ante AFIP ni ante el comprador.', MARCO.x0 + 14, y + 20, { width: ancho - 24 });
  doc.restore();
  doc.fillColor(NEGRO);
  return y + 40;
}

/* "ORIGINAL", arriba de todo y en la franja celeste. */
function dibujarFranjaOriginal(doc, y) {
  doc.save().rect(INTERIOR.x0, y + 2, INTERIOR.x1 - INTERIOR.x0, 14).fill(AZUL_CLARO).restore();
  doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(10)
    .text('ORIGINAL', INTERIOR.x0, y + 6, { width: INTERIOR.x1 - INTERIOR.x0, align: 'center', lineBreak: false });
  return y + 16;
}

/*
 * La cabecera de la primera hoja: ORIGINAL, la letra en su recuadro con el
 * código del comprobante, y los dos recuadros del emisor y del comprobante.
 */
function dibujarCabecera(doc, vista, y0) {
  dibujarFranjaOriginal(doc, y0);

  // La letra, centrada, con el código de ARCA debajo ("COD. 06").
  const lx = 283.5;
  const lw = 28;
  const ly = y0 + 18;
  doc.save().lineWidth(0.5).rect(lx, ly, lw, 33).fillAndStroke('#FFFFFF', NEGRO).restore();
  doc.fillColor(NEGRO).font('Helvetica').fontSize(27)
    .text(vista.letra, lx, ly + 1, { width: lw, align: 'center', lineBreak: false });
  if (vista.codigo) {
    doc.font('Helvetica').fontSize(5.5)
      .text(`COD. ${vista.codigo}`, lx, ly + 26, { width: lw, align: 'center', lineBreak: false });
  }

  const top = y0 + 53;
  const anchoCaja = (INTERIOR.x1 - INTERIOR.x0) / 2;
  const izq = { x: INTERIOR.x0, w: anchoCaja };
  const der = { x: INTERIOR.x0 + anchoCaja, w: anchoCaja };
  const pad = 10;

  // ── Izquierda: el emisor ──────────────────────────────────────
  /*
   * En el modelo arriba va el logo. Stocker todavía no guarda el logo de cada
   * negocio, así que va su nombre, grande, en el mismo lugar.
   */
  const anchoTexto = izq.w - pad * 2;
  const tamMarca = tamanoQueEntra(doc, vista.emisor.marca, {
    fuente: 'Helvetica-Bold', tamano: 22, minimo: 12, ancho: anchoTexto,
  });
  doc.font('Helvetica-Bold').fontSize(tamMarca);
  const altoMarca = doc.heightOfString(vista.emisor.marca || ' ', { width: anchoTexto, align: 'center' });

  const lineasIzq = [
    vista.emisor.razonSocial && `Razón Social: ${vista.emisor.razonSocial}`,
    vista.emisor.domicilio && `Domicilio Comercial: ${vista.emisor.domicilio}`,
    vista.emisor.condicionIva,
  ].filter(Boolean);
  doc.font('Helvetica-Bold').fontSize(8);
  const altosIzq = lineasIzq.map((l) => Math.max(12, doc.heightOfString(l, { width: anchoTexto, align: 'center' }) + 3));
  const altoLineasIzq = altosIzq.reduce((a, b) => a + b, 0);
  const altoIzq = 8 + altoMarca + 10 + altoLineasIzq + 2;

  // ── Derecha: el comprobante ───────────────────────────────────
  const lineasDer = [
    `Nro. Comprobante: ${vista.numero}`,
    `Fecha de Emisión: ${vista.fecha}`,
    `C.U.I.T: ${vista.emisor.cuit}`,
    // Ingresos Brutos e Inicio de Actividades sólo si están cargados: un "—"
    // en un comprobante fiscal se lee como un dato que falta.
    vista.emisor.ingresosBrutos && `ING. BRUTOS: ${vista.emisor.ingresosBrutos}`,
    vista.emisor.inicioActividades && `Inicio Actividades: ${vista.emisor.inicioActividades}`,
  ].filter(Boolean);
  const altoDer = 22 + lineasDer.length * 12 + 6;

  const alto = Math.max(85.5, altoIzq, altoDer);

  doc.lineWidth(0.5).strokeColor(NEGRO);
  doc.rect(izq.x, top, izq.w, alto).stroke();
  doc.rect(der.x, top, der.w, alto).stroke();

  // Marca centrada en el espacio que dejan las líneas de abajo.
  const espacioMarca = alto - altoLineasIzq - 4;
  const yMarca = top + Math.max(6, (espacioMarca - altoMarca) / 2);
  doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(tamMarca)
    .text(vista.emisor.marca, izq.x + pad, yMarca, { width: anchoTexto, align: 'center' });

  let yl = top + alto - altoLineasIzq - 2;
  doc.font('Helvetica-Bold').fontSize(8);
  lineasIzq.forEach((l, i) => {
    doc.text(l, izq.x + pad, yl + 3, { width: anchoTexto, align: 'center' });
    yl += altosIzq[i];
  });

  doc.font('Helvetica-Bold').fontSize(18)
    .text(vista.titulo, der.x, top + 3.5, { width: der.w, align: 'center', lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(8);
  lineasDer.forEach((l, i) => {
    doc.text(l, der.x + pad, top + 22.6 + i * 12, { width: der.w - pad * 2, align: 'center', lineBreak: false });
  });

  return top + alto;
}

/*
 * El cliente, en dos columnas como el modelo. Cada fila baja lo que ocupe su
 * celda más alta: un domicilio largo se parte en renglones dentro de su
 * columna, en vez de pisar el campo de al lado como pasaba antes.
 */
function dibujarCliente(doc, vista, y) {
  const { receptor } = vista;
  const campo = (etiqueta, valor, x, cy, ancho) => {
    doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(8)
      .text(`${etiqueta}: `, x, cy, { width: ancho, continued: true })
      .font('Helvetica').text(valor);
    return doc.y - cy;
  };
  const alturaDe = (etiqueta, valor, ancho) => {
    doc.font('Helvetica').fontSize(8);
    // Medido con la regular: la etiqueta en negrita es apenas más ancha, por eso el margen.
    return doc.heightOfString(`${etiqueta}: ${valor}`, { width: ancho - 4 });
  };
  const fila = (izq, der) => {
    const hIzq = izq ? alturaDe(izq[0], izq[1], izq[2] || CLIENTE.anchoIzq) : 0;
    const hDer = der ? alturaDe(der[0], der[1], CLIENTE.anchoDer) : 0;
    if (izq) campo(izq[0], izq[1], CLIENTE.x0, y, izq[2] || CLIENTE.anchoIzq);
    if (der) campo(der[0], der[1], CLIENTE.xDer, y, CLIENTE.anchoDer);
    y += Math.max(hIzq, hDer, 9) + 7;
  };

  y += 12;
  fila(['Apellido y Nombre', receptor.nombre],
    receptor.documento ? [receptor.documento.etiqueta, receptor.documento.valor] : null);
  fila(['Domicilio', receptor.domicilio || '-'],
    receptor.condicionIva ? ['IVA', receptor.condicionIva] : null);
  // El mail va a lo ancho: una dirección larga sin espacios no se puede partir bien en media hoja.
  if (receptor.email) fila(['Email', receptor.email, INTERIOR.x1 - CLIENTE.x0 - 4], null);
  if (vista.asociada) fila(['Comprobante asociado', vista.asociada.texto, INTERIOR.x1 - CLIENTE.x0 - 4], null);
  if (vista.motivo) fila(['Motivo', vista.motivo, INTERIOR.x1 - CLIENTE.x0 - 4], null);
  return y + 2;
}

/*
 * Las columnas del detalle, las del modelo: Sku · Producto · Unidades · Precio
 * Unitario · IVA · Precio Total. El Sku es más ancho que en el modelo porque
 * los de indumentaria son largos (modelo + color + talle). En una C no hay
 * columna IVA —un monotributista no lo factura, y un "0%" diría otra cosa— y
 * ese ancho se lo lleva el producto.
 */
function columnas(vista) {
  const defs = [
    { clave: 'sku', titulo: 'Sku', ancho: 78 },
    { clave: 'producto', titulo: 'Producto', ancho: 240 },
    { clave: 'unidades', titulo: 'Unidades', ancho: 47.27 },
    { clave: 'unitario', titulo: 'Precio Unitario', ancho: 77.35 },
    { clave: 'iva', titulo: 'IVA', ancho: 42.97 },
    { clave: 'total', titulo: 'Precio Total', ancho: 68.75 },
  ];
  const usadas = vista.conIva ? defs : defs.filter((c) => c.clave !== 'iva');
  if (!vista.conIva) usadas.find((c) => c.clave === 'producto').ancho += 42.97;
  let x = TABLA.x0;
  return usadas.map((c) => { const col = { ...c, x }; x += c.ancho; return col; });
}

function dibujarEncabezadoTabla(doc, cols, y) {
  doc.lineWidth(0.5);
  for (const c of cols) {
    doc.save().rect(c.x, y, c.ancho, 15).fill(AZUL).restore();
    doc.rect(c.x, y, c.ancho, 15).strokeColor(NEGRO).stroke();
    doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(9)
      .text(c.titulo, c.x, y + 4, { width: c.ancho, align: 'center', lineBreak: false });
  }
  return y + 15;
}

function textosDelRenglon(r) {
  return {
    sku: r.sku,
    producto: r.producto,
    unidades: String(r.unidades),
    unitario: numero(r.unitario),
    iva: r.alicuota == null ? '' : `${porcentaje(r.alicuota)}%`,
    total: numero(r.total),
  };
}

function altoDelRenglon(doc, cols, r) {
  const prod = cols.find((c) => c.clave === 'producto');
  doc.font('Helvetica').fontSize(8);
  const h = doc.heightOfString(r.producto || ' ', { width: prod.ancho - 4 });
  return Math.max(ALTO_RENGLON, h + 3);
}

function dibujarRenglon(doc, cols, r, y) {
  const t = textosDelRenglon(r);
  for (const c of cols) {
    const texto = t[c.clave];
    if (!texto) continue;
    if (c.clave === 'producto') {
      doc.fillColor(NEGRO).font('Helvetica').fontSize(8)
        .text(texto, c.x + 2, y + 3, { width: c.ancho - 4 });
    } else {
      // Un SKU largo se achica antes que partirse: partido no se puede buscar.
      const tam = c.clave === 'sku'
        ? tamanoQueEntra(doc, texto, { fuente: 'Helvetica', tamano: 8, minimo: 5.5, ancho: c.ancho - 4 })
        : 8;
      doc.fillColor(NEGRO).font('Helvetica').fontSize(tam)
        .text(texto, c.x + 2, y + 3 + (8 - tam) / 2, { width: c.ancho - 4, align: 'center' });
    }
  }
  return y + altoDelRenglon(doc, cols, r);
}

/*
 * Un renglón de totales: la etiqueta a la izquierda de la última columna y el
 * importe en su celda de color, como en el modelo.
 */
function celdaDeTotal(doc, cols, y, etiqueta, valor, { fondo = AZUL_CLARO, signo = null, etiquetaSuelta = false } = {}) {
  const ult = cols[cols.length - 1];
  const ante = cols[cols.length - 2];
  doc.save().rect(ult.x, y, ult.ancho, ALTO_CELDA).fill(fondo).restore();
  doc.fillColor(NEGRO);
  if (etiquetaSuelta) {
    // "Descuentos" va suelto bajo el precio unitario y el "$" pegado a la celda, como en el modelo.
    const pu = cols.find((c) => c.clave === 'unitario');
    doc.font('Helvetica').fontSize(8).text(etiqueta, pu.x + 2, y + 5, { width: pu.ancho, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(8)
      .text(signo || '$', ante.x, y + 5, { width: ante.ancho - 4, align: 'right', lineBreak: false });
  } else {
    doc.font('Helvetica-Bold').fontSize(8)
      .text(etiqueta, TABLA.x0, y + 5, { width: ult.x - TABLA.x0 - 4, align: 'right', lineBreak: false });
  }
  doc.font('Helvetica-Bold').fontSize(8)
    .text(numero(valor), ult.x, y + 5, { width: ult.ancho, align: 'center', lineBreak: false });
  return y + ALTO_CELDA;
}

/*
 * ── El Régimen de Transparencia Fiscal al Consumidor (Ley 27.743) ─
 *
 * Desde 2024 la ley obliga a mostrarle al consumidor final cuánto de lo que
 * pagó es impuesto. En una factura B el precio va con el IVA adentro, así que
 * sin esta leyenda el comprador no tiene forma de saber cuánto le corresponde a
 * la AFIP: ve un número y nada más. Es lo que el recuadro dice.
 *
 * Va SÓLO en la B, y eso no es una omisión:
 *   · la A es entre responsables inscriptos y ya lleva el IVA discriminado en su
 *     propio renglón, así que el dato está dicho;
 *   · la C la emite un monotributista, que no discrimina IVA porque no lo
 *     factura. Poner un "IVA contenido: $0" ahí sería afirmar algo falso sobre
 *     el precio.
 *
 * "Otros impuestos nacionales indirectos" va en cero porque Stocker no liquida
 * impuestos internos ni percepciones: el día que lo haga, el número sale de ahí
 * y no de esta constante.
 */
function drawTransparenciaFiscal(doc, y, { tipo, iva }) {
  if (String(tipo || '').toUpperCase() !== 'B') return y;

  const x = 41.83;
  const ancho = 553.17 - 41.83;
  const alto = 66;

  doc.save()
    .rect(x, y, ancho, alto)
    .lineWidth(1).strokeColor(NEGRO).stroke()
    .restore();

  doc.font('Helvetica-Oblique').fontSize(9).fillColor(NEGRO)
    .text('Régimen de Transparencia Fiscal al Consumidor (Ley 27.743)', x + 10, y + 10, {
      width: ancho - 20, underline: true,
    });

  // Etiqueta alineada a la derecha y el importe a su lado, como en el modelo.
  const corte = 216;
  const linea = (k, v, cy) => {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(NEGRO);
    doc.text(k, x + 10, cy, { width: corte - 10, align: 'right' });
    doc.text(v, x + corte + 12, cy, { width: ancho - corte - 24, align: 'left' });
  };
  linea('IVA Contenido: $', numero(iva || 0), y + 34);
  linea('Otros Impuestos Nacionales Indirectos: $', numero(0), y + 47);

  return y + alto + 6;
}

/*
 * El pie, como el modelo: el QR de ARCA a la izquierda, al lado "ARCA" con su
 * nombre en chico y "Comprobante Autorizado" con la leyenda de rigor, y a la
 * derecha el CAE y su vencimiento.
 *
 * Si el comprobante no es fiscal no hay QR ni "Comprobante Autorizado": sería
 * decir que ARCA autorizó algo que no existe en ARCA.
 */
function dibujarPie(doc, vista, qr, y) {
  const xTexto = 129.77;
  if (qr) doc.image(qr, 43.83, y, { width: 73, height: 73 });

  if (vista.esFiscal) {
    doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(16)
      .text('ARCA', xTexto, y + 9.5, { lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(4)
      .text('Agencia de Recaudación', xTexto, y + 23, { lineBreak: false })
      .text('y Control Aduanero', xTexto + 3, y + 27.5, { lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(9)
      .text('Comprobante Autorizado', xTexto, y + 37, { lineBreak: false });
    doc.font('Helvetica-BoldOblique').fontSize(5)
      .text('Esta Administración Federal no se responsabiliza por los datos ingresados en el detalle de la operación',
        xTexto, y + 64, { width: 330, lineBreak: false });
  } else {
    doc.fillColor(ROJO).font('Helvetica-Bold').fontSize(9)
      .text('Comprobante sin validez fiscal', 43.83, y + 22, { width: 300, lineBreak: false });
    doc.font('Helvetica').fontSize(7)
      .text('No lleva el código QR de ARCA porque este comprobante no existe en ARCA.', 43.83, y + 35, { width: 300 });
    doc.fillColor(NEGRO);
  }

  if (vista.cae) {
    const xd = 330;
    const wd = TABLA.x1 - xd;
    doc.fillColor(NEGRO).font('Helvetica-BoldOblique').fontSize(10)
      .text(`CAE N°: ${vista.cae}`, xd, y + 22.8, { width: wd, align: 'right', lineBreak: false });
    if (vista.caeVencimiento) {
      doc.text(`Fecha de Vto de CAE: ${vista.caeVencimiento}`, xd, y + 37.8, { width: wd, align: 'right', lineBreak: false });
    }
  }
  return y + 73;
}

/*
 * El cierre de la factura: totales, notas, recuadro de la Ley 27.743 y pie.
 * Va siempre entero y en la última hoja; para saber si entra se lo mide
 * dibujándolo en un documento de descarte (ver `altoDelCierre`), así la
 * medida no puede quedar desfasada del dibujo.
 */
function dibujarCierre(doc, vista, cols, qr, y) {
  y += 12;
  if (vista.renglones.length) {
    y = celdaDeTotal(doc, cols, y, 'Subtotal $', vista.subtotal);
  }
  if (vista.descuento) {
    y += 14;
    y = dibujarRenglon(doc, cols, {
      sku: '',
      producto: vista.descuentoEtiqueta,
      unidades: 1,
      unitario: r2(-vista.descuento / (vista.conIva ? 1 + ALICUOTA_IVA.porcentaje / 100 : 1)),
      alicuota: vista.alicuota,
      total: -vista.descuento,
    }, y);
    y += 14;
    y = celdaDeTotal(doc, cols, y, 'Descuentos', -vista.descuento, { etiquetaSuelta: true });
  }
  if (vista.ajuste) {
    y = celdaDeTotal(doc, cols, y, 'Ajustes', vista.ajuste, { etiquetaSuelta: true });
  }
  if (vista.discriminaIva) {
    y = celdaDeTotal(doc, cols, y, 'Importe Neto Gravado $', vista.neto);
    y = celdaDeTotal(doc, cols, y, `IVA ${porcentaje(vista.alicuota)}% $`, vista.iva);
  }
  y = celdaDeTotal(doc, cols, y, 'Total $', vista.total, { fondo: AZUL });

  if (vista.notas.length) {
    y += 8;
    doc.fillColor(GRIS).font('Helvetica').fontSize(7.5);
    for (const n of vista.notas) {
      doc.text(n, CLIENTE.x0, y, { width: INTERIOR.x1 - CLIENTE.x0 - 4 });
      y = doc.y + 1;
    }
    doc.fillColor(NEGRO);
  }

  y += 14;
  y = drawTransparenciaFiscal(doc, y, { tipo: vista.letra, iva: vista.iva });
  y += 4;
  return dibujarPie(doc, vista, qr, y);
}

function documentoNuevo(extra = {}) {
  /*
   * Márgenes en cero, a propósito. Con margen, PDFKit agrega una hoja sola
   * cuando un texto cae debajo del margen inferior: así salía la segunda hoja
   * con sólo el pie. Acá cada posición la decide el armado, y lo que no entra
   * se pagina a mano.
   */
  return new PDFDocument({ size: 'A4', margin: 0, ...extra });
}

function altoDelCierre(vista, cols, qr) {
  const borrador = documentoNuevo();
  return dibujarCierre(borrador, vista, cols, qr, 0);
}

/* Cabecera de las hojas que siguen: ORIGINAL y qué comprobante es. */
function dibujarCabeceraContinuacion(doc, vista, y0, hoja) {
  dibujarFranjaOriginal(doc, y0);
  doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(9)
    .text(`${vista.titulo} ${vista.letra} · Nro. Comprobante: ${vista.numero} · ${vista.fecha} · Hoja ${hoja} (continuación)`,
      INTERIOR.x0, y0 + 24, { width: INTERIOR.x1 - INTERIOR.x0, align: 'center', lineBreak: false });
  return y0 + 44;
}

/*
 * ── Las hojas ───────────────────────────────────────────────────────
 *
 * Una factura corta entra en una hoja. Una larga pagina: el detalle sigue en
 * la hoja siguiente y el cierre —totales, Ley 27.743, QR y CAE— va entero en
 * la ÚLTIMA. Antes el cierre se dibujaba donde cayera: con unos once renglones
 * el QR quedaba fuera de la hoja.
 *
 * Se reparte antes de dibujar: si el cierre no entra debajo del último
 * renglón, los últimos renglones pasan a la hoja nueva con él, para que la
 * última hoja no sean totales sueltos sin nada que sumar.
 */
function repartirEnHojas(doc, vista, cols, { inicioPrimera, inicioSiguientes, altoCierre }) {
  const hojas = [[]];
  let y = inicioPrimera;
  for (const r of vista.renglones) {
    const h = altoDelRenglon(doc, cols, r);
    if (y + h > LIMITE_DETALLE && hojas[hojas.length - 1].length) {
      hojas.push([]);
      y = inicioSiguientes;
    }
    hojas[hojas.length - 1].push(r);
    y += h;
  }
  if (y + altoCierre > LIMITE_CIERRE) {
    const ultima = hojas[hojas.length - 1];
    const pasan = [];
    while (ultima.length > 1 && pasan.length < 3) pasan.unshift(ultima.pop());
    hojas.push(pasan);
  }
  return hojas;
}

async function generarFactura(invoice, items, business = {}, contexto = {}) {
  const vista = armarVista(invoice, items, business, contexto);
  const qr = await qrDelComprobante(invoice);
  const cols = columnas(vista);

  return new Promise((resolve, reject) => {
    const doc = documentoNuevo({
      bufferPages: true,
      info: { Title: `${vista.titulo} ${vista.letra} ${vista.numero}`, Author: vista.emisor.razonSocial || 'Stocker' },
    });
    const partes = [];
    doc.on('data', (c) => partes.push(c));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);

    try {
      const altoCierre = altoDelCierre(vista, cols, qr);

      // Primera hoja: se mide lo que ocupa la cabecera dibujándola de verdad.
      const arribaPrimera = dibujarAvisoNoFiscal(doc, vista, MARCO.arriba);
      let y = dibujarCabecera(doc, vista, arribaPrimera);
      y = dibujarCliente(doc, vista, y);
      y += 6;
      const inicioPrimera = y + 15;
      const arribaSiguientes = vista.esFiscal ? MARCO.arriba : MARCO.arriba + 40;
      const inicioSiguientes = arribaSiguientes + 44 + 15;
      const hojas = repartirEnHojas(doc, vista, cols, { inicioPrimera, inicioSiguientes, altoCierre });

      const marcos = [];
      hojas.forEach((renglones, i) => {
        let arriba = arribaPrimera;
        if (i > 0) {
          doc.addPage();
          arriba = dibujarAvisoNoFiscal(doc, vista, MARCO.arriba);
          y = dibujarCabeceraContinuacion(doc, vista, arriba, i + 1);
        }
        y = dibujarEncabezadoTabla(doc, cols, y);
        for (const r of renglones) y = dibujarRenglon(doc, cols, r, y);

        const esUltima = i === hojas.length - 1;
        if (esUltima) {
          y = dibujarCierre(doc, vista, cols, qr, y);
          marcos.push({ arriba, abajo: Math.min(MARCO.abajo, y + 10) });
        } else {
          doc.fillColor(GRIS).font('Helvetica-Oblique').fontSize(7)
            .text('Continúa en la hoja siguiente', TABLA.x0, LIMITE_DETALLE + 4,
              { width: TABLA.x1 - TABLA.x0, align: 'right', lineBreak: false });
          doc.fillColor(NEGRO);
          marcos.push({ arriba, abajo: MARCO.abajo });
        }
      });

      // El marco celeste de cada hoja, y "Hoja x de y" cuando hay más de una.
      marcos.forEach((m, i) => {
        doc.switchToPage(i);
        doc.save().lineWidth(1).strokeColor(AZUL)
          .roundedRect(MARCO.x0, m.arriba, MARCO.x1 - MARCO.x0, m.abajo - m.arriba, 4).stroke().restore();
        if (marcos.length > 1) {
          doc.fillColor(GRIS).font('Helvetica').fontSize(7)
            .text(`Hoja ${i + 1} de ${marcos.length}`, MARCO.x0, m.abajo + 4,
              { width: MARCO.x1 - MARCO.x0, align: 'right', lineBreak: false });
          doc.fillColor(NEGRO);
        }
      });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

/*
 * Lo que la factura necesita y no está en su fila: Ingresos Brutos e Inicio de
 * Actividades del CUIT, y —para las facturas emitidas antes de que se
 * guardaran— el domicilio del local y la condición del emisor. El negocio sale
 * de la factura, que ya se buscó con el de la sesión.
 *
 * Si algo de esto falla, el PDF sale igual con lo que la factura tiene: no
 * poder descargar un comprobante fiscal por un dato de la cabecera sería peor.
 */
async function contextoDeImpresion(invoice) {
  const contexto = { emisor: {}, descuentoPct: 0, asociada: null };
  try {
    const {
      BusinessCuit, BusinessArcaConfig, Sale, BusinessLocation, Invoice,
    } = require('../models');
    const businessId = invoice.businessId;

    let cuit = invoice.businessCuitId
      ? await BusinessCuit.findOne({ where: { id: invoice.businessCuitId, businessId } })
      : null;
    if (!cuit && invoice.emisorCuit) {
      cuit = await BusinessCuit.findOne({ where: { businessId, cuit: soloDigitos(invoice.emisorCuit) } });
    }
    const config = cuit ? await BusinessArcaConfig.findOne({ where: { businessCuitId: cuit.id } }) : null;
    const venta = invoice.saleId
      ? await Sale.findOne({ where: { id: invoice.saleId, businessId }, attributes: ['id', 'locationId', 'descuentoPct'] })
      : null;
    const local = venta?.locationId
      ? await BusinessLocation.findOne({ where: { id: venta.locationId, businessId } })
      : null;

    contexto.emisor = {
      ingresosBrutos: cuit?.ingresosBrutos || null,
      inicioActividades: cuit?.inicioActividades || null,
      domicilio: domicilioComercial({ local, cuit }),
      condicionIva: config?.condicionIva || cuit?.condicionIva || null,
    };
    contexto.descuentoPct = Number(venta?.descuentoPct) || 0;

    if (invoice.facturaAsociadaId) {
      const f = await Invoice.findOne({
        where: { id: invoice.facturaAsociadaId, businessId },
        attributes: ['id', 'numero', 'tipo', 'clase', 'ptoVtaArca', 'cbteNroArca', 'cbteTipoArca', 'cbteFchArca', 'fechaEmision', 'arcaRespuesta'],
      });
      if (f) contexto.asociada = f.toJSON();
    }
  } catch (e) {
    log.warn('factura', 'el PDF sale sin los datos extra de la cabecera', { motivo: e.message });
  }
  return contexto;
}

module.exports = {
  generarFactura,
  contextoDeImpresion,
  domicilioComercial,
  drawTransparenciaFiscal,
  numeroArca,
  datosQr,
  urlQr,
  // Para las pruebas: lo que el papel dice, ya calculado, y cómo se reparte.
  __vista: armarVista,
  __medidas: { MARCO, LIMITE_DETALLE, LIMITE_CIERRE },
};
