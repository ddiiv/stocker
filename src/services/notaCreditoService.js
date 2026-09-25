/*
 * Notas de crédito y de débito.
 *
 * Una factura con CAE no se borra ni se corrige: existe en AFIP y va a seguir
 * existiendo. Lo único que se puede hacer es emitir OTRO comprobante que la
 * revierta, total o parcialmente. Hasta ahora el sistema decía "hace falta una
 * nota de crédito" en dos lugares distintos y no había ninguna forma de
 * emitirla: una factura mal hecha quedaba sin salida.
 *
 * ── Lo que NO se recalcula ───────────────────────────────────────
 *
 * La letra, el CUIT emisor, el punto de venta, el ambiente y los datos del
 * receptor salen de la factura que se revierte, no de la configuración de hoy.
 * Una nota es el reverso de un comprobante concreto: si se recalculara,
 * bastaría con que el cliente hubiera cambiado de condición frente al IVA —o
 * con que el negocio hubiera cambiado de punto de venta— para emitir un
 * comprobante distinto que casualmente lleva un CbtesAsoc apuntando a la
 * factura vieja.
 *
 * ── El tope ──────────────────────────────────────────────────────
 *
 * AFIP no valida que las notas no excedan a la factura asociada: dos notas de
 * crédito por el total salen las dos bien y quedan las dos autorizadas. Por
 * eso el tope se controla acá, con la factura trabada y sumando lo ya
 * acreditado dentro de la misma transacción.
 */

const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { Invoice, InvoiceItem } = require('../models');
const { solicitarCAE, calcularIVA } = require('./arcaService');
const { nextInvoiceNumber, crearConNumero } = require('./invoiceNumberService');
const { log } = require('../utils/logger');

const CLASES_NOTA = ['nota_credito', 'nota_debito'];

const error = (mensaje, status = 400, extra = {}) =>
  Object.assign(new Error(mensaje), { status, ...extra });

/** Lo ya acreditado contra una factura, en pesos. */
async function acreditado(facturaId, clase, transaction) {
  const notas = await Invoice.findAll({
    where: { facturaAsociadaId: facturaId, clase, cae: { [Op.ne]: null } },
    attributes: ['total'],
    transaction,
  });
  return notas.reduce((s, n) => s + Number(n.total), 0);
}

/**
 * Cuánto se le puede todavía acreditar a una factura.
 *
 * Se usa para mostrarlo antes de emitir y para decidir si la venta ya se puede
 * anular. Fuera de una transacción es informativo: la decisión se toma con la
 * factura trabada.
 */
async function saldoParaNotas(facturaId, clase = 'nota_credito', transaction = null) {
  const factura = await Invoice.findByPk(facturaId, { transaction });
  if (!factura) throw error('Ese comprobante no existe.', 404);
  const ya = await acreditado(facturaId, clase, transaction);
  const total = Number(factura.total);
  return { total, acreditado: ya, disponible: Math.round((total - ya) * 100) / 100 };
}

/**
 * Emite una nota contra una factura.
 *
 * `total` opcional: sin él se acredita todo lo que queda.
 */
