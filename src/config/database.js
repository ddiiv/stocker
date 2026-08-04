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

let sequelize;

if (DATABASE_URL) {
  // Postgres via URL (Railway, Neon, Supabase, Heroku, Render).
  sequelize = new Sequelize(DATABASE_URL, {
    dialect: 'postgres',
    logging: isDev ? console.log : false,
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
      logging: isDev ? console.log : false,
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
      logging: isDev ? console.log : false,
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
