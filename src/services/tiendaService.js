/*
 * Lo que la tienda minorista le pregunta a Stocker.
 *
 * La tienda es un canal online más, como Mercado Libre y Jumpseller: no
 * calcula stock ni precios, los pregunta. Lo único que guarda de su lado es lo
 * suyo —slug, categoría, SEO, fotos—, y por eso acá se devuelve el catálogo
 * completo con la cantidad publicable, que es exactamente el mismo número que
 * se le manda a los otros dos canales.
 *
 * ── Por qué el mismo número y no uno propio ──────────────────────
 *
 * `stockPublicableService` ya decide qué se publica: lo disponible en los
 * locales que abastecen online, menos el margen de seguridad, y en un pack
 * cuántos se pueden armar. Si la tienda hiciera su propia cuenta, el día que
 * esa regla cambie —un local nuevo, otra forma de contar los packs— dos
 * canales publicarían números distintos del mismo estante.
 */

const { Op } = require('sequelize');
const { Product, ProductVariant } = require('../models');
const { variantesPublicables, cantidadesPublicables } = require('./stockPublicableService');
const { localesQueAbastecenOnline } = require('./stockService');
const { precioMinorista, precioMayorista, tieneValor } = require('./precioService');

/*
 * Un catálogo de indumentaria entra holgado; el tope existe para que una
 * consulta no se lleve puesto el proceso si alguien cargó de más.
 */
const TOPE_VARIANTES = Number(process.env.TIENDA_TOPE_VARIANTES) || 20_000;
const TOPE_SKUS_CONSULTA = 500;

/**
 * El catálogo entero: productos padre, sus variantes y cuánto publicar.
 *
 * Se devuelve el padre con sus variantes adentro porque así lo consume la
 * tienda —un producto con su selector de color y talle— y porque el SKU
 * agrupador es la clave con la que guarda lo suyo.
 */
async function catalogo({ businessId }) {
  const [locales, variantes] = await Promise.all([
    localesQueAbastecenOnline(businessId),
    variantesPublicables(businessId, { soloActivas: true }),
  ]);
  const cantidades = locales.length
    ? await cantidadesPublicables(businessId, locales, variantes)
    : new Map();

  const truncado = variantes.length > TOPE_VARIANTES;
  const usadas = truncado ? variantes.slice(0, TOPE_VARIANTES) : variantes;

  /*
   * Se agrupa por SKU agrupador, que es por donde la tienda junta las
   * variantes en un producto. Cuando no hay agrupador se cae al SKU del
   * producto: un producto sin agrupador es uno solo, no un grupo vacío.
   */
  const porPadre = new Map();
  for (const v of usadas) {
    const p = v.producto;
    if (!p) continue;
    const clave = p.skuAgrupador || p.sku;
    if (!clave) continue;

    if (!porPadre.has(clave)) {
      porPadre.set(clave, {
        /*
         * El id del producto, además del SKU.
         *
         * Es la clave con la que la tienda engancha sus propias filas, y existe
         * porque un SKU se corrige: alguien le arregla un typo y, si la tienda
         * guardó el SKU como identidad, pierde el enganche con sus fotos, su
         * texto y su categoría. El id no cambia nunca.
         *
         * Va el del producto padre que agrupa, que es el que la tienda muestra
         * como una ficha.
         */
        id: p.id,
        skuAgrupador: clave,
        titulo: p.titulo,
        /*
         * El precio del producto, además del de cada variante.
         *
         * Es el que una ficha muestra antes de que el cliente elija talle. Las
         * variantes pueden tener el suyo —nulo significa "usa el del producto"—,
         * así que sin este número una ficha cuyas variantes no lo pisan no tiene
         * precio que mostrar.
         */
        precioMinorista: precioParaPublicar(precioMinorista(null, p), null, p, 'precioMinorista'),
        precioMayorista: precioParaPublicar(precioMayorista(null, p), null, p, 'precioMayorista'),
        descripcion: p.descripcion || null,
        categoria: p.categoria || null,
        modelo: p.modelo || null,
        genero: p.genero || null,
        variantes: [],
      });
    }
    porPadre.get(clave).variantes.push({
      // El id de la variante, por lo mismo que el del producto. Y además es lo
      // que viaja en el aviso `stock_cambio` (<negocio>:<variante>), así que sin
      // esto la tienda no puede traducir el aviso a un SKU suyo.
      id: v.id,
      sku: v.sku,
      // Del par genérico que Stocker guarda de verdad, no de un campo que no existe.
      ...ejesDe(v),
      /*
       * Los dos precios, con nombre completo y sin un `precio` a secas.
       *
       * La otra integración —el portal mayorista— devuelve `precio` y ahí
       * significa el mayorista. Dos rutas con el mismo campo queriendo decir
       * cosas distintas es la clase de detalle que se descubre cobrando mal.
       */
      precioMinorista: precioParaPublicar(precioMinorista(v, p), v, p, 'precioMinorista'),
      precioMayorista: precioParaPublicar(precioMayorista(v, p), v, p, 'precioMayorista'),
      /* El mismo número que se le manda a Mercado Libre y a Jumpseller. */
      /*
       * `cantidadesPublicables` devuelve { disponible, margen, cantidad } por
       * variante, no un número. Pasar el objeto por Number() da NaN, y NaN
       * serializado a JSON sale `null`: la tienda recibía null en cada SKU que
       * SÍ existe, que es peor que un cero porque no está en `desconocidos` y no
       * hay forma de distinguirlo de un dato faltante. Mercado Libre y Jumpseller
       * leen `.cantidad` desde siempre; esto no lo hacía.
       */
      publicable: Number(cantidades.get(v.id)?.cantidad || 0),
      activo: v.activo !== false,
    });
  }

  return {
    /*
     * De qué negocio es este catálogo.
     *
     * La credencial ya lo determina del lado de Stocker, pero la tienda lo
     * necesita del suyo: guarda los productos contra un negocio, y si algún día
     * una credencial se reemplaza por la de otro negocio sin que nadie lo note,
     * el dato en la respuesta es lo único que lo delata antes de mezclar dos
     * catálogos en la misma base.
     */
    negocio: businessId,
    productos: [...porPadre.values()],
    truncado,
    /*
     * Sin locales que abastezcan online todo da cero, y eso no se distingue de
     * "no hay stock" mirando los números. Se dice.
     */
    sinLocalesOnline: locales.length === 0,
    generadoEn: new Date(),
  };
}

