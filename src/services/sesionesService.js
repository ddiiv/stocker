const crypto = require('node:crypto');
const { Op, TableHints } = require('sequelize');
const db = require('../config/database');
const { SesionCuenta, Business, Employee, EmployeeSession } = require('../models');
const { crearSesion, vencimientoAbsoluto, IDLE_MS } = require('../utils/session');
const { etiquetaDeDispositivo, normalizarIp } = require('../utils/dispositivo');
const { log } = require('../utils/logger');

/*
 * Las sesiones de la cuenta: abrirlas, verificarlas, cerrarlas y listarlas.
 *
 * El JWT sigue siendo la sesión (vigencia, inactividad, tope absoluto: ver
 * utils/session.js). Cada sesión además tiene una fila, y el token lleva el
 * `sid` de esa fila. La fila sirve para dos cosas que un JWT solo no puede:
 *
 *   · Que el dueño VEA dónde está abierta su cuenta.
 *   · Cerrar UNA sesión puntual. Antes el único corte era `sesionesDesde`, que
 *     echa a todas juntas.
 *
 * Y sobre eso, el límite de sesiones del dueño por plan.
 */

const MINUTO = 60 * 1000;
const DIA = 24 * 60 * MINUTO;

/*
 * Cada cuánto, como mucho, se escribe la última actividad de una sesión.
 *
 * Escribirla en cada pedido sería una escritura por cada clic de cada cajero.
 * Con un minuto de tope, la lista sigue diciendo "activa hace un momento" y la
 * base hace una escritura por minuto por sesión, no cientos.
 */
const TOQUE_MS = MINUTO;

/*
 * Cuándo una sesión cuenta como activa.
 *
 * Abierta, sin pasar el tope absoluto, y con actividad dentro de la ventana de
 * inactividad. Una sesión abandonada —la pestaña que quedó abierta en una PC
 * prestada— deja de contar sola a los 30 minutos, sin que nadie la cierre: su
 * JWT ya venció y no puede volver a entrar.
 *
 * Se le suma el minuto del TOQUE: la última actividad guardada puede atrasar
 * hasta un minuto respecto de la real, y una sesión viva no puede quedar
 * afuera de la cuenta. Contar de más un minuto a una que acaba de morir no le
 * hace daño a nadie; contar de menos a una viva dejaría pasar el límite.
 */
function condicionActiva(ahora = new Date()) {
  const t = new Date(ahora).getTime();
  return {
    cerradaEn: null,
    venceEn: { [Op.gt]: new Date(t) },
    ultimaActividadEn: { [Op.gt]: new Date(t - IDLE_MS - TOQUE_MS) },
  };
}

// La misma condición, sobre una fila ya leída.
function finDeVida(fila) {
  const porInactividad = new Date(fila.ultimaActividadEn).getTime() + IDLE_MS + TOQUE_MS;
  return Math.min(new Date(fila.venceEn).getTime(), porInactividad);
}

const HISTORIAL_DIAS = 30;
// Lo que dice la Política de Privacidad sobre los registros de acceso.
const RETENCION_DIAS = 90;
// Un negocio con cuarenta empleados que entran dos veces por día junta miles
// de filas en un mes. La pantalla no necesita más que las últimas.
const HISTORIAL_MAX = 300;

/* ── El interruptor del límite ─────────────────────────────────────
 *
 * SESIONES_LIMITE = sombra (por omisión) | activo | off
 *
 *   sombra  Se cuenta y se deja en el log a quién se le habría cerrado una
 *           sesión, sin cerrar nada. Es para ver cuántos dueños topan con el
 *           límite antes de que le moleste a alguien.
 *   activo  Se cierra la sesión del dueño con menos actividad reciente.
 *   off     Ni se cuenta.
 *
 * Un valor que no se entiende cae en 'sombra', que es el que no le cierra la
 * sesión a nadie. El modo efectivo se imprime en el arranque, así que un
 * "on" mal escrito se ve en el primer deploy.
 */
