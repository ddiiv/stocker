const { verifyToken } = require('../utils/jwt');
const { renovarSesion, sesionVigente } = require('../utils/session');
const { readAuthCookie, setAuthCookie } = require('../utils/authCookie');
const { motivoDeBloqueo } = require('./plan');
const { Business, Employee, EmployeeSession, Role } = require('../models');
const sesiones = require('../services/sesionesService');
const dosFactores = require('../services/dosFactoresService');

// El token vive en una cookie httpOnly. El header Bearer se sigue aceptando
// para clientes que no son el navegador (scripts, Postman) y para que las
// sesiones abiertas antes del cambio no se corten de golpe.
function extractToken(req) {
  const fromCookie = readAuthCookie(req);
  if (fromCookie) return fromCookie;
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

// req.auth = { type:'business'|'employee', businessId, sid, employeeId?, permisos?, roleId? }
// req.sesion = la fila de SesionCuenta de este token (ver sesionesService)
async function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ message: 'Token no proporcionado.' });

  try {
    // Si pasó la ventana de inactividad, el propio exp del token ya venció y
    // esto lanza: el corte no depende del navegador.
    req.auth = verifyToken(token);

    /*
     * El empleado se vuelve a leer de la base en cada pedido.
     *
     * Sin esto, quien manda es el token: los permisos y el estado del empleado
     * viajan firmados adentro y nunca se releen, así que desactivar a alguien
     * —o borrarlo— no le cortaba el acceso. Peor todavía, la ventana de
     * inactividad se renueva en cada pedido, así que un empleado que sigue
     * usando el sistema no llegaba nunca al corte: el único tope real eran las
     * 24 h del límite absoluto.
     *
     * En un local eso es concreto. Echás a alguien un viernes a la tarde y
     * hasta el sábado puede seguir facturando, moviendo stock y tocando la
     * caja desde su teléfono.
     *
     * Es una lectura por clave primaria con un join al cargo. Va antes de
     * renovar la cookie para que el token que se re-firma lleve los permisos
     * de ahora y no los del login.
     */
    /*
     * El dueño: ¿la cuenta cerró sus sesiones desde que ésta empezó?
     *
     * Es una lectura por clave primaria de dos columnas —medida en 0,7 ms— y
     * es la única forma de que un cambio de contraseña eche a quien ya está
     * adentro. Sin esto, cambiar la contraseña porque sospechás que te
     * entraron no echa a nadie: el intruso sigue con su cookie hasta el tope
     * de 24 h, que es justo lo contrario de lo que la persona cree que hizo.
     *
     * El empleado no paga esta consulta: su fila ya se relee acá abajo por
     * otro motivo, así que la comprobación va pegada a esa lectura.
     */
    /*
     * Sólo entran tokens de una sesión de la cuenta: del dueño o de un
     * empleado, con su negocio.
     *
     * Antes cualquier token firmado con el secreto pasaba por acá, y el
     * servidor firma más de una clase: el `state` del OAuth de Mercado Libre
     * lleva un businessId y servía como credencial para las rutas que sólo
     * piden requireAuth. Ahora cada sesión tiene su fila, y un token que no
     * es de sesión no tiene ninguna.
     */
    if ((req.auth.type !== 'business' && req.auth.type !== 'employee') || !req.auth.businessId) {
      return res.status(401).json({ message: 'Token inválido o expirado.' });
    }
    // Sin sid: emitido antes de que las sesiones tuvieran tabla. Ver
    // sesionesService.RECHAZO_SIN_SID.
    if (!req.auth.sid) {
      return res.status(401).json(sesiones.RECHAZO_SIN_SID);
    }

    /*
     * La fila de la sesión, en paralelo con la lectura del dueño o del
     * empleado que ya se hacía: es una lectura por índice único y no suma
     * latencia. Una fila cerrada —desde otro dispositivo, por el límite del
     * plan, por un cambio de contraseña, por "Salir"— deja afuera a su token
     * aunque el JWT siga firmado y vigente.
     */
    if (req.auth.type === 'business') {
      const [negocio, fila] = await Promise.all([
        Business.findByPk(req.auth.businessId, { attributes: ['id', 'sesionesDesde'] }),
        sesiones.buscar(req.auth.sid),
      ]);
      if (!negocio) {
        return res.status(401).json({ message: 'La cuenta ya no existe.', codigo: 'SESION_REVOCADA' });
      }
      const rechazo = sesiones.motivoDeRechazo(fila, req.auth);
      if (rechazo) return res.status(401).json(rechazo);
      req.sesion = fila;
      // La segunda llave: ver el modelo Business.sesionesDesde.
      if (!sesionVigente(req.auth, negocio.sesionesDesde)) {
        return res.status(401).json({
          message: 'Se cambió la contraseña de la cuenta, así que se cerraron las sesiones abiertas. Volvé a entrar.',
          codigo: 'SESION_CERRADA',
        });
      }
    }

    if (req.auth.type === 'employee') {
      const [empleado, fila] = await Promise.all([
        Employee.findByPk(req.auth.employeeId, {
          attributes: ['id', 'businessId', 'activo', 'roleId', 'sesionesDesde', 'suspendidoPorPlan'],
          include: [{ model: Role, as: 'cargo', attributes: ['id', 'permisos'] }],
        }),
        sesiones.buscar(req.auth.sid),
      ]);

      /*
       * Borrado, desactivado, o movido a otro negocio: en los tres casos la
       * sesión deja de valer. El mensaje es el mismo para los tres a
       * propósito: decir cuál de las tres cosas pasó es información sobre la
       * cuenta que no hace falta dar en un 401.
       */
      /*
       * Salvo el suspendido por el plan (la cuenta bajó a un plan con menos
       * usuarios): a él se le dice eso, que es algo que el dueño resuelve, y
       * no "ya no tenés acceso", que suena a que lo echaron.
       */
      if (empleado && !empleado.activo && empleado.suspendidoPorPlan &&
          empleado.businessId === req.auth.businessId) {
        return res.status(401).json(sesiones.RECHAZOS.plan);
      }
      if (!empleado || !empleado.activo || empleado.businessId !== req.auth.businessId) {
        return res.status(401).json({
          message: 'Tu usuario ya no tiene acceso. Pedile al dueño de la cuenta que lo revise.',
          codigo: 'SESION_REVOCADA',
        });
      }

      const rechazo = sesiones.motivoDeRechazo(fila, req.auth);
      if (rechazo) return res.status(401).json(rechazo);
      req.sesion = fila;

      // Le cambiaron la contraseña: las sesiones que esa contraseña había
      // abierto —en ésta y en cualquier otra computadora— dejan de valer.
      if (!sesionVigente(req.auth, empleado.sesionesDesde)) {
        return res.status(401).json({
          message: 'Se cambió la contraseña de tu usuario, así que se cerraron las sesiones abiertas. Volvé a entrar.',
          codigo: 'SESION_CERRADA',
        });
      }

      // Los permisos salen del cargo de ahora, no de los que tenía al entrar:
      // cambiarle el cargo a alguien surte efecto en el pedido siguiente.
      req.auth.permisos = empleado.cargo?.permisos || {};
      req.auth.roleId = empleado.roleId;
    }

    // Sesión deslizante: se corre la ventana de inactividad en cada pedido,
    // pero el tope absoluto viaja firmado y no se mueve. Si ya se cumplió,
    // renovarSesion devuelve null y hay que volver a autenticarse.
    // Sólo aplica a la cookie; con Bearer el cliente maneja su propio token.
    if (readAuthCookie(req)) {
      const renovado = renovarSesion(req.auth);
      if (!renovado) {
        return res.status(401).json({ message: 'La sesión alcanzó su duración máxima. Volvé a iniciar sesión.' });
      }
      setAuthCookie(res, renovado, req);
      if (req.auth.type === 'business') dosFactores.renovarMarca(req, res, req.auth.businessId);
    }

    // La última actividad de la fila, como mucho una vez por minuto.
    await sesiones.tocar(req.sesion);

    /*
     * Cuenta sin pagar: se puede leer, no escribir.
     *
     * Va acá y no en un r.use() del archivo de rutas porque ese corre antes que
     * este middleware, mirando un req.auth que todavía no existe. Con la lista
     * de exentas dentro de plan.js, el cliente siempre puede entrar, ver sus
     * datos y pagar.
     */
    const bloqueo = await motivoDeBloqueo(req);
    if (bloqueo) return res.status(402).json(bloqueo);

    // Última conexión y sesión más reciente: no bloquean el pedido.
    if (req.auth.type === 'employee' && req.auth.employeeId) {
      const now = new Date();
      Employee.update({ ultimaConexion: now }, { where: { id: req.auth.employeeId } }).catch(() => {});
      // Refrescar lastSeenAt sólo si la última sesión es de las últimas 12 horas
      EmployeeSession.findOne({
        where: { employeeId: req.auth.employeeId },
        order: [['lastSeenAt', 'DESC']],
      }).then((sess) => {
        if (sess && now - new Date(sess.lastSeenAt) < 12 * 60 * 60 * 1000) {
          sess.update({ lastSeenAt: now }).catch(() => {});
        }
      }).catch(() => {});
    }
    next();
  } catch (err) {
    /*
     * Un 401 dice "tu sesión no vale". Eso es cierto sólo si el token no
     * verifica; no lo es si la base no contestó a tiempo.
     *
     * El catch tapaba todo por igual, y desde que acá se relee al empleado eso
     * pasó a importar: con el pool saturado, la lectura falla y el cajero veía
     * "Token inválido o expirado" — o sea, lo echaba del sistema en el peor
     * momento, cuando hay cola en la caja. Se distingue: si el token estaba
     * bien, el problema es del servidor y se responde como tal.
     */
    if (req.auth) return next(err);
    res.status(401).json({ message: 'Token inválido o expirado.' });
  }
}

