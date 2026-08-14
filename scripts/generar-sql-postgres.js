#!/usr/bin/env node
/*
 * Genera el SQL de migración para Postgres (Railway).
 *
 * El DDL sale de los propios modelos con el generador de Sequelize para
 * Postgres, no escrito a mano: los nombres de columna son camelCase y en
 * Postgres eso obliga a comillas dobles en cada una. Escribirlo a mano es
 * pedir una diferencia sutil entre lo que crea el script y lo que el ORM
 * espera, que después falla en runtime con "column does not exist".
 *
 * No hace falta correrlo para deployar: el backend crea las tablas solo al
 * arrancar. Sirve para aplicar los cambios a mano, revisarlos antes, o
 * arreglar una base que quedó a mitad de camino.
 *
 * Uso:
 *   node scripts/generar-sql-postgres.js            → imprime el SQL
 *   node scripts/generar-sql-postgres.js --out a.sql
 */
const fs = require('fs');
const { Sequelize } = require('sequelize');

// Instancia sólo para generar SQL: no se conecta a ninguna base.
const pg = new Sequelize('postgres://user:pass@localhost:5432/db', {
  dialect: 'postgres',
  logging: false,
});
const qg = pg.getQueryInterface().queryGenerator;

// Los modelos se definen contra la conexión real (que puede ser mssql), así
// que se recrean acá sobre la instancia Postgres para obtener su DDL.
const { DataTypes } = require('sequelize');

