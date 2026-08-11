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
  Product, ProductVariant, Sale, SaleItem, StockMovement, Invoice, InvoiceItem,
} = require('../src/models');

const DEMO_EMAIL = 'demo@stocker.app';
const DEMO_PASSWORD = 'Demo2026!!';

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[rand(0, arr.length - 1)];
const round2 = (n) => Math.round(n * 100) / 100;

async function reset() {
  const existente = await Business.findOne({ where: { email: DEMO_EMAIL } });
  if (!existente) return;
  console.log('→ Borrando negocio demo anterior…');
  // Orden por dependencias de FK: primero lo que referencia, después lo referenciado.
  const products = await Product.findAll({ where: { businessId: existente.id } });
  const productIds = products.map((p) => p.id);
  const variants = productIds.length ? await ProductVariant.findAll({ where: { productId: productIds } }) : [];
  const variantIds = variants.map((v) => v.id);

  const sales = await Sale.findAll({ where: { businessId: existente.id } });
  const saleIds = sales.map((s) => s.id);
  const invoices = await Invoice.findAll({ where: { businessId: existente.id } });
  const invoiceIds = invoices.map((i) => i.id);

  if (invoiceIds.length) await InvoiceItem.destroy({ where: { invoiceId: invoiceIds } });
  await Invoice.destroy({ where: { businessId: existente.id } });
  if (saleIds.length) await SaleItem.destroy({ where: { saleId: saleIds } });
  await Sale.destroy({ where: { businessId: existente.id } });
  if (variantIds.length) await StockMovement.destroy({ where: { productVariantId: variantIds } });
  if (productIds.length) await ProductVariant.destroy({ where: { productId: productIds } });
  await Product.destroy({ where: { businessId: existente.id } });
  await Employee.destroy({ where: { businessId: existente.id } });
  await Client.destroy({ where: { businessId: existente.id } });
  await BusinessCuit.destroy({ where: { businessId: existente.id } });
  await BusinessLocation.destroy({ where: { businessId: existente.id } });
  await Role.destroy({ where: { businessId: existente.id } });
  await existente.destroy();
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
    cuit: '20345678901',
    telefono: '11 4555-2231',
    ownerTelefono: '11 6644-8890',
    email: DEMO_EMAIL,
    passwordHash,
  });

  await BusinessCuit.create({
    businessId: business.id, nombre: business.nombreNegocio, cuit: business.cuit, esPrincipal: true,
  });

  await Role.bulkCreate([
    { businessId: business.id, nombre: 'Administrador', permisos: { stock:'editar', ventas:'editar', facturacion:'editar', empleados:'editar', dashboard:'editar', cotizaciones:'editar' } },
    { businessId: business.id, nombre: 'Vendedor', permisos: { stock:'ver', ventas:'editar', facturacion:'ver', empleados:'ninguno', dashboard:'ver', cotizaciones:'editar' } },
  ]);
  const rolVendedor = await Role.findOne({ where: { businessId: business.id, nombre: 'Vendedor' } });

  console.log('→ Creando locales…');
  const locales = await BusinessLocation.bulkCreate([
    { businessId: business.id, nombre: 'Local Palermo', direccion: 'Av. Santa Fe 3421, CABA', telefono: '11 4555-2231' },
    { businessId: business.id, nombre: 'Local Belgrano', direccion: 'Av. Cabildo 1876, CABA', telefono: '11 4555-9087' },
    { businessId: business.id, nombre: 'Online / Envíos', direccion: 'Envíos a domicilio', telefono: business.telefono },
  ], { returning: true });

  console.log('→ Creando empleados…');
  const empPass = await bcrypt.hash('Vendedor2026!', 10);
  const empleados = await Employee.bulkCreate([
    { businessId: business.id, roleId: rolVendedor.id, locationId: locales[0].id, dni: '38221109', nombre: 'Camila', apellido: 'Souza', email: 'camila@boutiquealmendra.demo', passwordHash: empPass, activo: true },
    { businessId: business.id, roleId: rolVendedor.id, locationId: locales[1].id, dni: '37845210', nombre: 'Nicolás', apellido: 'Paredes', email: 'nicolas@boutiquealmendra.demo', passwordHash: empPass, activo: true },
    { businessId: business.id, roleId: rolVendedor.id, locationId: locales[0].id, dni: '40112365', nombre: 'Ayelén', apellido: 'Gómez', email: 'ayelen@boutiquealmendra.demo', passwordHash: empPass, activo: true },
  ], { returning: true });

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
        const colorAbrev = color.replace(/\s/g, '').toUpperCase().slice(0, 6);
        const talleAbrev = String(talle).replace(/\s/g, '').toUpperCase().slice(0, 4);
        const suf = `${colorAbrev}${talleAbrev}`;
        const stockInicial = rand(4, 40);
        const variant = await ProductVariant.create({
          productId: product.id,
          sku: `${skuBase}-${suf}`,
          codigoBarras: `779${String(rand(1000000, 9999999))}`,
          variante1Nombre: 'Color', variante1Valor: color,
          variante2Nombre: 'Talle', variante2Valor: talle,
          stock: stockInicial, stockMinimo: 5,
        });
        variantesCreadas.push({ variant, product, categoria: c.categoria });
      }
    }
  }
  console.log(`  ${catalogo.length} productos, ${variantesCreadas.length} variantes.`);

  console.log('→ Generando 12 meses de ventas…');
  // Estacionalidad simple: más ventas en los últimos 2 meses (efecto "creciendo"),
  // caída leve en enero/febrero (temporada baja típica de indumentaria en AR).
  const hoy = new Date();
  const mediosPago = ['Efectivo', 'Débito', 'Crédito', 'Transferencia', 'QR / Billetera'];
  let numeroVenta = 1;
  let totalVentas = 0, totalUnidades = 0;

  for (let mesesAtras = 11; mesesAtras >= 0; mesesAtras--) {
    const fechaBase = new Date(hoy.getFullYear(), hoy.getMonth() - mesesAtras, 1);
    const mesNum = fechaBase.getMonth(); // 0=ene
    const esBaja = mesNum === 0 || mesNum === 1; // ene/feb
    const esPico = mesesAtras <= 1; // últimos 2 meses: negocio "creciendo"
    const ventasDelMes = esBaja ? rand(14, 20) : esPico ? rand(34, 44) : rand(22, 32);

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
      const local = pick(locales);
      const empleado = pick(empleados);
      const conCliente = Math.random() < 0.55;
      const cliente = conCliente ? pick(clientes) : null;
      const estado = Math.random() < 0.94 ? 'pagado' : 'pendiente'; // casi todo cobrado

      let subtotal = 0;
      const itemsPayload = [];
      for (const { variant, product } of itemsSeleccionados) {
        const cantidad = rand(1, 2);
        const precioUnitario = esMayorista ? Number(product.precioMayorista) : Number(product.precioMinorista);
        const itemSubtotal = round2(precioUnitario * cantidad);
        subtotal += itemSubtotal;
        itemsPayload.push({
          productVariantId: variant.id,
          titulo: product.titulo, sku: variant.sku, skuAgrupador: product.skuAgrupador,
          variante1Nombre: variant.variante1Nombre, variante1Valor: variant.variante1Valor,
          variante2Nombre: variant.variante2Nombre, variante2Valor: variant.variante2Valor,
          cantidad, precioUnitario, subtotal: itemSubtotal, esMayorista,
        });
      }

      const numero = `V-${String(numeroVenta++).padStart(6, '0')}`;
      const sale = await Sale.create({
        businessId: business.id,
        locationId: local.id,
        employeeId: empleado.id,
        clientId: cliente?.id || null,
        numero, tipo: 'venta', estado,
        esMayorista,
        subtotal: round2(subtotal),
        descuentoPct: 0, descuento: 0,
        total: round2(subtotal),
        medioPago: pick(mediosPago),
        fecha: fechaStr,
      });
      await SaleItem.bulkCreate(itemsPayload.map((it) => ({ ...it, saleId: sale.id })));

      totalVentas += subtotal;
      totalUnidades += itemsPayload.reduce((s, i) => s + i.cantidad, 0);
    }
  }

  console.log(`  ${numeroVenta - 1} ventas generadas · $${Math.round(totalVentas).toLocaleString('es-AR')} facturado · ${totalUnidades} unidades.`);

  console.log('\n✔ Negocio demo listo.\n');
  console.log('─────────────────────────────────────────');
  console.log(`  Negocio:     ${business.nombreNegocio}`);
  console.log(`  Email:       ${DEMO_EMAIL}`);
  console.log(`  Contraseña:  ${DEMO_PASSWORD}`);
  console.log('─────────────────────────────────────────');
  console.log('  (Es el login de dueño — entra directo, sin selector de empleado.)');
}

seed()
  .then(() => process.exit(0))
  .catch((err) => { console.error('✖ Error generando el demo:', err); process.exit(1); });
