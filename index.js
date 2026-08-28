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
const { log, mask, sinDatos } = require('./src/utils/logger');

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
/*
 * Orígenes permitidos.
 *
 * Antes esto aceptaba cualquier subdominio de railway.app, vercel.app y ngrok
 * por patrón. O sea: cualquiera que levantara un sitio en Railway podía hacerle
 * pedidos con credenciales a esta API. La cookie SameSite=Strict tapaba buena
 * parte del agujero, pero la lista no tenía por qué estar abierta.
 *
 * Ahora son exactos y salen de la configuración. Los tres servicios del
 * proyecto —app, backoffice y página pública— se declaran por variable.
 *
 * localhost sólo fuera de producción: en producción, un origen de localhost no
 * es un desarrollador, es alguien apuntando su navegador a nuestra API.
 */
/*
 * Un dominio interno no puede ser un origen válido.
 *
 * `Origin` lo pone el navegador con la dirección que el usuario tiene en la
 * barra, así que un `*.railway.internal` —o un host privado— jamás va a
 * aparecer ahí. Si una de estas variables quedó apuntando al dominio privado
 * del servicio en vez de al público, la lista queda con una entrada inútil y el
 * dominio real afuera. Se descarta y se avisa, porque el síntoma es "CORS me
 * rechaza" y la causa está tres pasos atrás.
 */
const ES_INTERNO = /(\.railway\.internal|\.internal|\.local)(:\d+)?$/i;

const CORS_CANDIDATOS = [
  ...(process.env.FRONTEND_URL || '').split(',').map((v) => ['FRONTEND_URL', comoUrl(v)]),
  ['FRONTEND_DOMAIN',   comoUrl(process.env.FRONTEND_DOMAIN)],
  ['BACKOFFICE_DOMAIN', comoUrl(process.env.BACKOFFICE_DOMAIN)],
  ['LANDING_DOMAIN',    comoUrl(process.env.LANDING_DOMAIN)],
].filter(([, url]) => Boolean(url));

const CORS_DESCARTADOS = CORS_CANDIDATOS.filter(([, url]) => ES_INTERNO.test(url));
const CORS_ORIGENES = [...new Set(
  CORS_CANDIDATOS.filter(([, url]) => !ES_INTERNO.test(url)).map(([, url]) => url)
)];

const ES_PRODUCCION = process.env.NODE_ENV === 'production';
const CORS_LOCALES = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
];

function origenPermitido(origin) {
  if (CORS_ORIGENES.includes(origin)) return true;
  if (!ES_PRODUCCION && CORS_LOCALES.some((rx) => rx.test(origin))) return true;
  return false;
}

