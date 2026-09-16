/*
 * Jumpseller: sincronización de stock por SKU.
 *
 * Mismo criterio que Mercado Libre y a propósito: lo que se publica sale de
 * `stockPublicableService` —lo disponible en los locales que abastecen las
 * ventas online, menos el margen de seguridad, y en un pack cuántos se pueden
 * armar—, así los dos canales publican el mismo número del mismo estante.
 *
 * Lo que cambia es la API. En Jumpseller el stock vive en el producto cuando
 * no tiene variantes, y en cada variante cuando las tiene; el SKU está en los
 * dos lugares. La cuenta se conecta con la clave de la tienda (Login Key y
 * Auth Token del panel del dueño), que van como usuario y contraseña.
 */

const https = require('https');
const axios = require('axios');
const { JumpsellerAccount } = require('../models');
const stockService = require('./stockService');
const { variantesPublicables, cantidadesPublicables } = require('./stockPublicableService');
const { log } = require('../utils/logger');

const API = 'https://api.jumpseller.com/v1';
const TIMEOUT_MS = Number(process.env.JUMPSELLER_TIMEOUT_MS) || 20000;
/*
 * El límite de Jumpseller es 20 pedidos por segundo y 800 por minuto, por
 * tienda. Cuatro a la vez deja margen de sobra y alcanza para que una
 * sincronización de cientos de productos no tarde una eternidad.
 */
const CONCURRENCIA = Number(process.env.JUMPSELLER_CONCURRENCIA) || 4;
const ESPERA_429_MS = Number(process.env.JUMPSELLER_ESPERA_429_MS) || 1500;
// El máximo por página que acepta la API.
const TAM_PAGINA = 100;
/*
 * Cuánto vive el mapa de la tienda.
 *
 * La API de Jumpseller no tiene una búsqueda por SKU documentada: para saber
 * dónde va un SKU hay que listar el catálogo. Después de cada venta eso sería
 * pedir cientos de productos para actualizar uno, así que el mapa se guarda
 * unos minutos. Si el SKU que se busca no está —un producto nuevo en la
 * tienda—, se vuelve a pedir igual.
 */
const CACHE_MS = Number(process.env.JUMPSELLER_CACHE_MS) || 5 * 60 * 1000;
// businessId → { vence, porSku, productos }
const cacheTiendas = new Map();

// Sólo lo que hace falta para cruzar por SKU y escribir stock.
const CAMPOS = 'id,name,sku,price,stock,stock_unlimited,status,permalink,variants';

const agente = new https.Agent({ keepAlive: true, maxSockets: CONCURRENCIA, timeout: TIMEOUT_MS });
const http = axios.create({ timeout: TIMEOUT_MS, httpsAgent: agente });

const error = (mensaje, status = 400, extra = {}) => Object.assign(new Error(mensaje), { status, ...extra });

async function enParalelo(items, limite, fn) {
  const resultados = new Array(items.length);
  let siguiente = 0;
  const obrero = async () => {
    for (;;) {
      const i = siguiente++;
      if (i >= items.length) return;
      resultados[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limite, items.length) }, obrero));
  return resultados;
}

/** Un pedido a la API, con la clave de la tienda y un reintento si pega el límite. */
async function pedir(cuenta, metodo, ruta, { params = null, cuerpo = null, intentos = 3 } = {}) {
  const config = {
    auth: { username: cuenta.loginKey, password: cuenta.authToken },
    headers: { 'Content-Type': 'application/json' },
    ...(params ? { params } : {}),
  };
  for (let i = 1; ; i++) {
    try {
      const { data } = metodo === 'get'
        ? await http.get(`${API}${ruta}`, config)
        : await http.put(`${API}${ruta}`, cuerpo, config);
      return data;
    } catch (err) {
      const status = err.response?.status;
      // 429: el límite es por tienda y se libera solo; sólo hay que esperar.
      if (status === 429 && i < intentos) {
        await new Promise((listo) => setTimeout(listo, ESPERA_429_MS * i));
        continue;
      }
      if (status === 401 || status === 403) {
        throw error('Jumpseller rechazó la clave de la tienda. Revisá el Login Key y el Auth Token.', 401);
      }
      throw err;
    }
  }
}

