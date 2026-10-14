/*
 * Configuración de la cuenta: quién ve qué pestaña, qué se dice de cada
 * sesión, del límite de dispositivos, de los Términos y del próximo cobro, y
 * por qué te sacaron cuando caés al login.
 *
 * Es la lógica de las pantallas, sin las pantallas: lo que decide qué se
 * muestra vive en utils/ para poder probarlo acá con node, sin navegador.
 *
 * Uso:  node scripts/test-configuracion.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  PESTANAS_CUENTA, pestanasDeCuenta, entradaDeCuenta, haceCuanto, deQuienEs,
  esMovil, ordenarActivas, textoDelLimite, estadoDeTerminos, proximoCobro, datosDelPeriodo,
} from '../src/utils/cuenta.js';
import { AVISOS_DE_CIERRE, motivoParaLogin, avisoDeCierre, motivoDelRechazo } from '../src/utils/motivosSesion.js';

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  ✓ ${t}`); ok++; }
  else { console.log(`  ✗ ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n${t}`);

const aqui = path.dirname(fileURLToPath(import.meta.url));
const leer = (rel) => readFileSync(path.join(aqui, '..', rel), 'utf8');

const DUENIO = { type: 'business', id: 1 };
const EMPLEADO = { type: 'employee', id: 7, permisos: { ventas: 'editar', integraciones: 'editar' } };
const MIN = 60 * 1000;
const AHORA = new Date('2026-10-13T15:00:00Z').getTime();
const hace = (ms) => new Date(AHORA - ms).toISOString();

tit('1. QUIÉN VE QUÉ PESTAÑA');
chk('el dueño ve las cinco', ['/cuenta', '/cuenta/suscripcion', '/cuenta/sesiones', '/cuenta/seguridad', '/cuenta/terminos'],
  pestanasDeCuenta(DUENIO).map((p) => p.to));
chk('un empleado, sólo Sesiones (aunque tenga todos los permisos)', ['/cuenta/sesiones'],
  pestanasDeCuenta(EMPLEADO).map((p) => p.to));
chk('sin sesión, ninguna', [], pestanasDeCuenta(null));
chk('"Configuración" lleva al dueño a Mi cuenta', '/cuenta', entradaDeCuenta(DUENIO));
chk('y al empleado directo a sus sesiones', '/cuenta/sesiones', entradaDeCuenta(EMPLEADO));
chk('sin sesión no lleva a ningún lado', null, entradaDeCuenta(null));

/*
 * Las pestañas, las rutas y la puerta tienen que decir lo mismo. Una pestaña
 * del dueño sin OwnerRoute le mostraría al empleado la pantalla armándose y
 * rompiéndose con el 403; Sesiones CON OwnerRoute le escondería al empleado
 * lo único que el backend le deja ver.
 */
tit('2. PESTAÑAS, RUTAS Y PUERTAS DICEN LO MISMO');
const app = leer('src/App.jsx');
const layout = leer('src/components/layout/AppLayout.jsx');
for (const p of PESTANAS_CUENTA) {
  const linea = app.split('\n').find((l) => l.includes(`path="${p.to}"`)) || '';
  chk(`${p.to}: existe la ruta`, true, Boolean(linea));
  chk(`${p.to}: ${p.soloDuenio ? 'con' : 'sin'} OwnerRoute`, Boolean(p.soloDuenio), linea.includes('<OwnerRoute>'));
  chk(`${p.to}: tiene título en la barra`, true, layout.includes(`"${p.to}":`));
}

/*
 * El menú: un solo "Configuración" (el grupo viejo con ese nombre pasó a ser
 * "Negocio") y el renglón lleva a cada uno a lo que puede abrir.
 */
const sidebar = leer('src/components/layout/Sidebar.jsx');
chk('el menú no tiene un grupo que se llame "Configuración"', false, /titulo:\s*"Configuración"/.test(sidebar));
chk('el grupo de empleados, pagos e integraciones se llama "Negocio"', true, /titulo:\s*"Negocio"/.test(sidebar));
chk('el renglón "Configuración" usa entradaDeCuenta para elegir adónde ir', true,
  /label:\s*"Configuración"[\s\S]{0,120}destino:\s*entradaDeCuenta/.test(sidebar));

