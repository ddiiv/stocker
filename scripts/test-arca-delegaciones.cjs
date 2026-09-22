/*
 * Las delegaciones de ARCA se detectan solas.
 *
 * El trámite de AFIP tiene tres pasos y ninguno tiene API: el cliente delega,
 * Stocker acepta la designación y le asigna el certificado. Lo que sí se puede
 * leer es el resultado: el TA del WSAA trae la lista de CUIT que nuestro
 * certificado puede representar, y esa lista sólo se completa con los tres
 * pasos hechos.
 *
 * Lo que se prueba acá es esa lectura y lo que Stocker hace con ella: activar
 * al que ya está, y —sobre todo— darse cuenta de una revocación, que AFIP no
 * avisa de ninguna forma.
 */

const { Op } = require('sequelize');
const { Business, BusinessCuit, BusinessArcaConfig } = require('../src/models');
const cli = require('../src/services/arcaClient');
const arca = require('../src/services/arcaService');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const tokenCon = (cuits) => Buffer.from(
  `<?xml version="1.0"?><login entity="1" service="wsfe" uid="SERIALNUMBER=CUIT 30111111118">`
  + `<relations>${cuits.map((c) => `<relation key="${c}" reltype="4"/>`).join('')}</relations></login>`,
).toString('base64');

