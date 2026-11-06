const { Op } = require('sequelize');
const { Business, BusinessLocation, Client } = require('../models');
const tienda = require('./tiendaService');
const { localesQueAbastecenOnline } = require('./stockService');
const regla = require('./reglaMayoristaService');

/*
 * Lo que necesita un asistente con IA (un modelo local, por ejemplo) para
 * atender: encontrar productos escritos como los pide una persona, saber quién
 * le habla y la regla del precio mayorista para decirla.
 *
 * El modelo nunca decide si algo existe, cuánto hay o cuánto sale: lo pregunta
 * acá. Los precios y el stock son los mismos que ve la tienda propia
 * (tiendaService.catalogo), y los pedidos entran por la bandeja de siempre
 * (solicitudMayoristaService) para que una persona los acepte.
 */

const TOPE_PRODUCTOS = 10;
// Palabras que la gente escribe y que no dicen nada del producto.
const VACIAS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'en', 'con', 'para',
  'y', 'o', 'que', 'hay', 'tenes', 'tienen', 'tenés', 'busco', 'quiero', 'talle', 'color', 'por', 'favor']);

const normal = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/*
 * Sin el plural: "remeras" → "remera", y "pantalones" → "pantalon", "mujeres" →
 * "mujer", "colores" → "color" (con sólo sacar la s, "pantalone" no encontraba
 * "pantalón"). El -es sale sólo tras vocal y l, n, r, d, s o z, y en palabras
 * largas: "hombres", "nenes", "bebes", "verdes" y "pares" pierden nada más la s.
 */
const raiz = (p) => (p.length > 5 && /[aeiou][lnrdsz]es$/.test(p) ? p.slice(0, -2) : p.length > 3 && p.endsWith('s') ? p.slice(0, -1) : p);
const palabras = (t) => normal(t).split(/[^a-z0-9]+/).filter(Boolean);

/*
 * Lo que escribe la gente por lo que hay cargado: "caballero" es Hombre,
 * "nena" es Niños, "remería" es remera. Sólo sinónimos de verdad, la misma
 * prenda con otro nombre: remera, musculosa y top son prendas distintas, igual
 * que short y bermuda; y un estilo ("chupín", "jogger") no es sinónimo de
 * pantalón, porque pedir un chupín traería todos los pantalones. Lo Unisex
 * entra al pedir hombre o mujer (después de lo de ese género), pero pedir
 * unisex no trae lo de hombre. Afuera a propósito: "playera" (la ojota),
 * "camiseta" (la térmica o la de fútbol), "canguro" (también es riñonera).
 *
 * El sinónimo se compara por palabra entera: por comienzo, "male" encontraba
 * "Malena" y "calza" encuentra "Calzado". Por comienzo sigue sólo lo que
 * escribió la persona ("rem" encuentra "remera").
 */
const GRUPOS = [
  [['hombre', 'caballero', 'masculino', 'masculina', 'varon', 'senor'], ['unisex']],
  [['mujer', 'dama', 'femenino', 'femenina', 'senora'], ['unisex']],
  [['nino', 'nina', 'nene', 'nena', 'chico', 'chica', 'pibe', 'piba', 'kid', 'infantil']],
  [['remera', 'remeria', 'remeron', 'remerita']],
  [['calza', 'calzita', 'legging', 'leggin']],
  [['buzo', 'buzito', 'hoodie', 'sudadera']],
  [['campera', 'camperita', 'chaqueta', 'jacket']],
];
const SINONIMOS = new Map(); // palabra → la misma prenda o público con otro nombre
const ADEMAS = new Map(); // palabra → lo que entra además, después (Unisex)
for (const [grupo, ademas = []] of GRUPOS) {
  for (const p of grupo) {
    SINONIMOS.set(raiz(p), grupo.map(raiz));
    ADEMAS.set(raiz(p), ademas.map(raiz));
  }
}
// Las palabras de género o edad: solas no eligen el tipo de prenda (ver buscarProductos).
const DE_PUBLICO = new Set(GRUPOS.slice(0, 3).flatMap(([g]) => g.map(raiz)));

/*
 * ¿La variante tiene todas las palabras buscadas?
 *
 * Por palabra entera y no por pedazo de texto: "m" (el talle) no puede
 * encontrar "remera" ni "mom". Las palabras de tres letras o más sí pueden ser
 * el comienzo ("rem" encuentra "remera").
 */
function coincide(buscadas, texto, { sinAdemas = false } = {}) {
  const propias = palabras(texto).map(raiz);
  return buscadas.every((b) => propias.some((p) => (b.length >= 3 ? p.startsWith(b) : p === b))
    || [...(SINONIMOS.get(b) || []), ...(sinAdemas ? [] : ADEMAS.get(b) || [])].some((s) => propias.includes(s)));
}

