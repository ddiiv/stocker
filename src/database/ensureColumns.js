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

const { DataTypes, Op } = require('sequelize');
const { sinDatos } = require('../utils/logger');

// tabla → { columna: definición }
const COLUMNAS_ESPERADAS = {
  business_locations: {
    /*
     * Local o depósito. Los que ya existen quedan como 'local' —es lo que
     * venían siendo—, y el negocio marca a mano cuál es su depósito. Adivinarlo
     * por el nombre convertiría en bodega a cualquier local que se llame
     * "Depósito Central" y le cortaría las ventas de un día para el otro.
     */
    tipo: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'local' },
    // Cuándo una venta de este local va a precio mayorista. Ver el modelo y
    // reglaMayoristaService: cada local tiene la suya.
    mayoristaModo:     { type: DataTypes.STRING(10), allowNull: true, defaultValue: 'cantidad' },
    mayoristaCantidad: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 3 },
    mayoristaMonto:    { type: DataTypes.DECIMAL(12, 2), allowNull: true },
  },
  pedidos_reposicion: {
    /*
     * El saldo del pedido: lo que se pidió y no llegó a salir del depósito.
     * Queda esperando que alguien decida mandarlo o darlo de baja, y se muestra
     * primero en la bandeja para que no se pierda de vista.
     */
    saldoEstado:    { type: DataTypes.STRING(20), allowNull: true },
    saldoMotivo:    { type: DataTypes.STRING(500), allowNull: true },
    saldoResueltoPorEmployeeId: { type: DataTypes.INTEGER, allowNull: true },
    saldoResueltoEn:            { type: DataTypes.DATE, allowNull: true },
    pedidoOrigenId: { type: DataTypes.INTEGER, allowNull: true },
  },
  mercadolibre_accounts: {
    // De qué lugar sale el stock que se publica. Nulo hasta que el negocio lo
    // elija; ahí se resuelve al primero de tipo `online`.
    locationId: { type: DataTypes.INTEGER, allowNull: true },
  },
  sale_items: {
    /*
     * El costo de la mercadería al momento de venderla.
     *
     * Sin esto el margen histórico se calculaba contra el costo ACTUAL del
     * producto: cuando un proveedor sube los precios, todos los márgenes del
     * año pasado cambian solos y un mes que fue bueno pasa a figurar en
     * pérdida. Un análisis a varios años necesita que el pasado no se reescriba.
     *
     * Nulo en las ventas anteriores a este cambio: ahí se cae al costo del
     * producto, que es la mejor aproximación disponible y queda dicho.
     */
    costoUnitario: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
  },
  product_variants: {
    codigoBarras: { type: DataTypes.STRING(60), allowNull: true },
    /*
     * El negocio dueño de la variante, copiado del producto.
     *
     * Es una desnormalización deliberada y existe por una sola razón: el SKU
     * tiene que ser único dentro de un negocio y libre entre negocios. Sin esta
     * columna el único índice posible es sobre `sku` a secas, o sea global, y
     * entonces el primer local que registra "REMERA-NEG-M" se lo saca a todos
     * los demás clientes de Stocker para siempre.
     */
    businessId: { type: DataTypes.INTEGER, allowNull: true },
    /*
     * Precios propios de la variante. Nulos a propósito: nulo significa
     * "usa el del producto", que es lo que hacen casi todas.
     */
    precioMinorista: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    precioMayorista: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    costo:           { type: DataTypes.DECIMAL(12, 2), allowNull: true },
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
    // Cómo arma este negocio los SKU de sus variantes. JSON en texto, como el
    // resto: MSSQL no tiene tipo JSON. Vacío = las reglas de fábrica.
    reglaSku:     { type: DataTypes.TEXT, allowNull: true },
    // Política de venta sin stock. Los negocios que ya existen arrancan en
    // 'permitir': es lo que pide el mostrador y lo que evita perder la venta.
    ventaSinStock: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'permitir' },
    // Funciones que el negocio conserva aunque su plan no las incluya. La
    // llena `heredarFeaturesEnUso` una sola vez. Ver el modelo Business.
    featuresHeredadas: { type: DataTypes.STRING(255), allowNull: true },
  },
  products: {
    // Producto de feria: se vende sin llevar inventario. Ver el modelo.
    esFeria:         { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false },
    origenProductId: { type: DataTypes.INTEGER, allowNull: true },
  },

  sales: {
    // El número de venta que una cotización tiene apartado. Ver el modelo.
    numeroVenta: { type: DataTypes.STRING(25), allowNull: true },
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
/*
 * Índices que no están declarados en los modelos.
 *
 * Se manejan acá y no en la definición del modelo porque son cambios sobre
 * tablas que ya existen en producción, y porque uno de ellos reemplaza a otro:
 * hay que crear el nuevo y recién después borrar el viejo.
 */
const INDICES = [
  {
    tabla: 'product_variants',
    nombre: 'uq_variants_business_sku',
    columnas: ['businessId', 'sku'],
    unico: true,
    /*
     * Sólo se crea cuando ninguna variante quedó sin negocio.
     *
     * En SQL Server y en Postgres un índice único trata a los NULL como un
     * valor más: con dos filas sin businessId la creación falla, y peor, si
     * llegara a pasar dejaría el sistema sin ninguna garantía de unicidad.
     * Mejor no crearlo y volver a intentar en el próximo arranque, cuando el
     * relleno ya haya terminado.
     */
    requiere: 'SELECT COUNT(*) AS faltan FROM product_variants WHERE businessId IS NULL',
    requierePg: 'SELECT COUNT(*) AS faltan FROM product_variants WHERE "businessId" IS NULL',
    // El global se va recién cuando el nuevo está en pie.
    reemplaza: 'uq_variants_sku',
  },
  /*
   * Los índices del análisis.
   *
   * Todas las consultas del dashboard filtran por negocio + tipo + estado y
   * recortan por fecha. Sin este índice, cada carga del panel recorre la tabla
   * de ventas entera: con tres años de historia eso son decenas de miles de
   * filas leídas para mostrar un número.
   */
  {
    tabla: 'sales',
    nombre: 'idx_sales_analitica',
    columnas: ['businessId', 'tipo', 'estado', 'fecha'],
    unico: false,
  },
  {
    // El JOIN de los items contra su venta, que es el otro lado de cada agregado.
    tabla: 'sale_items',
    nombre: 'idx_sale_items_venta',
    columnas: ['saleId'],
    unico: false,
  },
  {
    /*
     * El número reservado también es único, y por el mismo motivo que el otro:
     * es el que la venta va a usar cuando la cotización se convierta. Si dos
     * cotizaciones reservaran el mismo, la segunda en convertirse chocaría
     * contra uq_sales_biz_numero y quedaría trabada sin forma de destrabarse.
     *
     * Va filtrado por IS NOT NULL porque las ventas normales lo tienen vacío:
     * los dos motores tratan al NULL como un valor más y sin el filtro no
     * podría haber dos ventas sin reserva. Postgres y SQL Server escriben el
     * índice parcial igual, así que alcanza con el `where`.
     */
    tabla: 'sales',
    nombre: 'uq_sales_biz_numero_venta',
    columnas: ['businessId', 'numeroVenta'],
    unico: true,
    where: { numeroVenta: { [Op.not]: null } },
  },
];

const RELLENOS = [
  {
    descripcion: 'locales anteriores a la regla mayorista quedan con las 3 prendas de siempre',
    cuandoSeAgrega: 'business_locations.mayoristaModo',
    /*
     * Con NULL, la regla no existe y hay que decidir en cada consulta qué
     * significa eso — que es como se cuelan dos interpretaciones distintas del
     * mismo dato. Se deja escrito lo que el sistema venía haciendo.
     */
    reintentable: true,
    sql: `UPDATE business_locations SET "mayoristaModo" = 'cantidad', "mayoristaCantidad" = 3
           WHERE "mayoristaModo" IS NULL OR "mayoristaCantidad" IS NULL`,
    sqlMssql: `UPDATE business_locations SET mayoristaModo = 'cantidad', mayoristaCantidad = 3
                WHERE mayoristaModo IS NULL OR mayoristaCantidad IS NULL`,
  },

  {
    descripcion: 'productos anteriores al evento marcados como catálogo normal',
    cuandoSeAgrega: 'products.esFeria',
    /*
     * Reintentable y con guarda de NULL: la columna se agregó a una tabla que ya
     * tenía filas, así que todo lo anterior quedó en NULL. Un NULL acá no es
     * inocuo — en SQL, "no es de feria" preguntado sobre NULL da NULL, y la fila
     * queda afuera del filtro sin que nadie se entere.
     */
    reintentable: true,
    sql: 'UPDATE products SET "esFeria" = false WHERE "esFeria" IS NULL',
    sqlMssql: 'UPDATE products SET esFeria = 0 WHERE esFeria IS NULL',
  },

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
  {
    /*
     * Cada variante hereda el negocio de su producto.
     *
     * Reintentable y filtrando por IS NULL: si el arranque se corta a la mitad,
     * el próximo termina lo que falta. Y es lo que habilita el índice único de
     * arriba, que no se crea hasta que esto no deje ninguna fila sin completar.
     */
    descripcion: 'variantes: heredar el negocio del producto',
    cuandoSeAgrega: 'product_variants.businessId',
    reintentable: true,
    sql: 'UPDATE product_variants SET "businessId" = p."businessId" FROM products p WHERE p.id = product_variants."productId" AND product_variants."businessId" IS NULL',
    sqlMssql: 'UPDATE v SET v.businessId = p.businessId FROM product_variants v JOIN products p ON p.id = v.productId WHERE v.businessId IS NULL',
  },
  {
    /*
     * El stock que había pasa al primer local de cada negocio.
     *
     * Hasta ahora `product_variants.stock` era un número suelto, sin lugar.
     * Al pasar a stock por local hay que decidir dónde estaba, y la única
     * respuesta honesta es "en el local principal": es donde el negocio venía
     * operando, y repartirlo entre locales sería inventar datos.
     *
     * Reintentable y con NOT EXISTS: sólo crea las filas que faltan, así que
     * repetirlo no duplica ni pisa un stock ya ajustado por local. Una variante
     * que ya fue distribuida a mano no se toca.
     *
     * Los negocios sin locales quedan sin filas: su stock sigue viviendo en el
     * total, que es exactamente lo que tenían antes.
     *
     * Va después del relleno de `businessId` porque filtra por esa columna: al
     * revés, en una base recién migrada no encontraría ninguna variante y todo
     * el stock quedaría sin local hasta el arranque siguiente.
     */
    descripcion: 'stock existente: asignarlo al local principal',
    cuandoSeAgrega: 'product_variants.businessId',
    reintentable: true,
    sql: `
      INSERT INTO variant_stocks ("businessId", "productVariantId", "locationId", stock, "createdAt", "updatedAt")
      SELECT v."businessId", v.id, l.id, COALESCE(v.stock, 0), NOW(), NOW()
      FROM product_variants v
      JOIN LATERAL (
        SELECT id FROM business_locations
        WHERE "businessId" = v."businessId" AND activo = true
        ORDER BY id ASC LIMIT 1
      ) l ON true
      WHERE v."businessId" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM variant_stocks vs WHERE vs."productVariantId" = v.id)`,
    sqlMssql: `
      INSERT INTO variant_stocks (businessId, productVariantId, locationId, stock, createdAt, updatedAt)
      SELECT v.businessId, v.id, l.id, ISNULL(v.stock, 0), GETDATE(), GETDATE()
      FROM product_variants v
      CROSS APPLY (
        SELECT TOP 1 id FROM business_locations
        WHERE businessId = v.businessId AND activo = 1
        ORDER BY id ASC
      ) l
      WHERE v.businessId IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM variant_stocks vs WHERE vs.productVariantId = v.id)`,
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
    /*
     * Ventas fiadas saldadas con un pago a cuenta antes del arreglo: quedaron
     * en 'pagado' con totalCobrado en cero, así que las métricas las contaban
     * como $0. Sobre un pago a cuenta no hay recargo, o sea que lo cobrado es
     * el total. Reintentable y acotado a ese caso exacto.
     */
    descripcion: 'ventas fiadas saldadas a cuenta: completar lo cobrado',
    cuandoSeAgrega: 'sales.totalCobrado',
    reintentable: true,
    sql: `UPDATE sales SET "totalCobrado" = total WHERE estado = 'pagado' AND "condicionPago" = 'cuenta_corriente' AND ("totalCobrado" IS NULL OR "totalCobrado" = 0) AND total > 0`,
    sqlMssql: `UPDATE sales SET totalCobrado = total WHERE estado = 'pagado' AND condicionPago = 'cuenta_corriente' AND (totalCobrado IS NULL OR totalCobrado = 0) AND total > 0`,
  },
  {
    descripcion: 'suscripciones anteriores: descuento en cero',
    cuandoSeAgrega: 'subscriptions.descuentoPct',
    reintentable: true,
    sql: `UPDATE subscriptions SET "descuentoPct" = 0 WHERE "descuentoPct" IS NULL`,
    sqlMssql: `UPDATE subscriptions SET descuentoPct = 0 WHERE descuentoPct IS NULL`,
  },
  {
    /*
     * Ventas anteriores: se copia el costo actual del producto.
     *
     * Es una aproximación y no hay otra: el costo de entonces no quedó
     * guardado en ninguna parte. A partir de ahora cada venta guarda el suyo,
     * así que el error no crece.
     */
    descripcion: 'items de venta anteriores: costo del producto',
    cuandoSeAgrega: 'sale_items.costoUnitario',
    reintentable: true,
    /*
     * Postgres y SQL Server escriben el UPDATE con JOIN distinto, y no es un
     * detalle de estilo: en Postgres la tabla que se actualiza NO se repite en
     * el FROM —la relación va en el WHERE— y el SET no lleva el alias adelante.
     * Escrito a la manera de SQL Server, Postgres responde
     * `relation "si" does not exist` y el relleno no corre nunca.
     */
    sql: `UPDATE sale_items si
             SET "costoUnitario" = p.costo
            FROM product_variants pv
            JOIN products p ON p.id = pv."productId"
           WHERE pv.id = si."productVariantId"
             AND si."costoUnitario" IS NULL`,
    sqlMssql: `UPDATE si SET si.costoUnitario = p.costo
               FROM sale_items si
               JOIN product_variants pv ON pv.id = si.productVariantId
               JOIN products p ON p.id = pv.productId
               WHERE si.costoUnitario IS NULL`,
  },
  {
    // Los locales que ya existían son locales. Un depósito se marca a mano.
    descripcion: 'locales existentes: tipo local',
    cuandoSeAgrega: 'business_locations.tipo',
    reintentable: true,
    sql: `UPDATE business_locations SET tipo = 'local' WHERE tipo IS NULL OR tipo = ''`,
    sqlMssql: `UPDATE business_locations SET tipo = 'local' WHERE tipo IS NULL OR tipo = ''`,
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
        console.warn(`[schema] No se pudo agregar ${tabla}.${nombre}: ${sinDatos(err.message, 160)}`);
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
      console.warn(`[schema] No se pudo aplicar "${relleno.descripcion}": ${sinDatos(err.message, 160)}`);
    }
  }

  await liberarNumeroDeCotizaciones(sequelize);
  await heredarFeaturesEnUso(sequelize);
  await asegurarIndices(sequelize, esPostgres);

  return agregadas;
}

