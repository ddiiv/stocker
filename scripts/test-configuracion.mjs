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
  esMovil, ordenarActivas, textoDelLimite, estadoDeTerminos, proximoCobro,
} from '../src/utils/cuenta.js';
import { AVISOS_DE_CIERRE, motivoParaLogin, avisoDeCierre } from '../src/utils/motivosSesion.js';

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

console.log(`\n─────────────────────────────\n  Pasaron: ${ok}   Fallaron: ${ko}`);
process.exit(ko ? 1 : 0);
