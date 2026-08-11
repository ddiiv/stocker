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
};

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
};

module.exports = { log, mask };
