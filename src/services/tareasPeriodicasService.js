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
const jumpseller = require('./jumpsellerService');
const arca = require('./arcaService');
const postventa = require('./mercadolibrePostventaService');
const mlPedidos = require('./mercadolibrePedidosService');
const cola = require('./colaVentasOnlineService');
const { MercadoLibreAccount, JumpsellerAccount } = require('../models');
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
 * ── Las ventas de Jumpseller, que no entran solas ─────────────────
 *
 * Mercado Libre avisa por webhook y además el barrido busca órdenes nuevas, así
 * que una venta de ML entra sola. Jumpseller no: `importarPedidos` existía desde
 * siempre pero el único que la llamaba era el botón de la pantalla. Una venta de
 * Jumpseller no apartaba stock hasta que alguien se acordaba de apretarlo, y
 * mientras tanto esa prenda seguía ofreciéndose en el mostrador, en Mercado Libre
 * y en la tienda. Es la diferencia entre vender dos veces la última unidad y no.
 *
 * La ventana es corta a propósito. El barrido corre cada quince minutos, así que
 * dos días de margen cubren de sobra una tienda que estuvo caída un rato, sin
 * recorrer un año de órdenes en cada vuelta. Para traer lo viejo está el botón,
 * que acepta hasta 365 días.
 *
 * Correrlo de más no cuesta ni descuenta dos veces: los pedidos entran por la
 * cola de ventas online, que es idempotente por (negocio, plataforma, número de
 * pedido) y lo tiene respaldado con un índice único en la base. Un pedido ya
 * importado vuelve como `repetido` y no aparta nada.
 */
const JUMPSELLER_DIAS_BARRIDO = Number(process.env.JUMPSELLER_DIAS_BARRIDO) || 2;

async function barrerPedidosJumpseller() {
  const cuentas = await JumpsellerAccount.findAll({ where: { syncActiva: true } });
  let importados = 0;
  let fallaron = 0;

  for (const cuenta of cuentas) {
    try {
      const r = await jumpseller.importarPedidos(cuenta.businessId, {
        dias: JUMPSELLER_DIAS_BARRIDO, tope: 200,
      });
      importados += r.importados || 0;
      /*
       * Sólo se anota cuando entró algo. En una tienda con poco movimiento esto
       * corre noventa y seis veces por día sin encontrar nada, y un log por vuelta
       * tapa lo que sí importa.
       */
      if (r.importados) {
        log.info('jumpseller', 'ventas nuevas importadas por el barrido', {
          businessId: cuenta.businessId,
          importados: r.importados,
          sinStock: r.sinStock || 0,
          conAvisos: r.conAvisos || 0,
        });
      }
      /*
       * Una venta que no pudo apartar stock es lo que alguien tiene que mirar hoy,
       * no mañana: la tienda ya le cobró al cliente.
       */
      if (r.sinStock) {
        log.warn('jumpseller', 'ventas que entraron sin poder apartar stock', {
          businessId: cuenta.businessId, sinStock: r.sinStock,
        });
      }
    } catch (e) {
      fallaron += 1;
      log.warn('jumpseller', 'no se pudieron importar las ventas', {
        businessId: cuenta.businessId, motivo: e.message,
      });
    }
  }
  return { cuentas: cuentas.length, importados, fallaron };
}
/*
 * El mismo barrido para Jumpseller.
 *
 * Va aparte del de Mercado Libre y con su propio try: son dos tiendas
 * distintas, y que una esté caída o con la clave vencida no puede dejar sin
 * sincronizar a la otra.
 */
