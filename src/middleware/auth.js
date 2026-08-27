const { verifyToken } = require('../utils/jwt');
const { renovarSesion } = require('../utils/session');
const { readAuthCookie, setAuthCookie } = require('../utils/authCookie');
const { motivoDeBloqueo } = require('./plan');
const { Employee, EmployeeSession, Role } = require('../models');

// El token vive en una cookie httpOnly. El header Bearer se sigue aceptando
// para clientes que no son el navegador (scripts, Postman) y para que las
// sesiones abiertas antes del cambio no se corten de golpe.
function extractToken(req) {
  const fromCookie = readAuthCookie(req);
  if (fromCookie) return fromCookie;
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

// req.auth = { type:'business'|'employee', businessId, employeeId?, permisos?, roleId? }
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
    if (req.auth.type === 'employee' && req.auth.employeeId) {
      const empleado = await Employee.findByPk(req.auth.employeeId, {
        attributes: ['id', 'businessId', 'activo', 'roleId'],
        include: [{ model: Role, as: 'cargo', attributes: ['id', 'permisos'] }],
      });

      /*
       * Borrado, desactivado, o movido a otro negocio: en los tres casos la
       * sesión deja de valer. El mensaje es el mismo para los tres a
       * propósito: decir cuál de las tres cosas pasó es información sobre la
       * cuenta que no hace falta dar en un 401.
       */
      if (!empleado || !empleado.activo || empleado.businessId !== req.auth.businessId) {
        return res.status(401).json({
          message: 'Tu usuario ya no tiene acceso. Pedile al dueño de la cuenta que lo revise.',
          codigo: 'SESION_REVOCADA',
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
    }

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

module.exports = { requireAuth, requirePermission, requireAnyPermission, requireOwner, esAdministradorTotal };