tit('3. EL MOTIVO DEL CIERRE LLEGA AL LOGIN');
chk('http.js arma el ?motivo= con la lista de motivosSesion', true,
  /motivoParaLogin\(err\.response\?\.data\?\.codigo\)/.test(leer('src/lib/http.js')));
chk('el login saca el texto de la misma lista', true,
  /from "\.\.\/utils\/motivosSesion"/.test(leer('src/pages/LoginPage.jsx')));
for (const codigo of Object.keys(AVISOS_DE_CIERRE)) {
  chk(`${codigo} viaja al login`, `?motivo=${codigo}`, motivoParaLogin(codigo));
  chk(`${codigo} tiene su texto`, true, (avisoDeCierre(codigo) || '').length > 10);
}
chk('un código desconocido no viaja (no se inventa un cartel)', '', motivoParaLogin('OTRA_COSA'));
chk('sin código, tampoco', '', motivoParaLogin(undefined));
chk('?motivo=toString no saca un cartel', null, avisoDeCierre('toString'));
chk('"inactividad" tiene su propio cartel en el login, no éste', null, avisoDeCierre('inactividad'));
chk('SESION_CERRADA habla sólo de la contraseña', true, /contraseña/i.test(avisoDeCierre('SESION_CERRADA')));
chk('el desplazado sabe que fue por el máximo de dispositivos', true,
  /máximo de dispositivos/.test(avisoDeCierre('SESION_DESPLAZADA')));

/*
 * Cada código que el backend puede mandar en un 401 de sesión tiene que tener
 * su cartel. Si el backend suma uno y acá nadie lo agrega, el que cae al login
 * no se entera de por qué. Se lee del repo del backend si está al lado (en el
 * deploy no está, y entonces se avisa en vez de fallar).
 */
const back = path.join(aqui, '../../../back/stocker/src');
if (existsSync(back)) {
  const fuentes = ['services/sesionesService.js', 'middleware/auth.js']
    .map((f) => readFileSync(path.join(back, f), 'utf8')).join('\n');
  const codigos = [...new Set([...fuentes.matchAll(/codigo:\s*'(SESION_[A-Z_]+)'/g)].map((m) => m[1]))].sort();
  chk('el backend manda al menos los seis códigos de sesión', true, codigos.length >= 6);
  for (const c of codigos) chk(`el código ${c} del backend tiene cartel`, true, Boolean(avisoDeCierre(c)));
} else {
  console.log('  (sin el repo del backend al lado: no se cruzan los códigos)');
}

tit('4. CUÁNTO HACE');
chk('menos de dos minutos es "ahora"', 'hace un momento', haceCuanto(hace(90 * 1000), AHORA));
chk('minutos', 'hace 5 min', haceCuanto(hace(5 * MIN), AHORA));
chk('horas', 'hace 3 h', haceCuanto(hace(3 * 60 * MIN + 10 * MIN), AHORA));
chk('después de un día, la fecha y la hora', true, /^\d{2}\/\d{2}\/\d{4},? \d{2}:\d{2}$/.test(haceCuanto(hace(26 * 60 * MIN), AHORA)));
chk('una fecha rota no rompe la pantalla', '—', haceCuanto('no-es-una-fecha', AHORA));
chk('sin fecha, guion', '—', haceCuanto(null, AHORA));
chk('un reloj adelantado no da "hace -3 min"', 'hace un momento', haceCuanto(new Date(AHORA + 3 * MIN).toISOString(), AHORA));

tit('5. DE QUIÉN ES CADA SESIÓN');
chk('para el dueño, la suya', 'Vos (dueño)', deQuienEs({ tipo: 'business' }, DUENIO));
chk('para el dueño, la de un empleado con su nombre', 'Ana Pérez',
  deQuienEs({ tipo: 'employee', empleado: { id: 3, nombre: 'Ana', apellido: 'Pérez' } }, DUENIO));
