/*
 * Packs: se venden solos, descuentan lo que llevan adentro.
 *
 * Un "pack de 3 remeras baby tee" tiene su propio SKU y se publica en Mercado
 * Libre como un artículo más. Pero las tres remeras están en el estante una
 * sola vez: cuando el pack se vende, salen esas tres, no una cuarta cosa
 * llamada pack.
 *
 * ── Por qué un pack no tiene stock propio ─────────────────────────
 *
 * Porque serían dos verdades sobre la misma mercadería. Con stock propio hay
 * que mantenerlo sincronizado con el de sus componentes, y ese "hay que" es
 * donde se rompe: alguien vende una remera suelta y el pack sigue diciendo que
 * hay tres armados. La cuenta se hace siempre y no se guarda nunca.
 *
 * Lo que hay de un pack es lo que alcance para armarlo:
 *
 *     disponible = mínimo sobre sus componentes de ⌊disponible / cantidad⌋
 *
 * Con 7 remeras negras y un pack que lleva 3, hay 2 packs. Es piso y no
 * redondeo: con 2 remeras no hay un pack, hay dos remeras.
 *
 * ── Y por qué el pack es una variante ─────────────────────────────
 *
 * La sincronización con ML busca por SKU sobre variantes, la cola de pedidos
 * resuelve SKU sobre variantes, y el picking arma sobre variantes. Con una
 * entidad aparte habría que enseñarle a los tres caminos que existe otra clase
 * de cosa vendible, y el cuarto camino que alguien agregue se va a olvidar.
 */

const { Op } = require('sequelize');
const { ProductVariant, Product, PackComponente, VariantStock } = require('../models');
const stockService = require('./stockService');
const skuService = require('./skuService');

const error = (mensaje, status = 400, extra = {}) =>
  Object.assign(new Error(mensaje), { status, ...extra });

/**
 * Los componentes de varios packs, en UNA consulta.
 *
 * En bulk y no de a uno porque quien pregunta suele preguntar por muchos: la
 * sincronización con ML mira todo el catálogo, y de a una consulta por pack
 * serían doscientas idas a la base para dibujar una lista.
 *
 * @returns {Map<number, Array<{componenteVariantId, cantidad}>>}
 */
async function componentesDe(packVariantIds, t = null) {
  const ids = [...new Set((packVariantIds || []).filter(Boolean))];
  if (!ids.length) return new Map();

  const filas = await PackComponente.findAll({
    where: { packVariantId: ids },
    attributes: ['packVariantId', 'componenteVariantId', 'cantidad'],
    transaction: t,
  });

  const mapa = new Map();
  for (const f of filas) {
    if (!mapa.has(f.packVariantId)) mapa.set(f.packVariantId, []);
    mapa.get(f.packVariantId).push({
      componenteVariantId: f.componenteVariantId,
      cantidad: Number(f.cantidad) || 1,
    });
  }
  return mapa;
}

/**
 * Cuántos packs se pueden armar con lo que hay en un local.
 *
 * Un pack sin componentes cargados da cero, no infinito: un pack vacío no es un
 * pack que se puede armar siempre, es uno mal configurado, y publicar stock
 * infinito de algo que no existe es la peor forma de enterarse.
 */
async function disponibleDePack(packVariantId, locationId, t = null) {
  const mapa = await componentesDe([packVariantId], t);
  const componentes = mapa.get(Number(packVariantId)) || [];
  if (!componentes.length) return 0;

  let posibles = Infinity;
  for (const c of componentes) {
    const hay = await stockService.disponibleEn(c.componenteVariantId, locationId, t);
    posibles = Math.min(posibles, Math.floor(hay / c.cantidad));
    if (posibles <= 0) return 0;   // ya no alcanza: no hace falta seguir mirando
  }
  return posibles === Infinity ? 0 : posibles;
}

