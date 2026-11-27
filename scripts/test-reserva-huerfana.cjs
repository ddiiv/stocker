// node scripts/test-reserva-huerfana.cjs — sin base: liberar o consumir una reserva de una variante borrada no crea filas ni explota.
const assert = require('node:assert/strict');
const { VariantStock } = require('../src/models');
const stock = require('../src/services/stockService');

(async () => {
  let creadas = 0;
  VariantStock.findOne = async () => null;
  VariantStock.findOrCreate = async () => { creadas += 1; throw new Error('violates foreign key constraint'); };
  const t = { LOCK: { UPDATE: 'UPDATE' } };
  assert.equal(await stock.liberarReserva(5724, 2, 2, 1, t), false);
  assert.equal(await stock.consumirReserva(5724, 2, 2, 1, t), false);
  assert.equal(creadas, 0);
  console.log('reserva de variante borrada: OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
