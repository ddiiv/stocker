/*
 * Administrar desde Stocker las publicaciones que ya están en Mercado Libre, y
 * calcular precios con lo que ML cobra de verdad.
 *
 * Dos reglas valen para todo lo de acá:
 *   - Ningún id que llegue del navegador se escribe sin releerlo y ver que el
 *     vendedor es la cuenta conectada de ESE negocio (itemsPropios).
 *   - Si ML no contesta un costo, no se reemplaza por los porcentajes fijos de
 *     los parámetros: se dice que no se pudo. Un precio calculado con un costo
 *     inventado es plata perdida en cada venta.
 *
 * Lo que entregas/ml-api-publicar.md no confirma va con "shortcut:" y el error
 * de ML se muestra tal cual.
 */

const { Op } = require('sequelize');
const { MercadoLibreAccount, MercadoLibreLink } = require('../models');
const stockService = require('./stockService');
const publicables = require('./stockPublicableService');
const ml = require('./mercadolibreService');
const pub = require('./mercadolibrePublicarService');
const { ejesDe } = require('./tiendaService');

const ML_API = 'https://api.mercadolibre.com';
const TTL_LISTADO_MS = 60 * 1000;
const TOPE_ITEMS = 200;
const TOPE_VISTA_PRECIOS = 40; // cada precio sugerido son hasta 60 pedidos a ML: más no entra en un pedido HTTP
const TOPE_CAMBIO_PCT = 60;
const TOPE_CONSULTAS = 30;
const TOPE_DESCRIPCION = 50000;
// Las campañas de cuotas que cambian el cargo (ml-api-publicar.md, sección 6).
const CAMPANAS = ['3x_campaign', '9x_campaign', '12x_campaign', 'pcj-co-funded'];

const error400 = (mensaje, detalles) => Object.assign(new Error(mensaje), { status: 400, detalles });
const sinCosto = (mensaje) => Object.assign(new Error(`No se pudo calcular el costo con Mercado Libre: ${mensaje}`), { status: 502, detalles: { codigo: 'SIN_COSTO_ML' } });
const r2 = (n) => Math.round(n * 100) / 100;
const numero = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
const dormir = (ms) => new Promise((listo) => setTimeout(listo, ms));

/*
 * Un rechazo de ML fuera de los PUT por ítem (leer el catálogo, renovar el
 * token) llega sin `status` y el manejador lo tapaba con "Error interno del
 * servidor": acá sale con el pedido que falló y el texto de ML.
 */
function conMotivo(e) {
  if (e.status || !(e.isAxiosError || e.response)) return e;
  // Sin la query: no aporta y puede llevar datos.
  const pedido = `${String(e.config?.method || '').toUpperCase()} ${String(e.config?.url || '').replace(ML_API, '').split('?')[0]}`.trim();
  return Object.assign(new Error(`Mercado Libre rechazó un pedido (${pedido || 'sin datos'}). ${pub.textoDeError(e)}`), { status: 502 });
}

async function conectar(businessId) {
  const cuenta = await MercadoLibreAccount.findOne({ where: { businessId } });
  if (!cuenta) throw error400('No hay una cuenta de MercadoLibre conectada.');
  const headers = { Authorization: `Bearer ${await ml.tokenValido(cuenta)}` };
  return { cuenta, headers, params: await pub.parametros(businessId) };
}

function olvidar(businessId, cuenta) {
  pub.olvidar(`admin:${businessId}:${cuenta.mlUserId}`);
  pub.olvidar(`publicados:${businessId}`);
}

// ── De quién es cada publicación ─────────────────────────────────

function idsLimpios(lista, tope = TOPE_ITEMS) {
  if (!Array.isArray(lista) || !lista.length) throw error400('Elegí al menos una publicación.');
  const ids = [...new Set(lista.map((x) => String(x ?? '').trim().toUpperCase()))];
  if (ids.some((id) => !/^MLA\d+$/.test(id))) throw error400('Hay un id de publicación que no es válido (tiene que ser como MLA123456789).');
  if (ids.length > tope) throw error400(`Se pueden tocar hasta ${tope} publicaciones por vez.`);
  return ids;
}

const esDeLaCuenta = (item, cuenta) => Boolean(cuenta.mlUserId) && String(item?.seller_id ?? '') === String(cuenta.mlUserId);

/*
 * Los ítems recién leídos, y sólo si TODOS son de la cuenta: con uno ajeno o
 * ilegible no se escribe ninguno.
 */
async function itemsPropios(cuenta, headers, lista, tope) {
  const ids = idsLimpios(lista, tope);
  const leidos = new Map((await ml.traerItems(ids, headers)).map((i) => [String(i.id), i]));
  const ajenos = ids.filter((id) => !esDeLaCuenta(leidos.get(id), cuenta));
  if (ajenos.length) {
    throw Object.assign(new Error(`Estas publicaciones no son de tu cuenta de Mercado Libre (o no se pudieron leer): ${ajenos.join(', ')}.`), { status: 403 });
  }
  return ids.map((id) => leidos.get(id));
}

// ── El cruce con Stocker ─────────────────────────────────────────

/** Para una publicación (o variación): el vínculo manual manda; si no hay, el SKU. */
async function cruceDe(businessId) {
  const [links, variantes] = await Promise.all([
    MercadoLibreLink.findAll({ where: { businessId } }),
    publicables.variantesPublicables(businessId, { soloActivas: true }),
  ]);
  const porSku = new Map(variantes.map((v) => [v.sku, v]));
  const manual = new Map(links.map((l) => [`${l.mlItemId}:${l.mlVariationId || ''}`, l.sku]));
  const de = (item, variacion = null) => {
    const sku = manual.get(`${item.id}:${variacion?.id ?? ''}`) || ml.skuDe(variacion || item);
    return { sku: sku || null, variante: (sku && porSku.get(sku)) || null };
  };
  return { links, variantes, de };
}

const costoDe = (v) => {
  if (!v) return null;
  const c = Number(v.costo) > 0 ? Number(v.costo) : Number(v.producto?.costo);
  return c > 0 ? c : null;
};

// ── Mis publicaciones ────────────────────────────────────────────

const valorDe = (atributos, id) => {
  const a = (atributos || []).find((x) => x.id === id);
  const nombre = a?.value_name ?? a?.values?.[0]?.name;
  return a && nombre != null ? { value_id: a.value_id && a.value_id !== '-1' ? String(a.value_id) : null, value_name: String(nombre) } : null;
};

