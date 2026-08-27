/*
 * Ingreso por curvas, y la aprobación de reposición sin stock declarado.
 *
 * CURVAS. La mercadería no llega en unidades sueltas: llega en corridas. "20
 * curvas de pantalón negro" son 20 de cada talle de ese color — con 5 talles,
 * 100 unidades. Cargarlo talle por talle es escribir cinco líneas para decir
 * una sola cosa, y con veinte modelos por camión es donde aparecen los errores.
 *
 * La curva pareja es el caso del ejemplo. La despareja —1-2-2-1 en S-M-L-XL— es
 * como suele venir realmente una compra de indumentaria, así que sin ella la
 * primera compra real no entraría.
 *
 * REPOSICIÓN. Antes, un pedido sin stock declarado se rechazaba. La realidad
 * del depósito es otra: hay mercadería física sin cargar, y frenar ahí obligaba
 * a inventar un ingreso sólo para poder aprobar algo que ya estaba en el
 * estante. Ahora se aprueba y el faltante queda escrito.
 *
 * Uso:  API=http://localhost:3000 node scripts/test-curvas.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const { Op } = require('sequelize');
const API = process.env.API || 'http://localhost:3000';
const {
  Business, BusinessLocation, Product, ProductVariant, VariantStock,
  StockIngreso, StockIngresoItem, StockMovement, PedidoReposicion, PedidoReposicionItem,
} = require('../src/models');
const stockService = require('../src/services/stockService');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

function sesion() {
  let cookie = '';
  return async (metodo, ruta, cuerpo) => {
    const r = await fetch(`${API}${ruta}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    const set = r.headers.getSetCookie?.() || [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    let json = null; try { json = JSON.parse(await r.text()); } catch { /* no json */ }
    return { status: r.status, json };
  };
}

