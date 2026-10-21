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
  const { Business, Client, SolicitudMayorista, SolicitudMayoristaItem, IntegracionExterna } = require('../src/models');
  const integraciones = require('../src/services/integracionesService');
  const { errorHandler } = require('../src/middleware/errorHandler');

  const app = express();
  app.use(express.json());
  app.use('/api', require('../src/routes'));
  app.use(errorHandler);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/integraciones/asistente`;

  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  const { token, integracion } = await integraciones.emitir({ businessId: negocio.id, origen: 'asistente', nombre: 'QA asistente' });
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

    tit('2. BUSCAR PRODUCTOS COMO LOS ESCRIBE UNA PERSONA');
    const jeans = await pedir('GET', '/productos?texto=jeans');
    chk('responde', 200, jeans.status);
    chk('"jeans" encuentra los jeans (por la categoría, aunque el título diga "Jean")', true,
      (jeans.json?.productos || []).some((p) => normal(p.categoria) === 'jeans'));
    const uno = jeans.json?.productos?.[0];
    chk('cada variante trae SKU, disponible y los dos precios', true,
      Boolean(uno?.variantes?.every((v) => v.sku && Number.isFinite(v.disponible) && v.precioMayorista != null && v.precioMinorista != null)));
    chk('y la regla mayorista en texto, para decirla', true, /Mayorista|mayorista/.test(jeans.json?.reglaMayorista?.texto || ''));
    // El jean de la demo viene en 36 a 40: sin talle M no hay nada, y "Mom" no cuenta como M.
    chk('"jean talle m": la m no encuentra "Mom"', [], (await pedir('GET', '/productos?texto=jean%20talle%20m')).json?.productos);
    const buzoM = await pedir('GET', '/productos?texto=buzo%20talle%20m');
    chk('"buzo talle m" trae sólo las variantes M', true,
      (buzoM.json?.productos || []).length > 0
      && buzoM.json.productos.every((p) => p.variantes.every((v) => Object.values(v).some((x) => normal(x) === 'm'))));
    chk('algo que no existe no inventa nada', [], (await pedir('GET', '/productos?texto=heladera%20samsung')).json?.productos);

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
