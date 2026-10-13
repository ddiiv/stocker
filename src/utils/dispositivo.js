/*
 * «Chrome · Windows», a partir del user agent.
 *
 * Es lo que se muestra en la lista de sesiones de la cuenta. El user agent
 * entero no lo lee nadie, y lo que el dueño necesita es reconocer de un
 * vistazo cuál es su teléfono y cuál la PC del local para saber qué cerrar.
 *
 * A mano y no con una librería: son una docena de reglas, y una dependencia
 * más para esto es más superficie que el problema que resuelve. Si no se
 * reconoce nada se dice eso, sin inventar: una etiqueta equivocada es peor que
 * ninguna, porque el dueño cerraría la sesión que no es.
 *
 * El ORDEN de las reglas importa: Edge y Opera dicen "Chrome" en su user
 * agent, y Chrome dice "Safari". Se pregunta del más específico al más
 * general.
 */

const NAVEGADORES = [
  [/\bEdg(e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrome\/|\bCriOS\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];

const SISTEMAS = [
  [/\biPhone\b/, 'iPhone'],
  [/\biPad\b/, 'iPad'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'Mac'],
  [/\bLinux\b/, 'Linux'],
];

function etiquetaDeDispositivo(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return 'Dispositivo desconocido';

  const navegador = NAVEGADORES.find(([re]) => re.test(ua))?.[1] || null;
  const sistema = SISTEMAS.find(([re]) => re.test(ua))?.[1] || null;

  if (navegador && sistema) return `${navegador} · ${sistema}`;
  if (navegador || sistema) return navegador || sistema;
  // Un script o una herramienta (curl, Postman, node): no es un navegador.
  return 'Otro programa';
}

/*
 * La IP como la guarda la sesión.
 *
 * Express entrega las IPv4 como "::ffff:1.2.3.4" cuando el servidor escucha
 * en IPv6 (y escucha en '::', ver index.js). Es la misma dirección; mostrarla
 * con el prefijo sólo confunde a quien la mira.
 */
function normalizarIp(ip) {
  const texto = String(ip || '').trim();
  if (!texto) return null;
  return texto.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1').slice(0, 64);
}

module.exports = { etiquetaDeDispositivo, normalizarIp };
