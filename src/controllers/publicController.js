const { Plan, PlatformSetting } = require('../models');
const { CATALOGO_FEATURES } = require('../config/planes');

/*
 * Datos que consume la página pública de Stocker.
 *
 * La página es un archivo estático servido desde un hosting gratuito. Para no
 * tener que editarla y volver a publicarla cada vez que cambia un precio o un
 * teléfono, lee estos valores al cargar.
 *
 * Clave del diseño: la página trae los mismos datos escritos en el HTML como
 * respaldo. Si la API no responde —o todavía no existe— el visitante ve
 * precios correctos igual. Una página comercial que muestra "cargando…"
 * porque se cayó un backend es peor que una desactualizada.
 *
 * Es público sin sesión, y sólo devuelve lo que ya está publicado.
 */

const POR_DEFECTO = {
  contactoEmail:    'danteinsauviola@gmail.com',
  contactoWhatsapp: '5491151180090',
  contactoTelefono: '+54 9 11 5118-0090',
  // A dónde entra quien ya es cliente. Se puede pisar desde el backoffice, pero
  // el valor por defecto sale de la configuración del backend para no tener el
  // dominio escrito en dos lugares.
  urlSistema:       '',
  // Pesos por dólar, para el selector de moneda. Es referencia comercial, no
  // una cotización en vivo: se actualiza a mano desde el backoffice.
  cotizacionUsd:    '1450',
};

const datosLanding = async (_req, res, next) => {
  try {
    const [filas, planes] = await Promise.all([
      PlatformSetting.findAll(),
      Plan.findAll({ where: { activo: true }, order: [['orden', 'ASC']] }),
    ]);

    const guardado = Object.fromEntries(filas.map((f) => [f.clave, f.valor]).filter(([, v]) => v != null && v !== ''));
    const ajustes = { ...POR_DEFECTO, ...guardado };

    /*
     * Sin cache compartida, y es el punto de todo esto.
     *
     * Antes iba `public, max-age=300`. Con `public`, cualquier intermediario
     * —el proxy de Railway, un CDN, el proxy de una oficina— se queda con una
     * copia y la sirve cinco minutos. El `cache: "no-store"` de la página no
     * lo evita: sólo salta la cache DEL NAVEGADOR, no la de un tercero que ya
     * guardó la respuesta.
     *
     * El resultado era que un cambio hecho en el backoffice no se veía y no
     * había forma de saber por qué: la base ya tenía el valor nuevo y la
     * página seguía mostrando el viejo.
     *
     * `no-cache` no significa "no guardar": significa revalidar siempre antes
     * de usar. La respuesta pesa un kilobyte, así que el costo es nulo al lado
     * de que un precio quede desactualizado.
    /*
     * URL del sistema para el botón «Entrar».
     *
     * Sale de FRONTEND_URL o FRONTEND_DOMAIN, que ya existen para el CORS: si
     * hubiera una variable propia serían dos lugares que decir lo mismo y uno
     * que se olvida de actualizar. Un ajuste guardado la pisa.
     */
    const delEntorno = (process.env.FRONTEND_URL || '').split(',')[0].trim()
                    || (process.env.FRONTEND_DOMAIN || '').trim();
    const urlSistema = (ajustes.urlSistema || delEntorno || '').replace(/\/+$/, '');

    res.set('Cache-Control', 'no-cache, must-revalidate');
    res.json({
      sistema: urlSistema
        ? (/^https?:\/\//i.test(urlSistema) ? urlSistema : `https://${urlSistema}`)
        : null,
      contacto: {
        email:    ajustes.contactoEmail,
        whatsapp: ajustes.contactoWhatsapp,
        telefono: ajustes.contactoTelefono,
      },
      cotizacionUsd: Number(ajustes.cotizacionUsd) || Number(POR_DEFECTO.cotizacionUsd),
      planes: planes.map((p) => ({
        codigo: p.codigo,
        nombre: p.nombre,
        precioMensual: p.precioMensual != null ? Number(p.precioMensual) : null,
        maxCuits: p.maxCuits,
        maxEmpleados: p.maxEmpleados,
        maxLocales: p.maxLocales,
        maxSkus: p.maxSkus,
        maxComprobantes: p.maxComprobantes,
        soporte: p.soporte,
        requiereCotizacion: p.requiereCotizacion,
        /*
         * Las funciones, para que la página pública deje de tenerlas escritas.
         *
         * Los precios y los topes ya viajaban; las funciones no, así que el día
         * que Eventos, Depósito y Reposición entraron al catálogo hubo que
         * editar el HTML de la landing a mano. Un cambio hecho en el backoffice
         * seguía sin verse ahí, que es justo lo que el resto de este endpoint
         * viene a evitar.
         *
         * Se manda el objeto entero y no una lista curada: la página decide qué
         * bullets muestra y con cuál texto —es una página de venta, no una
         * tabla— pero el tilde y la cruz salen de acá.
         */
        features: (typeof p.features === 'string' ? JSON.parse(p.features || '{}') : (p.features || {})),
      })),
      /*
       * El nombre visible de cada función, por si la página quiere listarlas
       * sin tenerlas escritas. Es el mismo catálogo que usan el backoffice y la
       * pantalla de suscripción.
       */
      features: CATALOGO_FEATURES,
    });
  } catch (e) { next(e); }
};

module.exports = { datosLanding, POR_DEFECTO };
