const crypto = require('node:crypto');

/*
 * TOTP — el código de seis dígitos de Google Authenticator (RFC 6238).
 *
 * Se implementa acá y no con una dependencia porque son treinta líneas de
 * HMAC: sumar un paquete de terceros al camino de login del superusuario es
 * agrandar la superficie de ataque justo donde menos conviene.
 *
 * El paso es de 30 segundos porque es lo único que aceptan Google
 * Authenticator, Authy y 1Password. Un paso más largo obligaría a una app a
 * medida, y una app a medida se termina reemplazando por una captura de
 * pantalla del secreto.
 */

const PASO_SEG = 30;
const DIGITOS = 6;
// Ventana de tolerancia: un paso para atrás y uno para adelante. Cubre el
// reloj corrido del teléfono sin abrir una ventana de reuso larga.
const VENTANA = 1;

const ALFABETO_B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Secreto nuevo, en base32, listo para cargar en la app del teléfono. */
function generarSecreto(bytes = 20) {
  const buf = crypto.randomBytes(bytes);
  let bits = '', salida = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    salida += ALFABETO_B32[parseInt(bits.slice(i, i + 5), 2)];
  }
  return salida;
}

function base32ABuffer(secreto) {
  const limpio = String(secreto).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const c of limpio) {
    const v = ALFABETO_B32.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** Código de 6 dígitos para un instante dado. */
function codigoPara(secreto, contador) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(contador));
  const hmac = crypto.createHmac('sha1', base32ABuffer(secreto)).update(buf).digest();

  // Truncamiento dinámico del RFC: el último nibble dice dónde empieza.
  const offset = hmac[hmac.length - 1] & 0x0f;
  const codigo = ((hmac[offset] & 0x7f) << 24 |
                  (hmac[offset + 1] & 0xff) << 16 |
                  (hmac[offset + 2] & 0xff) << 8 |
                  (hmac[offset + 3] & 0xff)) % 10 ** DIGITOS;

  return String(codigo).padStart(DIGITOS, '0');
}

/**
 * Valida el código tipeado.
 *
 * La comparación es en tiempo constante: con un `===` el tiempo de respuesta
 * filtra cuántos dígitos acertó quien está probando.
 */
function validar(secreto, codigo) {
  const limpio = String(codigo || '').replace(/\D/g, '');
  if (limpio.length !== DIGITOS || !secreto) return false;

  const ahora = Math.floor(Date.now() / 1000 / PASO_SEG);
  for (let i = -VENTANA; i <= VENTANA; i++) {
    const esperado = codigoPara(secreto, ahora + i);
    const a = Buffer.from(esperado);
    const b = Buffer.from(limpio);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** URI para el QR que se escanea con la app del teléfono. */
function uriParaQr({ secreto, cuenta, emisor = 'Stocker Backoffice' }) {
  const etiqueta = encodeURIComponent(`${emisor}:${cuenta}`);
  return `otpauth://totp/${etiqueta}?secret=${secreto}` +
         `&issuer=${encodeURIComponent(emisor)}&algorithm=SHA1&digits=${DIGITOS}&period=${PASO_SEG}`;
}

module.exports = { generarSecreto, validar, codigoPara, uriParaQr, PASO_SEG, DIGITOS };