chk('un empleado borrado igual se nombra', 'Empleado dado de baja',
  deQuienEs({ tipo: 'employee', empleado: { id: 9, nombre: null, apellido: null } }, DUENIO));
chk('el empleado ve sólo las suyas: no hace falta decir de quién', null,
  deQuienEs({ tipo: 'employee', empleado: { id: 7, nombre: 'Juan', apellido: 'Gómez' } }, EMPLEADO));
chk('teléfono', true, esMovil('Chrome · Android'));
chk('iPhone', true, esMovil('Safari · iPhone'));
chk('computadora', false, esMovil('Firefox · Windows'));

tit('6. EL ORDEN DE LAS ABIERTAS');
const orden = ordenarActivas([
  { id: 1, tipo: 'employee', actual: false, ultimaActividadEn: hace(1 * MIN) },
  { id: 2, tipo: 'business', actual: false, ultimaActividadEn: hace(20 * MIN) },
  { id: 3, tipo: 'business', actual: true, ultimaActividadEn: hace(10 * MIN) },
  { id: 4, tipo: 'business', actual: false, ultimaActividadEn: hace(2 * MIN) },
  { id: 5, tipo: 'employee', actual: false, ultimaActividadEn: hace(30 * MIN) },
]).map((s) => s.id);
chk('ésta primero, después las del dueño, después los empleados; la más reciente arriba', [3, 4, 2, 1, 5], orden);
const original = [
  { id: 1, tipo: 'employee', actual: false, ultimaActividadEn: hace(1 * MIN) },
  { id: 2, tipo: 'business', actual: true, ultimaActividadEn: hace(5 * MIN) },
];
ordenarActivas(original);
chk('no reordena la lista que recibe (es el estado de React)', [1, 2], original.map((s) => s.id));

tit('7. EL LÍMITE DE DISPOSITIVOS');
chk('un empleado no tiene límite que mostrar', null, textoDelLimite(null));
let l = textoDelLimite({ tope: 3, modo: 'activo', activas: 2 });
chk('activo: "2 de 3"', '2 de 3', l.cifra);
chk('activo: dice que se cierra la de menos actividad', true, /se cierra sola la que tenga menos actividad/.test(l.detalle));
chk('activo: con barra', true, l.conBarra);
l = textoDelLimite({ tope: 3, modo: 'sombra', activas: 4 });
chk('sombra: NO promete que se cierra ahora', true, /no cerramos ninguna/.test(l.detalle));
chk('sombra: avisa que se pasó', true, l.pasado);
l = textoDelLimite({ tope: 1, modo: 'activo', activas: 1 });
chk('singular: "1 dispositivo"', true, /en 1 dispositivo a la vez/.test(l.detalle));
l = textoDelLimite({ tope: null, modo: 'activo', activas: 4 });
chk('sin tope (Enterprise): sin barra y sin "de N"', ['4 abiertas', false], [l.cifra, l.conBarra]);
l = textoDelLimite({ tope: 3, modo: 'off', activas: 1 });
chk('apagado: no se mide contra nada', ['1 abierta', false, false], [l.cifra, l.conBarra, l.pasado]);

tit('8. LOS TÉRMINOS');
chk('aceptó la vigente', 'al-dia', estadoDeTerminos({ terminosVersion: '2026-09', terminosVigente: '2026-09' }));
chk('aceptó una anterior', 'anterior', estadoDeTerminos({ terminosVersion: '2026-09', terminosVigente: '2026-11' }));
chk('cuenta sin registro de aceptación', 'sin-registro', estadoDeTerminos({ terminosVersion: null, terminosVigente: '2026-11' }));
chk('sin datos no rompe', 'sin-registro', estadoDeTerminos());

tit('9. EL PRÓXIMO COBRO');
const base = { estado: 'activa', renovacionAutomatica: true, vence: '2026-11-10T03:00:00Z',
  proximoCobroEn: '2026-11-10T03:00:00Z', plan: { nombre: 'Plan Pro' } };
