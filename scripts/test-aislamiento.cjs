/*
 * Que un negocio no vea ni toque lo de otro, y que la sesión se pueda cortar.
 *
 * Estas tres reglas no las cubría nada y las tres estaban rotas:
 *
 *   · Una venta aceptaba el clientId de otro inquilino, guardaba la venta con
 *     él y devolvía su ficha entera —mail, teléfono, CUIT, DNI, límite de
 *     crédito y saldo—, porque la asociación `cliente` se incluye sin filtro.
 *     En una venta de verdad, además, le mandaba a esa persona el comprobante
 *     y un WhatsApp por una compra que nunca hizo.
 *
 *   · Desactivar o borrar un empleado no le cortaba el acceso: los permisos
 *     viajaban dentro del token y nunca se releía la base.
 *
 *   · El candado de suscripción se montaba antes de que existiera req.auth, así
 *     que nunca se cerraba: una cuenta impaga seguía escribiendo.
 *
 * Uso:  API=http://localhost:3000 node scripts/test-aislamiento.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const { Op } = require('sequelize');
const API = process.env.API || 'http://localhost:3000';
const {
  Business, Client, Employee, Role, Sale, SaleItem, Subscription, ProductVariant,
  BusinessLocation, VariantStock,
} = require('../src/models');

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
    const texto = await r.text();
    let json = null; try { json = JSON.parse(texto); } catch { /* no json */ }
    return { status: r.status, json };
  };
}

