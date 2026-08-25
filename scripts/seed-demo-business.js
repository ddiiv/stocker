/*
 * Crea un negocio de demostración con historial de ~12 meses para mostrar
 * a clientes potenciales. No toca ningún negocio existente: todo cuelga de
 * un Business nuevo (email fijo, se puede rerun borrando antes con --reset).
 *
 * Uso:
 *   node scripts/seed-demo-business.js
 *   node scripts/seed-demo-business.js --reset   (borra el demo anterior y lo recrea)
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const {
  db, Business, BusinessCuit, BusinessLocation, Role, Employee, Client,
  Product, ProductVariant, VariantStock, Sale, SaleItem, SalePayment,
  StockMovement, Invoice, InvoiceItem, PaymentMethod, CashShift, CashMovement,
  ClientAccountEntry, VariantType, BusinessArcaConfig, Subscription,
  SubscriptionPayment, MercadoLibreAccount, MercadoLibreLink,
  StockIngreso, StockIngresoItem, PedidoReposicion, PedidoReposicionItem,
} = require('../src/models');
const skuService = require('../src/services/skuService');
const { PRESETS } = require('../src/config/permisos');

const DEMO_EMAIL = 'demo@stocker.app';
const DEMO_PASSWORD = 'Demo2026!!';
const EMPLEADO_PASSWORD = 'Vendedor2026!';
// Meses de historia. Dos años para que la comparación interanual tenga sentido.
const MESES_HISTORIA = 24;

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[rand(0, arr.length - 1)];
const round2 = (n) => Math.round(n * 100) / 100;

/*
 * Borra el demo anterior por completo.
 *
 * La lista es larga a propósito: cada tabla que cuelga del negocio tiene que
 * estar. Una que falte deja filas huérfanas apuntando a un negocio que ya no
 * existe, y eso no se nota hasta que una consulta las trae y muestra datos de
 * un demo viejo mezclados con el nuevo.
 *
 * El orden es por dependencia de claves foráneas: primero lo que referencia,
 * después lo referenciado.
 */