/*
 * Le respeta a cada negocio las funciones que ya venía usando.
 *
 * Depósito, reposición y eventos existieron sin puerta durante meses:
 * cualquier cuenta los usaba, pagara lo que pagara. El día que entran al
 * catálogo de planes, cortarle el acceso a quien ya tiene mercadería cargada o
 * el catálogo de evento armado sería dejarlo afuera de SUS datos por un cambio
 * comercial nuestro.
 *
 * Así que se saca una foto: quien ya tenía datos de esa función, la conserva.
 * Quien todavía no la usó, pasa por la puerta como corresponde.
 *
 * Corre una sola vez por negocio —la marca es la columna ya escrita— y por eso
 * la foto es del momento del despliegue y no se mueve después. Es exactamente
 * lo que se quiere: si se recalculara en cada arranque, cualquiera se abriría
 * la función usándola una vez el día que le corten.
 */
async function heredarFeaturesEnUso() {
  const { Business, BusinessLocation, StockIngreso, PedidoReposicion, Product } = require('../models');

  let negocios;
  try {
    negocios = await Business.findAll({ where: { featuresHeredadas: null }, attributes: ['id'] });
  } catch {
    // La columna todavía no existe (primer arranque del deploy). El próximo la
    // encuentra.
    return;
  }
  if (!negocios.length) return;

  let marcados = 0;
  for (const negocio of negocios) {
    const heredadas = [];
    try {
      const [depositos, ingresos, pedidos, ferias, productosFeria] = await Promise.all([
        BusinessLocation.count({ where: { businessId: negocio.id, tipo: 'deposito' } }),
        StockIngreso.count({ where: { businessId: negocio.id } }),
        PedidoReposicion.count({ where: { businessId: negocio.id } }),
        BusinessLocation.count({ where: { businessId: negocio.id, tipo: 'feria' } }),
        Product.count({ where: { businessId: negocio.id, esFeria: true } }),
      ]);
      if (depositos > 0 || ingresos > 0) heredadas.push('deposito');
      if (pedidos > 0) heredadas.push('reposicion');
      if (ferias > 0 || productosFeria > 0) heredadas.push('eventos');
    } catch (err) {
      console.warn(`[schema] no se pudo mirar el uso del negocio ${negocio.id}: ${sinDatos(err.message, 160)}`);
      continue;
    }

    /*
     * Se escribe SIEMPRE, aunque la lista quede vacía.
     *
     * La cadena vacía es la marca de "a éste ya lo miramos". Dejarlo en NULL
     * haría que el próximo arranque lo volviera a mirar, y con eso la foto
     * dejaría de ser una foto.
     */
    await negocio.update({ featuresHeredadas: heredadas.join(',') });
    if (heredadas.length) marcados += 1;
  }
  if (marcados) {
    console.log(`[schema] ${marcados} negocio(s) conservan funciones que ya usaban antes de entrar al plan`);
  }
}

