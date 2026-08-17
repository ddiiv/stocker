import { http } from "../lib/http";

/**
 * Facturas con filtro de fechas.
 *
 * Devuelve también `resumen`, con los totales de TODO el filtro. Sumar las
 * filas visibles daría el total de la página y no del período — que es
 * justamente lo que se quiere saber al filtrar por mes.
 */
export async function fetchInvoices({ desde, hasta, limit = 100 } = {}) {
  const params = { limit };
  if (desde) params.desde = desde;
  if (hasta) params.hasta = hasta;
  const { data } = await http.get("/invoices", { params });
  return {
    facturas: data.data || [],
    resumen: data.resumen || { cantidad: 0, emitidas: 0, anuladas: 0, totalEmitido: 0 },
  };
}

export async function generateInvoiceFromSale(sale, { tipo, clienteCuit, clienteEmail, clienteDireccion, enviarEmail = true, enviarWhatsapp = true, businessCuitId } = {}) {
  const { data } = await http.post("/invoices", {
    saleId: sale.id,
    tipo, clienteCuit, clienteEmail, clienteDireccion,
    enviarEmail, enviarWhatsapp,
    businessCuitId: businessCuitId || undefined,
  });
  return data;
}

export async function voidInvoice(id) {
  const { data } = await http.patch(`/invoices/${id}/anular`);
  return data;
}

// Descarga el PDF de la factura. La cookie de sesión viaja sola en el
// request, así que no hace falta pasar el token por la URL.
export async function downloadInvoicePdf(invoice) {
  const { data } = await http.get(`/invoices/${invoice.id}/pdf`, { responseType: "blob" });
  const url = window.URL.createObjectURL(new Blob([data], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `factura-${invoice.numero.replace(/\//g, "-")}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

export async function fetchReceipts({ desde, hasta } = {}) {
  const params = { limit: 200 };
  if (desde) params.desde = desde;
  if (hasta) params.hasta = hasta;
  const { data } = await http.get("/invoices", { params });
  // Receipts are derived from paid invoices in this endpoint
  return (data.data || []).map((inv) => ({
    id: `rec-${inv.id}`,
    numero: `R-${inv.numero}`,
    facturaId: inv.id,
    fecha: inv.fechaEmision?.slice(0, 10),
    cliente: inv.clienteNombre,
    monto: inv.total,
    medioPago: inv.venta?.medioPago || "—",
  }));
}
