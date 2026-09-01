const { Router } = require('express');
const multer = require('multer');
const { requireAuth, requirePermission, requireAnyPermission, requireOwner } = require('../middleware/auth');
const { loginLimiter, passwordResetLimiter, registerLimiter } = require('../middleware/rateLimit');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const { register, login, employeeLogin, logout, me, forgotPassword, verifyResetCode, resetPassword } = require('../controllers/authController');
const { validatePasswordBody } = require('../utils/passwordPolicy');
const productCtrl  = require('../controllers/productController');
const feriaCtrl    = require('../controllers/feriaController');
const employeeCtrl = require('../controllers/employeeController');
const saleCtrl     = require('../controllers/saleController');
const invoiceCtrl  = require('../controllers/invoiceController');
const {
  getLocations, createLocation, updateLocation, deleteLocation,
  getRoles, createRole, updateRole, deleteRole,
  getClients, createClient, updateClient, deleteClient,
  getDashboard,
} = require('../controllers/otherControllers');
const { lookupCuit } = require('../controllers/arcaController');
const arcaConfigCtrl = require('../controllers/arcaConfigController');
const variantTypeCtrl = require('../controllers/variantTypeController');
const skuCtrl = require('../controllers/skuController');
const businessCuitCtrl = require('../controllers/businessCuitController');
const { testSend: whatsappTestSend } = require('../controllers/whatsappTestController');
const mlCtrl = require('../controllers/mercadolibreController');
const metricsCtrl = require('../controllers/metricsController');
const creditCtrl = require('../controllers/creditController');
const paymentCtrl = require('../controllers/paymentMethodController');
const cashCtrl = require('../controllers/cashController');
const depositoCtrl = require('../controllers/depositoController');
const soporteCtrl = require('../controllers/soporteController');
const reposicionCtrl = require('../controllers/reposicionController');
const accountCtrl = require('../controllers/accountController');
const billingCtrl = require('../controllers/billingController');
const { exigirOperativa, requireFeature } = require('../middleware/plan');
const backofficeCtrl = require('../controllers/backofficeController');
const { requirePlatformAdmin } = require('../middleware/backoffice');
const { restringirBackoffice } = require('../middleware/ipAllowlist');
const { frenarSiBloqueado } = require('../services/bloqueoService');
const publicCtrl = require('../controllers/publicController');
const { FEATURES } = require('../config/planes');

const r = Router();

/*
 * Express 4 no entiende de promesas.
 *
 * Si un handler `async` rechaza, Express no lo ve: el rechazo queda sin
 * manejar y Node lo convierte en uncaughtException, que en index.js termina en
 * process.exit(1). O sea que un error asincrónico en UNA ruta dejaba sin
 * sistema a todos los negocios a la vez.
 *
 * No es teórico. `const t = await sequelize.transaction()` está escrito ANTES
 * del try en treinta controladores, y cuando el pool se agota —doce ventas
 * simultáneas alcanzan, con pool de 10— eso lanza fuera de todo catch. Se
 * reprodujo: el proceso se caía con "Operation timeout" y sin stack.
 *
 * Envolver acá, en el registro, cubre las 178 rutas de una y también las que
 * se agreguen después, que es lo que hace que el arreglo no se pierda. Un
 * rechazo pasa a ser un 500 con su log, como cualquier error sincrónico.
 */
const envolver = (fn) => (
  typeof fn === 'function' && fn.constructor.name === 'AsyncFunction'
    ? function envuelto(req, res, next) { return Promise.resolve(fn(req, res, next)).catch(next); }
    : fn
);

for (const metodo of ['get', 'post', 'put', 'patch', 'delete', 'all']) {
  const original = r[metodo].bind(r);
  r[metodo] = (ruta, ...handlers) => original(ruta, ...handlers.map(envolver));
}

// ── Auth ──────────────────────────────────────────────────────────
r.post('/auth/register',              registerLimiter, validatePasswordBody(), register);
r.post('/auth/login',                 loginLimiter, frenarSiBloqueado('business'), login);
r.post('/auth/employee-login',        loginLimiter, frenarSiBloqueado('employee'), employeeLogin);
r.post('/auth/logout',                logout);
r.get ('/auth/me',                    requireAuth, me);
r.post('/auth/forgot-password',       passwordResetLimiter, frenarSiBloqueado('reset'), forgotPassword);
r.post('/auth/verify-reset-code',     passwordResetLimiter, verifyResetCode);
r.post('/auth/reset-password',        passwordResetLimiter, validatePasswordBody('newPassword'), resetPassword);

