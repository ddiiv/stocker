/*
 * El QR de la representación impresa (RG 4892).
 *
 * Lo que se prueba no es el dibujo sino lo que el QR dice: si los datos no son
 * exactamente los del comprobante autorizado, el que lo escanee —el comprador,
 * un inspector— no encuentra nada en ARCA, y un papel que parece verificable y
 * no lo es es peor que uno sin QR.
 *
 * Especificación: https://www.arca.gob.ar/fe/qr/ (RG 4892/2020).
 */

const { __qr, generateInvoicePdfBuffer } = require('../src/services/pdfService');

let ok = 0, ko = 0;
const chk = (t, e, o) => {
  const a = JSON.stringify(e), b = JSON.stringify(o);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const facturaReal = (extra = {}) => ({
  id: 1,
  numero: '2609-00001',            // el interno de Stocker
  tipo: 'A',
  emisorCuit: '30-71234567-8',
  clienteCuit: '20-12345678-9',
  clienteNombre: 'Cliente QA',
  fechaEmision: new Date('2026-09-18T14:30:00.000Z'),
  subtotal: 10000, iva: 2100, total: 12100,
  cae: '70417054367476',
  caeVencimiento: '2026-09-28',
  ambiente: 'produccion',
  simulado: false,
  arcaRespuesta: { puntoVenta: 3, numero: 94, cbteTipo: 1, CAE: '70417054367476' },
  ...extra,
});

(async () => {
  tit('1. LO QUE DICE EL QR ES EL COMPROBANTE AUTORIZADO');
  const datos = __qr.datosQr(facturaReal());
  chk('versión, fecha y CUIT del emisor', [1, '2026-09-18', 30712345678],
    [datos.ver, datos.fecha, datos.cuit]);
  chk('punto de venta, tipo y número los pone ARCA, no la numeración interna',
    [3, 1, 94], [datos.ptoVta, datos.tipoCmp, datos.nroCmp]);
  chk('importe, moneda y cotización', [12100, 'PES', 1], [datos.importe, datos.moneda, datos.ctz]);
  chk('el CAE va como código de autorización tipo "E"', ['E', 70417054367476],
    [datos.tipoCodAut, datos.codAut]);
  chk('el receptor con CUIT va como tipo 80', [80, 20123456789], [datos.tipoDocRec, datos.nroDocRec]);

  tit('2. LA URL ES LA QUE PIDE LA ESPECIFICACIÓN');
  const url = __qr.urlQr(facturaReal());
  chk('apunta al verificador de ARCA', true, url.startsWith('https://www.arca.gob.ar/fe/qr/?p='));
  const vuelta = JSON.parse(Buffer.from(url.split('?p=')[1], 'base64').toString('utf8'));
  chk('y los datos viajan en base64, íntegros', [94, 12100], [vuelta.nroCmp, vuelta.importe]);

  tit('3. EL CONSUMIDOR FINAL SIN DATOS NO INVENTA UN DOCUMENTO');
  const sinDoc = __qr.datosQr(facturaReal({ clienteCuit: null, tipo: 'B' }));
  chk('no se manda tipo ni número de documento', [undefined, undefined],
    [sinDoc.tipoDocRec, sinDoc.nroDocRec]);
  const conDni = __qr.datosQr(facturaReal({ clienteCuit: '12345678', tipo: 'B' }));
  chk('con DNI se manda como tipo 96', [96, 12345678], [conDni.tipoDocRec, conDni.nroDocRec]);

  tit('4. UN COMPROBANTE QUE NO EXISTE EN ARCA NO LLEVA QR');
  chk('homologación: sin QR', null, __qr.datosQr(facturaReal({ ambiente: 'homologacion' })));
  chk('CAE simulado: sin QR', null, __qr.datosQr(facturaReal({ simulado: true })));
  chk('sin CAE: sin QR', null, __qr.datosQr(facturaReal({ cae: null })));
  chk('sin número de ARCA: sin QR', null, __qr.datosQr(facturaReal({ arcaRespuesta: {} })));

  tit('5. EL NÚMERO IMPRESO ES EL DE ARCA');
  chk('punto de venta y número, con ceros', '00003-00000094', __qr.numeroArca(facturaReal()));
  chk('sin respuesta de ARCA no hay número', null, __qr.numeroArca(facturaReal({ arcaRespuesta: null })));

  tit('6. EL PDF SE GENERA IGUAL, CON Y SIN QR');
  const items = [{ titulo: 'Remera', sku: 'QA-1', cantidad: 1, precioUnitario: 10000, subtotal: 10000 }];
  const negocio = { nombreNegocio: 'QA', cuit: '30-71234567-8' };
  const conQr = await generateInvoicePdfBuffer(facturaReal(), items, negocio);
  const sinQr = await generateInvoicePdfBuffer(facturaReal({ ambiente: 'homologacion' }), items, negocio);
  chk('los dos son PDF', ['%PDF', '%PDF'],
    [conQr.slice(0, 4).toString(), sinQr.slice(0, 4).toString()]);
  chk('y el que lleva QR pesa más', true, conQr.length > sinQr.length);

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
