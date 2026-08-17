const { Plan, PlatformSetting } = require('../models');

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

    // Cache corta: los precios cambian poco y la página no puede depender de
    // que la API responda rápido en cada visita.
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

    res.set('Cache-Control', 'public, max-age=300');
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
      })),
    });
  } catch (e) { next(e); }
};

module.exports = { datosLanding, POR_DEFECTO };
