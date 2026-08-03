require('dotenv').config();
const { db } = require('../models');

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

    console.log('✔  Modelos sincronizados correctamente.');
    process.exit(0);
  } catch (err) {
    console.error('✖  Error al sincronizar:', err.message);
    process.exit(1);
  }
}

sync();