(async () => {
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  if (!negocio) { console.log('Falta el negocio demo.'); process.exit(1); }

  const local = await BusinessLocation.findOne({
    where: { businessId: negocio.id, tipo: 'local', activo: true },
  });
  const existencia = (await VariantStock.findAll({ where: { locationId: local.id }, limit: 300 }))
    .find((e) => (e.stock ?? 0) >= 5);
  const variante = await ProductVariant.findByPk(existencia.productVariantId);

  const api = sesion();
  const login = await api('POST', '/api/auth/login', { email: negocio.email, password: 'Demo2026!!' });
  if (login.status !== 200) { console.log('No se pudo entrar:', login.status); process.exit(1); }

  const creados = [];
  const linea = { productVariantId: variante.id, cantidad: 1, precioUnitario: 100 };
  /* Se cotiza en vez de vender: una cotización no dispara el mail ni el
     WhatsApp al cliente, y para lo que se mide da igual. */
  const cotizar = async (extra) => {
    const r = await api('POST', '/api/sales', {
      tipo: 'cotizacion', estado: 'pendiente', locationId: local.id, items: [linea], ...extra,
    });
    if (r.json?.id) creados.push(r.json.id);
    return r;
  };

  tit('1. EL CLIENTE TIENE QUE SER DE ESTE NEGOCIO');
  const ajeno = await Client.findOne({
    where: { businessId: { [Op.ne]: negocio.id } }, attributes: ['id', 'businessId'],
  });
  if (ajeno) {
    const conAjeno = await cotizar({ clientId: ajeno.id });
    chk('un clientId de otro negocio se rechaza', 404, conAjeno.status);
    chk('y no viaja ni un dato de su ficha', true, !conAjeno.json?.cliente);
  } else {
    console.log('  \x1b[33m—\x1b[0m no hay clientes de otro negocio para probar la fuga');
  }

  const propio = await Client.findOne({ where: { businessId: negocio.id }, attributes: ['id'] });
  const conPropio = await cotizar({ clientId: propio.id });
  chk('el cliente propio sigue funcionando', 201, conPropio.status);
  const sinCliente = await cotizar({});
  chk('y consumidor final también', 201, sinCliente.status);

  tit('2. LA SESIÓN DEL EMPLEADO SE PUEDE CORTAR');
  const rol = await Role.findOne({ where: { businessId: negocio.id } });
  const alta = await api('POST', '/api/employees', {
    nombre: 'Aislamiento', apellido: 'QA', dni: '39777001',
    email: 'aislamiento.qa@test.local', password: 'AislaQa2026!', roleId: rol?.id,
  });
  chk('se crea el empleado de prueba', 201, alta.status);

  const emp = sesion();
  const entro = await emp('POST', '/api/auth/employee-login', {
    email: 'aislamiento.qa@test.local', password: 'AislaQa2026!',
  });
  chk('el empleado entra', 200, entro.status);
  chk('y su sesión sirve', 200, (await emp('GET', '/api/auth/me')).status);

  await api('PATCH', `/api/employees/${alta.json.id}/toggle`);
  chk('desactivado: la sesión abierta deja de servir EN EL ACTO', 401, (await emp('GET', '/api/auth/me')).status);

  await api('PATCH', `/api/employees/${alta.json.id}/toggle`);
  chk('reactivado: la misma sesión vuelve a valer', 200, (await emp('GET', '/api/auth/me')).status);

  // El cargo también se relee: cambiarlo surte efecto sin volver a entrar.
  const rolVacio = await api('POST', '/api/roles', { nombre: `QA sin permisos ${Date.now()}`, permisos: {} });
  if (rolVacio.status === 201) {
    await api('PUT', `/api/employees/${alta.json.id}`, { roleId: rolVacio.json.id });
    chk('quitarle los permisos surte efecto sin relogueo', 403, (await emp('GET', '/api/stock/por-local')).status);
    await api('PUT', `/api/employees/${alta.json.id}`, { roleId: rol?.id });
  }

  await api('DELETE', `/api/employees/${alta.json.id}`);
  chk('borrado: la sesión muere', 401, (await emp('GET', '/api/auth/me')).status);

  tit('2.b NADIE SE EDITA SUS PROPIOS PERMISOS');
  /*
   * Quien administra cargos podía editar el suyo y otorgarse facturación, caja
   * y aprobaciones sin que el dueño se enterara. Desde que los permisos se
   * releen en cada pedido, además, surtía efecto en el acto.
   */
  const emp2 = sesion();
  const alta2 = await api('POST', '/api/employees', {
    nombre: 'Cargo', apellido: 'QA', dni: '39777002',
    email: 'cargo.qa@test.local', password: 'CargoQa2026!', roleId: rol?.id,
  });
  await emp2('POST', '/api/auth/employee-login', {
    email: 'cargo.qa@test.local', password: 'CargoQa2026!',
  });
  const cargoPropio = await emp2('PUT', `/api/roles/${rol.id}`, {
    permisos: { facturacion: 'editar', caja: 'editar' },
  });
  chk('editar los permisos del cargo propio se rechaza', 403, cargoPropio.status);
  chk('renombrar el propio sigue permitido', 200,
    (await emp2('PUT', `/api/roles/${rol.id}`, { nombre: rol.nombre })).status);
  await api('DELETE', `/api/employees/${alta2.json.id}`);

  tit('2.c EL LOCAL DE UN MOVIMIENTO TAMBIÉN ES DEL NEGOCIO');
  /*
   * El `locationId` llegaba del cuerpo y se usaba tal cual. No dejaba leer nada
   * ajeno, pero escribía filas de stock contra el local de otro negocio: la
   * contabilidad por local de los dos quedaba sucia, y se podía esconder
   * mercadería en un lugar que la propia pantalla no muestra.
   */
  const localAjeno = await BusinessLocation.findOne({
    where: { businessId: { [Op.ne]: negocio.id } }, attributes: ['id'],
  });
  if (localAjeno) {
    const conAjeno = await api('PATCH', `/api/products/variants/${variante.id}/stock`, {
      tipo: 'ingreso', cantidad: 1, locationId: localAjeno.id, motivo: 'QA aislamiento',
    });
    chk('ajustar stock en el local de otro negocio se rechaza', 400, conAjeno.status);
    chk('y no queda fila de stock en ese local', null,
      await VariantStock.findOne({ where: { productVariantId: variante.id, locationId: localAjeno.id } }));
  } else {
    console.log('  \x1b[33m—\x1b[0m no hay locales de otro negocio para probarlo');
  }
  const localPropio = await api('PATCH', `/api/products/variants/${variante.id}/stock`, {
    tipo: 'ingreso', cantidad: 1, locationId: local.id, motivo: 'QA aislamiento',
  });
  chk('el local propio sigue funcionando', 200, localPropio.status);
  await api('PATCH', `/api/products/variants/${variante.id}/stock`, {
    tipo: 'egreso', cantidad: 1, locationId: local.id, motivo: 'QA aislamiento deshacer',
  });

  tit('3. SIN PAGAR SE LEE, NO SE ESCRIBE');
  const sub = await Subscription.findOne({ where: { businessId: negocio.id } });
  const comoEstaba = { estado: sub.estado, trialFin: sub.trialFin };
  try {
    await sub.update({ estado: 'trial', trialFin: new Date(Date.now() - 86400000) });

    const escribir = await cotizar({});
    chk('escribir se bloquea con 402', 402, escribir.status);
    chk('y dice que es por la suscripción', 'suscripcion', escribir.json?.motivo);
    chk('leer los propios datos sigue andando', 200, (await api('GET', '/api/sales?limit=1')).status);

    /* Lo que no se puede bloquear nunca: la pantalla que le permite volver a
       operar. Encerrar al cliente afuera de ahí es peor que no cobrarle. */
    chk('la suscripción sigue accesible', 200, (await api('GET', '/api/billing/suscripcion')).status);
    chk('y los datos para pagar también', 200, (await api('GET', '/api/billing/transferencia')).status);
  } finally {
    await sub.update(comoEstaba);
  }
  chk('con la cuenta al día vuelve a escribir', 201, (await cotizar({})).status);

  tit('Limpieza');
  for (const id of creados) {
    await SaleItem.destroy({ where: { saleId: id } });
    const v = await Sale.findByPk(id);
    if (v) await v.destroy();
  }
  await Employee.destroy({ where: { email: { [Op.like]: '%.qa@test.local' } } });
  await Role.destroy({ where: { nombre: { [Op.like]: 'QA sin permisos%' } } });
  chk('no quedan documentos de prueba', 0, (await Sale.findAll({ where: { id: creados } })).length);

  console.log(`\n\x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
