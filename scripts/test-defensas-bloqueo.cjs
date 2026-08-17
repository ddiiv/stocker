/*
 * Comprobación del bloqueo por fuerza bruta. Lo llama test-defensas.sh.
 *
 * Va en un archivo y no embebido con `node -e` dentro del shell: entre las
 * comillas del shell, las del JS y las plantillas quedaba ilegible y se rompía
 * en silencio, devolviendo un error de parseo que parecía una falla del
 * bloqueo.
 *
 * Se prueba contra el servicio y no contra el endpoint porque el limitador de
 * peticiones corta a los 5 intentos por minuto, antes de que se junten los
 * fallos que el bloqueo necesita para actuar. Las dos capas existen justamente
 * para eso: el limitador frena el ataque rápido, el bloqueo el lento.
 */
require('dotenv').config();
const { Op } = require('sequelize');
const bloqueo = require('../src/services/bloqueoService');
const { AuthAttempt } = require('../src/models');
const req = { ip: '203.0.113.77', headers: { 'user-agent': 'test-defensas' }, body: {} };

(async () => {
  const cuenta = process.argv[2];
  await AuthAttempt.destroy({ where: { identificador: cuenta } });

  const antes = await bloqueo.revisar({ req, identificador: cuenta });
  for (let i = 0; i < 4; i++) {
    await bloqueo.registrar({ req, tipo: 'business', identificador: cuenta, exito: false });
  }
  const conCuatro = await bloqueo.revisar({ req, identificador: cuenta });

  await bloqueo.registrar({ req, tipo: 'business', identificador: cuenta, exito: false });
  const conCinco = await bloqueo.revisar({ req, identificador: cuenta });

  const otra = 'otra.cuenta@defensas.test';
  const otroReq = { ...req, ip: '203.0.113.78' };
  for (let i = 0; i < 3; i++) {
    await bloqueo.registrar({ req: otroReq, tipo: 'business', identificador: otra, exito: false });
  }
  const otraLibre = await bloqueo.revisar({ req: otroReq, identificador: otra });

  await bloqueo.limpiar({ req, identificador: cuenta });
  const trasEntrar = await bloqueo.revisar({ req, identificador: cuenta });

  // La limpieza va ANTES de imprimir: el logger de la base escribe en stdout,
  // así que un DELETE posterior dejaba una línea de debug como última salida y
  // el `tail -1` del shell leía eso en vez del JSON.
  await AuthAttempt.destroy({ where: { identificador: { [Op.like]: '%@defensas.test' } } });

  console.log(JSON.stringify({
    antes: antes ? 'bloqueado' : 'libre',
    conCuatro: conCuatro ? 'bloqueado' : 'libre',
    conCinco: conCinco ? 'bloqueado' : 'libre',
    minutos: conCinco ? conCinco.minutos : 0,
    filtraCuenta: conCinco ? /esta cuenta|no existe|registrad/i.test(conCinco.mensaje) : false,
    otraLibre: otraLibre ? 'bloqueado' : 'libre',
    trasEntrar: trasEntrar ? 'bloqueado' : 'libre',
  }));
  process.exit(0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
