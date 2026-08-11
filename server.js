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
const PORT = process.env.PORT || 8080;
const DIST = path.join(__dirname, 'dist');

// En Railway: http://<nombre-del-servicio>.railway.internal:3000
const API_TARGET = process.env.API_INTERNAL_URL || 'http://localhost:3000';

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
      console.error(`[proxy] ${req.method} ${req.url} → ${err.message}`);
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

app.listen(PORT, '::', () => {
  console.log(`✔ Front sirviendo en el puerto ${PORT}`);
  console.log(`  API interna: ${API_TARGET}`);
});
