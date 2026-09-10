/*
 * La renovación del token de Mercado Libre, bajo carga.
 *
 * El refresh_token de ML es de UN SOLO USO: al canjearlo, el anterior muere.
 * Y las renovaciones nunca llegan de a una. El token dura seis horas, y lo que
 * despierta al sistema cuando vence suele ser una ráfaga de notificaciones
 * —ML manda hasta ocho por venta— que entran en paralelo como pedidos HTTP
 * distintos. Si cada una canjea por su cuenta, gana una y las demás reciben
 * `invalid_grant`: la cuenta queda perfectamente conectada pero el cliente ve
 * "Reconectá la cuenta" y rehace una autorización que no hacía falta.
 *
 * Lo que se comprueba acá:
 *
 *   · Con el token vigente no se sale a la red.
 *   · Ocho llamadas en paralelo sobre un token vencido hacen UN solo canje.
 *   · El refresh_token nuevo se guarda (si no, el próximo canje falla).
 *   · Si el canje falla pero la cuenta ya quedó renovada por otro lado —dos
 *     instancias del backend—, se usa ese token en vez de dar la cuenta por
 *     caída.
 *   · Una falla de verdad sí avisa, y deja el motivo escrito.
 *
 * Se prueba contra una API simulada: el canje real quema el refresh_token de
 * la cuenta conectada del usuario.
 *
 * Uso:  node scripts/test-ml-token.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const Module = require('module');

let canjes = 0;                 // cuántas veces se llamó a /oauth/token
let modo = 'ok';                // 'ok' | 'falla' | 'carrera'
let alCanjear = null;           // gancho para simular a la otra instancia
let serie = 0;

const originalLoad = Module._load;
Module._load = function (pedido) {
  if (pedido === 'axios') {
    const responder = async (metodo, url, cfg, cuerpo) => {
      if (url.includes('/oauth/token')) {
        canjes += 1;
        // Latencia: sin ella todo se resuelve en el mismo tick y ocho llamadas
        // "en paralelo" no se pisarían nunca, así que la prueba no probaría nada.
        await new Promise((r) => setTimeout(r, 20));
        if (alCanjear) await alCanjear();
        if (modo === 'falla' || modo === 'carrera') {
          const e = new Error('invalid_grant');
          e.response = { status: 400, data: { message: 'invalid_grant' } };
          throw e;
        }
        serie += 1;
        return { data: {
          access_token:  `ACCESO-${serie}`,
          refresh_token: `REFRESCO-${serie}`,
          expires_in:    21600,
        } };
      }
      return { data: {} };
    };
    const cliente = {
      get:  (url, cfg) => responder('get', url, cfg),
      put:  (url, cuerpo, cfg) => responder('put', url, cfg, cuerpo),
      post: (url, cuerpo, cfg) => responder('post', url, cfg, cuerpo),
      create: () => cliente,
    };
    return cliente;
  }
  return originalLoad.apply(this, arguments);
};

const { Business, MercadoLibreAccount } = require('../src/models');
const ml = require('../src/services/mercadolibreService');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const ML_USER = '888000999';

(async () => {
  process.env.ML_CLIENT_ID = process.env.ML_CLIENT_ID || 'qa-client';
  process.env.ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET || 'qa-secret';

  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  if (!negocio) { console.log('Falta el negocio demo.'); process.exit(1); }

  const limpiar = () => MercadoLibreAccount.destroy({ where: { mlUserId: ML_USER } });
  await limpiar();

  // Deja la cuenta en un estado conocido y devuelve una instancia fresca.
  const cuentaCon = async (campos) => {
    await limpiar();
    return MercadoLibreAccount.create({
      businessId: negocio.id, mlUserId: ML_USER, nickname: 'QA TOKEN',
      accessToken: 'VIEJO', refreshToken: 'REFRESCO-0', ...campos,
    });
  };

  try {
    tit('1. CON EL TOKEN VIGENTE NO SE SALE A LA RED');
    canjes = 0; modo = 'ok';
    let cuenta = await cuentaCon({ tokenExpiraEn: new Date(Date.now() + 6 * 60 * 60 * 1000) });
    const vigente = await ml.tokenValido(cuenta);
    chk('devuelve el que ya tenía', 'VIEJO', vigente);
    chk('sin pedirle nada a ML',    0,       canjes);

    tit('2. OCHO EN PARALELO SOBRE UN TOKEN VENCIDO = UN SOLO CANJE');
    /*
     * Es el caso real: el token vence y entra la ráfaga de notificaciones.
     * Sin candado, acá se veían ocho canjes y siete `invalid_grant`.
     */
    canjes = 0; modo = 'ok'; serie = 0;
    cuenta = await cuentaCon({ tokenExpiraEn: new Date(Date.now() - 1000) });
    const enParalelo = await Promise.all(
      Array.from({ length: 8 }, () => ml.tokenValido(cuenta)),
    );
    chk('un solo canje para las ocho', 1, canjes);
    chk('las ocho reciben el mismo token', 1, new Set(enParalelo).size);
    chk('y es el que devolvió ML', 'ACCESO-1', enParalelo[0]);

    await cuenta.reload();
    chk('el refresh_token nuevo quedó guardado', 'REFRESCO-1', cuenta.refreshToken);
    chk('y el error anterior se limpió', null, cuenta.ultimoError);

    tit('3. DOS INSTANCIAS: SI OTRO YA RENOVÓ, NO ES UNA DESCONEXIÓN');
    /*
     * El candado es por proceso. Con dos instancias del backend las dos pueden
     * canjear el mismo refresh_token y una va a fallar, aunque la cuenta haya
     * quedado conectada. Se simula que "la otra instancia" deja la fila
     * renovada justo antes de que a ésta le rebote el canje.
     */
    canjes = 0; modo = 'carrera';
    cuenta = await cuentaCon({ tokenExpiraEn: new Date(Date.now() - 1000) });
    alCanjear = async () => {
      await MercadoLibreAccount.update(
        { accessToken: 'ACCESO-DE-LA-OTRA', refreshToken: 'REFRESCO-DE-LA-OTRA',
          tokenExpiraEn: new Date(Date.now() + 6 * 60 * 60 * 1000) },
        { where: { id: cuenta.id } },
      );
    };
    const enCarrera = await ml.tokenValido(cuenta).catch((e) => `LANZÓ: ${e.message}`);
    alCanjear = null;
    chk('usa el token que dejó la otra instancia', 'ACCESO-DE-LA-OTRA', enCarrera);
    await cuenta.reload();
    chk('y no marca la cuenta como caída', null, cuenta.ultimoError);

    tit('4. UNA FALLA DE VERDAD SÍ AVISA');
    canjes = 0; modo = 'falla';
    cuenta = await cuentaCon({ tokenExpiraEn: new Date(Date.now() - 1000) });
    const falla = await ml.tokenValido(cuenta).then(() => 'NO LANZÓ').catch((e) => e.message);
    chk('avisa que hay que reconectar', true, /Reconectá la cuenta/.test(falla));
    await cuenta.reload();
    chk('y deja el motivo escrito', true, /invalid_grant/.test(cuenta.ultimoError || ''));

    tit('5. SIN REFRESH TOKEN NO HAY NADA QUE RENOVAR');
    canjes = 0; modo = 'ok';
    cuenta = await cuentaCon({ tokenExpiraEn: new Date(Date.now() - 1000), refreshToken: null });
    const sinRefresh = await ml.tokenValido(cuenta).then(() => 'NO LANZÓ').catch((e) => e.message);
    chk('lo dice claro', true, /no está conectada/.test(sinRefresh));
    chk('sin salir a la red', 0, canjes);

  } finally {
    tit('Limpieza');
    await limpiar();
    chk('no queda la cuenta de prueba', 0, await MercadoLibreAccount.count({ where: { mlUserId: ML_USER } }));
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
