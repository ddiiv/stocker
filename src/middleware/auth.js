const { verifyToken } = require('../utils/jwt');
const { renovarSesion } = require('../utils/session');
const { readAuthCookie, setAuthCookie } = require('../utils/authCookie');
const { Employee, EmployeeSession } = require('../models');

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

    // Actualiza última conexión del empleado y su sesión más reciente (sin bloquear el request)
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
  } catch {
    res.status(401).json({ message: 'Token inválido o expirado.' });
  }
}

const LEVELS = { ninguno: 0, ver: 1, editar: 2 };

function requirePermission(moduleKey, minLevel = 'ver') {
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ message: 'No autenticado.' });
    if (req.auth.type === 'business') return next(); // dueño tiene acceso total
    const level = req.auth.permisos?.[moduleKey] || 'ninguno';
    if (LEVELS[level] >= LEVELS[minLevel]) return next();
    return res.status(403).json({ message: `Sin permiso de ${minLevel} en ${moduleKey}.` });
  };
}

// Para endpoints que alimentan pantallas de módulos distintos. Ej: la consulta
// de padrón AFIP la usan tanto la pantalla de clientes (ventas) como la de
// CUITs del negocio (facturación); exigir un solo módulo dejaría afuera a la
// mitad de los roles legítimos.
function requireAnyPermission(modulos, minLevel = 'ver') {
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ message: 'No autenticado.' });
    if (req.auth.type === 'business') return next();
    const alcanza = modulos.some(
      (m) => LEVELS[req.auth.permisos?.[m] || 'ninguno'] >= LEVELS[minLevel]
    );
    if (alcanza) return next();
    return res.status(403).json({ message: `Sin permiso de ${minLevel} en ${modulos.join(' o ')}.` });
  };
}

// Sólo el dueño del negocio. Para diagnóstico e infraestructura, que no
// corresponde a ningún módulo de permisos y no debería ver un empleado.
function requireOwner(req, res, next) {
  if (!req.auth) return res.status(401).json({ message: 'No autenticado.' });
  if (req.auth.type !== 'business')
    return res.status(403).json({ message: 'Sólo el dueño de la cuenta puede acceder a esto.' });
  next();
}

module.exports = { requireAuth, requirePermission, requireAnyPermission, requireOwner };
