/*
 * Lo que un asistente con IA le pregunta a Stocker.
 *
 * Con una credencial de origen 'asistente' (la emite el equipo desde el
 * backoffice): buscar productos escritos como los pide una persona, reconocer
 * al cliente por teléfono, CUIT o mail, y dejar un pedido en la bandeja de
 * mayoristas para que una persona lo acepte. La IA nunca inventa stock ni
 * precios: los toma de acá.
 *
 * Va por HTTP contra el router real en un puerto efímero, con la cuenta demo.
 */

require('dotenv').config({ path: __dirname + '/../.env' });

let ok = 0;
let ko = 0;
const chk = (t, esperado, obtenido) => {
  const igual = JSON.stringify(esperado) === JSON.stringify(obtenido);
  console.log(`  ${igual ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${t}`);
  if (!igual) console.log(`      esperaba ${JSON.stringify(esperado)} · vino ${JSON.stringify(obtenido)}`);
  igual ? (ok += 1) : (ko += 1);
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

(async () => {
  const express = require('express');
  const db = require('../src/config/database');
  const { Business, BusinessLocation, Client, Product, ProductVariant, VariantStock, SolicitudMayorista, SolicitudMayoristaItem, IntegracionExterna } = require('../src/models');
  const integraciones = require('../src/services/integracionesService');
  const { errorHandler } = require('../src/middleware/errorHandler');

  const app = express();
  app.use(express.json());
  app.use('/api', require('../src/routes'));
  app.use(errorHandler);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/integraciones/asistente`;

  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  /*
   * La credencial de la prueba se crea directo y no con emitir(): emitir anula
   * la que ya esté activa, y en una base de desarrollo esa es la del
   * asistente-local que se está probando a mano.
   */
  const token = require('crypto').randomBytes(24).toString('base64url');
  const integracion = await IntegracionExterna.create({
    businessId: negocio.id, origen: 'asistente', nombre: 'QA asistente',
    tokenHash: integraciones.__hash(token), pista: token.slice(-6), activa: true,
  });
  const pedir = async (metodo, ruta, cuerpo, conToken = true) => {
    const r = await fetch(base + ruta, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(conToken ? { Authorization: `Bearer ${token}` } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    let json = null;
    try { json = await r.json(); } catch { /* sin cuerpo */ }
    return { status: r.status, json };
  };
  const normal = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  const cliente = await Client.create({
    businessId: negocio.id, nombre: 'QA Asistente', cuit: '30719999995',
    telefono: '11 5555-1234', email: 'qa.asistente@cliente.example', tipo: 'mayorista',
  });

  try {
    tit('1. SIN CREDENCIAL NO SE PREGUNTA NADA');
    chk('sin token: 401', 401, (await pedir('GET', '/productos?texto=jean', null, false)).status);

    tit('1b. A QUÉ NEGOCIO APUNTA LA CREDENCIAL');
    const neg = await pedir('GET', '/negocio');
    chk('el nombre del negocio de la credencial', negocio.nombreNegocio, neg.json?.nombre);
    const atienden = await BusinessLocation.findAll({ where: { businessId: negocio.id, activo: true, tipo: ['local', 'feria'] }, order: [['id', 'ASC']] });
    chk('sus locales que atienden público, con dirección', atienden.map((l) => [l.nombre, l.direccion]),
      (neg.json?.locales || []).map((l) => [l.nombre, l.direccion]));
    const noAtienden = await BusinessLocation.count({ where: { businessId: negocio.id, tipo: ['deposito', 'online'] } });
    chk(`ni depósitos ni la tienda online (la demo tiene ${noAtienden})`, false,
      (neg.json?.locales || []).some((l) => /dep[oó]sito|online/i.test(l.nombre)));
    chk('y la regla mayorista en texto', true, /mayorista/i.test(neg.json?.reglaMayorista?.texto || ''));

    tit('2. BUSCAR PRODUCTOS COMO LOS ESCRIBE UNA PERSONA');
    const jeans = await pedir('GET', '/productos?texto=jeans');
    chk('responde', 200, jeans.status);
    chk('"jeans" encuentra los jeans (por la categoría, aunque el título diga "Jean")', true,
      (jeans.json?.productos || []).some((p) => normal(p.categoria) === 'jeans'));
    const uno = jeans.json?.productos?.[0];
    chk('cada producto trae su SKU agrupador (la clave del producto en el portal mayorista)', true,
      (jeans.json?.productos || []).length > 0 && jeans.json.productos.every((p) => typeof p.skuAgrupador === 'string' && p.skuAgrupador.length > 0));
    chk('cada variante trae SKU, disponible y los dos precios', true,
      Boolean(uno?.variantes?.every((v) => v.sku && Number.isFinite(v.disponible) && v.precioMayorista != null && v.precioMinorista != null)));
    chk('y la regla mayorista en texto, para decirla', true, /Mayorista|mayorista/.test(jeans.json?.reglaMayorista?.texto || ''));
    // El jean de la demo viene en 36 a 40: "Mom" no cuenta como M, y vuelve con sus talles reales para decir que M no hay.
    const jeanM = (await pedir('GET', '/productos?texto=jean%20talle%20m')).json?.productos || [];
    chk('"jean talle m": la m no encuentra "Mom" (ninguna variante M)', [true, false],
      [jeanM.length > 0 && jeanM.every((p) => /jean/i.test(p.titulo)), jeanM.some((p) => p.variantes.some((v) => normal(v.talle) === 'm'))]);
    // Palabras de dos productos distintos: antes exigía las dos en el mismo y no traía nada.
    const dos = ((await pedir('GET', '/productos?texto=canguro%20cargo')).json?.productos || []).map((p) => p.titulo);
    chk('"canguro cargo" trae el buzo canguro y el pantalón cargo', [true, true],
      [dos.some((x) => /canguro/i.test(x)), dos.some((x) => /cargo/i.test(x))]);
    // "cargo" nombra un solo producto; "buzo" y "canguro", varios: con tope 2 el cargo no puede quedar afuera.
    chk('con tope, la palabra que nombra un solo producto no queda afuera', true,
      ((await pedir('GET', '/productos?texto=buzo%20canguro%20cargo&limite=2')).json?.productos || []).some((p) => /cargo/i.test(p.titulo)));
    const buzoM = await pedir('GET', '/productos?texto=buzo%20talle%20m');
    // El producto entero, para ofrecer otro talle o color si el pedido no está; primero el que tiene M.
    chk('"buzo talle m" trae los buzos enteros, primero uno con M en stock', [true, true, true],
      [(buzoM.json?.productos || []).length > 0,
        (buzoM.json?.productos || []).every((p) => /buzo/i.test(p.titulo) && p.variantes.some((v) => normal(v.talle) !== 'm')),
        Boolean(buzoM.json?.productos?.[0]?.variantes.some((v) => normal(v.talle) === 'm' && v.disponible > 0))]);
    // La remera oversize va primero en el catálogo pero no viene en verde: primero el buzo, que sí.
    const verde = (await pedir('GET', '/productos?texto=oversize%20verde')).json?.productos || [];
    chk('"oversize verde": primero un oversize con verde en stock, y siguen los otros oversize', [true, true],
      [Boolean(verde[0]?.variantes.some((v) => normal(v.color) === 'verde' && v.disponible > 0)), verde.some((p) => /remera oversize/i.test(p.titulo))]);
    chk('algo que no existe no inventa nada', [], (await pedir('GET', '/productos?texto=heladera%20samsung')).json?.productos);
    chk('las palabras que no están en ningún producto no filtran ("buzo para mi local")', true,
      ((await pedir('GET', `/productos?texto=${encodeURIComponent('un buzo para mi local')}`)).json?.productos || [])
        .some((p) => /buzo/i.test(p.titulo)));

    tit('2b. EL STOCK ES EL DE TODOS LOS LOCALES QUE VENDEN');
    /*
     * El pedido del asistente lo acepta una persona y sale de su local: cuenta
     * el stock de todos los locales, no sólo de los que abastecen lo online.
     * Belgrano deja de abastecer lo online durante la prueba y su stock tiene
     * que seguir contando.
     */
    const belgrano = await BusinessLocation.findOne({ where: { businessId: negocio.id, nombre: 'Local Belgrano' } });
    const abastecia = belgrano.abasteceOnline;
    await belgrano.update({ abasteceOnline: false });
    try {
      const jean = (await pedir('GET', '/productos?texto=jean')).json?.productos?.[0];
      const skus = (jean?.variantes || []).map((v) => v.sku);
      const delNegocio = (await Product.findAll({ where: { businessId: negocio.id }, attributes: ['id'] })).map((p) => p.id);
      const ids = new Map((await ProductVariant.findAll({ where: { sku: skus, productId: delNegocio }, attributes: ['id', 'sku'] })).map((v) => [v.id, v.sku]));
      const queVenden = await BusinessLocation.findAll({ where: { businessId: negocio.id, activo: true, tipo: 'local' } });
      const libre = new Map(skus.map((s) => [s, 0]));
      let enBelgrano = 0;
      for (const f of await VariantStock.findAll({ where: { businessId: negocio.id, productVariantId: [...ids.keys()], locationId: queVenden.map((l) => l.id) } })) {
        const x = Math.max(0, Number(f.stock) - Number(f.reservado || 0));
        libre.set(ids.get(f.productVariantId), libre.get(ids.get(f.productVariantId)) + x);
        if (f.locationId === belgrano.id) enBelgrano += x;
      }
      chk(`la prueba tiene stock en Belgrano (${enBelgrano})`, true, enBelgrano > 0);
      chk('disponible = lo libre de todos los locales que venden, sin depósito ni online', Object.fromEntries(libre),
        Object.fromEntries((jean?.variantes || []).map((v) => [v.sku, v.disponible])));
    } finally {
      await belgrano.update({ abasteceOnline: abastecia });
    }

    tit('3. RECONOCER AL CLIENTE');
    const porTel = await pedir('GET', '/clientes?telefono=%2B5491155551234');
    chk('por el teléfono, aunque llegue con +54 9', [cliente.id], (porTel.json?.clientes || []).map((c) => c.id));
    chk('dice que es mayorista', true, porTel.json?.clientes?.[0]?.mayorista);
    chk('por el CUIT con guiones', [cliente.id], ((await pedir('GET', '/clientes?cuit=30-71999999-5')).json?.clientes || []).map((c) => c.id));
    chk('por el mail', [cliente.id], ((await pedir('GET', '/clientes?email=QA.asistente@cliente.example')).json?.clientes || []).map((c) => c.id));
    chk('sin datos no devuelve a nadie', [], (await pedir('GET', '/clientes')).json?.clientes);
    chk('no manda la ficha entera (ni el mail ni el teléfono)', ['apellido', 'cuit', 'id', 'mayorista', 'nombre', 'tipo'],
      Object.keys(porTel.json?.clientes?.[0] || {}).sort());

    tit('4. EL PEDIDO VA A LA BANDEJA');
    const sku = uno?.variantes?.[0]?.sku;
    const pedido = await pedir('POST', '/pedidos', {
      pedidoExterno: 'QA-ASIS-1', items: [{ sku, cantidad: 3 }],
      cliente: { nombre: 'QA Asistente', cuit: '30719999995', telefono: '1155551234', tipo: 'mayorista' },
    });
    chk('se recibe', true, [200, 201, 202].includes(pedido.status));
    const enBandeja = await SolicitudMayorista.findOne({ where: { businessId: negocio.id, pedidoExterno: 'QA-ASIS-1' } });
    chk('queda pendiente en la bandeja, con origen asistente', ['pendiente', 'asistente'], [enBandeja?.estado, enBandeja?.origen]);
    chk('el stock por SKU responde igual que el de la tienda', true,
      Number.isFinite((await pedir('GET', `/stock?skus=${encodeURIComponent(sku)}`)).json?.stock?.[sku]));
  } finally {
    const s = await SolicitudMayorista.findOne({ where: { businessId: negocio.id, pedidoExterno: 'QA-ASIS-1' } });
    if (s) { await SolicitudMayoristaItem.destroy({ where: { solicitudId: s.id } }); await s.destroy(); }
    await cliente.destroy();
    await IntegracionExterna.destroy({ where: { id: integracion.id } });
    server.close();
    await db.close().catch(() => {});
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