function filasDeItem(item, cruce) {
  return (item.variations?.length ? item.variations : [null]).map((v) => {
    const { sku, variante } = cruce.de(item, v);
    const atributos = v ? [...(v.attribute_combinations || []), ...(v.attributes || [])] : item.attributes;
    const color = valorDe(atributos, 'COLOR');
    const ejes = variante ? ejesDe(variante) : { color: null, talle: null };
    const precio = v?.price ?? item.price ?? null;
    const original = item.original_price;
    return {
      itemId: String(item.id), mlVariationId: v ? String(v.id) : null, userProductId: v?.user_product_id || item.user_product_id || null,
      sku, color: color?.value_name ?? null, colorValueId: color?.value_id ?? null, talle: valorDe(atributos, 'SIZE')?.value_name ?? null,
      precio, precioOriginal: original != null && original > precio ? original : null,
      stockMl: (v ? v.available_quantity : item.available_quantity) ?? null,
      estado: item.status || null, subEstados: [].concat(item.sub_status || []),
      tipo: item.listing_type_id || null, tipoNombre: ml.NOMBRE_TIPO[item.listing_type_id] || null,
      catalogo: Boolean(item.catalog_listing), full: item.shipping?.logistic_type === 'fulfillment',
      link: item.permalink || ml.enlaceDe(item.id),
      productId: variante?.producto?.id ?? null, productoTitulo: variante?.producto?.titulo ?? null,
      productoSku: variante?.producto?.skuAgrupador ?? null, variantId: variante?.id ?? null,
      colorStocker: ejes.color, talleStocker: ejes.talle,
    };
  });
}

/*
 * Las publicaciones agrupadas por producto: en User Products por family_name
 * (y categoría: el mismo nombre en dos categorías son dos familias); en el
 * modelo viejo cada ítem es su grupo. Las finalizadas y las ajenas (un vínculo
 * manual puede apuntar a cualquier id) quedan afuera.
 */
function agrupar(publicaciones, cruce, cuenta) {
  const grupos = new Map();
  for (const item of publicaciones) {
    if (item.status === 'closed' || !esDeLaCuenta(item, cuenta)) continue;
    const clave = item.family_name ? `f:${item.category_id}:${item.family_name}` : `i:${item.id}`;
    if (!grupos.has(clave)) {
      grupos.set(clave, {
        clave, nombre: item.family_name || item.title || String(item.id), familyName: item.family_name || null,
        modelo: item.family_name ? 'user-products' : 'clasico', categoriaId: item.category_id || null, variantes: [],
      });
    }
    grupos.get(clave).variantes.push(...filasDeItem(item, cruce));
  }
  return [...grupos.values()];
}

/*
 * Los problemas de un grupo. El stock sólo se compara donde la sincronización
 * lo escribe (`sincroniza`): a las duplicadas del mismo SKU las deja en cero a
 * propósito, y eso no es un problema.
 */
function problemasDe(filas) {
  const salida = [];
  const sumar = (codigo, mensaje, afectadas) => {
    if (afectadas.length) salida.push({ codigo, mensaje, itemIds: [...new Set(afectadas.map((f) => f.itemId))] });
  };
  sumar('SIN_VINCULAR', 'Hay variantes sin vincular a un producto de Stocker.', filas.filter((f) => !f.variantId));

  const porColor = new Map();
  for (const f of filas) {
    if (!f.productId || !f.colorStocker || !f.color) continue;
    const k = `${f.productId}:${pub.claveColor(f.colorStocker)}`;
    if (!porColor.has(k)) porColor.set(k, []);
    porColor.get(k).push(f);
  }
  for (const lista of porColor.values()) {
    const distintos = new Map(lista.map((f) => [pub.claveColor(f.color), f.color]));
    // Con el mismo value_id ML lo toma como un solo color aunque el nombre difiera.
    const mismoId = lista.every((f) => f.colorValueId && f.colorValueId === lista[0].colorValueId);
    if (distintos.size > 1 && !mismoId) {
      sumar('COLOR_REPARTIDO', `El color ${lista[0].colorStocker} figura en ML como ${[...distintos.values()].map((x) => `"${x}"`).join(' y ')}.`, lista);
    }
  }

  const porCombinacion = new Map();
  for (const f of filas) {
    if (!f.color && !f.talle) continue;
    // Con otro tipo de publicación (o el par de catálogo) es otra condición de venta del mismo producto: es legítimo.
    const k = JSON.stringify([pub.claveColor(f.color), pub.claveColor(f.talle), f.tipo, f.catalogo]);
    if (!porCombinacion.has(k)) porCombinacion.set(k, []);
    porCombinacion.get(k).push(f);
  }
  for (const lista of porCombinacion.values()) {
    if (lista.length > 1) sumar('REPETIDA', `${[lista[0].color, lista[0].talle].filter(Boolean).join(' / ')} está publicado ${lista.length} veces con el mismo tipo de publicación.`, lista);
  }

  const conStock = filas.filter((f) => f.sincroniza && f.stockStocker != null);
  sumar('PAUSADA_CON_STOCK', 'Hay variantes pausadas que tienen stock en Stocker.', conStock.filter((f) => f.estado === 'paused' && f.stockStocker > 0));
  // En Full el stock lo maneja ML.
  sumar('STOCK_DISTINTO', 'El stock de Mercado Libre no coincide con el publicable de Stocker.', conStock.filter((f) => !f.full && f.stockMl !== f.stockStocker));
  return salida;
}

const buscable = (g) => pub.claveColor([g.nombre, ...g.variantes.flatMap((v) => [v.itemId, v.sku, v.color, v.talle, v.productoTitulo, v.productoSku])].filter(Boolean).join(' '));

async function leerGrupos(businessId, cuenta, { fresco = false } = {}) {
  const clave = `admin:${businessId}:${cuenta.mlUserId}`;
  if (fresco) pub.olvidar(clave);
  const [destinos, cruce] = await Promise.all([
    pub.conCache(clave, TTL_LISTADO_MS, () => ml.destinosDeLaCuenta(cuenta, businessId)),
    cruceDe(businessId),
  ]);
  return { destinos, cruce, grupos: agrupar(destinos.publicaciones, cruce, cuenta) };
}

