const { Op } = require('sequelize');
const { cuitValido, emailValido, normalizarCuit } = require('../utils/identificadores');
const { sanitizarPermisos } = require('../config/permisos');
const bcrypt = require('bcryptjs');
const { BusinessLocation, Role, Client, Sale, SaleItem, Invoice, ProductVariant, Product, StockMovement } = require('../models');
const reglaMayorista = require('../services/reglaMayoristaService');
const { TIPOS, NOMBRES } = require('../config/lugares');
const { ilikeOperator } = require('../utils/sqlHelpers');

/*
 * Toma del body sólo los campos permitidos.
 *
 * Los `update(req.body)` y los spreads `{ ...req.body }` dejan que el cliente
 * escriba cualquier columna del modelo, incluida businessId. Con eso, alguien
 * con permiso de edición puede mover un registro a otro negocio o pisar el
 * businessId que el servidor acababa de fijar. Ver informe QA F-02.
 */
function soloCampos(body, permitidos) {
  const patch = {};
  for (const campo of permitidos) {
    if (body?.[campo] !== undefined) patch[campo] = body[campo];
  }
  return patch;
}

const CAMPOS_LOCAL   = ['nombre', 'direccion', 'telefono', 'activo', 'tipo',
  // La regla de precio mayorista es propia de cada local. Ver reglaMayoristaService.
  'mayoristaModo', 'mayoristaCantidad', 'mayoristaMonto',
  // Si este local abastece lo que se vende por internet: su stock se publica y
  // de ahí se descuentan los pedidos online. Ver stockService.stockOnline.
  'abasteceOnline'];
const CAMPOS_CLIENTE = ['nombre', 'apellido', 'email', 'telefono', 'whatsapp',
  'cuit', 'dni', 'direccion', 'tipo', 'notas'];


// ─── LOCATIONS ────────────────────────────────────────────────────
const getLocations = async (req, res, next) => {
  try {
    const locs = await BusinessLocation.findAll({ where: { businessId: req.auth.businessId }, order: [['nombre', 'ASC']] });
    res.json(locs);
  } catch (e) { next(e); }
};
/*
 * Local o depósito, y nada más.
 *
 * Se valida acá porque de este campo cuelga todo el circuito: un tipo mal
 * escrito haría que el lugar no aparezca ni como local de venta ni como
 * depósito, y sería invisible en las dos pantallas a la vez.
 */
/*
 * Qué puede hacer cada tipo está en config/lugares.js, que es de donde salen
 * también los filtros de stock y reposición. Esta lista estaba escrita de nuevo
 * acá: dos copias de la misma verdad, y agregar un tipo obligaba a acordarse de
 * los dos lugares.
 */
const TIPOS_LOCAL = TIPOS;

/*
 * El error nombra los tipos como los ve el cliente.
 *
 * Devolver "local, deposito, online, feria" era mostrarle los valores crudos de
 * la base a alguien que en pantalla lee "Evento" y "Online / Envíos", y encima
 * filtra hacia afuera cómo están guardados.
 */
const tiposValidos = () => TIPOS_LOCAL.map((t) => NOMBRES[t] || t).join(', ');

