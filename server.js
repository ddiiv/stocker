/*
 * Servidor de producción del front.
 *
 * Hace dos cosas:
 *   1. Sirve el build estático de Vite (dist/).
 *   2. Reenvía /api/* al backend por la red privada de Railway.
 *
 * El segundo punto es el que permite que el backend no tenga dominio público:
 * el único servicio expuesto a internet es éste. Y como el front y la API
 * comparten origen, la cookie de sesión puede ser SameSite=Lax sin que el
 * navegador la trate como third-party.
 *
 * Ojo con la red privada de Railway: resuelve sólo por IPv6 y el DNS interno
 * tarda unos segundos en levantar cuando arranca el contenedor.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import { createProxyMiddleware } from 'http-proxy-middleware';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const DIST = path.join(__dirname, 'dist');

/*
 * El hash de los scripts embebidos del HTML.
 *
 * El único que hay es el que aplica el tema antes del primer pixel. Para poder
 * embeberlo sin abrir 'unsafe-inline' —el permiso que convierte una inyección
 * de HTML en ejecución de código, o sea renunciar a lo único que la política
 * aporta— se declara el hash exacto de ese bloque: se ejecuta ése y ningún
 * otro.
 *
 * Se calcula al arrancar leyendo el HTML que se va a servir de verdad, no el
 * del repo: Vite puede minificar el bloque al compilar, y un hash escrito a
 * mano en una constante rompe la página en silencio la primera vez que alguien
 * toque una línea del script.
 */