async function listar(businessId, { buscar = '', conProblemas = false, pagina = 1, porPagina = 20, fresco = false } = {}) {
  const { cuenta } = await conectar(businessId);
  const { destinos, cruce, grupos } = await leerGrupos(businessId, cuenta, { fresco });
  const locales = await stockService.localesQueAbastecenOnline(businessId);
  const cantidades = locales.length ? await publicables.cantidadesPublicables(businessId, locales, cruce.variantes) : null;
  for (const g of grupos) {
    for (const f of g.variantes) {
      f.stockStocker = cantidades && f.variantId ? (cantidades.get(f.variantId)?.cantidad || 0) : null;
      const asignada = f.sku ? destinos.porSku.get(f.sku) : null;
      f.sincroniza = Boolean(asignada) && ((asignada.mlItemId === f.itemId && String(asignada.mlVariationId || '') === String(f.mlVariationId || ''))
        || Boolean(f.userProductId && asignada.userProductId === f.userProductId));
    }
    g.problemas = problemasDe(g.variantes);
  }
  grupos.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es') || a.clave.localeCompare(b.clave));
  const texto = pub.claveColor(buscar);
  const filtrados = grupos.filter((g) => (!conProblemas || g.problemas.length) && (!texto || buscable(g).includes(texto)));
  const tam = Math.min(Math.max(Math.trunc(Number(porPagina)) || 20, 1), 100);
  const paginas = Math.max(1, Math.ceil(filtrados.length / tam));
  const pag = Math.min(Math.max(Math.trunc(Number(pagina)) || 1, 1), paginas);
  return {
    grupos: filtrados.slice((pag - 1) * tam, pag * tam),
    total: filtrados.length, pagina: pag, porPagina: tam, paginas,
    resumen: { grupos: grupos.length, publicaciones: new Set(grupos.flatMap((g) => g.variantes.map((v) => v.itemId))).size, conProblemas: grupos.filter((g) => g.problemas.length).length },
    sinLugarOnline: !locales.length,
  };
}

// ── Descripción ──────────────────────────────────────────────────

const urlDescripcion = (id) => `${ML_API}/items/${id}/description`;

async function leerDescripcion(businessId, itemId) {
  const { cuenta, headers } = await conectar(businessId);
  const [item] = await itemsPropios(cuenta, headers, [itemId]);
  try {
    const { data } = await pub.con429(() => ml.httpML.get(urlDescripcion(item.id), { headers }));
    return { itemId: String(item.id), texto: data?.plain_text || data?.text || '' };
  } catch (e) {
    if (e.response?.status === 404) return { itemId: String(item.id), texto: '' };
    throw Object.assign(new Error(pub.textoDeError(e)), { status: 502 });
  }
}

/** El mismo texto a uno o a todo el grupo. Cada ítem es independiente: un error no frena al resto. */
async function guardarDescripcion(businessId, { itemIds, texto } = {}) {
  const plano = String(texto ?? '').replace(/\r\n?/g, '\n').trim();
  if (!plano) throw error400('La descripción no puede quedar vacía.');
  if (plano.length > TOPE_DESCRIPCION) throw error400(`La descripción no puede pasar de ${TOPE_DESCRIPCION} caracteres.`);
  const { cuenta, headers } = await conectar(businessId);
  const items = await itemsPropios(cuenta, headers, itemIds);
  const resultados = [];
  for (const { id } of items) {
    const cuerpo = { plain_text: plano };
    try {
      try {
        await pub.con429(() => ml.httpML.put(`${urlDescripcion(id)}?api_version=2`, cuerpo, { headers }));
      } catch (e) {
        if (e.response?.status !== 404) throw e;
        // shortcut: que el PUT dé 404 cuando todavía no hay descripción no está confirmado; si da otra cosa, sale el error de ML.
        await pub.con429(() => ml.httpML.post(urlDescripcion(id), cuerpo, { headers }));
      }
      resultados.push({ itemId: String(id), ok: true });
    } catch (e) {
      resultados.push({ itemId: String(id), ok: false, error: pub.textoDeError(e) });
    }
  }
  return { cambiadas: resultados.filter((r) => r.ok).length, fallaron: resultados.filter((r) => !r.ok).length, resultados };
}

// ── SKU y vínculo ────────────────────────────────────────────────
/*
 * Dice a qué variante de Stocker corresponde una publicación (o una variación
 * suya). El vínculo queda en Stocker, que es lo que usa la sincronización; con
 * `escribirEnMl` además se le escribe el SKU en Mercado Libre.
 *
 * Cada variante tiene UN vínculo: si ya está publicada en otra, la
 * sincronización va a escribirle a la nueva y dejar la otra en 0. Por eso eso
 * se confirma aparte (409 SKU_EN_OTRA).
 */
async function vincular(businessId, { itemId, mlVariationId = null, variantId, escribirEnMl = false, confirmado = false } = {}) {
  const { cuenta, headers } = await conectar(businessId);
  const [item] = await itemsPropios(cuenta, headers, [itemId]);
  const idItem = String(item.id);
  const idVariacion = mlVariationId ? String(mlVariationId) : null;
  const variaciones = item.variations || [];
  if (idVariacion ? !variaciones.some((v) => String(v.id) === idVariacion) : variaciones.length) {
    throw error400('Esa variación no es de la publicación. Actualizá la lista y probá de nuevo.');
  }
  const { cruce, destinos } = await leerGrupos(businessId, cuenta, { fresco: true });
  const variante = cruce.variantes.find((v) => v.id === Number(variantId));
  if (!variante) throw error400('Esa variante no está en Stocker (o está dada de baja).');
  const sku = variante.sku;
  const actual = destinos.porSku.get(sku);
  if (!confirmado && actual && !(actual.mlItemId === idItem && String(actual.mlVariationId || '') === String(idVariacion || ''))) {
    throw Object.assign(new Error(`El SKU ${sku} ya está en la publicación ${actual.mlItemId}. Si seguís, el stock se manda a ${idItem} y la otra puede quedar en 0.`),
      { status: 409, detalles: { codigo: 'SKU_EN_OTRA' } });
  }
  // La publicación pasa a ser de este SKU: el vínculo que tuviera con otro se va.
  await MercadoLibreLink.destroy({ where: { businessId, mlItemId: idItem, mlVariationId: idVariacion, sku: { [Op.ne]: sku } } });
  const valores = { businessId, sku, mlItemId: idItem, mlVariationId: idVariacion, titulo: item.title || item.family_name || null };
  const [link, nuevo] = await MercadoLibreLink.findOrCreate({ where: { businessId, sku }, defaults: valores });
  if (!nuevo) {
    // El descuento era de la publicación anterior: no se arrastra a otra.
    await link.update({ ...valores, ...(link.mlItemId !== idItem ? { descuentoPct: null, descuentoHasta: null } : {}), ultimoError: null });
  }

  let enMl = null;
  if (escribirEnMl) {
    const atributo = { id: 'SELLER_SKU', value_name: sku };
    // En el modelo viejo van TODAS las variaciones: la que no se manda, ML la borra.
    const cuerpo = idVariacion
      ? { variations: variaciones.map((v) => (String(v.id) === idVariacion ? { id: v.id, attributes: [atributo] } : { id: v.id })) }
      : { attributes: [atributo] };
    try {
      await pub.con429(() => ml.httpML.put(`${ML_API}/items/${idItem}`, cuerpo, { headers }));
      enMl = { ok: true };
    } catch (e) {
      // shortcut: que ML deje cambiar el SKU de lo ya publicado no está confirmado; el vínculo de Stocker alcanza para sincronizar.
      enMl = { ok: false, error: pub.textoDeError(e) };
    }
  }
  olvidar(businessId, cuenta);
  ml.marcarParaSync(businessId, sku);
  return { sku, itemId: idItem, mlVariationId: idVariacion, enMl };
}