/**
 * Lo mismo para muchos packs y muchos locales, sin una consulta por pack.
 *
 * Es lo que usa la sincronización con Mercado Libre: con un catálogo de
 * doscientas publicaciones, preguntar de a una convierte una pantalla en un
 * minuto de espera.
 *
 * @param {number[]} packVariantIds
 * @param {number[]} locationIds  los locales que abastecen
 * @returns {Map<number, number>} packs armables EN CADA local, sumados
 *
 * Por local y después sumado, no al revés. Juntar primero el stock de cada
 * prenda entre locales y recién ahí dividir publicaba packs que no se pueden
 * armar: 2 remeras en Palermo y 1 en Belgrano daban "1 Pack x3" en Mercado
 * Libre, pero la venta aparta el pack ENTERO en un local (`repartirPackOnline`)
 * y la rechazaba por falta de stock. Lo publicado tiene que ser exactamente lo
 * que la venta puede apartar.
 */
async function disponibleDePacksEnLocales(packVariantIds, locationIds, businessId, t = null) {
  const resultado = new Map();
  const ids = [...new Set((packVariantIds || []).filter(Boolean))];
  if (!ids.length || !locationIds?.length) return resultado;

  const porPack = await componentesDe(ids, t);
  const idsComponentes = [...new Set(
    [...porPack.values()].flat().map((c) => c.componenteVariantId),
  )];
  if (!idsComponentes.length) {
    for (const id of ids) resultado.set(id, 0);
    return resultado;
  }

  // Todo el stock de todos los componentes, de una.
  const filas = await VariantStock.findAll({
    where: { businessId, locationId: locationIds, productVariantId: idsComponentes },
    attributes: ['productVariantId', 'locationId', 'stock', 'reservado'],
    transaction: t,
  });

  // Libre por prenda Y por local: sumarlo entre locales es justamente el error.
  const libre = new Map();
  for (const f of filas) {
    const clave = `${Number(f.productVariantId)}:${Number(f.locationId)}`;
    const disponible = Math.max(0, (Number(f.stock) || 0) - (Number(f.reservado) || 0));
    libre.set(clave, (libre.get(clave) || 0) + disponible);
  }

  const locales = [...new Set(locationIds.map(Number))];
  for (const id of ids) {
    const componentes = porPack.get(id) || [];
    if (!componentes.length) { resultado.set(id, 0); continue; }

    let total = 0;
    for (const local of locales) {
      let enEsteLocal = Infinity;
      for (const c of componentes) {
        const hay = libre.get(`${Number(c.componenteVariantId)}:${local}`) || 0;
        enEsteLocal = Math.min(enEsteLocal, Math.floor(hay / c.cantidad));
        if (enEsteLocal <= 0) break;   // en este local ya no se arma ninguno
      }
      if (enEsteLocal !== Infinity && enEsteLocal > 0) total += enEsteLocal;
    }
    resultado.set(id, total);
  }
  return resultado;
}

/**
 * Aparta lo que hace falta para `cantidadPacks` packs.
 *
 * Todo o nada. Si el segundo componente no alcanza, se suelta lo que ya se
 * apartó del primero: media reserva deja mercadería comprometida para un pack
 * que nunca se va a poder armar, y nadie la va a soltar porque no quedó ningún
 * pedido que la explique.
 *
 * Adentro de una transacción el rollback ya lo cubriría, pero la compensación
 * está igual: esta función también se llama suelta, y depender de que quien
 * llama haya abierto una transacción es la clase de supuesto que se rompe
 * cuando alguien agrega el cuarto camino.
 */
async function reservarPack(packVariantId, locationId, businessId, cantidadPacks, t = null) {
  const n = Number(cantidadPacks);
  if (!Number.isInteger(n) || n <= 0) {
    throw error('La cantidad de packs a reservar tiene que ser un entero mayor a cero.');
  }

  const mapa = await componentesDe([packVariantId], t);
  const componentes = mapa.get(Number(packVariantId)) || [];
  if (!componentes.length) {
    throw error(
      'Este pack no tiene componentes cargados: no se sabe qué habría que apartar.',
      409, { codigo: 'PACK_SIN_COMPONENTES' },
    );
  }

  const hechas = [];
  for (const c of componentes) {
    const pudo = await stockService.reservar(
      c.componenteVariantId, locationId, businessId, c.cantidad * n, t,
    );
    if (!pudo) {
      for (const y of hechas) {
        await stockService.liberarReserva(
          y.componenteVariantId, locationId, businessId, y.cantidad * n, t,
        );
      }
      return false;
    }
    hechas.push(c);
  }
  return true;
}

