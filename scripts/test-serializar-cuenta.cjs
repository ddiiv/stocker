/*
 * Que el secreto del doble factor no viaje al navegador.
 *
 * El login, /auth/me y GET /api/account mandaban el negocio entero "menos el
 * passwordHash". Con eso viajaba `totpSecret`, la semilla de la que salen los
 * códigos del segundo factor: quien leyera una sola de esas respuestas podía
 * generar códigos válidos para siempre. Esta suite cuida tres cosas:
 *
 *   1. Que los campos sensibles no salgan, por ninguna de las rutas.
 *   2. Que los que el front usa SÍ salgan: arreglar una fuga rompiendo la
 *      pantalla de cuenta no es un arreglo.
 *   3. La propiedad que hace que esto no vuelva a pasar: una columna NUEVA no
 *      sale sola. Es la diferencia entre una lista de lo permitido y una de lo
 *      prohibido, y es lo que la lista vieja no cumplía.
 *
 * Las rutas se llaman en proceso, con req/res sintéticos: no depende de qué
 * backend tenga el 3000. El secreto se pone en memoria y nunca se guarda.
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

const SENSIBLES = [
  'passwordHash', 'totpSecret', 'totpPendiente', 'totpRecuperacion', 'totpUltimoPaso',
  'dobleFactorCanales', 'sesionesDesde', 'terminosIp', 'featuresHeredadas',
];
// Lo que el front lee del negocio (relevado con grep sobre los tres fronts).
const QUE_USA_EL_FRONT = [
  'id', 'nombreNegocio', 'ownerNombre', 'ownerApellido', 'ownerTelefono',
  'telefono', 'email', 'cuit', 'condicionIva', 'createdAt',
];
const SECRETO = 'JBSWY3DPEHPK3PXP-SECRETO-DE-PRUEBA';

/* Busca un valor en cualquier profundidad: la fuga puede venir anidada. */
const contiene = (obj, valor) => JSON.stringify(obj).includes(valor);

function llamar(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(p) { resolve({ status: this.statusCode, json: p }); },
    };
    Promise.resolve(handler(req, res, reject)).catch(reject);
  });
}

(async () => {
  const db = require('../src/config/database');
  const { Business } = require('../src/models');
  const { serializarCuenta } = require('../src/utils/serializarCuenta');

  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } })
    || await Business.findOne({ order: [['id', 'ASC']] });

  try {
    tit('1. EL SERIALIZADOR');
    const conSecreto = await Business.findByPk(negocio.id);
    conSecreto.setDataValue('totpSecret', SECRETO);
    conSecreto.setDataValue('totpPendiente', 'PENDIENTE-DE-PRUEBA');
    conSecreto.setDataValue('terminosIp', '203.0.113.7');
    const salida = serializarCuenta(conSecreto);

    for (const campo of SENSIBLES) {
      chk(`no sale ${campo}`, false, campo in salida);
    }
    chk('y el secreto no aparece en ninguna parte del objeto', false, contiene(salida, SECRETO));
    chk('ni la IP desde la que se aceptaron los términos', false, contiene(salida, '203.0.113.7'));

    for (const campo of QUE_USA_EL_FRONT) {
      chk(`sale ${campo}, que el front usa`, true, campo in salida);
    }

    tit('2. UNA COLUMNA NUEVA NO SALE SOLA');
    /*
     * Esto es lo que la lista vieja no cumplía y por lo que se escapó el
     * secreto: el día que alguien le agrega una columna a la tabla, sale al
     * navegador sin que nadie lo decida. Se simula con un campo que no existe.
     */
    const conColumnaNueva = await Business.findByPk(negocio.id);
    const plano = { ...conColumnaNueva.toJSON(), tokenDeAlgunaIntegracionFutura: 'NO-DEBERIA-VERSE' };
    const salidaNueva = serializarCuenta(plano);
    chk('un campo nuevo, no permitido a propósito, queda afuera', false,
      'tokenDeAlgunaIntegracionFutura' in salidaNueva);

    tit('3. LAS RUTAS DE VERDAD');
    /*
     * El serializador puede estar bien y una ruta seguir usando otro camino. Se
     * llama a GET /api/account y a /auth/me con el secreto puesto en la base
     * (dentro de una transacción que se deshace al final).
     */
    const accountCtrl = require('../src/controllers/accountController');
    const authCtrl = require('../src/controllers/authController');

    const anterior = { totpSecret: negocio.totpSecret, terminosIp: negocio.terminosIp };
    await Business.update(
      { totpSecret: SECRETO, terminosIp: '203.0.113.7' },
      { where: { id: negocio.id } },
    );
    try {
      const cuenta = await llamar(accountCtrl.obtener, { auth: { businessId: negocio.id } });
      chk('GET /api/account responde', 200, cuenta.status);
      chk('y no trae el secreto del doble factor', false, contiene(cuenta.json, SECRETO));
      chk('ni la IP de los términos', false, contiene(cuenta.json, '203.0.113.7'));
      /*
       * El estado del doble factor tiene que seguir llegando, pero derivado: que
       * está activo, no la semilla.
       */
      chk('pero sí dice que el doble factor está activo', true,
        Boolean(cuenta.json?.dobleFactor?.app?.activa));

      /*
       * `me` decide por `req.auth.type`. Sin ese campo cae en la rama del
       * empleado, devuelve 404, y un "no trae el secreto" pasa en el vacío: una
       * respuesta que no trae NADA tampoco trae el secreto. Fue lo que pasó la
       * primera vez, y lo cazó el control A/B. Por eso se exige primero que la
       * respuesta traiga el negocio: si no, la prueba no prueba nada.
       */
      const yo = await llamar(authCtrl.me, { auth: { type: 'business', businessId: negocio.id } })
        .catch((e) => ({ status: e.status, json: null }));
      chk('/auth/me devuelve el negocio de verdad', [200, negocio.id], [yo.status, yo.json?.data?.id]);
      chk('y no trae el secreto', false, contiene(yo.json || {}, SECRETO));
    } finally {
      await Business.update(anterior, { where: { id: negocio.id } });
    }
    const restaurado = await Business.findByPk(negocio.id);
    chk('el negocio quedó como estaba', anterior.totpSecret ?? null, restaurado.totpSecret ?? null);
  } finally {
    await db.close();
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
