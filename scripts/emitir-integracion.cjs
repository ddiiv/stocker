/*
 * Emite la credencial con la que un sistema de afuera le escribe a Stocker.
 *
 * Existe porque el token se muestra UNA sola vez y hacerlo por HTTP exige la
 * sesión del dueño: una cookie que hay que sacar de algún lado, pegar en un
 * curl y que se vence. Esto corre contra la base y listo.
 *
 * Uso:
 *   node scripts/emitir-integracion.cjs                    → lista los negocios
 *   node scripts/emitir-integracion.cjs 39                 → emite para ese id
 *   node scripts/emitir-integracion.cjs alguien@negocio.com
 *
 * En Railway es lo mismo, desde la shell del servicio del backend.
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const { Business, IntegracionExterna } = require('../src/models');
const integraciones = require('../src/services/integracionesService');

const ORIGEN = process.env.ORIGEN || 'isuwaya';

(async () => {
  const quien = (process.argv[2] || '').trim();

  if (!quien) {
    const negocios = await Business.findAll({
      attributes: ['id', 'nombreNegocio', 'email'], order: [['id', 'ASC']], limit: 100,
    });
    console.log('\nNegocios cargados:\n');
    for (const n of negocios) console.log(`  ${String(n.id).padStart(4)}  ${n.nombreNegocio}  ·  ${n.email}`);
    console.log('\nVolvé a correrlo con el id o el email:  node scripts/emitir-integracion.cjs <id|email>\n');
    process.exit(0);
  }

  const negocio = /^\d+$/.test(quien)
    ? await Business.findByPk(Number(quien))
    : await Business.findOne({ where: { email: quien } });

  if (!negocio) { console.error(`No encontré ningún negocio con "${quien}".`); process.exit(1); }

  /*
   * Si ya había una credencial viva se avisa ANTES de emitir: emitir apaga la
   * anterior, y hacerlo sin querer deja al portal sin poder mandar pedidos
   * hasta que alguien note por qué.
   */
  const vigente = await IntegracionExterna.findOne({
    where: { businessId: negocio.id, origen: ORIGEN, activa: true },
  });
  if (vigente) {
    console.log(`\n⚠  Ya hay una credencial activa para ${ORIGEN} en este negocio`
      + ` (termina en ${vigente.pista}${vigente.ultimoUsoEn ? `, se usó por última vez el ${new Date(vigente.ultimoUsoEn).toLocaleString('es-AR')}` : ', nunca se usó'}).`);
    console.log('   Emitir una nueva la apaga: el portal deja de poder mandar pedidos hasta que cargues la nueva.');
    if (process.argv[3] !== '--igual') {
      console.log('\n   Si es lo que querés, agregá --igual:');
      console.log(`     node scripts/emitir-integracion.cjs ${quien} --igual\n`);
      process.exit(1);
    }
  }

  const { token, integracion } = await integraciones.emitir({
    businessId: negocio.id, origen: ORIGEN, nombre: 'Portal mayorista',
  });

  console.log(`\n✔  Credencial emitida para ${negocio.nombreNegocio} (negocio ${negocio.id}), origen ${integracion.origen}.\n`);
  console.log('   Este token no se vuelve a mostrar. Copialo ahora al .env de ISUWAYA:\n');
  console.log(`     STOCKER_TOKEN=${token}`);
  console.log('     STOCKER_URL=https://TU-DOMINIO/api          # o http://backend.railway.internal:PUERTO');
  console.log(`     STOCKER_NEGOCIO=${negocio.id}               # referencia: el negocio sale del token\n`);
  console.log('   Para probar que llega, desde ISUWAYA: Panel → Pedidos → reintentar el envío.\n');
  process.exit(0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
