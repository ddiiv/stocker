/*
 * Servidor de la página pública.
 *
 * Hace dos cosas, y la segunda es la que importa:
 *
 *   1. Sirve index.html.
 *   2. Reenvía /api al backend por la red privada.
 *
 * Sin el punto 2, la página no tiene a quién preguntarle los precios ni el
 * contacto, así que lo que se cambia en el backoffice no llega nunca — que es
 * exactamente lo que pasaba cuando esto se servía como archivo suelto. Con el
 * proxy, además, el pedido es del mismo origen y no hay CORS en el medio.
 *
 * La página funciona igual si el backend está caído: trae los valores escritos
 * en el HTML como respaldo. Una página comercial que muestra "cargando…" porque
 * se cayó un backend es peor que una desactualizada.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import { createProxyMiddleware } from 'http-proxy-middleware';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const PORT = Number(process.env.PORT || process.env.LANDING_PORT) || 8082;

/*
 * A dónde está el backend. Mismo criterio que los otros servicios: la URL
 * entera en API_INTERNAL_URL, o BACKEND_DOMAIN + BACKEND_PORT.
 *
 * Acá NO se corta el arranque si falta: a diferencia de la app y el backoffice,
 * esta página se sostiene sola con los valores del HTML. Dejarla caída por no
 * poder actualizar un teléfono sería perder visitas por un problema menor.
 */
function destinoApi() {
  if (process.env.API_INTERNAL_URL) return process.env.API_INTERNAL_URL.replace(/\/+$/, '');

  const dominio = (process.env.BACKEND_DOMAIN || '').trim().replace(/\/+$/, '');
  if (!dominio) return null;

  const puerto = process.env.BACKEND_PORT || '3000';
  if (/^https?:\/\//i.test(dominio)) {
    return /:\d+$/.test(dominio) ? dominio : `${dominio}:${puerto}`;
  }
  return /:\d+$/.test(dominio) ? `http://${dominio}` : `http://${dominio}:${puerto}`;
}

const API_TARGET = destinoApi();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(compression());

app.get('/healthz', (req, res) => res.json({ ok: true, apiTarget: API_TARGET }));

const FORZAR_HTTPS = process.env.NODE_ENV === 'production';

app.use((req, res, next) => {
  if (FORZAR_HTTPS && !req.secure) {
    return res.redirect(308, `https://${req.headers.host}${req.originalUrl}`);
  }
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

/*
 * Sólo se reenvía /api/public.
 *
 * Es la única parte de la API que esta página necesita, y es la única sin
 * sesión. Reenviar todo /api convertiría a un sitio público en una puerta más
 * hacia el login y los endpoints del backoffice, sin ninguna razón.
 */
if (API_TARGET) {
  app.use(createProxyMiddleware({
    pathFilter: '/api/public',
    target: API_TARGET,
    changeOrigin: true,
    xfwd: true,
    proxyTimeout: 8000,
    timeout: 8000,
    on: {
      error(err, req, res) {
        // No se responde con un error visible: la página ya tiene los datos
        // escritos y este pedido es una mejora, no un requisito.
        console.warn(`[proxy] ${req.url} → ${err.code || 'ERROR'} (la página usa sus valores por defecto)`);
        if (res && !res.headersSent) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Sin datos en vivo.' }));
        }
      },
    },
  }));
}

app.use(express.static(__dirname, {
  index: false,
  extensions: ['html'],
}));

/*
 * Cualquier otro /api no existe acá.
 *
 * Sin esto caía en el fallback de abajo y devolvía el HTML de la página con un
 * 200, que es la respuesta más confusa posible: quien esté probando cree que el
 * endpoint existe y devuelve basura.
 */
app.use('/api', (req, res) => res.status(404).json({ message: 'No encontrado.' }));

// El HTML nunca se cachea: un cambio de precio tiene que verse en la próxima
// visita, no cuando al navegador se le ocurra.
app.use((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = app.listen(PORT, '::', () => {
  const dir = server.address();
  if (!dir) return;
  console.log('─────────────────────────────────────────');
  console.log(`  Página pública en ${dir.address}:${dir.port}`);
  console.log(`  Datos en vivo .. ${API_TARGET
    ? `sí, vía ${API_TARGET}`
    : '✖ no — sin API_INTERNAL_URL ni BACKEND_DOMAIN, la página usa los valores del HTML'}`);
  console.log('─────────────────────────────────────────');
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE'
    ? `El puerto ${PORT} ya está ocupado.`
    : `No se pudo iniciar: ${err.message}`);
  process.exit(1);
});
