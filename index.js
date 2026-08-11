require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const path         = require('path');
const fse       = require('fs-extra');
const sequelize = require('./src/config/database');
require('./src/models'); // carga asociaciones

const routes              = require('./src/routes');
const { errorHandler, notFound } = require('./src/middleware/errorHandler');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS ─────────────────────────────────────────────────────────
// Se aceptan: FRONTEND_URL exacto (env), los dominios de Railway y Vercel,
// cualquier tunnel de ngrok, y localhost. Requests sin Origin (curl, health
// checks, mismo dominio) pasan libres.
//
// Sirviendo el front y la API desde el mismo origen esto casi no interviene,
// pero el navegador sí manda Origin en los POST same-origin: sin el patrón de
// Railway, el login en producción moriría con 500 antes de llegar al handler.
const CORS_STATIC_ORIGINS = (process.env.FRONTEND_URL || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const CORS_ORIGIN_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  // Cubre tanto proyecto.railway.app como proyecto.up.railway.app.
  /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.railway\.app$/i,
  /^https:\/\/[a-z0-9-]+\.vercel\.app$/i,
  /^https:\/\/[a-z0-9-]+\.ngrok-free\.app$/i,
  /^https:\/\/[a-z0-9-]+\.ngrok\.app$/i,
  /^https:\/\/[a-z0-9-]+\.ngrok\.io$/i,
];
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // curl / same-origin / health checks
    if (CORS_STATIC_ORIGINS.includes(origin)) return cb(null, true);
    if (CORS_ORIGIN_PATTERNS.some((rx) => rx.test(origin))) return cb(null, true);
    console.warn(`[cors] Origen rechazado: ${origin}`);
    cb(new Error(`CORS: origen no permitido (${origin})`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'ngrok-skip-browser-warning'],
}));

// Detrás del proxy de Railway: sin esto, req.ip devuelve la IP del proxy y
// las cookies Secure no se emiten porque Express cree que la conexión es http.
app.set('trust proxy', 1);
// No anunciar el framework: le ahorra a un atacante saber contra qué apuntar.
app.disable('x-powered-by');

app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Carpeta de PDFs accesible estáticamente
const pdfDir = process.env.PDF_STORAGE_PATH || path.join(__dirname, 'storage/pdfs');
fse.ensureDirSync(pdfDir);
app.use('/storage/pdfs', express.static(pdfDir));

// ── Rutas ─────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ message: 'Stocker API v2 ✔', status: 'ok' }));
const { apiLimiter } = require('./src/middleware/rateLimit');
app.use('/api', apiLimiter, routes);

// ── 404 y errores ─────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ── Arranque ──────────────────────────────────────────────────────
async function start() {
  try {
    await sequelize.authenticate();
    console.log('✔ Conectado a la base de datos.');

    // Crea las tablas que falten. Con alter:false NO toca las existentes:
    // solo ejecuta CREATE TABLE IF NOT EXISTS, así que es seguro correrlo en
    // cada arranque. Sin esto, un deploy con modelos nuevos rompe con
    // "relation ... does not exist" hasta que alguien corra db:sync a mano.
    if (process.env.DB_AUTO_SYNC !== 'false') {
      await sequelize.sync({ alter: false, logging: false });
      // sync no agrega columnas a tablas que ya existen: eso lo cubre este paso.
      const { ensureColumns } = require('./src/database/ensureColumns');
      const nuevas = await ensureColumns(sequelize);
      console.log(`✔ Esquema verificado${nuevas.length ? ` — columnas agregadas: ${nuevas.join(', ')}` : ''}.`);
    }

    // La red privada de Railway es IPv6: si el server sólo escucha en 0.0.0.0,
    // `backend.railway.internal` no resuelve a nada y el proxy da ECONNREFUSED.
    // Con '::' Linux acepta también IPv4 mapeado, así que no perdemos nada.
    app.listen(PORT, '::', () => {
      console.log(`✔ Stocker API corriendo en el puerto ${PORT} (IPv4 + IPv6)`);
      console.log(`  PDFs en: ${pdfDir}`);
    });
  } catch (error) {
    console.error('✖ No se pudo conectar a la base de datos:', error.message);
    process.exit(1);
  }
}

start();