const MODOS = ['sombra', 'activo', 'off'];
function modoLimite() {
  const valor = String(process.env.SESIONES_LIMITE || '').trim().toLowerCase();
  return MODOS.includes(valor) ? valor : 'sombra';
}

/* ── Abrir ─────────────────────────────────────────────────────── */

/*
 * El tope de sesiones del plan del negocio, o null si no tiene.
 *
 * Si no se puede leer el plan, se entra SIN límite y queda en el log. El
 * límite es una regla comercial; dejar a un dueño afuera de su cuenta porque
 * falló una consulta del plan sería un daño mucho mayor que el que evita.
 */
async function topeDelDueno(businessId) {
  try {
    // Acá adentro y no arriba: planService también lee de este servicio.
    const { estadoDe } = require('./planService');
    const { plan } = await estadoDe(businessId);
    return plan?.maxSesiones == null ? null : Number(plan.maxSesiones);
  } catch (e) {
    log.error('sesiones', 'no se pudo leer el tope de sesiones del plan: se entra sin límite', { motivo: e.message });
    return null;
  }
}

/*
 * Crea la fila del dueño respetando el tope de su plan.
 *
 * Todo pasa con la fila del negocio TRABADA: dos ingresos simultáneos leerían
 * el mismo conteo, los dos verían lugar y los dos entrarían. Con la traba el
 * segundo espera, cuenta lo que dejó el primero y desplaza si hace falta. Es
 * una traba de la base, no de memoria, así que sirve igual con varias
 * instancias del servidor.
 *
 * Se manda `lock` y `tableHint` porque cada motor ignora la opción del otro: en
 * SQL Server `lock` no hace nada (ver planService.trabada).
 *
 * La fila nueva se crea DESPUÉS de cerrar las que sobran, así que la sesión
 * que está entrando no puede ser nunca la desplazada. Y a esta altura el
 * segundo factor ya se verificó (y su código ya se gastó): el límite nunca
 * rechaza un ingreso, sólo hace lugar.
 */
async function crearConLimite(datos) {
  const modo = modoLimite();
  const tope = modo === 'off' ? null : await topeDelDueno(datos.businessId);
  if (tope == null) return SesionCuenta.create(datos);

  return db.transaction(async (t) => {
    await Business.findByPk(datos.businessId, {
      attributes: ['id'], transaction: t, lock: t.LOCK.UPDATE, tableHint: TableHints.UPDLOCK,
    });

    // La de menos actividad primero: es la que se va. A igual actividad, la
    // más vieja.
    const activas = await SesionCuenta.findAll({
      where: { businessId: datos.businessId, tipo: 'business', ...condicionActiva(datos.creadaEn) },
      attributes: ['id'],
      order: [['ultimaActividadEn', 'ASC'], ['id', 'ASC']],
      transaction: t,
    });

    const sobran = activas.length + 1 - tope;
    if (sobran > 0) {
      if (modo === 'activo') {
        const ids = activas.slice(0, sobran).map((s) => s.id);
        await SesionCuenta.update(
          { cerradaEn: datos.creadaEn, motivoCierre: 'limite' },
          { where: { id: ids, cerradaEn: null }, transaction: t },
        );
        log.info('sesiones', 'el dueño superó el tope de su plan: se cerraron las sesiones con menos actividad', {
          negocio: datos.businessId, tope, cerradas: ids.length,
        });
      } else {
        log.warn('sesiones', 'modo sombra: el dueño superó el tope de su plan y no se cerró nada', {
          negocio: datos.businessId, tope, activas: activas.length, seHabrianCerrado: sobran,
        });
      }
    }

    return SesionCuenta.create(datos, { transaction: t });
  });
}

/**
 * Abre una sesión: crea su fila y devuelve el token que la lleva.
 *
 * @param req      el pedido del login (de ahí salen la IP y el navegador)
 * @param payload  { type:'business'|'employee', businessId, employeeId?, roleId?, permisos? }
 */
