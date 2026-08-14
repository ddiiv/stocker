const { DataTypes } = require('sequelize');
const db = require('../config/database');

// NOTA: los campos unique NO llevan unique:true en el modelo porque SQL Server
// no soporta UNIQUE inline en ALTER COLUMN. Las constraints únicas están
// definidas en database/schema.sql y Sequelize las respeta igual.

// ─── Business ────────────────────────────────────────────────────
const Business = db.define('Business', {
  id:            { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  nombreNegocio: { type: DataTypes.STRING(150), allowNull: false },
  ownerNombre:   { type: DataTypes.STRING(100), allowNull: false },
  ownerApellido: { type: DataTypes.STRING(100), allowNull: false },
  ownerTelefono: { type: DataTypes.STRING(30) },
  cuit:          { type: DataTypes.STRING(20),  allowNull: false },
  telefono:      { type: DataTypes.STRING(30) },
  email:         { type: DataTypes.STRING(150), allowNull: false },
  passwordHash:  { type: DataTypes.STRING(255), allowNull: false },
}, { tableName: 'businesses' });

// ─── BusinessCuit (multi-CUIT por negocio) ───────────────────────
const BusinessCuit = db.define('BusinessCuit', {
  id:           { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  businessId:   { type: DataTypes.INTEGER, allowNull: false },
  nombre:       { type: DataTypes.STRING(150), allowNull: false },
  cuit:         { type: DataTypes.STRING(20),  allowNull: false },
  condicionIva: { type: DataTypes.STRING(60) },
  domicilio:    { type: DataTypes.STRING(255) },
  esPrincipal:  { type: DataTypes.BOOLEAN, defaultValue: false },
}, { tableName: 'business_cuits' });

// ─── BusinessArcaConfig (config ARCA por CUIT del negocio) ───────
const BusinessArcaConfig = db.define('BusinessArcaConfig', {
  id:                   { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  businessId:           { type: DataTypes.INTEGER, allowNull: false },
  businessCuitId:       { type: DataTypes.INTEGER, allowNull: false },
  puntoVenta:           { type: DataTypes.INTEGER },
  condicionIva:         { type: DataTypes.STRING(60) },
  ambiente:             { type: DataTypes.STRING(20), defaultValue: 'homologacion' },
  delegacionVerificada: { type: DataTypes.BOOLEAN, defaultValue: false },
  ultimaVerificacion:   { type: DataTypes.DATE },
  ultimoError:          { type: DataTypes.STRING(500) },
}, { tableName: 'business_arca_configs' });

// ─── ArcaToken (cache del TA de AFIP) ────────────────────────────
// AFIP no reemite un TA hasta que el vigente expira (12h). Guardarlo en
// disco no sirve en hosting con filesystem efímero (Railway): cada deploy
// lo perdería y quedaríamos 12h sin poder autenticar. En la base sobrevive
// deploys y lo comparten todas las instancias.
const ArcaToken = db.define('ArcaToken', {
  id:        { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  // clave = cuit::ambiente::service
  clave:     { type: DataTypes.STRING(120), allowNull: false, unique: true },
  token:     { type: DataTypes.TEXT, allowNull: false },
  sign:      { type: DataTypes.TEXT, allowNull: false },
  cuit:      { type: DataTypes.STRING(11) },
  expiraEn:  { type: DataTypes.DATE, allowNull: false },
}, { tableName: 'arca_tokens' });

// ─── MercadoLibreAccount (integración por negocio) ───────────────
// Guarda el OAuth de ML. El access_token dura 6h y se renueva con el
// refresh_token (que dura 6 meses y se rota en cada refresh, así que hay
// que persistir el nuevo cada vez).
const MercadoLibreAccount = db.define('MercadoLibreAccount', {
  id:              { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  businessId:      { type: DataTypes.INTEGER, allowNull: false, unique: true },
  mlUserId:        { type: DataTypes.STRING(30) },
  nickname:        { type: DataTypes.STRING(120) },
  accessToken:     { type: DataTypes.TEXT },
  refreshToken:    { type: DataTypes.TEXT },
  tokenExpiraEn:   { type: DataTypes.DATE },
  // sincronizacion
  syncActiva:      { type: DataTypes.BOOLEAN, defaultValue: true },
  ultimaSync:      { type: DataTypes.DATE },
  ultimoError:     { type: DataTypes.STRING(500) },
}, { tableName: 'mercadolibre_accounts' });

// ─── MercadoLibreLink (vínculo SKU Stocker ↔ publicación ML) ─────
const MercadoLibreLink = db.define('MercadoLibreLink', {
  id:              { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  businessId:      { type: DataTypes.INTEGER, allowNull: false },
  sku:             { type: DataTypes.STRING(60), allowNull: false },
  mlItemId:        { type: DataTypes.STRING(30), allowNull: false }, // MLA123456789
  mlVariationId:   { type: DataTypes.STRING(30) },                   // si la publicación tiene variantes
  titulo:          { type: DataTypes.STRING(200) },
  ultimoStockEnviado: { type: DataTypes.INTEGER },
  ultimaSync:      { type: DataTypes.DATE },
  ultimoError:     { type: DataTypes.STRING(500) },
}, { tableName: 'mercadolibre_links' });

// ─── VariantType (variantes maestras: Color, Talle, …) ───────────
const VariantType = db.define('VariantType', {
  id:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  businessId: { type: DataTypes.INTEGER, allowNull: false },
  nombre:     { type: DataTypes.STRING(80), allowNull: false },
  valores:    {
    type: DataTypes.TEXT,
    allowNull: false,
    defaultValue: '[]',
    get() { try { return JSON.parse(this.getDataValue('valores')); } catch { return []; } },
    set(val) { this.setDataValue('valores', typeof val === 'string' ? val : JSON.stringify(val)); },
  },
}, { tableName: 'variant_types' });

// ─── PasswordResetCode (recuperación de contraseña) ─────────────
const PasswordResetCode = db.define('PasswordResetCode', {
  id:           { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  businessId:   { type: DataTypes.INTEGER, allowNull: false },
  code:         { type: DataTypes.STRING(10), allowNull: false },
  attemptsLeft: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 4 },
  expiresAt:    { type: DataTypes.DATE, allowNull: false },
  usedAt:       { type: DataTypes.DATE },
  alertSentAt:  { type: DataTypes.DATE },
}, { tableName: 'password_reset_codes' });

// ─── EmployeeSession (tracking) ──────────────────────────────────
const EmployeeSession = db.define('EmployeeSession', {
  id:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  employeeId: { type: DataTypes.INTEGER, allowNull: false },
  ip:         { type: DataTypes.STRING(64) },
  userAgent:  { type: DataTypes.STRING(500) },
  loginAt:    { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  lastSeenAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, { tableName: 'employee_sessions', timestamps: false });

// ─── BusinessLocation ─────────────────────────────────────────────
const BusinessLocation = db.define('BusinessLocation', {
  id:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  businessId: { type: DataTypes.INTEGER, allowNull: false },
  nombre:     { type: DataTypes.STRING(150), allowNull: false },
  direccion:  { type: DataTypes.STRING(255), allowNull: false },
  telefono:   { type: DataTypes.STRING(30) },
  activo:     { type: DataTypes.BOOLEAN, defaultValue: true },
}, { tableName: 'business_locations' });

// ─── Role ─────────────────────────────────────────────────────────
const Role = db.define('Role', {
  id:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  businessId: { type: DataTypes.INTEGER, allowNull: false },
  nombre:     { type: DataTypes.STRING(80), allowNull: false },
  // SQL Server almacena JSON como NVARCHAR(MAX)
  permisos:   {
    type: DataTypes.TEXT,   // se serializa/deserializa manualmente
    allowNull: false,
    defaultValue: '{"stock":"ninguno","ventas":"ninguno","facturacion":"ninguno","empleados":"ninguno","dashboard":"ninguno","cotizaciones":"ninguno"}',
    get() { try { return JSON.parse(this.getDataValue('permisos')); } catch { return {}; } },
    set(val) { this.setDataValue('permisos', typeof val === 'string' ? val : JSON.stringify(val)); },
  },
}, { tableName: 'roles' });

// ─── Employee ─────────────────────────────────────────────────────
const Employee = db.define('Employee', {
  id:             { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  businessId:     { type: DataTypes.INTEGER, allowNull: false },
  locationId:     { type: DataTypes.INTEGER, allowNull: true },
  roleId:         { type: DataTypes.INTEGER, allowNull: true },
  dni:            { type: DataTypes.STRING(20), allowNull: false },
  nombre:         { type: DataTypes.STRING(100), allowNull: false },
  apellido:       { type: DataTypes.STRING(100), allowNull: false },
  telefono:       { type: DataTypes.STRING(30) },
  email:          { type: DataTypes.STRING(150), allowNull: false },
  passwordHash:   { type: DataTypes.STRING(255) },
  activo:         { type: DataTypes.BOOLEAN, defaultValue: true },
  ultimaConexion: { type: DataTypes.DATE, allowNull: true },
}, { tableName: 'employees' });

// ─── Client ───────────────────────────────────────────────────────
const Client = db.define('Client', {
  id:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  businessId: { type: DataTypes.INTEGER, allowNull: false },
  nombre:     { type: DataTypes.STRING(100), allowNull: false },
  apellido:   { type: DataTypes.STRING(100) },
  email:      { type: DataTypes.STRING(150) },
  telefono:   { type: DataTypes.STRING(30) },
  whatsapp:   { type: DataTypes.STRING(30) },
  cuit:       { type: DataTypes.STRING(20) },
  dni:        { type: DataTypes.STRING(20) },
  direccion:  { type: DataTypes.STRING(255) },
  tipo:       { type: DataTypes.STRING(20), defaultValue: 'minorista' }, // minorista|mayorista|empresa
  notas:      { type: DataTypes.TEXT },
}, { tableName: 'clients' });

// ─── Product ──────────────────────────────────────────────────────
const Product = db.define('Product', {
  id:              { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  businessId:      { type: DataTypes.INTEGER, allowNull: false },
  sku:             { type: DataTypes.STRING(80), allowNull: false },
  skuAgrupador:    { type: DataTypes.STRING(80), allowNull: false },
  titulo:          { type: DataTypes.STRING(200), allowNull: false },
  descripcion:     { type: DataTypes.TEXT },
  precioMinorista: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
  precioMayorista: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
  costo:           { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
  variantes: {
    type: DataTypes.TEXT,
    defaultValue: '{}',
    get() { try { return JSON.parse(this.getDataValue('variantes')); } catch { return {}; } },
    set(val) { this.setDataValue('variantes', typeof val === 'string' ? val : JSON.stringify(val)); },
  },
  modelo:             { type: DataTypes.STRING(80) },
  categoria:          { type: DataTypes.STRING(80) },
  genero:             { type: DataTypes.STRING(40) },
  activo:             { type: DataTypes.BOOLEAN, defaultValue: true },
  fechaActualizacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, { tableName: 'products' });

// ─── ProductVariant ───────────────────────────────────────────────
const ProductVariant = db.define('ProductVariant', {
  id:              { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  productId:       { type: DataTypes.INTEGER, allowNull: false },
  sku:             { type: DataTypes.STRING(100), allowNull: false },
  // Código que devuelve el lector de barras. Puede ser el EAN del proveedor
  // o el de una etiqueta propia. Si está vacío, el escaneo cae al SKU.
  codigoBarras:    { type: DataTypes.STRING(60) },
  variante1Nombre: { type: DataTypes.STRING(40) },
  variante1Valor:  { type: DataTypes.STRING(80) },
  variante2Nombre: { type: DataTypes.STRING(40) },
  variante2Valor:  { type: DataTypes.STRING(80) },
  stock:           { type: DataTypes.INTEGER, defaultValue: 0 },
  stockMinimo:     { type: DataTypes.INTEGER, defaultValue: 5 },
  activo:          { type: DataTypes.BOOLEAN, defaultValue: true },
}, { tableName: 'product_variants' });

// ─── StockMovement ────────────────────────────────────────────────
const StockMovement = db.define('StockMovement', {
  id:               { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  productVariantId: { type: DataTypes.INTEGER, allowNull: false },
  locationId:       { type: DataTypes.INTEGER, allowNull: true },
  employeeId:       { type: DataTypes.INTEGER, allowNull: true },
  saleItemId:       { type: DataTypes.INTEGER, allowNull: true },
  tipo:             { type: DataTypes.STRING(20), allowNull: false }, // ingreso|egreso|ajuste|devolucion
  cantidad:         { type: DataTypes.INTEGER, allowNull: false },
  stockAnterior:    { type: DataTypes.INTEGER, allowNull: false },
  stockNuevo:       { type: DataTypes.INTEGER, allowNull: false },
  motivo:           { type: DataTypes.STRING(255) },
  fechaMovimiento:  { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, { tableName: 'stock_movements', timestamps: false });

// ─── Sale ────────────────────────────────────────────────────────
const Sale = db.define('Sale', {
  id:           { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  businessId:   { type: DataTypes.INTEGER, allowNull: false },
  locationId:   { type: DataTypes.INTEGER, allowNull: true },
  employeeId:   { type: DataTypes.INTEGER, allowNull: true },
  clientId:     { type: DataTypes.INTEGER, allowNull: true },
  numero:       { type: DataTypes.STRING(25), allowNull: false },
  tipo:         { type: DataTypes.STRING(15), defaultValue: 'venta' },    // venta|cotizacion
  estado:       { type: DataTypes.STRING(15), defaultValue: 'pendiente' }, // pendiente|pagado|cancelado|vencida
  esMayorista:  { type: DataTypes.BOOLEAN, defaultValue: false },
  subtotal:     { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
  descuentoPct: { type: DataTypes.DECIMAL(5,2), defaultValue: 0 },
  descuento:    { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
  // `total` es el neto de la mercadería. Se mantiene con ese significado
  // porque encima se apoyan la facturación y todas las métricas: es lo que
  // el negocio vendió, sin el costo financiero del medio de pago.
  total:        { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
  // Texto de resumen ("Efectivo" o "Efectivo + Transferencia"). El detalle
  // real vive en sale_payments; esto queda para listados y tickets.
  medioPago:    { type: DataTypes.STRING(60) },
  // Suma neta de recargos y descuentos de los medios de pago usados.
  // Positivo = recargo; negativo = descuento.
  recargoPagos: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
  // Lo que efectivamente pagó el cliente: total + recargoPagos.
  totalCobrado: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
  notas:        { type: DataTypes.TEXT },
  cotizacionId: { type: DataTypes.INTEGER, allowNull: true },
  fecha:        { type: DataTypes.DATEONLY, allowNull: false },
}, { tableName: 'sales' });

// ─── PaymentMethod ───────────────────────────────────────────────
// Medios de pago que ofrece cada negocio, con su ajuste por defecto.
const PaymentMethod = db.define('PaymentMethod', {
  id:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  businessId: { type: DataTypes.INTEGER, allowNull: false },
  nombre:     { type: DataTypes.STRING(60), allowNull: false },
  // Porcentaje sobre el total. Positivo recarga (ej. 5 = +5% por
  // transferencia), negativo descuenta (ej. -10 = 10% off por efectivo).
  ajustePct:  { type: DataTypes.DECIMAL(5,2), defaultValue: 0 },
  activo:     { type: DataTypes.BOOLEAN, defaultValue: true },
  orden:      { type: DataTypes.INTEGER, defaultValue: 0 },
  notas:      { type: DataTypes.STRING(200) },
  // Marca explícita en vez de adivinar por el nombre: es lo único que entra al
  // arqueo, porque el resto no pasa por el cajón. Con un "Efectivo USD" o un
  // "Contado" la deducción por texto fallaba en silencio y la caja cerraba mal.
  esEfectivo: { type: DataTypes.BOOLEAN, defaultValue: false },
}, { tableName: 'payment_methods' });

// ─── CashShift (turno de caja) ───────────────────────────────────
// El arqueo es del empleado que atiende la caja. El dueño no abre turno:
// no está detrás del mostrador y no tiene efectivo que rendir.
const CashShift = db.define('CashShift', {
  id:            { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  businessId:    { type: DataTypes.INTEGER, allowNull: false },
  employeeId:    { type: DataTypes.INTEGER, allowNull: false },
  locationId:    { type: DataTypes.INTEGER, allowNull: true },
  // Efectivo con el que arranca el turno (cambio inicial).
  montoInicial:  { type: DataTypes.DECIMAL(12,2), allowNull: false, defaultValue: 0 },
  abiertoEn:     { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  cerradoEn:     { type: DataTypes.DATE, allowNull: true },
  // Lo que el sistema calcula que debería haber: inicial + ventas en efectivo
  // + ingresos - egresos - retiros. Se congela al cerrar.
  montoEsperado: { type: DataTypes.DECIMAL(12,2), allowNull: true },
  // Lo que el empleado contó físicamente en la caja.
  montoDeclarado:{ type: DataTypes.DECIMAL(12,2), allowNull: true },
  // declarado - esperado. Negativo = falta plata.
  diferencia:    { type: DataTypes.DECIMAL(12,2), allowNull: true },
  estado:        { type: DataTypes.STRING(15), defaultValue: 'abierto' }, // abierto|cerrado
  notaCierre:    { type: DataTypes.STRING(500) },
}, { tableName: 'cash_shifts' });

// ─── CashMovement (movimientos de caja) ──────────────────────────
const CashMovement = db.define('CashMovement', {
  id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  businessId:  { type: DataTypes.INTEGER, allowNull: false },
  // Null cuando lo registra el dueño fuera de un turno.
  cashShiftId: { type: DataTypes.INTEGER, allowNull: true },
  employeeId:  { type: DataTypes.INTEGER, allowNull: true },
  // ingreso | egreso | retiro. El retiro es plata que sale de la caja hacia
  // alguien (el dueño la lleva al banco, se paga un flete, etc).
  tipo:        { type: DataTypes.STRING(15), allowNull: false },
  monto:       { type: DataTypes.DECIMAL(12,2), allowNull: false },
  motivo:      { type: DataTypes.STRING(255) },
  // En los retiros: quién saca la plata y a quién se la entrega. Sin esto un
  // faltante no tiene a quién atribuirse.
  entregadoPor:{ type: DataTypes.STRING(120) },
  recibidoPor: { type: DataTypes.STRING(120) },
  fecha:       { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, { tableName: 'cash_movements' });

// ─── SalePayment ─────────────────────────────────────────────────
// Una fila por medio de pago usado en la venta. Permite pagos combinados
// (parte en efectivo, parte en transferencia) con su propio ajuste cada uno.
const SalePayment = db.define('SalePayment', {
  id:              { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  saleId:          { type: DataTypes.INTEGER, allowNull: false },
  // Puede quedar en null si después se borra el método: el nombre se guarda
  // aparte para que las ventas viejas no pierdan el dato.
  paymentMethodId: { type: DataTypes.INTEGER, allowNull: true },
  nombre:          { type: DataTypes.STRING(60), allowNull: false },
  // Parte del total de mercadería que se cubre con este medio.
  monto:           { type: DataTypes.DECIMAL(12,2), allowNull: false },
  // Se precarga del método pero es editable por venta: a veces se negocia.
  ajustePct:       { type: DataTypes.DECIMAL(5,2), defaultValue: 0 },
  ajusteMonto:     { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
  // monto + ajusteMonto: lo que entra por este medio.
  montoFinal:      { type: DataTypes.DECIMAL(12,2), allowNull: false },
  // Copia del flag al momento del cobro. Si después se edita el medio de pago,
  // un arqueo ya cerrado no puede cambiar de resultado.
  esEfectivo:      { type: DataTypes.BOOLEAN, defaultValue: false },
}, { tableName: 'sale_payments' });

// ─── SaleItem ────────────────────────────────────────────────────
const SaleItem = db.define('SaleItem', {
  id:               { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  saleId:           { type: DataTypes.INTEGER, allowNull: false },
  productVariantId: { type: DataTypes.INTEGER, allowNull: true },
  titulo:           { type: DataTypes.STRING(200), allowNull: false },
  sku:              { type: DataTypes.STRING(100), allowNull: false },
  skuAgrupador:     { type: DataTypes.STRING(80) },
  variante1Nombre:  { type: DataTypes.STRING(40) },
  variante1Valor:   { type: DataTypes.STRING(80) },
  variante2Nombre:  { type: DataTypes.STRING(40) },
  variante2Valor:   { type: DataTypes.STRING(80) },
  cantidad:         { type: DataTypes.INTEGER, allowNull: false },
  precioUnitario:   { type: DataTypes.DECIMAL(12,2), allowNull: false },
  subtotal:         { type: DataTypes.DECIMAL(12,2), allowNull: false },
  esMayorista:      { type: DataTypes.BOOLEAN, defaultValue: false },
}, { tableName: 'sale_items', timestamps: false });

// ─── Invoice ─────────────────────────────────────────────────────
const Invoice = db.define('Invoice', {
  id:               { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  businessId:       { type: DataTypes.INTEGER, allowNull: false },
  saleId:           { type: DataTypes.INTEGER, allowNull: false },
  clientId:         { type: DataTypes.INTEGER, allowNull: true },
  employeeId:       { type: DataTypes.INTEGER, allowNull: true },
  numero:           { type: DataTypes.STRING(25), allowNull: false },
  tipo:             { type: DataTypes.STRING(5), defaultValue: 'B' },  // A|B|C
  clienteNombre:    { type: DataTypes.STRING(200), allowNull: false },
  clienteCuit:      { type: DataTypes.STRING(20) },
  clienteEmail:     { type: DataTypes.STRING(150) },
  clienteDireccion: { type: DataTypes.STRING(255) },
  subtotal:         { type: DataTypes.DECIMAL(12,2), allowNull: false },
  iva:              { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
  total:            { type: DataTypes.DECIMAL(12,2), allowNull: false },
  esMayorista:      { type: DataTypes.BOOLEAN, defaultValue: false },
  cae:              { type: DataTypes.STRING(20) },
  caeVencimiento:   { type: DataTypes.DATEONLY },
  arcaRespuesta: {
    type: DataTypes.TEXT,
    get() { try { return JSON.parse(this.getDataValue('arcaRespuesta')); } catch { return null; } },
    set(val) { this.setDataValue('arcaRespuesta', val ? JSON.stringify(val) : null); },
  },
  businessCuitId: { type: DataTypes.INTEGER, allowNull: true },
  emisorCuit:     { type: DataTypes.STRING(20) },
  emisorNombre:   { type: DataTypes.STRING(150) },
  pdfPath:      { type: DataTypes.STRING(255) },
  fechaEmision: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  estado:       { type: DataTypes.STRING(15), defaultValue: 'emitida' }, // emitida|anulada|error
  notas:        { type: DataTypes.TEXT },
}, { tableName: 'invoices' });

// ─── InvoiceItem ─────────────────────────────────────────────────
const InvoiceItem = db.define('InvoiceItem', {
  id:              { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  invoiceId:       { type: DataTypes.INTEGER, allowNull: false },
  titulo:          { type: DataTypes.STRING(200), allowNull: false },
  sku:             { type: DataTypes.STRING(100), allowNull: false },
  skuAgrupador:    { type: DataTypes.STRING(80) },
  variante1Nombre: { type: DataTypes.STRING(40) },
  variante1Valor:  { type: DataTypes.STRING(80) },
  variante2Nombre: { type: DataTypes.STRING(40) },
  variante2Valor:  { type: DataTypes.STRING(80) },
  cantidad:        { type: DataTypes.INTEGER, allowNull: false },
  esMayorista:     { type: DataTypes.BOOLEAN, defaultValue: false },
  precioUnitario:  { type: DataTypes.DECIMAL(12,2), allowNull: false },
  subtotal:        { type: DataTypes.DECIMAL(12,2), allowNull: false },
}, { tableName: 'invoice_items', timestamps: false });

// ─── Associations ─────────────────────────────────────────────────
Business.hasMany(BusinessLocation, { foreignKey: 'businessId', as: 'locales',   onDelete: 'CASCADE' });
BusinessLocation.belongsTo(Business, { foreignKey: 'businessId' });

Business.hasMany(BusinessCuit, { foreignKey: 'businessId', as: 'cuits', onDelete: 'CASCADE' });
BusinessCuit.belongsTo(Business, { foreignKey: 'businessId' });

BusinessCuit.hasOne(BusinessArcaConfig, { foreignKey: 'businessCuitId', as: 'arcaConfig' });
BusinessArcaConfig.belongsTo(BusinessCuit, { foreignKey: 'businessCuitId', as: 'cuit' });
BusinessArcaConfig.belongsTo(Business, { foreignKey: 'businessId' });

Business.hasMany(VariantType, { foreignKey: 'businessId', as: 'variantTypes', onDelete: 'CASCADE' });
VariantType.belongsTo(Business, { foreignKey: 'businessId' });

Employee.hasMany(EmployeeSession, { foreignKey: 'employeeId', as: 'sesiones', onDelete: 'CASCADE' });
EmployeeSession.belongsTo(Employee, { foreignKey: 'employeeId' });

Business.hasMany(PasswordResetCode, { foreignKey: 'businessId', as: 'resetCodes', onDelete: 'CASCADE' });
PasswordResetCode.belongsTo(Business, { foreignKey: 'businessId' });

Business.hasMany(Role,     { foreignKey: 'businessId', as: 'roles',     onDelete: 'CASCADE' });
Role.belongsTo(Business,   { foreignKey: 'businessId' });

Business.hasMany(Employee, { foreignKey: 'businessId', as: 'empleados', onDelete: 'CASCADE' });
Employee.belongsTo(Business, { foreignKey: 'businessId' });

BusinessLocation.hasMany(Employee, { foreignKey: 'locationId', as: 'empleados' });
Employee.belongsTo(BusinessLocation, { foreignKey: 'locationId', as: 'local' });

Role.hasMany(Employee, { foreignKey: 'roleId', as: 'empleados' });
Employee.belongsTo(Role, { foreignKey: 'roleId', as: 'cargo' });

Business.hasMany(Client,  { foreignKey: 'businessId', as: 'clientes',  onDelete: 'CASCADE' });
Client.belongsTo(Business, { foreignKey: 'businessId' });

Business.hasMany(Product, { foreignKey: 'businessId', as: 'productos', onDelete: 'CASCADE' });
Product.belongsTo(Business, { foreignKey: 'businessId' });

Product.hasMany(ProductVariant, { foreignKey: 'productId', as: 'productVariants', onDelete: 'CASCADE' });
ProductVariant.belongsTo(Product, { foreignKey: 'productId', as: 'producto' });

ProductVariant.hasMany(StockMovement, { foreignKey: 'productVariantId', as: 'movimientos', onDelete: 'CASCADE' });
StockMovement.belongsTo(ProductVariant, { foreignKey: 'productVariantId', as: 'variante' });
StockMovement.belongsTo(Employee, { foreignKey: 'employeeId', as: 'empleado' });
StockMovement.belongsTo(BusinessLocation, { foreignKey: 'locationId', as: 'local' });

Business.hasMany(Sale, { foreignKey: 'businessId', as: 'ventas', onDelete: 'CASCADE' });
Sale.belongsTo(Business,  { foreignKey: 'businessId' });
Sale.belongsTo(Employee,  { foreignKey: 'employeeId', as: 'empleado' });
Sale.belongsTo(Client,    { foreignKey: 'clientId',   as: 'cliente' });
Sale.belongsTo(BusinessLocation, { foreignKey: 'locationId', as: 'local' });

Employee.hasMany(Sale,  { foreignKey: 'employeeId', as: 'ventas' });
Employee.hasMany(StockMovement, { foreignKey: 'employeeId', as: 'movimientosStock' });

Sale.hasMany(SaleItem, { foreignKey: 'saleId', as: 'items', onDelete: 'CASCADE' });
SaleItem.belongsTo(Sale, { foreignKey: 'saleId' });
SaleItem.belongsTo(ProductVariant, { foreignKey: 'productVariantId', as: 'variante' });

Sale.hasOne(Invoice, { foreignKey: 'saleId', as: 'factura' });
Invoice.belongsTo(Sale,     { foreignKey: 'saleId',     as: 'venta' });
Invoice.belongsTo(Client,   { foreignKey: 'clientId',   as: 'cliente' });
Invoice.belongsTo(Employee, { foreignKey: 'employeeId', as: 'empleado' });
Invoice.belongsTo(BusinessCuit, { foreignKey: 'businessCuitId', as: 'emisor' });
Business.hasMany(Invoice,   { foreignKey: 'businessId', as: 'facturas', onDelete: 'CASCADE' });
Invoice.belongsTo(Business, { foreignKey: 'businessId' });

Invoice.hasMany(InvoiceItem, { foreignKey: 'invoiceId', as: 'items', onDelete: 'CASCADE' });
InvoiceItem.belongsTo(Invoice, { foreignKey: 'invoiceId' });

Business.hasMany(CashShift, { foreignKey: 'businessId', as: 'turnosCaja', onDelete: 'CASCADE' });
CashShift.belongsTo(Business,  { foreignKey: 'businessId' });
CashShift.belongsTo(Employee,  { foreignKey: 'employeeId', as: 'empleado', onDelete: 'NO ACTION' });
CashShift.belongsTo(BusinessLocation, { foreignKey: 'locationId', as: 'local', onDelete: 'NO ACTION' });
// Sin CASCADE hacia el turno: SQL Server rechaza dos caminos de borrado que
// terminen en la misma tabla, y acá businessId ya trae uno.
CashShift.hasMany(CashMovement, { foreignKey: 'cashShiftId', as: 'movimientos', onDelete: 'NO ACTION' });
CashMovement.belongsTo(CashShift, { foreignKey: 'cashShiftId', as: 'turno' });
CashMovement.belongsTo(Employee,  { foreignKey: 'employeeId', as: 'empleado', onDelete: 'NO ACTION' });
Business.hasMany(CashMovement, { foreignKey: 'businessId', as: 'movimientosCaja', onDelete: 'CASCADE' });
CashMovement.belongsTo(Business, { foreignKey: 'businessId' });

Business.hasMany(PaymentMethod, { foreignKey: 'businessId', as: 'mediosPago', onDelete: 'CASCADE' });
PaymentMethod.belongsTo(Business, { foreignKey: 'businessId' });

Sale.hasMany(SalePayment, { foreignKey: 'saleId', as: 'pagos', onDelete: 'CASCADE' });
SalePayment.belongsTo(Sale, { foreignKey: 'saleId' });
// NO ACTION en vez de SET NULL: sale_payments ya recibe cascada desde sales, y
// ambas ramas terminan en businesses. SQL Server rechaza crear la tabla cuando
// hay más de un camino de borrado en cascada hacia la misma tabla.
//
// No se pierde nada: el controller no deja borrar un medio de pago que tenga
// ventas asociadas (lo desactiva), así que la base nunca queda con un
// paymentMethodId colgado.
SalePayment.belongsTo(PaymentMethod, { foreignKey: 'paymentMethodId', as: 'metodo', onDelete: 'NO ACTION' });

module.exports = {
  db,
  Business, BusinessLocation, BusinessCuit, BusinessArcaConfig, ArcaToken, VariantType,
  MercadoLibreAccount, MercadoLibreLink,
  Role, Employee, EmployeeSession, PasswordResetCode, Client,
  Product, ProductVariant, StockMovement,
  Sale, SaleItem, Invoice, InvoiceItem,
  PaymentMethod, SalePayment, CashShift, CashMovement,
};