async function reset() {
  const existente = await Business.findOne({ where: { email: DEMO_EMAIL } });
  if (!existente) return;
  const id = existente.id;
  console.log(`→ Borrando negocio demo anterior (id ${id})…`);

  const products = await Product.findAll({ where: { businessId: id }, attributes: ['id'] });
  const productIds = products.map((p) => p.id);
  const variants = productIds.length
    ? await ProductVariant.findAll({ where: { productId: productIds }, attributes: ['id'] })
    : [];
  const variantIds = variants.map((v) => v.id);

  const sales = await Sale.findAll({ where: { businessId: id }, attributes: ['id'] });
  const saleIds = sales.map((s) => s.id);
  const invoices = await Invoice.findAll({ where: { businessId: id }, attributes: ['id'] });
  const invoiceIds = invoices.map((i) => i.id);
  const turnos = await CashShift.findAll({ where: { businessId: id }, attributes: ['id'] });
  const turnoIds = turnos.map((t) => t.id);
  const cuits = await BusinessCuit.findAll({ where: { businessId: id }, attributes: ['id'] });
  const subs = await Subscription.findAll({ where: { businessId: id }, attributes: ['id'] });

  if (invoiceIds.length) await InvoiceItem.destroy({ where: { invoiceId: invoiceIds } });
  await Invoice.destroy({ where: { businessId: id } });

  /*
   * Los movimientos de cuenta corriente y de caja apuntan a la venta, así que
   * se van antes que ella. Al revés, SQL Server rechaza el DELETE por la clave
   * foránea y el borrado queda a medias.
   */
  await ClientAccountEntry.destroy({ where: { businessId: id } });
  if (turnoIds.length) await CashMovement.destroy({ where: { cashShiftId: turnoIds } });
  await CashShift.destroy({ where: { businessId: id } });

  if (saleIds.length) {
    await SalePayment.destroy({ where: { saleId: saleIds } });
    await SaleItem.destroy({ where: { saleId: saleIds } });
  }
  await Sale.destroy({ where: { businessId: id } });

  /*
   * Los documentos del circuito depósito → local.
   *
   * Van antes que las variantes, los locales y los empleados: sus items
   * apuntan a `product_variants` y las cabeceras a `business_locations`, así
   * que borrar primero aquéllas deja el DELETE frenado por la clave foránea y
   * el reset a medias.
   *
   * Y los ingresos antes que los pedidos, porque un ingreso puede haber nacido
   * para cubrir un pedido y lo referencia.
   */
  const ingresos = await StockIngreso.findAll({ where: { businessId: id }, attributes: ['id'] });
  if (ingresos.length) {
    await StockIngresoItem.destroy({ where: { ingresoId: ingresos.map((i) => i.id) } });
    await StockIngreso.destroy({ where: { businessId: id } });
  }
  const pedidos = await PedidoReposicion.findAll({ where: { businessId: id }, attributes: ['id'] });
  if (pedidos.length) {
    await PedidoReposicionItem.destroy({ where: { pedidoId: pedidos.map((p) => p.id) } });
    await PedidoReposicion.destroy({ where: { businessId: id } });
  }

  if (variantIds.length) {
    await StockMovement.destroy({ where: { productVariantId: variantIds } });
    await VariantStock.destroy({ where: { productVariantId: variantIds } });
    await MercadoLibreLink.destroy({ where: { businessId: id } }).catch(() => {});
    await ProductVariant.destroy({ where: { id: variantIds } });
  }
  await Product.destroy({ where: { businessId: id } });

  if (subs.length) await SubscriptionPayment.destroy({ where: { subscriptionId: subs.map((x) => x.id) } });
  await Subscription.destroy({ where: { businessId: id } });
  if (cuits.length) await BusinessArcaConfig.destroy({ where: { businessCuitId: cuits.map((c) => c.id) } });
  await BusinessArcaConfig.destroy({ where: { businessId: id } }).catch(() => {});
  await MercadoLibreAccount.destroy({ where: { businessId: id } }).catch(() => {});
  await PaymentMethod.destroy({ where: { businessId: id } });
  await VariantType.destroy({ where: { businessId: id } });
  await Employee.destroy({ where: { businessId: id } });
  await Client.destroy({ where: { businessId: id } });
  await BusinessCuit.destroy({ where: { businessId: id } });
  await BusinessLocation.destroy({ where: { businessId: id } });
  await Role.destroy({ where: { businessId: id } });
  await existente.destroy();
  console.log('  listo.');
}