/** El detalle que devuelve Jumpseller cuando algo sale mal. */
function detalleDeError(err) {
  const d = err.response?.data;
  if (typeof d === 'string') return d.slice(0, 300);
  return d?.message || d?.error || (Array.isArray(d?.errors) ? d.errors.join(', ') : null) || err.message;
}

/** La tienda conectada de un negocio. */
async function cuentaDe(businessId) {
  return JumpsellerAccount.findOne({ where: { businessId } });
}

async function estado(businessId) {
  const cuenta = await cuentaDe(businessId);
  if (!cuenta) return { conectado: false };
  return {
    conectado: true,
    tienda: cuenta.tienda || null,
    syncActiva: cuenta.syncActiva,
    ultimaSync: cuenta.ultimaSync,
    ultimoError: cuenta.ultimoError,
  };
}

/*
 * Conectar es guardar la clave, pero recién después de probarla.
 *
 * Guardarla sin probar deja una tienda "conectada" que falla en la primera
 * sincronización, y el error aparece horas después en un barrido que nadie
 * está mirando.
 */
async function conectar(businessId, { loginKey, authToken, tienda = null }) {
  const clave = String(loginKey || '').trim();
  const token = String(authToken || '').trim();
  if (!clave || !token) throw error('Faltan el Login Key y el Auth Token de tu tienda Jumpseller.');

  const prueba = { loginKey: clave, authToken: token };
  const cuantos = await pedir(prueba, 'get', '/products/count.json');
  const total = Number(cuantos?.count ?? cuantos?.products ?? 0) || 0;

  const valores = { businessId, loginKey: clave, authToken: token, ultimoError: null };
  if (tienda) valores.tienda = String(tienda).trim().slice(0, 120);
  cacheTiendas.delete(businessId);
  const cuenta = await cuentaDe(businessId);
  if (cuenta) await cuenta.update(valores);
  else await JumpsellerAccount.create(valores);
  return { conectado: true, productos: total };
}

async function desconectar(businessId) {
  cacheTiendas.delete(businessId);
  await JumpsellerAccount.destroy({ where: { businessId } });
  return { conectado: false };
}

/** Todos los productos de la tienda, con sus variantes. */
async function listarProductos(cuenta) {
  const productos = [];
  for (let pagina = 1; pagina <= 500; pagina++) {
    const lote = await pedir(cuenta, 'get', '/products.json', {
      params: { page: pagina, limit: TAM_PAGINA, fields: CAMPOS },
    });
    /*
     * La API devuelve [{ product: {...} }, ...]. No trae un "siguiente": se
     * pide hasta que una página vuelve incompleta, que es lo que la propia
     * documentación dice que hay que hacer.
     */
    const lista = Array.isArray(lote) ? lote.map((x) => x?.product || x).filter(Boolean) : [];
    productos.push(...lista);
    if (lista.length < TAM_PAGINA) break;
  }
  return productos;
}

const ORDEN_ESTADO = { available: 0, featured: 0, 'not-available': 1, disabled: 2 };
const NOMBRE_ESTADO = {
  available: 'Disponible', featured: 'Destacado',
  'not-available': 'No disponible', disabled: 'Deshabilitada',
};

const limpiarSku = (v) => {
  const t = String(v ?? '').trim();
  return t || null;
};

/** Una candidata por variante, o una por producto cuando no tiene variantes. */
function candidatasDeProducto(p) {
  const base = {
    productId: Number(p.id),
    titulo: p.name || '',
    permalink: p.permalink || null,
    estado: p.status || null,
    precio: Number(p.price) || 0,
  };
  if (Array.isArray(p.variants) && p.variants.length) {
    return p.variants.map((v) => ({
      ...base,
      variantId: Number(v.id),
      sku: limpiarSku(v.sku),
      stockActual: Number(v.stock) || 0,
      ilimitado: Boolean(v.stock_unlimited),
    }));
  }
  return [{
    ...base,
    variantId: null,
    sku: limpiarSku(p.sku),
    stockActual: Number(p.stock) || 0,
    ilimitado: Boolean(p.stock_unlimited),
  }];
}

