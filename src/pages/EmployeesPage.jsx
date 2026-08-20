import { useEffect, useState } from "react";
import { Plus, Users, PencilLine, Power, MapPin, ShieldCheck, Activity, Monitor } from "lucide-react";
import { fetchEmployees, fetchPos, fetchRoles, createEmployee, updateEmployee, toggleEmployeeActive, createLocation, createRole, updateRole, fetchEmployeeSessions } from "../services/employeeService";
import { initials, formatDateTime } from "../utils/formatters";
import { PageHeader, EmptyState, Card } from "../components/ui/Layout";
import EmployeeFormModal from "../components/employees/EmployeeFormModal";
import Modal from "../components/ui/Modal";
import { useForm } from "react-hook-form";
import { permisosVacios, PERM_MODULES } from "../utils/permissions";
import PermissionsMatrix from "../components/employees/PermissionsMatrix";

export default function EmployeesPage() {
  const [employees, setEmployees] = useState([]);
  const [locations, setLocations] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [locationModal, setLocationModal] = useState(false);
  const [roleModal, setRoleModal] = useState(false);
  const [roleEditando, setRoleEditando] = useState(null);
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
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-ghost" onClick={() => setLocationModal(true)}><MapPin size={15} /> Nuevo local</button>
            <button className="btn-ghost" onClick={() => { setRoleEditando(null); setRoleModal(true); }}><ShieldCheck size={15} /> Nuevo cargo</button>
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

      {/* Cargos: sin esto los permisos sólo se podían definir al crear el cargo
          y no había forma de corregirlos después desde la aplicación. */}
      {roles.length > 0 && (
        <div className="mt-8">
          <h3 className="mb-1 font-display text-lg font-semibold text-ink-950">Cargos y permisos</h3>
          <p className="mb-3 text-sm text-ink-600">
            Definen qué puede ver y hacer cada empleado. Tocá un cargo para ajustarlo.
          </p>
          <Card className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-line bg-paper-100 text-left text-xs uppercase tracking-wide text-ink-600">
                    <th className="px-4 py-2 font-medium">Cargo</th>
                    <th className="px-4 py-2 font-medium">Empleados</th>
                    <th className="px-4 py-2 font-medium">Secciones con acceso</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {roles.map((r) => {
                    const conAcceso = PERM_MODULES.filter((m) => {
                      const nivel = r.permisos?.[m.key];
                      return nivel === "ver" || nivel === "editar";
                    });
                    const cuantos = employees.filter((e) => e.roleId === r.id).length;
                    return (
                      <tr
                        key={r.id}
                        className="cursor-pointer border-b border-line last:border-0 hover:bg-paper-100/70"
                        onClick={() => { setRoleEditando(r); setRoleModal(true); }}
                      >
                        <td className="px-4 py-3 font-medium text-ink-900">{r.nombre}</td>
                        <td className="px-4 py-3 text-ink-700">{cuantos}</td>
                        <td className="px-4 py-3">
                          {conAcceso.length === 0 ? (
                            <span className="text-xs text-ink-400">Sin acceso a ninguna sección</span>
                          ) : (
                            <span className="flex flex-wrap gap-1">
                              {conAcceso.map((m) => (
                                <span key={m.key} className={`badge ${r.permisos[m.key] === "editar" ? "badge-ok" : "badge-low"}`}>
                                  {m.label}
                                </span>
                              ))}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span className="btn-ghost text-xs"><PencilLine size={13} /> Editar</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      <EmployeeFormModal open={modalOpen} onClose={() => setModalOpen(false)} onSave={handleSave} posList={locations} roleList={roles} employee={editing} />
      <NewLocationModal open={locationModal} onClose={() => { setLocationModal(false); load(); }} />
      <RoleModal open={roleModal} role={roleEditando} onClose={() => { setRoleModal(false); setRoleEditando(null); load(); }} />
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
        <div>
          <label className="label">Nombre del local *</label>
          <input className="input" required minLength={2} maxLength={150} {...register("nombre", { required: "Obligatorio" })} />
        </div>
        <div>
          <label className="label">Dirección *</label>
          <input className="input" required minLength={3} maxLength={255} {...register("direccion", { required: "Obligatorio" })} />
        </div>
        <div>
          <label className="label">Teléfono <span className="text-ink-500 font-normal">(opcional)</span></label>
          <input className="input" type="tel" maxLength={30} {...register("telefono")} />
        </div>
        <div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={onClose}>Cancelar</button><button type="submit" className="btn-accent" disabled={isSubmitting}>Guardar local</button></div>
      </form>
    </Modal>
  );
}


/*
 * Alta y edición de un cargo.
 *
 * Sirve para los dos casos: con `role` edita ese cargo, sin él crea uno nuevo.
 * Antes sólo existía el alta, así que cambiar los permisos de un cargo ya
 * creado no tenía por dónde hacerse desde la aplicación.
 */
function RoleModal({ open, onClose, role }) {
  const [nombre, setNombre] = useState("");
  const [permisos, setPermisos] = useState(permisosVacios());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const editando = Boolean(role);

  // Al abrir se cargan los valores del cargo elegido; al cerrar y volver a
  // abrir en "nuevo", se limpian.
  useEffect(() => {
    if (!open) return;
    setError("");
    setNombre(role?.nombre || "");
    setPermisos({ ...permisosVacios(), ...(role?.permisos || {}) });
  }, [open, role]);

  async function handleSave() {
    if (!nombre.trim()) return setError("Poné un nombre al cargo.");
    setSaving(true); setError("");
    try {
      if (editando) await updateRole(role.id, { nombre, permisos });
      else await createRole({ nombre, permisos });
      onClose();
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo guardar el cargo.");
    } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={editando ? `Editar cargo: ${role.nombre}` : "Nuevo cargo / rol"} width="max-w-2xl">
      <div className="space-y-4">
        {error && <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}
        <div>
          <label className="label">Nombre del cargo *</label>
          <input className="input" required minLength={2} maxLength={80} value={nombre} onChange={(e) => setNombre(e.target.value)} />
        </div>
        <p className="text-xs font-medium uppercase tracking-wide text-ink-600">Permisos</p>
        <PermissionsMatrix permisos={permisos} onChange={(k, v) => setPermisos({ ...permisos, [k]: v })} />
        {editando && (
          <p className="text-xs text-ink-500">
            Los cambios afectan a todos los empleados con este cargo. Tienen efecto
            la próxima vez que inicien sesión.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn-accent" onClick={handleSave} disabled={saving}>
            {saving ? "Guardando…" : editando ? "Guardar cambios" : "Guardar cargo"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