const { alcanza: alcanzaNivel } = require('../config/permisos');

/*
 * El dueño del negocio tiene acceso total a todo. No es un permiso que se le
 * conceda: es una condición de la cuenta, y por eso no figura en la matriz de
 * cargos ni se puede otorgar o quitar a un empleado.
 */
function esAdministradorTotal(auth) {
  return auth?.type === 'business';
}

function requirePermission(moduleKey, minLevel = 'ver') {
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ message: 'No autenticado.' });
    if (esAdministradorTotal(req.auth)) return next();
    if (alcanzaNivel(req.auth.permisos, moduleKey, minLevel)) return next();
    return res.status(403).json({ message: `Sin permiso de ${minLevel} en ${moduleKey}.` });
  };
}

// Para endpoints que alimentan pantallas de módulos distintos. Ej: la consulta
// de padrón AFIP la usan tanto la pantalla de clientes como la de CUITs del
// negocio; exigir un solo módulo dejaría afuera a la mitad de los roles.
function requireAnyPermission(modulos, minLevel = 'ver') {
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ message: 'No autenticado.' });
    if (esAdministradorTotal(req.auth)) return next();
    if (modulos.some((m) => alcanzaNivel(req.auth.permisos, m, minLevel))) return next();
    return res.status(403).json({ message: `Sin permiso de ${minLevel} en ${modulos.join(' o ')}.` });
  };
}

// Sólo el dueño del negocio. Para diagnóstico e infraestructura, que no
// corresponde a ningún módulo de permisos y no debería ver un empleado.
function requireOwner(req, res, next) {
  if (!req.auth) return res.status(401).json({ message: 'No autenticado.' });
  if (!esAdministradorTotal(req.auth))
    return res.status(403).json({ message: 'Sólo el dueño de la cuenta puede acceder a esto.' });
  next();
}

module.exports = { requireAuth, requirePermission, requireAnyPermission, requireOwner, esAdministradorTotal, extractToken };
