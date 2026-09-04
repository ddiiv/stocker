/*
 * Precio propio por variante.
 *
 * Es plata: si un lugar del sistema queda leyendo el precio del producto en vez
 * del de la variante, el negocio cobra de menos y no se entera hasta cerrar la
 * caja. Por eso se prueba la regla y además la venta de punta a punta.
 *
 * Uso:  API=http://localhost:3000 node scripts/test-precios.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const API = process.env.API || 'http://localhost:3000';
const {
  Business, BusinessLocation, Product, ProductVariant, VariantStock,
  Sale, SaleItem, SalePayment, StockMovement, PaymentMethod,
} = require('../src/models');
const precios = require('../src/services/precioService');
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
    const texto = await r.text();
    let json = null; try { json = JSON.parse(texto); } catch { /* no json */ }
    return { status: r.status, json };
  };
}

(async () => {
  const padre = { precioMinorista: 10000, precioMayorista: 8000, costo: 4000 };

  tit('1. LA REGLA: propio si lo tiene, del padre si no');
  chk('sin precio propio, hereda',        10000, precios.precioMinorista({ precioMinorista: null }, padre));
  chk('con precio propio, manda el suyo', 13000, precios.precioMinorista({ precioMinorista: 13000 }, padre));
  chk('mayorista, igual criterio',         8000, precios.precioMayorista({ precioMayorista: null }, padre));
  chk('costo, igual criterio',             4500, precios.costo({ costo: 4500 }, padre));

  /*
   * Cero es un precio, no un campo vacío: una variante de muestra o de regalo
   * puede valer 0 y eso es una decisión. Tratarlo como "sin precio" haría que
   * cobrara el del padre, o sea que se cobrara algo que se decidió regalar.
   */
  chk('cero es un precio propio, no "vacío"', 0, precios.precioMinorista({ precioMinorista: 0 }, padre));
  chk('cadena vacía sí es "vacío"',       10000, precios.precioMinorista({ precioMinorista: '' }, padre));

  tit('2. PRECIO DE VENTA SEGÚN MODALIDAD');
  const v = { precioMinorista: 13000, precioMayorista: null, producto: padre };
  chk('minorista usa el propio',  13000, precios.precioDeVenta(v, false));
  chk('mayorista cae al del padre', 8000, precios.precioDeVenta(v, true));

  // ── De punta a punta ──
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  const local = (await BusinessLocation.findAll({ where: { businessId: negocio.id, activo: true }, order: [['id', 'ASC']] }))[0];
  const metodo = await PaymentMethod.findOne({ where: { businessId: negocio.id } });

  const prod = await Product.create({
    businessId: negocio.id, sku: 'QA-PRE', skuAgrupador: 'QA-PRE', titulo: 'QA Precios',
    precioMinorista: 10000, precioMayorista: 8000, costo: 4000, activo: true,
  });
  const chico = await ProductVariant.create({
    productId: prod.id, businessId: negocio.id, sku: 'QA-PRE-S',
    variante1Nombre: 'Talle', variante1Valor: 'S', stock: 0, stockMinimo: 0,
  });
  const grande = await ProductVariant.create({
    productId: prod.id, businessId: negocio.id, sku: 'QA-PRE-XXL',
    variante1Nombre: 'Talle', variante1Valor: 'XXL', stock: 0, stockMinimo: 0,
    precioMinorista: 13000,
  });

  const creadas = [];
  try {
    await stock.mover({ variantId: chico.id, businessId: negocio.id, locationId: local.id, delta: 10, tipo: 'ingreso', motivo: 'QA' });
    await stock.mover({ variantId: grande.id, businessId: negocio.id, locationId: local.id, delta: 10, tipo: 'ingreso', motivo: 'QA' });

    const api = sesion();
    await api('POST', '/api/auth/login', { email: 'demo@stocker.app', password: 'Demo2026!!' });

    tit('3. EL BUSCADOR DEL PUNTO DE VENTA');
    const bChico  = await api('GET', `/api/products/scan/${chico.sku}`);
    const bGrande = await api('GET', `/api/products/scan/${grande.sku}`);
    chk('el talle S muestra el del producto', 10000, bChico.json?.precioMinorista);
    chk('el XXL muestra el suyo',             13000, bGrande.json?.precioMinorista);
    chk('y avisa cuál es propio',              true, bGrande.json?.propio?.precioMinorista);
    chk('el del producto no figura como propio', false, bChico.json?.propio?.precioMinorista);

    tit('4. LA VENTA COBRA LO QUE CORRESPONDE');
    /*
     * Sin mandar `precioUnitario`: se prueba lo que decide el servidor. Si el
     * cliente manda el precio, un bug del servidor quedaría tapado por el
     * número que vino del navegador.
     */
    const venta = await api('POST', '/api/sales', {
      tipo: 'venta', estado: 'pagado', locationId: local.id,
      items: [{ productVariantId: chico.id, cantidad: 1 }, { productVariantId: grande.id, cantidad: 1 }],
      pagos: [{ paymentMethodId: metodo.id, monto: 23000 }],
    });
    if (venta.json?.id) creadas.push(venta.json.id);
    chk('la venta entra', 201, venta.status);
    const porSku = new Map((venta.json?.items || []).map((i) => [i.sku, Number(i.precioUnitario)]));
    chk('cobró el del producto por el S',  10000, porSku.get('QA-PRE-S'));
    chk('cobró el propio por el XXL',      13000, porSku.get('QA-PRE-XXL'));
    chk('el total suma los dos',           23000, Number(venta.json?.total));

    tit('5. MAYORISTA — 3 o más prendas');
    // El XXL no tiene mayorista propio: tiene que caer al del producto.
    const mayor = await api('POST', '/api/sales', {
      tipo: 'venta', estado: 'pagado', locationId: local.id,
      items: [{ productVariantId: grande.id, cantidad: 3 }],
      pagos: [{ paymentMethodId: metodo.id, monto: 24000 }],
    });
    if (mayor.json?.id) creadas.push(mayor.json.id);
    chk('sin mayorista propio, usa el del producto', 8000, Number(mayor.json?.items?.[0]?.precioUnitario));

    tit('6. VOLVER A HEREDAR');
    const quitar = await api('POST', '/api/products/precios-masivo', {
      items: [{ variantId: grande.id, precioMinorista: null }],
    });
    chk('la llamada entra', 200, quitar.status);
    const trasQuitar = await api('GET', `/api/products/scan/${grande.sku}`);
    chk('vuelve al precio del producto', 10000, trasQuitar.json?.precioMinorista);
    chk('y deja de ser propio',           false, trasQuitar.json?.propio?.precioMinorista);

    tit('7. VALIDACIONES');
    const negativo = await api('POST', '/api/products/precios-masivo', {
      items: [{ variantId: grande.id, precioMinorista: -5 }],
    });
    chk('un precio negativo se rechaza', 400, negativo.status);
    const ajeno = await api('POST', '/api/products/precios-masivo', { items: [{ variantId: 1, precioMinorista: 1 }] });
    chk('una variante de otro negocio, también', 404, ajeno.status);

    /*
     * El tope de las columnas de dinero: DECIMAL(12,2).
     *
     * Un número más grande no daba un error de validación, daba un desborde en
     * la base — un 500 con "Error interno del servidor" en la cara del que
     * estaba cargando un producto. El alta lo mostró en el QA manual; acá
     * queda cubierto en los tres caminos que escriben precios.
     */
    const DESMEDIDO = 999999999999;
    const topeMasivo = await api('POST', '/api/products/precios-masivo', {
      items: [{ variantId: grande.id, precioMinorista: DESMEDIDO }],
    });
    chk('precio desmedido en la carga masiva', 400, topeMasivo.status);

    const topeVariante = await api('PUT', `/api/products/variants/${grande.id}`, { precioMinorista: DESMEDIDO });
    chk('precio desmedido al editar la variante', 400, topeVariante.status);

    const topeAlta = await api('POST', '/api/products', {
      titulo: 'QA tope', sku: 'QA-TOPE-P', skuAgrupador: 'QA-TOPE-P',
      precioMinorista: 1000, precioMayorista: DESMEDIDO,
    });
    chk('precio desmedido en el alta', 400, topeAlta.status);
    chk('y lo dice sin hablar de la base', false,
      /internal|Sequelize|EREQUEST|overflow/i.test(topeAlta.json?.message || ''));

    tit('8. UN PRODUCTO NO NACE SIN PRECIO');
    /*
     * Sin precio de venta el producto se puede agregar a una venta en $ 0, y
     * nada avisa. Es el agujero que encontró el plan de pruebas manual.
     */
    const sinPrecio = await api('POST', '/api/products', {
      titulo: 'QA sin precio', sku: 'QA-SINP-P', skuAgrupador: 'QA-SINP-P',
    });
    chk('sin precio no se crea', 400, sinPrecio.status);
    const conCero = await api('POST', '/api/products', {
      titulo: 'QA cero', sku: 'QA-CERO-P', skuAgrupador: 'QA-CERO-P', precioMinorista: 0,
    });
    chk('con precio 0 tampoco', 400, conCero.status);

    // Y los faltantes se dicen todos juntos, no de a uno por viaje.
    const vacio = await api('POST', '/api/products', {});
    const dice = vacio.json?.message || '';
    chk('el cuerpo vacío nombra los cuatro faltantes', true,
      ['título', 'SKU padre', 'SKU agrupador', 'precio minorista'].every((x) => dice.includes(x)));
    chk('y no muestra nombres del modelo', false, /cannot be null|Product\./i.test(dice));

    tit('9. EL SKU REPETIDO NO MUESTRA EL ÍNDICE');
    const repetido = await api('POST', '/api/products', {
      titulo: 'QA repetido', sku: prod.sku, skuAgrupador: 'QA-REPE-P', precioMinorista: 1000,
    });
    chk('se rechaza', 400, repetido.status);
    chk('sin nombrar el índice', false, /uq_|must be unique/i.test(repetido.json?.message || ''));

    tit('10. DESCUENTO POR IMPORTE, ADEMÁS DEL PORCENTAJE');
    /*
     * En el mostrador se regatea de las dos maneras: "te hago el 10%" y "te lo
     * dejo en 45.000" son la misma conversación. Antes sólo entraba la primera,
     * y para la segunda había que sacar la cuenta a mano y cargar un porcentaje
     * que casi nunca daba el número prometido.
     *
     * Se guardan las dos caras: el importe porque es lo que se descontó de
     * verdad, y el porcentaje porque es como se lee un descuento de un vistazo.
     */
    const conMonto = await api('POST', '/api/sales', {
      tipo: 'venta', estado: 'pagado', locationId: local.id,
      items: [{ productVariantId: chico.id, cantidad: 1 }],   // 10000
      descuentoMonto: 2500,
      pagos: [{ paymentMethodId: metodo.id, monto: 7500 }],
    });
    if (conMonto.json?.id) creadas.push(conMonto.json.id);
    chk('la venta con descuento en pesos entra', 201, conMonto.status);
    chk('descuenta exactamente lo pedido', 2500, Number(conMonto.json?.descuento));
    chk('y deja escrito qué porcentaje representa', 25, Number(conMonto.json?.descuentoPct));
    chk('el total baja', 7500, Number(conMonto.json?.total));

    // Un importe que no da un porcentaje redondo: el porcentaje se guarda con
    // decimales, que es el número real y no uno acomodado para que quede lindo.
    const raro = await api('POST', '/api/sales', {
      tipo: 'venta', estado: 'pagado', locationId: local.id,
      items: [{ productVariantId: chico.id, cantidad: 1 }],
      descuentoMonto: 3333,
      pagos: [{ paymentMethodId: metodo.id, monto: 6667 }],
    });
    if (raro.json?.id) creadas.push(raro.json.id);
    chk('un importe cualquiera da su porcentaje con decimales', 33.33, Number(raro.json?.descuentoPct));
    chk('pero lo que se descuenta es el importe, no el redondeo', 3333, Number(raro.json?.descuento));

    // El porcentaje sigue andando como siempre.
    const conPct = await api('POST', '/api/sales', {
      tipo: 'venta', estado: 'pagado', locationId: local.id,
      items: [{ productVariantId: chico.id, cantidad: 1 }],
      descuentoPct: 10,
      pagos: [{ paymentMethodId: metodo.id, monto: 9000 }],
    });
    if (conPct.json?.id) creadas.push(conPct.json.id);
    chk('el descuento por porcentaje sigue igual', [10, 1000, 9000],
      [Number(conPct.json?.descuentoPct), Number(conPct.json?.descuento), Number(conPct.json?.total)]);

    /*
     * Las dos juntas se rechazan. Decidir cuál gana en silencio es lo que hace
     * que el ticket diga una cosa y la caja otra.
     */
    const ambas = await api('POST', '/api/sales', {
      tipo: 'venta', estado: 'pagado', locationId: local.id,
      items: [{ productVariantId: chico.id, cantidad: 1 }],
      descuentoPct: 10, descuentoMonto: 2500,
      pagos: [{ paymentMethodId: metodo.id, monto: 7500 }],
    });
    if (ambas.json?.id) creadas.push(ambas.json.id);
    chk('mandar las dos formas se rechaza', 400, ambas.status);
    chk('y dice que hay que elegir una', true, /una sola forma/i.test(ambas.json?.message || ''));

    // Más descuento que venta dejaría el total en negativo: una devolución que
    // nadie pidió.
    const pasado = await api('POST', '/api/sales', {
      tipo: 'venta', estado: 'pagado', locationId: local.id,
      items: [{ productVariantId: chico.id, cantidad: 1 }],
      descuentoMonto: 99999,
      pagos: [{ paymentMethodId: metodo.id, monto: 0 }],
    });
    if (pasado.json?.id) creadas.push(pasado.json.id);
    chk('un descuento mayor que la venta se rechaza', 400, pasado.status);

    /*
     * Y en una cotización, que es donde más se usa: se presupuesta con el
     * descuento ya aplicado, y el cliente se lleva el número final.
     */
    const cotizada = await api('POST', '/api/sales', {
      tipo: 'cotizacion', estado: 'pendiente', locationId: local.id,
      items: [{ productVariantId: chico.id, cantidad: 2 }],   // 20000
      descuentoMonto: 5000,
    });
    if (cotizada.json?.id) creadas.push(cotizada.json.id);
    chk('la cotización con descuento en pesos entra', 201, cotizada.status);
    chk('con su importe y su porcentaje', [5000, 25, 15000],
      [Number(cotizada.json?.descuento), Number(cotizada.json?.descuentoPct), Number(cotizada.json?.total)]);

    const descNegativo = await api('POST', '/api/sales', {
      tipo: 'venta', estado: 'pagado', locationId: local.id,
      items: [{ productVariantId: chico.id, cantidad: 1 }],
      descuentoMonto: -500,
      pagos: [{ paymentMethodId: metodo.id, monto: 10500 }],
    });
    if (descNegativo.json?.id) creadas.push(descNegativo.json.id);
    chk('un descuento negativo se rechaza', 400, descNegativo.status);

  } finally {
    for (const id of creadas) {
      await SalePayment.destroy({ where: { saleId: id } });
      await SaleItem.destroy({ where: { saleId: id } });
      await Sale.destroy({ where: { id } });
    }
    await StockMovement.destroy({ where: { productVariantId: [chico.id, grande.id] } });
    await SaleItem.destroy({ where: { productVariantId: [chico.id, grande.id] } });
    await VariantStock.destroy({ where: { productVariantId: [chico.id, grande.id] } });
    await ProductVariant.destroy({ where: { id: [chico.id, grande.id] } });
    await Product.destroy({ where: { id: prod.id } });
    // Ninguno de estos debería existir: si alguno se creó, la prueba falló y
    // además dejó basura. Se limpia igual.
    await Product.destroy({ where: { sku: ['QA-TOPE-P', 'QA-SINP-P', 'QA-CERO-P', 'QA-REPE-P'] } });
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
