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
  payment_methods: {
    esEfectivo: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false },
  },
  sale_payments: {
    esEfectivo: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false },
  },
  businesses: {
    // Datos que ahora se traen del padrón de ARCA.
    condicionIva: { type: DataTypes.STRING(60), allowNull: true },
    arcaSyncEn:   { type: DataTypes.DATE, allowNull: true },
  },
  sales: {
    // Recargos/descuentos por medio de pago. `total` sigue siendo el neto de
    // mercadería, así que las ventas anteriores quedan con 0 y totalCobrado
    // se rellena abajo con el total que ya tenían.
    recargoPagos: { type: DataTypes.DECIMAL(12, 2), allowNull: true, defaultValue: 0 },
    totalCobrado: { type: DataTypes.DECIMAL(12, 2), allowNull: true, defaultValue: 0 },
  },
};

/*
 * Arreglos de datos que acompañan a una columna nueva.
 *
 * Agregar `totalCobrado` con default 0 dejaría todas las ventas históricas
 * mostrando "cobrado: $0". Como antes no había recargos por medio de pago,
 * lo cobrado era exactamente el total.
 */
const RELLENOS = [
  {
    // Los medios que ya existen y se llaman "Efectivo" quedan marcados solos:
    // si no, al deployar el arqueo dejaría de contar las ventas en efectivo.
    descripcion: 'medios de pago existentes: marcar los de efectivo',
    cuandoSeAgrega: 'payment_methods.esEfectivo',
    sql: `UPDATE payment_methods SET "esEfectivo" = true WHERE nombre ILIKE '%efectivo%' OR nombre ILIKE '%contado%'`,
    sqlMssql: `UPDATE payment_methods SET esEfectivo = 1 WHERE nombre LIKE '%fectivo%' OR nombre LIKE '%ontado%'`,
  },
  {
    descripcion: 'cobros anteriores: marcar los de efectivo',
    cuandoSeAgrega: 'sale_payments.esEfectivo',
    sql: `UPDATE sale_payments SET "esEfectivo" = true WHERE nombre ILIKE '%efectivo%' OR nombre ILIKE '%contado%'`,
    sqlMssql: `UPDATE sale_payments SET esEfectivo = 1 WHERE nombre LIKE '%fectivo%' OR nombre LIKE '%ontado%'`,
  },
  {
    descripcion: 'ventas anteriores: totalCobrado = total',
    cuandoSeAgrega: 'sales.totalCobrado',
    sql: 'UPDATE sales SET "totalCobrado" = total WHERE "totalCobrado" IS NULL OR "totalCobrado" = 0',
    sqlMssql: 'UPDATE sales SET totalCobrado = total WHERE totalCobrado IS NULL OR totalCobrado = 0',
  },
  {
    // addColumn no aplica el defaultValue a las filas que ya estaban.
    descripcion: 'ventas anteriores: recargoPagos = 0',
    cuandoSeAgrega: 'sales.recargoPagos',
    sql: 'UPDATE sales SET "recargoPagos" = 0 WHERE "recargoPagos" IS NULL',
    sqlMssql: 'UPDATE sales SET recargoPagos = 0 WHERE recargoPagos IS NULL',
  },
];

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

  // Rellenos: sólo corren para las columnas que se acaban de crear, así que
  // volver a arrancar el servidor no los repite.
  const esPostgres = sequelize.getDialect() === 'postgres';
  for (const relleno of RELLENOS) {
    if (!agregadas.includes(relleno.cuandoSeAgrega)) continue;
    try {
      await sequelize.query(esPostgres ? relleno.sql : relleno.sqlMssql);
      console.log(`[schema] ${relleno.descripcion}`);
    } catch (err) {
      console.warn(`[schema] No se pudo aplicar "${relleno.descripcion}": ${err.message}`);
    }
  }

  return agregadas;
}

/*
 * Datos mínimos para que una función nueva no aparezca vacía.
 *
 * Los medios de pago se crean junto con el negocio, pero los que ya existían
 * antes de esta función se quedarían sin ninguno: entrarían al punto de venta
 * y no tendrían con qué cobrar. Esto les carga los mismos que trae una cuenta
 * nueva, sin ajustes, para que después los editen.
 *
 * Es idempotente: sólo toca negocios que no tienen ninguno cargado.
 */
const MEDIOS_INICIALES = ['Efectivo', 'Débito', 'Crédito', 'Transferencia', 'QR / Billetera'];

async function ensureDatosIniciales() {
  const { Business, PaymentMethod } = require('../models');
  let sembrados = 0;

  const negocios = await Business.findAll({ attributes: ['id'] });
  for (const negocio of negocios) {
    const tiene = await PaymentMethod.count({ where: { businessId: negocio.id } });
    if (tiene > 0) continue;
    await PaymentMethod.bulkCreate(
      MEDIOS_INICIALES.map((nombre, i) => ({
        businessId: negocio.id, nombre, ajustePct: 0, activo: true, orden: i,
      }))
    );
    sembrados++;
  }

  return sembrados;
}

module.exports = { ensureColumns, ensureDatosIniciales, COLUMNAS_ESPERADAS };