const createLocation = async (req, res, next) => {
  try {
    const { nombre, direccion, telefono, tipo } = req.body;
    if (!nombre || !direccion) return res.status(400).json({ message: 'Nombre y dirección son obligatorios.' });
    const errRegla = reglaMayorista.validar(req.body);
    if (errRegla) return res.status(400).json({ message: errRegla });
    if (tipo && !TIPOS_LOCAL.includes(tipo)) {
      return res.status(400).json({ message: `El tipo tiene que ser uno de: ${tiposValidos()}.` });
    }

    /*
     * El tope de locales del plan, que nunca se controlaba.
     *
     * `maxLocales` se medía y se mostraba en la pantalla de suscripción, pero
     * ninguna ruta lo exigía: un plan de dos locales podía crear veinte. Es el
     * único de los cinco topes que estaba así, y como los depósitos y los
     * locales de evento también son locales, el agujero se agrandaba justo
     * ahora que esas funciones entran al plan.
     */
    const { exigirCupo } = require('../services/planService');
    await exigirCupo(req.auth.businessId, 'locales');

    const regla = reglaMayorista.normalizar(req.body);
    const loc = await BusinessLocation.create({
      businessId: req.auth.businessId, nombre, direccion, telefono, tipo: tipo || 'local',
      mayoristaModo: regla.modo, mayoristaCantidad: regla.cantidad, mayoristaMonto: regla.monto,
    });
    res.status(201).json(loc);
  } catch (e) { next(e); }
};
const updateLocation = async (req, res, next) => {
  try {
    const loc = await BusinessLocation.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!loc) return res.status(404).json({ message: 'Local no encontrado.' });

    const errRegla = reglaMayorista.validar({ ...loc.toJSON(), ...req.body });
    if (errRegla) return res.status(400).json({ message: errRegla });

    const { tipo } = req.body;
    if (tipo && !TIPOS_LOCAL.includes(tipo)) {
      return res.status(400).json({ message: `El tipo tiene que ser uno de: ${tiposValidos()}.` });
    }
    /*
     * Cambiar el tipo de un local que ya tiene operación NO es un cambio de
     * etiqueta, y hay que avisarlo antes.
     *
     * El aviso estaba sólo para `deposito`. Faltaba justo el caso peor: pasar
     * un local a `evento`. Un local de evento NO LLEVA STOCK por definición,
     * así que convertir uno que tiene mercadería cargada y ventas hechas lo
     * deja con un inventario que el sistema ya no va a mirar — sin una sola
     * advertencia, con un clic en un desplegable.
     *
     * Pasó de verdad, dos veces, sobre locales con ciento setenta ventas y
     * cuarenta y ocho artículos con stock. Se detectó porque las pruebas
     * empezaron a fallar; en la cuenta de un cliente no habría fallado nada:
     * simplemente el local dejaría de aparecer en Stock y nadie sabría por qué.
     *
     * Se pregunta por stock Y por ventas. Un local sin stock pero con historial
     * sigue siendo un cambio grande: sus ventas dejan de contarse como ventas
     * de local.
     */
    const CON_INVENTARIO = ['local', 'online', 'deposito'];
    const cambiaDeTipo = tipo && tipo !== loc.tipo;
    const dejaDeLlevarStock = cambiaDeTipo
      && CON_INVENTARIO.includes(loc.tipo)
      && (tipo === 'feria' || tipo === 'deposito');

    if (dejaDeLlevarStock && req.body.confirmar !== true) {
      const { VariantStock, Sale } = require('../models');
      const [conStock, ventas] = await Promise.all([
        VariantStock.count({ where: { locationId: loc.id, stock: { [Op.gt]: 0 } } }),
        Sale.count({ where: { locationId: loc.id } }),
      ]);

      if (conStock || ventas) {
        const nombreNuevo = NOMBRES[tipo] || tipo;
        const detalle = [
          conStock ? `${conStock} artículo(s) con stock` : null,
          ventas ? `${ventas} venta(s) registrada(s)` : null,
        ].filter(Boolean).join(' y ');

        return res.status(409).json({
          message: `"${loc.nombre}" tiene ${detalle}. `
            + (tipo === 'feria'
              ? `Un local de ${nombreNuevo} no lleva inventario: si lo convertís, ese stock deja de contarse `
                + 'y el local desaparece de Stock y de Reposición.'
              : 'Desde un depósito no se vende: la mercadería queda ahí y sale por transferencia.')
            + ' Confirmá si querés convertirlo igual.',
          codigo: 'LOCAL_CON_OPERACION',
          articulos: conStock,
          ventas,
        });
      }
    }

    await loc.update(soloCampos(req.body, CAMPOS_LOCAL));
    res.json(loc);
  } catch (e) { next(e); }
};
const deleteLocation = async (req, res, next) => {
  try {
    const loc = await BusinessLocation.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!loc) return res.status(404).json({ message: 'Local no encontrado.' });
    await loc.destroy();
    res.status(204).send();
  } catch (e) { next(e); }
};

