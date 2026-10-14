/*
 * Plataformas: con qué está conectado un negocio, y los pedidos de cotización
 * de un desarrollo a medida.
 *
 * ── El estado se calcula acá, no en la pantalla ──────────────────
 *
 * La pantalla dice "conectada", "sin conectar" o "disponible desde el Pro".
 * Para decirlo hay que cruzar el plan, lo heredado y las credenciales, y si
 * cada pantalla lo cruzara a su manera, el resumen diría una cosa y la puerta
 * de las rutas de máquina (requireIntegracion) haría otra. Por eso las dos
 * preguntan lo mismo: el plan del negocio y `featuresHeredadas`.
 *
 * ── Lo que NO sale de acá ────────────────────────────────────────
 *
 * Ningún token: ni el de las credenciales de máquina (ni su hash, ni la pista),
 * ni los de Mercado Libre, ni la clave de Jumpseller. Se lee cada tabla con la
 * lista de columnas que hace falta y nada más: un `findAll` sin `attributes`
 * es como un token termina viajando el día que alguien agrega un campo al
 * JSON.
 */

const { Op } = require('sequelize');
const {
  Business, Plan, IntegracionExterna, SolicitudMayorista, Employee,
  MercadoLibreAccount, JumpsellerAccount, CotizacionDesarrollo,
} = require('../models');
const { PLATAFORMAS } = require('../config/plataformas');
const { CASILLAS } = require('../config/correo');
const { log } = require('../utils/logger');

const error = (mensaje, status = 400, extra = {}) => Object.assign(new Error(mensaje), { status, ...extra });

/*
 * Qué se puede cotizar.
 *
 * El portal mayorista es un desarrollo a medida (decisión del dueño). La
 * tienda propia no siempre lo es —puede ser una página que ya existe y sólo
 * hay que conectar—, pero el pedido es el mismo: alguien del equipo tiene que
 * hablar con el cliente y emitir la credencial. Van a la misma bandeja para
 * que no haya dos lugares que mirar.
 */
const TIPOS_COTIZACION = {
  portal_mayorista: 'Portal de pedidos mayoristas a medida',
  tienda_propia: 'Conectar una tienda online propia',
};

const ESTADOS_COTIZACION = ['nueva', 'contactada', 'cotizada', 'aceptada', 'descartada'];

/* El plan más barato (por `orden`) que incluye la función, entre los activos. */
async function planMinimoPara(clave) {
  const planes = await Plan.findAll({
    where: { activo: true },
    attributes: ['codigo', 'nombre', 'orden', 'features'],
    order: [['orden', 'ASC']],
  });
  const p = planes.find((x) => x.features?.[clave]);
  return p ? { codigo: p.codigo, nombre: p.nombre } : null;
}

/*
 * La foto de las plataformas de un negocio.
 *
 * Por plataforma:
 *   estado      'conectada' | 'sin_conectar' | 'requiere_plan' | 'fuera_de_plan'
 *               ('fuera_de_plan' = hay algo conectado que el plan no incluye:
 *               para la tienda y el portal quiere decir que sus pedidos están
 *               rebotando con 402, y la pantalla lo tiene que avisar).
 *   incluida    el plan la trae o el negocio la heredó
 *   heredada    la conserva por tenerla antes de la puerta (no por el plan)
 *   desde       { codigo, nombre } del primer plan que la incluye
 *   detalle     lo mínimo para mostrar: cuenta/tienda, última sincronización,
 *               último uso. Nunca un token.
 */
