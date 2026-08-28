require('dotenv').config();
const { Sequelize } = require('sequelize');

// Selección de driver por prioridad:
//   1) DATABASE_URL (lo que inyecta Railway/Render/Neon) → Postgres
//   2) DB_DIALECT=postgres explícito + variables sueltas
//   3) fallback → SQL Server local (compatibilidad hacia atrás)
//
// Todas las variables tienen prefijo DB_* excepto DATABASE_URL que es estándar
// de plataformas cloud.

const DATABASE_URL = process.env.DATABASE_URL;
const DIALECT      = process.env.DB_DIALECT || (DATABASE_URL ? 'postgres' : 'mssql');
const isDev        = process.env.NODE_ENV === 'development';

/*
 * Sequelize, si se le pasa `console.log`, escupe el SQL completo — con los
 * valores del WHERE y del INSERT. Eso significa emails, CUITs, DNIs, hashes de
 * contraseña y los tokens de AFIP y MercadoLibre yendo a parar a los logs de
 * Railway, que quedan guardados y los ve cualquiera con acceso al proyecto.
 *
 * En vez del SQL registramos sólo la operación y la tabla: alcanza para ver qué
 * está haciendo la aplicación y detectar consultas de más, sin un solo dato
 * adentro. Para depurar una consulta puntual está DB_LOG_SQL=true, que nunca
 * debe activarse en producción.
 */
/*
 * El SQL crudo NUNCA sale en producción, diga lo que diga la variable.
 *
 * `DB_LOG_SQL=true` existe para depurar una consulta puntual en la máquina de
 * uno. Que alcance con cargar una variable de entorno para volcar emails,
 * CUITs, hashes de contraseña y tokens de AFIP a los logs de Railway es un
 * arma cargada al alcance de la mano: se prende para mirar algo, se olvida
 * prendida, y queda escrito para siempre.
 *
 * Se lo ata a NODE_ENV, que en producción no lo elige quien está depurando.
 */
const enProduccion = process.env.NODE_ENV === 'production';
const logSqlCrudo = process.env.DB_LOG_SQL === 'true' && !enProduccion;

if (process.env.DB_LOG_SQL === 'true' && enProduccion) {
  console.warn('[db] DB_LOG_SQL está prendida pero se ignora: en producción el SQL crudo no se registra.');
}

function logConsulta(sql) {
  if (logSqlCrudo) return console.log(sql);
  const texto = String(sql).replace(/^Executing \(\w+\):\s*/i, '');
  const verbo = (texto.match(/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|BEGIN|COMMIT|ROLLBACK)/i) || [])[1];
  if (!verbo) return console.log('[debug] db · consulta');
  // El nombre de la tabla es estructura, no dato: se puede loguear.
  const tabla = (texto.match(/(?:FROM|INTO|UPDATE|TABLE)\s+[`"\[]?(\w+)/i) || [])[1];
  console.log(`[debug] db · ${verbo.toUpperCase()}${tabla ? ` ${tabla}` : ''}`);
}

// Sólo en desarrollo, y aun así sin valores.
const logging = isDev ? logConsulta : false;

let sequelize;

if (DATABASE_URL) {
  // Postgres via URL (Railway, Neon, Supabase, Heroku, Render).
  sequelize = new Sequelize(DATABASE_URL, {
    dialect: 'postgres',
    logging,
    dialectOptions: {
      ssl: process.env.DB_SSL === 'false' ? false : { require: true, rejectUnauthorized: false },
    },
    pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
    define: { timestamps: true },
  });
} else if (DIALECT === 'postgres') {
  // Postgres local (docker o instancia propia).
  sequelize = new Sequelize(
    process.env.DB_NAME     || 'stocker',
    process.env.DB_USER     || 'postgres',
    process.env.DB_PASSWORD || 'postgres',
    {
      host:    process.env.DB_SERVER || 'localhost',
      port:    parseInt(process.env.DB_PORT) || 5432,
      dialect: 'postgres',
      logging,
      dialectOptions: process.env.DB_SSL === 'true' ? { ssl: { require: true, rejectUnauthorized: false } } : {},
      pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
      define: { timestamps: true },
    }
  );
} else {
  // Fallback: SQL Server local (setup original de dev).
  sequelize = new Sequelize(
    process.env.DB_NAME    || 'isumayorista',
    process.env.DB_USER    || 'sa',
    process.env.DB_PASSWORD|| '',
    {
      host:    process.env.DB_SERVER || 'localhost',
      port:    parseInt(process.env.DB_PORT) || 1433,
      dialect: 'mssql',
      logging,
      dialectOptions: {
        options: {
          encrypt:              process.env.DB_ENCRYPT    === 'true',
          trustServerCertificate: process.env.DB_TRUST_CERT !== 'false',
          enableArithAbort: true,
          connectTimeout: 30000,
        },
      },
      pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
      define: { timestamps: true },
    }
  );
}

module.exports = sequelize;