/** Suelta lo apartado por `cantidadPacks` packs, sin mover mercadería. */
async function liberarPack(packVariantId, locationId, businessId, cantidadPacks, t = null) {
  const n = Number(cantidadPacks);
  if (!Number.isInteger(n) || n <= 0) return false;
  const componentes = (await componentesDe([packVariantId], t)).get(Number(packVariantId)) || [];
  if (!componentes.length) return false;

  let todas = true;
  for (const c of componentes) {
    const pudo = await stockService.liberarReserva(
      c.componenteVariantId, locationId, businessId, c.cantidad * n, t,
    );
    if (!pudo) todas = false;
  }
  return todas;
}

/**
 * El pack salió: la reserva de cada componente se convierte en egreso.
 *
 * El movimiento se registra por COMPONENTE y no por pack, y dice de qué pack
 * salió. El libro de stock tiene que hablar de mercadería que existe: "salieron
 * 3 remeras negras M" es algo que se puede contar en el estante; "salió 1 pack"
 * no se puede contar en ningún lado.
 */
async function consumirPack(packVariantId, locationId, businessId, cantidadPacks, t = null, { motivo = null, employeeId = null } = {}) {
  const n = Number(cantidadPacks);
  if (!Number.isInteger(n) || n <= 0) return false;
  const componentes = (await componentesDe([packVariantId], t)).get(Number(packVariantId)) || [];
  if (!componentes.length) return false;

  for (const c of componentes) {
    const pudo = await stockService.consumirReserva(
      c.componenteVariantId, locationId, businessId, c.cantidad * n, t,
      { motivo, employeeId },
    );
    if (!pudo) return false;
  }
  return true;
}

/**
 * Cómo se reparten N packs entre los locales que abastecen online.
 *
 * Mismo contrato que `stockService.repartirDescuentoOnline`, para que la cola
 * pueda usar uno u otro sin saber cuál le tocó.
 *
 * ── Un pack se arma en UN local ───────────────────────────────────
 *
 * No se juntan dos remeras de Palermo y una de Belgrano para armar uno: nadie
 * va a cruzar la ciudad a buscar la tercera, y el pedido saldría con dos
 * prendas y un faltante que el sistema dice que no existe. Por eso el reparto
 * es por CUÁNTOS PACKS ENTEROS puede armar cada local, no por unidades sueltas.
 *
 * Se empieza por el que más puede armar, igual que con una variante suelta y
 * por lo mismo: con una prioridad fija el primer local se vacía mientras el
 * segundo queda intacto.
 */
async function repartirPackOnline(packVariantId, businessId, cantidadPacks, t = null) {
  const locales = await stockService.localesQueAbastecenOnline(businessId, t);
  const reparto = [];
  let restante = Number(cantidadPacks) || 0;

  const capacidad = [];
  for (const l of locales) {
    capacidad.push({
      locationId: l.id,
      nombre: l.nombre,
      packs: await disponibleDePack(packVariantId, l.id, t),
    });
  }
  capacidad.sort((a, b) => b.packs - a.packs);

  for (const c of capacidad) {
    if (restante <= 0) break;
    if (c.packs <= 0) continue;
    const toma = Math.min(c.packs, restante);
    reparto.push({ locationId: c.locationId, nombre: c.nombre, unidades: toma });
    restante -= toma;
  }

  return { alcanza: restante <= 0, falta: restante, reparto };
}

/*
 * ── Armar y validar un pack ──────────────────────────────────────
 */

/**
 * Reemplaza la composición de un pack.
 *
 * @param {Array<{componenteVariantId, cantidad}>} componentes
 */
