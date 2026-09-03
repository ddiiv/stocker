/*
 * Un CUIT, un cliente.
 *
 * El CUIT identifica a una persona ante ARCA: dos fichas con el mismo son la
 * misma persona cargada dos veces, y eso se paga después —la cuenta corriente
 * repartida entre las dos, el histórico de compras partido al medio, y dos
 * domicilios distintos para la misma factura.
 *
 * Y la otra mitad: cuando la venta tiene un cliente asociado, la factura sale
 * con SUS datos. Antes el cuerpo del pedido los pisaba, y eso no es prolijidad:
 * es un comprobante fiscal emitido a nombre de un CUIT que no compró.
 *
 * Uso:  API=http://localhost:3000 node scripts/test-clientes-cuit.cjs
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const { Op } = require('sequelize');
const API = process.env.API || 'http://localhost:3000';
const { Business, Client } = require('../src/models');

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

// Dos CUIT válidos de verdad: el controlador valida el dígito verificador antes
// de mirar si está repetido, así que uno inventado nunca llegaría a la prueba.
const CUIT_A = '20111111112';
const CUIT_B = '27222222228';

(async () => {
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  const otro = await Business.findOne({ where: { id: { [Op.ne]: negocio.id } } });

  const limpiar = () => Client.destroy({
    where: { cuit: { [Op.in]: [CUIT_A, CUIT_B, '20-11111111-2'] } },
  });
  await limpiar();

  const api = sesion();
  const entro = await api('POST', '/api/auth/login', { email: negocio.email, password: 'Demo2026!!' });
  if (entro.status !== 200) { console.log('No se pudo entrar:', entro.status); process.exit(1); }

  const creados = [];
  const crear = async (datos) => {
    const r = await api('POST', '/api/clients', datos);
    if (r.json?.id) creados.push(r.json.id);
    return r;
  };

  try {
    tit('1. EL MISMO CUIT NO SE CARGA DOS VECES');
    const primero = await crear({ nombre: 'QA', apellido: 'Primero', cuit: CUIT_A });
    chk('el primero entra', 201, primero.status);

    const segundo = await crear({ nombre: 'QA', apellido: 'Segundo', cuit: CUIT_A });
    chk('el segundo se rechaza', 409, segundo.status);
    chk('con su código', 'CUIT_REPETIDO', segundo.json?.codigo);
    chk('nombrando al que ya estaba', true, /QA Primero/.test(segundo.json?.message || ''));
    chk('y devolviendo su id, para poder elegirlo', primero.json.id, segundo.json?.clienteId);

    tit('2. CON GUIONES ES EL MISMO CUIT');
    /*
     * "20-11111111-2" y "20111111112" son el mismo número. Comparando como
     * texto pasaban como dos, y el duplicado entraba igual: el chequeo tiene
     * que normalizar los dos lados.
     */
    const conGuiones = await crear({ nombre: 'QA', apellido: 'Guiones', cuit: '20-11111111-2' });
    chk('escrito con guiones también se rechaza', 409, conGuiones.status);

    tit('3. SIN CUIT NO HAY DUPLICADO QUE BUSCAR');
    // Hay clientes de mostrador sin CUIT: dos de esos no son la misma persona.
    const sinCuit1 = await crear({ nombre: 'QA', apellido: 'Sin CUIT uno' });
    const sinCuit2 = await crear({ nombre: 'QA', apellido: 'Sin CUIT dos' });
    chk('dos clientes sin CUIT entran los dos', [201, 201], [sinCuit1.status, sinCuit2.status]);

    tit('4. EDITAR NO CHOCA CONTRA UNO MISMO');
    /*
     * Guardar una ficha sin tocarle el CUIT tiene que poder hacerse. Sin
     * excluirse a sí mismo, editar el teléfono de un cliente con CUIT era
     * imposible: chocaba contra su propio CUIT.
     */
    const propio = await api('PUT', `/api/clients/${primero.json.id}`, {
      cuit: CUIT_A, telefono: '1122334455',
    });
    chk('editarse a sí mismo con su CUIT anda', 200, propio.status);

    const otroCliente = await crear({ nombre: 'QA', apellido: 'Otro', cuit: CUIT_B });
    chk('un cliente con otro CUIT entra', 201, otroCliente.status);
    const robar = await api('PUT', `/api/clients/${otroCliente.json.id}`, { cuit: CUIT_A });
    chk('pero no puede tomar el CUIT de otro', 409, robar.status);

    tit('5. EL AVISO EN VIVO, ANTES DE TERMINAR LA FICHA');
    const consulta = await api('GET', `/api/clients/por-cuit?cuit=${CUIT_A}`);
    chk('avisa que existe', true, consulta.json?.existe);
    chk('y dice cuál es', primero.json.id, consulta.json?.cliente?.id);

    const libre = await api('GET', '/api/clients/por-cuit?cuit=20333333334');
    chk('uno libre contesta que no', false, libre.json?.existe);

    /*
     * Se llama con cada tecla: un CUIT a medio escribir no puede ser un error,
     * o la pantalla se llenaría de rojo mientras la persona tipea.
     */
    const aMedias = await api('GET', '/api/clients/por-cuit?cuit=2011');
    chk('a medio escribir contesta que no, sin error', [200, false],
      [aMedias.status, aMedias.json?.existe]);
    const vacio = await api('GET', '/api/clients/por-cuit?cuit=');
    chk('y vacío tampoco rompe', 200, vacio.status);

    tit('6. EL CUIT DE OTRO NEGOCIO NO ES UN DUPLICADO');
    /*
     * Dos negocios distintos pueden tener al mismo cliente. Y además: saber si
     * un CUIT existe en otro negocio no es algo que se pueda contestar desde
     * acá, ni que a nadie le importe.
     */
    if (otro) {
      const ajeno = await Client.create({
        businessId: otro.id, nombre: 'QA', apellido: 'De otro negocio', cuit: '30111111118',
      });
      const igual = await crear({ nombre: 'QA', apellido: 'Mismo CUIT otro negocio', cuit: '30111111118' });
      chk('el mismo CUIT en otro negocio no molesta', 201, igual.status);
      await ajeno.destroy();
    } else {
      console.log('  (no hay otro negocio cargado: se saltea)');
    }

    tit('7. UN CUIT INVÁLIDO SE FRENA ANTES');
    const malo = await crear({ nombre: 'QA', apellido: 'Malo', cuit: '20111111113' });
    chk('el dígito verificador se comprueba primero', 400, malo.status);
    chk('y se explica', true, /verificador/i.test(malo.json?.message || ''));

  } finally {
    tit('Limpieza');
    await Client.destroy({ where: { id: creados } });
    await limpiar();
    chk('no quedan clientes de prueba', 0,
      await Client.count({ where: { cuit: { [Op.in]: [CUIT_A, CUIT_B] } } }));
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
