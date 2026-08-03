import { http, API_URL } from "../lib/http";

export async function fetchInvoices() {
  const { data } = await http.get("/invoices", { params: { limit: 100 } });
  return data.data || [];
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

export function getInvoicePdfUrl(id) {
  const token = localStorage.getItem("isu_token");
  return `${API_URL}/invoices/${id}/pdf?token=${token}`;
}

// Descarga el PDF de la factura usando el token del Authorization header
// (evita depender del query param, que no todos los endpoints protegidos aceptan).
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

export async function fetchReceipts() {
  const { data } = await http.get("/invoices", { params: { limit: 200 } });
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