async function abrir(req, payload) {
  const tipo = payload?.type;
  if (tipo !== 'business' && tipo !== 'employee') {
    throw new Error(`No se puede abrir una sesión de tipo "${tipo}".`);
  }
  if (!payload.businessId) throw new Error('Una sesión sin negocio no se puede abrir.');

  const ahora = Date.now();
  const ua = String(req?.headers?.['user-agent'] || '');
  const datos = {
    sid: crypto.randomUUID(),
    businessId: payload.businessId,
    tipo,
    employeeId: tipo === 'employee' ? payload.employeeId : null,
    ip: normalizarIp(req?.ip || req?.socket?.remoteAddress),
    userAgent: ua.slice(0, 300) || null,
    dispositivo: etiquetaDeDispositivo(ua),
    creadaEn: new Date(ahora),
    ultimaActividadEn: new Date(ahora),
    venceEn: vencimientoAbsoluto(ahora),
  };

  // Sólo el dueño tiene tope. Los empleados ya lo tienen en la cantidad de
  // usuarios del plan, y cortarle la sesión a un cajero en plena venta es
  // peor que lo que esto frena. Sus sesiones se registran igual para verlas.
  if (tipo === 'business') await crearConLimite(datos);
  else await SesionCuenta.create(datos);

  return crearSesion({ ...payload, sid: datos.sid }, ahora);
}

/*
 * El token nuevo para la MISMA sesión, después de un cambio de contraseña o de
 * "cerrar todas".
 *
 * Esos dos caminos mueven `sesionesDesde`, y el token del que apretó el botón
 * quedaría del lado de afuera del corte. Se le firma uno nuevo —con
 * `iniciada` posterior al corte— pero con el mismo sid: es la misma
 * computadora, y en la lista tiene que seguir siendo la misma fila, no una
 * sesión nueva que aparece de la nada. El tope absoluto se corre igual que
 * cuando era una sesión nueva.
 */
async function reemitir(auth) {
  const ahora = Date.now();
  const base = auth.type === 'employee'
    ? { type: 'employee', businessId: auth.businessId, employeeId: auth.employeeId, roleId: auth.roleId, permisos: auth.permisos }
    : { type: 'business', businessId: auth.businessId };
  await SesionCuenta.update(
    { venceEn: vencimientoAbsoluto(ahora), ultimaActividadEn: new Date(ahora) },
    { where: { sid: auth.sid, businessId: auth.businessId, cerradaEn: null } },
  );
  return crearSesion({ ...base, sid: auth.sid }, ahora);
}

/* ── Verificar (en cada pedido, desde requireAuth) ──────────────── */

/*
 * Qué se le contesta a un token cuya fila ya no lo deja pasar.
 *
 * Un código por motivo y no uno solo, porque la pantalla de entrar le explica
 * a la persona qué pasó, y "se cambió la contraseña" no es lo que hay que
 * decirle al dueño cuya sesión se cerró porque entró desde el celular.
 */
const RECHAZOS = {
  limite: {
    codigo: 'SESION_DESPLAZADA',
    message: 'Se cerró esta sesión porque se entró a la cuenta desde otro dispositivo y el plan tiene un máximo de dispositivos a la vez.',
  },
  password: {
    codigo: 'SESION_CERRADA',
    message: 'Se cambió la contraseña, así que se cerraron las sesiones abiertas. Volvé a entrar.',
  },
  'cerrar-todo': {
    codigo: 'SESION_CERRADA_REMOTA',
    message: 'Se cerraron todas las sesiones de la cuenta desde otro dispositivo. Volvé a entrar.',
  },
  remota: {
    codigo: 'SESION_CERRADA_REMOTA',
    message: 'Se cerró esta sesión desde otro dispositivo. Volvé a entrar.',
  },
  baja: {
    codigo: 'SESION_REVOCADA',
    message: 'Tu usuario ya no tiene acceso. Pedile al dueño de la cuenta que lo revise.',
  },
  // La cuenta bajó a un plan con menos usuarios y éste quedó afuera. No es
  // "ya no tenés acceso": vuelve solo si la cuenta sube, o si el dueño lo elige.
  plan: {
    codigo: 'SESION_SUSPENDIDA_PLAN',
    message: 'Tu usuario quedó suspendido porque la cuenta pasó a un plan con menos usuarios. Pedile al dueño que te habilite.',
  },
};
const RECHAZO_GENERICO = { codigo: 'SESION_FINALIZADA', message: 'Esta sesión ya terminó. Volvé a entrar.' };
const RECHAZO_VENCIDA = {
  codigo: 'SESION_FINALIZADA', message: 'La sesión alcanzó su duración máxima. Volvé a iniciar sesión.',
};