/**
 * Las cantidades publicables de unos SKU puntuales.
 *
 * Es la consulta del carrito y del checkout: se pregunta por lo que el cliente
 * tiene en la mano, no por el catálogo entero.
 */
async function stockDeSkus({ businessId, skus }) {
  const pedidos = [...new Set((skus || []).map((s) => String(s || '').trim()).filter(Boolean))];
  if (!pedidos.length) return { stock: {}, desconocidos: [] };
  if (pedidos.length > TOPE_SKUS_CONSULTA) {
    throw Object.assign(
      new Error(`Se pueden consultar hasta ${TOPE_SKUS_CONSULTA} SKU por vez y llegaron ${pedidos.length}.`),
      { status: 400 },
    );
  }

  const variantes = await ProductVariant.findAll({
    where: { sku: { [Op.in]: pedidos } },
    include: [{ model: Product, as: 'producto', required: true, where: { businessId } }],
  });

  const locales = await localesQueAbastecenOnline(businessId);
  const cantidades = locales.length
    ? await cantidadesPublicables(businessId, locales, variantes)
    : new Map();

  const stock = {};
  // `.cantidad`, no el objeto: ver el comentario en `catalogo`.
  for (const v of variantes) stock[v.sku] = Number(cantidades.get(v.id)?.cantidad || 0);

  /*
   * Lo que no se encontró se devuelve aparte y NO como cero.
   *
   * Cero significa "no queda"; que el SKU no exista significa que la tienda
   * está publicando algo que acá no está, y esas dos cosas se arreglan en
   * lugares distintos. Devolver cero para las dos esconde la segunda.
   */
  const desconocidos = pedidos.filter((s) => !(s in stock));
  return { stock, desconocidos, generadoEn: new Date() };
}

