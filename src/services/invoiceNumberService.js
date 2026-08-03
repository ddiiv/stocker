const { Op } = require('sequelize');
const { Invoice, Sale } = require('../models');

// Formato: YYYY-MM-XXXXXX (ej: 2026-07-000001)
// El correlativo reinicia cada mes por businessId.
async function nextInvoiceNumber(businessId) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `${yyyy}-${mm}-`;

  const last = await Invoice.findOne({
    where: {
      businessId,
      numero: { [Op.like]: `${prefix}%` },
    },
    order: [['id', 'DESC']],
  });

  let seq = 1;
  if (last) {
    const lastSeq = parseInt(last.numero.split('-')[2], 10);
    seq = lastSeq + 1;
  }

  return `${prefix}${String(seq).padStart(6, '0')}`;
}

// Mismo formato para ventas/cotizaciones
async function nextSaleNumber(businessId, tipo) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = tipo === 'cotizacion' ? `COT-${yyyy}-${mm}-` : `V-${yyyy}-${mm}-`;

  const last = await Sale.findOne({
    where: {
      businessId,
      tipo,
      numero: { [Op.like]: `${prefix}%` },
    },
    order: [['id', 'DESC']],
  });

  let seq = 1;
  if (last) {
    const parts = last.numero.split('-');
    seq = parseInt(parts[parts.length - 1], 10) + 1;
  }

  return `${prefix}${String(seq).padStart(6, '0')}`;
}

module.exports = { nextInvoiceNumber, nextSaleNumber };