/** Quita el vínculo manual de una publicación: vuelve a mandar el SKU que tenga escrito en ML. */
async function desvincular(businessId, { itemId, mlVariationId = null } = {}) {
  const { cuenta, headers } = await conectar(businessId);
  const [item] = await itemsPropios(cuenta, headers, [itemId]);
  const quitados = await MercadoLibreLink.destroy({ where: { businessId, mlItemId: String(item.id), mlVariationId: mlVariationId ? String(mlVariationId) : null } });
  olvidar(businessId, cuenta);
  return { quitados };
}

// ── Nombre ───────────────────────────────────────────────────────

async function largoMaximo(categoriaId, headers) {
  try {
    const { data } = await ml.httpML.get(`${ML_API}/categories/${categoriaId}`, { headers });
    // shortcut: dónde viene max_title_length en la respuesta no está confirmado; sin él vale el de remeras (60).
    return numero(data?.settings?.max_title_length ?? data?.max_title_length) || pub.TOPE_FAMILY_NAME;
  } catch {
    return pub.TOPE_FAMILY_NAME;
  }
}

/*
 * Cambia family_name (o title en el modelo viejo).
 *
 * Se exige el grupo ENTERO y se corta en el primer error: una familia a medio
 * renombrar queda partida en dos publicaciones, y seguir mandando después de un
 * rechazo sólo agranda la partición.
 *
 * shortcut: que ML permita renombrar (sobre todo con ventas) no está
 * confirmado: se muestra su error tal cual.
 */
async function renombrar(businessId, { itemIds, nombre } = {}) {
  const ids = idsLimpios(itemIds);
  const nuevo = String(nombre ?? '').trim().replace(/\s+/g, ' ');
  if (!nuevo) throw error400('Escribí el nombre nuevo.');
  const { cuenta, headers } = await conectar(businessId);
  const items = await itemsPropios(cuenta, headers, ids);
  const { grupos } = await leerGrupos(businessId, cuenta, { fresco: true });
  const grupo = grupos.find((g) => g.variantes.some((v) => v.itemId === ids[0]));
  const delGrupo = new Set((grupo?.variantes || []).map((v) => v.itemId));
  if (delGrupo.size !== ids.length || ids.some((id) => !delGrupo.has(id))) {
    throw error400('El nombre se cambia al grupo entero (si no, la publicación queda partida en dos). Actualizá la lista y probá de nuevo.');
  }
  const maximo = await largoMaximo(grupo.categoriaId, headers);
  if (nuevo.length > maximo) throw error400(`El nombre tiene ${nuevo.length} caracteres y esta categoría admite ${maximo}.`);

  const resultados = [];
  let cortado = false;
  for (const item of items) {
    const itemId = String(item.id);
    const campo = item.family_name ? 'family_name' : 'title';
    if (cortado) { resultados.push({ itemId, estado: 'no-intentada' }); continue; }
    if (item[campo] === nuevo) { resultados.push({ itemId, estado: 'sin-cambios' }); continue; }
    try {
      const { data } = await pub.con429(() => ml.httpML.put(`${ML_API}/items/${itemId}`, { [campo]: nuevo }, { headers }));
      // Un 200 que deja el nombre anterior es un rechazo callado.
      if (data?.[campo] != null && data[campo] === item[campo]) throw new Error('Mercado Libre contestó bien pero el nombre no cambió.');
      resultados.push({ itemId, estado: 'cambiada' });
    } catch (e) {
      resultados.push({ itemId, estado: 'error', error: pub.textoDeError(e) });
      cortado = true;
    }
  }
  olvidar(businessId, cuenta);
  const n = (estado) => resultados.filter((r) => r.estado === estado).length;
  const cambiadas = n('cambiada') + n('sin-cambios');
  return {
    cortado, total: resultados.length, cambiadas, sinCambiar: resultados.length - cambiadas, resultados,
    mensaje: cortado
      ? `Se cortó en el primer error: quedaron ${cambiadas} publicación(es) con el nombre nuevo y ${resultados.length - cambiadas} sin cambiar.`
      : `Las ${cambiadas} publicación(es) quedaron con el nombre nuevo.`,
  };
}

// ── Pausar y reactivar ───────────────────────────────────────────