async function estadoDePlataformas(businessId) {
  const { estadoDe, heredaFeature } = require('./planService');

  const [estado, negocio, ml, js, credenciales, pendientes, totalSolicitudes, ultimaCotizacion] = await Promise.all([
    estadoDe(businessId),
    Business.findByPk(businessId, { attributes: ['id', 'nombreNegocio', 'featuresHeredadas'] }),
    MercadoLibreAccount.findOne({
      where: { businessId },
      // refreshToken se pide sólo para saber si hay; no sale de esta función.
      attributes: ['id', 'nickname', 'refreshToken', 'ultimaSync', 'ultimoError'],
    }),
    JumpsellerAccount.findOne({
      where: { businessId },
      attributes: ['id', 'tienda', 'ultimaSync', 'ultimoError'],
    }),
    IntegracionExterna.findAll({
      where: { businessId, activa: true },
      attributes: ['id', 'origen', 'ultimoUsoEn', 'createdAt'],
      order: [['id', 'DESC']],
    }),
    SolicitudMayorista.count({ where: { businessId, estado: 'pendiente' } }),
    SolicitudMayorista.count({ where: { businessId } }),
    CotizacionDesarrollo.findAll({
      where: { businessId },
      attributes: ['id', 'tipo', 'estado', 'createdAt'],
      order: [['id', 'DESC']],
      limit: 10,
    }),
  ]);

  const plan = estado.plan;
  const credPorOrigen = new Map();
  for (const c of credenciales) if (!credPorOrigen.has(c.origen)) credPorOrigen.set(c.origen, c);

  const minimos = new Map();
  for (const p of PLATAFORMAS) {
    if (!minimos.has(p.feature)) minimos.set(p.feature, await planMinimoPara(p.feature));
  }

  const plataformas = PLATAFORMAS.map((p) => {
    const porPlan = Boolean(plan?.features?.[p.feature]);
    const heredada = !porPlan && heredaFeature(negocio, p.feature);
    const incluida = porPlan || heredada;

    let conectada = false;
    let detalle = {};
    if (p.clave === 'mercadolibre') {
      conectada = Boolean(ml?.refreshToken);
      if (ml) detalle = { cuenta: ml.nickname || null, ultimaSync: ml.ultimaSync, conError: Boolean(ml.ultimoError) };
    } else if (p.clave === 'jumpseller') {
      conectada = Boolean(js);
      if (js) detalle = { cuenta: js.tienda || null, ultimaSync: js.ultimaSync, conError: Boolean(js.ultimoError) };
    } else if (p.origen) {
      const c = credPorOrigen.get(p.origen);
      conectada = Boolean(c);
      if (c) detalle = { ultimoUso: c.ultimoUsoEn, conectadaDesde: c.createdAt };
    }

    const estadoPlataforma = conectada
      ? (incluida ? 'conectada' : 'fuera_de_plan')
      : (incluida ? 'sin_conectar' : 'requiere_plan');

    return {
      clave: p.clave,
      nombre: p.nombre,
      feature: p.feature,
      estado: estadoPlataforma,
      conectada,
      incluida,
      heredada,
      desde: minimos.get(p.feature),
      detalle,
    };
  });

  return {
    plan: plan ? { codigo: plan.codigo, nombre: plan.nombre } : null,
    plataformas,
    mayoristas: { pendientes, total: totalSolicitudes },
    cotizaciones: ultimaCotizacion.map((c) => ({
      id: c.id, tipo: c.tipo, tipoTexto: TIPOS_COTIZACION[c.tipo] || c.tipo,
      estado: c.estado, creadaEn: c.createdAt,
    })),
    /*
     * El botón de WhatsApp, ya armado para cada tipo de pedido. null cuando
     * no hay número configurado: la pantalla no lo dibuja.
     */
    whatsapp: Object.fromEntries(Object.keys(TIPOS_COTIZACION).map((tipo) => [
      tipo, enlaceWhatsapp({ tipo, nombreNegocio: negocio?.nombreNegocio || 'mi negocio' }),
    ])),
  };
}

/* ── Cotizaciones ─────────────────────────────────────────────── */

/*
 * El número de WhatsApp del equipo, sólo dígitos, o null.
 *
 * Sale de COTIZACIONES_WHATSAPP y de ningún otro lado: si no está, no se
 * ofrece el botón. Mejor no ofrecerlo que mandar al cliente a un número que
 * nadie mira.
 */
function whatsappDeCotizacion() {
  const digitos = String(process.env.COTIZACIONES_WHATSAPP || '').replace(/\D/g, '');
  return digitos.length >= 8 ? digitos : null;
}

/*
 * El enlace wa.me con el mensaje ya escrito, o null.
 *
 * Es un enlace y nada más (decisión del dueño): abre el WhatsApp del cliente
 * con el texto listo y él decide si lo manda. La API de Meta no sirve para
 * esto: fuera de la ventana de 24 h sólo manda plantillas aprobadas.
 */