// ── Cuenta del dueño ─────────────────────────────────────────────
/*
 * Suscripción a Stocker.
 *
 * El catálogo de planes es público: lo consume la pantalla de precios, y quien
 * está en modo lectura tiene que poder ver a qué plan pasarse.
 *
 * El resto pide requireOwner: un empleado no decide qué plan paga el negocio.
 * Ninguna de estas rutas lleva `exigirOperativa` — sería encerrar al cliente
 * fuera de la única pantalla que le permite volver a operar.
 *
 * El webhook queda sin auth porque lo llama Mercado Pago; se defiende
 * validando la firma y consultando el pago contra la API de MP.
 */
r.get ('/billing/planes',          billingCtrl.getPlanes);
// El catálogo de funciones, para que ninguna pantalla lo escriba a mano.
r.get ('/billing/features',        billingCtrl.getFeatures);
r.post('/billing/webhook/mercadopago', billingCtrl.webhookMercadoPago);
r.get ('/billing/suscripcion',     requireAuth, requireOwner, billingCtrl.getSuscripcion);
r.get ('/billing/pagos',           requireAuth, requireOwner, billingCtrl.getPagos);
r.post('/billing/checkout',        requireAuth, requireOwner, billingCtrl.crearCheckout);
r.get ('/billing/transferencia',   requireAuth, requireOwner, billingCtrl.getDatosTransferencia);
r.post('/billing/transferencia',   requireAuth, requireOwner, billingCtrl.informarTransferencia);
r.post('/billing/verificar',       requireAuth, requireOwner, billingCtrl.verificarPagos);
r.post('/billing/renovacion',      requireAuth, requireOwner, billingCtrl.cambiarRenovacion);
r.post('/billing/baja',            requireAuth, requireOwner, billingCtrl.solicitarBaja);
r.delete('/billing/baja',          requireAuth, requireOwner, billingCtrl.cancelarBaja);
r.get ('/billing/pagos/:id/recibo', requireAuth, requireOwner, billingCtrl.descargarRecibo);

/*
 * Datos que consume la página pública (contacto, precios, cotización).
 *
 * Abierto a propósito: lo lee un sitio estático sin sesión. Sólo devuelve lo
 * que ya está publicado en la página de precios.
 */
r.get ('/public/landing',          publicCtrl.datosLanding);

/*
 * Backoffice de Stocker — administración de la plataforma.
 *
 * Sesión propia (`type: platform`), separada de la de los negocios: un token
 * de dueño no abre estas rutas ni con el id correcto. El login exige segundo
 * factor porque es la única cuenta que ve los datos de todos los clientes.
 */
/*
 * Restricción por IP para TODO el backoffice, incluido el login.
 *
 * Va como un `use` sobre el prefijo y no ruta por ruta: una ruta nueva que
 * alguien olvide anotar quedaría abierta a internet, y ese olvido no se nota
 * hasta que ya pasó algo.
 *
 * Se aplica antes del login a propósito. Si sólo cubriera las rutas con sesión,
 * cualquiera podría seguir probando contraseñas contra el login desde afuera.
 */
r.use('/backoffice', restringirBackoffice);

r.post('/backoffice/login',          loginLimiter, frenarSiBloqueado('platform'), backofficeCtrl.login);
r.post('/backoffice/logout',         backofficeCtrl.logout);
r.post('/backoffice/totp/activar',   loginLimiter, backofficeCtrl.activarTotp);
r.get ('/backoffice/me',             requirePlatformAdmin, backofficeCtrl.yo);
r.get ('/backoffice/resumen',        requirePlatformAdmin, backofficeCtrl.resumen);
r.get ('/backoffice/cuentas',        requirePlatformAdmin, backofficeCtrl.listarCuentas);
r.get ('/backoffice/cuentas/:id',    requirePlatformAdmin, backofficeCtrl.verCuenta);
r.put ('/backoffice/cuentas/:id/suscripcion', requirePlatformAdmin, backofficeCtrl.editarSuscripcion);
r.post('/backoffice/pagos/:id/aprobar',   requirePlatformAdmin, backofficeCtrl.aprobarPago);
r.post('/backoffice/pagos/:id/rechazar',  requirePlatformAdmin, backofficeCtrl.rechazarPago);
r.get ('/backoffice/planes',         requirePlatformAdmin, backofficeCtrl.listarPlanes);
r.get ('/backoffice/planes/catalogo', requirePlatformAdmin, backofficeCtrl.catalogoDeFeatures);
r.put ('/backoffice/planes/:codigo', requirePlatformAdmin, backofficeCtrl.editarPlan);
r.get ('/backoffice/mercadopago',    requirePlatformAdmin, backofficeCtrl.estadoMercadoPago);
r.get ('/backoffice/seguridad',      requirePlatformAdmin, backofficeCtrl.estadoSeguridad);
r.get ('/backoffice/ajustes',        requirePlatformAdmin, backofficeCtrl.getAjustes);
r.put ('/backoffice/ajustes',        requirePlatformAdmin, backofficeCtrl.editarAjustes);