async function cambiarEstado(businessId, { itemIds, estado } = {}) {
  if (!['paused', 'active'].includes(estado)) throw error400('El estado tiene que ser "paused" o "active".');
  const { cuenta, headers } = await conectar(businessId);
  const items = await itemsPropios(cuenta, headers, itemIds);
  const resultados = [];
  if (estado === 'active') {
    // El mismo camino que la sincronización: sin stock no reactiva, porque ML la volvería a pausar. Toma de a 50.
    for (let i = 0; i < items.length; i += 50) {
      const r = await ml.reactivar(businessId, { mlItemIds: items.slice(i, i + 50).map((x) => String(x.id)) });
      resultados.push(...r.resultados.map((x) => ({ itemId: x.mlItemId, ok: x.ok, yaEstaba: Boolean(x.yaEstaba), error: x.error })));
    }
  } else {
    for (const item of items) {
      const itemId = String(item.id);
      if (item.status === 'paused') { resultados.push({ itemId, ok: true, yaEstaba: true }); continue; }
      try {
        await pub.con429(() => ml.httpML.put(`${ML_API}/items/${itemId}`, { status: 'paused' }, { headers }));
        resultados.push({ itemId, ok: true, yaEstaba: false });
      } catch (e) {
        resultados.push({ itemId, ok: false, error: pub.textoDeError(e) });
      }
    }
  }
  olvidar(businessId, cuenta);
  return { cambiadas: resultados.filter((r) => r.ok && !r.yaEstaba).length, fallaron: resultados.filter((r) => !r.ok).length, resultados };
}

// ── Unificar colores ─────────────────────────────────────────────

/** Sobre las publicaciones elegidas, por producto de Stocker: gana el valor de la mayoría (coloresPublicados). */
async function unificarColores(businessId, { itemIds } = {}) {
  const { cuenta, headers } = await conectar(businessId);
  const items = await itemsPropios(cuenta, headers, itemIds);
  const cruce = await cruceDe(businessId);
  const porProducto = new Map();
  for (const item of items) {
    if (item.variations?.length) continue; // modelo viejo: el color es de la variación, no del ítem
    const { variante } = cruce.de(item);
    const color = variante ? ejesDe(variante).color : null;
    if (!color) continue;
    const k = variante.producto.id;
    if (!porProducto.has(k)) porProducto.set(k, []);
    porProducto.get(k).push({ itemId: String(item.id), color });
  }
  const porItem = {};
  for (const lista of porProducto.values()) {
    // La clave es el ítem y no el SKU: dos publicaciones del mismo SKU tienen que unificarse las dos.
    const colores = await pub.coloresPublicados({
      variantes: lista.map((x) => ({ sku: x.itemId, color: x.color })),
      publicados: new Map(lista.map((x) => [x.itemId, { mlItemId: x.itemId }])),
      headers, http: ml.httpML,
    });
    for (const c of colores.values()) {
      Object.assign(porItem, await pub.aplicarColor({ aCambiar: c.aCambiar, canonico: c.canonico, queda: c.canonico.value_name, headers, http: ml.httpML }));
    }
  }
  olvidar(businessId, cuenta);
  const n = (estado) => Object.values(porItem).filter((r) => r.estado === estado).length;
  return { unificados: n('unificado'), fallaron: n('error'), porItem };
}

// ── Lo que cobra ML por un precio ────────────────────────────────

const campanasDe = (item) => {
  const tags = CAMPANAS.filter((t) => (item.tags || []).includes(t));
  const terminos = (item.sale_terms || []).filter((t) => t.id === 'INSTALLMENTS_CAMPAIGN');
  if (tags.length || !terminos.length) return tags;
  // Cotizar otra campaña que la que tiene dejaría el costo de cuotas de menos.
  // shortcut: el formato del término no está en el documento; sólo se entiende '3x_campaign', ampliar al ver uno real.
  if (!terminos.every((t) => [t.value_name, t.value_id].includes('3x_campaign'))) {
    throw sinCosto('la publicación tiene una campaña de cuotas y no se sabe cuál es.');
  }
  return ['3x_campaign'];
};

/*
 * El desglose de vender `item` publicado a `precio`.
 *
 * Los cargos se calculan sobre lo que paga el comprador (con el descuento); el
 * envío gratis lo obliga el precio PUBLICADO desde el umbral, igual que en
 * precioMl, y la que ya lo ofrece lo sigue ofreciendo aunque baje: cambiar el
 * precio no se lo saca.
 */
async function cotizar({ item, precio, extraPct = 0, cobrado: pagado = null, params, pesoGramos, mlUserId, headers, http = ml.httpML, esperar = dormir, memo = null }) {
  const cobrado = pagado ?? (extraPct > 0 ? pub.precioConDescuento(precio, extraPct) : precio);
  const envioItem = item.shipping || {};
  const pedir = (url, query) => {
    const clave = JSON.stringify([url, query]);
    if (memo?.has(clave)) return memo.get(clave);
    const p = pub.con429(() => http.get(url, { headers, params: query }), { esperar })
      .then((r) => r.data)
      .catch((e) => { memo?.delete(clave); throw sinCosto(pub.textoDeError(e)); });
    memo?.set(clave, p);
    return p;
  };

  const campanas = campanasDe(item);
  const consulta = {
    price: cobrado, category_id: item.category_id, listing_type_id: item.listing_type_id,
    logistic_type: envioItem.logistic_type || undefined, shipping_mode: envioItem.mode || undefined,
    billable_weight: Math.round(pesoGramos),
  };
  // shortcut: el ejemplo oficial usa tags=ahora-3; que acepte el tag de la campaña no está confirmado (abajo se controla que cobre las cuotas).
  if (campanas.length) consulta.tags = campanas.join(',');
  const data = await pedir(`${ML_API}/sites/MLA/listing_prices`, consulta);
  const lista = Array.isArray(data) ? data : [data];
  const fila = lista.find((x) => x?.listing_type_id === item.listing_type_id) || (lista.length === 1 && !lista[0]?.listing_type_id ? lista[0] : null);
  const det = fila?.sale_fee_details || {};
  // shortcut: el documento sólo nombra sale_fee_details.gross_amount (se toma como el total en pesos); sale_fee_amount, si viene, manda.
  const total = numero(fila?.sale_fee_amount) ?? numero(det.gross_amount);
  if (total == null || total <= 0) throw sinCosto('la respuesta no trae un cargo por vender que se entienda.');
  const cuotasPct = numero(det.financing_add_on_fee) || 0;
  if (campanas.length && !(cuotasPct > 0)) {
    throw sinCosto(`la publicación tiene cuotas (${campanas.join(', ')}) y la respuesta no trae su costo: el cargo quedaría de menos.`);
  }
  const costoCuotas = r2(cobrado * cuotasPct / 100);
  const costoFijo = r2(numero(det.fixed_fee) || 0);
  const cargoVender = r2(total - costoCuotas - costoFijo);
  if (cargoVender < -1) throw sinCosto('el desglose de la respuesta no cierra con el total.');

  const llevaEnvio = envioItem.free_shipping === true || (envioItem.mode === 'me2' && precio >= params.umbral);
  let envio = 0;
  if (llevaEnvio) {
    if (envioItem.mode !== 'me2') throw sinCosto('ofrece envío gratis sin Mercado Envíos: ese costo no lo informa Mercado Libre.');
    // ML pide item_id de una publicación activa o las medidas del paquete.
    const medida = item.status !== 'active' && envioItem.dimensions ? { dimensions: envioItem.dimensions } : { item_id: item.id };
    const e = await pedir(`${ML_API}/users/${mlUserId}/shipping_options/free`, {
      ...medida, item_price: cobrado, listing_type_id: item.listing_type_id, mode: 'me2',
      condition: item.condition || 'new', logistic_type: envioItem.logistic_type || undefined, verbose: true, free_shipping: 'True',
    });
    // shortcut: no está confirmado que list_cost ya tenga restado coverage.discount; si no, el envío queda estimado de más.
    const costo = numero(e?.coverage?.all_country?.list_cost);
    if (costo == null || costo < 0 || (e.coverage.all_country.currency_id || 'ARS') !== 'ARS') throw sinCosto('la respuesta no trae el costo del envío gratis.');
    envio = r2(costo);
  }
  // El parámetro de impuestos se cuenta como en precioMl: en las ventas con envío gratis.
  const impuestos = llevaEnvio ? params.impuestos : 0;
  return {
    precio, precioConDescuento: cobrado, extraPct: pagado == null ? extraPct : 0, // lo ya cobrado no es "con X %"
    cargoVender, costoCuotas, costoFijo, cargosMl: r2(total), llevaEnvio, envio, impuestos,
    leQueda: r2(cobrado - total - envio - impuestos),
    // Cuánto sube lo que queda por cada peso publicado: guía la búsqueda.
    pendiente: Math.max(0.05, (1 - (numero(det.percentage_fee) ?? (total / cobrado) * 100) / 100) * (1 - extraPct / 100)),
  };
}

