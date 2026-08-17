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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import { createProxyMiddleware } from 'http-proxy-middleware';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const DIST = path.join(__dirname, 'dist');

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
 * Se puede dar entero en API_INTERNAL_URL, o armarlo con las variables
 * compartidas del proyecto (BACKEND_DOMAIN + BACKEND_PORT). Como BACKEND_PORT
 * es la misma variable que usa el backend para elegir su puerto, los dos
 * coinciden solos y desaparece el desencuentro clásico de "escucha en un
 * puerto y le hablo a otro".
 *
 * BACKEND_DOMAIN puede venir como host pelado o como URL. Dentro de la red
 * privada se usa http: el tráfico no sale de Railway y no hay TLS.
 */
function destinoApi() {
  if (process.env.API_INTERNAL_URL) return process.env.API_INTERNAL_URL.replace(/\/+$/, '');

  const dominio = (process.env.BACKEND_DOMAIN || '').trim().replace(/\/+$/, '');
  if (!dominio) return 'http://localhost:3000';

  const puerto = process.env.BACKEND_PORT || '3000';
  // Si ya trae protocolo, respetamos lo que puso el usuario.
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
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // La app no se embebe en ningún lado: bloquear iframes evita clickjacking
  // sobre el punto de venta.
  res.setHeader('X-Frame-Options', 'DENY');
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

// SPA: cualquier ruta que no sea archivo ni API la resuelve React Router.
// Va como middleware sin patrón porque Express 5 ya no acepta '*' suelto.
app.use((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(DIST, 'index.html'));
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
