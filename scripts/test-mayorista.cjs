/*
 * Cuándo una venta va a precio mayorista, y de qué local sale.
 *
 * Hasta ahora la regla era `>= 3 prendas`, escrita a mano en el controlador y
 * otra vez en cada una de las dos pantallas que arman una venta. Tres copias
 * del mismo número sin saber una de otra: el día que alguien cambiara una, la
 * pantalla mostraría un precio y el servidor cobraría otro. En una caja eso es
 * lo peor que puede pasar, porque el cliente ya pagó.
 *
 * Ahora la regla vive en el local. Cada uno puede tener la suya: la sucursal
 * del centro pide tres prendas, el puesto de feria vende siempre al por mayor.
 *
 * El umbral por monto se mide con PRECIOS MINORISTAS. El precio depende del
 * total y el total del precio, así que hay que cortar el círculo por algún
 * lado; midiendo en lista, el número contra el que se compara es el mismo que
 * el cajero ve mientras carga.
 *
 * Uso:  API=http://localhost:3000 node scripts/test-mayorista.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const { Op } = require('sequelize');
const API = process.env.API || 'http://localhost:3000';
const {
  Business, BusinessLocation, Product, ProductVariant, Sale, SaleItem, SalePayment, Employee, Role,
} = require('../src/models');
const regla = require('../src/services/reglaMayoristaService');

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
  const local = await BusinessLocation.findOne({
    where: { businessId: negocio.id, tipo: 'local', activo: true },
  });
  // Una variante cuyo mayorista sea DISTINTO del minorista: si son iguales,
  // esta prueba pasaría sin comprobar nada.
  const variante = await ProductVariant.findOne({
    where: { businessId: negocio.id, activo: true },
    include: [{
      model: Product, as: 'producto', required: true,
      where: { precioMayorista: { [Op.gt]: 0 }, precioMinorista: { [Op.gt]: 0 } },
    }],
  });
  const pMin = Number(variante.producto.precioMinorista);
  const pMay = Number(variante.producto.precioMayorista);
  if (pMin === pMay) { console.log('Hace falta un producto con mayorista distinto del minorista.'); process.exit(1); }

  const api = sesion();
  const login = await api('POST', '/api/auth/login', { email: negocio.email, password: 'Demo2026!!' });
  if (login.status !== 200) { console.log('No se pudo entrar:', login.status); process.exit(1); }

  const original = {
    mayoristaModo: local.mayoristaModo, mayoristaCantidad: local.mayoristaCantidad,
    mayoristaMonto: local.mayoristaMonto,
  };
  const creadas = [];

  /* Se cotiza en vez de vender: el precio se calcula igual y no mueve stock ni
     dispara avisos al dueño. */
  const cotizar = async (cantidad, extra = {}) => {
    const r = await api('POST', '/api/sales', {
      tipo: 'cotizacion', estado: 'pendiente', locationId: local.id,
      items: [{ productVariantId: variante.id, cantidad }], ...extra,
    });
    if (r.json?.id) creadas.push(r.json.id);
    return r;
  };
  const ponerRegla = (r) => api('PUT', `/api/locations/${local.id}`, r);
  const precioDe = (r) => Number(r.json?.items?.[0]?.precioUnitario);

  try {
    tit('1. LA REGLA DE SIEMPRE, AHORA CONFIGURABLE');
    await ponerRegla({ mayoristaModo: 'cantidad', mayoristaCantidad: 3, mayoristaMonto: null });
    chk('2 prendas van a minorista', pMin, precioDe(await cotizar(2)));
    chk('3 prendas van a mayorista', pMay, precioDe(await cotizar(3)));
    chk('y la venta queda marcada como mayorista', true, (await cotizar(3)).json?.esMayorista);

    tit('2. CADA LOCAL CON SU PROPIO NÚMERO');
    await ponerRegla({ mayoristaModo: 'cantidad', mayoristaCantidad: 5 });
    chk('con umbral 5, cuatro prendas siguen a minorista', pMin, precioDe(await cotizar(4)));
    chk('cinco pasan a mayorista', pMay, precioDe(await cotizar(5)));

    tit('3. UMBRAL POR MONTO, MEDIDO EN LISTA');
    /*
     * El umbral se pone entre el precio de dos prendas y el de tres, así que
     * dos no llegan y tres sí — medido a precio minorista, que es el punto.
     */
    const umbral = pMin * 2.5;
    await ponerRegla({ mayoristaModo: 'monto', mayoristaMonto: umbral });
    chk('dos prendas no llegan al monto', pMin, precioDe(await cotizar(2)));
    chk('tres lo superan y pasan a mayorista', pMay, precioDe(await cotizar(3)));

    tit('4. LOS DOS CRITERIOS: LO QUE PASE PRIMERO');
    // Cantidad alta y monto bajo: tiene que ganar el monto.
    await ponerRegla({ mayoristaModo: 'ambos', mayoristaCantidad: 50, mayoristaMonto: pMin * 1.5 });
    chk('llega por monto aunque falten prendas', pMay, precioDe(await cotizar(2)));
    // Y al revés: monto altísimo, cantidad baja.
    await ponerRegla({ mayoristaModo: 'ambos', mayoristaCantidad: 2, mayoristaMonto: pMin * 1000 });
    chk('llega por cantidad aunque falte monto', pMay, precioDe(await cotizar(2)));

    tit('5. LOCALES QUE NO CUENTAN NADA');
    await ponerRegla({ mayoristaModo: 'siempre' });
    chk('siempre mayorista: una sola prenda ya va por mayor', pMay, precioDe(await cotizar(1)));
    await ponerRegla({ mayoristaModo: 'nunca' });
    chk('siempre minorista: cincuenta prendas siguen a detalle', pMin, precioDe(await cotizar(50)));

    tit('6. LO QUE LA REGLA NO DEJA CONFIGURAR');
    chk('un modo inventado se rechaza', 400, (await ponerRegla({ mayoristaModo: 'a-ojo' })).status);
    chk('cantidad cero se rechaza', 400,
      (await ponerRegla({ mayoristaModo: 'cantidad', mayoristaCantidad: 0 })).status);
    /*
     * Un modo por monto sin monto dejaría al local con una regla que nunca se
     * cumple: todo saldría a minorista y nadie entendería por qué.
     */
    const sinMonto = await ponerRegla({ mayoristaModo: 'monto', mayoristaMonto: null });
    chk('modo por monto sin monto se rechaza', 400, sinMonto.status);
    chk('y dice qué falta', true, /importe|monto/i.test(sinMonto.json?.message || ''));

    tit('7. LA MISMA REGLA LA EVALÚA UNA SOLA FUNCIÓN');
    // Es lo que impide que la pantalla y el servidor se separen.
    chk('cantidad',  [false, true],  [regla.esMayorista({ mayoristaModo: 'cantidad', mayoristaCantidad: 3 }, 2, 0),
                                      regla.esMayorista({ mayoristaModo: 'cantidad', mayoristaCantidad: 3 }, 3, 0)]);
    chk('monto',     [false, true],  [regla.esMayorista({ mayoristaModo: 'monto', mayoristaMonto: 100 }, 99, 99),
                                      regla.esMayorista({ mayoristaModo: 'monto', mayoristaMonto: 100 }, 1, 100)]);
    chk('siempre y nunca', [true, false], [regla.esMayorista({ mayoristaModo: 'siempre' }, 0, 0),
                                           regla.esMayorista({ mayoristaModo: 'nunca' }, 999, 999999)]);
    chk('sin regla cargada, las 3 de siempre', [false, true],
      [regla.esMayorista(null, 2, 0), regla.esMayorista(null, 3, 0)]);

    tit('8. TODA VENTA Y TODA COTIZACIÓN TIENEN LOCAL');
    await ponerRegla(original);
    const sinLocal = await api('POST', '/api/sales', {
      tipo: 'cotizacion', estado: 'pendiente',
      items: [{ productVariantId: variante.id, cantidad: 1 }],
    });
    if (sinLocal.json?.id) creadas.push(sinLocal.json.id);
    chk('una cotización sin local se rechaza', 400, sinLocal.status);
    chk('y pide elegirlo', true, /local/i.test(sinLocal.json?.message || ''));

    tit('9. EL DUEÑO PUEDE DECIR QUIÉN VENDIÓ');
    const rol = await Role.findOne({ where: { businessId: negocio.id } });
    const alta = await api('POST', '/api/employees', {
      nombre: 'Mayorista', apellido: 'QA', dni: '39888111',
      email: 'mayorista.qa@test.local', password: 'MayoQa2026!', roleId: rol?.id,
    });
    const conVendedor = await cotizar(1, { employeeId: alta.json.id });
    chk('la venta queda atribuida a ese vendedor', alta.json.id, conVendedor.json?.employeeId);

    const ajeno = await Employee.findOne({ where: { businessId: { [Op.ne]: negocio.id } }, attributes: ['id'] });
    if (ajeno) {
      const conAjeno = await cotizar(1, { employeeId: ajeno.id });
      chk('un vendedor de otro negocio se rechaza', 400, conAjeno.status);
    }
    await api('DELETE', `/api/employees/${alta.json.id}`);

    tit('10. LA REGLA DEL LOCAL VALE IGUAL PARA UN EMPLEADO');
    /*
     * El bug: la regla se aplicaba entrando como dueño y no entrando como
     * empleado. En la pantalla figuraba configurada —porque sin regla se
     * describe la de fábrica, "desde 3 prendas"— así que parecía andar. Con el
     * local en "siempre mayorista", el empleado cobraba todo a minorista.
     *
     * La causa estaba en la pantalla: la lista de locales sólo se pedía si el
     * usuario podía elegir local, o sea el dueño. Para el empleado nunca había
     * coincidencia y la regla quedaba en null.
     *
     * Se prueban las dos mitades: que el servidor cobre bien con una sesión de
     * empleado, y que la sesión le mande el local con la regla adentro, que es
     * de donde la pantalla la saca ahora.
     */
    const rolAdmin = await Role.findOne({ where: { businessId: negocio.id, nombre: 'Administrador' } })
      || await Role.findOne({ where: { businessId: negocio.id } });
    const bcrypt = require('bcryptjs');
    await Employee.destroy({ where: { email: 'mayo.empleado@test.local' } });
    const empleado = await Employee.create({
      businessId: negocio.id, roleId: rolAdmin.id, locationId: local.id, dni: '39888112',
      nombre: 'Mayo', apellido: 'Empleado', email: 'mayo.empleado@test.local',
      passwordHash: await bcrypt.hash('MayoEmp2026!', 10), activo: true,
    });

    const emp = sesion();
    const entro = await emp('POST', '/api/auth/employee-login',
      { email: 'mayo.empleado@test.local', password: 'MayoEmp2026!' });
    chk('el empleado entra', 200, entro.status);

    await ponerRegla({ mayoristaModo: 'siempre' });
    const cotizarEmp = async (cantidad) => {
      const r = await emp('POST', '/api/sales', {
        tipo: 'cotizacion', estado: 'pendiente',
        items: [{ productVariantId: variante.id, cantidad }],
      });
      if (r.json?.id) creadas.push(r.json.id);
      return r;
    };
    const unaDelEmpleado = await cotizarEmp(1);
    chk('con "siempre mayorista", una prenda del empleado va por mayor',
      pMay, Number(unaDelEmpleado.json?.items?.[0]?.precioUnitario));
    chk('y la cotización queda marcada como mayorista', true, unaDelEmpleado.json?.esMayorista);

    await ponerRegla({ mayoristaModo: 'nunca' });
    chk('con "siempre minorista", cincuenta prendas del empleado van a detalle',
      pMin, Number((await cotizarEmp(50)).json?.items?.[0]?.precioUnitario));

    // La otra mitad: la sesión del empleado trae su local CON la regla.
    await ponerRegla({ mayoristaModo: 'cantidad', mayoristaCantidad: 7 });
    const yo = await emp('GET', '/api/auth/me');
    chk('la sesión del empleado trae su local', local.id, yo.json?.data?.local?.id);
    chk('y la regla adentro, que es la que usa la pantalla',
      ['cantidad', 7], [yo.json?.data?.local?.mayoristaModo, yo.json?.data?.local?.mayoristaCantidad]);

    tit('11. EL PRECIO NO SE MANDA DESDE AFUERA');
    /*
     * `item.precioUnitario ?? calcPrecio(...)`: si el cliente mandaba precio,
     * se cobraba ese. Ninguna pantalla lo manda, así que la rama existía sólo
     * para quien armara el pedido a mano. Con un token válido y un cero, la
     * mercadería salía con la venta registrada y la caja cuadrada.
     */
    const conPrecio = await api('POST', '/api/sales', {
      tipo: 'cotizacion', estado: 'pendiente', locationId: local.id,
      items: [{ productVariantId: variante.id, cantidad: 1, precioUnitario: 0 }],
    });
    if (conPrecio.json?.id) creadas.push(conPrecio.json.id);
    chk('mandar el precio en la línea se rechaza', 400, conPrecio.status);
    chk('y explica dónde va el descuento', true, /descuento/i.test(conPrecio.json?.message || ''));

    tit('12. SIN PRECIO MAYORISTA NO SE REGALA LA MERCADERÍA');
    /*
     * `precioMayorista` terminaba en `|| 0`. Un producto al que nadie le cargó
     * mayorista se vendía GRATIS en cuanto la venta cruzaba el umbral: con la
     * regla de fábrica alcanzaba con tres prendas.
     */
    const prodSinMay = await Product.create({
      businessId: negocio.id, sku: 'QA-SINMAY', skuAgrupador: 'QA-SINMAY',
      // Cero y no null: la columna del producto no acepta null, así que "sin
      // precio mayorista" se escribe exactamente así en la base.
      titulo: 'QA sin mayorista', precioMinorista: 4500, precioMayorista: 0,
      costo: 1000, activo: true,
    });
    const varSinMay = await ProductVariant.create({
      productId: prodSinMay.id, businessId: negocio.id, sku: 'QA-SINMAY-1',
      variante1Nombre: 'Color', variante1Valor: 'Único', stock: 0, stockMinimo: 0,
    });
    await ponerRegla({ mayoristaModo: 'siempre' });
    const regalada = await api('POST', '/api/sales', {
      tipo: 'cotizacion', estado: 'pendiente', locationId: local.id,
      items: [{ productVariantId: varSinMay.id, cantidad: 3 }],
    });
    if (regalada.json?.id) creadas.push(regalada.json.id);
    chk('se cobra el precio de lista, no cero', 4500, Number(regalada.json?.items?.[0]?.precioUnitario));
    chk('y el total tampoco es cero', 13500, Number(regalada.json?.total));
    const precios = require('../src/services/precioService');
    chk('la función lo dice sola', [4500, 4500, 0],
      [precios.precioMayorista({}, { precioMinorista: 4500, precioMayorista: 0 }),
       precios.precioMayorista({}, { precioMinorista: 4500 }),
       // Un cero propio de la variante sigue siendo una decisión y se respeta.
       precios.precioMayorista({ precioMayorista: 0 }, { precioMinorista: 4500 })]);

    // El empleado y el producto de prueba se borran en la limpieza y no acá:
    // las cotizaciones que acaban de generarse los apuntan a los dos, y la base
    // rebota por clave foránea si se van antes que las ventas.
  } finally {
    tit('Limpieza');
    await BusinessLocation.update(original, { where: { id: local.id } });
    for (const id of creadas) {
      await SalePayment.destroy({ where: { saleId: id } }).catch(() => {});
      await SaleItem.destroy({ where: { saleId: id } });
      const v = await Sale.findByPk(id); if (v) await v.destroy();
    }
    await Employee.destroy({ where: { email: ['mayorista.qa@test.local', 'mayo.empleado@test.local'] } });
    await ProductVariant.destroy({ where: { sku: 'QA-SINMAY-1' } });
    await Product.destroy({ where: { sku: 'QA-SINMAY' } });
    const vuelto = await BusinessLocation.findByPk(local.id);
    chk('la regla del local quedó como estaba', original.mayoristaModo, vuelto.mayoristaModo);
    chk('no quedan cotizaciones de prueba', 0, (await Sale.findAll({ where: { id: creadas } })).length);
  }

  console.log(`\n\x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