// requireOwner en todas: un empleado no toca las credenciales del negocio.
// Los cambios de email y contraseña pasan por el limitador de recuperación,
// que ya acota los pedidos que disparan un mail.
r.get ('/account',                   requireAuth, requireOwner, accountCtrl.obtener);
r.put ('/account',                   requireAuth, requireOwner, accountCtrl.actualizar);
r.post('/account/sincronizar-arca',  requireAuth, requireOwner, accountCtrl.sincronizarConArca);
r.post('/account/email/solicitar',   requireAuth, requireOwner, passwordResetLimiter, accountCtrl.solicitarCambioEmail);
r.post('/account/email/confirmar',   requireAuth, requireOwner, accountCtrl.confirmarCambioEmail);
r.post('/account/password/solicitar', requireAuth, requireOwner, passwordResetLimiter, accountCtrl.solicitarCambioPassword);
r.post('/account/password/confirmar', requireAuth, requireOwner, validatePasswordBody('passwordNueva'), accountCtrl.confirmarCambioPassword);

/*
 * A partir de acá, todo lo que ESCRIBE exige la cuenta al día.
 *
 * Va como un `use` y no repetido ruta por ruta: una ruta nueva que alguien
 * olvide anotar quedaría cobrando gratis, y ese olvido no se nota nunca.
 *
 * Sólo afecta a métodos de escritura y sólo a sesiones ya autenticadas: los
 * GET siguen abiertos aunque la cuenta esté impaga. Es la regla del modo
 * lectura — el cliente nunca pierde el acceso a sus propios datos.
 */
// El candado vive ahora dentro de requireAuth (middleware/auth.js): acá corría
// antes de que existiera req.auth y por eso dejaba pasar todo. La lista de
// rutas exentas está en middleware/plan.js.

/*
 * Feria.
 *
 * Preparar el catálogo de un puesto de feria es trabajo de stock: se eligen
 * productos del catálogo normal y se genera su versión sin variantes. Vender en
 * la feria, en cambio, es el punto de venta de siempre — no hay rutas de venta
 * acá.
 */
/*
 * Depósito, reposición y eventos entran al catálogo de planes.
 *
 * Se cierran sólo los POST. Los GET quedan abiertos a propósito: un negocio
 * que baja de plan tiene que poder seguir MIRANDO la mercadería que cargó y
 * los pedidos que hizo. Cerrarle la lectura sería quitarle sus datos, no una
 * función.
 *
 * Y quien ya venía usando esto antes de que existiera la puerta la conserva:
 * lo resuelve requireFeature contra `featuresHeredadas` (ver ensureColumns).
 */
r.get ('/feria/candidatos', requireAuth, requirePermission('stock', 'ver'),    feriaCtrl.getCandidatos);
r.get ('/feria/productos',  requireAuth, requireAnyPermission(['stock', 'ventas'], 'ver'), feriaCtrl.getProductos);
// La lista de precios del puesto, en PDF. Es un informe: alcanza con poder ver.
r.get ('/feria/lista-precios', requireAuth, requireAnyPermission(['stock', 'ventas'], 'ver'), feriaCtrl.getListaPrecios);
r.post('/feria/generar',    requireAuth, requirePermission('stock', 'editar'), requireFeature(FEATURES.EVENTOS), feriaCtrl.postGenerar);
// Un producto de evento cargado a mano, sin original en el catálogo.
r.post('/feria/productos',  requireAuth, requirePermission('stock', 'editar'), requireFeature(FEATURES.EVENTOS), feriaCtrl.postManual);
r.post('/feria/precios',    requireAuth, requirePermission('stock', 'editar'), requireFeature(FEATURES.EVENTOS), feriaCtrl.postPrecios);

