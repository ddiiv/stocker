/*
 * Métricas analíticas del negocio.
 *
 * Separado de getDashboard (que devuelve los KPIs del período elegido):
 * acá vive el análisis histórico y el detalle por producto.
 */

const { Op } = require('sequelize');
const { Sale, SaleItem, BusinessLocation, ProductVariant, Product } = require('../models');

// Filtro de fechas reutilizable. Sin parámetros, devuelve todo el historial.
function rangoFechas(query) {
  const where = {};
  if (query.desde || query.hasta) {
    where.fecha = {};
    if (query.desde) where.fecha[Op.gte] = query.desde;
    if (query.hasta) where.fecha[Op.lte] = query.hasta;
  }
  return where;
}

// Agrupa una fecha YYYY-MM-DD según la granularidad pedida.
function claveDe(fecha, granularidad) {
  const f = String(fecha);
  if (granularidad === 'anio')    return f.slice(0, 4);
  if (granularidad === 'mes')     return f.slice(0, 7);
  if (granularidad === 'semana') {
    // Lunes de la semana ISO — sirve para agrupar sin depender de librerías.
    const d = new Date(`${f}T00:00:00`);
    const diaSemana = (d.getDay() + 6) % 7; // 0 = lunes
    d.setDate(d.getDate() - diaSemana);
    return d.toISOString().slice(0, 10);
  }
  return f; // día
}

// ── GET /api/metrics/timeline ────────────────────────────────────
// Evolución de las ventas a lo largo del tiempo, sin límite de rango.
const timeline = async (req, res, next) => {
  try {
    const businessId = req.auth.businessId;
    const granularidad = ['dia', 'semana', 'mes', 'anio'].includes(req.query.granularidad)
      ? req.query.granularidad : 'mes';
    const incluirPendientes = req.query.incluirPendientes === 'true';

    const estados = incluirPendientes ? ['pagado', 'pendiente'] : ['pagado'];
    const ventas = await Sale.findAll({
      where: { businessId, tipo: 'venta', estado: { [Op.in]: estados }, ...rangoFechas(req.query) },
      include: [{ model: SaleItem, as: 'items' }],
      order: [['fecha', 'ASC']],
    });

    // Costo por SKU para poder calcular margen en cada punto de la serie.
    const skus = [...new Set(ventas.flatMap((v) => v.items.map((i) => i.sku)))];
    const variantes = skus.length
      ? await ProductVariant.findAll({ where: { sku: skus }, include: [{ model: Product, as: 'producto' }] })
      : [];
    const costoPorSku = new Map(variantes.map((v) => [v.sku, Number(v.producto?.costo) || 0]));

    const buckets = new Map();
    for (const v of ventas) {
      const clave = claveDe(v.fecha, granularidad);
      const b = buckets.get(clave) || {
        periodo: clave, total: 0, ventas: 0, unidades: 0, costo: 0,
        pagado: 0, pendiente: 0,
      };
      const unidades = v.items.reduce((n, i) => n + i.cantidad, 0);
      const costo    = v.items.reduce((n, i) => n + (costoPorSku.get(i.sku) || 0) * i.cantidad, 0);

      b.total    += Number(v.total);
      b.ventas   += 1;
      b.unidades += unidades;
      b.costo    += costo;
      b[v.estado === 'pagado' ? 'pagado' : 'pendiente'] += Number(v.total);
      buckets.set(clave, b);
    }

    const serie = Array.from(buckets.values())
      .sort((a, b) => a.periodo.localeCompare(b.periodo))
      .map((b) => ({
        ...b,
        total: Math.round(b.total * 100) / 100,
        costo: Math.round(b.costo * 100) / 100,
        ganancia: Math.round((b.total - b.costo) * 100) / 100,
        margenPct: b.total ? Math.round(((b.total - b.costo) / b.total) * 100) : 0,
        ticketPromedio: b.ventas ? Math.round(b.total / b.ventas) : 0,
      }));

    // Variación contra el período anterior, para leer la tendencia de un vistazo.
    serie.forEach((p, i) => {
      const previo = i > 0 ? serie[i - 1].total : null;
      p.variacionPct = previo ? Math.round(((p.total - previo) / previo) * 100) : null;
    });

    const totalGeneral = serie.reduce((s, p) => s + p.total, 0);
    const mejor = serie.reduce((a, b) => (b.total > (a?.total ?? -1) ? b : a), null);

    res.json({
      granularidad,
      serie,
      resumen: {
        totalFacturado: Math.round(totalGeneral * 100) / 100,
        totalVentas:    serie.reduce((s, p) => s + p.ventas, 0),
        totalUnidades:  serie.reduce((s, p) => s + p.unidades, 0),
        gananciaTotal:  Math.round(serie.reduce((s, p) => s + p.ganancia, 0) * 100) / 100,
        periodos:       serie.length,
        mejorPeriodo:   mejor ? { periodo: mejor.periodo, total: mejor.total } : null,
        promedioPorPeriodo: serie.length ? Math.round(totalGeneral / serie.length) : 0,
      },
    });
  } catch (e) { next(e); }
};

