require('dotenv').config();
const { Sequelize } = require('sequelize');

const sequelize = new Sequelize(
  process.env.DB_NAME    || 'isumayorista',
  process.env.DB_USER    || 'sa',
  process.env.DB_PASSWORD|| '',
  {
    host:    process.env.DB_SERVER || 'localhost',
    port:    parseInt(process.env.DB_PORT) || 1433,
    dialect: 'mssql',
    logging: process.env.NODE_ENV === 'development' ? console.log : false,
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

module.exports = sequelize;
