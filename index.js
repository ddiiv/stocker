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

// ── Middleware ────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
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