/*
 * Un token sin `sid` es de antes de que existiera la tabla.
 *
 * El dueño decidió que esos dejen de valer en el despliegue: no hay clientes
 * reales todavía, y adoptarlos con una fila al vuelo metería en la lista (y en
 * el conteo del límite) computadoras que nadie sabe reconocer. Volver a entrar
 * una vez es todo lo que cuesta.
 */
const RECHAZO_SIN_SID = {
  codigo: 'SESION_ANTERIOR',
  message: 'Actualizamos la forma de iniciar sesión. Volvé a entrar.',
};

/** La fila de la sesión del token, o null. */
function buscar(sid) {
  if (!sid || typeof sid !== 'string') return Promise.resolve(null);
  return SesionCuenta.findOne({ where: { sid } });
}

/**
 * Por qué esta fila NO deja pasar a este token, o null si lo deja.
 *
 * Además de abierta y vigente, la fila tiene que ser del mismo negocio, del
 * mismo tipo y del mismo empleado que dice el token. El token está firmado y
 * no debería poder contradecir a su fila; si lo hace, algo está muy mal y la
 * respuesta segura es no dejar pasar.
 */
function motivoDeRechazo(fila, auth, ahora = new Date()) {
  if (!fila) return RECHAZO_GENERICO;
  if (fila.businessId !== auth.businessId || fila.tipo !== auth.type) return RECHAZO_GENERICO;
  if (auth.type === 'employee' && fila.employeeId !== auth.employeeId) return RECHAZO_GENERICO;
  if (fila.cerradaEn) return RECHAZOS[fila.motivoCierre] || RECHAZO_GENERICO;
  if (new Date(fila.venceEn) <= ahora) return RECHAZO_VENCIDA;
  return null;
}

/*
 * Anota la última actividad, como mucho una vez por TOQUE_MS.
 *
 * Compara contra el valor ya leído en este mismo pedido: no cuesta otra
 * consulta. Si la escritura falla, el pedido sigue: es un dato para la lista,
 * no algo de lo que dependa la seguridad.
 */
async function tocar(fila, ahora = new Date()) {
  if (!fila) return false;
  if (new Date(ahora) - new Date(fila.ultimaActividadEn) < TOQUE_MS) return false;
  try {
    await SesionCuenta.update(
      { ultimaActividadEn: new Date(ahora) },
      { where: { id: fila.id, cerradaEn: null } },
    );
    return true;
  } catch (e) {
    log.warn('sesiones', 'no se pudo anotar la última actividad', { motivo: e.message });
    return false;
  }
}

/* ── Cerrar ────────────────────────────────────────────────────── */

/**
 * Cierra las sesiones abiertas que cumplan el filtro. Devuelve cuántas.
 *
 * El negocio es obligatorio y sale SIEMPRE de la sesión o del registro del
 * que se trata, nunca del pedido: un cierre sin negocio cerraría filas de
 * todas las cuentas.
 *
 * Cierra toda fila sin cerrar, aunque parezca vencida por inactividad. La
 * última actividad guardada puede atrasar (y si una escritura falló, atrasar
 * más); una sesión que en la base parece muerta podría estar viva, y en un
 * cambio de contraseña no hay margen para equivocarse de ese lado.
 *
 * Lo que NO cierra es una fila pasada de su tope absoluto. `venceEn` no
 * atrasa: es el `absExp` del token (reemitir mueve los dos juntos) y
 * requireAuth rechaza la fila en cuanto lo pasa, así que ningún token puede
 * volver a usarla. Cerrarla sólo le cambiaría la fecha: una sesión muerta
 * hace 80 días quedaba "cerrada hoy", volvía a aparecer en el historial de
 * 30 días y la purga, que cuenta 90 días desde el fin, guardaba su IP y su
 * navegador casi el doble de lo que dice la Política de Privacidad.
 */