function enlaceWhatsapp({ tipo, nombreNegocio, id = null }) {
  const numero = whatsappDeCotizacion();
  if (!numero) return null;
  const que = TIPOS_COTIZACION[tipo] || TIPOS_COTIZACION.portal_mayorista;
  const texto = id
    ? `Hola, soy de ${nombreNegocio}. Pedí una cotización en Stocker (#${id}): ${que.toLowerCase()}.`
    : `Hola, soy de ${nombreNegocio}. Quiero cotizar en Stocker: ${que.toLowerCase()}.`;
  return `https://wa.me/${numero}?text=${encodeURIComponent(texto)}`;
}

/* A dónde va el aviso por mail: COTIZACIONES_EMAIL, o la casilla de soporte. */
function destinoDeCotizacion() {
  const propio = String(process.env.COTIZACIONES_EMAIL || '').trim();
  return propio || CASILLAS.soporte || null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const recortar = (v, max) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};

/*
 * Guarda el pedido y recién después avisa.
 *
 * `auth` es el req.auth de la sesión: el negocio sale de ahí, nunca del
 * cuerpo. El aviso por mail se dispara SIN esperarlo: si el correo tarda o se
 * cae, el cliente ya tiene su respuesta y la fila ya está. Lo que pase con el
 * mail queda escrito en la fila (avisoEnviadoEn / avisoError) para que el
 * backoffice lo vea.
 *
 * `enviar` se puede reemplazar en las pruebas (correo caído, correo colgado).
 */
async function crearCotizacion(auth, cuerpo = {}, { enviar } = {}) {
  const businessId = auth?.businessId;
  if (!businessId) throw error('Falta el negocio.', 401);

  const tipo = Object.prototype.hasOwnProperty.call(TIPOS_COTIZACION, cuerpo.tipo) ? cuerpo.tipo : null;
  if (!tipo) throw error('Elegí qué querés cotizar.');

  const detalle = String(cuerpo.detalle || '').trim();
  /*
   * Un mínimo, como en soporte: "quiero un portal" no se puede cotizar y
   * obliga a escribirle para preguntar lo mismo que se podía haber puesto.
   */
  if (detalle.length < 20) {
    throw error('Contanos un poco más: qué venden por mayor, a cuántos clientes y cómo toman hoy los pedidos. Con eso podemos cotizar sin volver a preguntarte.');
  }
  if (detalle.length > 4000) throw error('El detalle es demasiado largo (máximo 4000 caracteres).');

  const negocio = await Business.findByPk(businessId, {
    attributes: ['id', 'nombreNegocio', 'cuit', 'email', 'ownerNombre', 'ownerApellido', 'telefono', 'ownerTelefono'],
  });
  if (!negocio) throw error('Negocio no encontrado.', 404);

  // Quién lo pide: el dueño, o el empleado con su nombre.
  let quien = [negocio.ownerNombre, negocio.ownerApellido].filter(Boolean).join(' ') || negocio.nombreNegocio;
  let emailPorDefecto = negocio.email;
  if (auth.employeeId) {
    const emp = await Employee.findOne({
      where: { id: auth.employeeId, businessId },
      attributes: ['nombre', 'apellido', 'email'],
    });
    if (emp) {
      quien = `${emp.nombre} ${emp.apellido || ''}`.trim();
      emailPorDefecto = emp.email || negocio.email;
    }
  }

  const contactoEmail = recortar(cuerpo.contactoEmail, 150) || emailPorDefecto || null;
  if (contactoEmail && !EMAIL_RE.test(contactoEmail)) throw error('Ese email no parece válido.');
  const contactoTelefono = recortar(cuerpo.contactoTelefono, 40) || negocio.ownerTelefono || negocio.telefono || null;

  const fila = await CotizacionDesarrollo.create({
    businessId,
    tipo,
    detalle,
    contactoNombre: recortar(cuerpo.contactoNombre, 150) || quien,
    contactoEmail,
    contactoTelefono,
    estado: 'nueva',
    pedidaPorEmployeeId: auth.employeeId || null,
  });

  // El aviso, sin esperarlo y sin que pueda tirar abajo el pedido.
  const { estadoDe } = require('./planService');
  const mandar = enviar || require('./emailService').sendCotizacionDesarrollo;
  const aviso = (async () => {
    let plan = null;
    try { plan = (await estadoDe(businessId)).plan?.nombre || null; } catch { /* sin plan igual se avisa */ }
    const r = await mandar({
      destino: destinoDeCotizacion(),
      negocio: negocio.toJSON(),
      cotizacion: fila.toJSON(),
      tipoTexto: TIPOS_COTIZACION[tipo],
      quien,
      plan,
    });
    if (r?.enviado) await fila.update({ avisoEnviadoEn: new Date(), avisoError: null });
    else await fila.update({ avisoError: String(r?.motivo || 'no se envió').slice(0, 200) });
  })().catch(async (e) => {
    log.warn('plataformas', 'no salió el aviso de una cotización (quedó guardada)', {
      cotizacion: fila.id, error: e.message,
    });
    await fila.update({ avisoError: String(e.message || 'error').slice(0, 200) }).catch(() => {});
  });

  return {
    cotizacion: aCliente(fila),
    whatsapp: enlaceWhatsapp({ tipo, nombreNegocio: negocio.nombreNegocio, id: fila.id }),
    // Para las pruebas: la promesa del aviso, que el controlador no espera.
    _aviso: aviso,
  };
}

