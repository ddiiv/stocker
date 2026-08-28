require('dotenv').config();
const { db } = require('../models');
const { sinDatos } = require('../utils/logger');

async function sync() {
  try {
    await db.authenticate();
    console.log('✔  Conectado a SQL Server.');

    // Las tablas ya fueron creadas por database/schema.sql.
    // Usamos sync sin alter para que Sequelize solo verifique la conexión
    // y registre los modelos sin intentar modificar columnas existentes.
    // Si necesitás agregar columnas nuevas, modificá schema.sql y correlo
    // con: sqlcmd -S localhost -U sa -P 'Password' -i database/schema.sql
    await db.sync({ alter: false });
    const { ensureColumns } = require('./ensureColumns');
    const nuevas = await ensureColumns(db);
    if (nuevas.length) console.log('  Columnas agregadas:', nuevas.join(', '));

    console.log('✔  Modelos sincronizados correctamente.');
    process.exit(0);
  } catch (err) {
    console.error('✖  Error al sincronizar:', sinDatos(err.message, 160));
    process.exit(1);
  }
}

sync();