async function cerrar({ businessId, tipo, employeeId, id, excepto, motivo, ahora = new Date(), transaction }) {
  if (!businessId) throw new Error('Cerrar sesiones exige el negocio.');
  if (!motivo) throw new Error('Cerrar sesiones exige un motivo.');
  const where = { businessId, cerradaEn: null, venceEn: { [Op.gt]: new Date(ahora) } };
  if (tipo) where.tipo = tipo;
  if (employeeId != null) where.employeeId = employeeId;
  if (id != null) where.id = id;
  if (excepto) where.sid = { [Op.ne]: excepto };
  const [cantidad] = await SesionCuenta.update(
    { cerradaEn: new Date(ahora), motivoCierre: motivo },
    { where, transaction },
  );
  return cantidad;
}

/*
 * El logout. Recibe el payload ya verificado (la firma sí, el vencimiento no:
 * ver utils/jwt.decodificarToken) y cierra su fila. Nunca tira: salir tiene
 * que funcionar aunque la base no conteste.
 *
 * Como en cerrar(): una fila pasada de su tope absoluto ya terminó y no se le
 * pone fecha de cierre.
 */
async function cerrarPorLogout(payload) {
  if (!payload?.sid || !payload.businessId) return 0;
  try {
    const ahora = new Date();
    const [cantidad] = await SesionCuenta.update(
      { cerradaEn: ahora, motivoCierre: 'usuario' },
      { where: { sid: payload.sid, businessId: payload.businessId, cerradaEn: null, venceEn: { [Op.gt]: ahora } } },
    );
    return cantidad;
  } catch (e) {
    log.warn('sesiones', 'no se pudo cerrar la sesión al salir', { motivo: e.message });
    return 0;
  }
}

/* ── Listar ────────────────────────────────────────────────────── */

const TEXTO_MOTIVO = {
  usuario: 'Se cerró con «Salir»',
  'cerrar-todo': 'Se cerraron todas las sesiones',
  remota: 'Se cerró desde otro dispositivo',
  password: 'Cambio de contraseña',
  limite: 'Se superó el máximo de dispositivos del plan',
  baja: 'El usuario se dio de baja',
  plan: 'El usuario quedó suspendido por el cambio de plan',
  vencida: 'Venció',
};

/*
 * Estado de una fila para la pantalla.
 *
 * Una fila sin cerrar puede estar igual muerta: venció por inactividad o por
 * el tope de 24 h y nadie la cerró, porque nadie tiene por qué. Y una que se
 * cerró DESPUÉS de haber muerto (un cambio de contraseña cierra todas las
 * abiertas) se muestra como vencida en su momento real, no como cerrada por
 * algo que pasó cuando ya no existía.
 */
function estadoDeFila(fila, ahora = new Date()) {
  const vida = finDeVida(fila);
  const cerrada = fila.cerradaEn ? new Date(fila.cerradaEn).getTime() : null;
  if (cerrada != null && cerrada <= vida) {
    return { estado: 'cerrada', motivo: fila.motivoCierre, fin: new Date(cerrada) };
  }
  if (cerrada != null || vida <= new Date(ahora).getTime()) {
    // El fin real, sin el minuto de margen que se usa para contar.
    const fin = Math.min(new Date(fila.venceEn).getTime(),
      new Date(fila.ultimaActividadEn).getTime() + IDLE_MS);
    return { estado: 'vencida', motivo: 'vencida', fin: new Date(fin) };
  }
  return { estado: 'activa', motivo: null, fin: null };
}