/* Lo que ve el cliente de su pedido: sin la nota interna ni el estado del mail. */
function aCliente(f) {
  return {
    id: f.id,
    tipo: f.tipo,
    tipoTexto: TIPOS_COTIZACION[f.tipo] || f.tipo,
    detalle: f.detalle,
    estado: f.estado,
    creadaEn: f.createdAt,
  };
}

async function cotizacionesDe(businessId) {
  const filas = await CotizacionDesarrollo.findAll({
    where: { businessId },
    order: [['id', 'DESC']],
    limit: 50,
  });
  return filas.map(aCliente);
}

/* ── Backoffice ───────────────────────────────────────────────── */

async function listarParaBackoffice({ estado = null, limite = 200 } = {}) {
  const where = {};
  if (estado && ESTADOS_COTIZACION.includes(estado)) where.estado = estado;
  const filas = await CotizacionDesarrollo.findAll({
    where,
    order: [['id', 'DESC']],
    limit: Math.min(Number(limite) || 200, 500),
  });
  const negocios = filas.length
    ? await Business.findAll({
      where: { id: { [Op.in]: [...new Set(filas.map((f) => f.businessId))] } },
      attributes: ['id', 'nombreNegocio', 'email'],
    })
    : [];
  const porId = new Map(negocios.map((n) => [n.id, n]));
  return filas.map((f) => ({
    ...f.toJSON(),
    tipoTexto: TIPOS_COTIZACION[f.tipo] || f.tipo,
    negocio: porId.get(f.businessId)
      ? { id: f.businessId, nombre: porId.get(f.businessId).nombreNegocio, email: porId.get(f.businessId).email }
      : { id: f.businessId, nombre: '(negocio borrado)', email: null },
  }));
}

async function actualizarDesdeBackoffice(id, { estado, notaInterna } = {}, admin = null) {
  const fila = await CotizacionDesarrollo.findByPk(Number(id));
  if (!fila) throw error('Esa cotización no existe.', 404);
  const cambios = {};
  if (estado !== undefined) {
    if (!ESTADOS_COTIZACION.includes(estado)) {
      throw error(`Estado inválido. Los válidos son: ${ESTADOS_COTIZACION.join(', ')}.`);
    }
    if (estado !== fila.estado) {
      cambios.estado = estado;
      cambios.estadoCambiadoEn = new Date();
      cambios.estadoCambiadoPor = admin?.email || null;
    }
  }
  if (notaInterna !== undefined) cambios.notaInterna = recortar(notaInterna, 4000);
  if (Object.keys(cambios).length) await fila.update(cambios);
  return fila.toJSON();
}

module.exports = {
  estadoDePlataformas, planMinimoPara,
  crearCotizacion, cotizacionesDe, listarParaBackoffice, actualizarDesdeBackoffice,
  enlaceWhatsapp, whatsappDeCotizacion, destinoDeCotizacion,
  TIPOS_COTIZACION, ESTADOS_COTIZACION,
};
