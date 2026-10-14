/*
 * Plataformas: quién ve qué pestaña, cómo se dice el estado de cada conexión,
 * cuándo se muestra la bandeja mayorista y que las direcciones viejas sigan
 * andando.
 *
 * Es la lógica de las pantallas sin las pantallas (utils/plataformas.js), más
 * una lectura del armado: que el menú, las rutas y las pestañas digan lo
 * mismo. Corre con node, sin navegador.
 *
 * Uso:  node scripts/test-plataformas.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  PESTANAS_PLATAFORMAS, PERMISOS_PLATAFORMAS, pestanasDePlataformas, puedeVerPlataformas,
  puedePedirCotizacion, destinoDeRutaVieja, RUTAS_VIEJAS, textoDeEstado, muestraBandejaMayorista,
  validarCotizacion, avisoDeUso, ultimaCotizacion,
} from '../src/utils/plataformas.js';

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
const emp = (permisos) => ({ type: 'employee', id: 9, permisos });
const VENTAS = emp({ ventas: 'editar' });
const INTEGR_VER = emp({ integraciones: 'ver' });
const INTEGR_EDITAR = emp({ integraciones: 'editar' });
const NADA = emp({ clientes: 'ver' });
// Un cargo viejo sin la clave `integraciones` la hereda de stock (permissions.js).
const STOCK_VIEJO = emp({ stock: 'ver' });

tit('1. QUIÉN VE QUÉ PESTAÑA');
chk('el dueño ve las cinco', ['/plataformas', '/plataformas/mercadolibre', '/plataformas/jumpseller', '/plataformas/tienda', '/plataformas/mayoristas'],
  pestanasDePlataformas(DUENIO).map((t) => t.to));
chk('un vendedor: Resumen y Mayoristas (la bandeja de siempre)', ['/plataformas', '/plataformas/mayoristas'],
  pestanasDePlataformas(VENTAS).map((t) => t.to));
chk('integraciones sin ventas: todo menos Mayoristas', ['/plataformas', '/plataformas/mercadolibre', '/plataformas/jumpseller', '/plataformas/tienda'],
  pestanasDePlataformas(INTEGR_VER).map((t) => t.to));
chk('un cargo sin ninguno de los dos no ve nada', [], pestanasDePlataformas(NADA));
chk('sin sesión, nada', [], pestanasDePlataformas(null));
chk('quién entra a la sección', [true, true, true, false, true],
  [DUENIO, VENTAS, INTEGR_VER, NADA, STOCK_VIEJO].map(puedeVerPlataformas));
chk('se entra con integraciones o con ventas', ['integraciones', 'ventas'], PERMISOS_PLATAFORMAS);

tit('2. QUIÉN PIDE LA COTIZACIÓN (igual que el backend)');
chk('el dueño y integraciones en edición sí; ver, ventas y nada, no', [true, true, false, false, false],
  [DUENIO, INTEGR_EDITAR, INTEGR_VER, VENTAS, NADA].map(puedePedirCotizacion));
const ruta = leer('../../back/stocker/src/routes/index.js');
chk('el backend pide lo mismo: integraciones en edición', true,
  /r\.post\('\/plataformas\/cotizaciones',\s*requireAuth,\s*requirePermission\('integraciones',\s*'editar'\)/.test(ruta));
chk('y el estado lo ve quien tiene integraciones o ventas', true,
  /r\.get \('\/plataformas',\s*requireAuth,\s*requireAnyPermission\(\['integraciones', 'ventas'\], 'ver'\)/.test(ruta));

tit('3. LAS DIRECCIONES VIEJAS');
chk('Mercado Libre, con la query del regreso intacta', '/plataformas/mercadolibre?ml_ok=1',
  destinoDeRutaVieja('/integraciones/mercadolibre', '?ml_ok=1'));
chk('   y con el error de Mercado Libre', '/plataformas/mercadolibre?ml_error=Algo%20fall%C3%B3',
  destinoDeRutaVieja('/integraciones/mercadolibre', '?ml_error=Algo%20fall%C3%B3'));
chk('Jumpseller', '/plataformas/jumpseller', destinoDeRutaVieja('/integraciones/jumpseller'));
chk('Pedidos mayoristas, con el ancla', '/plataformas/mayoristas#x', destinoDeRutaVieja('/pedidos-mayoristas', '', '#x'));
chk('una dirección que no es vieja no se toca', null, destinoDeRutaVieja('/stock'));

const app = leer('src/App.jsx');
for (const vieja of Object.keys(RUTAS_VIEJAS)) {
  chk(`App.jsx: ${vieja} redirige con RedirigirRutaVieja`, true,
    new RegExp(`path="${vieja.replace(/\//g, '\\/')}"\\s+element={<RedirigirRutaVieja />}`).test(app));
}
const redirigir = leer('src/components/layout/RedirigirRutaVieja.jsx');
chk('RedirigirRutaVieja pasa search y hash', true, /destinoDeRutaVieja\(pathname, search, hash\)/.test(redirigir));
const ml = leer('../../back/stocker/src/controllers/mercadolibreController.js');
chk('el backend vuelve de Mercado Libre a la dirección nueva', 2, (ml.match(/res\.redirect\(`\/plataformas\/mercadolibre\?/g) || []).length);
chk('   y a la vieja ya no', 0, (ml.match(/redirect\(`\/integraciones\/mercadolibre/g) || []).length);

tit('4. LAS RUTAS, LAS PESTAÑAS Y EL MENÚ DICEN LO MISMO');
// Cada pestaña existe como ruta hija, con la puerta del permiso que dice la pestaña.
const hijas = {
  '/plataformas/mercadolibre': /path="mercadolibre"\s+element={<PermissionRoute permission="integraciones">/,
  '/plataformas/jumpseller': /path="jumpseller"\s+element={<PermissionRoute permission="integraciones">/,
  '/plataformas/tienda': /path="tienda"\s+element={<PermissionRoute permission="integraciones">/,
  '/plataformas/mayoristas': /path="mayoristas"\s+element={<PermissionRoute permission="ventas">/,
};
for (const t of PESTANAS_PLATAFORMAS.filter((x) => x.to !== '/plataformas')) {
  chk(`${t.to}: ruta con la puerta de ${t.permisos.join('/')}`, true, hijas[t.to]?.test(app) === true);
}
chk('la sección entera pide integraciones o ventas', true,
  /path="\/plataformas" element={<PermissionRoute permission={PERMISOS_PLATAFORMAS}>/.test(app));
chk('Pedidos mayoristas sigue con ventas (no con integraciones)', ['ventas'],
  PESTANAS_PLATAFORMAS.find((t) => t.to === '/plataformas/mayoristas').permisos);
const permRoute = leer('src/components/layout/PermissionRoute.jsx');
chk('PermissionRoute acepta una lista de permisos (alcanza con uno)', true,
  /permisos\.some\(/.test(permRoute));
chk('quien sólo tiene integraciones rebota a Plataformas, no a la ruta vieja', true,
  /integraciones: "\/plataformas"/.test(permRoute));

const sidebar = leer('src/components/layout/Sidebar.jsx');
chk('el menú tiene UN ítem Plataformas', 1, (sidebar.match(/label: "Plataformas"/g) || []).length);
chk('   que se ve con integraciones o ventas', true, /to: "\/plataformas", label: "Plataformas", icon: Plug, permisos: PERMISOS_PLATAFORMAS/.test(sidebar));
chk('   y ya no están los tres ítems sueltos', [false, false, false],
  ['/integraciones/mercadolibre', '/integraciones/jumpseller', '/pedidos-mayoristas'].map((r) => sidebar.includes(`to: "${r}"`)));
chk('el grupo se llama "Negocio" (no "Configuración")', [true, false],
  [/titulo: "Negocio"/.test(sidebar), /titulo: "Configuración"/.test(sidebar)]);
chk('el menú sabe mirar una lista de permisos', true, /l\.permisos\.some\(\(p\) => canView\(user, p\)\)/.test(sidebar));

// Nadie más apunta a las direcciones viejas: sólo la tabla de redirecciones y App.jsx.
const archivos = [];
const recorrer = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) recorrer(p);
    else if (/\.(jsx?|mjs)$/.test(f)) archivos.push(p);
  }
};
recorrer(path.join(aqui, '..', 'src'));
const conViejas = archivos
  .filter((f) => /["'`]\/(integraciones\/(mercadolibre|jumpseller)|pedidos-mayoristas)/.test(readFileSync(f, 'utf8')))
  .map((f) => path.relative(path.join(aqui, '..'), f)).sort();
chk('nadie más enlaza a las direcciones viejas', ['src/App.jsx', 'src/utils/plataformas.js'], conViejas);

tit('5. CÓMO SE DICE EL ESTADO');
const PRO = { codigo: 'pro', nombre: 'Plan Pro' };
chk('conectada', ['Conectada', 'ok'], Object.values(textoDeEstado({ estado: 'conectada' })));
chk('conectada por herencia lo aclara', 'Conectada (la conservás de antes)', textoDeEstado({ estado: 'conectada', heredada: true }).texto);
chk('sin conectar', ['No conectada', 'neutro'], Object.values(textoDeEstado({ estado: 'sin_conectar' })));
chk('Inicial sin credencial: "Disponible desde el Plan Pro"', ['Disponible desde el Plan Pro', 'plan'],
  Object.values(textoDeEstado({ estado: 'requiere_plan', desde: PRO })));
chk('conectada fuera del plan avisa en rojo', 'alerta', textoDeEstado({ estado: 'fuera_de_plan', desde: PRO }).tono);
chk('   y dice desde qué plan', true, textoDeEstado({ estado: 'fuera_de_plan', desde: PRO }).texto.includes('Plan Pro'));
chk('el plan sale de la respuesta, no está escrito', 'Disponible desde el Plan Superior',
  textoDeEstado({ estado: 'requiere_plan', desde: { nombre: 'Plan Superior' } }).texto);

tit('6. CUÁNDO SE MUESTRA LA BANDEJA MAYORISTA');
const estadoCon = (mayorista, total = 0) => ({ plataformas: [{ clave: 'mayorista', ...mayorista }], mayoristas: { pendientes: 0, total } });
chk('portal conectado sin ningún pedido todavía: la bandeja (decide la credencial)', true,
  muestraBandejaMayorista(estadoCon({ conectada: true }, 0)));
chk('sin portal y sin pedidos: la explicación y la cotización', false,
  muestraBandejaMayorista(estadoCon({ conectada: false }, 0)));
chk('sin portal pero con pedidos de antes: la bandeja sigue (no se esconden datos)', true,
  muestraBandejaMayorista(estadoCon({ conectada: false }, 3)));
const mayoristas = leer('src/pages/plataformas/MayoristasPage.jsx');
chk('si no se puede leer el estado, se muestra la bandeja igual', true,
  /if \(fallo\) return <PedidosMayoristasPage \/>;/.test(mayoristas));
chk('la pantalla de siempre se reusa, no se reescribe', true,
  /import PedidosMayoristasPage from "\.\.\/PedidosMayoristasPage";/.test(mayoristas));

tit('7. LA COTIZACIÓN, ANTES DE MANDARLA');
chk('detalle corto: se avisa', true, Boolean(validarCotizacion({ detalle: 'un portal' })));
chk('detalle suficiente: pasa', null, validarCotizacion({ detalle: 'Vendemos por mayor a cuarenta locales del interior.' }));
chk('email mal escrito: se avisa', 'Ese email no parece válido.',
  validarCotizacion({ detalle: 'Vendemos por mayor a cuarenta locales del interior.', contactoEmail: 'no-es-mail' }));
chk('email vacío: pasa (se usa el de la cuenta)', null,
  validarCotizacion({ detalle: 'Vendemos por mayor a cuarenta locales del interior.', contactoEmail: '' }));
chk('el último pedido de cada tipo', [2, null],
  [ultimaCotizacion({ cotizaciones: [{ id: 2, tipo: 'portal_mayorista' }, { id: 1, tipo: 'portal_mayorista' }] }, 'portal_mayorista')?.id,
    ultimaCotizacion({ cotizaciones: [] }, 'tienda_propia')]);

tit('8. UNA CONEXIÓN CALLADA');
const AHORA = new Date('2026-10-14T12:00:00Z').getTime();
const DIA = 24 * 60 * 60 * 1000;
const conUso = (dias) => ({ conectada: true, detalle: { ultimoUso: new Date(AHORA - dias * DIA).toISOString() } });
chk('usada hace un día: nada que avisar', null, avisoDeUso(conUso(1), AHORA));
chk('tres días sin noticias: se avisa', true, /3 días/.test(avisoDeUso(conUso(3), AHORA) || ''));
chk('nunca usada: se avisa', true, Boolean(avisoDeUso({ conectada: true, detalle: {} }, AHORA)));
chk('sin conectar: no aplica', null, avisoDeUso({ conectada: false }, AHORA));

tit('9. NINGÚN TOKEN EN LA PANTALLA');
const pantallas = ['src/pages/plataformas/ResumenPage.jsx', 'src/pages/plataformas/TiendaPropiaPage.jsx',
  'src/pages/plataformas/MayoristasPage.jsx', 'src/services/plataformasService.js'].map(leer).join('\n');
chk('las pantallas nuevas no leen token, hash ni pista', false, /\.(token|tokenHash|pista|accessToken|refreshToken|loginKey|authToken)\b/.test(pantallas));

console.log(`\n${ok} ok · ${ko} fallas`);
process.exit(ko ? 1 : 0);