/*
 * El precio publicado más bajo con el que quedan al menos `objetivo` pesos.
 *
 * Los cargos saltan (desde el umbral aparece el envío; el costo fijo va por
 * tramos), así que no hay fórmula: se busca primero debajo del umbral y recién
 * después arriba, acercándose con la pendiente y partiendo al medio, con tope
 * de consultas. Lo que se devuelve se vuelve a preguntar a ML y tiene que
 * cumplir.
 *
 * shortcut: salvo en los saltos del costo fijo (se mira un tramo para abajo),
 * se supone que a más precio queda más; con tramos muy angostos podría haber un
 * precio algo menor que también cumpla. Nunca devuelve uno que no cumpla.
 */
async function buscarPrecio({ objetivo, extraPct = 0, umbral, evaluar, tope = TOPE_CONSULTAS }) {
  let consultas = 0;
  const probar = (p) => { consultas += 1; return evaluar(p); };
  const cumple = (r) => r.leQueda >= objetivo;

  // `lo` no cumple (o está fuera del tramo), `hi` cumple.
  const acotar = async (lo, hi) => {
    for (let i = 1; hi.precio - lo > 1 && consultas < tope; i++) {
      const medio = Math.floor((lo + hi.precio) / 2);
      let p = i % 3 ? hi.precio - Math.floor((hi.leQueda - objetivo) / hi.pendiente) : medio;
      if (p >= hi.precio) p = hi.precio - 1;
      if (p <= lo) p = medio;
      const r = await probar(p);
      if (cumple(r)) hi = r; else lo = p;
    }
    return { hi, exacto: hi.precio - lo <= 1 };
  };

  // Con menos que esto ni sin cargos se llega.
  const piso = Math.max(1, Math.floor(objetivo / (1 - extraPct / 100)));
  const corte = Math.ceil(umbral);

  /*
   * El costo fijo va por tramos: al pasar de uno a otro lo que queda BAJA, así
   * que puede alcanzar con un precio del tramo de abajo aunque `ref` cumpla
   * justo o no cumpla. Se mira desde lo más bajo que podría ser sin ese costo;
   * si ahí se cobra otro, se busca en ese tramo. `entero`: no faltó mirar nada.
   */
  const tramoDeAbajo = async (ref) => {
    const fijo = ref.costoFijo || 0;
    const desde = Math.max(piso, ref.precio - Math.ceil(fijo / ref.pendiente) - 1);
    if (!(fijo > 0) || ref.leQueda + fijo < objetivo || desde >= ref.precio) return { entero: true };
    if (consultas >= tope) return { entero: false };
    let lo = piso - 1;
    let r = await probar(desde);
    while (r.costoFijo !== fijo) {
      if (cumple(r)) return { hallado: await acotar(lo, r), entero: true };
      lo = r.precio;
      const p = lo + Math.max(1, Math.ceil((objetivo - r.leQueda) / r.pendiente));
      if (p >= ref.precio) break;
      if (consultas >= tope) return { entero: false };
      r = await probar(p);
    }
    return { entero: true };
  };

  let hallado = null;
  let entero = true;
  if (piso < corte) {
    const r = await probar(corte - 1);
    if (cumple(r)) hallado = await acotar(piso - 1, r);
    else ({ hallado = null, entero } = await tramoDeAbajo(r));
  }
  if (!hallado) {
    let lo = Math.max(corte, piso) - 1;
    let r = await probar(lo + 1);
    for (let i = 1; !cumple(r); i++) {
      if (consultas >= tope) throw sinCosto(`no se encontró un precio que deje ${objetivo} en ${tope} consultas.`);
      lo = r.precio;
      const salto = Math.max(1, Math.ceil((objetivo - r.leQueda) / r.pendiente));
      r = await probar(lo + salto + (i > 4 ? Math.ceil(lo * 0.02 * (i - 4)) : 0));
    }
    hallado = await acotar(lo, r);
  }

  const abajo = await tramoDeAbajo(hallado.hi);
  if (abajo.hallado) hallado = abajo.hallado;
  const final = await evaluar(hallado.hi.precio, { fresco: true });
  if (!cumple(final)) throw sinCosto(`al verificar $${final.precio}, Mercado Libre dio otro costo y no llega a lo pedido. Probá de nuevo.`);
  return { desglose: final, minimoExacto: hallado.exacto && entero && abajo.entero, consultas: consultas + 1 };
}