/** La regla mayorista del local que abastece lo online, con su texto para decirla. */
async function reglaMayorista(businessId) {
  const [local] = await localesQueAbastecenOnline(businessId);
  const r = regla.normalizar(local || regla.POR_DEFECTO);
  return { ...r, texto: regla.describir(r) };
}

/*
 * Lo fijo del negocio, para que el asistente lo sepa desde el arranque sin
 * gastar una consulta por charla: cómo se llama (así se ve a qué cuenta apunta
 * la credencial), los locales que atienden público y la regla mayorista.
 */
async function negocio(businessId) {
  const [b, locales, mayorista] = await Promise.all([
    Business.findByPk(businessId, { attributes: ['nombreNegocio'] }),
    // Los depósitos y la tienda online no atienden gente: no se le pueden dar a un cliente.
    BusinessLocation.findAll({
      where: { businessId, activo: true, tipo: ['local', 'feria'] },
      attributes: ['nombre', 'direccion', 'telefono'],
      order: [['id', 'ASC']],
    }),
    reglaMayorista(businessId),
  ]);
  return {
    nombre: b?.nombreNegocio || null,
    locales: locales.map((l) => ({ nombre: l.nombre, direccion: l.direccion, telefono: l.telefono || null })),
    reglaMayorista: mayorista,
  };
}

async function buscarProductos({ businessId, texto, limite = TOPE_PRODUCTOS }) {
  const pedidas = palabras(texto).filter((p) => !VACIAS.has(p)).map(raiz);
  const tope = Math.min(Math.max(1, Number(limite) || TOPE_PRODUCTOS), TOPE_PRODUCTOS);
  /*
   * El stock de todos los locales que venden, no sólo de los que abastecen lo
   * online: el pedido del asistente lo acepta una persona y sale de su local.
   * Con sólo los online, Isuwaya mostraba en cero lo que tenía en su local más
   * grande y el asistente decía que no había. Depósitos y ferias no venden.
   */
  const locales = await tienda.localesQueVenden(businessId);
  const [catalogo, mayorista] = await Promise.all([tienda.catalogo({ businessId, locales, conPacks: true }), reglaMayorista(businessId)]);
  // OFERTA no es un tipo de prenda: son combos que el asistente no ofrece (el portal tampoco los publica).
  catalogo.productos = catalogo.productos.filter((p) => normal(p.categoria) !== 'oferta');

  /*
   * Las palabras que no están en ningún producto no filtran. La gente escribe
   * "un buzo para mi local" o "algo lindo": exigiendo todas, "local" dejaba
   * afuera a todos los buzos. Si ninguna palabra está en el catálogo, no hay
   * nada que mostrar ("heladera samsung" sigue sin traer nada).
   */
  const textoProducto = (p) => `${p.titulo} ${p.categoria} ${p.genero} ${p.skuAgrupador}`;
  const textoDe = (p, v) => `${textoProducto(p)} ${v.sku} ${Object.values(v).join(' ')}`;
  const buscadas = pedidas.filter((b) => catalogo.productos.some((p) => p.variantes.some((v) => coincide([b], textoDe(p, v)))));
  if (pedidas.length && !buscadas.length) {
    return { productos: [], reglaMayorista: mayorista, sinLocalesOnline: catalogo.sinLocalesOnline };
  }

  /*
   * Se elige el producto y se devuelve entero, con todos sus colores y talles:
   * si no hay en el color pedido, el asistente ofrece los que sí hay (y el
   * azul puede estar cargado como "Francia"). Eligen las palabras del producto
   * (título, categoría, género); las de color o talle sólo ponen primero al
   * que tiene eso en stock.
   */
  const nombra = (b, p) => coincide([b], textoProducto(p));
  const deProducto = buscadas.filter((b) => catalogo.productos.some((p) => nombra(b, p)));
  const deVariante = buscadas.filter((b) => !deProducto.includes(b));
  // Una palabra que nombra pocos productos pesa más: "loan" es uno solo y "cuello" son muchos; sin esto el Loan quedaba fuera del tope.
  const cuantos = new Map(deProducto.map((b) => [b, catalogo.productos.filter((p) => nombra(b, p)).length]));
  const candidatos = catalogo.productos
    .map((p) => {
      const vs = p.variantes.filter((v) => v.activo);
      const nombradas = deProducto.filter((b) => nombra(b, p));
      return {
        p,
        vs,
        todas: nombradas.length === deProducto.length,
        // Lo del género pedido antes que lo Unisex: con el tope, lo Unisex dejaba afuera remeras de hombre.
        directas: nombradas.filter((b) => coincide([b], textoProducto(p), { sinAdemas: true })).length,
        // Sin todas las palabras, una de género sola no trae otra prenda ("chalecos de mujer" traía remeras de mujer).
        deTipo: nombradas.some((b) => !DE_PUBLICO.has(b)) || deProducto.every((b) => DE_PUBLICO.has(b)),
        puntaje: nombradas.reduce((s, b) => s + 1 / cuantos.get(b), 0),
        justo: !deVariante.length || vs.some((v) => v.publicable > 0 && coincide(deVariante, textoDe(p, v))),
      };
    })
    .filter((x) => x.vs.length && (deProducto.length ? x.puntaje > 0 : x.justo));
  /*
   * Si alguno tiene todas las palabras del producto, van ésos. Si no, las
   * palabras pueden ser de productos distintos ("cuello v loan" son dos) y va
   * cada uno que nombre alguna, primero el de la palabra más específica.
   */
  const conTodas = candidatos.filter((x) => x.todas);
  const elegidos = conTodas.length
    ? conTodas.sort((a, b) => (b.directas - a.directas) || (b.justo - a.justo))
    : candidatos.filter((x) => x.deTipo).sort((a, b) => (b.puntaje - a.puntaje) || (b.directas - a.directas) || (b.justo - a.justo));

  const productos = elegidos.slice(0, tope).map(({ p, vs }) => ({
    // La clave del producto en el portal mayorista, donde el asistente deja el pedido.
    skuAgrupador: p.skuAgrupador,
    titulo: p.titulo, categoria: p.categoria, genero: p.genero,
    precioMayorista: p.precioMayorista, precioMinorista: p.precioMinorista,
    variantes: vs.map(({ id, activo, publicable, ...resto }) => ({ ...resto, disponible: publicable })),
  }));
  return { productos, reglaMayorista: mayorista, sinLocalesOnline: catalogo.sinLocalesOnline };
}

