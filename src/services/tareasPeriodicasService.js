/*
 * Lo que Stocker hace solo, cada tanto.
 *
 * Hoy hay una sola tarea: el barrido de stock hacia Mercado Libre. Vive acá y
 * no suelta en index.js para que la próxima tenga un lugar obvio donde ir, y
 * para que se pueda arrancar y parar entera en las pruebas.
 *
 * ── Por qué un barrido, si el aviso ya es inmediato ───────────────
 *
 * Cada movimiento de stock avisa a Mercado Libre en el momento. Eso cubre el
 * caso normal y es lo que mantiene la publicación al día en segundos. Pero ese
 * aviso vive en la memoria del proceso: un deploy de Railway en el medio se lo
 * lleva, y un fallo puntual —el token venció, ML devolvió 500— se registra en
 * el log y se descarta sin reintento.
 *
 * El barrido es la red debajo de eso. Compara lo que hay en Stocker contra lo
 * que dice cada publicación y manda SÓLO lo que difiere: si el aviso inmediato
 * hizo su trabajo, el barrido no manda nada y cuesta una lectura. Si se perdió,
 * lo corrige como mucho quince minutos después.
 *
 * ── Lo que este diseño NO cubre ───────────────────────────────────
 *
 * Con más de una instancia del backend, el barrido corre en todas. No rompe
 * nada —cada una manda las mismas diferencias, y la segunda no encuentra
 * ninguna— pero gasta llamadas a la API de ML al pedo. Si algún día se escala
 * a varias instancias, esto necesita un candado en la base.
 */

const ml = require('./mercadolibreService');
const postventa = require('./mercadolibrePostventaService');
const mlPedidos = require('./mercadolibrePedidosService');
const { MercadoLibreAccount } = require('../models');
const { log } = require('../utils/logger');

/*
 * Quince minutos: es lo que se eligió sabiendo que el aviso inmediato hace casi
 * todo el trabajo. Cada barrido lista el catálogo del vendedor, así que bajarlo
 * a un minuto multiplicaría esa lectura por quince sin ganar casi nada.
 */
const INTERVALO_MS = Number(process.env.ML_BARRIDO_MS) || 15 * 60 * 1000;

/*
 * El primero no sale apenas arranca el proceso.
 *
 * Un deploy reinicia el backend, y arrancar el barrido en el mismo segundo lo
 * hace competir con el arranque —conexión a la base, verificación de esquema—
 * justo cuando el servicio todavía está tomando las primeras peticiones.
 */
const DEMORA_INICIAL_MS = 60 * 1000;

let timer = null;
let corriendo = false;

/**
 * Un barrido: cada cuenta conectada y con sincronización activa.
 *
 * Devuelve un resumen para que las pruebas puedan comprobar qué hizo sin leer
 * el log.
 */
