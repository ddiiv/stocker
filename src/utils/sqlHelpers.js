// Helpers para escribir queries agnósticas de motor SQL.

const { Op } = require('sequelize');
const sequelize = require('../config/database');

// Devuelve el operador LIKE case-insensitive apropiado según el dialect actual:
//   Postgres → Op.iLike (case-insensitive nativo).
//   MSSQL    → Op.like (mssql compara sin distinguir mayúsculas por default en
//              la mayoría de collations, ej. Latin1_General_CI_AS).
//   Otros    → Op.like (fallback razonable).
//
// Uso:
//   const like = ilikeOperator();
//   where[column] = { [like]: `%${search}%` }
function ilikeOperator() {
  return sequelize.getDialect() === 'postgres' ? Op.iLike : Op.like;
}

/*
 * Cita un identificador según el motor: [tabla] en SQL Server, "tabla" en
 * Postgres. Hace falta para las subconsultas escritas a mano — sin las comillas,
 * Postgres pasa los nombres a minúsculas y `saleId` deja de existir.
 */
function citar(nombre) {
  return sequelize.getDialect() === 'postgres' ? `"${nombre}"` : `[${nombre}]`;
}

module.exports = { ilikeOperator, citar };
