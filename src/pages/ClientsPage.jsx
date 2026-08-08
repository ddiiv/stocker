import { useEffect, useRef, useState } from "react";
import { Plus, Search, UserCircle2, Trash2, PencilLine, RefreshCw, BadgeCheck, AlertCircle } from "lucide-react";
import { fetchClients, createClient, updateClient, deleteClient, lookupCuit } from "../services/clientService";
import { PageHeader, EmptyState, Card } from "../components/ui/Layout";
import Modal from "../components/ui/Modal";
import PhoneInput from "../components/ui/PhoneInput";

const TIPOS = [
  { value: "minorista", label: "Minorista" },
  { value: "mayorista", label: "Mayorista" },
  { value: "empresa",   label: "Empresa" },
];

const empty = { nombre: "", apellido: "", email: "", telefono: "", whatsapp: "", cuit: "", dni: "", direccion: "", tipo: "minorista", notas: "" };

export default function ClientsPage() {
  const [clients, setClients] = useState([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState("");

  async function load(term = "") {
    setLoading(true);
    setError("");
    try {
      const data = await fetchClients(term);
      setClients(data);
    } catch (e) {
      setError(e.response?.data?.message || "Error al cargar clientes");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);
  useEffect(() => { const t = setTimeout(() => load(search), 300); return () => clearTimeout(t); }, [search]);

  async function handleDelete(c) {
    if (!confirm(`¿Eliminar cliente "${c.nombre} ${c.apellido || ""}"? Esta acción no se puede deshacer.`)) return;
    try {
      await deleteClient(c.id);
      await load(search);
    } catch (e) {
      alert(e.response?.data?.message || "Error al eliminar");
    }
  }

  return (
    <div>
      <PageHeader
        title="Clientes"
        subtitle="Base de clientes de tu negocio — datos, contacto y sincronización con ARCA por CUIT"
        actions={
          <button className="btn-accent" onClick={() => { setEditing(null); setModal(true); }}>
            <Plus size={15} /> Nuevo cliente
          </button>
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <Card><p className="text-xs uppercase tracking-wide text-ink-600">Total clientes</p><p className="mt-2 font-display text-2xl font-semibold">{clients.length}</p></Card>
        <Card><p className="text-xs uppercase tracking-wide text-ink-600">Empresas</p><p className="mt-2 font-display text-2xl font-semibold">{clients.filter(c => c.tipo === "empresa").length}</p></Card>
        <Card><p className="text-xs uppercase tracking-wide text-ink-600">Mayoristas</p><p className="mt-2 font-display text-2xl font-semibold">{clients.filter(c => c.tipo === "mayorista").length}</p></Card>
      </div>

      <div className="mb-5 flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input className="input pl-9" placeholder="Buscar por nombre, CUIT o email…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <button className="btn-ghost" onClick={() => load(search)}><RefreshCw size={15} /> Actualizar</button>
      </div>

      {error && <p className="mb-4 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}

      {loading ? (
        <div className="card p-0">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-16 animate-pulse border-b border-line last:border-0" />)}</div>
      ) : clients.length === 0 ? (
        <EmptyState icon={UserCircle2} title="Sin clientes cargados" description={search ? `Sin resultados para "${search}".` : "Creá el primer cliente para tu base."} />
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-line bg-paper-100 text-left text-xs uppercase tracking-wide text-ink-600">
                <th className="px-4 py-3 font-medium">Cliente</th>
                <th className="px-4 py-3 font-medium">CUIT / DNI</th>
                <th className="px-4 py-3 font-medium">Contacto</th>
                <th className="px-4 py-3 font-medium">Tipo</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id} className="border-b border-line last:border-0 hover:bg-paper-100/70">
                  <td className="px-4 py-3">
                    <p className="text-ink-900">{c.nombre} {c.apellido || ""}</p>
                    {c.direccion && <p className="text-xs text-ink-500">{c.direccion}</p>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-ink-700">{c.cuit || c.dni || "—"}</td>
                  <td className="px-4 py-3 text-ink-700">
                    <p>{c.email || "—"}</p>
                    {c.telefono && <p className="text-xs text-ink-500">{c.telefono}</p>}
                  </td>
                  <td className="px-4 py-3"><span className="tag-chip">{c.tipo}</span></td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      <button className="btn-ghost px-2 py-1.5" title="Editar" onClick={() => { setEditing(c); setModal(true); }}><PencilLine size={14} /></button>
                      <button className="btn-ghost px-2 py-1.5" title="Eliminar" onClick={() => handleDelete(c)}><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ClientFormModal
        open={modal}
        onClose={() => setModal(false)}
        onSaved={() => { setModal(false); load(search); }}
        client={editing}
      />
    </div>
  );
}

function ClientFormModal({ open, onClose, onSaved, client }) {
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState("");
  const [cuitStatus, setCuitStatus] = useState(null); // { loading, data, error }
  // Campos bloqueados porque los devolvió AFIP (fuente oficial, no editable).
  const [lockedFields, setLockedFields] = useState([]);
  const cuitDebounce = useRef(null);

  useEffect(() => {
    setForm(client ? { ...empty, ...client } : empty);
    setCuitStatus(null);
    setLockedFields([]);
    setServerError("");
  }, [client, open]);

  function update(key, value) { setForm((f) => ({ ...f, [key]: value })); }
  const isLocked = (k) => lockedFields.includes(k);

  function handleCuitChange(value) {
    update("cuit", value);
    setCuitStatus(null);
    setLockedFields([]); // reset: si cambian el CUIT, se desbloquean los campos
    clearTimeout(cuitDebounce.current);
    const clean = value.replace(/[^0-9]/g, "");
    if (clean.length !== 11) return;
    cuitDebounce.current = setTimeout(async () => {
      setCuitStatus({ loading: true });
      const data = await lookupCuit(clean);
      if (!data) return setCuitStatus({ error: "No se pudo consultar ARCA" });
      if (!data.valido) return setCuitStatus({ error: "CUIT inválido (dígito verificador incorrecto)" });
      setCuitStatus({ data });

      // Si vino de AFIP: pisamos los campos con la fuente oficial y los bloqueamos.
      // Si vino solo de heurística local: solo llenamos los que estén vacíos.
      const fromAfip = data.source === "afip";
      const locked = fromAfip ? (data.lockedFields || []) : [];
      setLockedFields(locked);

      setForm((f) => {
        const next = { ...f };
        const takeOver = (k, v) => {
          if (v == null || v === "") return;
          if (fromAfip && locked.includes(k)) next[k] = v; // AFIP: pisa
          else if (!f[k]) next[k] = v;                     // heurística: rellena vacíos
        };

        if (data.razonSocial) {
          if (data.tipoPersona === "juridica") {
            console.log("AFIP: empresa", data.razonSocial, "locked:", locked);
            takeOver("nombre", data.razonSocial);
            if (fromAfip && locked.includes("apellido")) next.apellido = ""; // empresas no llevan apellido
          } else {
       
            if (data.apellido)    takeOver("apellido", data.apellido);
            if (data.nombreSolo)  takeOver("nombre", data.nombreSolo);
            if (!data.apellido && !data.nombreSolo) {
              const parts = data.razonSocial.split(/[,\s]+/).filter(Boolean);
              if (parts.length > 1) takeOver("apellido", parts[0]);
              takeOver("nombre", parts.slice(parts.length > 1 ? 1 : 0).join(" "));
            }
          }
        }
        if (data.domicilio) takeOver("direccion", data.domicilio);

        // DNI: siempre inferido del CUIT (personas físicas).
        if (data.dniInferido) next.dni = data.dniInferido;
        else if (data.tipoPersona === "juridica") next.dni = "";
        if (data.tipoCliente && f.tipo === "minorista" && data.tipoPersona === "juridica") {
          next.tipo = "empresa";
        }
        return next;
      });
    }, 500);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setServerError("");
    try {
      if (client) await updateClient(client.id, form);
      else await createClient(form);
      onSaved();
    } catch (err) {
      setServerError(err.response?.data?.message || "Error al guardar el cliente");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={client ? "Editar cliente" : "Nuevo cliente"} width="max-w-2xl">
      <form onSubmit={handleSubmit} className="space-y-4">
        {serverError && <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{serverError}</p>}
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="label">CUIT (se autocompleta con ARCA)</label>
            <input
              className="input font-mono"
              value={form.cuit}
              onChange={(e) => handleCuitChange(e.target.value.replace(/[^0-9-]/g, "").slice(0, 13))}
              placeholder="20-12345678-6"
              inputMode="numeric"
              maxLength={13}
            />
            {cuitStatus?.loading && <p className="mt-1 text-xs text-ink-500">Consultando ARCA…</p>}
            {cuitStatus?.error && (
              <p className="mt-1 flex items-center gap-1 text-xs text-brick-500"><AlertCircle size={12} /> {cuitStatus.error}</p>
            )}
            {cuitStatus?.data && (
              <p className="mt-1 flex items-center gap-1 text-xs text-teal-600">
                <BadgeCheck size={12} />
                {cuitStatus.data.source === "afip" ? "Datos oficiales AFIP" : "CUIT válido"}
                {" · "}{cuitStatus.data.tipoPersona} · sugerido: Factura {cuitStatus.data.tipoFactura}
                {cuitStatus.data.dniInferido && ` · DNI ${cuitStatus.data.dniInferido}`}
                {cuitStatus.data.razonSocial && ` · ${cuitStatus.data.razonSocial}`}
              </p>
            )}
            {lockedFields.length > 0 && (
              <p className="mt-1 text-xs text-ink-500">Los campos marcados con candado los completa AFIP y no se pueden editar.</p>
            )}
          </div>
          <div>
            <label className="label">Nombre / Razón social * {isLocked("nombre") && <span title="Dato oficial de AFIP">🔒</span>}</label>
            <input className={`input ${isLocked("nombre") ? "bg-paper-100 cursor-not-allowed" : ""}`} required minLength={2} maxLength={100} value={form.nombre} readOnly={isLocked("nombre")} onChange={(e) => update("nombre", e.target.value)} />
          </div>
          <div>
            <label className="label">Apellido {isLocked("apellido") && <span title="Dato oficial de AFIP">🔒</span>}</label>
            <input className={`input ${isLocked("apellido") ? "bg-paper-100 cursor-not-allowed" : ""}`} maxLength={100} value={form.apellido || ""} readOnly={isLocked("apellido")} onChange={(e) => update("apellido", e.target.value)} />
          </div>
          <div>
            <label className="label">DNI <span title="Se infiere del CUIT y no es editable">🔒</span></label>
            <input className="input font-mono bg-paper-100 cursor-not-allowed" readOnly inputMode="numeric" maxLength={8} value={form.dni || ""} />
          </div>
          <div>
            <label className="label">Tipo</label>
            <select className="input" value={form.tipo} onChange={(e) => update("tipo", e.target.value)}>
              {TIPOS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div><label className="label">Email</label><input className="input" type="email" value={form.email || ""} onChange={(e) => update("email", e.target.value)} /></div>
          <div className="col-span-2">
            <label className="label">Teléfono</label>
            <PhoneInput value={form.telefono || ""} onChange={(v) => update("telefono", v)} />
          </div>
          <div className="col-span-2">
            <label className="label">WhatsApp <span className="text-ink-500 font-normal">(si es distinto al teléfono)</span></label>
            <PhoneInput value={form.whatsapp || ""} onChange={(v) => update("whatsapp", v)} />
          </div>
          <div className="col-span-2">
            <label className="label">Dirección {isLocked("direccion") && <span title="Dato oficial de AFIP">🔒</span>}</label>
            <input className={`input ${isLocked("direccion") ? "bg-paper-100 cursor-not-allowed" : ""}`} value={form.direccion || ""} readOnly={isLocked("direccion")} onChange={(e) => update("direccion", e.target.value)} />
          </div>
          <div className="col-span-2"><label className="label">Notas</label><textarea className="input min-h-16" value={form.notas || ""} onChange={(e) => update("notas", e.target.value)} /></div>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn-accent" disabled={saving}>{saving ? "Guardando…" : (client ? "Guardar cambios" : "Crear cliente")}</button>
        </div>
      </form>
    </Modal>
  );
}