async function emitirNota({
  businessId, facturaId, clase = 'nota_credito', total = null, motivo, employeeId = null,
}) {
  if (!CLASES_NOTA.includes(clase)) throw error(`Clase inválida: ${clase}.`);
  const texto = String(motivo || '').trim().slice(0, 300);
  if (!texto) {
    throw error('Decí por qué se emite la nota: queda impresa en el comprobante y es lo que explica la devolución.');
  }

  /*
   * Todo lo que decide el importe pasa adentro de una transacción con la
   * factura trabada.
   *
   * Sin el candado, dos pedidos simultáneos leen el mismo "queda por
   * acreditar", los dos pasan el control y los dos piden CAE: quedan dos notas
   * autorizadas por el total contra una sola factura. AFIP no lo impide, y
   * revertir eso necesita una nota de DÉBITO.
   */
  const t = await sequelize.transaction();
  let datos;
  try {
    const factura = await Invoice.findOne({
      where: { id: facturaId, businessId, clase: 'factura' },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!factura) throw error('Esa factura no existe.', 404);
    if (!factura.cae) {
      throw error('Esa factura no tiene CAE: no hay nada que revertir en AFIP. Si es un borrador, anulala.', 409);
    }
    if (!factura.cbteNroArca || !factura.ptoVtaArca || !factura.cbteTipoArca) {
      /*
       * Sin las coordenadas no se puede armar el CbtesAsoc, y una nota sin
       * comprobante asociado no revierte nada. Pasa con las facturas anteriores
       * a que esas columnas existieran.
       */
      throw error(
        `La factura ${factura.numero} no tiene guardadas sus coordenadas de AFIP (punto de venta, tipo y número), `
        + 'así que no se le puede asociar una nota. Es una factura anterior a este circuito: hay que completarlas a mano.',
        409, { codigo: 'FACTURA_SIN_COORDENADAS' },
      );
    }

    const ya = await acreditado(factura.id, clase, t);
    const disponible = Math.round((Number(factura.total) - ya) * 100) / 100;
    if (disponible <= 0) {
      throw error(
        `La factura ${factura.numero} ya está acreditada por completo (${ya} de ${factura.total}).`,
        409, { codigo: 'FACTURA_ACREDITADA' },
      );
    }

    const importe = total === null || total === undefined
      ? disponible
      : Math.round(Number(total) * 100) / 100;
    if (!Number.isFinite(importe) || importe <= 0) throw error('El importe de la nota tiene que ser mayor a cero.');
    if (importe - disponible > 0.01) {
      throw error(
        `No se puede acreditar ${importe}: a la factura ${factura.numero} le quedan ${disponible} `
        + `(total ${factura.total}, ya acreditado ${ya}).`,
        409, { codigo: 'EXCEDE_FACTURA', detalles: { codigo: 'EXCEDE_FACTURA', disponible, total: Number(factura.total), acreditado: ya } },
      );
    }

    datos = { factura, importe, ya, disponible };
  } catch (e) {
    await t.rollback().catch(() => {});
    throw e;
  }

  /*
   * El CAE se pide FUERA de la transacción que trabó la factura.
   *
   * Sostener un lock mientras se viaja a AFIP —que tarda segundos y a veces se
   * cae— bloquearía toda otra operación sobre esa factura durante el viaje. El
   * control ya se hizo; lo que queda es que dos notas simultáneas no pasen el
   * tope, y de eso se encarga el candado de la transacción de arriba, que se
   * cierra recién después de reservar.
   */
  await t.commit();

  const { factura, importe } = datos;
  const { neto, iva } = calcularIVA(importe, factura.tipo);

  const arca = await solicitarCAE({
    // La letra es la de la factura: una nota de una B es una B.
    tipo: factura.tipo,
    clase,
    total: importe,
    clienteCuit: factura.clienteCuit,
    clienteCondicion: null,
    businessCuit: factura.emisorCuit,
    puntoVenta: factura.ptoVtaArca,
    ambiente: factura.ambiente,
    businessId,
    saleId: factura.saleId,
    asociada: {
      cbteTipo: factura.cbteTipoArca,
      ptoVta: factura.ptoVtaArca,
      numero: factura.cbteNroArca,
      fecha: factura.cbteFchArca,
      cuit: factura.emisorCuit,
    },
  });

  /*
   * Los renglones.
   *
   * Una nota total copia los de la factura: el cliente tiene que poder ver qué
   * se le está devolviendo. Una parcial no puede copiarlos —no cerrarían con el
   * importe— así que lleva una sola línea con el motivo.
   */
  const esTotal = Math.abs(importe - Number(factura.total)) < 0.01;
  const renglonesFactura = esTotal
    ? await InvoiceItem.findAll({ where: { invoiceId: factura.id }, order: [['id', 'ASC']] })
    : [];

  const t2 = await sequelize.transaction();
  try {
    const nota = await crearConNumero(
      (saltar) => nextInvoiceNumber(businessId, saltar, t2),
      (numero, sp) => Invoice.create({
        businessId,
        saleId: factura.saleId,
        clientId: factura.clientId,
        employeeId: employeeId || factura.employeeId,
        numero,
        tipo: factura.tipo,
        clase,
        facturaAsociadaId: factura.id,
        motivo: texto,
        clienteNombre: factura.clienteNombre,
        clienteCuit: factura.clienteCuit,
        clienteEmail: factura.clienteEmail,
        clienteDireccion: factura.clienteDireccion,
        subtotal: neto,
        iva,
        total: importe,
        esMayorista: factura.esMayorista,
        cae: arca.cae,
        caeVencimiento: arca.caeVencimiento,
        ptoVtaArca: arca.puntoVenta,
        cbteNroArca: arca.numero,
        cbteTipoArca: arca.cbteTipo,
        cbteFchArca: arca.cbteFch,
        arcaRespuesta: arca.respuesta,
        ambiente: factura.ambiente,
        simulado: factura.simulado,
        businessCuitId: factura.businessCuitId,
        emisorCuit: factura.emisorCuit,
        emisorNombre: factura.emisorNombre,
        cobroDestino: factura.cobroDestino,
      }, { transaction: sp }),
      { transaction: t2 },
    );

    const renglones = esTotal && renglonesFactura.length
      ? renglonesFactura.map((r) => ({
        invoiceId: nota.id,
        titulo: r.titulo,
        // El esquema no acepta SKU nulo; en una nota el renglón es el de la factura.
        sku: r.sku || 'NC',
        cantidad: r.cantidad,
        esMayorista: r.esMayorista,
        precioUnitario: r.precioUnitario,
        subtotal: r.subtotal,
      }))
      : [{
        invoiceId: nota.id,
        titulo: `Nota de ${clase === 'nota_credito' ? 'crédito' : 'débito'}: ${texto}`,
        sku: 'NC',
        cantidad: 1,
        esMayorista: factura.esMayorista,
        precioUnitario: importe,
        subtotal: importe,
      }];
    await InvoiceItem.bulkCreate(renglones, { transaction: t2 });

    if (arca.intentoId) {
      const { ArcaIntento } = require('../models');
      await ArcaIntento.update({ invoiceId: nota.id }, { where: { id: arca.intentoId }, transaction: t2 });
    }

    await t2.commit();
    log.info('arca', 'nota emitida', {
      businessId, clase, facturaId: factura.id, notaId: nota.id, importe,
    });
    return Invoice.findByPk(nota.id, { include: [{ model: InvoiceItem, as: 'items' }] });
  } catch (e) {
    await t2.rollback().catch(() => {});
    /*
     * El CAE ya salió. Si el guardado falla, el intento queda sin vincular y
     * el rescate de arcaService lo encuentra en el próximo pedido para esta
     * venta y ese tipo de comprobante: no se emite una segunda nota.
     */
    log.error('arca', 'la nota se autorizó en AFIP pero no se pudo guardar', {
      businessId, facturaId: facturaId, cae: arca.cae, motivo: e.message,
    });
    throw e;
  }
}

module.exports = { emitirNota, saldoParaNotas, acreditado, CLASES_NOTA };
