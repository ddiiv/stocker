const { verifyToken } = require('../utils/jwt');
const { Employee, EmployeeSession } = require('../models');

// req.auth = { type:'business'|'employee', businessId, employeeId?, permisos?, roleId? }
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Token no proporcionado.' });

  try {
    req.auth = verifyToken(token);

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

module.exports = { requireAuth, requirePermission };