/*
 * ── El color y el talle de una variante ───────────────────────────
 *
 * En Stocker una variante NO tiene campos 'color' ni 'talle': tiene dos pares
 * genéricos, variante1Nombre/variante1Valor y variante2Nombre/variante2Valor,
 * porque un negocio puede querer eje "Color"/"Talle" y otro "Sabor"/"Tamaño".
 *
 * Leerlos por el NOMBRE y no por la posición es lo correcto: hay productos con
 * un solo eje y no siempre es el mismo. El respaldo por posición existe para los
 * que tengan las etiquetas vacías.
 *
 * Y se recortan a propósito. La tienda valida el catálogo con un esquema que
 * acepta hasta 60 caracteres de color y 40 de talle, mientras acá la columna
 * admite 80: un valor más largo haría que la tienda descarte el catálogo ENTERO
 * y se quede sin productos, en vez de perder un adjetivo.
 */
const TOPE_COLOR = 60;
const TOPE_TALLE = 40;

const esEje = (nombre, palabras) => {
  const n = String(nombre || '').trim().toLowerCase();
  return palabras.some((p) => n.includes(p));
};

function ejesDe(v) {
  const pares = [
    { nombre: v.variante1Nombre, valor: v.variante1Valor },
    { nombre: v.variante2Nombre, valor: v.variante2Valor },
  ];
  const color = pares.find((p) => esEje(p.nombre, ['color']));
  const talle = pares.find((p) => esEje(p.nombre, ['talle', 'talla', 'tama', 'medida']));
  /*
   * Si las etiquetas no dicen nada, se cae al orden en que están cargadas, que
   * es el que usa el resto del sistema (ver depositoService).
   */
  const recortar = (x, tope) => {
    const s = x == null ? null : String(x).trim();
    return s ? s.slice(0, tope) : null;
  };
  return {
    color: recortar((color || pares[0]).valor, TOPE_COLOR),
    talle: recortar((talle || (color ? pares[1] : pares[1])).valor, TOPE_TALLE),
  };
}

/*
 * El precio, o nada.
 *
 * `precioService.precioMinorista` termina en `Number(...) || 0` porque para
 * cobrar un cero es un precio válido —una muestra, un regalo, un canje—. Para
 * publicar no: un producto al que nadie le cargó precio saldría a la vidriera en
 * cero y se vendería gratis. Acá "sin precio" tiene que viajar como null, para
 * que la plataforma pueda no publicarlo.
 */
function precioParaPublicar(calculado, variante, producto, campo) {
  const hayPropio = tieneValor(variante?.[campo]);
  const hayDelPadre = tieneValor(producto?.[campo]) && Number(producto[campo]) > 0;
  if (!hayPropio && !hayDelPadre) return null;
  return calculado;
}
/*
 * ── Qué le pasó a los pedidos que mandó la tienda ─────────────────
 *
 * La tienda necesita enterarse de lo que ocurre DESPUÉS de la respuesta del
 * POST: que el depósito despachó (y con qué seguimiento), que no encontró la
 * prenda, que el pedido se canceló. Con eso le manda el mail y el WhatsApp al
 * comprador.
 *
 * Pregunta la tienda en vez de avisar Stocker, igual que en el portal mayorista:
 * la tienda ya tiene reloj y reintentos escritos, y si se cae no se pierde nada
 * —cuando vuelve, pregunta desde donde quedó—. Un webhook perdido, en cambio, se
 * pierde callado.
 */

// Tope de lo que se devuelve por vuelta, para que una tienda que estuvo semanas
// sin preguntar no se traiga la tabla entera en una sola respuesta.
const TOPE_RESOLUCIONES = 500;

/*
 * El rezago del cursor, y por qué no puede ser cero.
 *
 * El cursor avanza hasta la última fila devuelta. Si se devolviera una fila cuya
 * transacción commiteó recién, otra que empezó antes y commitea un milisegundo
 * después quedaría con una `novedadEn` ANTERIOR al cursor y nunca se devolvería:
 * ese cambio se perdería para siempre. Con el rezago, para cuando la ventana se
 * abre ya commitearon todas las transacciones de ese instante —acá duran
 * milisegundos—.
 */
const REZAGO_MS = 5000;

/*
 * Qué cambió, en una palabra, derivada de los hechos y no guardada.
 *
 * El orden importa: un pedido cancelado que YA había salido existe —se cancela
 * y le queda `despachadoEn`—, y decirle "cancelado" a un cliente que tiene el
 * paquete en camino es peor que no decirle nada. Despachado gana.
 */
function queCambio(p) {
  if (p.despachadoEn) return 'despachado';
  if (p.estadoEnvio === 'con_faltante') return 'faltante';
  if (p.canceladoEn) return 'cancelado';
  return p.estado;
}

