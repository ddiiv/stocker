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