/*
 * Quién es el que escribe: por teléfono, CUIT o mail.
 *
 * Lo mínimo para atenderlo (nombre, CUIT y si es mayorista), no su ficha
 * entera: es lo que el asistente necesita y nada que no deba repetir en un chat.
 * El teléfono se compara por los últimos 8 dígitos: el mismo número llega como
 * +54 9 11…, 011… o 15… según quién lo escriba.
 */
async function buscarClientes({ businessId, telefono, cuit, email }) {
  const digitos = (t) => String(t || '').replace(/\D/g, '');
  const conCuit = digitos(cuit).length === 11 ? digitos(cuit) : null;
  const conEmail = String(email || '').includes('@') ? String(email).trim().toLowerCase() : null;
  const o = [];
  // Con y sin guiones: hay fichas viejas cargadas de las dos formas.
  if (conCuit) o.push({ cuit: [conCuit, `${conCuit.slice(0, 2)}-${conCuit.slice(2, 10)}-${conCuit.slice(10)}`] });
  if (conEmail) o.push({ email: conEmail });
  const ultimos = digitos(telefono).slice(-8);
  if (ultimos.length === 8) {
    // Una primera criba en la base por los últimos 4; el resto se compara acá sin el formato.
    const cola = `%${ultimos.slice(-4)}`;
    o.push({ telefono: { [Op.like]: cola } }, { whatsapp: { [Op.like]: cola } });
  }
  if (!o.length) return [];
  const filas = await Client.findAll({
    where: { businessId, [Op.or]: o },
    attributes: ['id', 'nombre', 'apellido', 'cuit', 'email', 'telefono', 'whatsapp', 'tipo'],
    limit: 50,
  });
  const esEste = (c) => (conCuit && digitos(c.cuit) === conCuit)
    || (conEmail && String(c.email || '').trim().toLowerCase() === conEmail)
    || (ultimos.length === 8 && [c.telefono, c.whatsapp].some((t) => digitos(t).endsWith(ultimos)));
  return filas
    .filter(esEste)
    .slice(0, 5)
    .map((c) => ({ id: c.id, nombre: c.nombre, apellido: c.apellido, cuit: c.cuit, tipo: c.tipo, mayorista: c.tipo === 'mayorista' }));
}

module.exports = {
  negocio, buscarProductos, buscarClientes, reglaMayorista,
  // Para probar sin base: el pedido pasa por lo mismo que en buscarProductos.
  __coincide: (pedido, texto) => coincide(palabras(pedido).filter((p) => !VACIAS.has(p)).map(raiz), texto), __palabras: palabras,
};