async function definirComponentes(packVariantId, businessId, componentes, t = null) {
  const pack = await ProductVariant.findOne({
    where: { id: packVariantId, businessId },
    attributes: ['id', 'productId', 'sku', 'esPack'],
    include: [{ model: Product, as: 'producto', attributes: ['id', 'esFeria'] }],
    transaction: t,
  });
  if (!pack) throw error('Ese pack no existe en este negocio.', 404);

  const lista = Array.isArray(componentes) ? componentes : [];
  if (!lista.length) {
    throw error('Un pack necesita al menos un componente: si no, no se sabe qué descuenta.');
  }
  if (lista.length > 20) {
    throw error('Un pack no puede llevar más de 20 componentes distintos.');
  }

  const ids = lista.map((c) => Number(c.componenteVariantId));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw error('Cada componente tiene que indicar qué variante lleva.');
  }
  if (ids.includes(Number(packVariantId))) {
    throw error('Un pack no puede llevarse a sí mismo adentro.');
  }
  if (new Set(ids).size !== ids.length) {
    throw error('Un componente aparece dos veces: poné la cantidad total en una sola línea.');
  }
  for (const c of lista) {
    const n = Number(c.cantidad);
    if (!Number.isInteger(n) || n <= 0) {
      throw error('La cantidad de cada componente tiene que ser un entero mayor a cero.');
    }
    if (n > 1000) throw error('La cantidad de un componente no puede pasar de 1000.');
  }

  /*
   * Los componentes tienen que ser del MISMO negocio, y no pueden ser packs.
   *
   * Lo primero es la defensa: el id viene del navegador, y sin este filtro se
   * podría armar un pack que descuenta stock de otro negocio.
   *
   * Lo segundo evita el pozo: un pack adentro de otro obliga a resolver la
   * cuenta en profundidad, y con un ciclo —A lleva B, B lleva A— la cuenta no
   * termina nunca.
   */
  const encontrados = await ProductVariant.findAll({
    where: { id: ids, businessId },
    attributes: ['id', 'sku', 'esPack'],
    include: [{ model: Product, as: 'producto', attributes: ['id', 'esFeria'], required: true }],
    transaction: t,
  });
  if (encontrados.length !== ids.length) {
    throw error('Alguno de los componentes no existe en este negocio.', 400);
  }
  const anidado = encontrados.find((v) => v.esPack);
  if (anidado) {
    throw error(
      `"${anidado.sku}" también es un pack, y un pack no puede llevar otro adentro.`,
      400, { codigo: 'PACK_ANIDADO' },
    );
  }
  /*
   * Un producto de evento no lleva stock por diseño: un pack que lo incluya
   * nunca podría descontarlo, y su disponible daría siempre cero sin que se
   * entienda por qué.
   */
  const deEvento = encontrados.find((v) => v.producto?.esFeria);
  if (deEvento) {
    throw error(
      `"${deEvento.sku}" es un producto de evento y no lleva stock: no puede ser parte de un pack.`,
      400, { codigo: 'PACK_CON_EVENTO' },
    );
  }

  /*
   * Un pack va en SU PROPIO producto, no mezclado con las prendas sueltas.
   *
   * Las variantes de un producto comparten dimensiones: si el producto es
   * "Baby Tee" con Color y Talle, todas sus variantes son un color y un talle.
   * Un pack no tiene color ni talle —tiene "3 unidades"— y meterlo ahí rompe
   * todo lo que lee esas dimensiones: la carga por curvas deja de encontrar el
   * eje, los listados agrupan mal, el selector de talles muestra "3 unidades"
   * como si fuera uno.
   *
   * No es hipotético: pasó armando la demo de esta misma función. Un pack
   * colgado de un producto existente puso en rojo seis comprobaciones de
   * curvas, y el síntoma —"con el color fijo: null"— no señalaba al pack por
   * ningún lado.
   */
  const hermanas = await ProductVariant.count({
    where: { productId: pack.productId, id: { [Op.ne]: packVariantId }, esPack: false },
    transaction: t,
  });
  if (hermanas > 0) {
    throw error(
      'Un pack tiene que estar en su propio producto. Las variantes de un producto comparten '
      + 'dimensiones —color, talle— y un pack no las tiene: mezclarlo rompe la carga por curvas '
      + 'y los listados de ese producto. Creá un producto para el pack y volvé a intentar.',
      400, { codigo: 'PACK_MEZCLADO' },
    );
  }

  await PackComponente.destroy({ where: { packVariantId }, transaction: t });
  await PackComponente.bulkCreate(
    lista.map((c) => ({
      businessId,
      packVariantId,
      componenteVariantId: Number(c.componenteVariantId),
      cantidad: Number(c.cantidad),
    })),
    { transaction: t },
  );
  await pack.update({ esPack: true }, { transaction: t });

  return PackComponente.findAll({
    where: { packVariantId },
    include: [{
      association: 'componente',
      attributes: ['id', 'sku', 'variante1Valor', 'variante2Valor'],
      include: [{ model: Product, as: 'producto', attributes: ['titulo'] }],
    }],
    transaction: t,
  });
}

