/*
 * Lo que Stocker promete por escrito contra lo que el código hace.
 *
 * Los Términos, la Privacidad y la página de planes se escribieron a mano, y
 * se desfasaron del sistema más de una vez: la landing vendía "un local" para
 * el Inicial cuando el plan daba dos; el catálogo ofrecía API, compras, listas
 * de precios y facturación por lote que nunca existieron; la Privacidad decía
 * que las claves de Mercado Libre y Jumpseller se guardaban cifradas y estaban
 * en texto plano. Un texto legal que promete lo que no hay es peor que uno
 * incompleto.
 *
 * Esta suite cuida, en este orden:
 *
 *   1. Que el catálogo no ofrezca una función que ninguna ruta exige.
 *   2. Que la semilla le saque las funciones retiradas y los textos falsos a
 *      los planes guardados, también a los editados desde el backoffice (sin
 *      pisar lo que escribió un operador).
 *   3. Que el backoffice pueda guardar un plan que todavía trae las retiradas.
 *   4. Que el registro viejo de ingresos de empleados se borre a los 90 días,
 *      como dice la Privacidad.
 *   5. Que cada número de los textos legales (los marcados con data-dato) sea
 *      el que usa el código, y que la versión publicada sea TERMINOS_VERSION.
 *   6. Que la página de planes diga lo que dice el catálogo.
 *
 * Corre en proceso. Lee las páginas de la landing del repo de al lado
 * (front/landing), como test-enlaces-legales lee el front. Toca los planes de
 * la base local y los deja como estaban.
 */

require('dotenv').config({ path: __dirname + '/../.env' });

// Los textos citan los valores POR OMISIÓN; una variable de entorno local no
// tiene que hacer fallar ni pasar esta prueba.
for (const v of ['SESSION_IDLE_MINUTES', 'SESSION_ABSOLUTE_HOURS', 'PAGO_VENCE_H']) delete process.env[v];

const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');

