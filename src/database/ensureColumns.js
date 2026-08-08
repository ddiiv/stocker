/*
 * Agrega columnas que se sumaron a los modelos después de que las tablas ya
 * existían en producción.
 *
 * `sequelize.sync({ alter: false })` solo crea tablas faltantes: nunca toca
 * las que ya están, así que una columna nueva no llega sola a la base. Y
 * `alter: true` no es opción en producción porque puede reescribir o borrar
 * columnas cuando el modelo y la tabla difieren.
 *
 * Este helper es el punto medio: mira qué columnas faltan y las agrega una
 * por una. Es idempotente — correrlo mil veces da el mismo resultado.
 *
 * Al agregar un campo nuevo a un modelo, sumalo también a la lista de abajo.
 */

const { DataTypes } = require('sequelize');

// tabla → { columna: definición }
const COLUMNAS_ESPERADAS = {
  product_variants: {
    codigoBarras: { type: DataTypes.STRING(60), allowNull: true },
  },
};

async function ensureColumns(sequelize) {
  const qi = sequelize.getQueryInterface();
  const agregadas = [];

  for (const [tabla, columnas] of Object.entries(COLUMNAS_ESPERADAS)) {
    let existentes;
    try {
      existentes = await qi.describeTable(tabla);
    } catch {
      // La tabla todavía no existe: sync la va a crear ya con sus columnas.
      continue;
    }

    for (const [nombre, definicion] of Object.entries(columnas)) {
      if (nombre in existentes) continue;
      try {
        await qi.addColumn(tabla, nombre, definicion);
        agregadas.push(`${tabla}.${nombre}`);
      } catch (err) {
        console.warn(`[schema] No se pudo agregar ${tabla}.${nombre}: ${err.message}`);
      }
    }
  }

  return agregadas;
}

module.exports = { ensureColumns, COLUMNAS_ESPERADAS };