app.use(cors({
  origin(origin, cb) {
    // Sin Origin: curl, mismo origen, healthchecks. No es un navegador cruzando
    // dominios, así que no hay nada que autorizar.
    if (!origin) return cb(null, true);
    if (origenPermitido(origin)) return cb(null, true);

    /*
     * No se escribe el origen tal cual.
     *
     * Lo elige quien llama, así que es texto ajeno yendo a parar a nuestros
     * logs: sirve para ensuciarlos —saltos de línea, líneas falsas— y para
     * dejar ahí lo que se le ocurra. Con el host alcanza para saber quién
     * rebotó, y se recorta.
     */
    let host = 'desconocido';
    try { host = new URL(origin).host.slice(0, 60); } catch { /* origen ilegible */ }
    log.warn('cors', 'origen rechazado', { host });
    // Se responde sin permiso en vez de lanzar: un throw acá termina en un 500
    // y en el log del servidor como si fuera un error nuestro.
    cb(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  maxAge: 86400,
}));

/*
 * Cuántos proxies hay delante.
 *
 * Express usa este número para elegir cuál de las direcciones de
 * X-Forwarded-For es el cliente: descarta las N de la derecha y toma la
 * siguiente. De eso dependen tres cosas: la restricción por IP del backoffice,
 * el contador de ráfagas y el bloqueo por intentos fallidos.
 *
 * El número tiene que ser EXACTO, y equivocarse para abajo es mucho menos grave
 * que para arriba:
 *
 *   Demasiado bajo  → se lee la IP de un proxy. La lista de IPs nunca coincide
 *                     y todos los usuarios comparten un solo contador, así que
 *                     un atacante puede dejar afuera a todo el mundo. Molesto,
 *                     pero no abre nada.
 *
 *   Demasiado alto  → se lee lo que el atacante escribió en la cabecera. Con
 *                     eso se saltea la lista de IPs y los límites de ráfaga
 *                     poniendo una dirección inventada. Ese sí es un agujero.
 *
 * Por eso NUNCA hay que poner `true` ni un número grande: `trust proxy: true`
 * toma la primera dirección de la cadena, que es exactamente la que cualquiera
 * puede inventar. Con un número exacto, las direcciones falsas quedan a la
 * izquierda de la real y se descartan solas.
 *
 * En este proyecto son 2: el edge de Railway y el servicio del front que
 * reenvía /api. Se puede comprobar en GET /api/mi-ip.
 */
const TOPE_HOPS = 4;   // más que esto no es un despliegue, es un error de tipeo
const HOPS_PEDIDOS = Number(process.env.TRUST_PROXY_HOPS || 1);

let HOPS = Number.isInteger(HOPS_PEDIDOS) && HOPS_PEDIDOS >= 0 ? HOPS_PEDIDOS : 1;
if (HOPS > TOPE_HOPS) {
  // Se recorta en vez de obedecer: un valor alto por error convierte la
  // cabecera del cliente en la fuente de la verdad, y eso no puede pasar por
  // un tipeo. Queda avisado en el arranque.
  console.warn(`[proxy] TRUST_PROXY_HOPS=${HOPS_PEDIDOS} es demasiado alto y dejaría que el cliente elija su propia IP. Se usa ${TOPE_HOPS}.`);
  HOPS = TOPE_HOPS;
}
app.set('trust proxy', HOPS);

app.disable('x-powered-by');

/*
 * Orden de los middlewares: importa, y esta es la razón de cada paso.
 *
 * Las ráfagas y los filtros de forma van ANTES del parser de JSON. Si fueran
 * después, un atacante mandando cuerpos de 10 MB haría que el servidor los lea
 * enteros en memoria para recién entonces rechazarlos — el límite terminaría
 * siendo la palanca del ataque en vez de la defensa.
 */
const { burstLimiter, apiLimiter, publicLimiter } = require('./src/middleware/rateLimit');
const { filtrarPeticion, filtrarCuerpo } = require('./src/middleware/hardening');

app.use(burstLimiter);
app.use(filtrarPeticion);

app.use(cookieParser());
/*
 * Cuerpo máximo: 1 MB.
 *
 * Estaba en 10 MB, que es diez veces más de lo que necesita el pedido más
 * grande de la API — una venta con cien ítems no pasa de unos pocos KB. Un
 * límite holgado no agrega ninguna función y sí multiplica por diez lo que se
 * puede hacer con una conexión.
 *
 * Las subidas de archivo no pasan por acá: van por multer, que tiene su propio
 * tope de 10 MB para las planillas de Excel.
 */
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(filtrarCuerpo);

/*
 * Cabeceras de seguridad.
 *
 * La API devuelve JSON, así que la CSP puede ser cerrada del todo: no hay
 * script ni estilo legítimo que cargar desde una respuesta de la API. Si algún
 * día un navegador termina renderizando una respuesta —por un error de
 * content-type, por ejemplo— no va a ejecutar nada.
 */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

/*
 * La carpeta de PDFs NO se sirve estáticamente.
 *
 * Estaba montada en `/storage/pdfs` con express.static y sin ninguna
 * autenticación. Los nombres son adivinables —`factura-0008-00000012-45.pdf`:
 * número de comprobante y id de fila, los dos enteros chicos—, así que
 * cualquiera que alcanzara el backend podía enumerar y bajarse las facturas de
 * todos los negocios. Comprobado: un GET sin sesión devolvía 200 y el PDF
 * entero.
 *
 * Hoy no está expuesto a internet porque el backend no tiene dominio público y
 * los frontends sólo reenvían `/api`, pero eso es una decisión de despliegue
 * que puede cambiar sin que nadie recuerde esta línea.
 *
 * No hace falta para nada: los dos endpoints que entregan comprobantes
 * —`/api/sales/:id/ticket` y `/api/invoices/:id/pdf`— regeneran el PDF desde la
 * base y lo mandan con la sesión validada.
 */
const pdfDir = process.env.PDF_STORAGE_PATH || path.join(__dirname, 'storage/pdfs');
fse.ensureDirSync(pdfDir);

// ── Rutas ─────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ message: 'Stocker API v2 ✔', status: 'ok' }));

/*
 * GET /api/mi-ip — qué IP ve el backend del que pregunta.
 *
 * Existe por una razón concreta: la restricción por IP del backoffice se
 * configura a ciegas, y si el número de proxies no está bien, la lista deja
 * afuera al operador con un 404 y sin forma de entrar a arreglarlo. Esto
 * permite verificar el valor ANTES de cargarlo.
 *
 * Público a propósito: sólo le cuenta a cada uno su propia IP, que ya conoce.
 * La cadena completa —que incluye direcciones internas— sólo se muestra con
 * MOSTRAR_CADENA_IP=1, para no publicar detalle de infraestructura de rutina.
 */
app.get('/api/mi-ip', (req, res) => {
  const cadena = String(req.headers['x-forwarded-for'] || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  /*
   * Se informa si ESTA IP entraría al backoffice con la lista actual.
   *
   * Es lo que cierra el círculo: sin esto, la única forma de saber si el valor
   * quedó bien es intentar entrar, y si quedó mal el resultado es un 404 sin
   * pistas. Acá se comprueba antes.
   *
   * Sólo dice sí o no. No devuelve la lista: le contaría a cualquiera desde
   * dónde se administra la plataforma.
   */
  const { parsearLista, estaEnLista } = require('./src/utils/ip');
  const reglas = parsearLista(process.env.BACKOFFICE_IPS);

  res.json({
    ip: req.ip,
    hops: app.get('trust proxy'),
    saltos: cadena.length,
    ...(process.env.MOSTRAR_CADENA_IP === '1' ? { cadena } : {}),
    backoffice: reglas.length === 0
      ? 'sin restricción: BACKOFFICE_IPS está vacía y el panel acepta cualquier IP'
      : estaEnLista(req.ip, reglas)
        ? 'esta IP SÍ entra al backoffice'
        : 'esta IP NO entra al backoffice',
    ayuda: 'Si esta no es tu IP pública, ajustá TRUST_PROXY_HOPS en el backend (1 si el navegador le pega directo, 2 si pasa por el front).',
  });
});

/*
 * La superficie sin sesión lleva un cupo más ajustado que el resto.
 *
 * El cupo holgado existe para el punto de venta, que con un lector de barras
 * dispara muchas peticiones seguidas. Nada de eso pasa por login ni por
 * registro, así que ahí no hay razón para ser generoso.
 */
app.use(['/api/auth', '/api/backoffice/login', '/api/backoffice/totp'], publicLimiter);
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

      // El historial de intentos crece con cada login del sistema; se recorta
      // acá y no con un cron para no depender de otra pieza que puede no correr.
      const { purgar } = require('./src/services/bloqueoService');
      await purgar();
    }

    // La red privada de Railway es IPv6: si el server sólo escucha en 0.0.0.0,
    // `backend.railway.internal` no resuelve a nada y el proxy da ECONNREFUSED.
    // Con '::' Linux acepta también IPv4 mapeado, así que no perdemos nada.
    const server = app.listen(PORT, '::', () => {
      const dir = server.address();
      /*
       * El puerto sí, la dirección de bind y la ruta en disco no.
       *
       * `dir.address` y la carpeta de PDFs son detalle de la máquina, no del
       * servicio: no ayudan a diagnosticar nada que el puerto no diga ya, y
       * una captura de estos logs no tiene por qué contar cómo está armado el
       * servidor por dentro.
       */
      console.log(`✔ Stocker API escuchando en el puerto ${dir.port} (IPv4 + IPv6)`);
      console.log(`  El servicio del front debe apuntar a: http://<nombre-de-este-servicio>.railway.internal:${dir.port}`);

      /*
       * Estado de las defensas, en el arranque.
       *
       * Se imprime porque el modo más común de fallar en esto es silencioso:
       * la variable quedó sin cargar, el panel siguió abierto a internet, y
       * nadie se enteró hasta que pasó algo. Verlo en cada deploy es la forma
       * más barata de que no pase inadvertido.
       */
      const { estado: estadoIps, VARIABLE } = require('./src/middleware/ipAllowlist');
      const ips = estadoIps();
      console.log('  ── Seguridad ──');
      console.log(`    Backoffice por IP .. ${ips.activa
        ? `restringido (${ips.cantidad} regla${ips.cantidad === 1 ? '' : 's'})`
        : `✖ ABIERTO — cargá ${VARIABLE}`}`);
        const bloq = require('./src/services/bloqueoService');
      console.log(`    Bloqueo por fuerza bruta .. ${bloq.TOPE_POR_CUENTA} fallos por cuenta · ${bloq.TOPE_POR_IP} por IP, en ${bloq.VENTANA_MIN} min`);
      console.log('    Ráfagas .. 60 pedidos cada 2 s por IP');
      console.log(`    Cuerpo máximo .. 1 MB`);
      console.log(`    Proxies delante .. ${app.get('trust proxy')} (TRUST_PROXY_HOPS) · comprobalo en GET /api/mi-ip`);
      if (!process.env.TRUST_PROXY_HOPS) {
        console.log('      ↳ sin definir, se usa 1. Si el front reenvía /api al backend son 2,');
        console.log('        y con 1 la restricción por IP y los límites leen la IP equivocada.');
      }

      /*
       * La lista de CORS efectiva, en el arranque.
       *
       * Sin esto, un dominio mal cargado sólo se descubre cuando un navegador
       * empieza a recibir rechazos, y desde el otro lado eso parece un problema
       * del front.
       */
      console.log('  ── CORS ──');
      if (CORS_ORIGENES.length) {
        for (const o of CORS_ORIGENES) console.log(`    ✔ ${o}`);
      } else {
        console.log('    ✖ Ningún origen configurado. Si algún front le pega por otro dominio, lo va a rechazar.');
      }
      for (const [variable, url] of CORS_DESCARTADOS) {
        console.log(`    ✖ ${variable} apunta a un dominio interno, y un navegador nunca lo manda como Origin.`);
        console.log(`      Cargá ahí el dominio PÚBLICO del servicio.`);
      }
      if (process.env.NODE_ENV !== 'production') {
        console.log('    + localhost (sólo fuera de producción)');
      }

      /*
       * Mercado Pago: mismo criterio. Una URL a localhost está cargada y no
       * sirve, y el cobro falla en silencio — el pago entra y la cuenta no se
       * activa.
       */
      const { problemasDeUrls, estaConfigurado } = require('./src/services/mercadopagoService');
      const problemasMp = estaConfigurado() ? problemasDeUrls() : [];
      if (problemasMp.length) {
        console.log('  ── Mercado Pago ──');
        for (const p of problemasMp) console.log(`    ✖ ${p}`);
      }

      /*
       * Correo: las tres casillas y si el dominio cierra.
       *
       * Un dominio mal configurado no falla, manda igual y cae en spam — que
       * es peor, porque nadie se entera hasta que un cliente dice que no le
       * llegó el comprobante. Decirlo en el log del deploy es la única forma
       * de que alguien lo mire.
       */
      const correo = require('./src/config/correo').estado();
      console.log('  ── Correo ──');
      /*
       * Las casillas van con el usuario tapado y el dominio a la vista.
       *
       * El dominio es lo que hay que verificar en el deploy —que sea el
       * nuestro y no el de pruebas— y el usuario exacto no aporta a eso. Saber
       * de qué casilla sale cada mail le sirve sobre todo a quien quiera
       * hacerse pasar por ella.
       */
      const casilla = (v) => {
        if (!v) return '(sin definir)';
        const [usuario, dominio] = String(v).split('@');
        if (!dominio) return mask.nombre(v);
        // Se tapa el usuario y se deja el dominio: es el dato que hay que
        // verificar acá —que sea el nuestro y no el de pruebas— y el usuario
        // exacto sólo le sirve a quien quiera hacerse pasar por esa casilla.
        return `${usuario.slice(0, 2)}${'*'.repeat(Math.max(1, usuario.length - 2))}@${dominio}`;
      };
      console.log(`    Envía todo (ventas, facturas, caja, códigos) .. ${casilla(correo.casillas.noreply)}`
        + `${correo.credencialPropia ? ' · credencial propia' : ' · SIN credencial propia'}`);
      console.log(`    Recibe reportes de soporte ................... ${casilla(correo.casillas.soporte)}`
        + `${correo.soporteConCredencial ? ' · con credencial' : ''}`);
      console.log(`    Cuenta principal (admin, SPF/DKIM) .......... ${casilla(correo.casillas.oficial)}`);
      if (correo.avisos.length) {
        for (const a of correo.avisos) console.log(`    ✖ ${a}`);
      } else {
        console.log('    ✔ La cuenta que autentica es la que figura como remitente: Gmail no lo reescribe.');
      }
    });

    /*
     * Apagado ordenado: Railway manda SIGTERM en cada deploy.
     *
     * Sin escucharlo, Node muere por la señal y npm lo reporta como si el
     * comando hubiera fallado —"npm error signal SIGTERM"— en CADA deploy. No
     * falló nada, pero queda escrito como error, y a fuerza de aparecer entrena
     * a no mirar los logs. El día que haya un error de verdad va a estar abajo
     * de ése.
     *
     * Acá además importa cerrar bien y no sólo salir: puede haber una venta a
     * medio commitear. `close()` deja de aceptar conexiones nuevas y espera a
     * que terminen las que están en curso.
     *
     * El plazo es porque `close()` espera a TODAS las conexiones abiertas, y
     * una que quedó colgada dejaría el contenedor sin salir hasta que la
     * plataforma lo mate a la fuerza — volviendo al mismo mensaje.
     */
    const apagar = (senal) => {
      console.log(`Recibido ${senal}: cerrando el servidor.`);
      const plazo = setTimeout(() => {
        console.warn('  Quedaron conexiones abiertas: se sale igual.');
        process.exit(0);
      }, 10000);
      plazo.unref();

      server.close(async () => {
        clearTimeout(plazo);
        try { await sequelize.close(); } catch { /* ya estaba cerrada */ }
        console.log('  Servidor cerrado.');
        process.exit(0);
      });
    };
    process.on('SIGTERM', () => apagar('SIGTERM'));
    process.on('SIGINT',  () => apagar('SIGINT'));

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
    /*
     * El mensaje va sin los valores que trae adentro, y la sentencia no va.
     *
     * Un error de Postgres llega con el dato pegado al texto —"Key (email)=(…)
     * already exists"— y `error.sql` es la consulta entera, con los valores del
     * WHERE y del INSERT. Escribirlos acá es filtrar por el peor lugar posible:
     * los logs de arranque son los que más se comparten en una captura cuando
     * algo no levanta.
     *
     * Queda el tipo de error y su forma, que es lo que hace falta para saber si
     * el problema es de credenciales, de esquema o de red.
     */
    console.error(`✖ Falló el arranque: ${sinDatos(detalle)}`);
    if (error.sql) console.error(`  Falló una sentencia ${String(error.sql).trim().split(/\s+/)[0].toUpperCase()}.`);
    process.exit(1);
  }
}