chk('en la prueba no se cobra', 'Durante la prueba no se cobra', proximoCobro({ ...base, estado: 'trial' }).valor);
chk('vencida: el pago ya se debe, no es "próximo"', ['Pendiente', true],
  [proximoCobro({ ...base, estado: 'morosa' }).valor, proximoCobro({ ...base, estado: 'morosa' }).alerta]);
chk('en modo lectura, igual', 'Pendiente', proximoCobro({ ...base, estado: 'lectura' }).valor);
chk('con la renovación apagada no se vuelve a cobrar', 'No se vuelve a cobrar',
  proximoCobro({ ...base, renovacionAutomatica: false }).valor);
chk('al día: la fecha del próximo cobro', true, /^\d{2}\/\d{2}\/2026$/.test(proximoCobro(base).valor));
chk('  y del plan actual', 'Plan Pro', proximoCobro(base).nota);
chk('con una bajada ya paga, se cobra el plan nuevo', 'Plan Inicial',
  proximoCobro({ ...base, planPendiente: { nombre: 'Plan Inicial', desde: base.vence } }).nota);
chk('sin próximo cobro guardado, cae al vencimiento', proximoCobro(base).valor,
  proximoCobro({ ...base, proximoCobroEn: null }).valor);

/*
 * Lo que manda el backend después de pagar antes de tiempo: el período en uso
 * y, aparte, lo ya pago para después (billingController.periodoActual). Antes
 * se mostraba lo pagado por adelantado como "actual", con hoy afuera.
 */
tit('10. EL PERÍODO ACTUAL Y LO PAGADO POR ADELANTADO');
const PER = { desde: '2026-10-01T03:00:00Z', hasta: '2026-10-31T03:00:00Z', tipo: 'pago', siguiente: null };
const SIG = { desde: '2026-10-31T03:00:00Z', hasta: '2026-11-30T03:00:00Z' };
const fechas = (d) => d.map((x) => [x.rotulo, x.valor, x.nota]);
chk('sin período, un solo recuadro que lo dice', [['Período actual', 'Sin período en curso', null]],
  fechas(datosDelPeriodo({ periodo: null })));
chk('la prueba se llama prueba y no dice "Pagado"', [['Período de prueba', '01/10/2026 al 31/10/2026', null]],
  fechas(datosDelPeriodo({ periodo: { ...PER, tipo: 'prueba' } })));
chk('al día, sin nada adelantado: un recuadro', [['Período actual', '01/10/2026 al 31/10/2026', 'Pagado']],
  fechas(datosDelPeriodo({ periodo: PER, plan: { nombre: 'Plan Pro' } })));
chk('renovado antes de tiempo: el actual y, aparte, el próximo ya pago con su plan', [
  ['Período actual', '01/10/2026 al 31/10/2026', 'Pagado'],
  ['Próximo período', '31/10/2026 al 30/11/2026', 'Ya pago · Plan Pro'],
], fechas(datosDelPeriodo({ periodo: { ...PER, siguiente: SIG }, plan: { nombre: 'Plan Pro' } })));
chk('con la bajada que rige cuando empieza lo adelantado: el próximo es del plan nuevo',
  'Ya pago · Plan Inicial',
  datosDelPeriodo({
    periodo: { ...PER, siguiente: SIG }, plan: { nombre: 'Plan Superior' },
    planPendiente: { nombre: 'Plan Inicial', desde: SIG.desde },
  })[1]?.nota);
chk('si la bajada rige en otra fecha no se nombra un plan que no es', 'Ya pago',
  datosDelPeriodo({
    periodo: { ...PER, siguiente: SIG }, plan: { nombre: 'Plan Superior' },
    planPendiente: { nombre: 'Plan Inicial', desde: '2026-11-15T03:00:00Z' },
  })[1]?.nota);
chk('sin el inicio guardado (cuenta vieja): "Hasta el …", sin inventar la fecha', 'Hasta el 31/10/2026',
  datosDelPeriodo({ periodo: { ...PER, desde: null, siguiente: SIG } })[0].valor);