(async () => {
  const negocio = await Business.findOne({ where: { email: 'demo@stocker.app' } });
  const limpiar = async () => {
    const cuits = await BusinessCuit.findAll({ where: { businessId: negocio.id, cuit: { [Op.like]: '30-9999999%' } } });
    if (cuits.length) {
      await BusinessArcaConfig.destroy({ where: { businessCuitId: cuits.map((c) => c.id) } });
      await BusinessCuit.destroy({ where: { id: cuits.map((c) => c.id) } });
    }
  };
  await limpiar();

  try {
    tit('1. LA LISTA DE REPRESENTADOS SALE DEL TA');
    chk('se leen los CUIT que AFIP reconoce', ['20190178154', '30333333313'],
      cli.relacionesDelTA({ token: tokenCon(['20190178154', '30333333313']) }));
    chk('un TA sin relaciones no representa a nadie', [], cli.relacionesDelTA({ token: tokenCon([]) }));
    chk('un token ilegible no rompe', [], cli.relacionesDelTA({ token: 'no-es-base64-valido###' }));
    chk('sin TA tampoco', [], cli.relacionesDelTA(null));

    tit('2. LO QUE STOCKER HACE CON ESA LISTA');
    const crear = async (cuit, { verificada = false, ambiente = 'produccion' } = {}) => {
      const bc = await BusinessCuit.create({
        businessId: negocio.id, nombre: `QA ${cuit}`, cuit, condicionIva: 'Responsable Inscripto',
      });
      return BusinessArcaConfig.create({
        businessId: negocio.id, businessCuitId: bc.id, puntoVenta: 3,
        ambiente, delegacionVerificada: verificada,
        ultimoError: verificada ? null : 'esperando la delegación',
      });
    };
    /*
     * El CUIT se guarda con guiones, como lo carga la gente, y tiene 11 dígitos
     * como los de verdad: AFIP manda 11 y el parser del TA sólo reconoce eso.
     * Con un CUIT inventado más corto la prueba pasaba y la realidad no.
     */
    const recienDelegado = await crear('30-99999991-1');
    const yaActivo = await crear('30-99999992-2', { verificada: true });
    const revocado = await crear('30-99999993-3', { verificada: true });
    const deHomologacion = await crear('30-99999994-4', { ambiente: 'homologacion' });

    /*
     * AFIP manda los CUIT sin guiones y manda TODOS los que representamos,
     * incluidos los de otros negocios: hay que cruzarlos igual.
     */
    const digitos = (v) => String(v).replace(/\D/g, '');
    const cuitDe = async (cfg) => digitos((await BusinessCuit.findByPk(cfg.businessCuitId)).cuit);
    const r2 = await arca.sincronizarDelegaciones({
      ambiente: 'produccion',
      relaciones: ['20999999993', await cuitDe(recienDelegado), await cuitDe(yaActivo)],
    });
    chk('un CUIT ajeno en la lista no molesta', 3, r2.representados);
    await recienDelegado.reload(); await yaActivo.reload(); await revocado.reload(); await deHomologacion.reload();

    chk('el que ya delegó y fue aceptado queda activo solo', [true, null],
      [recienDelegado.delegacionVerificada, recienDelegado.ultimoError]);
    chk('el que ya estaba activo sigue igual', true, yaActivo.delegacionVerificada);
    chk('el que revocó se marca, sin borrarle la configuración', [false, 3, true],
      [revocado.delegacionVerificada, revocado.puntoVenta, /no.*activa|volvé a delegar/i.test(revocado.ultimoError || '')]);
    chk('las cuentas de otro ambiente no se tocan', false, deHomologacion.delegacionVerificada);
    chk('el resumen cuenta lo que pasó', [1, 1], [r2.activadas, r2.revocadas]);

    const r3 = await arca.sincronizarDelegaciones({
      ambiente: 'produccion',
      relaciones: [await cuitDe(recienDelegado), await cuitDe(yaActivo)],
    });
    chk('correrlo de nuevo no cambia nada', [0, 0], [r3.activadas, r3.revocadas]);

    tit('3. SIN CUENTAS NO SE LE PREGUNTA NADA A AFIP');
    const vacio = await arca.sincronizarDelegaciones({ ambiente: 'un-ambiente-que-no-existe' });
    chk('no hay nada que sincronizar', [0, 0, 0], [vacio.cuentas, vacio.activadas, vacio.revocadas]);

    tit('4. EL RELOJ ARRANCA AUNQUE NO HAYA TIENDAS');
    /*
     * Un negocio puede facturar sin vender online. El barrido de los 15 minutos
     * es el mismo para las dos cosas, así que tiene que arrancar igual: si no,
     * las delegaciones nuevas no se activan nunca en esas instalaciones.
     */
    const tareas = require('../src/services/tareasPeriodicasService');
    const previo = { ml: process.env.ML_BARRIDO, js: process.env.JUMPSELLER_BARRIDO, arca: process.env.ARCA_DELEGACIONES };
    try {
      process.env.ML_BARRIDO = 'off';
      process.env.JUMPSELLER_BARRIDO = 'off';
      delete process.env.ARCA_DELEGACIONES;
      const arrancoSinTiendas = tareas.arrancar();
      tareas.parar();
      chk('sin ML ni Jumpseller, el reloj arranca igual por las delegaciones', true, arrancoSinTiendas);

      process.env.ARCA_DELEGACIONES = 'off';
      const arrancoSinNada = tareas.arrancar();
      tareas.parar();
      chk('con todo apagado no arranca nada', false, arrancoSinNada);
    } finally {
      for (const [k, v] of [['ML_BARRIDO', previo.ml], ['JUMPSELLER_BARRIDO', previo.js], ['ARCA_DELEGACIONES', previo.arca]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }

    tit('5. EL TA SE RENUEVA CUANDO HAY ALGUIEN ESPERANDO');
    /*
     * La lista de delegaciones viaja adentro del TA y el TA dura 12 horas. Si
     * se usa el guardado, el que delegó recién no aparece y queda esperando
     * hasta medio día. Acá se reemplaza el pedido a AFIP por uno de mentira
     * para mirar una sola cosa: si se pidió TA nuevo o se usó el de la caja.
     */
    const taFalso = (cuits, minutos = 720) => {
      const gen = Math.floor(Date.UTC(2026, 0, 2, 12, 0, 0) / 1000);
      const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sso version="2.0">
  <id src="CN=wsaahomo, O=AFIP, C=AR" dst="CN=wsfe, O=AFIP, C=AR" unique_id="1" gen_time="${gen}" exp_time="${gen + minutos * 60}"/>
  <operation type="login" value="granted">
    <login entity="33693450239" service="wsfe">
      <relations>${cuits.map((c) => `<relation key="${c}" relType="4"/>`).join('')}</relations>
    </login>
  </operation>
</sso>`;
      return { token: Buffer.from(xml, 'utf8').toString('base64'), sign: 'x', cuit: '20000000001' };
    };

    /*
     * En un ambiente propio, que nadie más usa: 'homologacion' tiene cuentas
     * reales de desarrollo esperando delegación, y con alguien esperando la
     * decisión sale siempre igual y la prueba no probaría nada. El ambiente es
     * sólo una etiqueta — cualquiera que no sea 'produccion' usa el mismo
     * certificado de homologación.
     */
    const AMB = 'qa-delegaciones';
    const soloMio = await crear('30-99999995-5', { ambiente: AMB });
    const cuitMio = digitos((await BusinessCuit.findByPk(soloMio.businessCuitId)).cuit);

    const getTAReal = cli.__getTA;
    const pedidos = [];
    try {
      cli.__getTA = async (opts) => { pedidos.push(!!opts.forzar); return taFalso([cuitMio]); };

      const h1 = await arca.sincronizarDelegaciones({ ambiente: AMB });
      await soloMio.reload();
      chk('con alguien esperando, se pide un TA nuevo', [true], pedidos);
      chk('y con ese TA queda activo', [true, 1], [soloMio.delegacionVerificada, h1.activadas]);
      chk('informa hasta cuándo vale el TA', true, h1.taVence instanceof Date);

      pedidos.length = 0;
      await arca.sincronizarDelegaciones({ ambiente: AMB });
      chk('sin nadie esperando, no se molesta a AFIP por un TA nuevo', [false], pedidos);

      /*
       * Un TA sin relaciones es indistinguible de un parseo roto o de un WSAA
       * que contesta raro. Revocar a todos por eso deja a los clientes sin
       * facturar hasta que alguien mire; el costo de no hacerlo es sólo llegar
       * tarde a una baja real, que igual se ve al primer intento de facturar.
       */
      cli.__getTA = async () => taFalso([]);
      const h2 = await arca.sincronizarDelegaciones({ ambiente: AMB });
      await soloMio.reload();
      chk('un TA sin relaciones no da de baja a nadie', [true, 0, true],
        [soloMio.delegacionVerificada, h2.revocadas, !!h2.inconcluso]);
    } finally {
      cli.__getTA = getTAReal;
    }

    tit('6. LO QUE EL TA DICE DE SÍ MISMO');
    const muestra = taFalso(['30111111118', '20222222229'], 720);
    const datos = cli.datosDelTA(muestra);
    chk('saca los CUIT representados', ['30111111118', '20222222229'], datos.relaciones);
    chk('y el vencimiento real, que es el que manda AFIP', 720,
      Math.round((datos.vence - datos.generado) / 60000));
    chk('un token ilegible no rompe nada', [[], null],
      [cli.datosDelTA({ token: '###' }).relaciones, cli.datosDelTA(null).vence]);
  } finally {
    tit('Limpieza');
    await limpiar();
    chk('no queda nada de la prueba', 0,
      await BusinessCuit.count({ where: { businessId: negocio.id, cuit: { [Op.like]: '30-9999999%' } } }));
  }

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