(async () => {
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  const deposito = await BusinessLocation.findOne({
    where: { businessId: negocio.id, tipo: 'deposito', activo: true },
  });
  if (!deposito) { console.log('El negocio no tiene depósito.'); process.exit(1); }

  // Un producto con DOS dimensiones: la curva se abre sobre la segunda.
  const conDos = await ProductVariant.findOne({
    where: { businessId: negocio.id, variante2Valor: { [Op.ne]: null }, activo: true },
    include: [{ model: Product, as: 'producto', required: true }],
  });
  const producto = conDos.producto;
  const color = conDos.variante1Valor;

  const api = sesion();
  const login = await api('POST', '/api/auth/login', { email: negocio.email, password: 'Demo2026!!' });
  if (login.status !== 200) { console.log('No se pudo entrar:', login.status); process.exit(1); }

  const ingresos = [];
  const stockInicial = new Map();
  const guardarStock = async (ids) => {
    for (const id of ids) if (!stockInicial.has(id)) stockInicial.set(id, await stockService.stockEn(id, deposito.id));
  };

  tit('1. QUÉ ABRE UNA CURVA');
  const previa = await api('GET', `/api/deposito/curva?productId=${producto.id}&valor=${encodeURIComponent(color)}`);
  chk('la consulta responde', 200, previa.status);
  chk('sobre el eje del talle', true, Boolean(previa.json?.eje));
  chk('con el color fijo', color, previa.json?.fijo);
  const talles = previa.json.valores;
  chk('y sus talles', true, talles.length >= 2);
  chk('unidades por curva = cantidad de talles', talles.length, previa.json?.unidadesPorCurva);

  const idsCurva = talles.map((v) => v.variantId);
  await guardarStock(idsCurva);

  tit('2. CURVA PAREJA');
  const N = 20;
  const pareja = await api('POST', '/api/deposito/ingresos', {
    origen: 'etiquetas',
    curvas: [{ productId: producto.id, valor: color, cantidad: N }],
  });
  chk('el ingreso entra', 201, pareja.status);
  if (pareja.json?.id) ingresos.push(pareja.json.id);
  chk('genera una línea por talle', talles.length, (pareja.json?.items || []).length);
  chk('todas con la misma cantidad', [N],
    [...new Set((pareja.json?.items || []).map((i) => i.cantidad))]);

  let totalEsperado = 0;
  for (const v of talles) {
    const ahora = await stockService.stockEn(v.variantId, deposito.id);
    totalEsperado += N;
    if (ahora !== stockInicial.get(v.variantId) + N) {
      chk(`el talle ${v.valor} subió ${N}`, stockInicial.get(v.variantId) + N, ahora);
    }
  }
  chk(`entraron ${N} × ${talles.length} = ${totalEsperado} unidades`, totalEsperado,
    (pareja.json?.items || []).reduce((s, i) => s + i.cantidad, 0));

  tit('3. CURVA DESPAREJA');
  // Como llega de verdad del proveedor: menos de los extremos, más del medio.
  const reparto = {};
  talles.forEach((v, i) => { reparto[v.valor] = i === 0 || i === talles.length - 1 ? 1 : 3; });
  const esperadoDesparejo = Object.values(reparto).reduce((a, b) => a + b, 0);

  const desparejo = await api('POST', '/api/deposito/ingresos', {
    origen: 'etiquetas',
    curvas: [{ productId: producto.id, valor: color, porValor: reparto }],
  });
  chk('el ingreso entra', 201, desparejo.status);
  if (desparejo.json?.id) ingresos.push(desparejo.json.id);
  chk('reparte distinto por talle', esperadoDesparejo,
    (desparejo.json?.items || []).reduce((s, i) => s + i.cantidad, 0));
  chk('los extremos llevan 1', 1,
    (desparejo.json?.items || []).find((i) => i.sku === talles[0].sku)?.cantidad);

  tit('4. CURVA Y LÍNEAS SUELTAS EN EL MISMO REMITO');
  /*
   * Un camión trae corridas de algunos modelos y unidades sueltas de otros.
   * Si una línea suelta cae sobre una variante que la curva ya tocó, se suman:
   * contando bultos es normal encontrar lo mismo en dos cajas.
   */
  const mixto = await api('POST', '/api/deposito/ingresos', {
    origen: 'etiquetas',
    curvas: [{ productId: producto.id, valor: color, cantidad: 2 }],
    items: [{ productVariantId: talles[0].variantId, cantidad: 5 }],
  });
  chk('el ingreso entra', 201, mixto.status);
  if (mixto.json?.id) ingresos.push(mixto.json.id);
  chk('la variante repetida queda sumada, no duplicada', 7,
    (mixto.json?.items || []).find((i) => i.sku === talles[0].sku)?.cantidad);
  chk('y sigue habiendo una línea por talle', talles.length, (mixto.json?.items || []).length);

  tit('5. LO QUE LA CURVA NO DEJA HACER');
  const sinColor = await api('POST', '/api/deposito/ingresos', {
    origen: 'etiquetas', curvas: [{ productId: producto.id, cantidad: 5 }],
  });
  chk('con dos dimensiones, exige elegir el color', 400, sinColor.status);
  chk('y dice cuáles hay', true, /:/.test(sinColor.json?.message || ''));

  const colorInventado = await api('POST', '/api/deposito/ingresos', {
    origen: 'etiquetas', curvas: [{ productId: producto.id, valor: 'Fucsia Imposible', cantidad: 5 }],
  });
  chk('un color que no existe se rechaza', 404, colorInventado.status);

  const sinCantidad = await api('POST', '/api/deposito/ingresos', {
    origen: 'etiquetas', curvas: [{ productId: producto.id, valor: color }],
  });
  chk('sin cantidad se rechaza', 400, sinCantidad.status);

  const todoCero = await api('POST', '/api/deposito/ingresos', {
    origen: 'etiquetas',
    curvas: [{ productId: producto.id, valor: color, porValor: Object.fromEntries(talles.map((v) => [v.valor, 0])) }],
  });
  chk('una curva que suma cero se rechaza', 400, todoCero.status);

  tit('6. APROBAR REPOSICIÓN SIN STOCK DECLARADO');
  /*
   * Se arma un pedido de un artículo que en el depósito figura en cero. Antes
   * esto se rechazaba de plano; ahora se aprueba y el faltante queda escrito.
   */
  const local = await BusinessLocation.findOne({
    where: { businessId: negocio.id, tipo: 'local', activo: true },
  });
  const enCero = await ProductVariant.findOne({
    where: { businessId: negocio.id, activo: true, id: { [Op.notIn]: idsCurva } },
  });
  const antesEnDeposito = await stockService.stockEn(enCero.id, deposito.id);
  if (antesEnDeposito > 0) {
    await stockService.mover({
      variantId: enCero.id, businessId: negocio.id, locationId: deposito.id,
      fijar: 0, tipo: 'ajuste', motivo: 'Prueba de curvas', registrarMovimiento: false,
    });
  }

  const pedido = await api('POST', '/api/reposicion/pedidos', {
    locationId: local.id,
    items: [{ productVariantId: enCero.id, cantidad: 10 }],
  });
  chk('el local pide reposición', 201, pedido.status);

  const aprobado = await api('POST', `/api/reposicion/pedidos/${pedido.json.pedido?.id || pedido.json.id}/aprobar`, {});
  chk('oficina lo aprueba igual, sin stock declarado', 200, aprobado.status);
  chk('pero avisa que falta', true, Boolean(aprobado.json?.aviso));
  chk('y el aviso queda escrito en el pedido', true,
    /sin stock declarado|faltante/i.test(
      (await PedidoReposicion.findByPk(pedido.json.pedido?.id || pedido.json.id))?.notas || '',
    ));

  tit('Limpieza');
  const pedidoId = pedido.json.pedido?.id || pedido.json.id;
  if (pedidoId) {
    await PedidoReposicionItem.destroy({ where: { pedidoId } });
    await PedidoReposicion.destroy({ where: { id: pedidoId } });
  }
  for (const id of ingresos) {
    await StockIngresoItem.destroy({ where: { ingresoId: id } });
    await StockIngreso.destroy({ where: { id } });
  }
  // El stock vuelve a como estaba: esto corrió contra el depósito de verdad.
  for (const [variantId, valor] of stockInicial) {
    await StockMovement.destroy({ where: { productVariantId: variantId, motivo: { [Op.like]: '%ING-%' } } });
    await stockService.mover({
      variantId, businessId: negocio.id, locationId: deposito.id,
      fijar: valor, tipo: 'ajuste', motivo: 'Limpieza test-curvas', registrarMovimiento: false,
    });
  }
  if (antesEnDeposito > 0) {
    await stockService.mover({
      variantId: enCero.id, businessId: negocio.id, locationId: deposito.id,
      fijar: antesEnDeposito, tipo: 'ajuste', motivo: 'Limpieza test-curvas', registrarMovimiento: false,
    });
  }
  let vuelto = true;
  for (const [variantId, valor] of stockInicial) {
    if (await stockService.stockEn(variantId, deposito.id) !== valor) vuelto = false;
  }
  chk('el stock del depósito quedó como estaba', true, vuelto);

  console.log(`\n\x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