// ─── ROLES ───────────────────────────────────────────────────────
const getRoles = async (req, res, next) => {
  try {
    const roles = await Role.findAll({ where: { businessId: req.auth.businessId }, order: [['nombre', 'ASC']] });
    res.json(roles);
  } catch (e) { next(e); }
};
const createRole = async (req, res, next) => {
  try {
    const { nombre, permisos } = req.body;
    if (!nombre) return res.status(400).json({ message: 'El nombre del cargo es obligatorio.' });
    // Se normaliza siempre: descarta módulos inventados y niveles inválidos, y
    // completa los que falten. Un permiso mal escrito no da acceso y no avisa,
    // así que conviene no dejarlo entrar.
    const role = await Role.create({
      businessId: req.auth.businessId,
      nombre,
      permisos: sanitizarPermisos(permisos),
    });
    res.status(201).json(role);
  } catch (e) { next(e); }
};
const updateRole = async (req, res, next) => {
  try {
    const role = await Role.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!role) return res.status(404).json({ message: 'Cargo no encontrado.' });
    // businessId nunca se toma del body: mover un cargo a otro negocio sería
    // regalarle acceso a datos ajenos.
    const patch = {};
    if (req.body?.nombre !== undefined) patch.nombre = req.body.nombre;
    if (req.body?.permisos !== undefined) patch.permisos = sanitizarPermisos(req.body.permisos);

    /*
     * Nadie se edita los permisos a sí mismo.
     *
     * Quien tiene "empleados: editar" administra cargos, que es su trabajo.
     * Pero editando el suyo propio se otorgaba en silencio facturación, caja y
     * aprobaciones, sin que el dueño se enterara — y desde que los permisos se
     * releen de la base en cada pedido, el cambio surte efecto en el acto.
     *
     * El nombre del cargo sí lo puede tocar: no da acceso a nada. Y el dueño no
     * tiene cargo, así que esto no lo limita a él.
     */
    if (patch.permisos !== undefined && req.auth.roleId && Number(req.auth.roleId) === role.id) {
      return res.status(403).json({
        message: 'No podés cambiar los permisos de tu propio cargo. Pedíselo al dueño de la cuenta.',
      });
    }

    await role.update(patch);
    res.json(role);
  } catch (e) { next(e); }
};
const deleteRole = async (req, res, next) => {
  try {
    const role = await Role.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!role) return res.status(404).json({ message: 'Cargo no encontrado.' });
    await role.destroy();
    res.status(204).send();
  } catch (e) { next(e); }
};

// ─── CLIENTS ─────────────────────────────────────────────────────
const getClients = async (req, res, next) => {
  try {
    const { search } = req.query;
    const where = { businessId: req.auth.businessId };
    if (search) {
      const like = ilikeOperator();
      where[Op.or] = [
        { nombre:   { [like]: `%${search}%` } },
        { apellido: { [like]: `%${search}%` } },
        { cuit:     { [like]: `%${search}%` } },
        { email:    { [like]: `%${search}%` } },
      ];
    }

    /*
     * `limit` para quien sólo necesita un puñado.
     *
     * El punto de venta y Nueva venta usan esto como buscador: la persona
     * escribe dos letras y elige de una lista corta. Traían el padrón entero
     * —todos los clientes del negocio— para filtrarlo en el navegador, en cada
     * apertura de la pantalla. Con cuarenta clientes no se nota; con veinte
     * mil son varios megabytes de JSON que el servidor arma y la máquina del
     * mostrador tiene que retener.
     *
     * Es opcional a propósito: la pantalla de Clientes administra el padrón y
     * necesita verlo completo. Recortarle la lista en silencio sería peor que
     * el problema que esto resuelve.
     */
    const pedido = Number(req.query.limit);
    const limit = Number.isFinite(pedido) && pedido > 0 ? Math.min(pedido, 100) : null;

    const clients = await Client.findAll({
      where,
      order: [['nombre', 'ASC']],
      ...(limit ? { limit } : {}),
    });
    res.json(clients);
  } catch (e) { next(e); }
};
/*
 * Valida los identificadores de un cliente.
 *
 * El CUIT es el dato con el que se emite la factura: mal cargado, el rechazo
 * llega de ARCA con el cliente esperando el comprobante. El email es por donde
 * se manda ese comprobante; con un error de tipeo no llega y nadie se entera.
 */
