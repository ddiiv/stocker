/*
 * El sobre de un movimiento, abierto.
 *
 * `docs/contrato-movimientos.md` define una forma igual para los cinco tipos de
 * movimiento que entran de afuera:
 *
 *   { contrato: 1, tipo: 'venta', id: 'isu:ISU-1042', ocurrioEn: '…', datos: {…} }
 *
 * Las rutas nacieron antes del contrato y reciben el cuerpo plano —`items`,
 * `pedidoExterno`— directo en la raíz. Las dos formas tienen que seguir
 * entrando: la tienda y el portal mayorista ya integraron contra la plana, y
 * romperles la integración para estrenar un sobre sería cambiarles el código a
 * cambio de nada.
 *
 * Esto se mete entre el cuerpo y el controlador: si hay sobre lo abre, y si no,
 * devuelve el cuerpo tal cual.
 */

const VERSION = 1;

const error = (mensaje) => Object.assign(new Error(mensaje), { status: 400 });

/**
 * Devuelve los datos del movimiento, venga en sobre o plano.
 *
 * @param cuerpo  `req.body`
 * @param tipoEsperado  el tipo que esta ruta sabe procesar, o null.
 */
function abrirSobre(cuerpo, tipoEsperado = null) {
  const c = cuerpo && typeof cuerpo === 'object' ? cuerpo : {};

  // Sin `datos` es el cuerpo plano de siempre.
  const tieneSobre = c.datos && typeof c.datos === 'object' && !Array.isArray(c.datos);
  if (!tieneSobre) return c;

  /*
   * Una versión que no conocemos se rechaza en vez de interpretarse.
   *
   * Si algún día el contrato cambia de forma incompatible, el que todavía manda
   * la 1 tiene que enterarse acá, no por una venta registrada mal.
   */
  const version = c.contrato == null ? VERSION : Number(c.contrato);
  if (version !== VERSION) {
    throw error(`Este Stocker entiende el contrato de movimientos ${VERSION} y llegó "${c.contrato}".`);
  }

  /*
   * El tipo equivocado es el error que más caro sale.
   *
   * Una devolución mandada a la ruta de ventas, sin este control, entraría como
   * una venta: descontaría stock en vez de devolverlo, y la diferencia
   * aparecería recién en el próximo recuento.
   */
  const tipo = c.tipo == null ? null : String(c.tipo).trim().toLowerCase();
  if (tipoEsperado && tipo && tipo !== tipoEsperado) {
    throw error(`Esta ruta procesa movimientos de tipo "${tipoEsperado}" y el mensaje dice "${c.tipo}".`);
  }

  const datos = { ...c.datos };

  /*
   * `id` es '<plataforma>:<su número>'. El número de pedido es lo que va al
   * índice único, así que se saca el prefijo hasta el PRIMER dos puntos: los de
   * más atrás son parte del número y sacárselos uniría dos pedidos distintos.
   */
  if (datos.pedidoExterno == null && c.id != null) {
    const id = String(c.id).trim();
    const corte = id.indexOf(':');
    datos.pedidoExterno = corte === -1 ? id : id.slice(corte + 1);
  }

  return datos;
}

module.exports = { abrirSobre, VERSION_CONTRATO: VERSION };
