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
  clients: {
    // Cuenta corriente. Arrancan todos deshabilitados: habilitar el crédito es
    // una decisión del negocio cliente por cliente, no un default.
    cuentaHabilitada: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false },
    limiteCredito:    { type: DataTypes.DECIMAL(12, 2), allowNull: true, defaultValue: 0 },
    saldoCuenta:      { type: DataTypes.DECIMAL(12, 2), allowNull: true, defaultValue: 0 },
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
    // Ventas fiadas: la condición de pago, lo que falta cobrar y si la
    // mercadería ya salió. Ver los rellenos: las ventas viejas son todas al
    // contado y su stock ya se descontó si estaban pagadas.
    condicionPago:        { type: DataTypes.STRING(20), allowNull: true, defaultValue: 'contado' },
    saldoPendiente:       { type: DataTypes.DECIMAL(12, 2), allowNull: true, defaultValue: 0 },
    stockDescontado:      { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false },
    cobradoEn:            { type: DataTypes.DATE, allowNull: true },
    cobradoPorEmployeeId: { type: DataTypes.INTEGER, allowNull: true },
  },
  plans: {
    editadoEn:       { type: DataTypes.DATE, allowNull: true },
    maxSkus:         { type: DataTypes.INTEGER, allowNull: true },
    maxComprobantes: { type: DataTypes.INTEGER, allowNull: true },
  },
  subscriptions: {
    renovacionAutomatica: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: true },
    descuentoPct:         { type: DataTypes.DECIMAL(5, 2), allowNull: true, defaultValue: 0 },
    descuentoNota:        { type: DataTypes.STRING(200), allowNull: true },
    bajaSolicitadaEn:     { type: DataTypes.DATE, allowNull: true },
    bajaMotivo:           { type: DataTypes.STRING(500), allowNull: true },
  },
  platform_admins: {
    totpSecret:     { type: DataTypes.STRING(64), allowNull: true },
    totpActivadoEn: { type: DataTypes.DATE, allowNull: true },
    ultimaIp:       { type: DataTypes.STRING(60), allowNull: true },
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
    descripcion: 'clientes anteriores: cuenta corriente en cero',
    cuandoSeAgrega: 'clients.saldoCuenta',
    sql: 'UPDATE clients SET "saldoCuenta" = 0, "limiteCredito" = 0, "cuentaHabilitada" = false WHERE "saldoCuenta" IS NULL',
    sqlMssql: 'UPDATE clients SET saldoCuenta = 0, limiteCredito = 0, cuentaHabilitada = 0 WHERE saldoCuenta IS NULL',
  },
  {
    // addColumn no aplica el defaultValue a las filas que ya estaban.
    descripcion: 'ventas anteriores: recargoPagos = 0',
    cuandoSeAgrega: 'sales.recargoPagos',
    sql: 'UPDATE sales SET "recargoPagos" = 0 WHERE "recargoPagos" IS NULL',
    sqlMssql: 'UPDATE sales SET recargoPagos = 0 WHERE recargoPagos IS NULL',
  },
  /*
   * Los cinco de abajo son `reintentable`: corren en cada arranque, no sólo
   * cuando la columna se acaba de crear.
   *
   * Es la lección de una migración a medias: la columna llegó a la base pero
   * el relleno no, y las ventas viejas quedaron con la condición de pago y el
   * saldo pendiente en NULL. Sin reintento eso no se arregla nunca, porque la
   * columna ya existe y el relleno no vuelve a mirarla.
   *
   * Por eso cada uno filtra por `IS NULL`: sólo tocan filas sin completar, así
   * que repetirlos no pisa el saldo de una venta que ya se cobró en parte.
   */
  {
    // Todo lo anterior a las ventas fiadas se cobró al contado.
    descripcion: 'ventas anteriores: condición de pago contado',
    cuandoSeAgrega: 'sales.condicionPago',
    reintentable: true,
    sql: `UPDATE sales SET "condicionPago" = 'contado' WHERE "condicionPago" IS NULL`,
    sqlMssql: `UPDATE sales SET condicionPago = 'contado' WHERE condicionPago IS NULL`,
  },
  {
    // Una venta pendiente sigue debiéndose entera; una pagada no debe nada.
    descripcion: 'ventas anteriores: saldo pendiente según estado',
    cuandoSeAgrega: 'sales.saldoPendiente',
    reintentable: true,
    sql: `UPDATE sales SET "saldoPendiente" = CASE WHEN estado = 'pendiente' AND tipo = 'venta' THEN total ELSE 0 END WHERE "saldoPendiente" IS NULL`,
    sqlMssql: `UPDATE sales SET saldoPendiente = CASE WHEN estado = 'pendiente' AND tipo = 'venta' THEN total ELSE 0 END WHERE saldoPendiente IS NULL`,
  },
  {
    // Antes el stock se descontaba exactamente cuando la venta pasaba a pagada.
    descripcion: 'ventas anteriores: stock descontado si estaban pagadas',
    cuandoSeAgrega: 'sales.stockDescontado',
    reintentable: true,
    sql: `UPDATE sales SET "stockDescontado" = (estado = 'pagado') WHERE "stockDescontado" IS NULL`,
    sqlMssql: `UPDATE sales SET stockDescontado = CASE WHEN estado = 'pagado' THEN 1 ELSE 0 END WHERE stockDescontado IS NULL`,
  },
  {
    // El arqueo pasa a mirar cuándo se cobró. Para las viejas, cobrar y
    // registrar fue el mismo acto, así que la fecha de alta es la del cobro.
    descripcion: 'ventas anteriores: fecha de cobro = fecha de alta',
    cuandoSeAgrega: 'sales.cobradoEn',
    reintentable: true,
    sql: `UPDATE sales SET "cobradoEn" = "createdAt" WHERE estado = 'pagado' AND "cobradoEn" IS NULL`,
    sqlMssql: `UPDATE sales SET cobradoEn = createdAt WHERE estado = 'pagado' AND cobradoEn IS NULL`,
  },
  {
    descripcion: 'ventas anteriores: cobrador = vendedor',
    cuandoSeAgrega: 'sales.cobradoPorEmployeeId',
    reintentable: true,
    // `employeeId IS NOT NULL` evita reescribir en cada arranque las ventas del
    // dueño, que no tienen vendedor y quedarían siempre "sin completar".
    sql: `UPDATE sales SET "cobradoPorEmployeeId" = "employeeId" WHERE estado = 'pagado' AND "cobradoPorEmployeeId" IS NULL AND "employeeId" IS NOT NULL`,
    sqlMssql: `UPDATE sales SET cobradoPorEmployeeId = employeeId WHERE estado = 'pagado' AND cobradoPorEmployeeId IS NULL AND employeeId IS NOT NULL`,
  },
  {
    // Las suscripciones que ya existían renuevan salvo que pidan lo contrario.
    descripcion: 'suscripciones anteriores: renovación automática y sin descuento',
    cuandoSeAgrega: 'subscriptions.renovacionAutomatica',
    reintentable: true,
    sql: `UPDATE subscriptions SET "renovacionAutomatica" = true WHERE "renovacionAutomatica" IS NULL`,
    sqlMssql: `UPDATE subscriptions SET renovacionAutomatica = 1 WHERE renovacionAutomatica IS NULL`,
  },
  {
    descripcion: 'suscripciones anteriores: descuento en cero',
    cuandoSeAgrega: 'subscriptions.descuentoPct',
    reintentable: true,
    sql: `UPDATE subscriptions SET "descuentoPct" = 0 WHERE "descuentoPct" IS NULL`,
    sqlMssql: `UPDATE subscriptions SET descuentoPct = 0 WHERE descuentoPct IS NULL`,
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

  // Rellenos: corren para las columnas que se acaban de crear. Los marcados
  // como `reintentable` corren siempre — filtran por IS NULL, así que sólo
  // completan filas que quedaron a medias y repetirlos no cambia nada.
  const esPostgres = sequelize.getDialect() === 'postgres';
  for (const relleno of RELLENOS) {
    if (!relleno.reintentable && !agregadas.includes(relleno.cuandoSeAgrega)) continue;
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
  const { sembrarPlanes, iniciarTrial } = require('../services/planService');
  const { Subscription } = require('../models');
  let sembrados = 0;

  // Catálogo comercial. Copia config/planes.js a la tabla si falta; de ahí en
  // más manda la base, para poder retocar precios y topes sin deploy.
  await sembrarPlanes();

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

  /*
   * Cuentas anteriores a los planes: se les abre la prueba de 14 días en vez
   * de dejarlas sin suscripción. Sin esto quedarían bloqueadas de golpe por
   * una función que ellas no pidieron.
   */
  for (const negocio of negocios) {
    const tiene = await Subscription.count({ where: { businessId: negocio.id } });
    if (!tiene) await iniciarTrial(negocio.id);
  }

  return sembrados;
}

module.exports = { ensureColumns, ensureDatosIniciales, COLUMNAS_ESPERADAS };