/** Deja de ser pack: se borra la composición y vuelve a ser una variante común. */
async function desarmar(packVariantId, businessId, t = null) {
  const pack = await ProductVariant.findOne({
    where: { id: packVariantId, businessId }, transaction: t,
  });
  if (!pack) throw error('Ese pack no existe en este negocio.', 404);
  await PackComponente.destroy({ where: { packVariantId }, transaction: t });
  await pack.update({ esPack: false }, { transaction: t });
  return pack;
}

/**
 * Los packs que se quedarían sin poder armarse si se toca esta variante.
 *
 * Sirve para avisar antes de desactivar o borrar un componente: sin esto, un
 * pack publicado en Mercado Libre pasa a stock cero de un día para el otro y
 * nadie sabe por qué.
 */
async function packsQueUsan(componenteVariantId, businessId, t = null) {
  const filas = await PackComponente.findAll({
    where: { businessId, componenteVariantId },
    include: [{ association: 'pack', attributes: ['id', 'sku', 'activo'] }],
    transaction: t,
  });
  return filas
    .filter((f) => f.pack)
    .map((f) => ({ variantId: f.pack.id, sku: f.pack.sku, lleva: Number(f.cantidad) }));
}

/*
 * ══ Combos: productos distintos, uno por color y talle ═════════════
 *
 * Un combo junta prendas distintas —remera + pantalón— y cada variante es una
 * combinación de color y talle: "Negro / M" lleva la remera negra M y el
 * pantalón negro M. Quien lo arma elige qué colores y qué talles, entre los que
 * existen en TODAS las prendas. También puede combinar colores distintos en una
 * misma variante: "Blanco + Negro / M" lleva la remera blanca y el pantalón
 * negro. El talle es siempre el mismo para todas las prendas.
 *
 * Los talles se ordenan como en una góndola, no alfabéticamente: "L, M, S" no
 * es ningún orden. Es la misma escala que usa la pantalla.
 */
const ESCALA_TALLES = [
  'XXXS', '3XS', 'XXS', '2XS', 'XS', 'S', 'M', 'L',
  'XL', 'XXL', '2XL', 'XXXL', '3XL', 'XXXXL', '4XL', 'XXXXXL', '5XL',
  'ÚNICO', 'UNICO', 'U',
];
const normTalle = (v) => String(v ?? '').trim().toUpperCase();

function compararTalles(a, b) {
  const pa = ESCALA_TALLES.indexOf(normTalle(a));
  const pb = ESCALA_TALLES.indexOf(normTalle(b));
  if (pa !== -1 && pb !== -1) return pa - pb;
  if (pa !== -1) return -1;
  if (pb !== -1) return 1;
  const na = Number(String(a).replace(',', '.'));
  const nb = Number(String(b).replace(',', '.'));
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  if (Number.isFinite(na)) return -1;
  if (Number.isFinite(nb)) return 1;
  return normTalle(a).localeCompare(normTalle(b), 'es');
}
const compararTexto = (a, b) => normTalle(a).localeCompare(normTalle(b), 'es');

const paresDe = (v) => [
  [v.variante1Nombre, v.variante1Valor],
  [v.variante2Nombre, v.variante2Valor],
].filter(([n, val]) => n && val !== null && val !== undefined && String(val).trim() !== '');

/** La clave de una combinación: color y talle, sin mayúsculas ni espacios de más. */
const claveCombo = (color, talle) => `${normTalle(color)}|${normTalle(talle)}`;
const normalizarClave = (clave) => String(clave ?? '').split('|').map(normTalle).join('|');

/** La clave de una variante de combo ya creada, leída de sus ejes. */
function claveDeVariante(v, ejes = {}) {
  const nColor = normTalle(ejes.color || 'Color');
  const nTalle = normTalle(ejes.talle || 'Talle');
  const pares = paresDe(v);
  const color = pares.find(([n]) => normTalle(n) === nColor)?.[1] || '';
  const talle = pares.find(([n]) => normTalle(n) === nTalle)?.[1] || '';
  return claveCombo(color, talle);
}

