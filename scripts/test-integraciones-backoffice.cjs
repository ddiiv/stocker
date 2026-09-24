/*
 * Las credenciales de integración, desde el backoffice.
 *
 * Las emite el equipo de Stocker al conectar el puente de un cliente, no el
 * cliente. Lo que se prueba es lo que duele si sale mal:
 *
 *   · Que la puerta esté cerrada. Estas rutas emiten credenciales que escriben
 *     ventas en la cuenta de un negocio: abiertas serían la llave del sistema.
 *   · Que el token se muestre UNA vez y no quede legible en ningún listado.
 *   · Que emitir apague la anterior Y lo diga: hacerlo sin querer deja al
 *     portal del cliente sin poder mandar pedidos, y sin el aviso nadie
 *     relaciona una cosa con la otra.
 *
 * Las funciones se llaman directo, con un req y un res de mentira: probar por
 * HTTP pediría la contraseña del admin de la plataforma, que no se escribe en
 * ningún lado. La puerta sí se prueba por HTTP, que es donde vive.
 *
 * Uso:  API=http://localhost:3000 node scripts/test-integraciones-backoffice.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const API = process.env.API || 'http://localhost:3000';
const { Op } = require('sequelize');
const { Business, IntegracionExterna, SolicitudMayorista } = require('../src/models');
const backoffice = require('../src/controllers/backofficeController');
const integraciones = require('../src/services/integracionesService');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/* Un req/res de mentira: la función contesta una vez y se devuelve lo que dijo. */
function llamar(handler, { body = {}, params = {}, query = {} } = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, payload }); },
    };
    Promise.resolve(handler({ body, params, query }, res, reject)).catch(reject);
  });
}

(async () => {
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } })
    || await Business.findOne({ order: [['id', 'ASC']] });

  const limpiar = () => IntegracionExterna.destroy({ where: { nombre: { [Op.like]: 'QA BO%' } } });
  await limpiar();

  try {
    tit('1. LA PUERTA');
    /*
     * Estas rutas emiten credenciales que escriben ventas y cuenta corriente en
     * la cuenta de un negocio. Sin sesión de admin no pueden contestar nada.
     */
    const sinSesion = async (metodo, ruta) => (await fetch(`${API}/api${ruta}`, {
      method: metodo, headers: { 'Content-Type': 'application/json' }, body: metodo === 'GET' ? undefined : '{}',
    })).status;
    chk('listar, sin sesión de admin', 401, await sinSesion('GET', '/backoffice/integraciones'));
    chk('emitir, sin sesión de admin', 401, await sinSesion('POST', '/backoffice/integraciones'));
    chk('revocar, sin sesión de admin', 401, await sinSesion('DELETE', '/backoffice/integraciones/1'));

    tit('2. EMITIR');
    const primera = await llamar(backoffice.emitirIntegracion, {
      body: { businessId: negocio.id, origen: 'isuwaya', nombre: 'QA BO uno' },
    });
    chk('se emite y el token viaja una vez', [201, true],
      [primera.status, typeof primera.payload.token === 'string' && primera.payload.token.length > 20]);
    chk('la primera no reemplaza a nadie', null, primera.payload.reemplaza);
    chk('viene con el negocio, para no equivocarse de cliente', negocio.id,
      primera.payload.integracion.negocio.id);
    chk('el token sirve de verdad', negocio.id,
      (await integraciones.verificar(primera.payload.token))?.businessId);

    const segunda = await llamar(backoffice.emitirIntegracion, {
      body: { businessId: negocio.id, origen: 'isuwaya', nombre: 'QA BO dos' },
    });
    /*
     * Emitir apaga la anterior. Que la respuesta lo diga es la diferencia entre
     * "el portal dejó de andar y nadie sabe por qué" y "lo apagamos nosotros".
     */
    chk('emitir de nuevo avisa a quién reemplaza', primera.payload.integracion.pista,
      segunda.payload.reemplaza?.pista);
    chk('y la anterior deja de servir', null, await integraciones.verificar(primera.payload.token));
    chk('la nueva sirve', negocio.id, (await integraciones.verificar(segunda.payload.token))?.businessId);

    tit('3. EL LISTADO NO PUEDE FILTRAR EL TOKEN');
    const lista = await llamar(backoffice.listarIntegraciones, {});
    const mia = (lista.payload.integraciones || []).find((x) => x.nombre === 'QA BO dos');
    chk('la credencial aparece con su negocio', [true, negocio.id], [Boolean(mia), mia?.negocio?.id]);
    chk('con la pista, que son seis caracteres', 6, (mia?.pista || '').length);
    /*
     * Ni el token ni su hash: con el hash, una captura de pantalla del panel
     * alcanza para quedarse con la llave si alguna vez el hash dejara de serlo.
     */
    const comoTexto = JSON.stringify(lista.payload);
    chk('el token no está en el listado', false, comoTexto.includes(segunda.payload.token));
    chk('ni el hash', false, comoTexto.includes(integraciones.__hash(segunda.payload.token)));

    chk('dice cuántos pedidos de ese negocio esperan revisión',
      await SolicitudMayorista.count({ where: { businessId: negocio.id, estado: 'pendiente' } }),
      mia?.pedidosPorRevisar);

    tit('4. REVOCAR');
    const revocada = await llamar(backoffice.revocarIntegracion, {
      params: { id: segunda.payload.integracion.id },
    });
    chk('se corta el puente', [200, true], [revocada.status, revocada.payload.ok]);
    chk('y el token deja de entrar', null, await integraciones.verificar(segunda.payload.token));
    chk('la fila queda, apagada: sirve para saber qué hubo', false,
      (await IntegracionExterna.findByPk(segunda.payload.integracion.id)).activa);

    tit('5. LO QUE NO SE PUEDE');
    const sinNegocio = await llamar(backoffice.emitirIntegracion, { body: {} }).catch((e) => e);
    chk('emitir sin decir para quién', 400, sinNegocio.status);
    const inexistente = await llamar(backoffice.emitirIntegracion, {
      body: { businessId: 999999, origen: 'isuwaya' },
    }).catch((e) => e);
    chk('emitir para un negocio que no existe', 404, inexistente.status);
    const origenRaro = await llamar(backoffice.emitirIntegracion, {
      body: { businessId: negocio.id, origen: 'lo-que-sea', nombre: 'QA BO tres' },
    }).catch((e) => e);
    chk('emitir para un origen que no existe', 400, origenRaro.status);
    const revocarFantasma = await llamar(backoffice.revocarIntegracion, {
      params: { id: 999999 },
    }).catch((e) => e);
    chk('revocar algo que no existe', 404, revocarFantasma.status);
  } finally {
    tit('Limpieza');
    await limpiar();
    chk('no queda nada de la prueba', 0,
      await IntegracionExterna.count({ where: { nombre: { [Op.like]: 'QA BO%' } } }));
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