let ok = 0;
let ko = 0;
const chk = (t, esperado, obtenido) => {
  const igual = JSON.stringify(esperado) === JSON.stringify(obtenido);
  console.log(`  ${igual ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${t}`);
  if (!igual) console.log(`      esperaba ${JSON.stringify(esperado)} · vino ${JSON.stringify(obtenido)}`);
  igual ? (ok += 1) : (ko += 1);
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const SRC = path.join(__dirname, '../src');
const LANDING = path.join(__dirname, '../../../front/landing');
const leerLanding = (archivo) => fs.readFileSync(path.join(LANDING, archivo), 'utf8');

// Saca las etiquetas y junta los espacios: para buscar frases en el texto.
const textoPlano = (html) => html
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** Todos los archivos .js de una carpeta, recursivo. */
function fuentes(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...fuentes(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

(async () => {
  const {
    FEATURES, FEATURES_RETIRADAS, CATALOGO_FEATURES, PLANES, PLAN_POR_DEFECTO, DIAS_TRIAL, DIAS_GRACIA,
  } = require('../src/config/planes');
  const { TERMINOS_VERSION } = require('../src/config/terminos');
  const { Plan, Employee, EmployeeSession } = require('../src/models');
  const planService = require('../src/services/planService');
  const sesiones = require('../src/services/sesionesService');
  const backoffice = require('../src/controllers/backofficeController');
  const db = require('../src/config/database');

  const porOrden = [...PLANES].sort((a, b) => a.orden - b.orden);
  const primeroCon = (...claves) => porOrden.find((p) => claves.every((k) => p.features?.[k]));

  // ───────────────────────────────────────────────────────────────────
  tit('1. EL CATÁLOGO NO PROMETE LO QUE NO HAY');
  const claves = CATALOGO_FEATURES.map((f) => f.clave);
  chk('ninguna función retirada en el catálogo', [], claves.filter((k) => FEATURES_RETIRADAS.includes(k)));
  chk('ninguna función retirada en FEATURES', [],
    Object.values(FEATURES).filter((k) => FEATURES_RETIRADAS.includes(k)));
  chk('ningún plan de la semilla trae una retirada', [],
    PLANES.flatMap((p) => Object.keys(p.features).filter((k) => FEATURES_RETIRADAS.includes(k)).map((k) => `${p.codigo}.${k}`)));
  chk('cada plan nombra todas las funciones del catálogo', [],
    PLANES.flatMap((p) => claves.filter((k) => !(k in p.features)).map((k) => `${p.codigo}.${k}`)));

  /*
   * La regla que importa: una función del catálogo tiene que tener una puerta
   * en el código —una ruta con requireFeature, un tieneFeature, o el origen de
   * una credencial en config/plataformas—. Si no la tiene, el plan "la incluye"
   * y no incluye nada.
   */
  const codigo = fuentes(SRC)
    .filter((f) => !f.endsWith(path.join('config', 'planes.js')))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
  const nombreDe = Object.fromEntries(Object.entries(FEATURES).map(([n, v]) => [v, n]));
  const sinPuerta = claves.filter((k) => {
    const n = nombreDe[k];
    // requireFeature(FEATURES.X) / tieneFeature(negocio, FEATURES.X), o una
    // plataforma de config/plataformas con el origen de la credencial que la
    // exige requireIntegracion.
    return !new RegExp(`requireFeature\\(\\s*FEATURES\\.${n}\\b`).test(codigo)
      && !new RegExp(`tieneFeature\\([^)]*FEATURES\\.${n}\\b`).test(codigo)
      && !new RegExp(`feature:\\s*FEATURES\\.${n},\\s*origen:`).test(codigo);
  });
  chk('toda función del catálogo tiene una puerta en el código', [], sinPuerta);

  const prometeDeMas = /chat|tel[eé]fono|masiva|por lote|compras|proveedores|listas? de precios|\bAPI\b|multi-?dep[oó]sito|todo el sistema/i;
  chk('ningún soporte ni descripción promete lo retirado', [],
    PLANES.filter((p) => prometeDeMas.test(`${p.soporte} ${p.descripcion}`)).map((p) => p.codigo));

  const prueba = PLANES.find((p) => p.codigo === PLAN_POR_DEFECTO);
  chk('el plan de la prueba trae todas las funciones (la landing lo dice)', [],
    claves.filter((k) => !prueba.features[k]));
  const superior = PLANES.find((p) => p.codigo === 'superior');
  const enterprise = PLANES.find((p) => p.codigo === 'enterprise');
  chk('el Superior trae todo lo del Pro', [], claves.filter((k) => prueba.features[k] && !superior.features[k]));
  chk('el Enterprise trae todo lo del Superior', [], claves.filter((k) => superior.features[k] && !enterprise.features[k]));

  // ───────────────────────────────────────────────────────────────────
  tit('2. LA SEMILLA LIMPIA LOS PLANES GUARDADOS');
  const guardados = await Plan.findAll({ where: { codigo: PLANES.map((p) => p.codigo) } });
  const foto = guardados.map((p) => ({ id: p.id, datos: { ...p.get({ plain: true }), features: JSON.stringify(p.features) } }));
  const fila = async (c) => Plan.findOne({ where: { codigo: c } });
  const semilla = (c) => PLANES.find((p) => p.codigo === c);
  try {
    // A) Sin editar: un cambio SÓLO de descripción tiene que llegar.
    const ini = semilla('inicial');
    await (await fila('inicial')).update({
      ...Object.fromEntries(Object.entries(ini).filter(([k]) => k !== 'textosViejos')),
      features: JSON.stringify(ini.features),
      descripcion: ini.textosViejos.descripcion[0],
      editadoEn: null,
    });
    // B) Sin editar: un plan con una función retirada guardada.
    const pro = semilla('pro');
    await (await fila('pro')).update({
      ...Object.fromEntries(Object.entries(pro).filter(([k]) => k !== 'textosViejos')),
      features: JSON.stringify({ ...pro.features, api: true, compras: true }),
      editadoEn: null,
    });
    // C) Editado por un operador, con las promesas viejas y un precio propio.
    const editadoEn = new Date('2026-09-01T12:00:00Z');
    await (await fila('superior')).update({
      precioMensual: 123456,
      soporte: semilla('superior').textosViejos.soporte[0],
      descripcion: semilla('superior').textosViejos.descripcion[0],
      features: JSON.stringify({ ...semilla('superior').features, api: true, listasPrecios: true, multiDeposito: true }),
      editadoEn,
    });
    // D) Editado, con textos que escribió el operador: no se tocan.
    await (await fila('enterprise')).update({
      soporte: 'Atención personalizada',
      descripcion: 'Texto propio del operador',
      features: JSON.stringify({ ...semilla('enterprise').features, facturacionMasiva: true }),
      editadoEn,
    });

    await planService.sembrarPlanes();

    const a = await fila('inicial');
    chk('sin editar: la descripción vieja se reemplaza', ini.descripcion, a.descripcion);
    const b = await fila('pro');
    chk('sin editar: se van las funciones retiradas', [], Object.keys(b.features).filter((k) => FEATURES_RETIRADAS.includes(k)));
    const c = await fila('superior');
    chk('editado: se van las funciones retiradas', [], Object.keys(c.features).filter((k) => FEATURES_RETIRADAS.includes(k)));
    chk('editado: el soporte viejo (chat y teléfono) se reemplaza', semilla('superior').soporte, c.soporte);
    chk('editado: la descripción vieja se reemplaza', semilla('superior').descripcion, c.descripcion);
    chk('editado: el precio que puso el operador se respeta', 123456, Number(c.precioMensual));
    chk('editado: sigue marcado como editado', editadoEn.toISOString(), new Date(c.editadoEn).toISOString());
    chk('editado: el resto de sus funciones queda igual', true, Object.keys(semilla('superior').features)
      .every((k) => c.features[k] === semilla('superior').features[k]));
    const d = await fila('enterprise');
    chk('editado con texto propio: el soporte no se toca', 'Atención personalizada', d.soporte);
    chk('editado con texto propio: la descripción no se toca', 'Texto propio del operador', d.descripcion);
    chk('editado con texto propio: igual se le saca la retirada', false, 'facturacionMasiva' in d.features);
  } finally {
    for (const { id, datos } of foto) await Plan.update(datos, { where: { id } });
  }

  // ───────────────────────────────────────────────────────────────────
  tit('3. EL BACKOFFICE GUARDA UN PLAN QUE TODAVÍA TRAE LAS RETIRADAS');
  const codigoQa = `qa-leg-${process.pid}`.slice(0, 20);
  await Plan.destroy({ where: { codigo: codigoQa } });
  await Plan.create({
    codigo: codigoQa, nombre: 'QA legales', activo: false, orden: 99,
    features: JSON.stringify({ facturacion: true, api: true, compras: true }),
  });
  const editar = async (body) => {
    const salida = { status: 200, json: null };
    const res = {
      status(s) { salida.status = s; return this; },
      json(j) { salida.json = j; return this; },
    };
    await backoffice.editarPlan({ admin: { id: 0, rol: 'owner' }, params: { codigo: codigoQa }, body }, res,
      (e) => { throw e; });
    return salida;
  };
  try {
    // Lo que manda la pantalla: el objeto entero que leyó, retiradas incluidas.
    const r = await editar({ features: { facturacion: false, api: true, compras: true, eventos: true } });
    chk('se guarda (no 400 por las retiradas)', 200, r.status);
    const guardado = await Plan.findOne({ where: { codigo: codigoQa } });
    chk('lo que se nombró se aplica', [false, true], [guardado.features.facturacion, guardado.features.eventos]);
    chk('y las retiradas no quedan, ni las que mandó ni las que tenía', [],
      Object.keys(guardado.features).filter((k) => FEATURES_RETIRADAS.includes(k)));
    const r2 = await editar({ features: { inventada: true } });
    chk('una clave que nunca existió sigue dando 400', 400, r2.status);
  } finally {
    await Plan.destroy({ where: { codigo: codigoQa } });
  }

  // ───────────────────────────────────────────────────────────────────
  tit('4. LOS INGRESOS DE EMPLEADOS SE BORRAN A LOS 90 DÍAS');
  const empleado = await Employee.findOne({ attributes: ['id'] });
  if (!empleado) {
    chk('hay un empleado en la base para probar la purga', true, false);
  } else {
    const DIA = 24 * 60 * 60 * 1000;
    const hace = (d) => new Date(Date.now() - d * DIA);
    const ua = `qa-legales-${process.pid}`;
    const [vieja, reciente] = await Promise.all([
      EmployeeSession.create({ employeeId: empleado.id, ip: '203.0.113.9', userAgent: ua, loginAt: hace(95), lastSeenAt: hace(sesiones.RETENCION_DIAS + 1) }),
      EmployeeSession.create({ employeeId: empleado.id, ip: '203.0.113.9', userAgent: ua, loginAt: hace(89), lastSeenAt: hace(sesiones.RETENCION_DIAS - 1) }),
    ]);
    try {
      await sesiones.purgar();
      chk('la de hace más de 90 días se borra', null, await EmployeeSession.findByPk(vieja.id));
      chk('la de hace menos de 90 días queda', reciente.id, (await EmployeeSession.findByPk(reciente.id))?.id);
    } finally {
      await EmployeeSession.destroy({ where: { userAgent: ua } });
    }
  }

  // ───────────────────────────────────────────────────────────────────
  tit('5. CADA NÚMERO DE LOS TEXTOS LEGALES ES EL DEL CÓDIGO');
  if (!fs.existsSync(LANDING)) {
    console.log('  (no está la landing al lado: se saltea)');
  } else {
    const session = require('../src/utils/session');
    const bloqueo = require('../src/services/bloqueoService');
    const cola = require('../src/services/colaVentasOnlineService');
    const logo = require('../src/utils/logoFactura');
    const sinTope = (v) => (v == null ? 'sin tope' : String(v));

    /*
     * El valor de cada data-dato, sacado del código. Un número escrito en el
     * texto sin su data-dato no se controla: por eso la sección también exige
     * que cada página tenga los suyos.
     */
    const DATOS = {
      'terminos.version': TERMINOS_VERSION,
      'trial.dias': String(DIAS_TRIAL),
      'trial.plan': prueba.nombre,
      'gracia.dias': String(DIAS_GRACIA),
      'periodo.dias': String(planService.DIAS_PERIODO),
      'sesion.inactividadMin': String(session.IDLE_MIN),
      'sesion.maximoHoras': String(session.ABSOLUTE_H),
      'sesiones.retencionDias': String(sesiones.RETENCION_DIAS),
      'sesiones.historialDias': String(sesiones.HISTORIAL_DIAS),
      // Los ingresos de empleados se purgan con la misma constante (sección 4).
      'ingresosEmpleados.retencionDias': String(sesiones.RETENCION_DIAS),
      'intentos.retencionDias': String(bloqueo.RETENCION_DIAS),
      'reserva.horas': String(cola.PAGO_VENCE_H),
      'reserva.topeDias': String(cola.PAGO_TOPE_H / 24),
      'logo.maxKb': String(logo.LOGO_MAX_BYTES / 1024),
      'logo.maxLado': String(logo.LOGO_MAX_LADO),
      'conexiones.desde': primeroCon(FEATURES.TIENDA_PROPIA, FEATURES.PORTAL_MAYORISTA)?.nombre,
      'ecommerce.desde': primeroCon(FEATURES.ECOMMERCE)?.nombre,
      ...Object.fromEntries(PLANES.map((p) => [`plan.${p.codigo}.maxSesiones`, sinTope(p.maxSesiones)])),
    };
    const EXIGIDOS = {
      'terminos.html': [
        'terminos.version', 'trial.dias', 'trial.plan', 'gracia.dias', 'periodo.dias',
        'sesion.inactividadMin', 'sesion.maximoHoras', 'reserva.horas', 'reserva.topeDias',
        'logo.maxKb', 'logo.maxLado', 'conexiones.desde', 'ecommerce.desde',
        ...PLANES.map((p) => `plan.${p.codigo}.maxSesiones`),
      ],
      'privacidad.html': [
        'terminos.version', 'sesiones.retencionDias', 'sesiones.historialDias',
        'ingresosEmpleados.retencionDias', 'intentos.retencionDias',
      ],
      'reembolsos.html': ['terminos.version'],
      'cookies.html': ['terminos.version', 'sesion.inactividadMin', 'sesion.maximoHoras'],
    };

    for (const [archivo, exigidos] of Object.entries(EXIGIDOS)) {
      const html = leerLanding(archivo);
      const encontrados = [...html.matchAll(/<span data-dato="([^"]+)">([\s\S]*?)<\/span>/g)]
        .map(([, k, v]) => [k, v.replace(/\s+/g, ' ').trim()]);
      chk(`${archivo}: ningún data-dato desconocido`, [], encontrados.filter(([k]) => !(k in DATOS)).map(([k]) => k));
      chk(`${archivo}: cada dato dice lo que dice el código`, [],
        encontrados.filter(([k, v]) => k in DATOS && v !== DATOS[k]).map(([k, v]) => `${k}: "${v}" (código: "${DATOS[k]}")`));
      const presentes = new Set(encontrados.map(([k]) => k));
      chk(`${archivo}: están todos los que tiene que citar`, [], exigidos.filter((k) => !presentes.has(k)));
    }

    /*
     * Lo que la Privacidad dice de las claves de Mercado Libre y Jumpseller
     * tiene que coincidir con cómo se guardan. Hoy no hay cifrado en ningún
     * lado del código: si algún día se cifran (la tarea siguiente), esta
     * comprobación pide cambiar el texto, y al revés.
     */
    const privacidad = textoPlano(leerLanding('privacidad.html'));
    const hayCifrado = /createCipheriv|createDecipheriv/.test(codigo);
    const frase = privacidad.match(/Las claves de conexión de Mercado Libre y de Jumpseller[^.]*\./)?.[0] || '';
    chk('Privacidad: hay una frase sobre las claves de Mercado Libre y Jumpseller', true, Boolean(frase));
    chk('Privacidad: dice "sin cifrar" mientras el código no las cifre', !hayCifrado, /sin cifrar/.test(frase));
    chk('Privacidad: ya no dice que las credenciales de las integraciones se guardan cifradas', false,
      /credenciales de las integraciones se guardan cifradas/i.test(privacidad));

    /*
     * Que no se caiga una cláusula de lo que esta etapa construyó. No mide la
     * redacción: mide que el tema esté.
     */
    const terminos = textoPlano(leerLanding('terminos.html'));
    const TEMAS = {
      'integraciones y que no respondemos por los terceros': /No respondemos por la disponibilidad de esos servicios/,
      'Jumpseller nombrado': /Jumpseller/,
      'credenciales emitidas por el equipo de Stocker': /La credencial la emite el equipo de Stocker/,
      'revocar una credencial': /la anterior deja de servir/,
      'límite de dispositivos del dueño': /máximo de dispositivos abiertos a la vez/,
      'se cierra la de menos actividad': /menos actividad reciente/,
      'desarrollos a medida por única vez': /trabajo por única vez, aparte de la suscripción/,
      'datos del comprador en los pedidos': /datos personales de quien compra/,
      'delegación ARCA sin pedir la Clave Fiscal': /Nunca te pedimos tu Clave Fiscal/,
      'reserva de stock sin pagar y su vencimiento': /aparta la mercadería/,
      'prorrateo al subir': /sólo la diferencia/,
      'el vencimiento no se mueve': /tu vencimiento no se mueve/,
      'bajada con elección de empleados': /elegís cuáles siguen usando Stocker/,
      'suspendidos vuelven al subir': /se reactivan solos/,
      'débito automático actualizado': /actualizamos nosotros el monto del débito/,
      'el logo de la factura': /El logo de la factura/,
    };
    chk('Términos: están todos los temas', [], Object.entries(TEMAS).filter(([, re]) => !re.test(terminos)).map(([t]) => t));
  }

  // ───────────────────────────────────────────────────────────────────
  tit('6. LA PÁGINA DE PLANES DICE LO QUE DICE EL CATÁLOGO');
  if (!fs.existsSync(LANDING)) {
    console.log('  (no está la landing al lado: se saltea)');
  } else {
    const html = leerLanding('index.html');
    const miles = new Intl.NumberFormat('es-AR');
    const tope = (v, suf = '') => (v == null ? 'Sin tope' : miles.format(v) + suf);

    for (const plan of PLANES) {
      const bloque = html.match(new RegExp(`<article class="plan[^"]*" data-plan="${plan.codigo}">([\\s\\S]*?)</article>`))?.[1];
      if (!bloque) { chk(`${plan.codigo}: está la tarjeta`, true, false); continue; }

      const precio = bloque.match(/data-ars="(\d+)"/)?.[1];
      chk(`${plan.codigo}: el precio escrito es el de la semilla`, plan.precioMensual == null ? null : String(plan.precioMensual), precio ?? null);

      const filas = Object.fromEntries([...bloque.matchAll(/<dt>([^<]+)<\/dt><dd>([^<]+)<\/dd>/g)].map(([, k, v]) => [k.trim(), v.trim()]));
      chk(`${plan.codigo}: los topes escritos son los de la semilla`, {
        Comprobantes: tope(plan.maxComprobantes, '/mes'),
        SKUs: tope(plan.maxSkus),
        CUITs: tope(plan.maxCuits),
        Usuarios: tope(plan.maxEmpleados),
        Locales: tope(plan.maxLocales),
        'Dispositivos del dueño': tope(plan.maxSesiones, ' a la vez'),
        Soporte: plan.soporte,
      }, filas);

      const para = bloque.match(/<p class="plan-for">([\s\S]*?)<\/p>/)?.[1].replace(/\s+/g, ' ').trim();
      chk(`${plan.codigo}: la bajada de la tarjeta es la descripción del plan`, plan.descripcion, para);

      const items = [...bloque.matchAll(/<li class="(yes|no)" data-feature="([^"]+)">/g)]
        .map(([, clase, ks]) => ({ clase, ks: ks.split(',').map((k) => k.trim()) }));
      chk(`${plan.codigo}: cada tilde nombra funciones del catálogo`, [],
        items.flatMap((i) => i.ks.filter((k) => !claves.includes(k))));
      chk(`${plan.codigo}: el tilde y la cruz escritos coinciden con la semilla`, [],
        items.filter((i) => (i.clase === 'yes') !== i.ks.every((k) => plan.features[k] === true)).map((i) => i.ks.join(',')));
    }

    // Cada fila de las tarjetas se actualiza desde la API: el script tiene que
    // conocer su nombre, si no la fila queda con el valor escrito para siempre.
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || '';
    const filasDeTarjetas = [...new Set([...html.matchAll(/<dt>([^<]+)<\/dt>/g)].map(([, k]) => k.trim()))];
    chk('el script de datos en vivo conoce todas las filas', [],
      filasDeTarjetas.filter((k) => !script.includes(`"${k}":`)));

    /*
     * Lo que la decisión 8 sacó. Se busca en el texto visible, no en los
     * comentarios del HTML (que explican por qué se sacó).
     */
    const visible = textoPlano(html);
    const PROHIBIDO = {
      'API para integraciones': /\bAPI\b/,
      'listas de precios': /listas? de precios/i,
      'facturación masiva o por lote': /facturaci[oó]n masiva|por lote/i,
      'compras y proveedores': /proveedores|[oó]rdenes de compra/i,
      'multi-depósito': /multi-?dep[oó]sito/i,
      'aviso del día 7': /D[ií]a 7\b/,
      'aviso del día 12': /D[ií]a 12\b/,
      'soporte por chat': /\bchat\b/i,
      'soporte por teléfono': /Soporte[^.]{0,40}tel[eé]fono/i,
      'una prueba con "todo"': /todo (habilitado|abierto)/i,
      '"un local" en el Inicial': /\bUn local\b/,
    };
    chk('la landing no promete nada de lo retirado', [],
      Object.entries(PROHIBIDO).filter(([, re]) => re.test(visible)).map(([t]) => t));
    chk('el IVA se sigue diciendo igual (decisión 14)', true,
      visible.includes('Valores mensuales con IVA incluido. Se paga por Mercado Pago o transferencia.'));
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  await db.close();
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
