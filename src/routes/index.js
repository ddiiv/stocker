const { Router } = require('express');
const multer = require('multer');
const { requireAuth, requirePermission, requireAnyPermission, requireOwner } = require('../middleware/auth');
const { loginLimiter, passwordResetLimiter, registerLimiter } = require('../middleware/rateLimit');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const { register, login, employeeLogin, logout, me, forgotPassword, verifyResetCode, resetPassword } = require('../controllers/authController');
const { validatePasswordBody } = require('../utils/passwordPolicy');
const productCtrl  = require('../controllers/productController');
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
const businessCuitCtrl = require('../controllers/businessCuitController');
const { testSend: whatsappTestSend } = require('../controllers/whatsappTestController');
const mlCtrl = require('../controllers/mercadolibreController');
const metricsCtrl = require('../controllers/metricsController');
const creditCtrl = require('../controllers/creditController');
const paymentCtrl = require('../controllers/paymentMethodController');
const cashCtrl = require('../controllers/cashController');
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
r.use((req, res, next) => (req.auth?.businessId ? exigirOperativa(req, res, next) : next()));

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
r.post  ('/employees',              requireAuth, requirePermission('empleados','editar'), employeeCtrl.createEmployee);
r.put   ('/employees/:id',          requireAuth, requirePermission('empleados','editar'), employeeCtrl.updateEmployee);
r.patch ('/employees/:id/toggle',   requireAuth, requirePermission('empleados','editar'), employeeCtrl.toggleActive);
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
// Escaneo con lector de barras — antes de /products/:id para que no lo capture
r.get   ('/products/scan/:codigo',                        requireAuth, requirePermission('stock','ver'),    productCtrl.scanLookup);
r.post  ('/products/scan/stock',                          requireAuth, requirePermission('stock','editar'), productCtrl.scanAdjustStock);
r.get   ('/products/:id',                                 requireAuth, requirePermission('stock','ver'),    productCtrl.getProduct);
r.post  ('/products',                                     requireAuth, requirePermission('stock','editar'), productCtrl.createProduct);
r.put   ('/products/:id',                                 requireAuth, requirePermission('stock','editar'), productCtrl.updateProduct);
r.delete('/products/:id',                                 requireAuth, requirePermission('stock','editar'), productCtrl.deleteProduct);
r.post  ('/products/:id/variants',                        requireAuth, requirePermission('stock','editar'), productCtrl.addVariant);
r.put   ('/products/variants/:variantId',                 requireAuth, requirePermission('stock','editar'), productCtrl.updateVariant);
r.delete('/products/variants/:variantId',                 requireAuth, requirePermission('stock','editar'), productCtrl.deleteVariant);
r.patch ('/products/variants/:variantId/stock',           requireAuth, requirePermission('stock','editar'), productCtrl.adjustStock);
r.get   ('/products/variants/:variantId/movements',       requireAuth, requirePermission('stock','ver'),    productCtrl.getVariantMovements);

// ── Sales & Quotes ───────────────────────────────────────────────
r.get   ('/sales',                      requireAuth, requirePermission('ventas','ver'),    saleCtrl.getSales);
r.get   ('/sales/:id',                  requireAuth, requirePermission('ventas','ver'),    saleCtrl.getSale);
r.get   ('/sales/:id/ticket',           requireAuth, requirePermission('ventas','ver'),    saleCtrl.downloadTicket);
r.post  ('/sales',                      requireAuth, requirePermission('ventas','editar'), saleCtrl.createSale);
// Mismo permiso que vender: quien atiende el mostrador es quien cobra lo que
// quedó fiado. Fijar los límites de crédito, en cambio, sigue siendo de pagos.
r.post  ('/sales/:id/cobrar',           requireAuth, requirePermission('ventas','editar'), saleCtrl.cobrarSale);
r.patch ('/sales/:id/estado',           requireAuth, requirePermission('ventas','editar'), saleCtrl.updateSaleStatus);
r.post  ('/sales/cotizacion/:id/convertir', requireAuth, requirePermission('cotizaciones','editar'), saleCtrl.convertQuoteToSale);

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
r.get('/metrics/timeline', requireAuth, requirePermission('dashboard','ver'), metricsCtrl.timeline);
r.get('/metrics/products', requireAuth, requirePermission('dashboard','ver'), metricsCtrl.products);

module.exports = r;
