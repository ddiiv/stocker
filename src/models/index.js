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
  // El CUIT identifica fiscalmente a la cuenta: se fija al registrarse y no
  // se edita. Cambiarlo sería otra cuenta, y arrastraría facturas ya emitidas
  // a nombre del CUIT anterior.
  cuit:          { type: DataTypes.STRING(20),  allowNull: false },
  // Condición frente a ARCA (Responsable Inscripto, Monotributo, Exento…).
  // Se trae del padrón, no la escribe el usuario.
  condicionIva:  { type: DataTypes.STRING(60) },
  // Cuándo se sincronizaron por última vez los datos del padrón.
  arcaSyncEn:    { type: DataTypes.DATE },
  telefono:      { type: DataTypes.STRING(30) },
  email:         { type: DataTypes.STRING(150), allowNull: false },
  passwordHash:  { type: DataTypes.STRING(255), allowNull: false },
  /*
   * Reglas de confección de SKU de las variantes.
   *
   * TEXT con JSON adentro y no un tipo JSON: MSSQL no lo tiene, y el proyecto
   * corre sobre MSSQL local y Postgres en Railway con el mismo modelo.
   */
  reglaSku: {
    type: DataTypes.TEXT,
    allowNull: true,
    get() { try { return JSON.parse(this.getDataValue('reglaSku')); } catch { return null; } },
    set(val) { this.setDataValue('reglaSku', val == null ? null : JSON.stringify(val)); },
  },
  /*
   * Qué hacer cuando se vende algo que el sistema no tiene en stock.
   *
   *   permitir  (por defecto) → la venta pasa y el stock queda en negativo,
   *                             marcado para regularizar.
   *   bloquear                → no se vende hasta cargar la mercadería.
   *
   * El default es permitir porque en el mostrador la mercadería está en la
   * mano del cliente y el sistema va atrás: frenar la venta por un dato que
   * todavía no se cargó pierde la venta o empuja a inventar una vuelta rara.
   *
   * El negativo NO es un error tapado: queda a la vista como faltante por
   * regularizar. Un negativo avisado dice "vendiste 3 más de las que sabía";
   * uno silencioso convierte el inventario en ficción, y por eso la venta que
   * lo genera se marca y se lista aparte.
   */
  ventaSinStock: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'permitir' },
  /*
   * Funciones que el negocio conserva aunque su plan ya no las incluya.
   *
   * Cuando una función que era libre pasa a estar en un plan, cortársela de un
   * día para el otro a quien ya la venía usando —con mercadería cargada en el
   * depósito, o el catálogo de evento armado— es dejarlo sin acceso a SUS
   * datos por un cambio comercial. Acá quedan anotadas, separadas por coma, en
   * el momento en que la puerta se pone.
   *
   * Es una foto, no una regla viva: sólo se llena una vez, para las cuentas
   * que ya tenían datos. Una cuenta nueva nace con esto vacío y pasa por la
   * puerta como corresponde.
   */
  featuresHeredadas: { type: DataTypes.STRING(255), allowNull: true },
}, { tableName: 'businesses' });

/* ─── Plan (catálogo comercial) ────────────────────────────────────
 *
 * Los límites viven en la base y no en el código porque son la palanca
 * comercial: subir el Pro de 5 a 8 empleados, o cotizarle a un Enterprise
 * puntual, no puede exigir un deploy.
 *
 * `null` en un límite significa "sin tope" — es Enterprise. Cero no sirve:
 * cero es un tope real y válido.
 */