function errorDeIdentificadores(body) {
  if (body?.cuit && String(body.cuit).trim() && !cuitValido(body.cuit)) {
    return 'El CUIT no es válido: revisá los números. Son 11 dígitos y el último es verificador.';
  }
  if (body?.email && String(body.email).trim() && !emailValido(body.email)) {
    return 'El email no tiene un formato válido.';
  }
  return null;
}

/*
 * ¿Ya hay un cliente de este negocio con ese CUIT?
 *
 * El CUIT identifica a una persona ante ARCA: dos fichas con el mismo son la
 * misma persona cargada dos veces, y eso se paga después —la cuenta corriente
 * repartida entre las dos, el histórico de compras partido al medio, y dos
 * direcciones distintas para la misma factura.
 *
 * Se compara por los once dígitos pelados y no por el texto: "20-11111111-2" y
 * "20111111112" son el mismo CUIT, y comparar como cadena los deja pasar como
 * si fueran dos. Por eso se normalizan los dos lados, el que llega y los que ya
 * están.
 *
 * Y siempre dentro del negocio de la sesión: dos negocios distintos pueden
 * tener al mismo cliente, y saber si un CUIT existe en otro negocio no es algo
 * que se pueda contestar desde acá.
 */
async function clienteConMismoCuit(businessId, cuit, exceptoId = null) {
  const digitos = normalizarCuit(cuit);
  if (!digitos) return null;

  const where = { businessId, cuit: { [Op.ne]: null } };
  if (exceptoId) where.id = { [Op.ne]: exceptoId };

  const candidatos = await Client.findAll({
    where, attributes: ['id', 'nombre', 'apellido', 'cuit'],
  });
  return candidatos.find((c) => normalizarCuit(c.cuit) === digitos) || null;
}

const nombreDe = (c) => `${c.nombre || ''} ${c.apellido || ''}`.trim() || 'otro cliente';

/*
 * GET /api/clients/por-cuit?cuit=...
 *
 * Para avisar mientras se escribe, antes de que la persona termine de cargar
 * la ficha entera. Enterarse al apretar "Guardar" —con el cliente esperando en
 * el mostrador— es tarde: hay que borrar todo y buscar el que ya estaba.
 *
 * Devuelve el cliente que ya lo tiene, para poder ofrecer elegirlo en vez de
 * dejar a la persona buscándolo a mano.
 */
const clientePorCuit = async (req, res, next) => {
  try {
    const cuit = req.query.cuit;
    // Un CUIT a medio escribir todavía no es un CUIT: se contesta que no hay
    // nada en vez de un error, porque esto se llama con cada tecla.
    if (!normalizarCuit(cuit)) return res.json({ existe: false, cliente: null });

    const repetido = await clienteConMismoCuit(req.auth.businessId, cuit);
    res.json({
      existe: Boolean(repetido),
      cliente: repetido
        ? { id: repetido.id, nombre: repetido.nombre, apellido: repetido.apellido, cuit: repetido.cuit }
        : null,
    });
  } catch (e) { next(e); }
};

