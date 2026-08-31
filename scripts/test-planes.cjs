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
const { FEATURES, CATALOGO_FEATURES, PLANES } = require('../src/config/planes');
const backoffice = require('../src/controllers/backofficeController');

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
    return { status: r.status, json, cacheControl: r.headers.get('cache-control') || '' };
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

    // ─────────────────────────────────────────────────────────────
    tit('8. EL CATÁLOGO NO SE DESINCRONIZA');
    /*
     * Ésta es la prueba que evita que el defecto vuelva.
     *
     * La lista de funciones estaba escrita a mano en tres pantallas —el
     * backoffice, la suscripción del cliente y la landing— y cuando el backend
     * pasó de nueve a doce, ninguna se enteró. El backoffice mostraba nueve y
     * no tenía casilla para tildar las tres nuevas: un operador no podía ni
     * ver ni cambiar un tercio de lo que vende.
     *
     * Ahora las pantallas piden el catálogo. Lo único que hay que garantizar
     * es que el catálogo cubra exactamente las claves que existen.
     */
    const claves = Object.values(FEATURES).sort();
    const delCatalogo = CATALOGO_FEATURES.map((f) => f.clave).sort();
    chk('el catálogo cubre todas las funciones', claves, delCatalogo);
    chk('todas tienen nombre visible', 0, CATALOGO_FEATURES.filter((f) => !f.label).length);
    chk('y todas explican qué hacen', 0, CATALOGO_FEATURES.filter((f) => !f.ayuda).length);
    chk('sin claves repetidas', CATALOGO_FEATURES.length, new Set(delCatalogo).size);

    const publico = await api('GET', '/api/billing/features');
    chk('el catálogo se sirve por HTTP', 200, publico.status);
    chk('con las doce', CATALOGO_FEATURES.length, publico.json?.length);

    // ─────────────────────────────────────────────────────────────
    tit('9. GUARDAR UN PLAN NO BORRA LO QUE NO NOMBRA');
    /*
     * Antes esto era `patch.features = req.body.features` sin mirar nada: un
     * cuerpo parcial borraba en silencio todo lo que no nombrara. Es
     * exactamente lo que iba a pasar con las tres funciones nuevas el día que
     * alguien guardara desde la pantalla vieja.
     */
    const llamar = async (codigo, body) => {
      let salida = { status: 200, json: null };
      const res = {
        status(c) { salida.status = c; return this; },
        json(j) { salida.json = j; return this; },
      };
      await backoffice.editarPlan(
        { admin: { id: 0, rol: 'owner' }, params: { codigo }, body },
        res,
        (e) => { throw e; },
      );
      return salida;
    };

    const proAntes = await Plan.findOne({ where: { codigo: 'pro' } });
    const featuresAntes = typeof proAntes.features === 'string'
      ? JSON.parse(proAntes.features || '{}') : { ...proAntes.features };
    const editadoAntes = proAntes.editadoEn;

    await llamar('pro', { features: { api: true } });
    const proDespues = await Plan.findOne({ where: { codigo: 'pro' } });
    const featuresDespues = typeof proDespues.features === 'string'
      ? JSON.parse(proDespues.features || '{}') : proDespues.features;

    chk('la función nombrada cambia', true, featuresDespues.api);
    chk('eventos sigue estando', true, featuresDespues.eventos);
    chk('depósito también', true, featuresDespues.deposito);
    chk('y reposición', true, featuresDespues.reposicion);

    // ─────────────────────────────────────────────────────────────
    tit('10. UNA FUNCIÓN QUE NO EXISTE SE RECHAZA');
    /*
     * Una clave mal escrita entraba y quedaba para siempre: un plan que dice
     * tener algo que ninguna ruta mira. Se ve recién cuando un cliente
     * reclama por una función que compró y no aparece.
     */
    const inventada = await llamar('pro', { features: { superPoderes: true } });
    chk('se rechaza', 400, inventada.status);
    chk('diciendo cuál', ['superPoderes'], inventada.json?.desconocidas);

    const noObjeto = await llamar('pro', { features: ['facturacion'] });
    chk('un array tampoco pasa', 400, noObjeto.status);

    // ─────────────────────────────────────────────────────────────
    tit('11. LOS CINCO TOPES SE PUEDEN EDITAR');
    /*
     * maxSkus y maxComprobantes no estaban en el bucle del controlador: la
     * pantalla los ofrecía, el operador los cambiaba, veía "actualizado" y no
     * pasaba nada. Silencioso, que es la peor forma de fallar.
     */
    const skusAntes = proDespues.maxSkus;
    const compAntes = proDespues.maxComprobantes;
    await llamar('pro', { maxSkus: 12345, maxComprobantes: 6789 });
    const conTopes = await Plan.findOne({ where: { codigo: 'pro' } });
    chk('maxSkus se guarda', 12345, conTopes.maxSkus);
    chk('maxComprobantes también', 6789, conTopes.maxComprobantes);

    // Se deja el plan como estaba, incluido el sello de "editado a mano".
    await conTopes.update({
      features: featuresAntes, maxSkus: skusAntes,
      maxComprobantes: compAntes, editadoEn: editadoAntes,
    });
    const restaurado = await Plan.findOne({ where: { codigo: 'pro' } });
    chk('el plan queda como estaba', skusAntes, restaurado.maxSkus);
    chk('sin quedar marcado como tocado a mano', editadoAntes, restaurado.editadoEn);


    // ─────────────────────────────────────────────────────────────
    tit('12. LO QUE SE EDITA EN EL BACKOFFICE LLEGA A LA PÁGINA PÚBLICA');
    /*
     * La landing tenía los precios y los topes sincronizados, pero las
     * funciones escritas a mano en el HTML. El día que Eventos, Depósito y
     * Reposición entraron al catálogo hubo que editar esa página aparte, y
     * hasta que alguien se acordara vendía algo distinto de lo que el sistema
     * daba.
     *
     * Esto comprueba el circuito entero: se edita por donde edita el
     * backoffice y se lee por donde lee la página.
     */
    const publico1 = await api('GET', '/api/public/landing');
    chk('la página pública responde', 200, publico1.status);
    chk('y trae el catálogo de funciones con su nombre', true,
      Array.isArray(publico1.json?.features) && publico1.json.features.length === CATALOGO_FEATURES.length);

    const proPublico = (publico1.json?.planes || []).find((x) => x.codigo === 'pro');
    chk('cada plan viaja con sus funciones', true, Boolean(proPublico?.features));
    chk('el Pro sale con Mercado Libre', true, proPublico.features.ecommerce);

    // Se edita por el mismo camino que usa el backoffice.
    const proParaLanding = await Plan.findOne({ where: { codigo: 'pro' } });
    const featuresParaLanding = typeof proParaLanding.features === 'string'
      ? JSON.parse(proParaLanding.features || '{}') : { ...proParaLanding.features };
    const precioParaLanding = proParaLanding.precioMensual;
    const editadoParaLanding = proParaLanding.editadoEn;

    await llamar('pro', { features: { ecommerce: false }, precioMensual: 123456 });

    const publico2 = await api('GET', '/api/public/landing');
    const proTrasEditar = (publico2.json?.planes || []).find((x) => x.codigo === 'pro');
    chk('apagar una función se ve en la página', false, proTrasEditar.features.ecommerce);
    chk('y cambiar el precio también', 123456, proTrasEditar.precioMensual);
    chk('sin tocar las demás funciones', true, proTrasEditar.features.deposito);

    /*
     * La respuesta NO puede quedar cacheada por un intermediario: si el proxy
     * de Railway o un CDN se la guardan, un cambio del backoffice deja de
     * verse y no hay forma de saber por qué.
     */
    chk('y la respuesta se revalida siempre', true, /no-cache/.test(publico2.cacheControl));

    /*
     * Se restaura con un UPDATE por `where`, no sobre la instancia.
     *
     * `proParaLanding` se leyó ANTES de editar, así que en memoria ya tiene los
     * valores originales: pedirle que se actualice a lo que cree que ya es no
     * genera ninguna escritura, y el plan quedaba editado. La prueba se caía
     * en su propia limpieza y dejaba el catálogo tocado.
     */
    await Plan.update(
      { features: featuresParaLanding, precioMensual: precioParaLanding, editadoEn: editadoParaLanding },
      { where: { codigo: 'pro' } },
    );
    const proRestaurado = (await api('GET', '/api/public/landing')).json.planes.find((x) => x.codigo === 'pro');
    chk('el plan queda como estaba', [true, Number(precioParaLanding)],
      [proRestaurado.features.ecommerce, proRestaurado.precioMensual]);
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
