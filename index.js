require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const fse       = require('fs-extra');
const sequelize = require('./src/config/database');
require('./src/models'); // carga asociaciones

const routes              = require('./src/routes');
const { errorHandler, notFound } = require('./src/middleware/errorHandler');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS ─────────────────────────────────────────────────────────
// Se aceptan: FRONTEND_URL exacto (env), cualquier *.vercel.app del proyecto,
// cualquier tunnel de ngrok, y localhost. Requests sin Origin (curl, health
// checks, mismo dominio) pasan libres.
const CORS_STATIC_ORIGINS = (process.env.FRONTEND_URL || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const CORS_ORIGIN_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
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

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Carpeta de PDFs accesible estáticamente
const pdfDir = process.env.PDF_STORAGE_PATH || path.join(__dirname, 'storage/pdfs');
fse.ensureDirSync(pdfDir);
app.use('/storage/pdfs', express.static(pdfDir));

// ── Rutas ─────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ message: 'Stocker API v2 ✔', status: 'ok' }));
app.use('/api', routes);

// ── 404 y errores ─────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ── Arranque ──────────────────────────────────────────────────────
async function start() {
  try {
    await sequelize.authenticate();
    console.log('✔ Conectado a la base de datos.');
    app.listen(PORT, () => {
      console.log(`✔ Stocker API corriendo en http://localhost:${PORT}`);
      console.log(`  PDFs en: ${pdfDir}`);
    });
  } catch (error) {
    console.error('✖ No se pudo conectar a la base de datos:', error.message);
    process.exit(1);
  }
}

start();
