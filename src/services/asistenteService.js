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
// "remeras" encuentra "remera": se compara sin la s final de las palabras largas.
const raiz = (p) => (p.length > 3 && p.endsWith('s') ? p.slice(0, -1) : p);
const palabras = (t) => normal(t).split(/[^a-z0-9]+/).filter(Boolean);

/*
 * ¿La variante tiene todas las palabras buscadas?
 *
 * Por palabra entera y no por pedazo de texto: "m" (el talle) no puede
 * encontrar "remera" ni "mom". Las palabras de tres letras o más sí pueden ser
 * el comienzo ("rem" encuentra "remera").
 */
function coincide(buscadas, texto) {
  const propias = palabras(texto).map(raiz);
  return buscadas.every((b) => propias.some((p) => (b.length >= 3 ? p.startsWith(b) : p === b)));
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
  const locales = await BusinessLocation.findAll({
    where: { businessId, activo: true, tipo: 'local' }, attributes: ['id', 'nombre'], order: [['id', 'ASC']],
  });
  const [catalogo, mayorista] = await Promise.all([tienda.catalogo({ businessId, locales }), reglaMayorista(businessId)]);

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
    ? conTodas.sort((a, b) => b.justo - a.justo)
    : candidatos.sort((a, b) => (b.puntaje - a.puntaje) || (b.justo - a.justo));

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

module.exports = { negocio, buscarProductos, buscarClientes, reglaMayorista, __coincide: coincide, __palabras: palabras };
