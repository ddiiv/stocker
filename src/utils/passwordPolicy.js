// Política de contraseñas de Stocker (compartida entre register y reset).
// Reglas: mínimo 8 caracteres, al menos 1 mayúscula, al menos 2 números,
// al menos 1 símbolo especial (no letra, no número).

const RULES = [
  { key: 'length',   test: (p) => p.length >= 8,                      msg: 'Al menos 8 caracteres' },
  { key: 'upper',    test: (p) => /[A-ZÁÉÍÓÚÑ]/.test(p),              msg: 'Al menos 1 letra mayúscula' },
  { key: 'digits',   test: (p) => (p.match(/\d/g) || []).length >= 2, msg: 'Al menos 2 números' },
  { key: 'symbol',   test: (p) => /[^A-Za-z0-9ÁÉÍÓÚÑáéíóúñ]/.test(p), msg: 'Al menos 1 símbolo especial' },
];

// Devuelve { valid: bool, failed: [{key, msg}], passed: [...] }
function evaluate(password) {
  const failed = [];
  const passed = [];
  for (const r of RULES) {
    (r.test(String(password || '')) ? passed : failed).push({ key: r.key, msg: r.msg });
  }
  return { valid: failed.length === 0, failed, passed };
}

/*
 * Middleware para validar `password` (o el campo indicado) en req.body.
 *
 * Uso: router.post('/x', validatePasswordBody(), handler)
 *
 * `opcional: true` es para las ediciones, donde el campo ausente significa
 * "no la cambies". Si viene, igual tiene que cumplir: dejar que una edición
 * pise una contraseña buena por una débil sería la misma puerta de atrás.
 */
function validatePasswordBody(field = 'password', { opcional = false, mensajeFalta = null } = {}) {
  return (req, res, next) => {
    const pass = req.body?.[field];
    if (!pass) {
      if (opcional) return next();
      // `mensajeFalta` existe porque "Falta el campo password" es un mensaje
      // para quien escribe el cliente, no para quien está cargando un alta.
      return res.status(400).json({ message: mensajeFalta || `Falta el campo "${field}".` });
    }
    const result = evaluate(pass);
    if (!result.valid) {
      return res.status(400).json({
        message: 'La contraseña no cumple los requisitos.',
        requisitos: result.failed.map((f) => f.msg),
      });
    }
    next();
  };
}

module.exports = { evaluate, validatePasswordBody, RULES };