// ── La calculadora ───────────────────────────────────────────────

function opcionalEnRango(x, min, max, nombre) {
  if (x == null || x === '') return null;
  const n = Number(x);
  if (!Number.isFinite(n) || n < min || n > max) throw error400(`${nombre} tiene que ser un número entre ${min} y ${max}.`);
  return n;
}

/* Lo de Stocker de una publicación: costo, SKU y el descuento nuestro que lleva. */
function datosDe(item, cruce) {
  const filas = (item.variations?.length ? item.variations : [null]).map((v) => cruce.de(item, v));
  // Modelo viejo: el precio es uno para todas las variaciones, así que vale el costo más alto.
  const costos = filas.map((f) => costoDe(f.variante)).filter(Boolean);
  const pcts = cruce.links.filter((l) => String(l.mlItemId) === String(item.id) && l.descuentoPct >= pub.DESCUENTO_MIN_PCT).map((l) => l.descuentoPct);
  return {
    sku: filas[0].sku,
    costo: costos.length ? Math.max(...costos) : null,
    costoParcial: costos.length > 0 && costos.length < filas.length,
    extraPct: pcts.length ? Math.max(...pcts) : 0,
  };
}

const precioDeLista = (item) => numero(item.original_price) || numero(item.price) || 0;

const conGanancia = (desglose, costo, params) => {
  const { pendiente, ...d } = desglose;
  return {
    ...d,
    ganancia: costo ? r2(d.leQueda - costo) : null,
    bajoPiso: costo ? d.leQueda < costo + params.packing : null,
  };
};

function evaluador(base) {
  const memo = new Map();
  return (precio, { fresco = false, cobrado = null } = {}) => cotizar({ ...base, precio, cobrado, memo: fresco ? null : memo });
}

const objetivoPorDefecto = (costo, params) => r2(costo * params.multiplicador + params.packing);

/*
 * Con `precio`, qué queda. Sin él, el precio mínimo que deja `quiere` (por
 * defecto costo × multiplicador + packing).
 */
async function calcular(businessId, { itemId, precio, quiere, extraPct, pesoGramos } = {}) {
  const pedido = {
    precio: opcionalEnRango(precio, 1, 1e9, 'El precio'),
    quiere: opcionalEnRango(quiere, 1, 1e9, 'Lo que querés que quede'),
    extra: opcionalEnRango(extraPct, 0, 79, 'El extra para descuento'),
    peso: opcionalEnRango(pesoGramos, 1, 100000, 'El peso en gramos'),
  };
  const { cuenta, headers, params } = await conectar(businessId);
  const [item] = await itemsPropios(cuenta, headers, [itemId]);
  const d = datosDe(item, await cruceDe(businessId));
  const extra = pedido.extra ?? d.extraPct;
  const evaluar = evaluador({ item, extraPct: extra, params, pesoGramos: pedido.peso ?? params.pesoGramos, mlUserId: cuenta.mlUserId, headers });
  const comun = {
    itemId: String(item.id), nombre: item.family_name || item.title || null, sku: d.sku,
    costo: d.costo, costoParcial: d.costoParcial, packing: params.packing,
    objetivoPorDefecto: d.costo ? objetivoPorDefecto(d.costo, params) : null,
    precioActual: precioDeLista(item), extraPct: extra, extraDeLaPublicacion: d.extraPct, pesoGramos: pedido.peso ?? params.pesoGramos,
    afectaVariaciones: item.variations?.length || 0,
  };
  if (pedido.precio != null) {
    // Al precio de hoy el comprador paga item.price: puede haber un descuento que no pusimos nosotros.
    const deHoy = pedido.precio === comun.precioActual && pedido.extra == null && numero(item.price) < comun.precioActual;
    const cobrado = deHoy ? numero(item.price) : null;
    return { ...comun, modo: 'precio', desglose: conGanancia(await evaluar(pedido.precio, { cobrado }), d.costo, params) };
  }
  const objetivo = pedido.quiere ?? comun.objetivoPorDefecto;
  if (!objetivo) throw error400('Esta publicación no tiene costo en Stocker: indicá cuánto querés que te quede.');
  const r = await buscarPrecio({ objetivo, extraPct: extra, umbral: params.umbral, evaluar });
  return { ...comun, modo: 'objetivo', objetivo, minimoExacto: r.minimoExacto, consultas: r.consultas, desglose: conGanancia(r.desglose, d.costo, params) };
}

// ── Precios en tanda ─────────────────────────────────────────────

function cambiosLimpios(cambios, tope) {
  if (!Array.isArray(cambios) || !cambios.length) throw error400('Elegí al menos una publicación.');
  const ids = cambios.map((c) => String(c?.itemId ?? '').trim().toUpperCase());
  if (new Set(ids).size !== ids.length) throw error400('Hay una publicación repetida en la tanda.');
  idsLimpios(ids, tope);
  return cambios.map((c, i) => ({ itemId: ids[i], precio: c.precio, confirmado: c.confirmado === true }));
}

const cambioPct = (actual, nuevo) => (actual > 0 ? r2((nuevo - actual) / actual * 100) : null);
// Sin precio actual no hay contra qué comparar: también se pide confirmación.
const pideConfirmacion = (actual, nuevo) => !(actual > 0) || Math.abs(nuevo - actual) > actual * TOPE_CAMBIO_PCT / 100;