async function barrerStockMl() {
  if (!ml.estaConfigurado()) {
    return { cuentas: 0, actualizados: 0, fallaron: 0, mensajesNuevos: 0, reclamosNuevos: 0 };
  }

  /*
   * Sólo cuentas con refresh token: sin él la renovación no puede funcionar y
   * el barrido escribiría el mismo error cada quince minutos para siempre.
   */
  const cuentas = await MercadoLibreAccount.findAll({ where: { syncActiva: true } });
  const conectadas = cuentas.filter((c) => c.refreshToken);

  let actualizados = 0;
  let fallaron = 0;
  let mensajesNuevos = 0;
  let reclamosNuevos = 0;
  let enviosCambiados = 0;

  for (const cuenta of conectadas) {
    /*
     * Los mensajes y los reclamos van en su propio try.
     *
     * Son la parte más frágil: si a la app de ML le falta el permiso, esto
     * falla siempre. Compartiendo el try con el stock, ese permiso faltante
     * dejaría de sincronizar el stock también — que es lo que hace que se venda
     * lo que no está.
     */
    try {
      const post = await postventa.barrer(cuenta);
      mensajesNuevos += post.mensajesNuevos || 0;
      reclamosNuevos += post.reclamos?.nuevos || 0;
      if (post.mensajesNuevos || post.reclamos?.nuevos) {
        log.info('ml-postventa', 'barrido periódico', {
          businessId: cuenta.businessId,
          mensajes: post.mensajesNuevos, reclamos: post.reclamos?.nuevos,
        });
      }
    } catch (e) {
      if (e.codigo === 'ML_SIN_PERMISO') {
        await cuenta.update({ ultimoError: e.message.slice(0, 400) }).catch(() => {});
      }
      log.warn('ml-postventa', 'el barrido de posventa falló', {
        businessId: cuenta.businessId, motivo: e.message?.slice(0, 200),
      });
    }

    /*
     * Los envíos, contra Mercado Libre. En su propio try por lo mismo que la
     * posventa: que falle esto no puede frenar el stock publicado.
     *
     * Es lo que hace que un aviso perdido se corrija solo. Sin esto, un envío
     * que ML despachó o canceló y cuyo aviso no llegó quedaba como estaba
     * hasta que alguien abriera Envíos del Día.
     */
    try {
      const envios = await mlPedidos.reconciliarEnvios(cuenta.businessId);
      if (!envios.omitido) {
        enviosCambiados += Object.values(envios.cambios || {}).reduce((n, x) => n + (Number(x) || 0), 0);
      }
    } catch (e) {
      log.warn('ml-reconciliacion', 'el barrido de envíos falló', {
        businessId: cuenta.businessId, motivo: e.message?.slice(0, 200),
      });
    }

    try {
      const r = await ml.sincronizarStock(cuenta.businessId);
      actualizados += r.resumen?.actualizados || 0;
      if (r.resumen?.actualizados) {
        log.info('mercadolibre', 'barrido periódico', {
          businessId: cuenta.businessId, actualizados: r.resumen.actualizados,
        });
      }
    } catch (e) {
      fallaron += 1;
      /*
       * El error queda guardado en la cuenta, no sólo en el log.
       *
       * Es lo que la sección de Mercado Libre muestra. Un token vencido no se
       * arregla solo y puede pasar días sin sincronizar: en el log del servidor
       * eso no lo ve nadie, y el stock publicado se va quedando viejo en
       * silencio mientras se sigue vendiendo contra él.
       */
      await cuenta.update({
        ultimoError: `Sincronización automática: ${String(e.message).slice(0, 400)}`,
      }).catch(() => { /* si ni eso se puede escribir, queda el log */ });
      log.warn('mercadolibre', 'el barrido periódico falló', {
        businessId: cuenta.businessId, motivo: e.message?.slice(0, 200),
      });
    }
  }

  return { cuentas: conectadas.length, actualizados, fallaron, mensajesNuevos, reclamosNuevos, enviosCambiados };
}

/*
 * Una corrida por vez.
 *
 * Con doscientas publicaciones por cuenta y varias cuentas, un barrido puede
 * durar más que el intervalo. Sin este freno se irían encimando, cada uno
 * pidiéndole a ML lo mismo que el anterior todavía está pidiendo.
 */
async function tick() {
  if (corriendo) {
    log.warn('mercadolibre', 'el barrido anterior sigue corriendo: se saltea este turno', {});
    return;
  }
  corriendo = true;
  try {
    await barrerStockMl();
  } catch (e) {
    log.warn('mercadolibre', 'el barrido periódico se cayó entero', { motivo: e.message });
  } finally {
    corriendo = false;
  }
}

/** Arranca las tareas. Se llama una vez, desde index.js. */
function arrancar() {
  if (timer) return false;
  if (!ml.estaConfigurado()) {
    console.log('  Barrido de stock a Mercado Libre .. apagado (falta configurar la app)');
    return false;
  }
  if (process.env.ML_BARRIDO === 'off') {
    console.log('  Barrido de stock a Mercado Libre .. apagado por ML_BARRIDO=off');
    return false;
  }

  timer = setTimeout(function primero() {
    tick();
    timer = setInterval(tick, INTERVALO_MS);
    // Que una tarea pendiente no impida cerrar el proceso en un deploy.
    timer.unref?.();
  }, DEMORA_INICIAL_MS);
  timer.unref?.();

  console.log(`  Barrido de stock a Mercado Libre .. cada ${Math.round(INTERVALO_MS / 60000)} min`);
  return true;
}

/** Para las tareas. Lo usan las pruebas y un apagado ordenado. */
function parar() {
  if (!timer) return;
  clearTimeout(timer);
  clearInterval(timer);
  timer = null;
}

module.exports = { arrancar, parar, barrerStockMl, INTERVALO_MS };
