const crypto = require('crypto');
const jwt = require('jsonwebtoken');

/*
 * El secreto de firma no puede tener un valor por defecto conocido: quien lea
 * el repositorio podría firmar un token con cualquier businessId y entrar como
 * cualquier negocio. Antes había un fallback literal, así que un deploy que se
 * olvidara de setear JWT_SECRET arrancaba igual y quedaba abierto en silencio.
 *
 * En producción ahora el proceso no levanta sin la variable. En desarrollo se
 * genera un secreto al azar por arranque — sirve para trabajar, y como cambia
 * en cada reinicio deja claro que no es apto para producción.
 */
function resolverSecreto() {
  const desdeEnv = process.env.JWT_SECRET;

  if (desdeEnv && desdeEnv.length >= 32) return desdeEnv;

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      desdeEnv
        ? 'JWT_SECRET es demasiado corto: usá al menos 32 caracteres aleatorios.'
        : 'Falta JWT_SECRET. Generá uno con: openssl rand -base64 48'
    );
  }

  if (desdeEnv) {
    console.warn('[jwt] JWT_SECRET tiene menos de 32 caracteres. En producción esto aborta el arranque.');
    return desdeEnv;
  }

  console.warn('[jwt] Sin JWT_SECRET: se generó uno efímero para esta sesión. Las sesiones se caen en cada reinicio.');
  return crypto.randomBytes(48).toString('base64');
}

const SECRET     = resolverSecreto();
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

function signToken(payload, options = {}) {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN, ...options });
}

function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

/*
 * La firma sí, el vencimiento no. Para el logout y nada más.
 *
 * Quien aprieta "Salir" después de media hora sin tocar nada tiene el token
 * vencido, y con verifyToken el logout no sabría qué sesión cerrar: la fila
 * quedaría abierta en la lista de la cuenta. La firma se sigue exigiendo, así
 * que nadie puede cerrar una sesión ajena inventándose un token.
 *
 * Devuelve null en vez de tirar: un logout nunca falla.
 */
function decodificarToken(token) {
  try {
    return jwt.verify(token, SECRET, { ignoreExpiration: true });
  } catch {
    return null;
  }
}

module.exports = { signToken, verifyToken, decodificarToken };
