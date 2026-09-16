/*
 * Trabajos largos, fuera del pedido HTTP.
 *
 * Sincronizar novecientos productos con variantes son miles de escrituras: a
 * un cuarto de segundo cada una, minutos. Adentro del pedido eso termina en
 * "la aplicación no respondió" —el proxy lo corta—, y el trabajo se pierde a
 * mitad de camino sin que nadie sepa qué alcanzó a mandarse.
 *
 * Acá el pedido arranca el trabajo y contesta en el acto; la pantalla pregunta
 * cómo viene. Vive en la memoria del proceso: si el servidor se reinicia, el
 * trabajo se pierde y se vuelve a arrancar. Es a propósito: una cola con base
 * de datos es otra cosa, y para esto —un botón que alguien apretó y está
 * mirando— alcanza con esto.
 */

const { log } = require('../utils/logger');

// Un trabajo terminado se guarda un rato para que la pantalla lo lea.
const VIDA_TERMINADO_MS = Number(process.env.TRABAJOS_VIDA_MS) || 30 * 60 * 1000;

// clave → trabajo
const trabajos = new Map();

function limpiarViejos() {
  const ahora = Date.now();
  for (const [clave, t] of trabajos) {
    if (t.estado !== 'corriendo' && ahora - (t.terminado || 0) > VIDA_TERMINADO_MS) {
      trabajos.delete(clave);
    }
  }
}

/** Lo que ve la pantalla: el trabajo sin las partes internas. */
function publico(t) {
  if (!t) return { estado: 'ninguno' };
  return {
    id: t.id,
    estado: t.estado,
    iniciado: t.iniciado,
    terminado: t.terminado,
    progreso: t.progreso,
    resultado: t.estado === 'listo' ? t.resultado : null,
    error: t.error,
  };
}

/**
 * Arranca un trabajo con esta clave. Si ya hay uno corriendo, devuelve ese:
 * dos sincronizaciones del mismo negocio a la vez se pisarían.
 *
 * `fn` recibe una función para ir contando el avance.
 */
function iniciar(clave, fn) {
  limpiarViejos();
  const actual = trabajos.get(clave);
  if (actual?.estado === 'corriendo') return publico(actual);

  const trabajo = {
    id: `${clave}:${Date.now()}`,
    clave,
    estado: 'corriendo',
    iniciado: Date.now(),
    terminado: null,
    progreso: {},
    resultado: null,
    error: null,
  };
  trabajos.set(clave, trabajo);

  /*
   * Sin await: el pedido que lo arrancó ya contestó. Todo error queda adentro
   * del trabajo, que es donde la pantalla lo va a leer.
   */
  Promise.resolve()
    .then(() => fn((avance) => { trabajo.progreso = { ...trabajo.progreso, ...avance }; }))
    .then((resultado) => { trabajo.estado = 'listo'; trabajo.resultado = resultado; })
    .catch((e) => {
      trabajo.estado = 'error';
      trabajo.error = String(e?.message || e).slice(0, 500);
      log.warn('trabajos', 'un trabajo terminó con error', { clave, motivo: trabajo.error });
    })
    .finally(() => { trabajo.terminado = Date.now(); });

  return publico(trabajo);
}

/** Cómo viene el trabajo de esa clave. */
const estado = (clave) => publico(trabajos.get(clave));

/** Para las pruebas: esperar a que termine. */
async function esperar(clave, { tope = 60000 } = {}) {
  const desde = Date.now();
  for (;;) {
    const t = trabajos.get(clave);
    if (!t || t.estado !== 'corriendo') return publico(t);
    if (Date.now() - desde > tope) throw new Error(`El trabajo ${clave} no terminó a tiempo.`);
    await new Promise((listo) => setTimeout(listo, 20));
  }
}

module.exports = { iniciar, estado, esperar };
