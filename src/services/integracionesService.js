/*
 * Credenciales para sistemas, no para personas.
 *
 * Un sistema de afuera —hoy ISUWAYA, el portal de pedidos mayoristas— necesita
 * poder escribir en Stocker sin que haya nadie sentado adelante. La sesión de
 * una persona no sirve: se corta a los 30 minutos de inactividad, se revoca
 * cuando el dueño cambia la contraseña y con doble factor no se puede renovar
 * sola. Una integración que se apaga sin avisar pierde pedidos en silencio,
 * que es la peor forma de fallar.
 *
 * El token se genera acá, se muestra UNA vez y se guarda hasheado. Lo que se
 * conserva en claro son los últimos caracteres, para poder decir "es el que
 * termina en 9f2c" sin poder reconstruirlo.
 */

const crypto = require('crypto');
const { IntegracionExterna } = require('../models');

// 32 bytes de azar. No hay diccionario que probar contra esto, así que SHA-256
// alcanza y bcrypt sólo costaría tiempo en cada pedido que entra.
const BYTES = 32;
const ORIGENES = ['isuwaya'];

const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

const error = (mensaje, status = 400) => Object.assign(new Error(mensaje), { status });

/**
 * Crea una credencial y devuelve el token EN CLARO por única vez.
 *
 * Si el negocio ya tenía una para ese origen, la vieja se desactiva: dos
 * credenciales vivas para el mismo puente son dos cosas que revocar el día que
 * haya que revocar, y nadie se acuerda de la segunda.
 */
async function emitir({ businessId, origen, nombre = null }) {
  const cual = String(origen || '').toLowerCase();
  if (!ORIGENES.includes(cual)) {
    throw error(`Origen desconocido: ${origen}. Los válidos son ${ORIGENES.join(', ')}.`);
  }
  if (!businessId) throw error('Falta el negocio.');

  await IntegracionExterna.update(
    { activa: false },
    { where: { businessId, origen: cual, activa: true } },
  );

  const token = crypto.randomBytes(BYTES).toString('base64url');
  const integracion = await IntegracionExterna.create({
    businessId,
    origen: cual,
    nombre,
    tokenHash: hash(token),
    pista: token.slice(-6),
    activa: true,
  });
  return { token, integracion };
}

/**
 * Quién es el que golpea la puerta, o null.
 *
 * Devuelve la integración —y con ella el negocio— o null. Nunca dice por qué
 * falló: a quien no tiene la credencial no se le explica si el token no existe
 * o si está desactivado.
 */
async function verificar(token) {
  const limpio = String(token || '').trim();
  if (!limpio) return null;
  const fila = await IntegracionExterna.findOne({ where: { tokenHash: hash(limpio), activa: true } });
  if (!fila) return null;
  /*
   * El último uso se guarda sin esperar a que termine.
   *
   * Es un dato para mirar en una pantalla, no algo de lo que dependa el
   * pedido: si la escritura falla, el pedido tiene que entrar igual.
   */
  fila.update({ ultimoUsoEn: new Date() }).catch(() => {});
  return fila;
}

/** Las credenciales de un negocio, sin nada que permita reconstruir el token. */
async function listar(businessId) {
  const filas = await IntegracionExterna.findAll({
    where: { businessId },
    attributes: ['id', 'origen', 'nombre', 'pista', 'activa', 'ultimoUsoEn', 'createdAt'],
    order: [['id', 'DESC']],
  });
  return filas.map((f) => f.toJSON());
}

/** Corta el puente. No se borra la fila: sirve para saber qué hubo. */
async function revocar({ businessId, id }) {
  const fila = await IntegracionExterna.findOne({ where: { id, businessId } });
  if (!fila) throw error('Esa credencial no existe.', 404);
  await fila.update({ activa: false });
  return { ok: true };
}

module.exports = { emitir, verificar, listar, revocar, ORIGENES, __hash: hash };
