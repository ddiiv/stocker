import { useEffect, useState } from "react";
import { Plus, CreditCard, PencilLine, Trash2, Banknote, TrendingUp, TrendingDown } from "lucide-react";
import {
  fetchPaymentMethods, createPaymentMethod, updatePaymentMethod, deletePaymentMethod,
} from "../services/paymentMethodService";
import { EmptyState, Card, PageHeader } from "../components/ui/Layout";
import Modal from "../components/ui/Modal";
import { useAuth } from "../context/AuthContext";
import { canEdit } from "../utils/permissions";

const vacio = { nombre: "", ajustePct: 0, esEfectivo: false, activo: true, notas: "" };

export default function PaymentMethodsPage() {
  const { user } = useAuth();
  const puedeEditar = canEdit(user, "pagos");

  const [metodos, setMetodos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState(vacio);
  const [editando, setEditando] = useState(null);
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");
  const [guardando, setGuardando] = useState(false);

  async function load() {
    setLoading(true); setError("");
    try {
      setMetodos(await fetchPaymentMethods());
    } catch (e) {
      setError(e.response?.data?.message || "No se pudieron cargar los medios de pago");
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  function abrirNuevo() { setEditando(null); setForm(vacio); setError(""); setModal(true); }
  function abrirEdicion(m) {
    setEditando(m);
    setForm({
      nombre: m.nombre,
      ajustePct: Number(m.ajustePct) || 0,
      esEfectivo: Boolean(m.esEfectivo),
      activo: Boolean(m.activo),
      notas: m.notas || "",
    });
    setError(""); setModal(true);
  }

  async function guardar(e) {
    e.preventDefault();
    setGuardando(true); setError("");
    try {
      if (editando) await updatePaymentMethod(editando.id, form);
      else await createPaymentMethod(form);
      setModal(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || "No se pudo guardar");
    } finally { setGuardando(false); }
  }

  async function eliminar(m) {
    if (!confirm(`¿Eliminar el medio de pago "${m.nombre}"?`)) return;
    setAviso("");
    try {
      const r = await deletePaymentMethod(m.id);
      // Si ya se cobró con él, el backend lo desactiva en vez de borrarlo.
      if (r?.desactivado) setAviso(r.message);
      await load();
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo eliminar");
    }
  }

  return (
    <div>
      <PageHeader
        title="Métodos de pago"
        subtitle="Con qué puede cobrar el negocio, y qué recargo o descuento lleva cada uno"
        actions={puedeEditar && (
          <button className="btn-accent" onClick={abrirNuevo}><Plus size={15} /> Nuevo medio</button>
        )}
      />

      <Card className="mb-5 border-l-4 border-l-brass-500">
        <p className="text-sm text-ink-700">
          El ajuste se aplica <strong>sólo cuando la venta se cobra con un único medio</strong>.
          Si el cliente reparte el pago entre varios, no se aplica ninguno automáticamente —
          aunque el cajero puede cargarlo a mano en el momento del cobro.
        </p>
      </Card>

      {error && <p className="mb-4 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}
      {aviso && <p className="mb-4 rounded-md bg-paper-200 px-3 py-2 text-sm text-ink-700">{aviso}</p>}

      {loading ? (
        <div className="card p-0">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-16 animate-pulse border-b border-line last:border-0" />)}
        </div>
      ) : metodos.length === 0 ? (
        <EmptyState
          icon={CreditCard}
          title="Sin medios de pago"
          description="Cargá al menos uno para poder cobrar en el punto de venta."
        />
      ) : (
        <Card className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-line bg-paper-100 text-left text-xs uppercase tracking-wide text-ink-600">
                  <th className="px-4 py-2 font-medium">Medio</th>
                  <th className="px-4 py-2 font-medium">Ajuste</th>
                  <th className="px-4 py-2 font-medium">Cuenta al arqueo</th>
                  <th className="px-4 py-2 font-medium">Estado</th>
                  {puedeEditar && <th className="px-4 py-2" />}
                </tr>
              </thead>
              <tbody>
                {metodos.map((m) => {
                  const ajuste = Number(m.ajustePct) || 0;
                  return (
                    <tr key={m.id} className={`border-b border-line last:border-0 ${m.activo ? "" : "opacity-55"}`}>
                      <td className="px-4 py-3">
                        <p className="font-medium text-ink-900">{m.nombre}</p>
                        {m.notas && <p className="text-xs text-ink-500">{m.notas}</p>}
                      </td>
                      <td className="px-4 py-3">
                        {ajuste === 0 ? (
                          <span className="text-ink-500">Sin ajuste</span>
                        ) : (
                          <span className={`inline-flex items-center gap-1 font-medium ${ajuste > 0 ? "text-brick-500" : "text-teal-600"}`}>
                            {ajuste > 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                            {ajuste > 0 ? "+" : ""}{ajuste}%
                            <span className="ml-1 text-xs font-normal text-ink-500">
                              {ajuste > 0 ? "recargo" : "descuento"}
                            </span>
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {m.esEfectivo ? (
                          <span className="inline-flex items-center gap-1 text-ink-700"><Banknote size={14} /> Sí</span>
                        ) : (
                          <span className="text-ink-500">No</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`badge ${m.activo ? "badge-low" : "badge-out"}`}>
                          {m.activo ? "Activo" : "Inactivo"}
                        </span>
                      </td>
                      {puedeEditar && (
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          <button className="btn-ghost text-xs" onClick={() => abrirEdicion(m)}>
                            <PencilLine size={13} /> Editar
                          </button>
                          <button className="btn-ghost ml-1 text-xs text-brick-500" onClick={() => eliminar(m)}>
                            <Trash2 size={13} />
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Modal open={modal} onClose={() => setModal(false)} title={editando ? "Editar medio de pago" : "Nuevo medio de pago"}>
        <form onSubmit={guardar} className="space-y-4">
          {error && <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}

          <div>
            <label className="label">Nombre</label>
            <input
              className="input" value={form.nombre} autoFocus
              onChange={(e) => setForm({ ...form, nombre: e.target.value })}
              placeholder="Ej: Transferencia"
            />
          </div>

          <div>
            <label className="label">Recargo o descuento</label>
            <div className="flex items-center gap-2">
              <input
                type="number" step="0.01" min="-100" max="100" className="input"
                value={form.ajustePct}
                onChange={(e) => setForm({ ...form, ajustePct: e.target.value })}
              />
              <span className="text-sm text-ink-600">%</span>
            </div>
            <p className="mt-1 text-xs text-ink-500">
              Positivo recarga (5 = +5%), negativo descuenta (-10 = 10% off). Dejalo en 0 si no lleva ajuste.
            </p>
          </div>

          <label className="flex items-start gap-2 text-sm text-ink-700">
            <input
              type="checkbox" className="mt-0.5" checked={form.esEfectivo}
              onChange={(e) => setForm({ ...form, esEfectivo: e.target.checked })}
            />
            <span>
              Es efectivo
              <span className="block text-xs text-ink-500">
                Lo cobrado por este medio se suma al arqueo de caja. Marcalo sólo para dinero físico.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm text-ink-700">
            <input
              type="checkbox" className="mt-0.5" checked={form.activo}
              onChange={(e) => setForm({ ...form, activo: e.target.checked })}
            />
            <span>
              Activo
              <span className="block text-xs text-ink-500">Si lo desactivás, deja de ofrecerse al cobrar.</span>
            </span>
          </label>

          <div>
            <label className="label">Nota <span className="font-normal text-ink-500">(opcional)</span></label>
            <input
              className="input" value={form.notas}
              onChange={(e) => setForm({ ...form, notas: e.target.value })}
              placeholder="Ej: CBU terminado en 4471"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-ghost" onClick={() => setModal(false)}>Cancelar</button>
            <button className="btn-accent" disabled={guardando}>{guardando ? "Guardando…" : "Guardar"}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