/**
 * Lee la definición guardada de un combo. Devuelve null si está dañada.
 *
 * Entiende también la primera versión ({ eje, piezas: [{ fijos }] }), donde el
 * color se fijaba por prenda y las variantes sólo decían el talle. Esas se leen
 * con `legado`: sus etiquetas no llevan color, así completar no duplica lo que
 * ya existe con otro nombre.
 */
function leerDefinicionCombo(texto) {
  let def = texto;
  if (typeof texto === 'string') {
    try { def = JSON.parse(texto); } catch { return null; }
  }
  if (!def || typeof def !== 'object' || !Array.isArray(def.piezas) || !def.piezas.length) return null;
  if (def.piezas.some((p) => !p || typeof p !== 'object' || !(Number(p.productId) > 0))) return null;
  const piezas = def.piezas.map((p) => ({
    productId: Number(p.productId),
    cantidad: Math.max(1, Math.trunc(Number(p.cantidad) || 1)),
  }));
  if (Number(def.version) >= 2) {
    return {
      version: 2,
      legado: false,
      ejes: { color: def.ejes?.color || 'Color', talle: def.ejes?.talle || 'Talle' },
      piezas,
      colores: Array.isArray(def.colores) ? def.colores : null,
      talles: Array.isArray(def.talles) ? def.talles : null,
      excluidas: Array.isArray(def.excluidas) ? def.excluidas : [],
    };
  }
  const colorFijo = (p) => {
    const fijos = p?.fijos && typeof p.fijos === 'object' ? p.fijos : {};
    const nombre = Object.keys(fijos).find((k) => normTalle(k) === 'COLOR');
    return nombre ? fijos[nombre] : null;
  };
  return {
    version: 1,
    legado: true,
    ejes: { color: 'Color', talle: def.eje || 'Talle' },
    piezas,
    colores: [def.piezas.map(colorFijo)],
    talles: null,
    excluidas: [],
  };
}

/**
 * Qué combinaciones salen de un grupo de prendas, sin crear nada.
 *
 * `colores` es la lista de opciones elegidas: cada una dice el color de cada
 * prenda, en orden (`['Blanco', 'Negro']`), o es un texto para el mismo color
 * en todas. Sin lista, se ofrece cada color que tienen todas las prendas.
 * `talles` es la lista de talles elegidos; sin lista, todos los que tienen
 * todas. Una prenda sin colores o sin talles (una gorra) entra igual en todas.
 *
 * Cada opción de color por cada talle da una fila, pero sólo si TODAS las
 * prendas tienen esa variante: lo que no existe va a `imposibles`, con lo que
 * falta, en vez de desaparecer sin explicación.
 *
 * Nunca tira: lo pedido que no existe va a `invalidas`, y el que crea decide
 * si eso es un error.
 */