// ── Locations ─────────────────────────────────────────────────────
// El listado queda con requireAuth solo: lo necesitan casi todas las pantallas
// (venta, POS, stock, movimientos) y sólo devuelve nombres de sucursal del
// propio negocio. Escribir sí exige permiso de empleados.
r.get   ('/locations',     requireAuth, getLocations);
r.post  ('/locations',     requireAuth, requirePermission('empleados','editar'), createLocation);
r.put   ('/locations/:id', requireAuth, requirePermission('empleados','editar'), updateLocation);
r.delete('/locations/:id', requireAuth, requirePermission('empleados','editar'), deleteLocation);

// ── Roles / Cargos ────────────────────────────────────────────────
r.get   ('/roles',     requireAuth, requirePermission('empleados','ver'),    getRoles);
r.post  ('/roles',     requireAuth, requirePermission('empleados','editar'), createRole);
r.put   ('/roles/:id', requireAuth, requirePermission('empleados','editar'), updateRole);
r.delete('/roles/:id', requireAuth, requirePermission('empleados','editar'), deleteRole);

// ── Employees ─────────────────────────────────────────────────────
r.get   ('/employees',              requireAuth, requirePermission('empleados','ver'),    employeeCtrl.getEmployees);
r.get   ('/employees/:id',          requireAuth, requirePermission('empleados','ver'),    employeeCtrl.getEmployee);
r.get   ('/employees/:id/sessions', requireAuth, requirePermission('empleados','ver'),    employeeCtrl.getSessions);
/*
 * El empleado entra al sistema con esta contraseña, así que pasa por la misma
 * política que la del dueño. Antes no pasaba por ninguna: `123` se aceptaba, y
 * sin contraseña se creaba una cuenta que no podía entrar y nadie avisaba.
 */
r.post  ('/employees',              requireAuth, requirePermission('empleados','editar'), validatePasswordBody('password', {
  mensajeFalta: 'Poné una contraseña: es con la que el empleado va a entrar al sistema.',
}), employeeCtrl.createEmployee);
r.put   ('/employees/:id',          requireAuth, requirePermission('empleados','editar'), validatePasswordBody('password', { opcional: true }), employeeCtrl.updateEmployee);
r.patch ('/employees/:id/toggle',   requireAuth, requirePermission('empleados','editar'), employeeCtrl.toggleActive);
// Levantar el bloqueo por intentos fallidos: sólo el dueño. Es una decisión de
// seguridad —si fue un ataque o alguien que se equivocó de tecla—, y no algo
// que se delegue con el módulo de empleados.
r.post  ('/employees/:id/desbloquear', requireAuth, requireOwner, employeeCtrl.desbloquear);
r.delete('/employees/:id',          requireAuth, requirePermission('empleados','editar'), employeeCtrl.deleteEmployee);

// ── Clients ───────────────────────────────────────────────────────
/*
 * Cuentas corrientes. Va antes de '/clients/:id' — si no, Express toma
 * "cuentas" como un id y la ruta nunca se alcanza.
 *
 * Consultar y cobrar entra con permiso de clientes: es tarea de mostrador.
 * Fijar el límite exige permiso de pagos, porque decidir a quién se le fía y
 * por cuánto es una decisión de plata, no de carga de datos.
 */
r.get   ('/clients/cuentas',       requireAuth, requirePermission('clientes','ver'),    creditCtrl.getCuentas);
r.get   ('/clients/:id/cuenta',    requireAuth, requirePermission('clientes','ver'),    creditCtrl.getCuenta);
r.put   ('/clients/:id/cuenta',    requireAuth, requirePermission('pagos','editar'),    requireFeature(FEATURES.CUENTAS_CORRIENTES), creditCtrl.updateCuentaConfig);
r.post  ('/clients/:id/cuenta/pagos', requireAuth, requirePermission('clientes','editar'), requireFeature(FEATURES.CUENTAS_CORRIENTES), creditCtrl.registrarPago);

r.get   ('/clients',     requireAuth, requirePermission('clientes','ver'),    getClients);
r.post  ('/clients',     requireAuth, requirePermission('clientes','editar'), createClient);
r.put   ('/clients/:id', requireAuth, requirePermission('clientes','editar'), updateClient);
r.delete('/clients/:id', requireAuth, requirePermission('clientes','editar'), deleteClient);

// ── ARCA / CUIT lookup ───────────────────────────────────────────
// Lo consumen la pantalla de clientes y la de CUITs del negocio.
r.get('/arca/cuit/:cuit', requireAuth, requireAnyPermission(['clientes', 'facturacion']), lookupCuit);