/** Actual contra nuevo, con lo que queda antes y después. Sin `precio`, propone el mínimo para el objetivo por defecto. */
async function vistaPreviaPrecios(businessId, { cambios, pesoGramos } = {}) {
  const limpios = cambiosLimpios(cambios, TOPE_VISTA_PRECIOS);
  const peso = opcionalEnRango(pesoGramos, 1, 100000, 'El peso en gramos');
  const { cuenta, headers, params } = await conectar(businessId);
  const items = await itemsPropios(cuenta, headers, limpios.map((c) => c.itemId), TOPE_VISTA_PRECIOS);
  const cruce = await cruceDe(businessId);
  const memo = new Map(); // las variantes de un producto pagan lo mismo: se pregunta una vez
  const filas = [];
  for (const [i, item] of items.entries()) {
    const d = datosDe(item, cruce);
    const actual = precioDeLista(item);
    const fila = {
      itemId: String(item.id), nombre: item.family_name || item.title || null, sku: d.sku,
      color: valorDe(item.attributes, 'COLOR')?.value_name ?? null, talle: valorDe(item.attributes, 'SIZE')?.value_name ?? null,
      costo: d.costo, piso: d.costo ? r2(d.costo + params.packing) : null, extraPct: d.extraPct,
      precioActual: actual, precioCobradoHoy: numero(item.price), precioNuevo: null, sugerido: false,
      cambioPct: null, requiereConfirmacion: false, antes: null, despues: null, error: null,
    };
    const base = { item, params, pesoGramos: peso ?? params.pesoGramos, mlUserId: cuenta.mlUserId, headers };
    try {
      // "Antes" es lo que paga hoy el comprador, con el descuento que tenga puesto.
      fila.antes = conGanancia(await cotizar({ ...base, precio: actual, cobrado: numero(item.price) ?? actual, memo }), d.costo, params);
    } catch (e) { fila.error = e.message; }
    try {
      const evaluar = (precio, { fresco = false } = {}) => cotizar({ ...base, extraPct: d.extraPct, precio, memo: fresco ? null : memo });
      const elegido = limpios[i].precio;
      let desglose;
      if (elegido != null && elegido !== '') {
        desglose = await evaluar(opcionalEnRango(elegido, 1, 1e9, 'El precio'));
      } else {
        if (!d.costo) throw error400('No tiene costo en Stocker: escribí el precio a mano.');
        ({ desglose } = await buscarPrecio({ objetivo: objetivoPorDefecto(d.costo, params), extraPct: d.extraPct, umbral: params.umbral, evaluar }));
        fila.sugerido = true;
      }
      fila.despues = conGanancia(desglose, d.costo, params);
      fila.precioNuevo = desglose.precio;
    } catch (e) {
      fila.error = e.message;
      fila.precioNuevo = numero(limpios[i].precio);
    }
    if (fila.precioNuevo > 0) {
      fila.cambioPct = cambioPct(actual, fila.precioNuevo);
      fila.requiereConfirmacion = pideConfirmacion(actual, fila.precioNuevo);
    }
    filas.push(fila);
  }
  return { filas };
}

/*
 * Valida la tanda ANTES de arrancar el trabajo, contra el precio que ML tiene
 * ahora. Con un solo precio rechazado no se aplica ninguno.
 */
async function prepararPrecios(businessId, { cambios } = {}) {
  const limpios = cambiosLimpios(cambios, TOPE_ITEMS);
  const { cuenta, headers } = await conectar(businessId);
  const items = await itemsPropios(cuenta, headers, limpios.map((c) => c.itemId));
  const rechazados = [];
  const plan = items.map((item, i) => {
    const c = limpios[i];
    const precio = typeof c.precio === 'number' ? c.precio : NaN;
    const actual = precioDeLista(item);
    let motivo = null;
    if (!Number.isFinite(precio) || !(precio > 0) || precio > 1e9) motivo = 'El precio tiene que ser un número mayor que cero.';
    else if (!c.confirmado && pideConfirmacion(actual, precio)) motivo = `Cambia más de ${TOPE_CAMBIO_PCT} % respecto del actual ($${actual}): hay que confirmarlo.`;
    if (motivo) {
      rechazados.push({ itemId: c.itemId, motivo, precioActual: actual, precioNuevo: c.precio ?? null, requiereConfirmacion: precio > 0 && precio <= 1e9 });
    }
    return { item, itemId: c.itemId, precio, anterior: actual };
  });
  if (rechazados.length) {
    throw error400(`No se cambió ningún precio: ${rechazados.map((r) => `${r.itemId}: ${r.motivo}`).join(' ')}`, { codigo: 'PRECIOS_RECHAZADOS', rechazados });
  }
  return { businessId, cuenta, headers, plan };
}

/*
 * shortcut: según una fuente no confirmada, desde el 18/03/2026 ML rechaza un
 * PUT que sólo trae price. Se manda así y, si lo rechaza, sale su error tal
 * cual (la pantalla sugiere probar con una sola primero).
 */
async function aplicarPrecios({ businessId, cuenta, headers, plan }, { onProgreso = () => {}, esperar = dormir } = {}) {
  const porItem = {};
  onProgreso({ total: plan.length, hechos: 0, porItem });
  let hechos = 0;
  // Subir el precio quita en ML nuestro descuento: sin fecha, renovarDescuentos lo vuelve a poner.
  const reponerDescuento = (itemId) => MercadoLibreLink.update({ descuentoHasta: null }, { where: { businessId, mlItemId: itemId } });
  for (const { item, itemId, precio, anterior } of plan) {
    // Modelo viejo: el precio va en cada variación, todas con su id (la que falte, ML la borra).
    // shortcut: esa forma no está probada con la cuenta; el modelo User Products manda sólo price.
    const cuerpo = item.variations?.length ? { variations: item.variations.map((v) => ({ id: v.id, price: precio })) } : { price: precio };
    try {
      await pub.con429(() => ml.httpML.put(`${ML_API}/items/${itemId}`, cuerpo, { headers }), { esperar });
      porItem[itemId] = { estado: 'cambiado', de: anterior, a: precio };
      try { await reponerDescuento(itemId); } catch (e) {
        porItem[itemId].aviso = `El precio cambió, pero no se pudo anotar que hay que reponer el descuento (${e.message}).`;
      }
    } catch (e) {
      porItem[itemId] = { estado: 'error', de: anterior, a: precio, error: pub.textoDeError(e) };
      // Sin respuesta o con un 5xx no se sabe si el cambio entró: por las dudas se repone igual.
      if (!(e.response?.status < 500)) await reponerDescuento(itemId).catch(() => {});
    }
    hechos += 1;
    onProgreso({ total: plan.length, hechos, porItem });
  }
  olvidar(businessId, cuenta);
  const n = (estado) => Object.values(porItem).filter((r) => r.estado === estado).length;
  return { cambiados: n('cambiado'), fallaron: n('error'), porItem };
}

module.exports = {
  vincular, desvincular,
  conMotivo,
  listar, leerDescripcion, guardarDescripcion, renombrar, cambiarEstado, unificarColores,
  calcular, vistaPreviaPrecios, prepararPrecios, aplicarPrecios,
  agrupar, problemasDe, cotizar, buscarPrecio,
};
