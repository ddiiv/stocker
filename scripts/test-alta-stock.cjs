/*
 * Vender con stock sin declarar: el alta confirmada.
 *
 * En un local la prenda está en la percha aunque el remito no se haya cargado.
 * Antes eso se resolvía de dos maneras malas: o la venta pasaba igual y dejaba
 * el stock en negativo —el inventario se volvía ficción— o se convertía sola en
 * cotización y el cliente se iba sin comprobante.
 *
 * Ahora se pregunta. Si la persona confirma, se da de alta la diferencia y
 * RECIÉN DESPUÉS la venta la descuenta. Ese orden es lo que se prueba acá, y no
 * es un detalle estético: es lo que hace que el libro de movimientos cuente lo
 * que realmente pasó.
 *
 * Lo que más importa de este archivo:
 *
 *   · Sin confirmar no se toca NADA. Ni el stock, ni la numeración.
 *   · Las cantidades las calcula el servidor. Lo que mande el navegador se
 *     ignora: si no, cualquiera con la sesión abierta se inventa inventario.
 *   · La política del negocio manda. Si el dueño puso "no vender sin stock",
 *     confirmar no lo pisa.
 *
 * Uso:  API=http://localhost:3000 node scripts/test-alta-stock.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const bcrypt = require('bcryptjs');
const API = process.env.API || 'http://localhost:3000';
const {
  Business, BusinessLocation, Product, ProductVariant, VariantStock,
  PaymentMethod, Employee, Role, Sale, SaleItem, StockMovement,
} = require('../src/models');
const stock = require('../src/services/stockService');

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
  const politicaOriginal = negocio.ventaSinStock;
  const locales = await BusinessLocation.findAll({
    where: { businessId: negocio.id, tipo: 'local', activo: true }, order: [['id', 'ASC']],
  });
  const [A, B] = locales;
  const metodo = await PaymentMethod.findOne({ where: { businessId: negocio.id } });
  const rol = await Role.findOne({ where: { businessId: negocio.id, nombre: 'Vendedor' } })
    || await Role.findOne({ where: { businessId: negocio.id } });

  // Producto normal y producto de evento: el segundo no lleva stock nunca.
  const prod = await Product.create({
    businessId: negocio.id, sku: 'QA-ALT', skuAgrupador: 'QA-ALT', titulo: 'QA Alta de stock',
    precioMinorista: 100, precioMayorista: 80, costo: 40, activo: true,
  });
  const v1 = await ProductVariant.create({
    productId: prod.id, businessId: negocio.id, sku: 'QA-ALT-1',
    variante1Nombre: 'Color', variante1Valor: 'Rojo', stock: 0, stockMinimo: 0,
  });
  const v2 = await ProductVariant.create({
    productId: prod.id, businessId: negocio.id, sku: 'QA-ALT-2',
    variante1Nombre: 'Color', variante1Valor: 'Azul', stock: 0, stockMinimo: 0,
  });
  const prodEvento = await Product.create({
    businessId: negocio.id, sku: 'QA-ALT-EV', skuAgrupador: 'QA-ALT-EV', titulo: 'QA Evento',
    precioMinorista: 200, precioMayorista: 150, costo: 0, activo: true, esFeria: true,
  });
  const vEvento = await ProductVariant.create({
    productId: prodEvento.id, businessId: negocio.id, sku: 'EVEQA-ALT-EV', stock: 0, stockMinimo: 0,
  });

  const pass = await bcrypt.hash('QaAlta2026!', 10);
  const empleado = await Employee.create({
    businessId: negocio.id, roleId: rol.id, locationId: A.id, dni: '99880001',
    nombre: 'QA', apellido: 'Alta', email: 'qa.alta@stocker.test', passwordHash: pass, activo: true,
  });

  const api = sesion();
  const login = await api('POST', '/api/auth/login', { email: negocio.email, password: 'Demo2026!!' });
  if (login.status !== 200) { console.log('No se pudo entrar:', login.status); process.exit(1); }

  const creadas = [];
  const enA = (v = v1) => stock.stockEn(v.id, A.id);
  const enB = (v = v1) => stock.stockEn(v.id, B.id);

  const vender = async (extra = {}, lineas = null) => {
    const items = lineas || [{ productVariantId: v1.id, cantidad: 5, precioUnitario: 100 }];
    const total = items.reduce((s, i) => s + i.precioUnitario * i.cantidad, 0);
    const r = await api('POST', '/api/sales', {
      tipo: 'venta', estado: 'pagado', locationId: A.id, employeeId: empleado.id,
      items, pagos: [{ paymentMethodId: metodo.id, monto: total }],
      ...extra,
    });
    if (r.json?.id) creadas.push(r.json.id);
    return r;
  };

  const fijar = async (v, local, cantidad) => {
    await stock.mover({
      variantId: v.id, businessId: negocio.id, locationId: local.id,
      fijar: cantidad, tipo: 'ajuste', motivo: 'QA alta de stock',
    });
  };

  try {
    // ─────────────────────────────────────────────────────────────
    tit('Cuando alcanza, no pasa nada raro');
    await fijar(v1, A, 10);
    const holgada = await vender();
    chk('la venta entra', 201, holgada.status);
    chk('sin aviso de alta', undefined, holgada.json?.altaStock);
    chk('descuenta lo justo', 5, await enA());

    // ─────────────────────────────────────────────────────────────
    tit('Sin confirmar no se toca nada');
    await fijar(v1, A, 2);
    const movsAntes = await StockMovement.count({ where: { productVariantId: v1.id } });
    const ventasAntes = await Sale.count({ where: { businessId: negocio.id, tipo: 'venta' } });

    const sinConfirmar = await vender();
    chk('la venta se frena', 409, sinConfirmar.status);
    chk('con el código que la pantalla espera', 'SIN_STOCK', sinConfirmar.json?.codigo);
    chk('y ofreciendo confirmar', true, sinConfirmar.json?.puedeConfirmar);
    chk('dice en qué local falta', A.nombre, sinConfirmar.json?.local);

    const f = (sinConfirmar.json?.faltantes || [])[0];
    chk('nombra el artículo', 'QA-ALT-1', f?.sku);
    chk('con nombre legible', 'QA Alta de stock · Rojo', f?.nombre);
    chk('dice cuánto hay', 2, f?.hay);
    chk('cuánto se vende', 5, f?.pide);
    chk('y cuánto falta', 3, f?.falta);

    chk('el stock quedó intacto', 2, await enA());
    chk('no se registró ningún movimiento', movsAntes,
      await StockMovement.count({ where: { productVariantId: v1.id } }));
    /*
     * Que no quede la venta a medias es lo importante.
     *
     * El rechazo ocurre DESPUÉS de crear la fila, dentro de la misma
     * transacción. Si el rollback no llegara, quedaría una venta fantasma con
     * número emitido y sin stock descontado.
     */
    chk('ni una venta a medio hacer', ventasAntes,
      await Sale.count({ where: { businessId: negocio.id, tipo: 'venta' } }));

    // ─────────────────────────────────────────────────────────────
    tit('Confirmando: primero entra, después sale');
    const confirmada = await vender({ confirmarAltaStock: true });
    chk('la venta entra', 201, confirmada.status);
    chk('avisa lo que dio de alta', 'STOCK_DADO_DE_ALTA', confirmada.json?.altaStock?.codigo);
    chk('con las unidades exactas', 3, confirmada.json?.altaStock?.altas?.[0]?.unidades);
    chk('y el stock termina en cero', 0, await enA());

    const movs = await StockMovement.findAll({
      where: { productVariantId: v1.id }, order: [['id', 'ASC']],
    });
    const ultimos = movs.slice(-2);
    chk('el anteúltimo movimiento es el alta', 'ingreso', ultimos[0]?.tipo);
    chk('por la diferencia', 3, ultimos[0]?.cantidad);
    chk('que deja el stock en 5', 5, ultimos[0]?.stockNuevo);
    chk('el último es el egreso de la venta', 'egreso', ultimos[1]?.tipo);
    chk('por lo vendido', 5, ultimos[1]?.cantidad);
    chk('y lo deja en 0', 0, ultimos[1]?.stockNuevo);
    chk('el alta dice de dónde salió', true,
      /Alta confirmada al vender V-/.test(ultimos[0]?.motivo || ''));
    chk('y queda a nombre de quien vendió', empleado.id, ultimos[0]?.employeeId);

    /*
     * Nunca en negativo.
     *
     * Es el punto de todo el cambio: antes esta misma venta dejaba −3 y la
     * prenda aparecía en "Stock a regularizar". Ahora o se declara, o no se
     * vende.
     */
    chk('en ningún momento pasó por negativo', 0,
      movs.filter((m) => Number(m.stockNuevo) < 0).length);

    // ─────────────────────────────────────────────────────────────
    tit('Las cantidades las decide el servidor');
    /*
     * El navegador manda un sí, no un número. Acá se le manda además una lista
     * de faltantes inventada con cantidades enormes: si el servidor la leyera,
     * daría de alta 999 unidades.
     */
    await fijar(v1, A, 1);
    const inflado = await vender({
      confirmarAltaStock: true,
      faltantes: [{ productVariantId: v1.id, sku: 'QA-ALT-1', falta: 999 }],
      altas: [{ productVariantId: v1.id, unidades: 999 }],
    });
    chk('la venta entra igual', 201, inflado.status);
    chk('pero da de alta sólo lo que faltaba', 4, inflado.json?.altaStock?.altas?.[0]?.unidades);
    chk('y el stock termina en cero, no en 995', 0, await enA());

    // ─────────────────────────────────────────────────────────────
    tit('Varias líneas: sólo se da de alta la que falta');
    await fijar(v1, A, 10);
    await fijar(v2, A, 1);
    const mixta = await vender({ confirmarAltaStock: true }, [
      { productVariantId: v1.id, cantidad: 2, precioUnitario: 100 },
      { productVariantId: v2.id, cantidad: 4, precioUnitario: 100 },
    ]);
    chk('la venta entra', 201, mixta.status);
    chk('una sola alta', 1, mixta.json?.altaStock?.altas?.length);
    chk('la del artículo que faltaba', 'QA-ALT-2', mixta.json?.altaStock?.altas?.[0]?.sku);
    chk('por 3 unidades', 3, mixta.json?.altaStock?.altas?.[0]?.unidades);
    chk('el que alcanzaba se descuenta normal', 8, await enA(v1));
    chk('y el otro queda en cero', 0, await enA(v2));

    // ─────────────────────────────────────────────────────────────
    tit('El stock de otro local no cuenta, pero se avisa');
    await fijar(v1, A, 0);
    await fijar(v1, B, 7);
    const enOtro = await vender();
    chk('se frena igual', 409, enOtro.status);
    chk('porque acá no hay', 0, enOtro.json?.faltantes?.[0]?.hay);
    chk('pero avisa que hay en otro lado', 7, enOtro.json?.faltantes?.[0]?.enOtrosLocales);
    chk('sin tocar el stock del otro local', 7, await enB());

    // ─────────────────────────────────────────────────────────────
    tit('Los productos de evento nunca entran en la cuenta');
    /*
     * Un producto de evento se vende sin llevar stock. Si apareciera como
     * faltante, cada venta del evento dispararía el modal y confirmar
     * intentaría darle stock a algo que por definición no lo tiene.
     */
    const localEvento = await BusinessLocation.create({
      businessId: negocio.id, nombre: 'QA Evento', direccion: 'QA', tipo: 'feria', activo: true,
    });
    const ventaEvento = await api('POST', '/api/sales', {
      tipo: 'venta', estado: 'pagado', locationId: localEvento.id, employeeId: empleado.id,
      items: [{ productVariantId: vEvento.id, cantidad: 9, precioUnitario: 200 }],
      pagos: [{ paymentMethodId: metodo.id, monto: 1800 }],
    });
    if (ventaEvento.json?.id) creadas.push(ventaEvento.json.id);
    chk('la venta de evento entra sin preguntar nada', 201, ventaEvento.status);
    chk('sin aviso de alta', undefined, ventaEvento.json?.altaStock);
    chk('y sin inventarle stock', 0, await stock.stockEn(vEvento.id, localEvento.id));

    // ─────────────────────────────────────────────────────────────
    tit('Anular devuelve lo vendido, no lo que había antes');
    /*
     * La prenda que el cliente trae de vuelta existe: el alta de entonces ya
     * quedó registrada aparte. Restarla al anular sería cobrarle dos veces el
     * mismo faltante al inventario.
     */
    await fijar(v1, A, 1);
    const paraAnular = await vender({ confirmarAltaStock: true },
      [{ productVariantId: v1.id, cantidad: 3, precioUnitario: 100 }]);
    chk('la venta entra', 201, paraAnular.status);
    chk('queda en cero', 0, await enA());
    const anulacion = await api('POST',
      `/api/sales/${encodeURIComponent(paraAnular.json.numero)}/anular`, { motivo: 'QA' });
    chk('se anula', 200, anulacion.status);
    chk('y vuelven las 3 que se habían vendido', 3, await enA());

    // ─────────────────────────────────────────────────────────────
    tit('Si el negocio dice que no, confirmar no lo pisa');
    await negocio.update({ ventaSinStock: 'bloquear' });
    await fijar(v1, A, 1);

    const bloqueada = await vender();
    chk('se frena', 409, bloqueada.status);
    chk('con el mismo código', 'SIN_STOCK', bloqueada.json?.codigo);
    chk('pero SIN ofrecer confirmar', false, bloqueada.json?.puedeConfirmar);
    chk('y explicando por qué', true,
      /configurado para no vender sin stock/i.test(bloqueada.json?.message || ''));

    const forzada = await vender({ confirmarAltaStock: true });
    chk('mandar la confirmación igual no alcanza', 409, forzada.status);
    chk('sigue sin ofrecerla', false, forzada.json?.puedeConfirmar);
    chk('y el stock no se movió', 1, await enA());
    await negocio.update({ ventaSinStock: politicaOriginal });

    // ─────────────────────────────────────────────────────────────
    tit('Dos cajas peleando la última unidad');
    /*
     * Sin confirmar, una sola puede ganar: la otra se topa con que ya no queda.
     * Es el mismo lock de siempre, pero ahora el perdedor recibe la pregunta en
     * vez de un error seco.
     */
    await fijar(v1, A, 1);
    const [c1, c2] = await Promise.all([
      vender({}, [{ productVariantId: v1.id, cantidad: 1, precioUnitario: 100 }]),
      vender({}, [{ productVariantId: v1.id, cantidad: 1, precioUnitario: 100 }]),
    ]);
    const estados = [c1.status, c2.status].sort();
    chk('una entra y la otra pregunta', [201, 409], estados);
    chk('y el stock queda en cero, no en negativo', 0, await enA());

    // ─────────────────────────────────────────────────────────────
    tit('Cotizaciones: presupuesto y nada más');
    const cot = await api('POST', '/api/sales', {
      tipo: 'cotizacion', estado: 'pendiente', locationId: A.id, employeeId: empleado.id,
      items: [{ productVariantId: v1.id, cantidad: 50, precioUnitario: 100 }],
    });
    if (cot.json?.id) creadas.push(cot.json.id);
    chk('se puede cotizar sin stock, sin preguntar nada', 201, cot.status);
    chk('no aparta número de venta', null, cot.json?.numeroVenta ?? null);
    chk('y no toca el stock', 0, await enA());

    const conv = await api('POST',
      `/api/sales/cotizacion/${encodeURIComponent(cot.json.numero)}/convertir`, { locationId: A.id });
    chk('convertirla ya no se puede', 410, conv.status);
    chk('con un motivo que se entiende', 'CONVERSION_DISCONTINUADA', conv.json?.codigo);

    // ─────────────────────────────────────────────────────────────
    tit('Emitir presupuestos es un permiso aparte');
    /*
     * El módulo `cotizaciones` gateaba la conversión, que ya no existe. Si no
     * pasara a gatear la emisión, sería un permiso que el dueño puede tildar y
     * destildar sin que cambie nada.
     */
    const permisosOriginales = rol.permisos;
    const sinCotizar = sesion();
    const loginEmp = await sinCotizar('POST', '/api/auth/employee-login',
      { email: 'qa.alta@stocker.test', password: 'QaAlta2026!' });
    chk('la empleada entra', 200, loginEmp.status);

    await rol.update({ permisos: { ...(permisosOriginales || {}), ventas: 'editar', cotizaciones: 'ninguno' } });
    const negada = await sinCotizar('POST', '/api/sales', {
      tipo: 'cotizacion', estado: 'pendiente', locationId: A.id,
      items: [{ productVariantId: v1.id, cantidad: 1, precioUnitario: 100 }],
    });
    if (negada.json?.id) creadas.push(negada.json.id);
    chk('sin el permiso no puede cotizar', 403, negada.status);
    await rol.update({ permisos: permisosOriginales });

    tit('Limpieza');
    // El local de evento se borra en el `finally`, no acá: todavía hay una
    // venta apuntándolo y la clave foránea lo frena.
  } finally {
    await negocio.update({ ventaSinStock: politicaOriginal });
    for (const id of creadas) {
      await SaleItem.destroy({ where: { saleId: id } });
      const v = await Sale.findByPk(id);
      if (v) await v.destroy();
    }
    for (const v of [v1, v2, vEvento]) {
      await StockMovement.destroy({ where: { productVariantId: v.id } });
      await VariantStock.destroy({ where: { productVariantId: v.id } });
      await ProductVariant.destroy({ where: { id: v.id } });
    }
    await Product.destroy({ where: { id: [prod.id, prodEvento.id] } });
    await Employee.destroy({ where: { id: empleado.id } });
    await BusinessLocation.destroy({ where: { businessId: negocio.id, nombre: 'QA Evento' } });

    chk('no quedan documentos de prueba', 0, (await Sale.findAll({ where: { id: creadas } })).length);
    chk('la política del negocio quedó como estaba', politicaOriginal,
      (await Business.findByPk(negocio.id)).ventaSinStock);
  }

  console.log(`\n\x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