// ── ARCA / config por CUIT del negocio ───────────────────────────
r.get ('/arca/status',                  requireAuth, requirePermission('facturacion','ver'), arcaConfigCtrl.status);
// Expone CUIT de Stocker y rutas de certificados: sólo el dueño.
r.get ('/arca/debug',                   requireAuth, requireOwner, arcaConfigCtrl.debug);
r.get ('/arca/cuits/:cuitId/config',    requireAuth, requirePermission('facturacion','ver'), arcaConfigCtrl.getConfig);
r.put ('/arca/cuits/:cuitId/config',    requireAuth, requirePermission('facturacion','editar'), arcaConfigCtrl.saveConfig);
r.post('/arca/cuits/:cuitId/verify',    requireAuth, requirePermission('facturacion','editar'), arcaConfigCtrl.verifyDelegation);

// ── MercadoLibre (sincronización de stock por SKU) ───────────────
// El callback es público: ML redirige al usuario ahí sin nuestro JWT,
// el negocio se identifica por el parámetro `state`.
r.get   ('/mercadolibre/callback',    mlCtrl.callback);
r.get   ('/mercadolibre/status',      requireAuth, requirePermission('integraciones','ver'),    mlCtrl.status);
r.get   ('/mercadolibre/auth-url',    requireAuth, requirePermission('integraciones','editar'), requireFeature(FEATURES.ECOMMERCE), mlCtrl.authUrl);
r.delete('/mercadolibre/disconnect',  requireAuth, requirePermission('integraciones','editar'), mlCtrl.disconnect);
r.get   ('/mercadolibre/preview',     requireAuth, requirePermission('integraciones','ver'),    mlCtrl.preview);
r.post  ('/mercadolibre/sync',        requireAuth, requirePermission('integraciones','editar'), requireFeature(FEATURES.ECOMMERCE), mlCtrl.sync);
r.get   ('/mercadolibre/links',       requireAuth, requirePermission('integraciones','ver'),    mlCtrl.listLinks);
r.post  ('/mercadolibre/links',       requireAuth, requirePermission('integraciones','editar'), requireFeature(FEATURES.ECOMMERCE), mlCtrl.upsertLink);
r.delete('/mercadolibre/links/:id',   requireAuth, requirePermission('integraciones','editar'), mlCtrl.deleteLink);

// ── Variant types (variantes maestras del negocio) ───────────────
r.get   ('/variant-types',      requireAuth, requirePermission('stock','ver'),    variantTypeCtrl.list);
r.post  ('/variant-types',      requireAuth, requirePermission('stock','editar'), variantTypeCtrl.create);
r.put   ('/variant-types/:id',  requireAuth, requirePermission('stock','editar'), variantTypeCtrl.update);
r.delete('/variant-types/:id',  requireAuth, requirePermission('stock','editar'), variantTypeCtrl.remove);

// ── WhatsApp test (debug) ─────────────────────────────────────────
// Manda mensajes reales: si lo alcanza cualquier empleado, es un spammer.
r.post('/whatsapp/test', requireAuth, requireOwner, whatsappTestSend);
r.get ('/whatsapp/test', requireAuth, requireOwner, whatsappTestSend);

// ── Business CUITs (multi-CUIT para facturación) ─────────────────
// Lo lee la pantalla de CUITs y también el detalle de venta.
r.get   ('/business-cuits',     requireAuth, requireAnyPermission(['facturacion', 'ventas']), businessCuitCtrl.list);
r.post  ('/business-cuits',     requireAuth, requirePermission('facturacion','editar'), businessCuitCtrl.create);
r.put   ('/business-cuits/:id', requireAuth, requirePermission('facturacion','editar'), businessCuitCtrl.update);
r.delete('/business-cuits/:id', requireAuth, requirePermission('facturacion','editar'), businessCuitCtrl.remove);

