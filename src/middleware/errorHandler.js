const { log } = require('../utils/logger');

/*
 * Manejo central de errores.
 *
 * Dos cuidados acá:
 *
 * 1. Al log no puede ir el mensaje crudo de Sequelize: en un error de base
 *    viene el SQL con los valores adentro (emails, CUITs, hashes), y termina
 *    guardado en los logs de Railway.
 *
 * 2. Al cliente tampoco. Antes se devolvía `err.message` tal cual, así que
 *    provocando errores a propósito se podía ir mapeando el esquema de la
 *    base. Los mensajes pensados para el usuario son los que el código marca
 *    con `err.status`; el resto es un fallo inesperado y se responde genérico.
 */

// Errores de base traen el SQL en el mensaje. Nos quedamos con el nombre del
// error, que dice qué pasó sin decir con qué datos.
function mensajeSeguro(err) {
  if (err?.name?.startsWith('Sequelize')) {
    return `${err.name}${err.original?.code ? ` (${err.original.code})` : ''}`;
  }
  return err?.message || 'error desconocido';
}

/*
 * Los errores de base, traducidos a algo que el usuario pueda accionar.
 *
 * Sequelize devuelve el nombre del índice ("uq_products_sku must be unique") o
 * el del atributo del modelo ("Product.sku cannot be null"). Las dos cosas son
 * nombres internos: no le dicen a quien está cargando un producto qué tiene
 * que corregir, y de paso van dibujando el esquema de la base para cualquiera
 * que provoque errores a propósito.
 *
 * Se busca por fragmentos y no por nombre exacto porque los dos motores los
 * escriben distinto: el mismo índice es `uq_products_biz_sku` en Postgres y
 * `uq_products_sku` en SQL Server.
 */
const CHOQUES = [
  { pistas: ['products', 'sku'],   mensaje: 'Ya tenés un producto con ese SKU. Cambiá el SKU padre o editá el que ya existe.' },
  { pistas: ['variants', 'sku'],   mensaje: 'Ya existe una variante con ese SKU. Los SKU de variante no se pueden repetir.' },
  { pistas: ['sales', 'numero'],   mensaje: 'Ese número de comprobante ya está usado. Volvé a intentar: el número se asigna solo.' },
  { pistas: ['invoices', 'sale'],  mensaje: 'Esa venta ya tiene una factura emitida.' },
  { pistas: ['invoices', 'numero'],mensaje: 'Ese número de factura ya está usado. Volvé a intentar.' },
  { pistas: ['businesses', 'email'], mensaje: 'Ya hay una cuenta registrada con ese email.' },
  { pistas: ['businesses', 'cuit'],  mensaje: 'Ya hay un negocio registrado con ese CUIT.' },
  { pistas: ['bizcuits'],          mensaje: 'Ese CUIT ya está cargado en el negocio.' },
  { pistas: ['employees', 'email'],mensaje: 'Ya hay un empleado con ese email.' },
  { pistas: ['roles'],             mensaje: 'Ya existe un rol con ese nombre.' },
  { pistas: ['vartypes'],          mensaje: 'Ya existe una variante con ese nombre.' },
  { pistas: ['arcaconfig'],        mensaje: 'Ese CUIT ya tiene una configuración de ARCA.' },
];

/** Los campos, como los llama la pantalla y no como los llama el modelo. */
const CAMPOS = {
  sku: 'el SKU padre', skuAgrupador: 'el SKU agrupador', skuVariante: 'el SKU de variante',
  titulo: 'el título', nombre: 'el nombre', apellido: 'el apellido',
  precioMinorista: 'el precio minorista', precioMayorista: 'el precio mayorista', costo: 'el costo',
  email: 'el email', cuit: 'el CUIT', numero: 'el número', cantidad: 'la cantidad',
  fecha: 'la fecha', businessId: 'el negocio', locationId: 'el local',
};

/** Dónde chocó, mirando todo lo que Sequelize deja del error. */
function textoDelChoque(err) {
  return [
    err?.parent?.constraint, err?.parent?.table, err?.original?.constraint,
    ...Object.keys(err?.fields || {}),
    ...(err?.errors || []).map((e) => e.message),
  ].filter(Boolean).join(' ').toLowerCase();
}

function traducir(err) {
  if (err?.name === 'SequelizeUniqueConstraintError') {
    const donde = textoDelChoque(err);
    const encontrado = CHOQUES.find((c) => c.pistas.every((p) => donde.includes(p)));
    return encontrado ? encontrado.mensaje : 'Ese dato ya está cargado y no se puede repetir.';
  }

  if (err?.name === 'SequelizeValidationError') {
    // Los "cannot be null" se rearman como una lista de campos que faltan.
    const faltan = (err.errors || [])
      .filter((e) => e.validatorKey === 'is_null' || /cannot be null/i.test(e.message || ''))
      .map((e) => CAMPOS[e.path] || `el campo ${e.path}`);
    if (faltan.length) {
      return faltan.length === 1
        ? `Falta ${faltan[0]}.`
        : `Faltan ${faltan.slice(0, -1).join(', ')} y ${faltan[faltan.length - 1]}.`;
    }
    /*
     * El resto de las validaciones sí son mensajes escritos a mano en el
     * modelo, pensados para leerse. Esos pasan tal cual.
     */
    const propios = (err.errors || []).map((e) => e.message).filter(Boolean);
    if (propios.length) return propios.join(' · ');
  }

  return null;
}

const errorHandler = (err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 500;

  // La ruta ubica el problema en el proyecto; los params/body nunca se loguean.
  const contexto = { ruta: `${req.method} ${req.route?.path || req.path}`, status };
  if (status >= 500) log.error('http', mensajeSeguro(err), contexto);
  else log.warn('http', mensajeSeguro(err), contexto);

  if (err.name === 'SequelizeValidationError' || err.name === 'SequelizeUniqueConstraintError') {
    /*
     * Se muestra en `message`, no sólo en `errors`. Antes el cuerpo decía
     * "Error de validación" a secas y el detalle viajaba en un array que
     * ninguna pantalla leía: quien vendía veía un error sin causa y no tenía
     * forma de saber qué corregir.
     */
    const mensaje = traducir(err) || 'Revisá los datos cargados.';
    return res.status(400).json({ message: mensaje, errors: [mensaje] });
  }

  // Sólo se devuelve el texto original cuando el código lo eligió a propósito.
  const paraElUsuario = err.status
    ? (err.message || 'Error en la operación')
    : 'Error interno del servidor';

  // `detalles` deja que un error deliberado acompañe datos que la pantalla
  // necesita para ofrecer una salida — por ejemplo, el turno de caja que quedó
  // abierto, para poder cerrarlo desde el mismo aviso. Sólo viaja en errores
  // con status explícito: nunca en un fallo inesperado.
  const cuerpo = { message: paraElUsuario };
  if (err.status && err.detalles && typeof err.detalles === 'object') {
    Object.assign(cuerpo, err.detalles);
  }

  res.status(status).json(cuerpo);
};

const notFound = (req, res) => {
  res.status(404).json({ message: `Ruta no encontrada: ${req.method} ${req.path}` });
};

module.exports = { errorHandler, notFound };