function hashesDeScripts(html) {
  const hashes = [];
  // Sólo los <script> SIN src: los que tienen src ya los cubre 'self'.
  const re = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m = re.exec(html);
  while (m) {
    if (m[1].trim()) {
      hashes.push(`'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
    }
    m = re.exec(html);
  }
  return hashes;
}

let SCRIPT_HASHES = [];
try {
  SCRIPT_HASHES = hashesDeScripts(fs.readFileSync(path.join(DIST, 'index.html'), 'utf8'));
} catch (e) {
  /*
   * Sin poder leer el HTML no se inventan permisos: se sirve con la política
   * estricta y, si algo queda bloqueado, se ve en la consola. La alternativa
   * —abrir 'unsafe-inline' por las dudas— dejaría la política inservible justo
   * cuando ya falló algo.
   */
  console.warn(`  No se pudo calcular el hash de los scripts embebidos: ${e.message}`);
}

/*
 * Puerto en el que escucha el front.
 *
 * Acá PORT gana sobre FRONTEND_PORT, al revés que en el backend: este servicio
 * sí tiene dominio público, y el edge de Railway enruta al puerto que inyecta.
 * Ignorarlo dejaría la app inalcanzable desde afuera.
 */
const PORT = Number(process.env.PORT || process.env.FRONTEND_PORT) || 8080;

/*
 * Destino del proxy: el backend, por la red privada.
 *
 * Se resuelve por orden de precisión:
 *   1. API_INTERNAL_URL — la URL entera. Es la más directa y la que conviene
 *      cuando algo no resuelve.
 *   2. BACKEND_DOMAIN + BACKEND_PORT.
 *
 * En desarrollo cae a localhost:3000. En producción NO: antes lo hacía, y
 * convertía una variable sin cargar en un ECONNREFUSED contra localhost que no
 * decía nada sobre la causa real. Ahora avisa qué miró y qué encontró.
 *
 * Ojo con las referencias anidadas de Railway: una variable compartida que a su
 * vez apunta a otro servicio (shared.BACKEND_DOMAIN = ${{svc.RAILWAY_PRIVATE_DOMAIN}})
 * puede quedar sin resolver y llegar vacía. Si pasa eso, lo más corto es poner
 * API_INTERNAL_URL a mano.
 */
function destinoApi() {
  if (process.env.API_INTERNAL_URL) {
    return process.env.API_INTERNAL_URL.replace(/\/+$/, '');
  }

  const dominio = (process.env.BACKEND_DOMAIN || '').trim().replace(/\/+$/, '');
  const puerto = process.env.BACKEND_PORT || '3000';

  if (!dominio) {
    const enProduccion = process.env.NODE_ENV === 'production';
    console.error('');
    console.error('  ✖ No se pudo resolver a dónde está el backend.');
    console.error('');
    console.error('    API_INTERNAL_URL .. ' + (process.env.API_INTERNAL_URL || '(vacío)'));
    console.error('    BACKEND_DOMAIN .... (vacío)');
    console.error('    BACKEND_PORT ...... ' + (process.env.BACKEND_PORT || '(vacío)'));
    console.error('');
    console.error('    Si BACKEND_DOMAIN viene de una variable compartida que');
    console.error('    referencia a otro servicio, puede no estar resolviendo.');
    console.error('    Lo más corto es cargar en ESTE servicio:');
    console.error('');
    console.error('      API_INTERNAL_URL=http://<servicio-backend>.railway.internal:3000');
    console.error('');
    if (enProduccion) {
      console.error('    Sin eso no hay a dónde reenviar /api, así que el servicio no arranca.');
      console.error('');
      process.exit(1);
    }
    console.error('    En desarrollo se usa http://localhost:3000.');
    console.error('');
    return 'http://localhost:3000';
  }

  if (/^https?:\/\//i.test(dominio)) {
    return /:\d+$/.test(dominio) ? dominio : `${dominio}:${puerto}`;
  }
  return /:\d+$/.test(dominio) ? `http://${dominio}` : `http://${dominio}:${puerto}`;
}

const API_TARGET = destinoApi();

app.disable('x-powered-by');
// Railway termina TLS en su edge y reenvía al contenedor por http, contándolo
// en X-Forwarded-Proto. Sin esto req.secure siempre daría false.
app.set('trust proxy', 1);
app.use(compression());

// Antes de la redirección a https: el healthcheck de Railway pega por http
// dentro de la red, y un 308 lo haría fallar.
app.get('/healthz', (req, res) => res.json({ ok: true, apiTarget: API_TARGET }));

// Railway ya redirige http→https en el edge, pero si algún día se sirve por
// otro lado esto evita que un request en claro llegue a ver la app.
const FORZAR_HTTPS = process.env.NODE_ENV === 'production';

app.use((req, res, next) => {
  if (FORZAR_HTTPS && !req.secure) {
    return res.redirect(308, `https://${req.headers.host}${req.originalUrl}`);
  }

  // HSTS: el navegador deja de intentar http para este dominio, así que ni
  // siquiera manda el request que después habría que redirigir. Sólo tiene
  // sentido anunciarlo sobre una conexión ya segura.
  if (req.secure) {
    /*
     * Dos años, no uno.
     *
     * `max-age` es cuánto tiempo el navegador RECUERDA que este dominio es
     * sólo-HTTPS. Con un año, alguien que no entra en trece meses vuelve a
     * hacer un primer pedido en claro; con dos, en la práctica no se olvida
     * nunca, porque nadie usa un sistema de gestión con esa frecuencia.
     *
     * Dos años es además el mínimo que pide la lista de precarga de los
     * navegadores. No estamos inscriptos —eso compromete el dominio y TODOS
     * sus subdominios a HTTPS de forma muy difícil de revertir, y conviene
     * esperar a que el dominio esté quieto— pero dejarlo en el valor que esa
     * lista exige es gratis y deja la puerta abierta.
     */
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // La app no se embebe en ningún lado: bloquear iframes evita clickjacking
  // sobre el punto de venta.
  res.setHeader('X-Frame-Options', 'DENY');
  
  /*
   * ── Política de Seguridad de Contenido ──────────────────────────
   *
   * Es la defensa que queda en pie cuando algo falla en otro lado. Si un día se
   * cuela HTML de un tercero —el nombre de un comprador de Mercado Libre, el
   * texto de un mensaje, el título de una publicación— sin CSP ese HTML puede
   * traer un <script> y correr con la sesión de quien esté en la caja.
   *
   * Se arranca de `default-src 'none'` y se abre sólo lo necesario: al revés
   * —permitir todo y prohibir algunos— la lista se queda vieja el día que
   * alguien agrega una dependencia.
   *
   * Sin 'unsafe-inline' en script-src, que es el permiso que convierte una
   * inyección de HTML en ejecución de código. Se puede porque el build de Vite
   * no deja ni un script embebido, y porque el script que aplica el tema antes
   * de pintar se movió a /tema.js justamente para no necesitarlo.
   *
   * Queda UNA sola apertura que no es 'self', y es a conciencia:
   *
   *   · 'wasm-unsafe-eval' — el lector de códigos por cámara. En Safari y
   *     Firefox no existe BarcodeDetector nativo y se cae a un decodificador
   *     WebAssembly, y compilar WebAssembly necesita ese permiso. Es MUCHO más
   *     angosto que 'unsafe-eval': habilita compilar wasm, no evaluar texto
   *     como código. Sacarlo dejaría el escáner del teléfono muerto en la mitad
   *     de los navegadores, que es peor cambio que el margen de seguridad que
   *     se gana.
   */
  res.setHeader('Content-Security-Policy', [
    "default-src 'none'",
    ["script-src 'self' 'wasm-unsafe-eval'", ...SCRIPT_HASHES].join(' '),
    "style-src 'self'",
    "font-src 'self'",
    // `blob:` para las fotos que se sacan con la cámara antes de subirlas.
    "img-src 'self' data: blob:",
    // El <video> del escáner y los PDF que se abren desde memoria.
    "media-src 'self' blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    'upgrade-insecure-requests',
  ].join('; '));

  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  /*
   * Permisos del navegador.
   *
   * `camera=(self)` es la única que queda prendida y es a propósito: el
   * escaneo de códigos con el teléfono es una función de la app. Todo lo demás
   * se apaga, así que una dependencia no puede prender el micrófono ni leer la
   * ubicación sin que nadie lo pida.
   */
  res.setHeader('Permissions-Policy', [
    'accelerometer=()', 'autoplay=()', 'camera=(self)', 'display-capture=()',
    'encrypted-media=()', 'fullscreen=(self)', 'geolocation=()', 'gyroscope=()',
    'magnetometer=()', 'microphone=()', 'midi=()', 'payment=()',
    'publickey-credentials-get=()', 'screen-wake-lock=()', 'usb=()',
    'xr-spatial-tracking=()',
  ].join(', '));

next();
});

// Se monta en la raíz con pathFilter en vez de app.use('/api', ...): Express
// recorta el prefijo al montar sobre una ruta y el backend terminaría
// recibiendo /auth/login en lugar de /api/auth/login.
app.use(createProxyMiddleware({
  pathFilter: '/api',
  target: API_TARGET,
  changeOrigin: true,
  xfwd: true,              // preserva la IP real del cliente para el backend
  proxyTimeout: 30_000,
  timeout: 30_000,
  on: {
    error(err, req, res) {
      // El código del error es lo que dice qué pasó; err.message a veces
      // viene vacío y deja el log sin información útil.
      const causas = {
        ECONNREFUSED: 'el backend no está escuchando en ese puerto (¿se cayó al arrancar? ¿PORT distinto?)',
        ENOTFOUND:    'no resuelve el nombre del servicio (¿API_INTERNAL_URL bien escrito? ¿mismo proyecto y environment?)',
        ETIMEDOUT:    'el backend no respondió a tiempo',
        ECONNRESET:   'el backend cortó la conexión',
        EAI_AGAIN:    'falló la resolución DNS interna (suele ser transitorio al arrancar el contenedor)',
      };
      const detalle = causas[err.code] || err.message || 'motivo desconocido';
      console.error(`[proxy] ${req.method} ${req.url} → ${err.code || 'ERROR'}: ${detalle}`);
      console.error(`[proxy] destino configurado: ${API_TARGET}`);

      if (res && !res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'No se pudo contactar a la API.' }));
      }
    },
  },
}));

// Los assets con hash en el nombre son inmutables; index.html nunca se cachea
// para que un deploy nuevo no quede servido desde la caché del navegador.
app.use(express.static(DIST, {
  index: false,
  setHeaders(res, filePath) {
    if (filePath.includes(`${path.sep}assets${path.sep}`)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

/*
 * SPA: cualquier ruta que no sea archivo ni API la resuelve React Router.
 * Va como middleware sin patrón porque Express 5 ya no acepta '*' suelto.
 *
 * Pero si el pedido PARECE un archivo —tiene extensión— y no lo sirvió el
 * estático de arriba, entonces no existe y se contesta 404. Devolver el HTML
 * de la app con un 200 para `/server.js`, `/.env` o `/package.json` es la
 * respuesta más confusa posible: quien sondea el sitio ve un 200 y concluye
 * que el archivo está ahí, y un asset mal tipeado llega al navegador como HTML
 * y revienta con "unexpected token '<'" en vez de un 404 legible.
 */
app.use((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (/\.[a-z0-9]{1,8}$/i.test(req.path)) {
    return res.status(404).type('text/plain').send('No encontrado.');
  }
  return res.sendFile(path.join(DIST, 'index.html'));
});

const server = app.listen(PORT, '::', () => {
  // Si el listen falló, address() es null y leerlo tira encima del error real,
  // tapándolo. El handler de 'error' de abajo es el que informa qué pasó.
  const dir = server.address();
  if (!dir) return;
  const origenPuerto = process.env.PORT ? 'PORT' : process.env.FRONTEND_PORT ? 'FRONTEND_PORT' : 'valor por defecto';
  const origenApi = process.env.API_INTERNAL_URL ? 'API_INTERNAL_URL' :
                    process.env.BACKEND_DOMAIN ? 'BACKEND_DOMAIN + BACKEND_PORT' : 'valor por defecto';
  console.log('─────────────────────────────────────────');
  console.log(`  Front escuchando en ${dir.address}:${dir.port}  (puerto de ${origenPuerto})`);
  console.log(`  Proxy /api → ${API_TARGET}  (de ${origenApi})`);
  console.log('─────────────────────────────────────────');
});

server.on('error', (err) => {
  const detalle = err.code === 'EADDRINUSE'
    ? `el puerto ${PORT} ya está ocupado por otro proceso`
    : err.code || err.message;
  console.error(`✖ No se pudo escuchar en el puerto ${PORT}: ${detalle}`);
  process.exit(1);
});

/*
 * Apagado ordenado: Railway manda SIGTERM en cada deploy.
 *
 * Sin escucharlo, Node muere por la señal y npm lo reporta como si el comando
 * hubiera fallado:
 *
 *   npm error command failed
 *   npm error signal SIGTERM
 *
 * No falló nada — es un reinicio normal— pero queda escrito como error en cada
 * deploy, y a fuerza de aparecer entrena a no mirar los logs. El día que haya
 * un error de verdad va a estar abajo de ése.
 *
 * Se cierra el servidor, se deja terminar lo que esté en vuelo y se sale con
 * cero, que es lo que npm entiende como "terminó bien".
 *
 * El plazo existe porque `close()` espera a que se cierren todas las conexiones
 * abiertas, y una que quedó colgada dejaría el contenedor sin salir hasta que
 * la plataforma lo mate a la fuerza — volviendo al mismo mensaje.
 */
function apagar(senal) {
  console.log(`Recibido ${senal}: cerrando el servidor.`);
  const plazo = setTimeout(() => {
    console.warn('  Quedaron conexiones abiertas: se sale igual.');
    process.exit(0);
  }, 10000);
  plazo.unref();

  server.close(() => {
    clearTimeout(plazo);
    console.log('  Servidor cerrado.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => apagar('SIGTERM'));
process.on('SIGINT',  () => apagar('SIGINT'));
