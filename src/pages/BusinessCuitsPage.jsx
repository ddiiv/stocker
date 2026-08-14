import { useEffect, useState } from "react";
import { Plus, Building2, PencilLine, Trash2, Star, ShieldCheck, Lock } from "lucide-react";
import { Link } from "react-router-dom";
import { fetchBusinessCuits, createBusinessCuit, updateBusinessCuit, deleteBusinessCuit } from "../services/businessCuitService";
import { lookupCuit } from "../services/clientService";
import { PageHeader, EmptyState, Card } from "../components/ui/Layout";
import Modal from "../components/ui/Modal";
import BillingTabs from "../components/billing/BillingTabs";

const CONDICIONES = [
  "Responsable Inscripto",
  "Monotributo",
  "Exento",
  "Consumidor Final",
];

const MAX = 3;

export default function BusinessCuitsPage() {
  const [cuits, setCuits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true); setError("");
    try { setCuits(await fetchBusinessCuits()); }
    catch (e) { setError(e.response?.data?.message || "Error al cargar CUITs"); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function handleDelete(c) {
    if (c.esPrincipal) return alert("No podés eliminar el CUIT principal. Marcá otro como principal primero.");
    if (!confirm(`¿Eliminar el CUIT "${c.nombre}"? Las facturas ya emitidas con él no se modifican.`)) return;
    try { await deleteBusinessCuit(c.id); await load(); }
    catch (e) { alert(e.response?.data?.message || "Error al eliminar"); }
  }

  return (
    <div>
      <PageHeader
        title="Facturación"
        subtitle="Facturas emitidas y los CUITs con los que facturás"
        actions={
          <button
            className="btn-accent"
            onClick={() => { setEditing(null); setModal(true); }}
            disabled={cuits.length >= MAX}
            title={cuits.length >= MAX ? `Máximo ${MAX} CUITs` : "Agregar CUIT"}
          >
            <Plus size={15} /> Nuevo CUIT
          </button>
        }
      />
      <BillingTabs />

      {error && <p className="mb-4 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}

      <div className="mb-4 rounded-md border border-line bg-paper-50 px-3 py-2 text-sm text-ink-600">
        Podés tener hasta <strong>{MAX} CUITs</strong> asociados a tu negocio para elegir desde cuál emitir cada factura. Actualmente: <strong>{cuits.length}/{MAX}</strong>.
      </div>

      {loading ? (
        <div className="card p-0">{Array.from({ length: 2 }).map((_, i) => <div key={i} className="h-24 animate-pulse border-b border-line last:border-0" />)}</div>
      ) : cuits.length === 0 ? (
        <EmptyState icon={Building2} title="Sin CUITs cargados" description="Agregá el primer CUIT para poder facturar." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {cuits.map((c) => (
            <Card key={c.id}>
              <div className="mb-2 flex items-start justify-between gap-2">
                <div>
                  <p className="font-display text-base font-semibold text-ink-950">{c.nombre}</p>
                  <p className="font-mono text-xs text-ink-700">{c.cuit}</p>
                </div>
                {c.esPrincipal && <span className="badge badge-ok inline-flex items-center gap-1"><Star size={11} /> Principal</span>}
              </div>
              <dl className="mb-3 space-y-1 text-xs text-ink-600">
                <div><dt className="inline text-ink-500">Condición IVA:</dt> <dd className="inline">{c.condicionIva || "—"}</dd></div>
                <div><dt className="inline text-ink-500">Domicilio:</dt> <dd className="inline">{c.domicilio || "—"}</dd></div>
              </dl>
              <div className="flex flex-wrap gap-1 border-t border-line pt-3">
                <Link to={`/facturacion/cuits/${c.id}/arca`} className="btn-ghost px-2 py-1.5 text-xs" title="Configurar facturación ARCA">
                  <ShieldCheck size={13} /> ARCA
                </Link>
                <button className="btn-ghost px-2 py-1.5 text-xs" onClick={() => { setEditing(c); setModal(true); }}><PencilLine size={13} /> Editar</button>
                <button className="btn-ghost px-2 py-1.5 text-xs" onClick={() => handleDelete(c)}><Trash2 size={13} /> Eliminar</button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <CuitFormModal open={modal} onClose={() => setModal(false)} onSaved={() => { setModal(false); load(); }} cuit={editing} />
    </div>
  );
}

function CuitFormModal({ open, onClose, onSaved, cuit }) {
  const [form, setForm] = useState({ nombre: "", cuit: "", condicionIva: "", domicilio: "", esPrincipal: false });
  const esPrincipal = !!cuit?.esPrincipal;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [cuitStatus, setCuitStatus] = useState(null);

  useEffect(() => {
    setForm(cuit ? { ...cuit, esPrincipal: !!cuit.esPrincipal } : { nombre: "", cuit: "", condicionIva: "", domicilio: "", esPrincipal: false });
    setError("");
    setCuitStatus(null);
  }, [cuit, open]);

  async function handleCuitChange(value) {
    setForm((f) => ({ ...f, cuit: value }));
    setCuitStatus(null);
    const clean = value.replace(/[^0-9]/g, "");
    if (clean.length !== 11) return;
    setCuitStatus({ loading: true });
    const data = await lookupCuit(clean);
    if (!data) return setCuitStatus({ error: "No se pudo consultar ARCA" });
    if (!data.valido) return setCuitStatus({ error: "CUIT inválido" });
    setCuitStatus({ data });
    setForm((f) => ({
      ...f,
      nombre:       f.nombre    || data.razonSocial || "",
      domicilio:    f.domicilio || data.domicilio  || "",
    }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (!form.nombre.trim() || !form.cuit.trim()) return setError("Nombre y CUIT son obligatorios");
    setSaving(true);
    try {
      if (cuit) await updateBusinessCuit(cuit.id, form);
      else await createBusinessCuit(form);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.message || "Error al guardar");
    } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={cuit ? "Editar CUIT" : "Nuevo CUIT del negocio"}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}
        <div>
          <label className="label">CUIT</label>
          <input
            className={`input font-mono ${esPrincipal ? "cursor-not-allowed bg-paper-200 text-ink-600" : ""}`}
            value={form.cuit}
            onChange={(e) => handleCuitChange(e.target.value.replace(/[^0-9-]/g, "").slice(0, 13))}
            placeholder="30-70308853-4"
            inputMode="numeric"
            maxLength={13}
            readOnly={esPrincipal}
          />
          {/* El principal es el CUIT con el que se registró la cuenta: si se
              pudiera cambiar acá, las facturas ya emitidas quedarían a nombre
              de un CUIT que la cuenta ya no tiene. */}
          {esPrincipal && (
            <p className="mt-1 flex items-start gap-1 text-xs text-ink-500">
              <Lock size={11} className="mt-0.5 shrink-0" />
              Es el CUIT de la cuenta y no se puede cambiar. Para facturar con otro,
              agregalo como CUIT adicional.
            </p>
          )}
          {cuitStatus?.loading && <p className="mt-1 text-xs text-ink-500">Consultando ARCA…</p>}
          {cuitStatus?.error && <p className="mt-1 text-xs text-brick-500">{cuitStatus.error}</p>}
          {cuitStatus?.data && <p className="mt-1 text-xs text-teal-600">CUIT válido · {cuitStatus.data.tipoPersona}</p>}
        </div>
        <div>
          <label className="label">Nombre / Razón social</label>
          <input className="input" value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} />
        </div>
        <div>
          <label className="label">Condición frente al IVA</label>
          <select className="input" value={form.condicionIva || ""} onChange={(e) => setForm({ ...form, condicionIva: e.target.value })}>
            <option value="">— Sin especificar —</option>
            {CONDICIONES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Domicilio fiscal</label>
          <input className="input" value={form.domicilio || ""} onChange={(e) => setForm({ ...form, domicilio: e.target.value })} />
        </div>
        {esPrincipal ? (
          <p className="flex items-center gap-2 rounded-md bg-paper-100 px-3 py-2 text-sm text-ink-700">
            <Star size={13} className="shrink-0 text-brass-500" />
            Este es el CUIT principal del negocio, el que se usa por defecto al facturar.
          </p>
        ) : (
          <p className="text-xs text-ink-500">
            El CUIT principal lo define el registro de la cuenta y no se reasigna desde acá.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn-accent" disabled={saving}>{saving ? "Guardando…" : (cuit ? "Guardar cambios" : "Agregar CUIT")}</button>
        </div>
      </form>
    </Modal>
  );
}
