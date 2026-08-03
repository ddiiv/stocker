const { Router } = require('express');
const multer = require('multer');
const { requireAuth, requirePermission } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const { register, login, employeeLogin, me } = require('../controllers/authController');
const productCtrl = require('../controllers/productController');
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

const r = Router();

// ── Auth ──────────────────────────────────────────────────────────
r.post('/auth/register',        register);
r.post('/auth/login',           login);
r.post('/auth/employee-login',  employeeLogin);
r.get ('/auth/me',              requireAuth, me);

// ── Locations ─────────────────────────────────────────────────────
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
r.get   ('/clients',     requireAuth, requirePermission('ventas','ver'),    getClients);
r.post  ('/clients',     requireAuth, requirePermission('ventas','editar'), createClient);
r.put   ('/clients/:id', requireAuth, requirePermission('ventas','editar'), updateClient);
r.delete('/clients/:id', requireAuth, requirePermission('ventas','editar'), deleteClient);

// ── ARCA / CUIT lookup ───────────────────────────────────────────
r.get('/arca/cuit/:cuit', requireAuth, lookupCuit);

// ── ARCA / config por CUIT del negocio ───────────────────────────
r.get ('/arca/status',                  requireAuth, arcaConfigCtrl.status);
r.get ('/arca/cuits/:cuitId/config',    requireAuth, arcaConfigCtrl.getConfig);
r.put ('/arca/cuits/:cuitId/config',    requireAuth, requirePermission('facturacion','editar'), arcaConfigCtrl.saveConfig);
r.post('/arca/cuits/:cuitId/verify',    requireAuth, requirePermission('facturacion','editar'), arcaConfigCtrl.verifyDelegation);

// ── Variant types (variantes maestras del negocio) ───────────────
r.get   ('/variant-types',      requireAuth, requirePermission('stock','ver'),    variantTypeCtrl.list);
r.post  ('/variant-types',      requireAuth, requirePermission('stock','editar'), variantTypeCtrl.create);
r.put   ('/variant-types/:id',  requireAuth, requirePermission('stock','editar'), variantTypeCtrl.update);
r.delete('/variant-types/:id',  requireAuth, requirePermission('stock','editar'), variantTypeCtrl.remove);

// ── WhatsApp test (debug) ─────────────────────────────────────────
r.post('/whatsapp/test', requireAuth, whatsappTestSend);
r.get ('/whatsapp/test', requireAuth, whatsappTestSend);

// ── Business CUITs (multi-CUIT para facturación) ─────────────────
r.get   ('/business-cuits',     requireAuth, businessCuitCtrl.list);
r.post  ('/business-cuits',     requireAuth, requirePermission('facturacion','editar'), businessCuitCtrl.create);
r.put   ('/business-cuits/:id', requireAuth, requirePermission('facturacion','editar'), businessCuitCtrl.update);
r.delete('/business-cuits/:id', requireAuth, requirePermission('facturacion','editar'), businessCuitCtrl.remove);

// ── Products ──────────────────────────────────────────────────────
r.get   ('/products',                                     requireAuth, requirePermission('stock','ver'),    productCtrl.getProducts);
r.get   ('/products/export',                              requireAuth, requirePermission('stock','ver'),    productCtrl.exportProducts);
r.post  ('/products/import',    requireAuth, requirePermission('stock','editar'), upload.single('file'),    productCtrl.importProducts);
r.get   ('/products/:id',                                 requireAuth, requirePermission('stock','ver'),    productCtrl.getProduct);
r.post  ('/products',                                     requireAuth, requirePermission('stock','editar'), productCtrl.createProduct);
r.put   ('/products/:id',                                 requireAuth, requirePermission('stock','editar'), productCtrl.updateProduct);
r.delete('/products/:id',                                 requireAuth, requirePermission('stock','editar'), productCtrl.deleteProduct);
r.post  ('/products/:id/variants',                        requireAuth, requirePermission('stock','editar'), productCtrl.addVariant);
r.put   ('/products/variants/:variantId',                 requireAuth, requirePermission('stock','editar'), productCtrl.updateVariant);
r.patch ('/products/variants/:variantId/stock',           requireAuth, requirePermission('stock','editar'), productCtrl.adjustStock);
r.get   ('/products/variants/:variantId/movements',       requireAuth, requirePermission('stock','ver'),    productCtrl.getVariantMovements);

// ── Sales & Quotes ───────────────────────────────────────────────
r.get   ('/sales',                      requireAuth, requirePermission('ventas','ver'),    saleCtrl.getSales);
r.get   ('/sales/:id',                  requireAuth, requirePermission('ventas','ver'),    saleCtrl.getSale);
r.get   ('/sales/:id/ticket',           requireAuth, requirePermission('ventas','ver'),    saleCtrl.downloadTicket);
r.post  ('/sales',                      requireAuth, requirePermission('ventas','editar'), saleCtrl.createSale);
r.patch ('/sales/:id/estado',           requireAuth, requirePermission('ventas','editar'), saleCtrl.updateSaleStatus);
r.post  ('/sales/cotizacion/:id/convertir', requireAuth, requirePermission('ventas','editar'), saleCtrl.convertQuoteToSale);

// ── Invoices ─────────────────────────────────────────────────────
r.get   ('/invoices',           requireAuth, requirePermission('facturacion','ver'),    invoiceCtrl.getInvoices);
r.get   ('/invoices/:id',       requireAuth, requirePermission('facturacion','ver'),    invoiceCtrl.getInvoice);
r.post  ('/invoices',           requireAuth, requirePermission('facturacion','editar'), invoiceCtrl.createInvoice);
r.patch ('/invoices/:id/anular',requireAuth, requirePermission('facturacion','editar'), invoiceCtrl.voidInvoice);
r.get   ('/invoices/:id/pdf',   requireAuth, requirePermission('facturacion','ver'),    invoiceCtrl.downloadPdf);

// ── Dashboard ─────────────────────────────────────────────────────
r.get('/dashboard', requireAuth, requirePermission('dashboard','ver'), getDashboard);

module.exports = r;
