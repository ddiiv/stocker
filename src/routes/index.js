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
const paymentCtrl = require('../controllers/paymentMethodController');
const cashCtrl = require('../controllers/cashController');
const accountCtrl = require('../controllers/accountController');

const r = Router();

// ── Auth ──────────────────────────────────────────────────────────
r.post('/auth/register',              registerLimiter, validatePasswordBody(), register);
r.post('/auth/login',                 loginLimiter, login);
r.post('/auth/employee-login',        loginLimiter, employeeLogin);
r.post('/auth/logout',                logout);
r.get ('/auth/me',                    requireAuth, me);
r.post('/auth/forgot-password',       passwordResetLimiter, forgotPassword);
r.post('/auth/verify-reset-code',     passwordResetLimiter, verifyResetCode);
r.post('/auth/reset-password',        passwordResetLimiter, validatePasswordBody('newPassword'), resetPassword);

// ── Cuenta del dueño ─────────────────────────────────────────────
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
r.get   ('/mercadolibre/auth-url',    requireAuth, requirePermission('integraciones','editar'), mlCtrl.authUrl);
r.delete('/mercadolibre/disconnect',  requireAuth, requirePermission('integraciones','editar'), mlCtrl.disconnect);
r.get   ('/mercadolibre/preview',     requireAuth, requirePermission('integraciones','ver'),    mlCtrl.preview);
r.post  ('/mercadolibre/sync',        requireAuth, requirePermission('integraciones','editar'), mlCtrl.sync);
r.get   ('/mercadolibre/links',       requireAuth, requirePermission('integraciones','ver'),    mlCtrl.listLinks);
r.post  ('/mercadolibre/links',       requireAuth, requirePermission('integraciones','editar'), mlCtrl.upsertLink);
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
r.post  ('/products/import',    requireAuth, requirePermission('stock','editar'), upload.single('file'),    productCtrl.importProducts);
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
r.patch ('/sales/:id/estado',           requireAuth, requirePermission('ventas','editar'), saleCtrl.updateSaleStatus);
r.post  ('/sales/cotizacion/:id/convertir', requireAuth, requirePermission('cotizaciones','editar'), saleCtrl.convertQuoteToSale);

// ── Invoices ─────────────────────────────────────────────────────
r.get   ('/invoices',           requireAuth, requirePermission('facturacion','ver'),    invoiceCtrl.getInvoices);
r.get   ('/invoices/:id',       requireAuth, requirePermission('facturacion','ver'),    invoiceCtrl.getInvoice);
r.post  ('/invoices',           requireAuth, requirePermission('facturacion','editar'), invoiceCtrl.createInvoice);
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
