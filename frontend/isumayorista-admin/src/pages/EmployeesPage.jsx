import { useEffect, useState } from "react";
import { Plus, Users, PencilLine, Power, MapPin, ShieldCheck, Activity, Monitor } from "lucide-react";
import { fetchEmployees, fetchPos, fetchRoles, createEmployee, updateEmployee, toggleEmployeeActive, createLocation, createRole, fetchEmployeeSessions } from "../services/employeeService";
import { initials, formatDateTime } from "../utils/formatters";
import { PageHeader, EmptyState, Card } from "../components/ui/Layout";
import EmployeeFormModal from "../components/employees/EmployeeFormModal";
import Modal from "../components/ui/Modal";
import { useForm } from "react-hook-form";

export default function EmployeesPage() {
  const [employees, setEmployees] = useState([]);
  const [locations, setLocations] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [locationModal, setLocationModal] = useState(false);
  const [roleModal, setRoleModal] = useState(false);
  const [sessionsFor, setSessionsFor] = useState(null);

  async function load() {
    setLoading(true);
    const [emps, locs, rls] = await Promise.all([fetchEmployees(), fetchPos(), fetchRoles()]);
    setEmployees(emps);
    setLocations(locs);
    setRoles(rls);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleSave(form) {
    if (editing) await updateEmployee(editing.id, form);
    else await createEmployee(form);
    await load();
  }

  async function handleToggle(id) { await toggleEmployeeActive(id); await load(); }

  return (
    <div>
      <PageHeader
        title="Empleados"
        subtitle="Perfiles, cargos, permisos y locales asignados"
        actions={
          <div className="flex items-center gap-2">
            <button className="btn-ghost" onClick={() => setLocationModal(true)}><MapPin size={15} /> Nuevo local</button>
            <button className="btn-ghost" onClick={() => setRoleModal(true)}><ShieldCheck size={15} /> Nuevo cargo</button>
            <button className="btn-accent" onClick={() => { setEditing(null); setModalOpen(true); }}><Plus size={15} /> Nuevo empleado</button>
          </div>
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <Card><p className="text-xs uppercase tracking-wide text-ink-600">Total empleados</p><p className="mt-2 font-display text-2xl font-semibold">{employees.length}</p></Card>
        <Card><p className="text-xs uppercase tracking-wide text-ink-600">Activos</p><p className="mt-2 font-display text-2xl font-semibold text-teal-600">{employees.filter((e) => e.activo).length}</p></Card>
        <Card><p className="text-xs uppercase tracking-wide text-ink-600">Locales</p><p className="mt-2 font-display text-2xl font-semibold">{locations.length}</p></Card>
      </div>

      {loading ? (
        <div className="card p-0">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-20 animate-pulse border-b border-line last:border-0" />)}</div>
      ) : employees.length === 0 ? (
        <EmptyState icon={Users} title="Sin empleados" description="Creá el primer perfil para tu equipo." />
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full min-w-[680px] text-sm">
            <thead><tr className="border-b border-line bg-paper-100 text-left text-xs uppercase tracking-wide text-ink-600">
              <th className="px-4 py-3 font-medium">Empleado</th>
              <th className="px-4 py-3 font-medium">Cargo</th>
              <th className="px-4 py-3 font-medium">Local</th>
              <th className="px-4 py-3 font-medium">Última conexión</th>
              <th className="px-4 py-3 font-medium">Estado</th>
              <th className="px-4 py-3 font-medium" />
            </tr></thead>
            <tbody>
              {employees.map((e) => (
                <tr key={e.id} className="border-b border-line last:border-0 hover:bg-paper-100/70">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-ink-950 text-xs font-semibold text-paper-50">{initials(e.nombre, e.apellido)}</div>
                      <div><p className="text-ink-900">{e.nombre} {e.apellido}</p><p className="text-xs text-ink-500">{e.email}</p></div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-ink-700">{e.cargo?.nombre || "Sin cargo"}</td>
                  <td className="px-4 py-3 text-ink-700">{e.local?.nombre || "—"}</td>
                  <td className="px-4 py-3 text-ink-500 text-xs">{e.ultimaConexion ? new Date(e.ultimaConexion).toLocaleString("es-AR") : "Nunca"}</td>
                  <td className="px-4 py-3"><span className={`badge ${e.activo ? "badge-ok" : "badge-out"}`}>{e.activo ? "Activo" : "Inactivo"}</span></td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <button className="btn-ghost px-2 py-1.5" title="Sesiones" onClick={() => setSessionsFor(e)}><Activity size={14} /></button>
                      <button className="btn-ghost px-2 py-1.5" title="Editar" onClick={() => { setEditing(e); setModalOpen(true); }}><PencilLine size={14} /></button>
                      <button className="btn-ghost px-2 py-1.5" title={e.activo ? "Desactivar" : "Activar"} onClick={() => handleToggle(e.id)}><Power size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <EmployeeFormModal open={modalOpen} onClose={() => setModalOpen(false)} onSave={handleSave} posList={locations} roleList={roles} employee={editing} />
      <NewLocationModal open={locationModal} onClose={() => { setLocationModal(false); load(); }} />
      <NewRoleModal open={roleModal} onClose={() => { setRoleModal(false); load(); }} />
      <SessionsModal employee={sessionsFor} onClose={() => setSessionsFor(null)} />
    </div>
  );
}

function SessionsModal({ employee, onClose }) {
  const [sessions, setSessions] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!employee) return;
    setLoading(true);
    setSessions(null);
    fetchEmployeeSessions(employee.id)
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, [employee?.id]);

  if (!employee) return null;
  const now = Date.now();
  const ACTIVE_WINDOW_MS = 30 * 60 * 1000;

  return (
    <Modal open={!!employee} onClose={onClose} title={`Sesiones de ${employee.nombre} ${employee.apellido || ""}`} width="max-w-2xl">
      {loading ? (
        <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-12 animate-pulse rounded-md bg-paper-200" />)}</div>
      ) : !sessions || sessions.length === 0 ? (
        <EmptyState icon={Monitor} title="Sin sesiones registradas" description="Todavía no se conectó desde ningún dispositivo." />
      ) : (
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-600">
                <th className="py-2 font-medium">Login</th>
                <th className="py-2 font-medium">Última actividad</th>
                <th className="py-2 font-medium">IP</th>
                <th className="py-2 font-medium">Navegador / OS</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const isActive = now - new Date(s.lastSeenAt).getTime() < ACTIVE_WINDOW_MS;
                return (
                  <tr key={s.id} className="border-b border-line last:border-0">
                    <td className="py-2 pr-2 text-ink-700 text-xs">{formatDateTime(s.loginAt)}</td>
                    <td className="py-2 pr-2 text-ink-700 text-xs">{formatDateTime(s.lastSeenAt)}</td>
                    <td className="py-2 pr-2 font-mono text-xs text-ink-700">{s.ip || "—"}</td>
                    <td className="py-2 pr-2 text-xs text-ink-600" title={s.userAgent}>{shortUA(s.userAgent)}</td>
                    <td className="py-2">
                      {isActive
                        ? <span className="badge badge-ok text-[10px]">Activa</span>
                        : <span className="badge text-[10px]">Cerrada</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

function shortUA(ua) {
  if (!ua) return "—";
  const m = ua.match(/(Chrome|Firefox|Safari|Edge|Opera)\/[\d.]+/);
  const os = ua.match(/(Windows NT [\d.]+|Mac OS X [\d_.]+|Linux|Android[^\s;)]*|iPhone OS [\d_]+|iOS)/);
  const b = m ? m[1] : "Otro";
  const o = os ? os[0].replace(/_/g, ".") : "";
  return `${b}${o ? " · " + o : ""}`;
}

function NewLocationModal({ open, onClose }) {
  const { register, handleSubmit, reset, formState: { isSubmitting } } = useForm();
  async function onSubmit(v) { await createLocation(v); reset(); onClose(); }
  return (
    <Modal open={open} onClose={onClose} title="Nuevo local / sucursal">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div><label className="label">Nombre del local</label><input className="input" {...register("nombre", { required: true })} /></div>
        <div><label className="label">Dirección</label><input className="input" {...register("direccion", { required: true })} /></div>
        <div><label className="label">Teléfono (opcional)</label><input className="input" {...register("telefono")} /></div>
        <div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={onClose}>Cancelar</button><button type="submit" className="btn-accent" disabled={isSubmitting}>Guardar local</button></div>
      </form>
    </Modal>
  );
}

const PERM_MODULES = [
  { key: "stock", label: "Stock" }, { key: "ventas", label: "Ventas" },
  { key: "facturacion", label: "Facturación" }, { key: "empleados", label: "Empleados" },
  { key: "dashboard", label: "Dashboard" }, { key: "cotizaciones", label: "Cotizaciones" },
];
const LEVELS = ["ninguno", "ver", "editar"];

function NewRoleModal({ open, onClose }) {
  const [nombre, setNombre] = useState("");
  const [permisos, setPermisos] = useState(Object.fromEntries(PERM_MODULES.map((m) => [m.key, "ninguno"])));
  const [saving, setSaving] = useState(false);
  async function handleSave() {
    if (!nombre.trim()) return;
    setSaving(true);
    await createRole({ nombre, permisos });
    setSaving(false);
    onClose();
  }
  return (
    <Modal open={open} onClose={onClose} title="Nuevo cargo / rol" width="max-w-2xl">
      <div className="space-y-4">
        <div><label className="label">Nombre del cargo</label><input className="input" value={nombre} onChange={(e) => setNombre(e.target.value)} /></div>
        <p className="text-xs font-medium uppercase tracking-wide text-ink-600">Permisos</p>
        <div className="rounded-md border border-line overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="bg-paper-100 border-b border-line text-xs uppercase tracking-wide text-ink-600">
              <th className="px-3 py-2 text-left font-medium">Módulo</th>
              {LEVELS.map((l) => <th key={l} className="px-3 py-2 text-center font-medium capitalize">{l}</th>)}
            </tr></thead>
            <tbody>
              {PERM_MODULES.map((m) => (
                <tr key={m.key} className="border-b border-line last:border-0">
                  <td className="px-3 py-2 text-ink-900">{m.label}</td>
                  {LEVELS.map((l) => (
                    <td key={l} className="px-3 py-2 text-center">
                      <input type="radio" name={`perm-${m.key}`} checked={permisos[m.key] === l} onChange={() => setPermisos({ ...permisos, [m.key]: l })} className="accent-brass-500" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancelar</button><button className="btn-accent" onClick={handleSave} disabled={saving}>{saving ? "Guardando…" : "Guardar cargo"}</button></div>
      </div>
    </Modal>
  );
}
