/*
 * Logger con enmascarado de datos personales.
 *
 * Los logs de Railway los ve cualquiera que tenga acceso al proyecto, y quedan
 * guardados. Escribir ahí un email, un teléfono o un CUIT completo es filtrar
 * datos de los clientes de nuestros clientes: alcanza con una cuenta de Railway
 * comprometida, o con compartir una captura, para exponerlos.
 *
 * La regla es que el log diga QUÉ pasó y DÓNDE, nunca CON QUÉ DATOS. Cuando hace
 * falta un identificador para poder seguir un caso, va enmascarado: queda lo
 * justo para reconocerlo si ya se sabe cuál es, pero no para descubrirlo.
 */

const crypto = require('crypto');

const NIVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const ORDEN = { error: 0, warn: 1, info: 2, debug: 3 };
const habilitado = (nivel) => (ORDEN[nivel] ?? 2) <= (ORDEN[NIVEL] ?? 2);

// ── Enmascarado ───────────────────────────────────────────────────
// Deja las puntas y tapa el medio: sirve para correlacionar, no para leer.
function mascaraGenerica(valor, visiblesInicio = 2, visiblesFin = 2) {
  const s = String(valor ?? '');
  if (!s) return '(vacío)';
  if (s.length <= visiblesInicio + visiblesFin) return '*'.repeat(s.length);
  // Ojo con slice(-0): devuelve la cadena entera, no el final vacío.
  const cola = visiblesFin > 0 ? s.slice(-visiblesFin) : '';
  return `${s.slice(0, visiblesInicio)}${'*'.repeat(s.length - visiblesInicio - visiblesFin)}${cola}`;
}

const mask = {
  // ana.perez@gmail.com → an******@g****.com
  email(valor) {
    const s = String(valor ?? '');
    const arroba = s.indexOf('@');
    if (arroba < 1) return '(email inválido)';
    const usuario = s.slice(0, arroba);
    const dominio = s.slice(arroba + 1);
    const punto = dominio.lastIndexOf('.');
    const tld = punto > -1 ? dominio.slice(punto) : '';
    const nombreDominio = punto > -1 ? dominio.slice(0, punto) : dominio;
    return `${mascaraGenerica(usuario, 2, 0)}@${mascaraGenerica(nombreDominio, 1, 0)}${tld}`;
  },

  // +54 9 11 4555-2231 → +54*********31
  telefono(valor) {
    return mascaraGenerica(String(valor ?? '').replace(/\s+/g, ''), 3, 2);
  },

  // 30500010912 → 30*******12
  cuit(valor) {
    return mascaraGenerica(String(valor ?? '').replace(/\D/g, ''), 2, 2);
  },

  // Para razón social, nombres, direcciones: sólo la inicial.
  nombre(valor) {
    const s = String(valor ?? '').trim();
    if (!s) return '(vacío)';
    return `${s[0]}${'*'.repeat(Math.min(s.length - 1, 8))}`;
  },

  /*
   * La IP no se escribe: se escribe una huella de la IP.
   *
   * Una dirección IP es dato personal —identifica a una persona a través de su
   * proveedor— y estos logs quedan guardados en Railway. Pero sin nada en su
   * lugar, los avisos de seguridad dejan de servir: no se puede distinguir
   * cuarenta intentos de la misma máquina de cuarenta máquinas distintas, que
   * es justamente la diferencia entre un ataque y un usuario despistado.
   *
   * La huella conserva eso y nada más. Es estable —la misma IP da siempre la
   * misma— y no se puede volver atrás.
   *
   * El salt sale de JWT_SECRET, que ya es secreto y ya está en producción. Si
   * se rota, las huellas cambian: se pierde la correlación con los logs viejos,
   * que es un precio menor por no sumar otra variable de entorno que alguien
   * tenga que acordarse de cargar.
   *
   * Para saber la IP propia y cargarla en la lista del backoffice está
   * GET /api/mi-ip, que se la dice a quien pregunta y no la deja escrita.
   */
  ip(valor) {
    const s = String(valor ?? '').trim();
    if (!s) return '(sin ip)';
    const familia = s.includes(':') ? 'v6' : 'v4';
    const huella = crypto
      .createHash('sha256')
      .update(`${process.env.JWT_SECRET || 'stocker'}|${s}`)
      .digest('hex')
      .slice(0, 8);
    return `ip${familia}#${huella}`;
  },
};

/*
 * Deja el mensaje de un error de afuera sin los datos que trae adentro.
 *
 * Los errores de Postgres, de AFIP y de Meta vienen con el valor que falló
 * pegado en el texto: "duplicate key ... Key (email)=(ana@gmail.com)",
 * "El CUIT 20345678901 no existe", "Invalid phone 5491145552231". Escribirlos
 * tal cual en el log es filtrar exactamente lo que el resto del archivo se
 * cuida de no escribir.
 *
 * Se conserva la FORMA del error, que es lo que sirve para diagnosticar, y se
 * tapa todo lo que parezca un valor: lo entrecomillado, lo que va entre
 * paréntesis después de un igual, los emails y las tiras largas de dígitos.
 */
function sinDatos(mensaje, largo = 300) {
  return String(mensaje ?? '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '(email)')
    .replace(/=\s*\(([^)]*)\)/g, '=(…)')
    .replace(/'[^']*'/g, "'…'")
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\d{6,}/g, '(número)')
    .slice(0, largo);
}

// ── Emisión ───────────────────────────────────────────────────────
// Formato: [nivel] modulo · mensaje
// `modulo` identifica la parte del proyecto, que es lo que hace falta para
// diagnosticar sin exponer nada.
function emitir(nivel, modulo, mensaje, datos) {
  if (!habilitado(nivel)) return;
  const salida = nivel === 'error' ? console.error : nivel === 'warn' ? console.warn : console.log;
  const extra = datos && Object.keys(datos).length
    ? ' ' + Object.entries(datos).map(([k, v]) => `${k}=${v}`).join(' ')
    : '';
  salida(`[${nivel}] ${modulo} · ${mensaje}${extra}`);
}

const log = {
  error: (modulo, mensaje, datos) => emitir('error', modulo, mensaje, datos),
  warn:  (modulo, mensaje, datos) => emitir('warn',  modulo, mensaje, datos),
  info:  (modulo, mensaje, datos) => emitir('info',  modulo, mensaje, datos),
  debug: (modulo, mensaje, datos) => emitir('debug', modulo, mensaje, datos),
  mask,
  sinDatos,
};

module.exports = { log, mask, sinDatos };