// ── Products ──────────────────────────────────────────────────────
r.get   ('/products',                                     requireAuth, requirePermission('stock','ver'),    productCtrl.getProducts);
r.get   ('/products/export',                              requireAuth, requirePermission('stock','ver'),    productCtrl.exportProducts);
r.post  ('/products/import',    requireAuth, requirePermission('stock','editar'), requireFeature(FEATURES.IMPORTACION_MASIVA), upload.single('file'),    productCtrl.importProducts);
r.get   ('/products/sku/:skuV', requireAuth, requirePermission('stock','ver'),    productCtrl.getProductPadreBySkuVariante);
// Buscador de variantes para el alta de ventas. Vale con ver stock o ver
// ventas: quien vende necesita encontrar la prenda aunque no tenga el módulo
// de stock, y es sólo consulta.
r.get   ('/products/buscar-variantes',                    requireAuth, requireAnyPermission(['stock','ventas'],'ver'), productCtrl.buscarVariantes);
// Escaneo con lector de barras — antes de /products/:id para que no lo capture
r.get   ('/products/scan/:codigo',                        requireAuth, requirePermission('stock','ver'),    productCtrl.scanLookup);
r.post  ('/products/scan/stock',                          requireAuth, requirePermission('stock','editar'), productCtrl.scanAdjustStock);
r.get   ('/products/:id',                                 requireAuth, requirePermission('stock','ver'),    productCtrl.getProduct);
r.post  ('/products',                                     requireAuth, requirePermission('stock','editar'), productCtrl.createProduct);
r.put   ('/products/:id',                                 requireAuth, requirePermission('stock','editar'), productCtrl.updateProduct);
r.delete('/products/:id',                                 requireAuth, requirePermission('stock','editar'), productCtrl.deleteProduct);
r.post  ('/products/:id/variants',                        requireAuth, requirePermission('stock','editar'), productCtrl.addVariant);
// Alta por combinatoria desde la tabla maestra de variantes. Sin `confirmar`
// sólo devuelve el plan, así la pantalla muestra exactamente lo que va a grabar.
r.post  ('/products/:id/variants/masivo',                 requireAuth, requirePermission('stock','editar'), productCtrl.agregarVariantesMasivo);
r.put   ('/products/variants/:variantId',                 requireAuth, requirePermission('stock','editar'), productCtrl.updateVariant);
r.delete('/products/variants/:variantId',                 requireAuth, requirePermission('stock','editar'), productCtrl.deleteVariant);
r.patch ('/products/variants/:variantId/stock',           requireAuth, requirePermission('stock','editar'), productCtrl.adjustStock);
// El libro de movimientos es de lectura: alcanza con permiso de ver stock.
/*
 * Confección de SKU. Ver la regla es parte de ver el stock; cambiarla afecta a
 * todo el catálogo y pide permiso de edición.
 */
r.get   ('/sku/regla',                                    requireAuth, requirePermission('stock','ver'),    skuCtrl.getRegla);
r.put   ('/sku/regla',                                    requireAuth, requirePermission('stock','editar'), skuCtrl.putRegla);
r.post  ('/sku/vista-previa',                             requireAuth, requirePermission('stock','ver'),    skuCtrl.vistaPrevia);
r.post  ('/sku/sugerir',                                  requireAuth, requirePermission('stock','ver'),    skuCtrl.sugerir);
r.get   ('/sku/disponible',                               requireAuth, requirePermission('stock','ver'),    skuCtrl.disponible);

// Imprimir etiquetas es parte de operar el stock, no de editarlo.
r.post  ('/products/precios-masivo',                       requireAuth, requirePermission('stock','editar'), productCtrl.preciosMasivo);
r.post  ('/products/etiquetas',                           requireAuth, requirePermission('stock','ver'),    productCtrl.generarEtiquetasPdf);

r.post  ('/stock/ajuste-masivo',                          requireAuth, requirePermission('stock','editar'), productCtrl.ajusteMasivo);
r.get   ('/stock/ingresos',                               requireAuth, requirePermission('stock','ver'),    productCtrl.getIngresosDelDia);
r.get   ('/stock/por-local/productos',                     requireAuth, requirePermission('stock','ver'),    productCtrl.getProductosPorLocal);
r.get   ('/stock/por-local/producto/:id',                 requireAuth, requirePermission('stock','ver'),    productCtrl.getVariantesPorLocal);
r.get   ('/stock/por-local',                              requireAuth, requirePermission('stock','ver'),    productCtrl.getStockPorLocal);
r.post  ('/stock/transferir',                             requireAuth, requirePermission('stock','editar'), productCtrl.transferirStock);

// Lo vendido sin stock cargado, que quedó en negativo esperando conteo.
r.get   ('/stock/a-regularizar',                          requireAuth, requirePermission('stock','ver'),    productCtrl.stockARegularizar);
r.get   ('/stock/movimientos',                            requireAuth, requirePermission('stock','ver'),    productCtrl.getStockMovements);
r.get   ('/products/variants/:variantId/movements',       requireAuth, requirePermission('stock','ver'),    productCtrl.getVariantMovements);

