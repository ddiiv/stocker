/*
 * Planes: qué función entra en cuál, y qué pasa con el que ya la usaba.
 *
 * Depósito, reposición y eventos existieron sin puerta durante meses:
 * cualquier cuenta los usaba, pagara lo que pagara. Meterlos al catálogo tiene
 * dos riesgos que este archivo cubre:
 *
 *   · Que la puerta no cierre — y entonces el plan no vale nada.
 *   · Que cierre DE MÁS y le corte el acceso a quien ya tenía mercadería
 *     cargada. Eso no es cobrar una función: es quitarle sus datos a alguien
 *     por un cambio comercial nuestro.
 *
 * Lo segundo se resuelve con una foto tomada una sola vez, al desplegar
 * (`featuresHeredadas`). Que sea una foto y no una regla viva importa: si se
 * recalculara en cada arranque, cualquiera se reabriría la función usándola
 * una vez el día que le corten.
 *
 * Uso:  API=http://localhost:3000 node scripts/test-planes.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const API = process.env.API || 'http://localhost:3000';
const {
  Business, BusinessLocation, Plan, Subscription, Product, ProductVariant, VariantStock,
} = require('../src/models');
const planService = require('../src/services/planService');
const { FEATURES, PLANES } = require('../src/config/planes');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

function sesion() {
  let cookie = '';
  return async (m, ruta, cuerpo) => {
    const r = await fetch(`${API}${ruta}`, {
      method: m,
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
  const sub = await Subscription.findOne({ where: { businessId: negocio.id } });
  const planOriginal = sub.planId;
  const heredadasOriginales = negocio.featuresHeredadas;

  const inicial = await Plan.findOne({ where: { codigo: 'inicial' } });
  const pro = await Plan.findOne({ where: { codigo: 'pro' } });
  const local = await BusinessLocation.findOne({ where: { businessId: negocio.id, tipo: 'local', activo: true } });

  const api = sesion();
  const login = await api('POST', '/api/auth/login', { email: negocio.email, password: 'Demo2026!!' });
  if (login.status !== 200) { console.log('No se pudo entrar:', login.status); process.exit(1); }

  const creados = [];

  try {
    // ─────────────────────────────────────────────────────────────
    tit('1. LA ESCALERA ES DESCENDENTE');
    /*
     * Cada plan tiene que incluir TODO lo del anterior. No es una regla
     * estética: un plan más caro al que le falte algo del barato es imposible
     * de vender y todavía más difícil de explicarle al que ya lo pagó.
     */
    const porOrden = [...PLANES].sort((a, b) => a.orden - b.orden);
    for (let i = 1; i < porOrden.length; i++) {
      const anterior = porOrden[i - 1], actual = porOrden[i];
      const perdidas = Object.values(FEATURES)
        .filter((f) => anterior.features[f] && !actual.features[f]);
      chk(`${actual.codigo} no pierde nada del ${anterior.codigo}`, [], perdidas);
    }

    chk('el inicial trae eventos', true, porOrden[0].features[FEATURES.EVENTOS]);
    chk('el inicial NO trae depósito', false, Boolean(porOrden[0].features[FEATURES.DEPOSITO]));
    chk('el inicial NO trae reposición', false, Boolean(porOrden[0].features[FEATURES.REPOSICION]));
    chk('el pro trae depósito', true, porOrden[1].features[FEATURES.DEPOSITO]);
    chk('el pro trae reposición', true, porOrden[1].features[FEATURES.REPOSICION]);
    chk('el superior trae todo', true,
      Object.values(FEATURES).every((f) => porOrden[2].features[f]));

    // ─────────────────────────────────────────────────────────────
    tit('2. LA PUERTA CIERRA');
    /*
     * Se baja el negocio al plan Inicial Y se le borra la foto de lo heredado:
     * es la situación de una cuenta nueva que nunca usó depósito.
     */
    await sub.update({ planId: inicial.id });
    await negocio.update({ featuresHeredadas: '' });

    chk('depósito no está en el plan', false, await planService.tieneFeature(negocio.id, 'deposito'));
    chk('reposición tampoco', false, await planService.tieneFeature(negocio.id, 'reposicion'));
    chk('eventos sí, es del inicial', true, await planService.tieneFeature(negocio.id, 'eventos'));

    const ingreso = await api('POST', '/api/deposito/ingresos', {
      origen: 'etiquetas', items: [],
    });
    chk('cargar un ingreso se frena', 402, ingreso.status);
    chk('diciendo que es por el plan', 'plan', ingreso.json?.motivo);
    chk('y cuál falta', 'deposito', ingreso.json?.feature);

    const pedido = await api('POST', '/api/reposicion/pedidos', { locationId: local.id, items: [] });
    chk('pedir reposición también', 402, pedido.status);
    chk('por la feature de reposición', 'reposicion', pedido.json?.feature);

    // ─────────────────────────────────────────────────────────────
    tit('3. PERO MIRAR SE PUEDE');
    /*
     * Los GET quedan abiertos a propósito. Un negocio que baja de plan tiene
     * que poder seguir viendo la mercadería que cargó: cerrarle la lectura
     * sería quitarle sus datos, no una función.
     */
    const verIngresos = await api('GET', '/api/deposito/ingresos');
    chk('la lista de ingresos se sigue viendo', 200, verIngresos.status);
    const verPedidos = await api('GET', '/api/reposicion/pedidos');
    chk('y la de pedidos también', 200, verPedidos.status);

    // ─────────────────────────────────────────────────────────────
    tit('4. AL QUE YA LA USABA NO SE LE CORTA');
    await negocio.update({ featuresHeredadas: 'deposito,reposicion' });

    chk('depósito vuelve a estar', true, await planService.tieneFeature(negocio.id, 'deposito'));
    chk('reposición también', true, await planService.tieneFeature(negocio.id, 'reposicion'));
    chk('pero no le abre lo que nunca usó', false, await planService.tieneFeature(negocio.id, 'api'));

    const ingreso2 = await api('POST', '/api/deposito/ingresos', {
      origen: 'etiquetas', items: [],
    });
    /*
     * Pasa la puerta del plan. Lo que devuelve después es otra cosa —un
     * ingreso sin líneas es inválido— y eso es exactamente lo que se quiere
     * ver: que el 402 ya no aparece.
     */
    chk('el ingreso pasa la puerta del plan', true, ingreso2.status !== 402);

    // ─────────────────────────────────────────────────────────────
    tit('5. LA FOTO NO SE SACA DOS VECES');
    /*
     * `featuresHeredadas` en cadena vacía significa "ya lo miramos y no usaba
     * nada". Si el arranque volviera a mirarlo, el que usó la función una vez
     * después del corte se la reabriría solo.
     */
    await negocio.update({ featuresHeredadas: '' });
    chk('con la foto vacía, no hereda', false, await planService.tieneFeature(negocio.id, 'deposito'));
    chk('y la foto vacía no es lo mismo que no tener foto', '',
      (await Business.findByPk(negocio.id)).featuresHeredadas);

    // ─────────────────────────────────────────────────────────────
    tit('6. EL TOPE DE LOCALES, QUE NUNCA SE CONTROLABA');
    /*
     * `maxLocales` se medía y se mostraba en la pantalla de suscripción, pero
     * ninguna ruta lo exigía: un plan de dos locales podía crear veinte. Era
     * el único de los cinco topes en ese estado.
     */
    const uso = await planService.usoDe(negocio.id);
    chk('el inicial tope 2 locales', 2, uso.locales.tope);
    chk('y el negocio ya tiene más', true, uso.locales.usado > uso.locales.tope);

    const nuevo = await api('POST', '/api/locations', {
      nombre: 'QA Plan Local', direccion: 'QA 123', tipo: 'local',
    });
    if (nuevo.json?.id) creados.push(nuevo.json.id);
    chk('crear otro local se frena', 409, nuevo.status);
    chk('diciendo cuál es el tope', true, /hasta 2 locales/.test(nuevo.json?.message || ''));

    // Con el plan que sí tiene lugar, entra.
    await sub.update({ planId: pro.id });
    const usoPro = await planService.usoDe(negocio.id);
    chk('el pro tope 4 locales', 4, usoPro.locales.tope);

    // ─────────────────────────────────────────────────────────────
    tit('7. EL PLAN NO PISA LOS PERMISOS');
    /*
     * Son dos controles distintos y tienen que seguir siéndolo: el plan dice
     * qué compró el negocio, el permiso dice qué puede hacer esa persona.
     * Tener la feature no le da permiso a nadie.
     */
    chk('el pro tiene depósito', true, await planService.tieneFeature(negocio.id, 'deposito'));
    const sinPermiso = await api('POST', '/api/deposito/ingresos/999999/aceptar');
    chk('pero la ruta sigue pidiendo su permiso', true, [403, 404].includes(sinPermiso.status));
  } finally {
    tit('Limpieza');
    await sub.update({ planId: planOriginal });
    await negocio.update({ featuresHeredadas: heredadasOriginales });
    for (const id of creados) await BusinessLocation.destroy({ where: { id } });
    await BusinessLocation.destroy({ where: { businessId: negocio.id, nombre: 'QA Plan Local' } });

    const vuelto = await Business.findByPk(negocio.id);
    chk('la foto quedó como estaba', heredadasOriginales, vuelto.featuresHeredadas);
    const s2 = await Subscription.findByPk(sub.id);
    chk('y el plan también', planOriginal, s2.planId);
  }

  console.log(`\n\x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