const createClient = async (req, res, next) => {
  try {
    const { nombre } = req.body;
    if (!nombre) return res.status(400).json({ message: 'El nombre es obligatorio.' });
    const malIdent = errorDeIdentificadores(req.body);
    if (malIdent) return res.status(400).json({ message: malIdent });

    const repetido = await clienteConMismoCuit(req.auth.businessId, req.body?.cuit);
    if (repetido) {
      return res.status(409).json({
        message: `Ya tenés un cliente con el CUIT ${req.body.cuit}: ${nombreDe(repetido)}. `
          + 'Usá ese en vez de cargarlo de nuevo.',
        codigo: 'CUIT_REPETIDO',
        // El id va para que la pantalla pueda ofrecer elegirlo en vez de dejar
        // a la persona buscándolo a mano después de haber escrito toda la ficha.
        clienteId: repetido.id,
      });
    }
    // El businessId va DESPUÉS del spread a propósito: al revés, un businessId
    // enviado por el cliente pisaba el de la sesión y el cliente nacía en otro
    // negocio.
    const client = await Client.create({
      ...soloCampos(req.body, CAMPOS_CLIENTE),
      businessId: req.auth.businessId,
    });
    res.status(201).json(client);
  } catch (e) { next(e); }
};
const updateClient = async (req, res, next) => {
  try {
    const malIdent = errorDeIdentificadores(req.body);
    if (malIdent) return res.status(400).json({ message: malIdent });
    const client = await Client.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!client) return res.status(404).json({ message: 'Cliente no encontrado.' });

    // Al editar hay que excluirse a sí mismo: si no, guardar una ficha sin
    // tocarle el CUIT choca contra su propio CUIT.
    if (req.body?.cuit !== undefined) {
      const repetido = await clienteConMismoCuit(req.auth.businessId, req.body.cuit, client.id);
      if (repetido) {
        return res.status(409).json({
          message: `Ya tenés otro cliente con el CUIT ${req.body.cuit}: ${nombreDe(repetido)}.`,
          codigo: 'CUIT_REPETIDO',
          clienteId: repetido.id,
        });
      }
    }
    await client.update(soloCampos(req.body, CAMPOS_CLIENTE));
    res.json(client);
  } catch (e) { next(e); }
};
const deleteClient = async (req, res, next) => {
  try {
    const client = await Client.findOne({ where: { id: req.params.id, businessId: req.auth.businessId } });
    if (!client) return res.status(404).json({ message: 'Cliente no encontrado.' });
    await client.destroy();
    res.status(204).send();
  } catch (e) { next(e); }
};