// ── GET /api/metrics/products ────────────────────────────────────
// Rendimiento de cada producto: unidades, ganancia, conversión y locales.
const products = async (req, res, next) => {
  try {
    const businessId = req.auth.businessId;

    const ventas = await Sale.findAll({
      where: { businessId, tipo: 'venta', estado: 'pagado', ...rangoFechas(req.query) },
      include: [{ model: SaleItem, as: 'items' }],
    });
    const totalVentas = ventas.length;

    const locales = await BusinessLocation.findAll({ where: { businessId } });
    const nombreLocal = new Map(locales.map((l) => [l.id, l.nombre]));

    // Catálogo actual: costo, precio y stock por SKU.
    const variantes = await ProductVariant.findAll({
      include: [{ model: Product, as: 'producto', where: { businessId } }],
    });
    const infoSku = new Map(variantes.map((v) => [v.sku, {
      costo: Number(v.producto?.costo) || 0,
      stock: Number(v.stock) || 0,
      skuAgrupador: v.producto?.skuAgrupador || v.sku,
      titulo: v.producto?.titulo,
      categoria: v.producto?.categoria,
      activo: v.producto?.activo,
    }]));

    // Stock actual agrupado por producto padre (para calcular rotación).
    const stockPorGrupo = new Map();
    for (const v of variantes) {
      const g = v.producto?.skuAgrupador || v.sku;
      const acc = stockPorGrupo.get(g) || { stock: 0, variantes: 0, titulo: v.producto?.titulo, categoria: v.producto?.categoria };
      acc.stock += Number(v.stock) || 0;
      acc.variantes += 1;
      stockPorGrupo.set(g, acc);
    }

    const porGrupo = new Map();
    for (const venta of ventas) {
      // Un mismo producto puede aparecer en varias líneas de la misma venta;
      // para la conversión nos importa en cuántas ventas distintas aparece.
      const gruposEnEstaVenta = new Set();

      for (const item of venta.items) {
        const info  = infoSku.get(item.sku) || {};
        const grupo = item.skuAgrupador || info.skuAgrupador || item.sku;
        gruposEnEstaVenta.add(grupo);

        const acc = porGrupo.get(grupo) || {
          skuAgrupador: grupo,
          titulo:    item.titulo || info.titulo,
          categoria: info.categoria || null,
          unidades: 0, facturado: 0, costo: 0,
          ventasCount: 0,
          porLocal:   new Map(),
          porVariante: new Map(),
        };

        const costoLinea = (info.costo || 0) * item.cantidad;
        acc.unidades  += item.cantidad;
        acc.facturado += Number(item.subtotal);
        acc.costo     += costoLinea;

        // Desglose por local
        const locId = venta.locationId ?? 0;
        const loc = acc.porLocal.get(locId) || {
          locationId: venta.locationId || null,
          nombre: nombreLocal.get(venta.locationId) || 'Sin local asignado',
          unidades: 0, facturado: 0, ventas: 0,
        };
        loc.unidades  += item.cantidad;
        loc.facturado += Number(item.subtotal);
        acc.porLocal.set(locId, loc);

        // Desglose por variante
        const va = acc.porVariante.get(item.sku) || {
          sku: item.sku,
          variante1Valor: item.variante1Valor,
          variante2Valor: item.variante2Valor,
          unidades: 0, facturado: 0,
          stockActual: info.stock ?? null,
        };
        va.unidades  += item.cantidad;
        va.facturado += Number(item.subtotal);
        acc.porVariante.set(item.sku, va);

        porGrupo.set(grupo, acc);
      }

      // Sumamos 1 venta a cada producto presente y al local correspondiente.
      for (const g of gruposEnEstaVenta) {
        const acc = porGrupo.get(g);
        acc.ventasCount += 1;
        const loc = acc.porLocal.get(venta.locationId ?? 0);
        if (loc) loc.ventas += 1;
      }
    }

    const productos = Array.from(porGrupo.values()).map((p) => {
      const ganancia   = p.facturado - p.costo;
      const stockGrupo = stockPorGrupo.get(p.skuAgrupador);
      const stockActual = stockGrupo?.stock ?? 0;
      // Rotación: cuánto de lo que tuviste disponible se vendió.
      // Aproximamos el disponible como stock actual + unidades ya vendidas.
      const disponible = stockActual + p.unidades;

      const porLocal = Array.from(p.porLocal.values()).sort((a, b) => b.unidades - a.unidades);

      return {
        skuAgrupador: p.skuAgrupador,
        titulo:    p.titulo,
        categoria: p.categoria || stockGrupo?.categoria || null,
        unidades:  p.unidades,
        facturado: Math.round(p.facturado * 100) / 100,
        costo:     Math.round(p.costo * 100) / 100,
        ganancia:  Math.round(ganancia * 100) / 100,
        margenPct: p.facturado ? Math.round((ganancia / p.facturado) * 100) : 0,
        precioPromedio:     p.unidades ? Math.round(p.facturado / p.unidades) : 0,
        gananciaPorUnidad:  p.unidades ? Math.round(ganancia / p.unidades) : 0,
        // Conversión = en qué porcentaje de las ventas aparece este producto.
        ventasCount:   p.ventasCount,
        conversionPct: totalVentas ? Math.round((p.ventasCount / totalVentas) * 100) : 0,
        // Rotación = qué proporción del stock disponible ya se vendió.
        stockActual,
        rotacionPct: disponible ? Math.round((p.unidades / disponible) * 100) : 0,
        variantesCount: stockGrupo?.variantes ?? p.porVariante.size,
        porLocal,
        mejorLocal: porLocal[0]?.nombre || null,
        peorLocal:  porLocal.length > 1 ? porLocal[porLocal.length - 1].nombre : null,
        porVariante: Array.from(p.porVariante.values()).sort((a, b) => b.unidades - a.unidades),
      };
    });

    // Productos del catálogo que nunca se vendieron en el período: son los
    // que más importa detectar (capital inmovilizado).
    const vendidos = new Set(productos.map((p) => p.skuAgrupador));
    const sinVentas = Array.from(stockPorGrupo.entries())
      .filter(([g]) => !vendidos.has(g))
      .map(([skuAgrupador, s]) => ({
        skuAgrupador, titulo: s.titulo, categoria: s.categoria,
        stockActual: s.stock, variantesCount: s.variantes,
      }))
      .sort((a, b) => b.stockActual - a.stockActual);

    // Totales por local, para comparar sucursales independientemente del producto.
    const totalPorLocal = new Map();
    for (const venta of ventas) {
      const locId = venta.locationId ?? 0;
      const t = totalPorLocal.get(locId) || {
        locationId: venta.locationId || null,
        nombre: nombreLocal.get(venta.locationId) || 'Sin local asignado',
        facturado: 0, ventas: 0, unidades: 0,
      };
      t.facturado += Number(venta.total);
      t.ventas    += 1;
      t.unidades  += venta.items.reduce((n, i) => n + i.cantidad, 0);
      totalPorLocal.set(locId, t);
    }

    res.json({
      totalVentas,
      productos: productos.sort((a, b) => b.facturado - a.facturado),
      sinVentas,
      locales: Array.from(totalPorLocal.values()).sort((a, b) => b.facturado - a.facturado),
    });
  } catch (e) { next(e); }
};

module.exports = { timeline, products };