chk('la pantalla usa esto y no arma el período a mano', true,
  /datosDelPeriodo\(sub\)\.map/.test(leer('src/pages/SubscriptionPage.jsx'))
  && !/sub\.periodo\.desde/.test(leer('src/pages/SubscriptionPage.jsx')));

/*
 * Al abrir o recargar la app, el primer pedido es GET /auth/me, y su 401 no
 * pasa por la redirección del interceptor (sería un loop). Si la sonda se
 * traga el código, el desplazado que recarga cae al login sin cartel. Se
 * prueba el camino de verdad: lib/http.js con su interceptor y
 * services/authService.js, con el adaptador de axios en lugar de la red.
 */
tit('11. EL MOTIVO TAMBIÉN AL ABRIR O RECARGAR LA APP (la sonda /auth/me)');
globalThis.window = { location: { pathname: '/dashboard', href: '/dashboard' } };
const { http } = await import('../src/lib/http.js');
const authService = await import('../src/services/authService.js');
const pedidos = [];
let respuesta = null;
http.defaults.adapter = async (config) => {
  pedidos.push(config.url);
  const { status, data } = respuesta;
  if (status === 0) throw Object.assign(new Error('Network Error'), { config, isAxiosError: true });
  if (status >= 200 && status < 300) return { data, status, statusText: 'OK', headers: {}, config };
  throw Object.assign(new Error(`HTTP ${status}`), {
    config, isAxiosError: true, response: { status, data, headers: {}, config },
  });
};
for (const codigo of ['SESION_DESPLAZADA', 'SESION_CERRADA_REMOTA', 'SESION_ANTERIOR']) {
  respuesta = { status: 401, data: { codigo, message: 'x' } };
  chk(`401 ${codigo} de /auth/me: sin sesión y con el motivo`, { me: null, motivo: `?motivo=${codigo}` },
    await authService.sondearSesion());
}
chk('la sonda pregunta a /auth/me', '/auth/me', pedidos.at(-1));
chk('y no recarga la página (el interceptor no redirige la sonda: no hay loop)', '/dashboard', window.location.href);
respuesta = { status: 401, data: { message: 'Token no proporcionado.' } };
chk('401 sin código (nunca entró): sin cartel', { me: null, motivo: '' }, await authService.sondearSesion());
respuesta = { status: 500, data: { codigo: 'SESION_DESPLAZADA' } };
chk('un 500 no es una sesión cerrada, aunque traiga un código', { me: null, motivo: '' },
  await authService.sondearSesion());
respuesta = { status: 0 };
chk('la red caída tampoco', { me: null, motivo: '' }, await authService.sondearSesion());
respuesta = { status: 200, data: { type: 'business', data: { id: 1 } } };
chk('con sesión: los datos y sin motivo', { me: { type: 'business', data: { id: 1 } }, motivo: '' },
  await authService.sondearSesion());
chk('getMe sigue devolviendo los datos', { type: 'business', data: { id: 1 } }, await authService.getMe());
respuesta = { status: 401, data: { codigo: 'SESION_DESPLAZADA' } };
chk('y null sin sesión, como antes (lo usan el login y el registro)', null, await authService.getMe());
chk('motivoDelRechazo sin respuesta no rompe', '', motivoDelRechazo(undefined));

// El cableado: la sonda al montar guarda el motivo y la puerta lo lleva al login.
const contexto = leer('src/context/AuthContext.jsx');
chk('AuthContext sondea con sondearSesion al montar y guarda el motivo', true,
  /sondearSesion\(\)\.then\(\(\{ me, motivo \}\) => \{\s*setMotivoCierre\(motivo\)/.test(contexto));
chk('  y lo borra cuando entra una sesión', true, /if \(me\) setMotivoCierre\(""\)/.test(contexto));
chk('ProtectedRoute lleva al login con el motivo', true,
  /<Navigate to=\{`\/login\$\{motivoCierre \|\| ""\}`\}/.test(leer('src/components/layout/ProtectedRoute.jsx')));

console.log(`\n─────────────────────────────\n  Pasaron: ${ok}   Fallaron: ${ko}`);
process.exit(ko ? 1 : 0);