async function seed() {
  if (process.argv.includes('--reset')) await reset();

  const existente = await Business.findOne({ where: { email: DEMO_EMAIL } });
  if (existente) {
    console.log(`Ya existe un negocio demo (id ${existente.id}). Corré con --reset para recrearlo.`);
    console.log(`\nCredenciales:\n  Email: ${DEMO_EMAIL}\n  Contraseña: ${DEMO_PASSWORD}`);
    return;
  }

  console.log('→ Creando negocio…');
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const business = await Business.create({
    nombreNegocio: 'Boutique Almendra',
    ownerNombre: 'Julieta',
    ownerApellido: 'Fernández',
    // CUIT con dígito verificador correcto: el demo tiene que poder emitir
    // facturas de prueba sin que ARCA lo rechace por el formato.
    cuit: '20345678906',
    telefono: '11 4555-2231',
    ownerTelefono: '11 6644-8890',
    email: DEMO_EMAIL,
    passwordHash,
  });

  await BusinessCuit.create({
    businessId: business.id, nombre: business.nombreNegocio, cuit: business.cuit, esPrincipal: true,
  });

  /*
   * Los cargos salen de PRESETS, que es la lista que usa el alta de cualquier
   * negocio. Antes estaban escritos a mano acá y quedaron viejos: al sumarse
   * los módulos del circuito depósito → local, el demo mostraba cargos sin
   * esos permisos y el circuito no se podía recorrer con un empleado.
   */
  const roles = await Role.bulkCreate(
    Object.entries(PRESETS).map(([nombre, permisos]) => ({ businessId: business.id, nombre, permisos })),
    { returning: true },
  );
  const rolVendedor = roles.find((r) => r.nombre === 'Vendedor');
  const rolAdmin = roles.find((r) => r.nombre === 'Administrador');
  const rolDeposito = roles.find((r) => r.nombre === 'Depósito');

  console.log('→ Creando locales…');
  const locales = await BusinessLocation.bulkCreate([
    { businessId: business.id, nombre: 'Local Palermo', direccion: 'Av. Santa Fe 3421, CABA', telefono: '11 4555-2231' },
    { businessId: business.id, nombre: 'Local Belgrano', direccion: 'Av. Cabildo 1876, CABA', telefono: '11 4555-9087' },
    { businessId: business.id, nombre: 'Online / Envíos', direccion: 'Envíos a domicilio', telefono: business.telefono },
    /*
     * El depósito, que es de donde sale todo.
     *
     * Va último a propósito: `locales[0..2]` son los locales de venta y varias
     * partes del seed reparten stock por índice. Un depósito metido en el medio
     * les daría mercadería de salón a la bodega.
     */
    { businessId: business.id, nombre: 'Depósito Central', direccion: 'Av. Warnes 1200, CABA', telefono: business.telefono, tipo: 'deposito' },
  ], { returning: true });
  const deposito = locales[3];

  console.log('→ Creando empleados…');
  const empPass = await bcrypt.hash(EMPLEADO_PASSWORD, 10);
  const empleados = await Employee.bulkCreate([
    { businessId: business.id, roleId: rolVendedor.id, locationId: locales[0].id, dni: '38221109', nombre: 'Camila', apellido: 'Souza', email: 'camila@boutiquealmendra.demo', passwordHash: empPass, activo: true },
    { businessId: business.id, roleId: rolVendedor.id, locationId: locales[1].id, dni: '37845210', nombre: 'Nicolás', apellido: 'Paredes', email: 'nicolas@boutiquealmendra.demo', passwordHash: empPass, activo: true },
    // Ayelén es administradora: el demo tiene que mostrar los dos niveles de
    // permiso, no tres vendedores iguales.
    { businessId: business.id, roleId: rolAdmin.id, locationId: locales[2].id, dni: '40112365', nombre: 'Ayelén', apellido: 'Gómez', email: 'ayelen@boutiquealmendra.demo', passwordHash: empPass, activo: true },
    // Del depósito: ingresa mercadería y prepara los envíos, no vende ni aprueba.
    { businessId: business.id, roleId: rolDeposito.id, locationId: deposito.id, dni: '35990412', nombre: 'Martín', apellido: 'Quiroga', email: 'martin@boutiquealmendra.demo', passwordHash: empPass, activo: true },
  ], { returning: true });

  console.log('→ Creando medios de pago…');
  /*
   * Se crean acá y no se dejan al arranque del servidor porque las ventas del
   * historial referencian su id: sin ellos, las ventas quedarían sin líneas de
   * pago y los filtros por medio de pago no tendrían nada que mostrar.
   */
  const medios = await PaymentMethod.bulkCreate([
    { businessId: business.id, nombre: 'Efectivo',       ajustePct: 0,  esEfectivo: true,  activo: true, orden: 1 },
    { businessId: business.id, nombre: 'Débito',         ajustePct: 0,  esEfectivo: false, activo: true, orden: 2 },
    { businessId: business.id, nombre: 'Crédito',        ajustePct: 10, esEfectivo: false, activo: true, orden: 3 },
    { businessId: business.id, nombre: 'Transferencia',  ajustePct: 0,  esEfectivo: false, activo: true, orden: 4 },
    { businessId: business.id, nombre: 'QR / Billetera', ajustePct: 0,  esEfectivo: false, activo: true, orden: 5 },
  ], { returning: true });

  console.log('→ Creando variantes maestras…');
  // Color y Talle con los valores que usa el catálogo: son los que alimentan la
  // pantalla de confección de SKU.
  await VariantType.bulkCreate([
    /*
     * Los valores que el catálogo usa de verdad, incluidos los compuestos.
     *
     * Faltaban "Azul Claro", "Azul Oscuro" y "Verde Militar", que sí tienen
     * variantes: sin ellos en la maestra, agregarle un talle a la Campera Denim
     * desde la tabla no era posible y había que cargarlo a mano. Son además los
     * que hacen falta para que las abreviaturas de más abajo se entiendan.
     */
    { businessId: business.id, nombre: 'Color', valores: ['Blanco','Negro','Beige','Azul','Azul Claro','Azul Oscuro','Camel','Gris','Verde','Verde Militar','Bordo','Rosa','Floral'] },
    { businessId: business.id, nombre: 'Talle', valores: ['S','M','L','XL','36','38','40','42'] },
  ]);

  console.log('→ Creando clientes…');
  const nombresCli = [
    ['Martina', 'López'], ['Sofía', 'Ramírez'], ['Valentina', 'Torres'], ['Lucía', 'Fernández'],
    ['Catalina', 'Díaz'], ['Emilia', 'Morales'], ['Renata', 'Suárez'], ['Delfina', 'Herrera'],
    ['Agustina', 'Rojas'], ['Pilar', 'Molina'],
  ];
  const clientes = await Client.bulkCreate(nombresCli.map(([nombre, apellido], i) => ({
    businessId: business.id, nombre, apellido,
    email: `${nombre.toLowerCase()}.${apellido.toLowerCase()}@mail.demo`,
    telefono: `11 ${rand(4000,4900)}-${rand(1000,9999)}`,
    dni: String(rand(30000000, 42000000)),
    tipo: i % 4 === 0 ? 'mayorista' : 'minorista',
  })), { returning: true });

  console.log('→ Creando catálogo de productos…');
  // Catálogo de indumentaria femenina — categorías variadas, cada una con
  // 2 dimensiones de variante (color x talle) para que el escaneo y las
  // métricas por variante tengan algo real que mostrar.
  const catalogo = [
    { titulo: 'Remera Oversize Algodón', categoria: 'Remeras', costo: 4200, minorista: 12900, mayorista: 9800, colores: ['Blanco','Negro','Beige'], talles: ['S','M','L'] },
    { titulo: 'Jean Mom Fit Tiro Alto', categoria: 'Jeans', costo: 9800, minorista: 28900, mayorista: 22500, colores: ['Azul','Negro'], talles: ['36','38','40','42'] },
    { titulo: 'Sweater Cuello Redondo', categoria: 'Sweaters', costo: 7100, minorista: 21900, mayorista: 16800, colores: ['Camel','Gris','Verde'], talles: ['S','M','L'] },
    { titulo: 'Vestido Midi Estampado', categoria: 'Vestidos', costo: 8600, minorista: 26900, mayorista: 20900, colores: ['Floral','Liso Negro'], talles: ['S','M','L'] },
    { titulo: 'Campera Denim Oversize', categoria: 'Camperas', costo: 14200, minorista: 39900, mayorista: 31500, colores: ['Azul Claro','Azul Oscuro'], talles: ['S','M','L'] },
    { titulo: 'Pollera Plisada Satinada', categoria: 'Polleras', costo: 6300, minorista: 19900, mayorista: 15200, colores: ['Negro','Bordo'], talles: ['S','M','L'] },
    { titulo: 'Top Corset Espalda Cruzada', categoria: 'Tops', costo: 3800, minorista: 11900, mayorista: 8900, colores: ['Blanco','Negro','Rosa'], talles: ['S','M','L'] },
    { titulo: 'Pantalón Cargo Wide Leg', categoria: 'Pantalones', costo: 8900, minorista: 25900, mayorista: 19900, colores: ['Verde Militar','Negro'], talles: ['36','38','40'] },
    { titulo: 'Musculosa Canesú Ribb', categoria: 'Musculosas', costo: 2600, minorista: 8900, mayorista: 6500, colores: ['Blanco','Negro','Gris'], talles: ['S','M','L'] },
    { titulo: 'Buzo Canguro Oversize', categoria: 'Buzos', costo: 8100, minorista: 24900, mayorista: 18900, colores: ['Beige','Negro','Verde'], talles: ['S','M','L'] },
  ];

  /*
   * La regla de SKU del negocio, la misma con la que la aplicación arma los
   * códigos: así el demo no queda con dos formatos distintos conviviendo.
   *
   * Las abreviaturas no son decorado: "Azul Claro" y "Azul Oscuro" dan las dos
   * AZU con tres letras, y sin excepción sus seis variantes chocarían. Es
   * además el caso que hace entender para qué sirve la pantalla de confección.
   */
  await skuService.guardarRegla(business.id, {
    abreviaturas: { Color: { 'Azul Claro': 'AZC', 'Azul Oscuro': 'AZO', 'Verde Militar': 'VMI' } },
  });
  const regla = await skuService.reglaDe(business.id);

  const variantesCreadas = []; // { variant, product, categoria }
  for (let i = 0; i < catalogo.length; i++) {
    const c = catalogo[i];
    const skuBase = `BA-${String(i + 1).padStart(3, '0')}`;
    const skuAgrupador = skuBase;
    const product = await Product.create({
      businessId: business.id,
      sku: skuBase, skuAgrupador,
      titulo: c.titulo,
      descripcion: `${c.titulo} — colección temporada.`,
      precioMinorista: c.minorista, precioMayorista: c.mayorista, costo: c.costo,
      variantes: { Color: c.colores, Talle: c.talles },
      categoria: c.categoria, genero: 'Mujer',
      fechaActualizacion: new Date(),
    });

    for (const color of c.colores) {
      for (const talle of c.talles) {
        // Truncar color y talle por separado (no la concatenación) para que
        // combinaciones largas no colapsen al mismo sufijo, ej. "Azul OscuroS"
        // y "Azul OscuroM" perdiendo la letra de talle al cortar a 10 chars.
        /*
         * El SKU lo arma la misma regla del negocio que usa la aplicación.
         *
         * Antes se abreviaba acá con otra fórmula (6 letras del color, 4 del
         * talle) y salía BA-010-BEIGEM, mientras que cualquier variante creada
         * después desde la pantalla salía BA-010-BEIM, con las 3 letras que
         * manda la regla. Dos formatos conviviendo dentro del mismo producto
         * hacen dudar de cuál es el correcto justo en el dato que se lee del
         * código de barras.
         */
        const skuVariante = await skuService.liberar(business.id, skuService.componer({
          agrupador: skuAgrupador,
          valores: [{ eje: 'Color', valor: color }, { eje: 'Talle', valor: talle }],
          regla,
        }));
        /*
         * Nace en cero: el stock entra después, repartido por local y con su
         * movimiento de ingreso. Ponerlo acá dejaría el total con un número y
         * `variant_stocks` vacío, o sea el total diciendo una cosa y la suma de
         * los locales otra.
         */
        const variant = await ProductVariant.create({
          productId: product.id,
          businessId: business.id,
          sku: skuVariante,
          codigoBarras: `779${String(rand(1000000, 9999999))}`,
          variante1Nombre: 'Color', variante1Valor: color,
          variante2Nombre: 'Talle', variante2Valor: talle,
          stock: 0, stockMinimo: 5,
        });
        variantesCreadas.push({ variant, product, categoria: c.categoria });
      }
    }
  }
  console.log(`  ${catalogo.length} productos, ${variantesCreadas.length} variantes.`);

  /*
   * ── Stock inicial repartido por local ──
   *
   * Todo se calcula en memoria y se inserta al final en bloque. Pasar por
   * stockService variante por variante serían miles de consultas —una lectura,
   * una escritura y un recálculo por cada una— y el seed tardaría minutos.
   *
   * El reparto es desparejo a propósito: Palermo es el local grande, Belgrano
   * la mitad, y Online un stock chico de reposición. Un demo con el mismo
   * número en los tres locales no muestra el problema que el stock por local
   * viene a resolver: que la prenda esté en la sucursal equivocada.
   */
  console.log('→ Repartiendo stock inicial entre los locales y el depósito…');
  /*
   * Los pesos son de los LOCALES DE VENTA, no de todos los lugares.
   *
   * El depósito se carga aparte y con su propia cantidad: no es un local más
   * que se lleva una tajada de la góndola, es la reserva de la que después
   * salen las reposiciones. Cuando esto recorría `locales` entero, los tres
   * pesos sumaban 1 y al depósito —que quedó último— le tocaba el resto, o
   * sea cero: el circuito de reposición no se podía ni probar porque no había
   * nada que mandar.
   */
  const deVenta = locales.filter((l) => l.tipo !== 'deposito');
  const PESO = [0.55, 0.32, 0.13];   // Palermo · Belgrano · Online
  // Anterior a la primera venta: el inventario existía antes de venderse.
  const inicioHistoria = new Date(); inicioHistoria.setMonth(inicioHistoria.getMonth() - MESES_HISTORIA - 1);

  // variantId → { locationId → unidades }
  const stockMem = new Map();
  const movimientos = [];

  const anotarIngreso = (variantId, locationId, n, motivo) => {
    if (n <= 0) return;
    movimientos.push({
      productVariantId: variantId, locationId, employeeId: null,
      tipo: 'ingreso', cantidad: n, stockAnterior: 0, stockNuevo: n,
      motivo, fechaMovimiento: inicioHistoria,
    });
  };

  for (const { variant } of variantesCreadas) {
    const total = rand(6, 45);
    const porLocal = new Map();
    let repartido = 0;
    deVenta.forEach((l, i) => {
      // El último se lleva el resto, así no se pierden unidades por redondeo y
      // la suma da exactamente el total.
      const n = i === deVenta.length - 1 ? total - repartido : Math.round(total * PESO[i]);
      repartido += n;
      porLocal.set(l.id, n);
      anotarIngreso(variant.id, l.id, n, 'Carga inicial de inventario');
    });

    // La reserva del depósito: más que cualquier local suelto, que es lo que
    // hace que tenga sentido pedirle reposición.
    const enDeposito = rand(8, 60);
    porLocal.set(deposito.id, enDeposito);
    anotarIngreso(variant.id, deposito.id, enDeposito, 'Ingreso de mercadería al depósito');

    stockMem.set(variant.id, porLocal);
  }

  console.log(`→ Generando ${MESES_HISTORIA} meses de ventas…`);
  // Estacionalidad simple: más ventas en los últimos 2 meses (efecto "creciendo"),
  // caída leve en enero/febrero (temporada baja típica de indumentaria en AR).
  const hoy = new Date();
  let numeroVenta = 1;
  let totalVentas = 0, totalUnidades = 0;

  /*
   * Dos años de historia.
   *
   * Con doce meses la comparación interanual —el mismo mes del año pasado, que
   * en indumentaria dice más que el mes contra mes— no tiene contra qué
   * comparar y el panel muestra guiones. Con veinticuatro se puede ver.
   */
  const crecimientoAnual = 1.35;   // el negocio creció un tercio de un año al otro

  for (let mesesAtras = MESES_HISTORIA - 1; mesesAtras >= 0; mesesAtras--) {
    const fechaBase = new Date(hoy.getFullYear(), hoy.getMonth() - mesesAtras, 1);
    const mesNum = fechaBase.getMonth(); // 0=ene
    const esBaja = mesNum === 0 || mesNum === 1; // ene/feb
    const esPico = mesesAtras <= 1; // últimos 2 meses: negocio "creciendo"
    const base = esBaja ? rand(14, 20) : esPico ? rand(34, 44) : rand(22, 32);
    // El año anterior vendía menos: es lo que hace que la comparación
    // interanual muestre crecimiento en vez de ruido.
    const ventasDelMes = mesesAtras >= 12 ? Math.max(6, Math.round(base / crecimientoAnual)) : base;

    for (let v = 0; v < ventasDelMes; v++) {
      const dia = rand(1, 27);
      const fecha = new Date(fechaBase.getFullYear(), fechaBase.getMonth(), dia);
      // No generamos ventas a futuro
      if (fecha > hoy) continue;
      const fechaStr = fecha.toISOString().slice(0, 10);

      const cantItems = rand(1, 3);
      const itemsSeleccionados = [];
      for (let k = 0; k < cantItems; k++) itemsSeleccionados.push(pick(variantesCreadas));

      const cantidadTotal = itemsSeleccionados.reduce((s) => s + rand(1, 2), 0);
      const esMayorista = cantidadTotal >= 3;
      /*
       * La venta sale de un local de venta, nunca del depósito.
       *
       * Cuando esto elegía sobre `locales` entero, un cuarto de las ventas del
       * demo salían de la bodega —justo lo que el sistema ahora prohíbe— y el
       * análisis por local mostraba al depósito facturando.
       */
      const local = pick(deVenta);
      const empleado = pick(empleados);
      const conCliente = Math.random() < 0.55;
      const cliente = conCliente ? pick(clientes) : null;
      const estado = Math.random() < 0.94 ? 'pagado' : 'pendiente'; // casi todo cobrado

      let subtotal = 0;
      const itemsPayload = [];
      for (const { variant, product } of itemsSeleccionados) {
        /*
         * La venta sale del stock DEL LOCAL donde se hizo.
         *
         * Si en ese local no hay, el ítem se saltea en lugar de dejar el stock
         * en negativo: es lo mismo que hace el sistema en producción, y un demo
         * con stock negativo no se puede mostrar.
         */
        const enLocal = stockMem.get(variant.id)?.get(local.id) || 0;
        if (enLocal <= 0) continue;

        const cantidad = Math.min(rand(1, 2), enLocal);
        const precioUnitario = esMayorista ? Number(product.precioMayorista) : Number(product.precioMinorista);
        const itemSubtotal = round2(precioUnitario * cantidad);
        subtotal += itemSubtotal;
        itemsPayload.push({
          productVariantId: variant.id,
          titulo: product.titulo, sku: variant.sku, skuAgrupador: product.skuAgrupador,
          variante1Nombre: variant.variante1Nombre, variante1Valor: variant.variante1Valor,
          variante2Nombre: variant.variante2Nombre, variante2Valor: variant.variante2Valor,
          cantidad, precioUnitario, subtotal: itemSubtotal, esMayorista,
          // Se guarda para poder armar el movimiento con el stock antes y
          // después, que es lo que muestra el libro.
          _antes: enLocal,
        });
        stockMem.get(variant.id).set(local.id, enLocal - cantidad);
      }

      // Una venta sin ítems —porque no había stock de ninguno en ese local— no
      // se registra: sería una venta de nada.
      if (!itemsPayload.length) continue;

      const numero = `V-${String(numeroVenta++).padStart(6, '0')}`;
      const medio = pick(medios);
      const cobrada = estado === 'pagado';
      const total = round2(subtotal);
      // El recargo del medio de pago se cobra además del precio de lista.
      const recargo = cobrada ? round2(total * (Number(medio.ajustePct) || 0) / 100) : 0;

      const sale = await Sale.create({
        businessId: business.id,
        locationId: local.id,
        employeeId: empleado.id,
        clientId: cliente?.id || null,
        numero, tipo: 'venta', estado,
        esMayorista,
        subtotal: total,
        descuentoPct: 0, descuento: 0,
        total,
        medioPago: medio.nombre,
        // Campos que llegaron con las ventas fiadas y los medios de pago: se
        // dejan coherentes desde el principio en vez de esperar al relleno del
        // arranque, que sólo completa lo que encuentra en NULL.
        condicionPago: 'contado',
        recargoPagos: recargo,
        totalCobrado: cobrada ? round2(total + recargo) : 0,
        saldoPendiente: cobrada ? 0 : total,
        stockDescontado: true,
        cobradoEn: cobrada ? fecha : null,
        cobradoPorEmployeeId: cobrada ? empleado.id : null,
        fecha: fechaStr,
      });

      const items = await SaleItem.bulkCreate(
        itemsPayload.map(({ _antes, ...it }) => ({ ...it, saleId: sale.id })),
        { returning: true },
      );

      /*
       * La venta queda en el libro de movimientos, con su local y su vendedor.
       *
       * Es lo que permite reconstruir el día cuando falta mercadería: sin esto
       * el stock baja y no hay nada que explique por qué. `saleItemId` es
       * además lo que distingue una venta de una corrección de carga.
       */
      itemsPayload.forEach((it, k) => {
        movimientos.push({
          productVariantId: it.productVariantId,
          locationId: local.id,
          employeeId: empleado.id,
          saleItemId: items[k]?.id || null,
          tipo: 'egreso',
          cantidad: it.cantidad,
          stockAnterior: it._antes,
          stockNuevo: it._antes - it.cantidad,
          motivo: `Venta ${numero}`,
          fechaMovimiento: fecha,
        });
      });

      // Las líneas de pago: sin ellas los filtros por medio de pago no tienen
      // qué mostrar y las ventas figuran como si vinieran de un sistema viejo.
      if (cobrada) {
        await SalePayment.create({
          saleId: sale.id,
          paymentMethodId: medio.id,
          nombre: medio.nombre,
          monto: total,
          ajustePct: Number(medio.ajustePct) || 0,
          ajusteMonto: recargo,
          montoFinal: round2(total + recargo),
          esEfectivo: medio.esEfectivo,
        });
      }

      totalVentas += subtotal;
      totalUnidades += itemsPayload.reduce((s, i) => s + i.cantidad, 0);
    }
  }

  console.log(`  ${numeroVenta - 1} ventas generadas · $${Math.round(totalVentas).toLocaleString('es-AR')} facturado · ${totalUnidades} unidades.`);

  /*
   * ── Volcado del stock ──
   *
   * Recién acá se escribe: el stock que queda es el resultado real de la carga
   * inicial menos las ventas, no un número inventado. Por eso la suma de los
   * locales y el total de la variante coinciden por construcción y no por
   * casualidad.
   */
  console.log('→ Guardando stock por local y movimientos…');
  const filasStock = [];
  const totalesPorVariante = new Map();
  for (const [variantId, porLocal] of stockMem) {
    let total = 0;
    for (const [locationId, unidades] of porLocal) {
      total += unidades;
      // Sólo se guardan las combinaciones con historia: una fila en cero de un
      // local que nunca recibió esa prenda no aporta nada y multiplica la tabla
      // por la cantidad de locales.
      if (unidades > 0) {
        filasStock.push({ businessId: business.id, productVariantId: variantId, locationId, stock: unidades });
      }
    }
    totalesPorVariante.set(variantId, total);
  }

  await VariantStock.bulkCreate(filasStock);
  for (const [variantId, total] of totalesPorVariante) {
    await ProductVariant.update({ stock: total }, { where: { id: variantId } });
  }
  // En tandas: un solo bulkCreate de miles de filas hace un INSERT gigante que
  // SQL Server rechaza por cantidad de parámetros.
  for (let i = 0; i < movimientos.length; i += 500) {
    await StockMovement.bulkCreate(movimientos.slice(i, i + 500));
  }

  const stockFinal = [...totalesPorVariante.values()].reduce((a, b) => a + b, 0);
  console.log(`  ${filasStock.length} filas de stock · ${stockFinal} unidades en góndola · ${movimientos.length} movimientos.`);

  console.log('\n✔ Negocio demo listo.\n');
  console.log('═════════════════════════════════════════════════════════');
  console.log(`  ${business.nombreNegocio}  ·  CUIT ${business.cuit}`);
  console.log('═════════════════════════════════════════════════════════');
  console.log('  DUEÑA (pestaña "Dueño" del login)');
  console.log(`    Email:      ${DEMO_EMAIL}`);
  console.log(`    Contraseña: ${DEMO_PASSWORD}`);
  console.log('');
  console.log('  EMPLEADOS (pestaña "Empleado" del login)');
  /*
   * Se comprueban antes de imprimirlas.
   *
   * Un demo que se entrega con una contraseña que no entra es peor que no
   * entregarlo: la persona prueba, falla, y no sabe si es la clave o el
   * sistema. Pasó una vez —un empleado quedó con otro hash— y el listado se
   * imprimió igual, tan seguro como siempre.
   */
  for (const e of empleados) {
    const anda = e.passwordHash && await bcrypt.compare(EMPLEADO_PASSWORD, e.passwordHash);
    if (!anda) {
      console.log(`    ✖ ATENCIÓN: la contraseña de ${e.email} no valida. Revisá antes de entregar el demo.`);
    }
  }

  console.log(`    Contraseña de todos: ${EMPLEADO_PASSWORD}`);
  for (const e of empleados) {
    const rol = roles.find((r) => r.id === e.roleId)?.nombre || '—';
    const loc = locales.find((l) => l.id === e.locationId)?.nombre || 'sin local';
    console.log(`    ${(e.nombre + ' ' + e.apellido).padEnd(18)} ${e.email.padEnd(34)} ${rol.padEnd(14)} ${loc}`);
  }
  console.log('');
  console.log('  LOCALES');
  for (const l of locales) console.log(`    ${String(l.id).padStart(3)}  ${l.nombre}`);
  console.log('═════════════════════════════════════════════════════════');
}

seed()
  .then(() => process.exit(0))
  .catch((err) => { console.error('✖ Error generando el demo:', err); process.exit(1); });