// ─── DASHBOARD ───────────────────────────────────────────────────
const getDashboard = async (req, res, next) => {
  try {
    const rangeDays = Math.min(parseInt(req.query.rangeDays, 10) || 30, 365);
    const cutoff    = new Date();
    cutoff.setDate(cutoff.getDate() - rangeDays);
    const businessId = req.auth.businessId;

    const sales = await Sale.findAll({
      where: { businessId, tipo: 'venta', fecha: { [Op.gte]: cutoff.toISOString().slice(0,10) } },
      include: [{ model: SaleItem, as: 'items' }],
    });

    const paid    = sales.filter((s) => s.estado === 'pagado');
    const revenue = paid.reduce((s, v) => s + Number(v.total), 0);
    const pending = sales.filter((s) => s.estado === 'pendiente').reduce((s, v) => s + Number(v.total), 0);

    // Costo de mercadería
    const allSkus = [...new Set(paid.flatMap((s) => s.items.map((i) => i.sku)))];
    // El SKU es único por negocio, no en toda la plataforma: el índice es
    // (businessId, sku). Sin filtrar, dos inquilinos que usen el mismo código
    // —"REMERA-M", "001"— se pisan y el margen sale con el costo del otro.
    const variants = allSkus.length ? await ProductVariant.findAll({
      where: { sku: allSkus, businessId: req.auth.businessId },
      include: [{ model: Product, as: 'producto' }],
    }) : [];
    const costMap  = new Map(variants.map((v) => [v.sku, Number(v.producto.costo)]));

    let cogs = 0;
    const byGroup = new Map();
    for (const s of paid) {
      for (const i of s.items) {
        cogs += (costMap.get(i.sku) || 0) * i.cantidad;
        const key = i.skuAgrupador || i.sku;
        const acc = byGroup.get(key) || { titulo: i.titulo, unidades: 0, facturado: 0 };
        acc.unidades  += i.cantidad;
        acc.facturado += Number(i.subtotal);
        byGroup.set(key, acc);
      }
    }

    // Top de variantes individuales (SKU exacto), además del agrupado por padre.
    // Sirve para ver qué talle/color concreto tiene más salida.
    const byVariant = new Map();
    for (const s of paid) {
      for (const i of s.items) {
        const acc = byVariant.get(i.sku) || {
          sku: i.sku, titulo: i.titulo, skuAgrupador: i.skuAgrupador,
          variante1Nombre: i.variante1Nombre, variante1Valor: i.variante1Valor,
          variante2Nombre: i.variante2Nombre, variante2Valor: i.variante2Valor,
          unidades: 0, facturado: 0,
        };
        acc.unidades  += i.cantidad;
        acc.facturado += Number(i.subtotal);
        byVariant.set(i.sku, acc);
      }
    }

    const byDay = new Map();
    for (const s of paid) byDay.set(s.fecha, (byDay.get(s.fecha) || 0) + Number(s.total));

    const invoices = await Invoice.findAll({ where: { businessId, estado: 'emitida' } });
    const stockBajo = await ProductVariant.findAll({ include: [{ model: Product, as: 'producto', where: { businessId } }], order: [['stock', 'ASC']], limit: 200 });

    // ── Progreso histórico ──────────────────────────────────────────
    // Query aparte sin filtro de fecha: el rango de arriba solo aplica a los
    // KPIs del período, pero la evolución anual necesita todo el historial.
    const historicas = await Sale.findAll({
      where: { businessId, tipo: 'venta', estado: 'pagado' },
      include: [{ model: SaleItem, as: 'items' }],
    });

    const byYear  = new Map();
    const byMonth = new Map();
    for (const s of historicas) {
      const anio = String(s.fecha).slice(0, 4);
      const mes  = String(s.fecha).slice(0, 7); // YYYY-MM
      const unidades = s.items.reduce((n, i) => n + i.cantidad, 0);

      const ay = byYear.get(anio) || { anio, total: 0, ventas: 0, unidades: 0 };
      ay.total += Number(s.total); ay.ventas += 1; ay.unidades += unidades;
      byYear.set(anio, ay);

      const am = byMonth.get(mes) || { mes, total: 0, ventas: 0, unidades: 0 };
      am.total += Number(s.total); am.ventas += 1; am.unidades += unidades;
      byMonth.set(mes, am);
    }

    const serieAnual = Array.from(byYear.values()).sort((a, b) => a.anio.localeCompare(b.anio));
    // Variación año contra año, para mostrar si el negocio crece o cae.
    serieAnual.forEach((a, idx) => {
      const previo = idx > 0 ? serieAnual[idx - 1].total : 0;
      a.variacionPct = previo ? Math.round(((a.total - previo) / previo) * 100) : null;
    });

    res.json({
      revenue, cogs, margin: revenue - cogs,
      marginPct: revenue ? Math.round(((revenue - cogs) / revenue) * 100) : 0,
      pendingAmount: pending,
      salesCount: paid.length,
      ticketPromedio: paid.length ? Math.round(revenue / paid.length) : 0,
      topProducts: Array.from(byGroup.entries()).map(([k, v]) => ({ skuAgrupador: k, ...v })).sort((a, b) => b.unidades - a.unidades).slice(0, 8),
      topVariants: Array.from(byVariant.values()).sort((a, b) => b.unidades - a.unidades).slice(0, 10),
      revenueSeries: Array.from(byDay.entries()).map(([fecha, total]) => ({ fecha, total })).sort((a, b) => a.fecha > b.fecha ? 1 : -1),
      serieAnual,
      serieMensual: Array.from(byMonth.values()).sort((a, b) => a.mes.localeCompare(b.mes)),
      lowStock: stockBajo.filter((v) => v.stock <= v.stockMinimo).slice(0, 10).map((v) => ({ sku: v.sku, titulo: v.producto.titulo, talle: v.variante2Valor, color: v.variante1Valor, stock: v.stock, stockMinimo: v.stockMinimo })),
      invoicesCount: invoices.length,
      invoicesTotal: invoices.reduce((s, i) => s + Number(i.total), 0),
    });
  } catch (e) { next(e); }
};

module.exports = {
  getLocations, createLocation, updateLocation, deleteLocation,
  getRoles, createRole, updateRole, deleteRole,
  getClients, clientePorCuit, createClient, updateClient, deleteClient,
  getDashboard,
};
