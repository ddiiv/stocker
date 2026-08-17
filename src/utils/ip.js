/*
 * Comparación de IPs contra una lista, con soporte de CIDR.
 *
 * Se implementa acá y no con una dependencia porque son cuarenta líneas y el
 * paquete quedaría en el camino crítico del control de acceso al backoffice:
 * cuanto menos código de terceros haya ahí, mejor.
 *
 * Maneja IPv4, IPv6 y las direcciones mapeadas (::ffff:1.2.3.4), que es como
 * suele llegar una IPv4 cuando el socket escucha en IPv6 — el caso de Railway.
 */

/** Normaliza a texto comparable: saca el mapeo v6 y el sufijo de zona. */
function normalizar(ip) {
  let limpia = String(ip || '').trim().toLowerCase();
  if (limpia.startsWith('::ffff:')) limpia = limpia.slice(7);
  const zona = limpia.indexOf('%');
  if (zona !== -1) limpia = limpia.slice(0, zona);
  return limpia;
}

const esV4 = (ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);

/** IPv4 a entero de 32 bits. Null si no es una v4 válida. */
function v4ANumero(ip) {
  const partes = ip.split('.').map(Number);
  if (partes.length !== 4 || partes.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((partes[0] << 24) | (partes[1] << 16) | (partes[2] << 8) | partes[3]) >>> 0;
}

/** IPv6 a un array de 16 bytes. Null si no se puede interpretar. */
function v6ABytes(ip) {
  // Forma mixta (::ffff:1.2.3.4 ya viene normalizada, pero quedan otras).
  let texto = ip;
  const mixta = texto.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mixta) {
    const n = v4ANumero(mixta[2]);
    if (n === null) return null;
    const alto = ((n >>> 16) & 0xffff).toString(16);
    const bajo = (n & 0xffff).toString(16);
    texto = `${mixta[1]}${alto}:${bajo}`;
  }

  const doble = texto.split('::');
  if (doble.length > 2) return null;

  const aGrupos = (s) => (s ? s.split(':').filter((x) => x !== '') : []);
  const izq = aGrupos(doble[0]);
  const der = doble.length === 2 ? aGrupos(doble[1]) : [];

  const faltan = 8 - izq.length - der.length;
  if (doble.length === 1 && izq.length !== 8) return null;
  if (doble.length === 2 && faltan < 0) return null;

  const grupos = doble.length === 2
    ? [...izq, ...Array(faltan).fill('0'), ...der]
    : izq;

  const bytes = [];
  for (const g of grupos) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

/**
 * ¿La IP entra en la regla? La regla puede ser una IP suelta o un CIDR.
 *
 * Una regla malformada devuelve false en vez de lanzar: en un control de
 * acceso, un error de tipeo en la configuración tiene que cerrar la puerta,
 * no tumbar el proceso ni —peor— abrirla.
 */
function coincide(ip, regla) {
  const dir = normalizar(ip);
  const texto = String(regla || '').trim().toLowerCase();
  if (!dir || !texto) return false;

  const [red, prefijoTexto] = texto.split('/');
  const redLimpia = normalizar(red);

  // Sin barra: comparación exacta.
  if (prefijoTexto === undefined) return dir === redLimpia;

  const prefijo = Number(prefijoTexto);
  if (!Number.isInteger(prefijo) || prefijo < 0) return false;

  if (esV4(dir) && esV4(redLimpia)) {
    if (prefijo > 32) return false;
    const a = v4ANumero(dir);
    const b = v4ANumero(redLimpia);
    if (a === null || b === null) return false;
    if (prefijo === 0) return true;
    const mascara = (0xffffffff << (32 - prefijo)) >>> 0;
    return (a & mascara) === (b & mascara);
  }

  const a = v6ABytes(dir);
  const b = v6ABytes(redLimpia);
  if (!a || !b || prefijo > 128) return false;

  const bytesEnteros = prefijo >> 3;
  for (let i = 0; i < bytesEnteros; i++) if (a[i] !== b[i]) return false;

  const bitsSueltos = prefijo & 7;
  if (bitsSueltos === 0) return true;
  const mascara = (0xff << (8 - bitsSueltos)) & 0xff;
  return (a[bytesEnteros] & mascara) === (b[bytesEnteros] & mascara);
}

/** Parsea "1.2.3.4, 10.0.0.0/8, ::1" a una lista de reglas. */
const parsearLista = (texto) =>
  String(texto || '').split(',').map((s) => s.trim()).filter(Boolean);

/** ¿La IP está en alguna de las reglas? */
const estaEnLista = (ip, reglas) => reglas.some((r) => coincide(ip, r));

module.exports = { coincide, parsearLista, estaEnLista, normalizar };
