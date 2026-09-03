/*
 * Que el sistema aguante varias cajas a la vez sin caerse ni perder ventas.
 *
 * Tres defectos distintos se juntaban acá, y los tres se vieron con doce
 * pedidos simultáneos —tres locales con cuatro terminales, un lunes:
 *
 *   · `const t = await sequelize.transaction()` está escrito ANTES del try en
 *     treinta controladores. Con el pool agotado eso lanza fuera de todo catch,
 *     Express 4 no ve el rechazo, Node lo vuelve uncaughtException y el proceso
 *     se mataba. Un pico de ventas dejaba sin sistema a TODOS los negocios.
 *
 *   · Cada venta pedía una SEGUNDA conexión —para calcular el número de
 *     comprobante— mientras retenía la de su transacción. Con diez conexiones,
 *     diez ventas se quedaban esperando cada una la que tenía otra. De doce
 *     ventas entraban dos.
 *
 *   · Al saturarse, el error salía como 500 "Error interno", que hace pensar
 *     que la venta quedó a medias, y a veces como 401 "Token inválido", que
 *     echaba al cajero del sistema en el peor momento.
 *
 * Se usan COTIZACIONES a propósito: ejercitan la misma numeración y las mismas
 * transacciones, pero no disparan el mail ni el WhatsApp que manda cada venta.
 * Con ventas de verdad, esta prueba le mandaría decenas de avisos al dueño.
 *
 * Uso:  API=http://localhost:3000 node scripts/test-carga.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const API = process.env.API || 'http://localhost:3000';
const {
  Business, BusinessLocation, Product, ProductVariant, VariantStock, Sale, SaleItem,
} = require('../src/models');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

function sesion() {
  // La cookie queda accesible desde afuera: la subida del .xlsx va con FormData
  // y no puede pasar por este helper, que manda JSON.
  const pedir = async (metodo, ruta, cuerpo) => {
    const r = await fetch(`${API}${ruta}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(pedir.cookie ? { Cookie: pedir.cookie } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    const set = r.headers.getSetCookie?.() || [];
    if (set.length) pedir.cookie = set.map((c) => c.split(';')[0]).join('; ');
    let json = null; try { json = JSON.parse(await r.text()); } catch { /* no json */ }
    return { status: r.status, json };
  };
  pedir.cookie = '';
  return pedir;
}

(async () => {
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  const local = await BusinessLocation.findOne({
    where: { businessId: negocio.id, tipo: 'local', activo: true },
  });
  const existencia = (await VariantStock.findAll({ where: { locationId: local.id }, limit: 300 }))
    .find((e) => (e.stock ?? 0) >= 1);
  const variante = await ProductVariant.findByPk(existencia.productVariantId);

  const api = sesion();
  const login = await api('POST', '/api/auth/login', { email: negocio.email, password: 'Demo2026!!' });
  if (login.status !== 200) { console.log('No se pudo entrar:', login.status); process.exit(1); }

  const creados = [];
  const cotizar = async () => {
    const r = await api('POST', '/api/sales', {
      tipo: 'cotizacion', estado: 'pendiente', locationId: local.id,
      items: [{ productVariantId: variante.id, cantidad: 1}],
    }).catch((e) => ({ status: 'red', json: { message: String(e.cause?.code || e.message) } }));
    if (r.json?.id) creados.push(r.json.id);
    return r;
  };

  /*
   * El limitador de ráfagas (60 pedidos cada 2 s por IP) es una defensa real y
   * no un fallo: sus 429 no se cuentan como pedidos perdidos.
   */
  const util = (rs) => rs.filter((r) => r.status !== 429);

  for (const N of [8, 12, 16]) {
    tit(`${N} CAJAS COBRANDO AL MISMO TIEMPO`);
    const rs = await Promise.all(Array.from({ length: N }, cotizar));
    const contadas = util(rs);
    const entraron = contadas.filter((r) => r.status === 201);

    chk('entran todas las que el limitador dejó pasar', contadas.length, entraron.length);
    chk('ninguna cae por saturación', 0, contadas.filter((r) => r.status === 503).length);
    chk('ninguna cae con error interno', 0, contadas.filter((r) => r.status === 500).length);
    // Un 401 acá sería el peor de los síntomas: echar al cajero por carga.
    chk('a nadie lo echa del sistema', 0, contadas.filter((r) => r.status === 401).length);
    /*
     * Cada una con SU número, y ninguna apartando un número de venta.
     *
     * Antes se comprobaba lo segundo al revés: cada cotización reservaba un
     * número de venta y se verificaba que fueran distintos. Las cotizaciones
     * dejaron de reservar, así que lo que hay que garantizar bajo carga es que
     * la serie COT- no repita.
     */
    chk('cada una con su número de cotización', entraron.length,
      new Set(entraron.map((r) => r.json?.numero).filter(Boolean)).size);
    chk('y ninguna aparta número de venta', 0,
      entraron.filter((r) => r.json?.numeroVenta).length);

    const vivo = await api('GET', '/api/auth/me');
    chk('y el servidor sigue en pie', 200, vivo.status);
  }

  tit('LA IMPORTACIÓN TIENE UN TOPE DE FILAS');
  /*
   * Sin tope, un .xlsx de 10 MB —lo que deja pasar el límite de subida— puede
   * traer más de cien mil filas, cada una con varias consultas, todo dentro de
   * UN pedido. Eso no es una importación lenta: es el proceso reteniendo el
   * archivo y agotando el pool mientras dura, con TODOS los negocios abajo.
   */
  const ExcelJS = require('exceljs');
  const { MAX_FILAS } = require('../src/services/productExcelService');
  chk('el tope está declarado', true, Number.isInteger(MAX_FILAS) && MAX_FILAS > 0);

  const armarPlanilla = async (filas) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Productos');
    ws.addRow(['SKU Padre', 'Título', 'Precio Minorista', 'SKU Variante']);
    for (let i = 0; i < filas; i++) ws.addRow([`QA-IMP-${i}`, `QA ${i}`, 100, `QA-IMP-${i}-U`]);
    return Buffer.from(await wb.xlsx.writeBuffer());
  };

  const subir = async (buffer) => {
    const form = new FormData();
    form.append('file', new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }), 'qa.xlsx');
    const r = await fetch(`${API}/api/products/import`, {
      method: 'POST', headers: { Cookie: api.cookie }, body: form,
    });
    let json = null; try { json = JSON.parse(await r.text()); } catch { /* no json */ }
    return { status: r.status, json };
  };

  const pasada = await subir(await armarPlanilla(MAX_FILAS + 1));
  chk('un archivo con una fila de más se rechaza', 413, pasada.status);
  chk('con un código que la pantalla puede leer', 'ARCHIVO_MUY_GRANDE', pasada.json?.codigo);
  chk('y diciendo cuál es el máximo', true,
    new RegExp(String(MAX_FILAS).replace(/(\d)(?=(\d{3})+$)/g, '$1.')).test(pasada.json?.message || ''));

  /*
   * Que rechace ANTES de escribir es el punto.
   *
   * Un rechazo a mitad de camino dejaría medio catálogo importado y la otra
   * mitad no, sin forma de saber dónde se cortó.
   */
  chk('sin crear nada', 0, await Product.count({ where: { sku: 'QA-IMP-0' } }));

  tit('Limpieza');
  for (const id of creados) {
    await SaleItem.destroy({ where: { saleId: id } });
    const v = await Sale.findByPk(id);
    if (v) await v.destroy();
  }
  chk('no quedan documentos de prueba', 0, (await Sale.findAll({ where: { id: creados } })).length);

  console.log(`\n\x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