async function proyectarCombo({
  businessId, piezas = [], ejes = {}, colores = null, talles = null,
  excluidas = [], legado = false, agrupador, t = null,
}) {
  const ejeColor = ejes.color || 'Color';
  const ejeTalle = ejes.talle || 'Talle';
  const nColor = normTalle(ejeColor);
  const nTalle = normTalle(ejeTalle);
  const ids = piezas.map((p) => Number(p.productId));
  // En serie: con SQL Server, dos consultas a la vez sobre la misma
  // transacción chocan.
  const productos = await Product.findAll({
    where: { id: ids, businessId }, attributes: ['id', 'sku', 'skuAgrupador', 'titulo'], transaction: t,
  });
  const variantes = await ProductVariant.findAll({
    where: { productId: ids, businessId, activo: true, esPack: false },
    attributes: ['id', 'productId', 'sku', 'variante1Nombre', 'variante1Valor', 'variante2Nombre', 'variante2Valor'],
    order: [['id', 'ASC']],
    transaction: t,
  });
  const regla = await skuService.reglaDe(businessId);
  const porId = new Map(productos.map((p) => [Number(p.id), p]));

  const salida = [];
  const indices = [];
  for (const p of piezas) {
    const prod = porId.get(Number(p.productId));
    const info = {
      productId: Number(p.productId),
      sku: prod?.skuAgrupador || prod?.sku || '',
      titulo: prod?.titulo || '',
      cantidad: Number(p.cantidad) || 1,
      colores: [],
      talles: [],
      problema: null,
    };
    const idx = { conColor: false, conTalle: false, porClave: new Map(), colores: new Map(), talles: new Map() };
    salida.push(info);
    indices.push(idx);
    if (!prod) { info.problema = 'Uno de los productos elegidos no existe en este negocio.'; continue; }

    const suyas = variantes.filter((v) => Number(v.productId) === prod.id);
    if (!suyas.length) { info.problema = `${prod.titulo} no tiene variantes activas para vender.`; continue; }

    for (const v of suyas) {
      const pares = paresDe(v);
      const otro = pares.find(([n]) => normTalle(n) !== nColor && normTalle(n) !== nTalle);
      if (otro) {
        info.problema = `${prod.titulo} tiene variantes por ${otro[0]}: un combo sólo combina ${ejeColor} y ${ejeTalle}.`;
        break;
      }
      const color = pares.find(([n]) => normTalle(n) === nColor)?.[1];
      const talle = pares.find(([n]) => normTalle(n) === nTalle)?.[1];
      if (color) {
        idx.conColor = true;
        if (!idx.colores.has(normTalle(color))) idx.colores.set(normTalle(color), String(color).trim());
      }
      if (talle) {
        idx.conTalle = true;
        if (!idx.talles.has(normTalle(talle))) idx.talles.set(normTalle(talle), String(talle).trim());
      }
      const clave = claveCombo(color, talle);
      if (idx.porClave.has(clave)) {
        info.problema = `${prod.titulo} tiene dos variantes ${[color, talle].filter(Boolean).join(' / ') || 'sin color ni talle'}: `
          + 'corregilas antes de armar el combo.';
        break;
      }
      idx.porClave.set(clave, v);
    }
    if (!info.problema) {
      for (const v of suyas) {
        const nombres = paresDe(v).map(([n]) => normTalle(n));
        const falta = idx.conColor && !nombres.includes(nColor) ? ejeColor
          : (idx.conTalle && !nombres.includes(nTalle) ? ejeTalle : null);
        if (falta) {
          info.problema = `${prod.titulo} tiene variantes con y sin ${falta} (${v.sku}): completalas antes de armar el combo.`;
          break;
        }
      }
    }
    info.colores = [...idx.colores.values()].sort(compararTexto);
    info.talles = [...idx.talles.values()].sort(compararTalles);
  }

  const avisos = [];
  const invalidas = [];
  const resultado = {
    piezas: salida, coloresComunes: [], tallesComunes: [], opciones: [], talles: [],
    filas: [], imposibles: [], invalidas, avisos,
  };
  if (salida.some((x) => x.problema)) return resultado;

  const conColor = indices.filter((x) => x.conColor);
  const conTalle = indices.filter((x) => x.conTalle);
  const enTodas = (lista, campo) => (lista.length
    ? [...lista[0][campo].entries()].filter(([k]) => lista.every((x) => x[campo].has(k))).map(([, v]) => v)
    : []);
  resultado.coloresComunes = enTodas(conColor, 'colores').sort(compararTexto);
  resultado.tallesComunes = enTodas(conTalle, 'talles').sort(compararTalles);

  if (conTalle.length && !resultado.tallesComunes.length) {
    avisos.push('Las prendas no tienen ningún talle en común (por ejemplo, una va de S a XL y la otra '
      + 'de 38 a 44), así que no sale ningún combo.');
    return resultado;
  }

  // ── Colores: lo elegido o, sin elección, cada color que tienen todas ──
  const opciones = [];
  const vistasOpcion = new Set();
  const agregarOpcion = (valores) => {
    const clave = valores.map((v) => normTalle(v)).join('|');
    if (!vistasOpcion.has(clave)) { vistasOpcion.add(clave); opciones.push(valores); }
  };
  if (!conColor.length) {
    agregarOpcion(piezas.map(() => null));
  } else if (colores === null || colores === undefined) {
    for (const c of resultado.coloresComunes) agregarOpcion(indices.map((x) => (x.conColor ? c : null)));
    if (!resultado.coloresComunes.length) {
      avisos.push('Las prendas no tienen ningún color en común. Podés armar el combo combinando colores '
        + 'distintos: elegí uno por prenda.');
    }
  } else {
    for (const pedida of colores) {
      const valores = typeof pedida === 'string'
        ? indices.map((x) => (x.conColor ? pedida : null))
        : (Array.isArray(pedida) ? pedida : pedida?.valores);
      if (!Array.isArray(valores) || valores.length !== piezas.length) {
        invalidas.push('Una de las combinaciones de colores no indica un color por prenda.');
        continue;
      }
      let mala = null;
      const normal = valores.map((val, i) => {
        const x = indices[i];
        if (!x.conColor) return null;
        const texto = val === null || val === undefined ? '' : String(val).trim();
        if (!texto) {
          if (x.colores.size === 1) return [...x.colores.values()][0];
          mala = mala || `Falta elegir el color de ${salida[i].titulo}.`;
          return null;
        }
        const existente = x.colores.get(normTalle(texto));
        if (!existente) mala = mala || `${salida[i].titulo} no tiene el color ${texto}.`;
        return existente || null;
      });
      if (mala) { invalidas.push(mala); continue; }
      agregarOpcion(normal);
    }
  }
  resultado.opciones = opciones;

  // ── Talles: lo elegido o, sin elección, todos los que tienen todas ────
  let tallesElegidos;
  if (!conTalle.length) {
    // La primera versión llamaba "Único" a la variante de un combo sin talles.
    tallesElegidos = [legado ? 'Único' : ''];
  } else if (talles === null || talles === undefined) {
    tallesElegidos = [...resultado.tallesComunes];
  } else {
    tallesElegidos = [];
    for (const pedido of talles) {
      const valor = resultado.tallesComunes.find((x) => normTalle(x) === normTalle(pedido));
      if (!valor) { invalidas.push(`El talle ${pedido} no está en todas las prendas.`); continue; }
      if (!tallesElegidos.includes(valor)) tallesElegidos.push(valor);
    }
    tallesElegidos.sort(compararTalles);
  }
  resultado.talles = tallesElegidos.filter(Boolean);

  // ── Una fila por color y talle, si todas las prendas la tienen ────────
  const fuera = new Set((excluidas || []).map(normalizarClave));
  const vistos = new Set();
  for (const valores of opciones) {
    const presentes = valores.filter(Boolean);
    const unColor = presentes.length > 0 && presentes.every((c) => normTalle(c) === normTalle(presentes[0]));
    const coloresEtiqueta = unColor ? [presentes[0]] : presentes;
    const color = legado ? '' : coloresEtiqueta.join(' + ');
    for (const talle of tallesElegidos) {
      const clave = claveCombo(color, talle);
      const etiqueta = [color, talle].filter(Boolean).join(' / ');
      const componentes = [];
      const faltan = [];
      valores.forEach((c, i) => {
        const x = indices[i];
        const talleDeEsta = x.conTalle ? talle : '';
        const v = x.porClave.get(claveCombo(c, talleDeEsta));
        if (v) {
          componentes.push({ componenteVariantId: v.id, cantidad: salida[i].cantidad, skuPadre: v.sku });
        } else {
          faltan.push([salida[i].titulo, c, talleDeEsta].filter(Boolean).join(' '));
        }
      });
      if (faltan.length) {
        resultado.imposibles.push({ clave, etiqueta, color, talle, faltan });
        continue;
      }
      const sku = skuService.componer({
        agrupador,
        valores: [
          ...(legado ? [] : coloresEtiqueta.map((c) => ({ eje: ejeColor, valor: c }))),
          ...(talle ? [{ eje: ejeTalle, valor: talle }] : []),
        ],
        regla,
      });
      const repetido = vistos.has(sku);
      vistos.add(sku);
      resultado.filas.push({
        clave, etiqueta, color, colores: valores, talle, sku, componentes, repetido,
        excluida: fuera.has(clave),
      });
    }
  }
  return resultado;
}

module.exports = {
  componentesDe, disponibleDePack, disponibleDePacksEnLocales, repartirPackOnline,
  reservarPack, liberarPack, consumirPack,
  definirComponentes, desarmar, packsQueUsan,
  proyectarCombo, compararTalles, leerDefinicionCombo, claveDeVariante, normalizarClave,
};