// ── Sales & Quotes ───────────────────────────────────────────────
r.get   ('/sales',                      requireAuth, requirePermission('ventas','ver'),    saleCtrl.getSales);
r.get   ('/sales/:numero',                  requireAuth, requirePermission('ventas','ver'),    saleCtrl.getSale);
r.get   ('/sales/:numero/ticket',           requireAuth, requirePermission('ventas','ver'),    saleCtrl.downloadTicket);
r.post  ('/sales',                      requireAuth, requirePermission('ventas','editar'), saleCtrl.createSale);
// Mismo permiso que vender: quien atiende el mostrador es quien cobra lo que
// quedó fiado. Fijar los límites de crédito, en cambio, sigue siendo de pagos.
r.post  ('/sales/:numero/cobrar',           requireAuth, requirePermission('ventas','editar'), saleCtrl.cobrarSale);
r.patch ('/sales/:numero/estado',           requireAuth, requirePermission('ventas','editar'), saleCtrl.updateSaleStatus);
// Anular: devuelve el stock, cancela la deuda y exige el motivo. Separado del
// cambio de estado porque deshace cosas, no sólo mueve una etiqueta.
r.post  ('/sales/:numero/anular',           requireAuth, requirePermission('ventas','editar'), saleCtrl.anularSale);
r.post  ('/sales/cotizacion/:numero/convertir', requireAuth, requirePermission('cotizaciones','editar'), saleCtrl.convertQuoteToSale);

// ── Invoices ─────────────────────────────────────────────────────
r.get   ('/invoices',           requireAuth, requirePermission('facturacion','ver'),    invoiceCtrl.getInvoices);
r.get   ('/invoices/:id',       requireAuth, requirePermission('facturacion','ver'),    invoiceCtrl.getInvoice);
r.post  ('/invoices',           requireAuth, requirePermission('facturacion','editar'), requireFeature(FEATURES.FACTURACION), invoiceCtrl.createInvoice);
r.patch ('/invoices/:id/anular',requireAuth, requirePermission('facturacion','editar'), invoiceCtrl.voidInvoice);
r.get   ('/invoices/:id/pdf',   requireAuth, requirePermission('facturacion','ver'),    invoiceCtrl.downloadPdf);

// ── Métodos de pago ──────────────────────────────────────────────
r.get   ('/payment-methods',     requireAuth, requireAnyPermission(['pagos','ventas']), paymentCtrl.list);
r.post  ('/payment-methods',     requireAuth, requirePermission('pagos','editar'), paymentCtrl.create);
r.put   ('/payment-methods/:id', requireAuth, requirePermission('pagos','editar'), paymentCtrl.update);
r.delete('/payment-methods/:id', requireAuth, requirePermission('pagos','editar'), paymentCtrl.remove);

// ── Caja / arqueo ────────────────────────────────────────────────
/* ─── Circuito depósito → local ────────────────────────────────────
 *
 * Tres permisos distintos porque son tres trabajos distintos:
 *   deposito     cuenta e ingresa mercadería nueva.
 *   reposicion   pide desde el local y prepara los envíos.
 *   aprobaciones firma. Es el control que separa a quien carga de quien
 *                autoriza, así que no se hereda de ninguno de los otros dos.
 */
r.get   ('/deposito/lugares',                requireAuth, requireAnyPermission(['deposito','reposicion','stock'],'ver'), depositoCtrl.lugares);
r.get   ('/deposito/ingresos',               requireAuth, requireAnyPermission(['deposito','aprobaciones'],'ver'),       depositoCtrl.listar);
r.get   ('/deposito/curva',                  requireAuth, requirePermission('deposito','ver'),                          depositoCtrl.curva);
r.post  ('/deposito/ingresos',               requireAuth, requirePermission('deposito','editar'), requireFeature(FEATURES.DEPOSITO),  depositoCtrl.crear);
r.post  ('/deposito/ingresos/:id/etiquetas', requireAuth, requirePermission('deposito','ver'),                           depositoCtrl.etiquetas);
r.post  ('/deposito/ingresos/:id/aceptar',   requireAuth, requirePermission('aprobaciones','editar'), requireFeature(FEATURES.DEPOSITO), depositoCtrl.aceptar);
r.post  ('/deposito/ingresos/:id/rechazar',  requireAuth, requirePermission('aprobaciones','editar'),                    depositoCtrl.rechazar);
r.post  ('/deposito/ingresos/:id/anular',    requireAuth, requirePermission('aprobaciones','editar'),                    depositoCtrl.anular);