/**
 * Los cambios de los pedidos de una plataforma, en orden y sin perder ninguno.
 *
 * @param desde   el cursor de la vuelta anterior, o null para arrancar de ahora.
 * @param limite  cuántos como máximo.
 */
async function resoluciones({ businessId, plataforma, desde = null, limite = 100 }) {
  const { Op } = require('sequelize');
  const { PedidoPlataforma } = require('../models');

  const tope = Math.min(Math.max(Number(limite) || 100, 1), TOPE_RESOLUCIONES);
  const hasta = new Date(Date.now() - REZAGO_MS);

  /*
   * Sin cursor no se devuelve historia.
   *
   * Una tienda que pregunta por primera vez no quiere enterarse de los cambios
   * de los últimos seis meses y mandarle un mail al comprador de cada uno. Se le
   * da el cursor de ahora y desde la próxima vuelta ve lo nuevo.
   */
  if (!desde) return { cursor: cursorDe(hasta, 0), cambios: [] };

  const leido = leerCursor(desde);
  if (!leido) {
    const e = new Error('El cursor no se entiende. Mandá el que devolvió la vuelta anterior, o ninguno para empezar.');
    e.status = 400;
    throw e;
  }

  const filas = await PedidoPlataforma.findAll({
    where: {
      businessId,
      plataforma,
      novedadEn: { [Op.ne]: null, [Op.lte]: hasta },
      /*
       * Cursor compuesto: la fecha sola no alcanza.
       *
       * Dos pedidos pueden tener la MISMA `novedadEn` al milisegundo —un despacho
       * de varios paquetes del mismo envío lo hace—. Con un cursor de fecha sola,
       * o se repiten los dos en cada vuelta o se saltea el segundo. El id
       * desempata.
       */
      [Op.or]: [
        { novedadEn: { [Op.gt]: leido.en } },
        { novedadEn: leido.en, id: { [Op.gt]: leido.id } },
      ],
    },
    order: [['novedadEn', 'ASC'], ['id', 'ASC']],
    limit: tope,
  });

  const cambios = filas.map((p) => ({
    pedidoExterno: p.pedidoExterno,
    // La palabra, para decidir rápido.
    cambio: queCambio(p),
    /*
     * Y los hechos, porque una palabra sola miente.
     *
     * Las dos fechas viajan siempre: con un pedido cancelado que ya había salido,
     * sólo con la palabra la tienda le avisaría "cancelado" a alguien que tiene
     * el paquete en camino.
     */
    estado: p.estado,
    estadoEnvio: p.estadoEnvio || null,
    pagoEstado: p.pagoEstado || null,
    seguimiento: p.seguimiento || null,
    envioTipo: p.envioTipo || null,
    despachadoEn: p.despachadoEn || null,
    canceladoEn: p.canceladoEn || null,
    motivo: p.motivo || null,
    en: p.novedadEn,
  }));

  /*
   * El cursor sale de la última fila devuelta y NO del reloj: si saliera del
   * reloj y el tope cortó la lista, lo que quedó afuera se perdería.
   */
  const ultima = filas[filas.length - 1];
  return {
    cursor: ultima ? cursorDe(ultima.novedadEn, ultima.id) : desde,
    cambios,
    // Para que la tienda sepa que conviene volver a preguntar ya mismo.
    hayMas: filas.length === tope,
  };
}

// El cursor es opaco a propósito: así se le puede cambiar la forma sin romperle
// la integración a nadie.
const cursorDe = (fecha, id) => `${new Date(fecha).toISOString()}|${id}`;

function leerCursor(valor) {
  const partes = String(valor).split('|');
  if (partes.length !== 2) return null;
  const en = new Date(partes[0]);
  const id = Number(partes[1]);
  if (Number.isNaN(en.getTime()) || !Number.isInteger(id) || id < 0) return null;
  return { en, id };
}
module.exports = {
  catalogo, stockDeSkus, resoluciones,
  TOPE_SKUS_CONSULTA, TOPE_RESOLUCIONES, __queCambio: queCambio, __cursorDe: cursorDe,
  // Expuestas para probarlas sin depender de qué datos tenga la base de turno.
  __ejesDe: ejesDe, __precioParaPublicar: precioParaPublicar,
};