/*
 * Les suelta el número de venta a las cotizaciones que lo tenían apartado.
 *
 * Es el reverso de lo que hacía este mismo archivo hasta hace poco. Mientras
 * las cotizaciones se convertían en venta, cada una nacía con un número de
 * venta reservado para no pelearlo el día de la conversión. Las cotizaciones
 * dejaron de convertirse, así que esa reserva pasó a ser un número sacado de
 * la serie que nadie va a usar nunca: un hueco permanente en la numeración,
 * imposible de explicar mirando la lista de ventas.
 *
 * Soltarlo no reescribe ninguna cotización: sigue siendo el mismo presupuesto,
 * con su mismo número COT-. Lo único que cambia es que el número de venta
 * vuelve a la cola.
 *
 * Va en un UPDATE y no en un RELLENO de la tabla de arriba porque no completa
 * una columna nueva: limpia una vieja. Es idempotente —en cuanto no queda
 * ninguna con reserva no escribe nada— y por eso corre en cada arranque.
 */
async function liberarNumeroDeCotizaciones(sequelize) {
  const { Sale } = require('../models');
  const { Op } = require('sequelize');

  try {
    const soltadas = await Sale.update(
      { numeroVenta: null },
      { where: { tipo: 'cotizacion', numeroVenta: { [Op.ne]: null } } },
    );
    const n = Array.isArray(soltadas) ? soltadas[0] : 0;
    if (n) console.log(`[schema] ${n} cotización(es) soltaron el número de venta que tenían apartado`);
  } catch (err) {
    // La columna puede no existir todavía en un primer arranque. El próximo la
    // encuentra, y mientras tanto no hay nada que soltar.
    console.warn(`[schema] no se pudo soltar la reserva de las cotizaciones: ${sinDatos(err.message, 160)}`);
  }
}

