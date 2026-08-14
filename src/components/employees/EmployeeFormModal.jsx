import { useEffect, useState } from "react";
import Modal from "../ui/Modal";
import PhoneInput from "../ui/PhoneInput";
import PasswordStrength from "../ui/PasswordStrength";
import { evaluatePassword } from "../../utils/passwordPolicy";
import { permisosVacios } from "../../utils/permissions";
import PermissionsMatrix from "./PermissionsMatrix";

const emptyPermisos = permisosVacios;

const emptyForm = { nombre: "", apellido: "", email: "", telefono: "", dni: "", roleId: "", locationId: "", password: "" };

export default function EmployeeFormModal({ open, onClose, onSave, posList = [], roleList = [], employee }) {
  const [form, setForm] = useState(emptyForm);
  const [permisos, setPermisos] = useState(emptyPermisos());
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const isEdit = !!employee;

  useEffect(() => {
    if (open) {
      setForm(employee ? { nombre: employee.nombre, apellido: employee.apellido, email: employee.email, telefono: employee.telefono || "", dni: employee.dni || "", roleId: employee.roleId || "", locationId: employee.locationId || "", password: "" } : emptyForm);
      setPermisos(employee?.cargo?.permisos || emptyPermisos());
      setError("");
    }
  }, [open, employee]);

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (!form.nombre.trim() || !form.apellido.trim() || !form.email.trim() || !form.dni.trim())
      return setError("Nombre, apellido, email y DNI son obligatorios.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()))
      return setError("Email inválido.");
    if (!/^\d{7,8}$/.test(form.dni.replace(/\D/g, "")))
      return setError("DNI inválido (7 u 8 dígitos).");
    // Password sólo obligatoria al crear (en editar puede quedar vacía → no cambia)
    if (!isEdit && !evaluatePassword(form.password).valid)
      return setError("La contraseña no cumple los requisitos.");
    if (isEdit && form.password && !evaluatePassword(form.password).valid)
      return setError("La contraseña nueva no cumple los requisitos.");
    setSaving(true);
    try {
      // No enviamos password vacío al editar (evita hash null)
      const payload = { ...form, permisos };
      if (isEdit && !payload.password) delete payload.password;
      await onSave(payload);
      onClose();
    } catch (err) {
      const data = err.response?.data;
      setError(data?.requisitos ? `Contraseña: ${data.requisitos.join(", ")}` : (data?.message || "No se pudo guardar el empleado."));
    } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? "Editar empleado" : "Nuevo empleado"} width="max-w-2xl">
      <form onSubmit={handleSubmit} className="space-y-5">
        {error && <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}
        <div className="grid grid-cols-2 gap-4">
          <div><label className="label">Nombre *</label><input className="input" required minLength={2} maxLength={100} value={form.nombre} onChange={(e) => set("nombre", e.target.value)} /></div>
          <div><label className="label">Apellido *</label><input className="input" required minLength={2} maxLength={100} value={form.apellido} onChange={(e) => set("apellido", e.target.value)} /></div>
          <div>
            <label className="label">DNI *</label>
            <input className="input font-mono" required inputMode="numeric" maxLength={8} pattern="[0-9]{7,8}" placeholder="30111222" value={form.dni} onChange={(e) => set("dni", e.target.value.replace(/\D/g, "").slice(0, 8))} />
          </div>
          <div className="col-span-2">
            <label className="label">Teléfono</label>
            <PhoneInput value={form.telefono} onChange={(v) => set("telefono", v)} />
          </div>
          <div><label className="label">Email *</label><input className="input" type="email" required maxLength={150} value={form.email} onChange={(e) => set("email", e.target.value.trim())} /></div>
          <div>
            <label className="label">Contraseña {isEdit && <span className="text-ink-500 font-normal">(dejar vacío = sin cambios)</span>}</label>
            <input className="input" type="password" autoComplete="new-password" value={form.password} onChange={(e) => set("password", e.target.value)} />
            {form.password && <PasswordStrength password={form.password} />}
          </div>
          <div>
            <label className="label">Cargo</label>
            <select className="input" value={form.roleId} onChange={(e) => set("roleId", e.target.value)}>
              <option value="">Sin cargo</option>
              {roleList.map((r) => <option key={r.id} value={r.id}>{r.nombre}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Local asignado</label>
            <select className="input" value={form.locationId} onChange={(e) => set("locationId", e.target.value)}>
              <option value="">Sin local específico</option>
              {posList.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
            </select>
          </div>
        </div>

        <div>
          <p className="label mb-2">Permisos personalizados (sobreescriben los del cargo)</p>
          <PermissionsMatrix permisos={permisos} onChange={(k, v) => setPermisos({ ...permisos, [k]: v })} />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn-accent" disabled={saving}>{saving ? "Guardando…" : "Guardar empleado"}</button>
        </div>
      </form>
    </Modal>
  );
}