function aVista(fila, auth, estado) {
  const e = fila.empleado;
  return {
    id: fila.id,
    tipo: fila.tipo,
    // Para un empleado borrado no hay nombre que mostrar, pero la sesión
    // existió y se ve igual.
    empleado: fila.tipo === 'employee'
      ? (e ? { id: e.id, nombre: e.nombre, apellido: e.apellido } : { id: fila.employeeId, nombre: null, apellido: null })
      : null,
    dispositivo: fila.dispositivo,
    ip: fila.ip,
    creadaEn: fila.creadaEn,
    ultimaActividadEn: fila.ultimaActividadEn,
    venceEn: fila.venceEn,
    actual: fila.sid === auth.sid,
    /*
     * Un empleado desactivado no entra (requireAuth lo relee en cada pedido),
     * pero su sesión no se cierra: reactivarlo la devuelve. Mientras tanto se
     * marca, para que la lista no diga "activa" de alguien que no puede entrar.
     */
    suspendida: fila.tipo === 'employee' && e?.activo === false,
    // Y si fue por el plan: la pantalla no lo explica igual que un "desactivado".
    suspendidaPorPlan: fila.tipo === 'employee' && e?.activo === false && e?.suspendidoPorPlan === true,
    ...(estado.estado === 'activa' ? {} : {
      estado: estado.estado,
      cerradaEn: estado.fin,
      motivoCierre: estado.motivo,
      motivoTexto: TEXTO_MOTIVO[estado.motivo] || null,
    }),
  };
}

/**
 * Las sesiones activas y las que terminaron en los últimos 30 días.
 *
 * El dueño ve las de todo el negocio, las suyas y las de cada empleado: es su
 * cuenta y es quien decide quién entra. Un empleado ve SÓLO las suyas; las del
 * dueño dicen desde dónde y a qué hora entra, y eso no es asunto de nadie más.
 */
async function listar(auth, ahora = new Date()) {
  const desde = new Date(new Date(ahora).getTime() - HISTORIAL_DIAS * DIA);
  /*
   * Una fila cerrada entra si TERMINÓ en los últimos 30 días, y terminó en lo
   * primero que pasó: el cierre, el tope absoluto o la inactividad (la misma
   * cuenta que finDeVida). Mirar sólo cerradaEn mostraba sesiones muertas
   * hace meses que alguien "cerró" después —datos de antes de que cerrar()
   * dejara de tocarlas—.
   */
  const where = {
    businessId: auth.businessId,
    [Op.or]: [
      { cerradaEn: null, ultimaActividadEn: { [Op.gte]: desde } },
      {
        cerradaEn: { [Op.gte]: desde },
        venceEn: { [Op.gte]: desde },
        ultimaActividadEn: { [Op.gte]: new Date(desde.getTime() - IDLE_MS - TOQUE_MS) },
      },
    ],
  };
  if (auth.type !== 'business') {
    where.tipo = 'employee';
    where.employeeId = auth.employeeId;
  }

  const filas = await SesionCuenta.findAll({
    where,
    include: [{ model: Employee, as: 'empleado', attributes: ['id', 'nombre', 'apellido', 'activo', 'suspendidoPorPlan'], required: false }],
    order: [['ultimaActividadEn', 'DESC'], ['id', 'DESC']],
    limit: HISTORIAL_MAX + 1,
  });

  const sesiones = [];
  const historial = [];
  for (const fila of filas.slice(0, HISTORIAL_MAX)) {
    const estado = estadoDeFila(fila, ahora);
    (estado.estado === 'activa' ? sesiones : historial).push(aVista(fila, auth, estado));
  }
  // La de este dispositivo primero: es la referencia con la que se lee el resto.
  sesiones.sort((a, b) => Number(b.actual) - Number(a.actual));
  historial.sort((a, b) => new Date(b.cerradaEn) - new Date(a.cerradaEn));

  let limite = null;
  if (auth.type === 'business') {
    const tope = await topeDelDueno(auth.businessId);
    limite = {
      tope,
      modo: modoLimite(),
      activas: sesiones.filter((s) => s.tipo === 'business').length,
    };
  }

  return {
    actual: sesiones.find((s) => s.actual)?.id ?? null,
    limite,
    sesiones,
    historial,
    historialTruncado: filas.length > HISTORIAL_MAX,
  };
}