/*
 * Crea los índices de INDICES y retira los que reemplazan.
 *
 * Todo lo que falla acá se avisa y sigue: un índice que no se pudo crear no
 * puede impedir que arranque el servidor, pero tampoco puede pasar en silencio
 * — si el único de SKU no está, el sistema queda aceptando duplicados y eso hay
 * que verlo en los logs del deploy.
 */
/*
 * Retira un índice único, sea índice o constraint.
 *
 * Un UNIQUE creado como constraint se apoya en un índice que aparece en
 * showIndex, pero DROP INDEX lo rechaza: hay que soltar la constraint. Cuál de
 * las dos formas tiene cada base depende de cómo se creó en su momento, y en
 * este proyecto conviven las dos. Se prueba la constraint primero y se cae al
 * índice, en vez de adivinar.
 */
async function retirar(sequelize, qi, tabla, nombre) {
  try {
    await sequelize.query(`ALTER TABLE ${qi.quoteIdentifier(tabla)} DROP CONSTRAINT ${qi.quoteIdentifier(nombre)}`);
  } catch {
    await qi.removeIndex(tabla, nombre);
  }
}

async function asegurarIndices(sequelize, esPostgres) {
  const qi = sequelize.getQueryInterface();

  for (const idx of INDICES) {
    try {
      const existentes = await qi.showIndex(idx.tabla);
      const yaEsta = existentes.some((i) => i.name === idx.nombre);

      if (!yaEsta) {
        if (idx.requiere) {
          const [filas] = await sequelize.query(esPostgres ? idx.requierePg : idx.requiere);
          const faltan = Number(filas?.[0]?.faltan) || 0;
          if (faltan > 0) {
            console.warn(`[schema] ${idx.nombre} todavía no: ${faltan} fila(s) sin completar. Se reintenta en el próximo arranque.`);
            continue;
          }
        }
        await qi.addIndex(idx.tabla, idx.columnas, { name: idx.nombre, unique: idx.unico, where: idx.where });
        console.log(`[schema] índice ${idx.nombre} creado`);
      }

      /*
       * El viejo se borra sólo después de confirmar que el nuevo está.
       *
       * Al revés quedaría una ventana —corta, pero real— en la que no hay
       * ninguna restricción de unicidad sobre el SKU, y en ese hueco cualquier
       * alta concurrente mete el duplicado que el índice existía para impedir.
       */
      if (idx.reemplaza) {
        const ahora = await qi.showIndex(idx.tabla);
        const nuevoEsta = ahora.some((i) => i.name === idx.nombre);
        const viejoEsta = ahora.some((i) => i.name === idx.reemplaza);
        if (nuevoEsta && viejoEsta) {
          await retirar(sequelize, qi, idx.tabla, idx.reemplaza);
          console.log(`[schema] ${idx.reemplaza} retirado (lo reemplaza ${idx.nombre})`);
        }
      }
    } catch (err) {
      console.warn(`[schema] No se pudo asegurar el índice ${idx.nombre}: ${sinDatos(err.message, 160)}`);
    }
  }
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