/*
 * Una promesa rechazada de fondo NO puede tumbar el servidor.
 *
 * Node convierte un rechazo sin manejar en uncaughtException, y como abajo eso
 * termina en process.exit(1), un mail que no salió o una consulta que tardó de
 * más dejaba sin sistema a TODOS los negocios a la vez. Se vio con doce ventas
 * simultáneas: la ráfaga de avisos por mail y WhatsApp que dispara cada venta
 * alcanzaba para voltear el proceso.
 *
 * Un rechazo así es un defecto y hay que arreglarlo, pero la caja de un local
 * no es el lugar donde enterarse. Se registra completo —con stack, que es lo
 * único que permite ubicarlo— y el servidor sigue atendiendo.
 */
process.on('unhandledRejection', (razon) => {
  const err = razon instanceof Error ? razon : new Error(String(razon));
  console.error('✖ Promesa rechazada sin manejar (el servidor sigue en pie):');
  console.error(`  ${err.name}: ${sinDatos(err.message)}`);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 8).join('\n'));
});

/*
 * Un throw fuera del try (por ejemplo al cargar un módulo) moría con un stack
 * trace pelado, sin decir qué variable faltaba.
 *
 * Acá sí se sale: una excepción sincrónica sin capturar deja el proceso en un
 * estado que no se puede razonar, y seguir sirviendo desde ahí es peor que
 * reiniciar. Va con stack porque sin él el mensaje solo —"Operation timeout"—
 * no alcanza para saber ni de qué parte del sistema vino.
 */
process.on('uncaughtException', (err) => {
  console.error('✖ El proceso se detuvo por un error no capturado:');
  console.error(`  ${err.name}: ${sinDatos(err.message)}`);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 10).join('\n'));
  process.exit(1);
});

start();