// El contador de bandejas lo mira cualquiera de los tres roles: es lo que
// hace que un pedido aprobado no se quede esperando a que alguien pregunte.
r.get   ('/reposicion/pendientes',           requireAuth, requireAnyPermission(['reposicion','deposito','aprobaciones'],'ver'), reposicionCtrl.pendientes);
// Los saldos sin resolver: lo que se pidió, no salió del depósito y espera
// que alguien decida. Va primero en la pantalla para que no se olvide.
r.get   ('/reposicion/saldos',               requireAuth, requireAnyPermission(['reposicion','deposito','aprobaciones'],'ver'), reposicionCtrl.saldos);
r.post  ('/reposicion/pedidos/:id/saldo',    requireAuth, requirePermission('aprobaciones','editar'), reposicionCtrl.resolverSaldo);
r.get   ('/reposicion/en-transito',          requireAuth, requireAnyPermission(['reposicion','deposito','stock'],'ver'),        reposicionCtrl.transito);
r.get   ('/reposicion/pedidos',              requireAuth, requireAnyPermission(['reposicion','deposito','aprobaciones'],'ver'), reposicionCtrl.listar);
r.get   ('/reposicion/pedidos/:id',          requireAuth, requireAnyPermission(['reposicion','deposito','aprobaciones'],'ver'), reposicionCtrl.detalle);
// Qué hay en el depósito de lo que este pedido pide. La miran oficina para
// aprobar y el depósito para armar: el mismo número para los dos.
r.get   ('/reposicion/pedidos/:id/disponibilidad', requireAuth, requireAnyPermission(['reposicion','deposito','aprobaciones'],'ver'), reposicionCtrl.disponibilidad);
// Cargar mercadería que estaba en el estante sin registrar, para completar el
// pedido. Es un ingreso al depósito y por eso pide permiso de depósito.
r.post  ('/reposicion/pedidos/:id/registrar-faltante', requireAuth, requirePermission('deposito','editar'), reposicionCtrl.registrarFaltante);
r.post  ('/reposicion/pedidos',              requireAuth, requirePermission('reposicion','editar'), requireFeature(FEATURES.REPOSICION), reposicionCtrl.crear);
r.post  ('/reposicion/pedidos/:id/cancelar', requireAuth, requirePermission('reposicion','editar'),   reposicionCtrl.cancelar);
r.post  ('/reposicion/pedidos/:id/despachar',requireAuth, requirePermission('reposicion','editar'), requireFeature(FEATURES.REPOSICION), reposicionCtrl.despachar);
r.post  ('/reposicion/pedidos/:id/recibir',  requireAuth, requirePermission('reposicion','editar'),   reposicionCtrl.recibir);
r.post  ('/reposicion/pedidos/:id/aprobar',  requireAuth, requirePermission('aprobaciones','editar'), reposicionCtrl.aprobar);
r.post  ('/reposicion/pedidos/:id/rechazar', requireAuth, requirePermission('aprobaciones','editar'), reposicionCtrl.rechazar);

/* ─── Soporte ──────────────────────────────────────────────────────
 *
 * Reportar un problema desde adentro del sistema. Cualquiera con sesión puede:
 * el que se topa con el bug suele ser quien está atendiendo, no el dueño.
 */
r.get ('/soporte/info',    requireAuth, soporteCtrl.info);
r.post('/soporte/reporte', requireAuth, soporteCtrl.reportar);

r.get ('/cash/turno-actual',   requireAuth, requirePermission('caja','ver'),    cashCtrl.turnoActual);
r.post('/cash/abrir',          requireAuth, requirePermission('caja','editar'), cashCtrl.abrir);
r.post('/cash/cerrar',         requireAuth, requirePermission('caja','editar'), cashCtrl.cerrar);
r.post('/cash/movimientos',    requireAuth, requirePermission('caja','editar'), cashCtrl.registrarMovimiento);
r.get ('/cash/turnos',         requireAuth, requirePermission('caja','ver'),    cashCtrl.listarTurnos);
r.get ('/cash/retiros',        requireAuth, requirePermission('caja','ver'),    cashCtrl.listarRetiros);
r.get ('/cash/turnos/:id',     requireAuth, requirePermission('caja','ver'),    cashCtrl.detalleTurno);

// ── Dashboard ─────────────────────────────────────────────────────
r.get('/dashboard', requireAuth, requirePermission('dashboard','ver'), getDashboard);

// ── Métricas analíticas (histórico + rendimiento por producto) ───
// El panel analítico: todo agregado en la base, para que el costo no crezca
// con los años de historia del negocio.
r.get('/metrics/panel',    requireAuth, requirePermission('dashboard','ver'), metricsCtrl.panel);
r.get('/metrics/timeline', requireAuth, requirePermission('dashboard','ver'), metricsCtrl.timeline);
r.get('/metrics/products', requireAuth, requirePermission('dashboard','ver'), metricsCtrl.products);

module.exports = r;