const Plan = db.define('Plan', {
  id:            { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  codigo:        { type: DataTypes.STRING(20), allowNull: false, unique: true }, // inicial|pro|enterprise
  nombre:        { type: DataTypes.STRING(60), allowNull: false },
  descripcion:   { type: DataTypes.STRING(255) },
  // Null = "a cotizar". Enterprise se cierra a mano con cada cliente, así que
  // el precio real de esa cuenta vive en Subscription.precioAcordado.
  precioMensual: { type: DataTypes.DECIMAL(12,2), allowNull: true },
  moneda:        { type: DataTypes.STRING(3), defaultValue: 'ARS' },
  // Topes. Null = ilimitado.
  maxCuits:      { type: DataTypes.INTEGER, allowNull: true },
  maxEmpleados:  { type: DataTypes.INTEGER, allowNull: true },
  maxLocales:    { type: DataTypes.INTEGER, allowNull: true },
  // Cuántas variantes distintas puede tener cargadas. Es el tope de
  // almacenamiento: cada SKU es una fila más de inventario, de movimientos y
  // de historial.
  maxSkus:       { type: DataTypes.INTEGER, allowNull: true },
  // Comprobantes electrónicos por MES. A diferencia de los otros topes, éste
  // se reinicia el día 1: mide consumo, no capacidad.
  maxComprobantes: { type: DataTypes.INTEGER, allowNull: true },
  /*
   * Funciones habilitadas, como JSON y no como una columna por función: cada
   * módulo nuevo agregaría una migración, y los planes cambian más seguido que
   * el esquema. Las claves las define config/planes.js.
   */
  // Mismo criterio que Role.permisos: SQL Server no tiene tipo JSON, se guarda
  // como texto y se serializa acá para que el resto del código vea un objeto.
  features: {
    type: DataTypes.TEXT,
    allowNull: false,
    defaultValue: '{}',
    get() { try { return JSON.parse(this.getDataValue('features')); } catch { return {}; } },
    set(val) { this.setDataValue('features', typeof val === 'string' ? val : JSON.stringify(val)); },
  },
  soporte:       { type: DataTypes.STRING(60) },
  // Enterprise no se contrata solo: se pide demo y se cotiza.
  requiereCotizacion: { type: DataTypes.BOOLEAN, defaultValue: false },
  activo:        { type: DataTypes.BOOLEAN, defaultValue: true },
  orden:         { type: DataTypes.INTEGER, defaultValue: 0 },
  // Cuándo lo tocó un operador desde el backoffice. Mientras sea null, la
  // semilla de config/planes.js puede seguir actualizándolo; en cuanto alguien
  // edita el precio a mano, el código deja de pisarlo.
  editadoEn:     { type: DataTypes.DATE, allowNull: true },
}, { tableName: 'plans' });

/* ─── Subscription (una por negocio) ───────────────────────────────
 *
 * Estados:
 *   trial     → 14 días con todo el plan habilitado, sin tarjeta.
 *   activa    → pago al día.
 *   morosa    → venció el período y todavía hay margen de gracia.
 *   lectura   → sin pago: se puede consultar todo pero no facturar, vender ni
 *               sincronizar. Los datos nunca se borran ni se ocultan.
 *   cancelada → baja pedida por el cliente.
 */
const Subscription = db.define('Subscription', {
  id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  businessId:  { type: DataTypes.INTEGER, allowNull: false, unique: true },
  planId:      { type: DataTypes.INTEGER, allowNull: false },
  estado:      { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'trial' },
  trialInicio: { type: DataTypes.DATE, allowNull: true },
  trialFin:    { type: DataTypes.DATE, allowNull: true },
  // Período pago vigente. Fuera de él la cuenta cae a lectura.
  periodoInicio: { type: DataTypes.DATE, allowNull: true },
  periodoFin:    { type: DataTypes.DATE, allowNull: true },
  // Precio cerrado con este cliente. Manda sobre el del plan: es lo que
  // permite cotizar Enterprise o dejar un precio viejo a quien ya estaba.
  precioAcordado: { type: DataTypes.DECIMAL(12,2), allowNull: true },
  // mercadopago | transferencia | manual
  metodoPago:     { type: DataTypes.STRING(20), allowNull: true },
  // Id de la suscripción automática en el proveedor (preapproval de Mercado
  // Pago). Con esto se consulta o se da de baja el débito recurrente.
  proveedorRef:   { type: DataTypes.STRING(120), allowNull: true },
  ultimoPagoEn:   { type: DataTypes.DATE, allowNull: true },
  proximoCobroEn: { type: DataTypes.DATE, allowNull: true },
  canceladaEn:    { type: DataTypes.DATE, allowNull: true },
  /*
   * Renovación automática. Cancelar la suscripción NO corta el servicio en el
   * acto: apaga esta bandera y la cuenta sigue andando hasta que termine el
   * período ya pagado. Cobrar un mes y quitarlo el mismo día sería quedarse
   * con plata por un servicio no prestado.
   */
  renovacionAutomatica: { type: DataTypes.BOOLEAN, defaultValue: true },
  // Descuento comercial sobre el precio de lista, otorgado desde el backoffice.
  descuentoPct:   { type: DataTypes.DECIMAL(5,2), defaultValue: 0 },
  descuentoNota:  { type: DataTypes.STRING(200), allowNull: true },
  // Baja de cuenta pedida por el titular. Queda anotado el pedido; el borrado
  // efectivo lo hace una persona, nunca el sistema solo.
  bajaSolicitadaEn: { type: DataTypes.DATE, allowNull: true },
  bajaMotivo:     { type: DataTypes.STRING(500), allowNull: true },
  notas:          { type: DataTypes.STRING(500) },
}, { tableName: 'subscriptions' });

/* ─── SubscriptionPayment (historial de cobros) ───────────────────
 *
 * Una fila por intento de cobro, aprobado o no. Los rechazos quedan: sin
 * ellos no hay forma de explicarle a un cliente por qué se le cortó el
 * servicio, ni de detectar una tarjeta que viene fallando.
 */
const SubscriptionPayment = db.define('SubscriptionPayment', {
  id:             { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  businessId:     { type: DataTypes.INTEGER, allowNull: false },
  subscriptionId: { type: DataTypes.INTEGER, allowNull: false },
  planId:         { type: DataTypes.INTEGER, allowNull: true },
  monto:          { type: DataTypes.DECIMAL(12,2), allowNull: false },
  moneda:         { type: DataTypes.STRING(3), defaultValue: 'ARS' },
  // pendiente | aprobado | rechazado | reintegrado
  estado:         { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'pendiente' },
  // mercadopago | transferencia | manual
  metodo:         { type: DataTypes.STRING(20), allowNull: false },
  // Id del pago en el proveedor. Único: es la defensa contra el webhook
  // repetido, que Mercado Pago manda de rutina y si no acreditaría dos veces.
  proveedorRef:   { type: DataTypes.STRING(120), allowNull: true, unique: true },
  linkPago:       { type: DataTypes.STRING(500), allowNull: true },
  periodoDesde:   { type: DataTypes.DATE, allowNull: true },
  periodoHasta:   { type: DataTypes.DATE, allowNull: true },
  // Transferencia bancaria: comprobante que sube el cliente y quién lo validó
  // desde el backoffice. Una transferencia no se acredita sola.
  comprobanteUrl: { type: DataTypes.STRING(500), allowNull: true },
  verificadoPor:  { type: DataTypes.STRING(150), allowNull: true },
  verificadoEn:   { type: DataTypes.DATE, allowNull: true },
  detalle:        { type: DataTypes.STRING(500), allowNull: true },
  fecha:          { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, { tableName: 'subscription_payments' });

/* ─── PlatformAdmin (backoffice de Stocker) ───────────────────────
 *
 * Operadores de Stocker, no de los negocios clientes. Tabla aparte a
 * propósito: un admin de plataforma no pertenece a ningún businessId, y
 * meterlo en `employees` habilitaría que un negocio se lo encuentre entre su
 * gente. Acá viven los que aprueban transferencias y cotizan Enterprise.
 */
const PlatformAdmin = db.define('PlatformAdmin', {
  id:            { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  nombre:        { type: DataTypes.STRING(120), allowNull: false },
  email:         { type: DataTypes.STRING(150), allowNull: false, unique: true },
  passwordHash:  { type: DataTypes.STRING(255), allowNull: false },
  // soporte  → lee cuentas y responde. owner → además cobra y cotiza.
  // soporte | owner | superuser. El superuser es uno solo y no se crea desde
  // la aplicación: se siembra con scripts/crear-superuser.js.
  rol:           { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'soporte' },
  /*
   * Segundo factor obligatorio (TOTP, el código de Google Authenticator).
   *
   * La contraseña sola no alcanza para una cuenta que ve todas las cuentas de
   * todos los negocios: si se filtra, se filtra el sistema entero. El secreto
   * se guarda en base32 y el código se valida contra el reloj.
   */
  totpSecret:    { type: DataTypes.STRING(64), allowNull: true },
  totpActivadoEn:{ type: DataTypes.DATE, allowNull: true },
  activo:        { type: DataTypes.BOOLEAN, defaultValue: true },
  ultimaConexion:{ type: DataTypes.DATE, allowNull: true },
  ultimaIp:      { type: DataTypes.STRING(60), allowNull: true },
}, { tableName: 'platform_admins' });

/* ─── AuthAttempt (intentos de autenticación) ─────────────────────
 *
 * Una fila por intento, exitoso o no. Es lo que permite bloquear a quien está
 * probando contraseñas sin castigar a quien se equivocó dos veces.
 *
 * Los bloqueos NO se guardan: se deducen contando estas filas. Una tabla de
 * bloqueos se llena de registros vencidos que hay que limpiar, y un bloqueo mal
 * borrado deja a alguien afuera sin motivo. Contando, el bloqueo se vence solo
 * cuando las filas salen de la ventana.
 */
const AuthAttempt = db.define('AuthAttempt', {
  id:     { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  ip:     { type: DataTypes.STRING(60), allowNull: true },
  // El email que se intentó. Se guarda para poder frenar un ataque repartido
  // entre muchas IPs contra una sola cuenta.
  identificador: { type: DataTypes.STRING(150), allowNull: true },
  // business | employee | platform | reset
  tipo:   { type: DataTypes.STRING(20), allowNull: false },
  exito:  { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  // Se recorta: un User-Agent puede venir con cientos de caracteres y acá sólo
  // interesa para distinguir un navegador de un script.
  userAgent: { type: DataTypes.STRING(200), allowNull: true },
  fecha:  { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, {
  tableName: 'auth_attempts',
  indexes: [
    { fields: ['ip', 'fecha'] },
    { fields: ['identificador', 'fecha'] },
  ],
});

/* ─── PlatformSetting (parámetros editables de la plataforma) ─────
 *
 * Clave-valor para lo que un operador cambia sin tocar código: el contacto y
 * los precios que muestra la página pública, la cotización del dólar. Vive en
 * la base para que actualizar un teléfono no sea un deploy.
 */
const PlatformSetting = db.define('PlatformSetting', {
  clave:        { type: DataTypes.STRING(60), primaryKey: true },
  valor:        { type: DataTypes.TEXT, allowNull: true },
  descripcion:  { type: DataTypes.STRING(200), allowNull: true },
  actualizadoPor: { type: DataTypes.STRING(150), allowNull: true },
}, { tableName: 'platform_settings' });

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
  /*
   * De qué lugar sale el stock que se publica.
   *
   * Antes se mandaba el total de la variante, que desde que el stock es por
   * local incluye el depósito: ML ofrecía mercadería que estaba en la bodega
   * y podía salir para una sucursal en cualquier momento. Ahora publica un
   * lugar concreto —normalmente el de tipo `online`— y lo que se ve en la
   * publicación es lo que se puede despachar.
   *
   * Nulo: se resuelve solo al primer lugar de tipo `online`.
   */
  locationId:      { type: DataTypes.INTEGER, allowNull: true },
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

// ─── AccountChangeCode ──────────────────────────────────────────
// Códigos para confirmar cambios sensibles de la cuenta del dueño: email y
// contraseña. Se separa de PasswordResetCode porque aquél es para recuperar
// el acceso desde afuera (sin sesión) y éste para modificar datos desde
// adentro, con la sesión ya iniciada — distinto flujo y distinto destinatario.
//
// `canal` queda preparado para sumar SMS/WhatsApp más adelante sin migrar.
const AccountChangeCode = db.define('AccountChangeCode', {
  id:           { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  businessId:   { type: DataTypes.INTEGER, allowNull: false },
  // email | password
  tipo:         { type: DataTypes.STRING(20), allowNull: false },
  // email | sms | whatsapp — hoy siempre email.
  canal:        { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'email' },
  // A dónde se mandó el código. En el cambio de email es la casilla NUEVA:
  // así se prueba que el dueño realmente la controla.
  destino:      { type: DataTypes.STRING(150), allowNull: false },
  code:         { type: DataTypes.STRING(10), allowNull: false },
  // Datos del cambio pendiente (ej. el email nuevo), en JSON.
  payload:      { type: DataTypes.TEXT },
  attemptsLeft: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 4 },
  expiresAt:    { type: DataTypes.DATE, allowNull: false },
  usedAt:       { type: DataTypes.DATE },
}, { tableName: 'account_change_codes' });

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
  /*
   * Qué es este lugar. No es una etiqueta decorativa: de cada tipo depende
   * qué se puede hacer con su stock.
   *
   *   local     Sucursal que atiende público. Vende y recibe reposición.
   *
   *   deposito  Entra la mercadería nueva y de ahí se transfiere. NO vende.
   *             Sin distinguirlo, el punto de venta ofrecía descontar de la
   *             bodega y el stock del salón quedaba mintiendo.
   *
   *   online    El stock reservado para las ventas web. Vende como un local,
   *             pero además es el único que se publica en MercadoLibre.
   *
   * Por qué online es un tipo aparte y no un local más: lo que se publica
   * tiene que ser stock contado y quieto. En los locales el conteo es
   * confiable; en el depósito la mercadería rota todo el tiempo, así que
   * publicar su stock es ofrecer online algo que quizá ya salió para una
   * sucursal. Separándolo, lo que ML muestra es lo que realmente se puede
   * despachar.
   *
   * Un negocio puede tener varios depósitos. Los que ya existían son locales:
   * es lo que eran hasta ahora y cambiarlos por adivinanza rompería sus ventas.
   */
  tipo:       { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'local' }, // local|deposito|online|feria
  /*
   * Cuándo una venta de este local pasa a precio mayorista.
   *
   * Hasta ahora eran tres prendas, escrito a mano en el controlador y otra vez
   * en dos pantallas. Con tres copias del mismo número, el día que alguien
   * cambie una, la pantalla muestra un precio y el servidor cobra otro.
   *
   *   cantidad  a partir de N prendas (lo de siempre; N por defecto, 3)
   *   monto     a partir de $X en la venta
   *   ambos     lo que se cumpla primero
   *   siempre   este local vende siempre al por mayor
   *   nunca     este local vende siempre al detalle
   *
   * Cada local tiene la suya: un puesto de feria puede vender todo al por mayor
   * mientras la sucursal del centro sigue pidiendo tres prendas.
   */
  mayoristaModo:     { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'cantidad' },
  mayoristaCantidad: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3 },
  /*
   * El umbral por monto se mide con PRECIOS MINORISTAS.
   *
   * El precio depende del total y el total depende del precio: es circular y
   * hay que cortar por algún lado. Midiendo en lista, el cajero puede explicarlo
   * —"llegaste a $50.000, ahora va por mayor"— y el número que ve mientras arma
   * la venta es el mismo contra el que se compara.
   */
  mayoristaMonto:    { type: DataTypes.DECIMAL(12, 2), allowNull: true },
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
  /*
   * Cuenta corriente.
   *
   * `saldoCuenta` es lo que el cliente debe: positivo = nos debe. Está
   * desnormalizado a propósito — la alternativa es sumar todos los movimientos
   * en cada validación de límite, y esa suma corre en medio de cada venta a
   * crédito. Se actualiza siempre dentro de la misma transacción que crea el
   * movimiento, así no puede quedar desfasado.
   *
   * `limiteCredito` en 0 con `cuentaHabilitada` en false es el estado normal:
   * el cliente paga al contado y no puede comprar fiado.
   */
  cuentaHabilitada: { type: DataTypes.BOOLEAN, defaultValue: false },
  limiteCredito:    { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
  saldoCuenta:      { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
}, { tableName: 'clients' });

// ─── ClientAccountEntry (movimiento de cuenta corriente) ─────────
// Libro mayor del cliente: cada fila es una deuda que nace (cargo) o que se
// cancela (pago). El saldo del cliente sale de acá; la columna `saldoCuenta`
// es sólo la caché.
const ClientAccountEntry = db.define('ClientAccountEntry', {
  id:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  businessId: { type: DataTypes.INTEGER, allowNull: false },
  clientId:   { type: DataTypes.INTEGER, allowNull: false },
  // Venta que originó el cargo. Null en ajustes manuales y en los pagos.
  saleId:     { type: DataTypes.INTEGER, allowNull: true },
  employeeId: { type: DataTypes.INTEGER, allowNull: true },
  // cargo = el cliente se lleva mercadería y queda debiendo.
  // pago  = trae plata y baja la deuda.
  tipo:       { type: DataTypes.STRING(10), allowNull: false },
  monto:      { type: DataTypes.DECIMAL(12,2), allowNull: false },
  // Saldo que quedó después de este movimiento. Congelado: sirve para leer el
  // extracto sin recalcular, y para detectar si la caché se desincronizó.
  saldoPosterior: { type: DataTypes.DECIMAL(12,2), allowNull: true },
  // Con qué pagó (sólo en los pagos).
  paymentMethodId: { type: DataTypes.INTEGER, allowNull: true },
  medioPago:  { type: DataTypes.STRING(60) },
  notas:      { type: DataTypes.STRING(255) },
  fecha:      { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, { tableName: 'client_account_entries' });

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
  /*
   * Producto de feria: se vende sin llevar inventario.
   *
   * Hay negocios con puestos de feria donde lo único que importa es registrar
   * QUÉ se vendió, no cuánto queda. Estos productos tienen un solo SKU —el
   * padre ES la variante, sin color ni talle—, precio propio, y su stock no se
   * consulta ni se mueve nunca.
   *
   * Es una bandera y no una tabla aparte porque siguen siendo productos: se
   * venden, se facturan y se cuentan en el total del negocio como cualquier
   * otro. Lo único que cambia es que quedan afuera de todo lo que presupone un
   * inventario — depósito, reposición, MercadoLibre y Stock a regularizar.
   */
  esFeria:        { type: DataTypes.BOOLEAN, defaultValue: false },
  /*
   * De qué producto del catálogo normal salió este de feria.
   *
   * Se guarda para poder decir "esto es el Loan Pantalón" cuando alguien mira
   * el de feria, y para no generarlo dos veces. No arrastra cambios: si al
   * original le cambian el título, el de feria conserva el suyo, que puede ser
   * distinto a propósito.
   */
  origenProductId: { type: DataTypes.INTEGER, allowNull: true },
}, { tableName: 'products' });

// ─── ProductVariant ───────────────────────────────────────────────
const ProductVariant = db.define('ProductVariant', {
  id:              { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  productId:       { type: DataTypes.INTEGER, allowNull: false },
  /*
   * Copia del negocio del producto. Ver ensureColumns: es lo que permite que el
   * SKU sea único dentro de un negocio en vez de único en todo Stocker.
   *
   * Nullable en el modelo aunque en la práctica nunca lo sea: las bases que
   * vienen de antes tienen filas sin completar hasta que corre el relleno, y
   * declararlo obligatorio rompería el arranque justo en esas.
   */
  businessId:      { type: DataTypes.INTEGER, allowNull: true },
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
  /*
   * Precio propio de la variante. NULL = usa el del producto.
   *
   * Nulo y no cero, y la diferencia importa: un talle especial que sale más
   * caro necesita su precio, pero la mayoría de las variantes comparte el del
   * padre y tiene que seguir haciéndolo. Con cero por defecto, subir el precio
   * del producto no llegaría a ninguna variante y todo pasaría a valer nada.
   *
   * El nulo también es lo que permite cambiar el precio de un producto de
   * cuarenta variantes tocando un solo número, que es el caso habitual.
   */
  precioMinorista: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
  precioMayorista: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
  costo:           { type: DataTypes.DECIMAL(12, 2), allowNull: true },
}, { tableName: 'product_variants' });

/*
 * El negocio se completa solo a partir del producto.
 *
 * Va en un hook y no en cada controlador a propósito: las variantes se crean
 * desde el alta de producto, el alta individual, la importación de Excel y la
 * sincronización con Mercado Libre. Repartir la responsabilidad entre cuatro
 * lugares es garantizar que el quinto se olvide, y una fila sin negocio no sólo
 * queda fuera de su propio listado: bloquea la creación del índice único.
 */
ProductVariant.addHook('beforeValidate', async (variante, opciones) => {
  if (variante.businessId || !variante.productId) return;
  const producto = await Product.findByPk(variante.productId, {
    attributes: ['businessId'],
    transaction: opciones.transaction,
  });
  if (producto) variante.businessId = producto.businessId;
});

/*
 * ─── VariantStock: el stock de una variante EN UN LOCAL ──────────
 *
 * Cada local tiene los mismos productos y distinto stock. Esta tabla es la
 * verdad: una fila por combinación de variante y local.
 *
 * `ProductVariant.stock` se conserva como el TOTAL, recalculado como la suma de
 * estas filas cada vez que una cambia. Es una desnormalización a propósito y
 * conviene entender por qué: media docena de pantallas —métricas, publicación
 * en Mercado Libre, exportación a Excel, el buscador del punto de venta,
 * etiquetas— leen ese campo y lo que quieren mostrar es justamente el total.
 * Reescribirlas todas de una para que sumen por su cuenta es la forma segura de
 * dejar una sin migrar y que muestre un número inventado durante meses.
 *
 * Quien escribe stock lo hace por services/stockService, que actualiza la fila
 * del local y el total en la misma transacción. Ningún controlador toca
 * `ProductVariant.stock` directamente.
 */
const VariantStock = db.define('VariantStock', {
  id:               { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  businessId:       { type: DataTypes.INTEGER, allowNull: false },
  productVariantId: { type: DataTypes.INTEGER, allowNull: false },
  locationId:       { type: DataTypes.INTEGER, allowNull: false },
  stock:            { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  // Mínimo por local: un depósito central y un local de barrio no reponen con
  // el mismo umbral.
  stockMinimo:      { type: DataTypes.INTEGER, allowNull: true },
}, {
  tableName: 'variant_stocks',
  indexes: [
    { name: 'uq_variant_stock', unique: true, fields: ['productVariantId', 'locationId'] },
    { name: 'idx_variant_stock_local', fields: ['businessId', 'locationId'] },
  ],
});

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

/* ═══════════════════════════════════════════════════════════════════
 * Circuito depósito → local
 *
 * Dos documentos, cada uno con su hoja de items, que juntos cubren el camino
 * de la mercadería desde que baja del camión hasta que está en la góndola:
 *
 *   StockIngreso       mercadería nueva que entra al depósito.
 *   PedidoReposicion   lo que un local pide y el depósito le manda.
 *
 * Los dos guardan quién hizo cada paso y cuándo, porque son justamente los
 * papeles que alguien va a querer revisar cuando las cantidades no cierren.
 * Nada se borra: rechazar y anular son estados, no un DELETE.
 * ═══════════════════════════════════════════════════════════════════ */

// ─── StockIngreso ─────────────────────────────────────────────────
const StockIngreso = db.define('StockIngreso', {
  id:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  businessId: { type: DataTypes.INTEGER, allowNull: false },
  // Siempre un depósito: la mercadería cruda no entra por el salón.
  locationId: { type: DataTypes.INTEGER, allowNull: false },
  employeeId: { type: DataTypes.INTEGER, allowNull: true },
  numero:     { type: DataTypes.STRING(25), allowNull: false },
  /*
   * Cómo se contó, que es lo que decide si el stock sube solo o espera firma.
   *
   *   etiquetas → se contó una vez y se imprimieron etiquetas en el acto. El
   *               stock sube ahí mismo: la etiqueta impresa ya es la prueba
   *               física de la cuenta y hacerlo contar de nuevo para "confirmar"
   *               es el error que este circuito viene a sacar.
   *   conteo    → se contó a mano, sin etiquetas. Queda pendiente de que
   *               oficina lo acepte.
   */
  origen:     { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'etiquetas' },
  // aplicado|pendiente|rechazado|anulado
  estado:     { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pendiente' },
  // Cuando el ingreso nace para cubrir un pedido del local.
  pedidoId:   { type: DataTypes.INTEGER, allowNull: true },
  notas:      { type: DataTypes.STRING(500) },
  /*
   * El porqué del rechazo o de la anulación. Es obligatorio en el controller:
   * un ingreso que desaparece sin explicación es exactamente el agujero por el
   * que después nadie puede reconstruir qué pasó.
   */
  motivo:     { type: DataTypes.STRING(500) },
  resueltoPorEmployeeId: { type: DataTypes.INTEGER, allowNull: true },
  resueltoEn:            { type: DataTypes.DATE, allowNull: true },
}, { tableName: 'stock_ingresos' });

const StockIngresoItem = db.define('StockIngresoItem', {
  id:               { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  ingresoId:        { type: DataTypes.INTEGER, allowNull: false },
  productVariantId: { type: DataTypes.INTEGER, allowNull: false },
  cantidad:         { type: DataTypes.INTEGER, allowNull: false },
  /*
   * Copia del SKU y la descripción al momento del ingreso.
   *
   * El remito tiene que poder leerse dentro de un año aunque la variante se
   * haya renombrado o dado de baja. Sin la copia, el historial muestra filas
   * vacías justo cuando se lo consulta para discutir un faltante.
   */
  sku:              { type: DataTypes.STRING(100) },
  descripcion:      { type: DataTypes.STRING(255) },
}, { tableName: 'stock_ingreso_items' });

// ─── PedidoReposicion ─────────────────────────────────────────────
const PedidoReposicion = db.define('PedidoReposicion', {
  id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  businessId:  { type: DataTypes.INTEGER, allowNull: false },
  numero:      { type: DataTypes.STRING(25), allowNull: false },
  // Quién pide (local) y de dónde sale (depósito).
  locationId:  { type: DataTypes.INTEGER, allowNull: false },
  depositoId:  { type: DataTypes.INTEGER, allowNull: true },
  solicitadoPorEmployeeId: { type: DataTypes.INTEGER, allowNull: true },
  /*
   * pendiente → aprobado → enviado → recibido | recibido_parcial
   *           ↘ rechazado                      ↘ (faltantes con nota)
   *
   * `enviado` es el estado en el que la mercadería ya salió del depósito y
   * todavía no llegó: en tránsito. Existe porque el stock sale al despachar,
   * así que durante el viaje no está en ningún lado y tiene que poder verse.
   */
  estado:      { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pendiente' },
  notas:       { type: DataTypes.STRING(500) },

  aprobadoPorEmployeeId: { type: DataTypes.INTEGER, allowNull: true },
  aprobadoEn:            { type: DataTypes.DATE, allowNull: true },
  motivoRechazo:         { type: DataTypes.STRING(500) },

  enviadoPorEmployeeId:  { type: DataTypes.INTEGER, allowNull: true },
  enviadoEn:             { type: DataTypes.DATE, allowNull: true },

  recibidoPorEmployeeId: { type: DataTypes.INTEGER, allowNull: true },
  recibidoEn:            { type: DataTypes.DATE, allowNull: true },
  notaRecepcion:         { type: DataTypes.STRING(500) },

  /*
   * El saldo: lo que se pidió y nunca salió del depósito.
   *
   * Es `pedida - enviada`, y NO `pedida - recibida`. La diferencia importa:
   * lo que salió y no llegó es una pérdida en tránsito que hay que investigar,
   * no mercadería para volver a mandar. Confundirlas haría despachar dos veces
   * la misma prenda.
   *
   * Un pedido con saldo queda esperando una decisión —mandarlo o darlo de
   * baja— y se muestra primero en la bandeja para que nadie se olvide. La
   * alternativa, cerrarlo en silencio, obliga al local a darse cuenta solo y a
   * pedir todo de nuevo.
   */
  saldoEstado:    { type: DataTypes.STRING(20), allowNull: true },  // pendiente|aceptado|rechazado
  saldoMotivo:    { type: DataTypes.STRING(500) },
  saldoResueltoPorEmployeeId: { type: DataTypes.INTEGER, allowNull: true },
  saldoResueltoEn:            { type: DataTypes.DATE, allowNull: true },
  // El pedido que continúa a éste, cuando el saldo se acepta y se rearma.
  pedidoOrigenId: { type: DataTypes.INTEGER, allowNull: true },
}, { tableName: 'pedidos_reposicion' });

const PedidoReposicionItem = db.define('PedidoReposicionItem', {
  id:               { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  pedidoId:         { type: DataTypes.INTEGER, allowNull: false },
  productVariantId: { type: DataTypes.INTEGER, allowNull: false },
  /*
   * Las tres cantidades del circuito, y las tres hacen falta.
   *
   * Pedida vs enviada muestra qué no había en el depósito; enviada vs recibida
   * muestra qué se perdió en el camino. Guardando una sola, cualquier faltante
   * es indistinguible de un error de carga.
   */
  cantidadPedida:   { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  cantidadEnviada:  { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  cantidadRecibida: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  notaFaltante:     { type: DataTypes.STRING(300) },
  sku:              { type: DataTypes.STRING(100) },
  descripcion:      { type: DataTypes.STRING(255) },
}, { tableName: 'pedido_reposicion_items' });

// ─── Sale ────────────────────────────────────────────────────────
const Sale = db.define('Sale', {
  id:           { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  businessId:   { type: DataTypes.INTEGER, allowNull: false },
  locationId:   { type: DataTypes.INTEGER, allowNull: true },
  employeeId:   { type: DataTypes.INTEGER, allowNull: true },
  clientId:     { type: DataTypes.INTEGER, allowNull: true },
  numero:       { type: DataTypes.STRING(25), allowNull: false },
  /*
   * El número de venta que la cotización tiene reservado.
   *
   * Una cotización se numera COT-… porque es un presupuesto y así lo tiene que
   * ver el cliente, pero desde que nace se le aparta el próximo número de
   * venta. Si más tarde se convierte, ya lo tiene: no compite con las ventas
   * que se hicieron mientras tanto ni le pisa el número a ninguna.
   *
   * Si nunca se convierte, ese número queda reservado igual y nadie lo toma.
   * La serie de ventas queda con saltos y está bien: es el número interno de
   * Stocker, no el del comprobante fiscal —ese lo numera ARCA con su propio
   * correlativo, en `invoices`.
   *
   * En una venta normal es null: su número vive en `numero` y punto.
   */
  numeroVenta:  { type: DataTypes.STRING(25), allowNull: true },
  tipo:         { type: DataTypes.STRING(15), defaultValue: 'venta' },    // venta|cotizacion
  estado:       { type: DataTypes.STRING(15), defaultValue: 'pendiente' }, // pendiente|pagado|cancelado|vencida
  /*
   * Cómo se acordó cobrar la venta, no con qué medio.
   *
   *   contado          → se cobra en el acto, con uno o varios medios de pago.
   *   cuenta_corriente → se fía. No se elige medio de pago ahora, porque
   *                      todavía no se sabe con qué va a pagar el cliente.
   *                      Exige cliente identificado y nace como deuda suya.
   *
   * Fiar dejó de ser un medio de pago: el medio recién se define al cobrar,
   * y ahí valen todas las combinaciones y ajustes de siempre.
   */
  condicionPago:   { type: DataTypes.STRING(20), defaultValue: 'contado' },
  // Lo que falta cobrar de ESTA venta. Cero cuando está saldada. Es lo que
  // permite cobrar una venta fiada en partes sin perder de vista cuál quedó.
  saldoPendiente:  { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
  /*
   * Si la mercadería ya salió del inventario.
   *
   * Antes se deducía de `estado === 'pagado'`, pero con las ventas fiadas se
   * separan los dos momentos: el cliente puede llevarse la ropa hoy y pagar la
   * semana que viene, o dejarla señada sin llevársela. Guardarlo explícito es
   * lo que evita descontar dos veces el mismo stock al cobrar.
   */
  stockDescontado: { type: DataTypes.BOOLEAN, defaultValue: false },
  // Cuándo y en la caja de quién entró la plata. En una venta de mostrador es
  // el mismo momento y el mismo empleado que la registró; en una fiada, no.
  // El arqueo se apoya en estos dos: el efectivo se rinde en el turno en que
  // se cobró, no en aquel en que se hizo la venta.
  cobradoEn:            { type: DataTypes.DATE, allowNull: true },
  cobradoPorEmployeeId: { type: DataTypes.INTEGER, allowNull: true },
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
  // Fiar no es un medio de pago: es una condición de la venta (`Sale.condicionPago`).
  // Cualquiera de estos medios sirve después para cobrar lo fiado.
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
  /*
   * El costo de la mercadería el día que se vendió, congelado acá.
   *
   * Sin esta copia el margen se calcula contra el costo actual del producto, y
   * entonces una suba del proveedor reescribe el resultado de todos los meses
   * anteriores. Para un panel que se mira a varios años, el pasado tiene que
   * quedarse quieto.
   */
  costoUnitario:    { type: DataTypes.DECIMAL(12,2), allowNull: true },
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
Business.hasMany(AccountChangeCode, { foreignKey: 'businessId', as: 'codigosCuenta', onDelete: 'CASCADE' });
AccountChangeCode.belongsTo(Business, { foreignKey: 'businessId' });
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

Client.hasMany(ClientAccountEntry, { foreignKey: 'clientId', as: 'movimientosCuenta', onDelete: 'CASCADE' });
ClientAccountEntry.belongsTo(Client, { foreignKey: 'clientId', as: 'cliente' });
// NO ACTION: SQL Server rechaza varios caminos de borrado en cascada hacia la
// misma tabla, y el movimiento tiene que sobrevivir igual — la deuda no
// desaparece porque se borre la venta que la originó.
ClientAccountEntry.belongsTo(Sale, { foreignKey: 'saleId', as: 'venta', onDelete: 'NO ACTION' });
ClientAccountEntry.belongsTo(Employee, { foreignKey: 'employeeId', as: 'empleado', onDelete: 'NO ACTION' });

Business.hasMany(Product, { foreignKey: 'businessId', as: 'productos', onDelete: 'CASCADE' });
Product.belongsTo(Business, { foreignKey: 'businessId' });

Product.hasMany(ProductVariant, { foreignKey: 'productId', as: 'productVariants', onDelete: 'CASCADE' });
ProductVariant.belongsTo(Product, { foreignKey: 'productId', as: 'producto' });

/*
 * Borrar una variante borra su stock en todos los locales: sin la variante, esas
 * filas no significan nada.
 */
ProductVariant.hasMany(VariantStock, { foreignKey: 'productVariantId', as: 'porLocal', onDelete: 'CASCADE' });
VariantStock.belongsTo(ProductVariant, { foreignKey: 'productVariantId', as: 'variante' });

/*
 * El local NO cascadea, y no es un olvido.
 *
 * SQL Server rechaza crear la tabla si las dos claves foráneas borran en
 * cascada: `product_variants` y `business_locations` cuelgan las dos de
 * `businesses`, así que borrar un negocio llegaría hasta acá por dos caminos y
 * el motor no lo permite ("multiple cascade paths"). Verificado probando las
 * cuatro combinaciones: cualquiera de las dos sola funciona, juntas no.
 *
 * Elegir cuál conservar es fácil: los locales de este sistema se dan de baja
 * con `activo = false`, no se borran, así que la cascada por local nunca se
 * dispararía. La de variante sí.
 */
BusinessLocation.hasMany(VariantStock, { foreignKey: 'locationId', as: 'stocks', onDelete: 'NO ACTION' });
// El `onDelete` va también acá: la restricción la crea el lado que tiene la
// columna, y sin declararlo Sequelize le pone CASCADE por su cuenta.
VariantStock.belongsTo(BusinessLocation, { foreignKey: 'locationId', as: 'local', onDelete: 'NO ACTION' });

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

/* ─── Circuito depósito → local: asociaciones ──────────────────────
 *
 * Todo lo que apunta a `business_locations`, `employees` o `product_variants`
 * va en NO ACTION. Las tres cuelgan de `businesses` igual que estos
 * documentos, así que borrar un negocio llegaría a la misma tabla por dos
 * caminos y SQL Server rechaza crearla ("multiple cascade paths"). El único
 * CASCADE es el de cada documento hacia sus propios items, que sin la cabecera
 * no significan nada.
 */
Business.hasMany(StockIngreso, { foreignKey: 'businessId', as: 'ingresos', onDelete: 'CASCADE' });
StockIngreso.belongsTo(Business, { foreignKey: 'businessId' });
StockIngreso.belongsTo(BusinessLocation, { foreignKey: 'locationId', as: 'deposito', onDelete: 'NO ACTION' });
StockIngreso.belongsTo(Employee, { foreignKey: 'employeeId', as: 'empleado', onDelete: 'NO ACTION' });
StockIngreso.belongsTo(Employee, { foreignKey: 'resueltoPorEmployeeId', as: 'resueltoPor', onDelete: 'NO ACTION' });

StockIngreso.hasMany(StockIngresoItem, { foreignKey: 'ingresoId', as: 'items', onDelete: 'CASCADE' });
StockIngresoItem.belongsTo(StockIngreso, { foreignKey: 'ingresoId', as: 'ingreso' });
StockIngresoItem.belongsTo(ProductVariant, { foreignKey: 'productVariantId', as: 'variante', onDelete: 'NO ACTION' });

Business.hasMany(PedidoReposicion, { foreignKey: 'businessId', as: 'pedidosReposicion', onDelete: 'CASCADE' });
PedidoReposicion.belongsTo(Business, { foreignKey: 'businessId' });
PedidoReposicion.belongsTo(BusinessLocation, { foreignKey: 'locationId', as: 'local', onDelete: 'NO ACTION' });
PedidoReposicion.belongsTo(BusinessLocation, { foreignKey: 'depositoId', as: 'deposito', onDelete: 'NO ACTION' });
PedidoReposicion.belongsTo(Employee, { foreignKey: 'solicitadoPorEmployeeId', as: 'solicitadoPor', onDelete: 'NO ACTION' });
PedidoReposicion.belongsTo(Employee, { foreignKey: 'aprobadoPorEmployeeId', as: 'aprobadoPor', onDelete: 'NO ACTION' });
PedidoReposicion.belongsTo(Employee, { foreignKey: 'enviadoPorEmployeeId', as: 'enviadoPor', onDelete: 'NO ACTION' });
PedidoReposicion.belongsTo(Employee, { foreignKey: 'recibidoPorEmployeeId', as: 'recibidoPor', onDelete: 'NO ACTION' });

PedidoReposicion.hasMany(PedidoReposicionItem, { foreignKey: 'pedidoId', as: 'items', onDelete: 'CASCADE' });
PedidoReposicionItem.belongsTo(PedidoReposicion, { foreignKey: 'pedidoId', as: 'pedido' });
PedidoReposicionItem.belongsTo(ProductVariant, { foreignKey: 'productVariantId', as: 'variante', onDelete: 'NO ACTION' });

// El ingreso que se generó para cubrir un pedido. Sin cascada: el remito de
// entrada al depósito sobrevive aunque el pedido se dé de baja.
PedidoReposicion.hasMany(StockIngreso, { foreignKey: 'pedidoId', as: 'ingresos', onDelete: 'NO ACTION' });
StockIngreso.belongsTo(PedidoReposicion, { foreignKey: 'pedidoId', as: 'pedido', onDelete: 'NO ACTION' });

// ─── Suscripciones ───────────────────────────────────────────────
Business.hasOne(Subscription, { foreignKey: 'businessId', as: 'suscripcion', onDelete: 'CASCADE' });
Subscription.belongsTo(Business, { foreignKey: 'businessId' });
Subscription.belongsTo(Plan,     { foreignKey: 'planId', as: 'plan', onDelete: 'NO ACTION' });
Plan.hasMany(Subscription,       { foreignKey: 'planId', as: 'suscripciones' });

Subscription.hasMany(SubscriptionPayment, { foreignKey: 'subscriptionId', as: 'pagos', onDelete: 'NO ACTION' });
SubscriptionPayment.belongsTo(Subscription, { foreignKey: 'subscriptionId', as: 'suscripcion' });
Business.hasMany(SubscriptionPayment, { foreignKey: 'businessId', as: 'pagosSuscripcion', onDelete: 'CASCADE' });
SubscriptionPayment.belongsTo(Business, { foreignKey: 'businessId' });
SubscriptionPayment.belongsTo(Plan, { foreignKey: 'planId', as: 'plan', onDelete: 'NO ACTION' });

module.exports = {
  StockIngreso, StockIngresoItem, PedidoReposicion, PedidoReposicionItem,
  db,
  Plan, Subscription, SubscriptionPayment, PlatformAdmin, PlatformSetting, AuthAttempt,
  Business, BusinessLocation, BusinessCuit, BusinessArcaConfig, ArcaToken, VariantType, VariantStock,
  MercadoLibreAccount, MercadoLibreLink,
  Role, Employee, EmployeeSession, PasswordResetCode, AccountChangeCode, Client,
  Product, ProductVariant, StockMovement,
  Sale, SaleItem, Invoice, InvoiceItem,
  PaymentMethod, SalePayment, CashShift, CashMovement,
  ClientAccountEntry,
};
