import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, HandCoins, RefreshCw, Settings2, Wallet } from "lucide-react";
import {
  fetchCuentas, fetchCuenta, updateCuentaConfig, registrarPagoCuenta,
} from "../services/clientService";
import { fetchPaymentMethods } from "../services/paymentMethodService";
import { canEdit } from "../utils/permissions";
import { useAuth } from "../context/AuthContext";
import { formatCurrency, formatDateTime } from "../utils/formatters";
import { PageHeader, Card, EmptyState } from "../components/ui/Layout";
import Modal from "../components/ui/Modal";
import ClientTabs from "../components/clients/ClientTabs";

/*
 * Cuentas corrientes.
 *
 * Muestra a quién se le fió, cuánto debe y cuánto crédito le queda. Los datos
 * no se refrescan solos: son consultas pesadas y el saldo sólo cambia cuando
 * alguien vende o cobra en esta misma pantalla, así que se recarga al entrar y
 * con el botón de actualizar.
 */
export default function ClientAccountsPage() {
  const { user } = useAuth();
  const puedeCobrar   = canEdit(user, "clientes");
  const puedeFijarTope = canEdit(user, "pagos");

  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState("");
  const [soloDeudores, setSoloDeudores] = useState(true);
  const [actualizado, setActualizado]   = useState(null);

  const [detalle, setDetalle]   = useState(null); // { cuenta, movimientos }
  const [modalPago, setModalPago]     = useState(null); // cuenta
  const [modalConfig, setModalConfig] = useState(null); // cuenta
  const [medios, setMedios] = useState([]);

  const cargar = useCallback(async () => {
    setLoading(true); setError("");
    try {
      setData(await fetchCuentas(soloDeudores));
      setActualizado(new Date());
    } catch (e) {
      setError(e.response?.data?.message || "No se pudieron cargar las cuentas.");
    } finally { setLoading(false); }
  }, [soloDeudores]);

  useEffect(() => { cargar(); }, [cargar]);
  useEffect(() => { fetchPaymentMethods().then(setMedios).catch(() => setMedios([])); }, []);

  async function abrirDetalle(cuenta) {
    setDetalle({ cuenta, movimientos: null });
    try {
      setDetalle(await fetchCuenta(cuenta.id));
    } catch {
      setDetalle({ cuenta, movimientos: [] });
    }
  }

  const cuentas = data?.cuentas || [];
  const totales = data?.totales;

  return (
    <div>
      <PageHeader
        title="Cuentas corrientes"
        subtitle="Clientes que compran fiado, su deuda y el crédito que les queda"
        actions={
          <button className="btn btn-ghost" onClick={cargar} disabled={loading}>
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            Actualizar
          </button>
        }
      />
      <ClientTabs />

      {actualizado && (
        <p className="mb-3 text-xs text-ink-500">
          Última actualización: {formatDateTime(actualizado)}
        </p>
      )}
      {error && <p className="mb-3 text-sm text-brick-600">{error}</p>}

      {totales && (
        <div className="mb-5 grid gap-3 sm:grid-cols-4">
          <Card>
            <p className="text-xs uppercase tracking-wide text-ink-600">Deuda total</p>
            <p className="mt-1 font-display text-2xl font-semibold text-brick-600">{formatCurrency(totales.deudaTotal)}</p>
          </Card>
          <Card>
            <p className="text-xs uppercase tracking-wide text-ink-600">Crédito otorgado</p>
            <p className="mt-1 font-display text-2xl font-semibold">{formatCurrency(totales.creditoTotal)}</p>
          </Card>
          <Card>
            <p className="text-xs uppercase tracking-wide text-ink-600">Con deuda</p>
            <p className="mt-1 font-display text-2xl font-semibold">{totales.conDeuda}</p>
          </Card>
          <Card>
            <p className="text-xs uppercase tracking-wide text-ink-600">Pasados de límite</p>
            <p className={`mt-1 font-display text-2xl font-semibold ${totales.excedidos ? "text-brick-500" : ""}`}>
              {totales.excedidos}
            </p>
          </Card>
        </div>
      )}

      <label className="mb-3 flex w-fit items-center gap-2 text-sm text-ink-700">
        <input
          type="checkbox"
          checked={!soloDeudores}
          onChange={(e) => setSoloDeudores(!e.target.checked)}
        />
        Mostrar también los clientes sin cuenta corriente
      </label>

      {!loading && !cuentas.length ? (
        <EmptyState
          icon={Wallet}
          title="Todavía no hay cuentas corrientes"
          description="Habilitá el crédito de un cliente desde el botón de configuración para poder venderle fiado."
        />
      ) : (
        <Card className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-600">
                  <th className="px-4 py-3">Cliente</th>
                  <th className="px-4 py-3 text-right">Saldo</th>
                  <th className="px-4 py-3 text-right">Límite</th>
                  <th className="px-4 py-3 text-right">Disponible</th>
                  <th className="px-4 py-3">Estado</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {cuentas.map((c) => (
                  <tr key={c.id} className="border-b border-line last:border-0 hover:bg-paper-100">
                    <td className="px-4 py-3">
                      <button className="text-left font-medium text-ink-950 hover:underline" onClick={() => abrirDetalle(c)}>
                        {c.nombre} {c.apellido}
                      </button>
                      {c.telefono && <p className="text-xs text-ink-500">{c.telefono}</p>}
                    </td>
                    <td className={`px-4 py-3 text-right tabular-nums ${c.saldoCuenta > 0 ? "font-semibold text-brick-600" : "text-ink-600"}`}>
                      {formatCurrency(c.saldoCuenta)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-ink-600">{formatCurrency(c.limiteCredito)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatCurrency(c.disponible)}</td>
                    <td className="px-4 py-3">
                      {c.excedido ? (
                        <span className="badge badge-credito inline-flex items-center gap-1">
                          <AlertTriangle size={12} /> Pasado de límite
                        </span>
                      ) : !c.cuentaHabilitada ? (
                        <span className="text-xs text-ink-500">Sin cuenta</span>
                      ) : (
                        <span className="text-xs text-teal-600">Habilitada</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        {puedeCobrar && c.saldoCuenta > 0 && (
                          <button className="btn btn-ghost !px-2 !py-1 text-xs" onClick={() => setModalPago(c)}>
                            <HandCoins size={14} /> Cobrar
                          </button>
                        )}
                        {puedeFijarTope && (
                          <button className="btn btn-ghost !px-2 !py-1 text-xs" onClick={() => setModalConfig(c)}>
                            <Settings2 size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <DetalleModal detalle={detalle} onClose={() => setDetalle(null)} />
      <PagoModal
        cuenta={modalPago}
        medios={medios}
        onClose={() => setModalPago(null)}
        onListo={() => { setModalPago(null); cargar(); }}
      />
      <ConfigModal
        cuenta={modalConfig}
        onClose={() => setModalConfig(null)}
        onListo={() => { setModalConfig(null); cargar(); }}
      />
    </div>
  );
}

function DetalleModal({ detalle, onClose }) {
  if (!detalle) return null;
  const { cuenta, movimientos } = detalle;
  return (
    <Modal open onClose={onClose} title={`Cuenta de ${cuenta.nombre} ${cuenta.apellido || ""}`} width="max-w-2xl">
      <div className="mb-4 grid grid-cols-3 gap-3 text-sm">
        <div><p className="text-xs text-ink-600">Saldo</p><p className="font-semibold tabular-nums">{formatCurrency(cuenta.saldoCuenta)}</p></div>
        <div><p className="text-xs text-ink-600">Límite</p><p className="tabular-nums">{formatCurrency(cuenta.limiteCredito)}</p></div>
        <div><p className="text-xs text-ink-600">Disponible</p><p className="tabular-nums">{formatCurrency(cuenta.disponible)}</p></div>
      </div>
      {movimientos === null ? (
        <p className="text-sm text-ink-600">Cargando movimientos…</p>
      ) : !movimientos.length ? (
        <p className="text-sm text-ink-600">Sin movimientos registrados.</p>
      ) : (
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-600">
                <th className="py-2">Fecha</th>
                <th className="py-2">Concepto</th>
                <th className="py-2 text-right">Importe</th>
                <th className="py-2 text-right">Saldo</th>
              </tr>
            </thead>
            <tbody>
              {movimientos.map((m) => (
                <tr key={m.id} className="border-b border-line last:border-0">
                  <td className="py-2 text-xs text-ink-600">{formatDateTime(m.fecha)}</td>
                  <td className="py-2">
                    {m.tipo === "cargo" ? "Venta" : "Pago"}
                    {m.venta?.numero && <span className="ml-1 text-xs text-ink-500">{m.venta.numero}</span>}
                    {m.medioPago && <span className="ml-1 text-xs text-ink-500">({m.medioPago})</span>}
                    {m.empleado && <p className="text-xs text-ink-500">{m.empleado.nombre} {m.empleado.apellido}</p>}
                  </td>
                  <td className={`py-2 text-right tabular-nums ${m.tipo === "cargo" ? "text-brick-600" : "text-teal-600"}`}>
                    {m.tipo === "cargo" ? "+" : "−"}{formatCurrency(m.monto)}
                  </td>
                  <td className="py-2 text-right tabular-nums text-ink-600">{formatCurrency(m.saldoPosterior)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

function PagoModal({ cuenta, medios, onClose, onListo }) {
  const [monto, setMonto] = useState("");
  const [metodo, setMetodo] = useState("");
  const [notas, setNotas] = useState("");
  const [error, setError] = useState("");
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    if (cuenta) { setMonto(String(cuenta.saldoCuenta)); setMetodo(""); setNotas(""); setError(""); }
  }, [cuenta]);

  if (!cuenta) return null;

  // Cualquier medio activo sirve para cobrar lo fiado: fiar dejó de ser un
  // medio de pago para pasar a ser una condición de la venta.
  const mediosCobrables = medios.filter((m) => m.activo);

  async function guardar(e) {
    e.preventDefault();
    setGuardando(true); setError("");
    try {
      await registrarPagoCuenta(cuenta.id, {
        monto: Number(monto),
        paymentMethodId: metodo ? Number(metodo) : null,
        notas: notas || null,
      });
      onListo();
    } catch (err) {
      setError(err.response?.data?.message || "No se pudo registrar el pago.");
    } finally { setGuardando(false); }
  }

  return (
    <Modal open onClose={onClose} title={`Cobrar a ${cuenta.nombre} ${cuenta.apellido || ""}`}>
      <form onSubmit={guardar} className="space-y-4">
        <p className="text-sm text-ink-600">
          Debe <span className="font-medium text-ink-950">{formatCurrency(cuenta.saldoCuenta)}</span>. Se puede cobrar una parte.
        </p>
        <div>
          <label className="label">Importe</label>
          <input className="input" type="number" step="0.01" min="0.01" value={monto}
                 onChange={(e) => setMonto(e.target.value)} required />
        </div>
        <div>
          <label className="label">Con qué paga</label>
          <select className="input" value={metodo} onChange={(e) => setMetodo(e.target.value)}>
            <option value="">Sin especificar</option>
            {mediosCobrables.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
          </select>
          <p className="mt-1 text-xs text-ink-500">
            Si es efectivo y tenés un turno abierto, el ingreso se suma a tu caja.
          </p>
        </div>
        <div>
          <label className="label">Notas</label>
          <input className="input" value={notas} onChange={(e) => setNotas(e.target.value)} placeholder="Opcional" />
        </div>
        {error && <p className="text-sm text-brick-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" disabled={guardando}>{guardando ? "Registrando…" : "Registrar pago"}</button>
        </div>
      </form>
    </Modal>
  );
}

function ConfigModal({ cuenta, onClose, onListo }) {
  const [habilitada, setHabilitada] = useState(false);
  const [limite, setLimite] = useState("0");
  const [error, setError] = useState("");
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    if (cuenta) {
      setHabilitada(!!cuenta.cuentaHabilitada);
      setLimite(String(cuenta.limiteCredito ?? 0));
      setError("");
    }
  }, [cuenta]);

  if (!cuenta) return null;

  async function guardar(e) {
    e.preventDefault();
    setGuardando(true); setError("");
    try {
      await updateCuentaConfig(cuenta.id, { cuentaHabilitada: habilitada, limiteCredito: Number(limite) });
      onListo();
    } catch (err) {
      setError(err.response?.data?.message || "No se pudo guardar.");
    } finally { setGuardando(false); }
  }

  return (
    <Modal open onClose={onClose} title={`Crédito de ${cuenta.nombre} ${cuenta.apellido || ""}`}>
      <form onSubmit={guardar} className="space-y-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={habilitada} onChange={(e) => setHabilitada(e.target.checked)} />
          Puede comprar en cuenta corriente
        </label>
        <div>
          <label className="label">Límite de crédito</label>
          <input className="input" type="number" step="0.01" min="0" value={limite}
                 onChange={(e) => setLimite(e.target.value)} />
          <p className="mt-1 text-xs text-ink-500">
            Deuda máxima que se le permite acumular. Una venta que lo supere se rechaza.
          </p>
        </div>
        {cuenta.saldoCuenta > 0 && (
          <p className="rounded-md bg-paper-100 px-3 py-2 text-xs text-ink-600">
            Hoy debe {formatCurrency(cuenta.saldoCuenta)}. Bajar el límite por debajo de ese monto no borra la deuda:
            queda marcado como pasado de límite y no puede llevar más hasta que pague.
          </p>
        )}
        {error && <p className="text-sm text-brick-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" disabled={guardando}>{guardando ? "Guardando…" : "Guardar"}</button>
        </div>
      </form>
    </Modal>
  );
}