async function barrerStockJumpseller() {
  const cuentas = await JumpsellerAccount.findAll({ where: { syncActiva: true } });
  let actualizados = 0;
  let fallaron = 0;

  for (const cuenta of cuentas) {
    try {
      const r = await jumpseller.sincronizarStock(cuenta.businessId);
      actualizados += r.resumen?.actualizados || 0;
      if (r.resumen?.actualizados) {
        log.info('jumpseller', 'barrido periódico', {
          businessId: cuenta.businessId, actualizados: r.resumen.actualizados,
        });
      }
    } catch (e) {
      fallaron += 1;
      /*
       * El error queda en la tienda, no sólo en el log: una clave que dejó de
       * andar no se arregla sola, y la pantalla de Jumpseller es donde alguien
       * lo va a ver.
       */
      try {
        await cuenta.update({ ultimoError: String(e.message || e).slice(0, 500) });
      } catch { /* si ni eso se puede guardar, queda el log */ }
      log.warn('jumpseller', 'el barrido falló', {
        businessId: cuenta.businessId, motivo: String(e.message || e).slice(0, 200),
      });
    }
  }
  return { cuentas: cuentas.length, actualizados, fallaron };
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
    if (process.env.ML_BARRIDO !== 'off') await barrerStockMl();
  } catch (e) {
    log.warn('mercadolibre', 'el barrido periódico se cayó entero', { motivo: e.message });
  }
  try {
    if (process.env.JUMPSELLER_BARRIDO !== 'off') await barrerStockJumpseller();
  } catch (e) {
    log.warn('jumpseller', 'el barrido periódico se cayó entero', { motivo: e.message });
  }
  /*
   * Las ventas de Jumpseller, en su propio try.
   *
   * Va aparte del barrido de stock de la misma tienda: que no se pueda publicar
   * una cantidad no es razón para no traer una venta que ya ocurrió, y al revés
   * tampoco.
   */
  try {
    if (process.env.JUMPSELLER_PEDIDOS !== 'off') await barrerPedidosJumpseller();
  } catch (e) {
    log.warn('jumpseller', 'la importación periódica de ventas se cayó entera', { motivo: e.message });
  }
  /*
   * Las delegaciones de ARCA: sale del TA que ya está cacheado 12 horas, así
   * que mirarlo en cada vuelta no le agrega ni un pedido a AFIP. Es lo que
   * hace que una delegación recién aceptada se active sola y que una revocada
   * se vea el mismo día.
   */
  try {
    if (process.env.ARCA_DELEGACIONES !== 'off') await arca.sincronizarTodasLasDelegaciones();
  } catch (e) {
    log.warn('arca', 'el barrido de delegaciones se cayó entero', { motivo: e.message });
  }
  /*
   * Los pedidos online que quedaron a mitad de camino.
   *
   * Es la red debajo de la cola: una fila 'pendiente' significa que la venta
   * entró y el stock no se apartó. Hasta que alguien la procese, el inventario
   * sigue ofreciendo mercadería vendida, y esa fila no aparece en ninguna
   * pantalla —Envíos del Día sólo lista aceptado y parcial—. Si la plataforma
   * reenvía, se arregla sola en el reenvío; si no reenvía, se arregla acá.
   *
   * Cuesta una consulta por vuelta cuando no hay nada colgado, que es siempre.
   */
  try {
    if (process.env.COLA_RESCATE !== 'off') await cola.rescatarPendientes();
  } catch (e) {
    log.warn('cola-online', 'el rescate de pendientes se cayó entero', { motivo: e.message });
  }
  /*
   * Los pedidos a los que se les venció el plazo de pago.
   *
   * Es la contracara de guardar el pago pendiente: mientras un pedido espera, la
   * mercadería está apartada y ya no está en la vidriera. La plataforma dice que
   * va a cancelar cuando el plazo venza, y seguramente lo haga; esto es para el
   * día que no lo haga, porque si no esa reserva queda para siempre y el stock
   * desaparece sin que nadie sepa por qué.
   */
  try {
    if (process.env.PAGO_VENCIMIENTO !== 'off') await cola.liberarPagosVencidos();
  } catch (e) {
    log.warn('cola-online', 'la liberación de pagos vencidos se cayó entera', { motivo: e.message });
  } finally {
    corriendo = false;
  }
}

/** Arranca las tareas. Se llama una vez, desde index.js. */
function arrancar() {
  if (timer) return false;
  /*
   * El barrido arranca aunque Mercado Libre no esté configurado: ahora también
   * sincroniza Jumpseller, y un negocio puede tener una tienda y no la otra.
   */
  const conMl = ml.estaConfigurado() && process.env.ML_BARRIDO !== 'off';
  const conJumpseller = process.env.JUMPSELLER_BARRIDO !== 'off';
  /*
   * Las delegaciones de AFIP cuelgan del mismo reloj, pero no del mismo
   * motivo: un negocio puede facturar sin tener ninguna tienda online. Si esto
   * no entra en la decisión, quien no publica en ML ni en Jumpseller se queda
   * sin el barrido entero y las delegaciones nuevas no se activan nunca.
   */
  const conArca = process.env.ARCA_DELEGACIONES !== 'off';
  /*
   * Y lo mismo para todo lo que se fue colgando de este reloj después.
   *
   * Cada tarea tiene su propio interruptor, pero el reloj es uno solo: si la
   * decisión de arrancarlo mira nada más las tres primeras, apagar los barridos
   * de stock también apaga —en silencio— la importación de ventas de Jumpseller,
   * el rescate de los pedidos que quedaron sin procesar y la liberación de la
   * mercadería de los pagos vencidos. Tres cosas que nadie relacionaría con
   * haber apagado un barrido de stock.
   */
  const conPedidosJs = process.env.JUMPSELLER_PEDIDOS !== 'off';
  const conCola = process.env.COLA_RESCATE !== 'off';
  const conVencimientos = process.env.PAGO_VENCIMIENTO !== 'off';

  if (!conMl && !conJumpseller && !conArca && !conPedidosJs && !conCola && !conVencimientos) {
    console.log('  Tareas periódicas ................ apagadas (todas)');
    return false;
  }

  timer = setTimeout(function primero() {
    tick();
    timer = setInterval(tick, INTERVALO_MS);
    // Que una tarea pendiente no impida cerrar el proceso en un deploy.
    timer.unref?.();
  }, DEMORA_INICIAL_MS);
  timer.unref?.();

  const minutos = Math.round(INTERVALO_MS / 60000);
  const canales = [conMl ? 'Mercado Libre' : null, conJumpseller ? 'Jumpseller' : null].filter(Boolean);
  console.log(canales.length
    ? `  Barrido de stock ................. cada ${minutos} min (${canales.join(' y ')})`
    : '  Barrido de stock ................. apagado (ninguna tienda conectada)');
  if (conPedidosJs) console.log(`  Ventas de Jumpseller ............. cada ${minutos} min`);
  if (conArca) console.log(`  Delegaciones de AFIP ............. cada ${minutos} min`);
  /*
   * Estas dos se anuncian porque tocan mercadería: si alguien las apagó, tiene
   * que verlo en el arranque y no descubrirlo por un pedido que quedó colgado.
   */
  if (conCola) console.log(`  Rescate de pedidos online ........ cada ${minutos} min`);
  if (conVencimientos) console.log(`  Pagos vencidos ................... cada ${minutos} min`);
  return true;
}

/** Para las tareas. Lo usan las pruebas y un apagado ordenado. */
function parar() {
  if (!timer) return;
  clearTimeout(timer);
  clearInterval(timer);
  timer = null;
}

module.exports = {
  arrancar, parar, barrerStockMl, barrerStockJumpseller, barrerPedidosJumpseller, INTERVALO_MS,
};
