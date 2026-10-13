/*
 * La subida del logo de la factura.
 *
 * Es el mismo multer en memoria que usan las planillas de productos, con otro
 * tope: el de las planillas es de 10 MB, y con ése un logo de 9 MB se leería
 * entero antes de rechazarlo. Acá multer corta apenas el archivo pasa los
 * 300 KB, y sólo acepta UN archivo en el campo "logo".
 *
 * Los errores de multer no traen `status`, así que el errorHandler los
 * contestaría como un 500 "error interno". Se traducen acá a lo que son: un
 * archivo que no se puede aceptar, dicho en castellano.
 *
 * Que el archivo sea de verdad un PNG o un JPEG no lo decide esto (multer
 * sólo sabe lo que dice el navegador): lo decide utils/logoFactura mirando
 * sus bytes.
 */
const multer = require('multer');
const { LOGO_MAX_BYTES } = require('../utils/logoFactura');

const recibir = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LOGO_MAX_BYTES, files: 1, fields: 5, parts: 6 },
}).single('logo');

function recibirLogo(req, res, next) {
  recibir(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        message: `El logo pesa más de ${Math.round(LOGO_MAX_BYTES / 1024)} KB, que es el máximo. Exportalo más chico o como JPG.`,
        codigo: 'LOGO_PESADO',
      });
    }
    if (err instanceof multer.MulterError) {
      return res.status(400).json({
        message: 'Mandá un solo archivo, la imagen del logo.',
        codigo: 'LOGO_FALTA',
      });
    }
    // Lo demás que puede fallar acá es leer el formulario (un envío cortado a
    // la mitad, un multipart mal armado): es del pedido, no del servidor.
    return res.status(400).json({
      message: 'El archivo no llegó completo. Volvé a intentar.',
      codigo: 'LOGO_FALTA',
    });
  });
}

module.exports = { recibirLogo };
