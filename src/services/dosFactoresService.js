const crypto = require('node:crypto');
const totp = require('../utils/totp');
const codigos = require('./codigosCuentaService');

/*
 * Segundo factor con app de autenticación.
 *
 * Vive acá y no en el controlador porque lo usan dos caminos que no se pueden
 * separar: la pantalla de Mi cuenta —activar, desactivar, regenerar códigos— y
 * el login. Si la verificación se escribiera dos veces, el día que se corrija
 * algo en una —la protección contra reuso, por ejemplo— la otra queda vieja, y
 * la que queda vieja es justamente la del login.
 */

const CANTIDAD_CODIGOS = 8;
// El tipo con el que se guardan los códigos de un solo uso del login. Aparte
// de los de cambio de email o contraseña: si compartieran tipo, pedir uno para
// entrar invalidaría el que se acababa de pedir para cambiar la contraseña.
const TIPO_LOGIN = 'login2fa';
const CANALES_VALIDOS = ['app', 'email', 'whatsapp'];
// Cuatro bytes por mitad: 8 caracteres hex por grupo, en dos grupos. Da 64
// bits de entropía, que para un código de un solo uso y con el login limitado
// es de sobra, y se puede dictar por teléfono sin equivocarse.
const BYTES_POR_GRUPO = 4;

/*
 * Los códigos de recuperación se guardan con SHA-256 y no con bcrypt.
 *
 * bcrypt es lento a propósito, para que una contraseña —que la gente elige
 * corta y previsible— no se pueda probar en masa. Estos códigos los generamos
 * nosotros con 64 bits de azar: no hay diccionario que probar, así que la
 * lentitud no compra nada y sí costaría medio segundo por cada uno de los ocho
 * en cada intento de login.
 */
const hash = (codigo) => crypto.createHash('sha256')
  .update(String(codigo).toUpperCase().replace(/[^A-Z0-9]/g, ''))
  .digest('hex');

const normalizar = (codigo) => String(codigo || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Ocho códigos nuevos: los de texto para mostrar una vez, los hashes para guardar. */
function generarCodigosDeRecuperacion() {
  const planos = [];
  for (let i = 0; i < CANTIDAD_CODIGOS; i++) {
    const a = crypto.randomBytes(BYTES_POR_GRUPO).toString('hex').toUpperCase();
    const b = crypto.randomBytes(BYTES_POR_GRUPO).toString('hex').toUpperCase();
    planos.push(`${a}-${b}`);
  }
  return { planos, hashes: planos.map(hash) };
}

function leerHashes(business) {
  try {
    const lista = JSON.parse(business.totpRecuperacion || '[]');
    return Array.isArray(lista) ? lista : [];
  } catch {
    return [];
  }
}

/** Cuántos códigos de recuperación quedan sin usar. */
function codigosRestantes(business) {
  return leerHashes(business).length;
}

/**
 * Consume un código de recuperación si coincide. Devuelve true y lo borra.
 *
 * Se compara contra los hashes guardados, y el que se usa se saca de la lista:
 * de un solo uso. Un código de recuperación que sirve dos veces es una
 * contraseña más, escrita en un papel.
 */
async function consumirCodigoDeRecuperacion(business, codigo) {
  const limpio = normalizar(codigo);
  if (!limpio) return false;

  const hashes = leerHashes(business);
  const buscado = hash(limpio);
  const i = hashes.indexOf(buscado);
  if (i === -1) return false;

  hashes.splice(i, 1);
  await business.update({ totpRecuperacion: JSON.stringify(hashes) });
  return true;
}

/**
 * ¿El segundo factor está bien?
 *
 * Acepta el código de seis dígitos de la app o uno de recuperación. Devuelve
 * `{ ok, motivo }` en vez de tirar: el que llama decide si eso es un 401 de
 * login o un 400 de pantalla de configuración, y el mensaje lo pone él.
 *
 * Contra el reuso: se guarda el último bloque de 30 segundos aceptado y se
 * exige que el siguiente sea posterior. Sin eso, un código que alguien vio
 * —por encima del hombro, en una captura— sirve durante noventa segundos, que
 * es tiempo de sobra para tipearlo en otra máquina.
 */
/*
 * Los canales prendidos de una cuenta.
 *
 * 'app' se deriva del secreto y no de la lista: si estuviera sólo en la lista,
 * una cuenta con el secreto cargado y el canal borrado por error quedaría con
 * el 2FA a medio prender, sin app y sin saberlo.
 */
function canalesActivos(business) {
  const guardados = (() => {
    try {
      const l = JSON.parse(business?.dobleFactorCanales || '[]');
      return Array.isArray(l) ? l.filter((c) => CANALES_VALIDOS.includes(c)) : [];
    } catch { return []; }
  })();
  const set = new Set(guardados.filter((c) => c !== 'app'));
  if (business?.totpSecret) set.add('app');
  return CANALES_VALIDOS.filter((c) => set.has(c));
}

/** ¿La cuenta tiene segundo factor, por el canal que sea? */
function tieneSegundoFactor(business) {
  return canalesActivos(business).length > 0;
}

/**
 * ¿El segundo factor está bien?
 *
 * Acepta, en este orden: el código de la app, el código de un solo uso que se
 * mandó al mail o al WhatsApp, y un código de recuperación. Se prueban todos
 * los que la cuenta tenga prendidos porque la persona no elige "con cuál"
 * responde: escribe seis dígitos y el servidor tiene que saber de dónde
 * salieron.
 *
 * Devuelve `{ ok, motivo }` en vez de tirar: el que llama decide si eso es un
 * 401 de login o un 400 de pantalla de configuración.
 */
async function verificar(business, codigo) {
  const canales = canalesActivos(business);
  if (!canales.length) return { ok: true, motivo: 'sin_2fa' };

  const limpio = normalizar(codigo);
  if (!limpio) return { ok: false, motivo: 'falta' };

  if (canales.includes('app') && business.totpSecret) {
    const paso = totp.pasoValido(business.totpSecret, limpio);
    if (paso !== null) {
      const ultimo = business.totpUltimoPaso == null ? null : Number(business.totpUltimoPaso);
      if (ultimo !== null && paso <= ultimo) return { ok: false, motivo: 'repetido' };
      await business.update({ totpUltimoPaso: paso });
      return { ok: true, motivo: 'totp' };
    }
  }

  if (canales.some((c) => c === 'email' || c === 'whatsapp')) {
    if (await codigos.codigoEsValido({ businessId: business.id, tipo: TIPO_LOGIN, code: limpio })) {
      return { ok: true, motivo: 'codigo_enviado' };
    }
  }

  if (await consumirCodigoDeRecuperacion(business, limpio)) {
    return { ok: true, motivo: 'recuperacion' };
  }

  return { ok: false, motivo: 'invalido' };
}

module.exports = {
  canalesActivos,
  tieneSegundoFactor,
  TIPO_LOGIN,
  CANALES_VALIDOS,
  generarCodigosDeRecuperacion,
  consumirCodigoDeRecuperacion,
  codigosRestantes,
  verificar,
  CANTIDAD_CODIGOS,
};