/** Cuántas sesiones del dueño hay activas ahora. Para el medidor del plan. */
function contarActivasDelDueno(businessId, ahora = new Date()) {
  return SesionCuenta.count({ where: { businessId, tipo: 'business', ...condicionActiva(ahora) } });
}

/* ── Purga ─────────────────────────────────────────────────────── */

/*
 * Borra las sesiones que terminaron hace más de 90 días.
 *
 * Una fila de sesión es un dato personal: IP, navegador, a qué hora entró
 * cada empleado. Se guarda lo que la Política de Privacidad dice y nada más.
 *
 * Los 90 días cuentan desde el FIN real de la sesión, que es lo primero que
 * pasó: el cierre, el tope absoluto o la inactividad (la cuenta de
 * finDeVida). Basta con que cualquiera de los tres sea anterior al límite.
 * Medir una fila cerrada sólo por cerradaEn guardaba de más a las que se
 * cerraron cuando ya estaban muertas; medir una abierta sólo por su tope,
 * hasta un día de más a la que quedó quieta mucho antes de llegar a él.
 */
async function purgar(ahora = new Date()) {
  const limite = new Date(new Date(ahora).getTime() - RETENCION_DIAS * DIA);
  let borradas = 0;
  try {
    borradas = await SesionCuenta.destroy({
      where: {
        [Op.or]: [
          { cerradaEn: { [Op.lt]: limite } },
          { venceEn: { [Op.lt]: limite } },
          { ultimaActividadEn: { [Op.lt]: new Date(limite.getTime() - IDLE_MS - TOQUE_MS) } },
        ],
      },
    });
    if (borradas) log.info('sesiones', `sesiones de hace más de ${RETENCION_DIAS} días purgadas: ${borradas}`);
  } catch (e) {
    log.warn('sesiones', 'no se pudo purgar el historial de sesiones', { motivo: e.message });
  }
  await purgarIngresosDeEmpleados(limite);
  return borradas;
}

/*
 * El registro viejo de ingresos de empleados (`employee_sessions`), con la
 * misma regla.
 *
 * Lo sigue escribiendo cada login de un empleado (IP, navegador y hora) para
 * la ficha del empleado, y no lo borraba nadie: la Política de Privacidad dice
 * que los registros de acceso se guardan 90 días y éstos quedaban para
 * siempre. Se mide por la última vez que se lo vio, que es cuando terminó.
 * Va aparte y con su propio try: si falla, no se lleva la otra purga.
 */
async function purgarIngresosDeEmpleados(limite) {
  try {
    const borrados = await EmployeeSession.destroy({ where: { lastSeenAt: { [Op.lt]: limite } } });
    if (borrados) log.info('sesiones', `ingresos de empleados de hace más de ${RETENCION_DIAS} días purgados: ${borrados}`);
    return borrados;
  } catch (e) {
    log.warn('sesiones', 'no se pudo purgar el registro de ingresos de empleados', { motivo: e.message });
    return 0;
  }
}

let relojPurga = null;
/*
 * Purga al arrancar y después una vez por día.
 *
 * Al arrancar sola no alcanzaba: un servidor que no se reinicia en meses
 * guardaría los registros de acceso mucho más de lo que promete la política.
 */
function programarPurga() {
  if (relojPurga) return;
  relojPurga = setInterval(() => { purgar(); }, DIA);
  relojPurga.unref?.();
}

module.exports = {
  abrir, reemitir, buscar, motivoDeRechazo, tocar, cerrar, cerrarPorLogout,
  listar, contarActivasDelDueno, purgar, programarPurga, modoLimite, condicionActiva,
  estadoDeFila,
  RECHAZO_SIN_SID, RECHAZOS, TOQUE_MS, HISTORIAL_DIAS, RETENCION_DIAS,
};