/*
 * Con el mismo SKU repetido se usa una sola: la que está a la venta antes que
 * la que no, y la que lleva la cuenta del stock antes que la de stock
 * ilimitado. El id desempata para que el resultado no cambie entre corridas.
 */
function compararCandidatas(a, b) {
  const clave = (c) => [
    ORDEN_ESTADO[c.estado] ?? 3,
    c.ilimitado ? 1 : 0,
    c.productId,
    c.variantId || 0,
  ];
  const ka = clave(a);
  const kb = clave(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return 0;
}

/** SKU → la publicación asignada, con las repetidas en `otras`. */
function mapearPorSku(productos) {
  const porSku = new Map();
  for (const p of productos) {
    for (const c of candidatasDeProducto(p)) {
      if (!c.sku) continue;
      if (!porSku.has(c.sku)) porSku.set(c.sku, []);
      porSku.get(c.sku).push(c);
    }
  }
  const salida = new Map();
  for (const [sku, lista] of porSku) {
    lista.sort(compararCandidatas);
    salida.set(sku, { ...lista[0], otras: lista.slice(1) });
  }
  return salida;
}

/**
 * El mapa SKU → publicación de la tienda. Se reusa el guardado mientras siga
 * fresco Y tenga los SKU que se están por mandar; si no, se lista de nuevo.
 */
async function mapaDeSkus(cuenta, { skus = null } = {}) {
  const guardado = cacheTiendas.get(cuenta.businessId);
  const fresco = guardado && guardado.vence > Date.now();
  if (fresco && skus?.length && skus.every((sku) => guardado.porSku.has(sku))) {
    return guardado;
  }
  const productos = await listarProductos(cuenta);
  const entrada = { vence: Date.now() + CACHE_MS, porSku: mapearPorSku(productos), productos: productos.length };
  cacheTiendas.set(cuenta.businessId, entrada);
  return entrada;
}

/** Manda el stock de una variante o de un producto sin variantes. */
async function enviarStock(cuenta, destino, cantidad) {
  if (destino.variantId) {
    return pedir(cuenta, 'put', `/products/${destino.productId}/variants/${destino.variantId}.json`, {
      cuerpo: { variant: { stock: cantidad } },
    });
  }
  /*
   * El producto se edita con nombre y precio: la API los pide en el cuerpo, y
   * se mandan los que ya tiene para no cambiar nada más que el stock.
   */
  return pedir(cuenta, 'put', `/products/${destino.productId}.json`, {
    cuerpo: { product: { name: destino.titulo, price: destino.precio, stock: cantidad } },
  });
}

/**
 * Sincroniza el stock de Stocker hacia Jumpseller, cruzando por SKU.
 *
 * @param {number} businessId
 * @param {object} opts
 * @param {boolean} opts.simular  Calcula los cambios y no manda nada.
 * @param {string[]} opts.skus    Sólo esos SKU.
 */
async function sincronizarStock(businessId, { simular = false, skus = null } = {}) {
  const cuenta = await cuentaDe(businessId);
  if (!cuenta) throw error('No hay una tienda de Jumpseller conectada.', 400);

  const locales = await stockService.localesQueAbastecenOnline(businessId);
  if (!locales.length) {
    throw error(
      'Ningún local está marcado para abastecer las ventas online. Marcá al menos uno desde '
      + 'Empleados → Locales: ese es el stock que se va a publicar.',
      409, { detalles: { codigo: 'SIN_LUGAR_ONLINE' } },
    );
  }

  const { porSku, productos: cuantosProductos } = await mapaDeSkus(cuenta, { skus });
  const variantes = await variantesPublicables(businessId);
  const cantidades = await cantidadesPublicables(businessId, locales, variantes);

  const resultados = [];
  const aMandar = [];
  const sinPublicacion = [];

  for (const v of variantes) {
    if (skus && !skus.includes(v.sku)) continue;
    const destino = porSku.get(v.sku);
    if (!destino) { sinPublicacion.push(v.id); continue; }

    const { margen: margenMl, cantidad } = cantidades.get(v.id) || { margen: 0, cantidad: 0 };
    const fila = {
      sku: v.sku,
      titulo: v.producto?.titulo || destino.titulo,
      margen: margenMl,
      productId: destino.productId,
      variantId: destino.variantId,
      permalink: destino.permalink,
      estadoTienda: destino.estado,
      estadoTiendaNombre: NOMBRE_ESTADO[destino.estado] || destino.estado || null,
      stockStocker: cantidad,
      stockTienda: destino.ilimitado ? null : destino.stockActual,
      lugar: locales.map((l) => l.nombre).join(', '),
      otras: (destino.otras || []).map((o) => ({
        productId: o.productId, variantId: o.variantId, titulo: o.titulo,
        permalink: o.permalink, estadoTienda: o.estado, stockTienda: o.ilimitado ? null : o.stockActual,
      })),
    };

    /*
     * Un producto con stock ilimitado no lleva la cuenta de las unidades: es
     * una decisión de la tienda, y pisarla con un número sería apagarla sin
     * avisar.
     */
    if (destino.ilimitado) {
      resultados.push({
        ...fila, estado: 'no-sincronizable',
        motivo: 'Tiene stock ilimitado en Jumpseller: no lleva la cuenta de las unidades.',
      });
      continue;
    }
    if (destino.estado === 'disabled') {
      fila.aviso = 'Está deshabilitada en Jumpseller: se le actualiza el stock, pero no se ve en la tienda.';
    }
    if (destino.stockActual === cantidad) {
      resultados.push({ ...fila, estado: 'sin-cambios' });
      continue;
    }
    if (simular) {
      resultados.push({ ...fila, estado: 'pendiente' });
      continue;
    }
    aMandar.push({ v, destino, cantidad, fila });
  }

  if (!simular && aMandar.length) {
    const enviados = await enParalelo(aMandar, CONCURRENCIA, async ({ destino, cantidad, fila }) => {
      try {
        await enviarStock(cuenta, destino, cantidad);
        // El mapa guardado queda al día: si no, la próxima venta creería que
        // la tienda sigue teniendo el número viejo.
        destino.stockActual = cantidad;
        return { ...fila, estado: 'actualizado' };
      } catch (err) {
        return { ...fila, estado: 'error', error: detalleDeError(err) };
      }
    });
    resultados.push(...enviados);
  }

  const resumen = {
    actualizados: resultados.filter((r) => r.estado === 'actualizado').length,
    pendientes: resultados.filter((r) => r.estado === 'pendiente').length,
    sinCambios: resultados.filter((r) => r.estado === 'sin-cambios').length,
    errores: resultados.filter((r) => r.estado === 'error').length,
    noSincronizables: resultados.filter((r) => r.estado === 'no-sincronizable').length,
  };

  if (!simular) {
    const conError = resultados.find((r) => r.estado === 'error');
    await cuenta.update({
      ultimaSync: new Date(),
      ultimoError: conError ? String(conError.error).slice(0, 500) : null,
    });
    if (resumen.actualizados) {
      log.info('jumpseller', 'stock sincronizado', { businessId, actualizados: resumen.actualizados });
    }
  }

  return {
    simulado: simular,
    lugares: locales.map((l) => ({ id: l.id, nombre: l.nombre, tipo: l.tipo })),
    productosEncontrados: cuantosProductos,
    skusEnTienda: porSku.size,
    sinPublicacion: sinPublicacion.length,
    resultados,
    resumen,
  };
}

module.exports = {
  estado,
  conectar,
  desconectar,
  listarProductos,
  mapearPorSku,
  sincronizarStock,
};