const TABLAS = {
  payment_methods: {
    id:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    businessId: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'businesses', key: 'id' }, onDelete: 'CASCADE' },
    nombre:     { type: DataTypes.STRING(60), allowNull: false },
    ajustePct:  { type: DataTypes.DECIMAL(5,2), defaultValue: 0 },
    activo:     { type: DataTypes.BOOLEAN, defaultValue: true },
    orden:      { type: DataTypes.INTEGER, defaultValue: 0 },
    notas:      { type: DataTypes.STRING(200) },
    esEfectivo: { type: DataTypes.BOOLEAN, defaultValue: false },
    createdAt:  { type: DataTypes.DATE, allowNull: false },
    updatedAt:  { type: DataTypes.DATE, allowNull: false },
  },
  sale_payments: {
    id:              { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    saleId:          { type: DataTypes.INTEGER, allowNull: false, references: { model: 'sales', key: 'id' }, onDelete: 'CASCADE' },
    paymentMethodId: { type: DataTypes.INTEGER, allowNull: true, references: { model: 'payment_methods', key: 'id' }, onDelete: 'NO ACTION' },
    nombre:          { type: DataTypes.STRING(60), allowNull: false },
    monto:           { type: DataTypes.DECIMAL(12,2), allowNull: false },
    ajustePct:       { type: DataTypes.DECIMAL(5,2), defaultValue: 0 },
    ajusteMonto:     { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
    montoFinal:      { type: DataTypes.DECIMAL(12,2), allowNull: false },
    esEfectivo:      { type: DataTypes.BOOLEAN, defaultValue: false },
    createdAt:       { type: DataTypes.DATE, allowNull: false },
    updatedAt:       { type: DataTypes.DATE, allowNull: false },
  },
  cash_shifts: {
    id:             { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    businessId:     { type: DataTypes.INTEGER, allowNull: false, references: { model: 'businesses', key: 'id' }, onDelete: 'CASCADE' },
    employeeId:     { type: DataTypes.INTEGER, allowNull: false, references: { model: 'employees', key: 'id' }, onDelete: 'NO ACTION' },
    locationId:     { type: DataTypes.INTEGER, allowNull: true, references: { model: 'business_locations', key: 'id' }, onDelete: 'NO ACTION' },
    montoInicial:   { type: DataTypes.DECIMAL(12,2), allowNull: false, defaultValue: 0 },
    abiertoEn:      { type: DataTypes.DATE, allowNull: false },
    cerradoEn:      { type: DataTypes.DATE, allowNull: true },
    montoEsperado:  { type: DataTypes.DECIMAL(12,2), allowNull: true },
    montoDeclarado: { type: DataTypes.DECIMAL(12,2), allowNull: true },
    diferencia:     { type: DataTypes.DECIMAL(12,2), allowNull: true },
    estado:         { type: DataTypes.STRING(15), defaultValue: 'abierto' },
    notaCierre:     { type: DataTypes.STRING(500) },
    createdAt:      { type: DataTypes.DATE, allowNull: false },
    updatedAt:      { type: DataTypes.DATE, allowNull: false },
  },
  cash_movements: {
    id:           { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    businessId:   { type: DataTypes.INTEGER, allowNull: false, references: { model: 'businesses', key: 'id' }, onDelete: 'CASCADE' },
    cashShiftId:  { type: DataTypes.INTEGER, allowNull: true, references: { model: 'cash_shifts', key: 'id' }, onDelete: 'NO ACTION' },
    employeeId:   { type: DataTypes.INTEGER, allowNull: true, references: { model: 'employees', key: 'id' }, onDelete: 'NO ACTION' },
    tipo:         { type: DataTypes.STRING(15), allowNull: false },
    monto:        { type: DataTypes.DECIMAL(12,2), allowNull: false },
    motivo:       { type: DataTypes.STRING(255) },
    entregadoPor: { type: DataTypes.STRING(120) },
    recibidoPor:  { type: DataTypes.STRING(120) },
    fecha:        { type: DataTypes.DATE, allowNull: false },
    createdAt:    { type: DataTypes.DATE, allowNull: false },
    updatedAt:    { type: DataTypes.DATE, allowNull: false },
  },
};

// Columnas que se suman a tablas que ya existen.
const COLUMNAS = [
  ['sales', 'recargoPagos', { type: DataTypes.DECIMAL(12,2), defaultValue: 0 }],
  ['sales', 'totalCobrado', { type: DataTypes.DECIMAL(12,2), defaultValue: 0 }],
];

/*
 * Los tipos tienen que pasar por un modelo definido sobre la instancia
 * Postgres. Si se le entregan los DataTypes sueltos al generador, DataTypes.DATE
 * sale como `DATE` — que en Postgres es sólo fecha, sin hora — y se perderían
 * la hora de apertura y cierre de los turnos de caja.
 */
function ddlDe(tabla, atributos) {
  const modelo = pg.define(tabla, atributos, { tableName: tabla, freezeTableName: true });
  const sql = qg.attributesToSQL(modelo.getAttributes(), { table: tabla, context: 'createTable' });
  return qg.createTableQuery(tabla, sql, {});
}

const partes = [];
partes.push(`-- Migración Stocker para Postgres (Railway)`);
partes.push(`-- Generado ${new Date().toISOString()}`);
partes.push(`--`);
partes.push(`-- Idempotente: se puede correr varias veces sin romper nada.`);
partes.push(`-- Envuelto en una transacción: si algo falla, no queda a medias.`);
partes.push(``);
partes.push(`BEGIN;`);
partes.push(``);

partes.push(`-- ── Tablas nuevas ──────────────────────────────────────────────`);
for (const [tabla, atributos] of Object.entries(TABLAS)) {
  partes.push(ddlDe(tabla, atributos).trim());
  partes.push(``);
}

partes.push(`-- ── Columnas nuevas en tablas existentes ───────────────────────`);
for (const [tabla, columna, definicion] of COLUMNAS) {
  const modeloTmp = pg.define(`tmp_${tabla}_${columna}`, { [columna]: definicion });
  const tipo = qg.attributesToSQL(modeloTmp.getAttributes(), { context: 'addColumn' })[columna];
  partes.push(`ALTER TABLE "${tabla}" ADD COLUMN IF NOT EXISTS "${columna}" ${tipo};`);
}
partes.push(``);

partes.push(`-- ── Índices ───────────────────────────────────────────────────`);
partes.push(`-- Las consultas frecuentes filtran por negocio y por turno.`);
partes.push(`CREATE INDEX IF NOT EXISTS idx_payment_methods_business ON "payment_methods" ("businessId");`);
partes.push(`CREATE INDEX IF NOT EXISTS idx_sale_payments_sale       ON "sale_payments" ("saleId");`);
partes.push(`CREATE INDEX IF NOT EXISTS idx_cash_shifts_empleado     ON "cash_shifts" ("businessId", "employeeId", "estado");`);
partes.push(`CREATE INDEX IF NOT EXISTS idx_cash_movements_turno     ON "cash_movements" ("cashShiftId");`);
partes.push(``);

partes.push(`-- ── Datos: ventas anteriores ──────────────────────────────────`);
partes.push(`-- Antes no había recargos por medio de pago, así que lo cobrado`);
partes.push(`-- era exactamente el total. Sin esto quedarían todas en $0.`);
partes.push(`UPDATE "sales" SET "totalCobrado" = "total" WHERE "totalCobrado" IS NULL OR "totalCobrado" = 0;`);
partes.push(`UPDATE "sales" SET "recargoPagos" = 0 WHERE "recargoPagos" IS NULL;`);
partes.push(``);

partes.push(`-- ── Datos: medios de pago para los negocios existentes ────────`);
partes.push(`-- Un negocio sin medios de pago no puede cobrar en el punto de venta.`);
partes.push(`INSERT INTO "payment_methods" ("businessId", "nombre", "ajustePct", "activo", "orden", "esEfectivo", "createdAt", "updatedAt")`);
partes.push(`SELECT b.id, m.nombre, 0, true, m.orden, m.efectivo, NOW(), NOW()`);
partes.push(`FROM "businesses" b`);
partes.push(`CROSS JOIN (VALUES`);
partes.push(`  ('Efectivo', 0, true),`);
partes.push(`  ('Débito', 1, false),`);
partes.push(`  ('Crédito', 2, false),`);
partes.push(`  ('Transferencia', 3, false),`);
partes.push(`  ('QR / Billetera', 4, false)`);
partes.push(`) AS m(nombre, orden, efectivo)`);
partes.push(`WHERE NOT EXISTS (SELECT 1 FROM "payment_methods" p WHERE p."businessId" = b.id);`);
partes.push(``);

partes.push(`-- Marca de efectivo para medios que ya existían con otro nombre.`);
partes.push(`UPDATE "payment_methods" SET "esEfectivo" = true`);
partes.push(`WHERE "esEfectivo" IS NOT TRUE AND ("nombre" ILIKE '%efectivo%' OR "nombre" ILIKE '%contado%');`);
partes.push(`UPDATE "sale_payments" SET "esEfectivo" = true`);
partes.push(`WHERE "esEfectivo" IS NOT TRUE AND ("nombre" ILIKE '%efectivo%' OR "nombre" ILIKE '%contado%');`);
partes.push(``);

partes.push(`COMMIT;`);
partes.push(``);

const sql = partes.join('\n');

const i = process.argv.indexOf('--out');
const destino = i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
if (destino) {
  fs.writeFileSync(destino, sql);
  console.log(`✔ Escrito en ${destino}`);
} else {
  console.log(sql);
}
