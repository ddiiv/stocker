const { PlatformAdmin } = require('../models');

/*
 * Sesión de operador de la plataforma.
 *
 * Deliberadamente separada de `requireAuth`: la sesión de un dueño y la de un
 * operador de Stocker no son intercambiables. Un token de negocio no puede
 * abrir el backoffice ni con el `type` correcto, porque acá se exige que
 * exista la fila en `platform_admins` y que siga activa.
 *
 * Se relee el admin en cada pedido en vez de confiar en lo que viaja firmado:
 * desactivar una cuenta tiene que cortar el acceso en el momento, no cuando
 * venza el token que ya se emitió.
 */

const { verifyToken } = require('../utils/jwt');
const { renovarSesion } = require('../utils/session');
const { readAuthCookie, setAuthCookie } = require('../utils/authCookie');

function extraerToken(req) {
  const cookie = readAuthCookie(req);
  if (cookie) return cookie;
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

async function requirePlatformAdmin(req, res, next) {
  const token = extraerToken(req);
  if (!token) return res.status(401).json({ message: 'Sesión no iniciada.' });

  try {
    const payload = verifyToken(token);
    if (payload.type !== 'platform' || !payload.platformAdminId) {
      return res.status(403).json({ message: 'Esta sesión no tiene acceso al backoffice.' });
    }

    const admin = await PlatformAdmin.findByPk(payload.platformAdminId);
    if (!admin || !admin.activo) {
      return res.status(401).json({ message: 'La cuenta de operador no está habilitada.' });
    }

    if (readAuthCookie(req)) {
      const renovado = renovarSesion(payload);
      if (!renovado) {
        return res.status(401).json({ message: 'La sesión alcanzó su duración máxima. Volvé a entrar.' });
      }
      setAuthCookie(res, renovado, req);
    }

    req.auth = payload;
    req.admin = admin;
    next();
  } catch {
    return res.status(401).json({ message: 'Sesión inválida o vencida.' });
  }
}

/** Sólo el superusuario. Se usa para lo que no debe poder hacer soporte. */
function requireSuperuser(req, res, next) {
  if (req.admin?.rol !== 'superuser') {
    return res.status(403).json({ message: 'Reservado al superusuario.' });
  }
  next();
}

module.exports = { requirePlatformAdmin, requireSuperuser };
