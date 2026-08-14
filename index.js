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

const app = express();

/*
 * Puerto.
 *
 * BACKEND_PORT gana sobre PORT a propósito. Railway inyecta su propia PORT en
 * cada servicio, y si el backend la obedeciera mientras el front proxea a
 * BACKEND_PORT (la variable compartida), cada uno usaría un puerto distinto y
 * la conexión interna fallaría sin decir por qué. Al ser BACKEND_PORT la misma
 * variable que lee el front, los dos coinciden por construcción.
 *
 * Esto es correcto porque el backend no tiene dominio público: la PORT de
 * Railway sólo hace falta cuando el edge tiene que enrutar tráfico de afuera.
 */
const PORT = Number(process.env.BACKEND_PORT || process.env.PORT) || 3000;

if (process.env.BACKEND_PORT && process.env.PORT
    && process.env.BACKEND_PORT !== process.env.PORT) {
  console.warn(
    `[config] BACKEND_PORT=${process.env.BACKEND_PORT} y PORT=${process.env.PORT} no coinciden. ` +
    `Se usa ${PORT}, que es a donde apunta el front.`
  );
}

// La URL pública del front, para CORS. Se acepta como dominio pelado
// (FRONTEND_DOMAIN, la variable compartida) o como URL completa.
function comoUrl(valor) {
  if (!valor) return null;
  const s = String(valor).trim().replace(/\/+$/, '');
  if (!s) return null;
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}
const FRONT_URL = comoUrl(process.env.FRONTEND_URL) || comoUrl(process.env.FRONTEND_DOMAIN);

// ── CORS ─────────────────────────────────────────────────────────
// Se aceptan: FRONTEND_URL exacto (env), los dominios de Railway y Vercel,
// cualquier tunnel de ngrok, y localhost. Requests sin Origin (curl, health
// checks, mismo dominio) pasan libres.
//
// Sirviendo el front y la API desde el mismo origen esto casi no interviene,
// pero el navegador sí manda Origin en los POST same-origin: sin el patrón de
// Railway, el login en producción moriría con 500 antes de llegar al handler.
// Admite varias separadas por coma en FRONTEND_URL, más la que salga de
// FRONTEND_DOMAIN (la variable compartida del proyecto).
const CORS_STATIC_ORIGINS = [
  ...(process.env.FRONTEND_URL || '').split(',').map((s) => comoUrl(s)),
  comoUrl(process.env.FRONTEND_DOMAIN),
].filter(Boolean);
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

// Resumen de configuración al arrancar. En Railway los logs son la única
// ventana al contenedor, y sin esto diagnosticar "no conecta" es adivinar:
// no se ve en qué puerto quedó escuchando ni qué variables llegaron.
// Se informa presencia y longitud, nunca el valor.
function resumenConfig() {
  const e = process.env;
  const estado = (v) => (v ? `ok (${String(v).length} chars)` : '✖ FALTA');
  console.log('─────────────────────────────────────────');
  console.log('  Configuración efectiva');
  const origenPuerto = e.BACKEND_PORT ? 'BACKEND_PORT' : e.PORT ? 'PORT' : 'valor por defecto';
  console.log(`    NODE_ENV .......... ${e.NODE_ENV || '(sin definir)'}`);
  console.log(`    Puerto ............ ${PORT}  (de ${origenPuerto})`);
  console.log(`    JWT_SECRET ........ ${estado(e.JWT_SECRET)}`);
  console.log(`    DATABASE_URL ...... ${e.DATABASE_URL ? 'ok' : '✖ FALTA (se usará la config de DB_* suelta)'}`);
  console.log(`    Front (CORS) ...... ${FRONT_URL || '(sin definir)'}`);
  console.log(`    ARCA_STOCKER_CUIT . ${e.ARCA_STOCKER_CUIT ? 'ok' : '(sin definir)'}`);
  console.log(`    Sesión ............ ${e.SESSION_IDLE_MINUTES || 30} min inactividad · ${e.SESSION_ABSOLUTE_HOURS || 24} h máximo`);
  console.log('─────────────────────────────────────────');
}

async function start() {
  try {
    resumenConfig();
    await sequelize.authenticate();
    console.log('✔ Conectado a la base de datos.');

    // Crea las tablas que falten. Con alter:false NO toca las existentes:
    // solo ejecuta CREATE TABLE IF NOT EXISTS, así que es seguro correrlo en
    // cada arranque. Sin esto, un deploy con modelos nuevos rompe con
    // "relation ... does not exist" hasta que alguien corra db:sync a mano.
    if (process.env.DB_AUTO_SYNC !== 'false') {
      await sequelize.sync({ alter: false, logging: false });
      // sync no agrega columnas a tablas que ya existen: eso lo cubre este paso.
      const { ensureColumns, ensureDatosIniciales } = require('./src/database/ensureColumns');
      const nuevas = await ensureColumns(sequelize);
      console.log(`✔ Esquema verificado${nuevas.length ? ` — columnas agregadas: ${nuevas.join(', ')}` : ''}.`);

      const sembrados = await ensureDatosIniciales();
      if (sembrados) console.log(`✔ Medios de pago iniciales creados en ${sembrados} negocio(s).`);
    }

    // La red privada de Railway es IPv6: si el server sólo escucha en 0.0.0.0,
    // `backend.railway.internal` no resuelve a nada y el proxy da ECONNREFUSED.
    // Con '::' Linux acepta también IPv4 mapeado, así que no perdemos nada.
    const server = app.listen(PORT, '::', () => {
      const dir = server.address();
      console.log(`✔ Stocker API escuchando en ${dir.address}:${dir.port} (IPv4 + IPv6)`);
      console.log(`  El servicio del front debe apuntar a: http://<nombre-de-este-servicio>.railway.internal:${dir.port}`);
      console.log(`  PDFs en: ${pdfDir}`);
    });

    server.on('error', (err) => {
      console.error(`✖ No se pudo escuchar en el puerto ${PORT}: ${err.code || err.message}`);
      process.exit(1);
    });
  } catch (error) {
    // Este catch cubre conexión, sync y ensureColumns. Decir siempre "no se
    // pudo conectar" manda a revisar credenciales cuando el problema puede
    // estar en el esquema. Y los errores de Sequelize suelen traer el detalle
    // en `original`, no en `message` — que a veces viene vacío.
    const detalle = error.original?.message || error.parent?.message || error.message || error.name;
    console.error(`✖ Falló el arranque: ${detalle}`);
    if (error.sql) console.error(`  Sentencia: ${String(error.sql).slice(0, 300)}`);
    process.exit(1);
  }
}

// Un throw fuera del try (por ejemplo al cargar un módulo) moría con un stack
// trace pelado, sin decir qué variable faltaba.
process.on('uncaughtException', (err) => {
  console.error('✖ El proceso se detuvo por un error no capturado:');
  console.error(`  ${err.message}`);
  process.exit(1);
});

start();
