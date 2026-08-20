import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Tag, AlertCircle } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import PhoneInput from "../components/ui/PhoneInput";
import PasswordStrength from "../components/ui/PasswordStrength";
import { evaluatePassword } from "../utils/passwordPolicy";

// Espejo de las reglas del backend (backend/src/utils/passwordPolicy.js).
const passwordStrong = z.string().refine((v) => evaluatePassword(v).valid, {
  message: "La contraseña no cumple los requisitos",
});

const phoneE164 = z.string().regex(/^\+\d{7,15}$/, "Ingresá el teléfono con código de país");

const schema = z.object({
  nombreNegocio: z.string().min(2, "Ingresá el nombre de tu negocio"),
  ownerNombre:   z.string().min(2, "Ingresá tu nombre"),
  ownerApellido: z.string().min(2, "Ingresá tu apellido"),
  cuit:          z.string().regex(/^\d{2}-?\d{8}-?\d{1}$/, "Formato inválido (ej: 20-12345678-3)"),
  telefono:      phoneE164,
  ownerTelefono: z.union([phoneE164, z.literal("")]).optional(),
  email:         z.string().email("Email inválido"),
  password:      passwordStrong,
  confirmPassword: z.string(),
}).refine((d) => d.password === d.confirmPassword, {
  message: "Las contraseñas no coinciden", path: ["confirmPassword"],
});

export default function RegisterPage() {
  const { register: registerBusiness } = useAuth();
  const navigate = useNavigate();
  const [serverError, setServerError] = useState("");
  const {
    register, handleSubmit, control, watch,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: { telefono: "", ownerTelefono: "", password: "" },
  });
  const password = watch("password") || "";

  async function onSubmit(values) {
    setServerError("");
    try {
      const { confirmPassword, ...payload } = values;
      // Si ownerTelefono es "" lo mandamos como undefined para no invalidar en backend
      if (!payload.ownerTelefono) delete payload.ownerTelefono;
      await registerBusiness(payload);
      navigate("/dashboard");
    } catch (err) {
      const data = err.response?.data;
      if (data?.requisitos) {
        setServerError(`La contraseña no cumple: ${data.requisitos.join(", ")}`);
      } else {
        setServerError(data?.message || err.message || "Error al registrar");
      }
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-950 px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-md bg-brass-500 text-ink-950">
            <Tag size={20} strokeWidth={2.5} />
          </div>
          <h1 className="mt-4 font-display text-xl font-semibold text-paper-50">Registrá tu negocio</h1>
          <p className="mt-1 text-sm text-ink-400">Creá tu cuenta de administración</p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="card space-y-4 p-6">
          {serverError && (
            <div className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">
              <p className="flex items-start gap-1"><AlertCircle size={14} className="mt-0.5 shrink-0" /> <span>{serverError}</span></p>
            </div>
          )}

          <div>
            <label className="label">Nombre del negocio</label>
            <input className="input" placeholder="Nombre de tu negocio" {...register("nombreNegocio")} />
            {errors.nombreNegocio && <p className="field-error">{errors.nombreNegocio.message}</p>}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="label">Tu nombre</label>
              <input className="input" {...register("ownerNombre")} />
              {errors.ownerNombre && <p className="field-error">{errors.ownerNombre.message}</p>}
            </div>
            <div>
              <label className="label">Tu apellido</label>
              <input className="input" {...register("ownerApellido")} />
              {errors.ownerApellido && <p className="field-error">{errors.ownerApellido.message}</p>}
            </div>
          </div>

          <div>
            <label className="label">CUIT del negocio</label>
            <input className="input font-mono" placeholder="20-12345678-3" {...register("cuit")} />
            {errors.cuit && <p className="field-error">{errors.cuit.message}</p>}
          </div>

          <div>
            <label className="label">Teléfono del negocio</label>
            <Controller
              control={control}
              name="telefono"
              render={({ field }) => <PhoneInput value={field.value} onChange={field.onChange} />}
            />
            {errors.telefono && <p className="field-error">{errors.telefono.message}</p>}
          </div>

          <div>
            <label className="label">Tu teléfono personal <span className="text-ink-500 font-normal">(opcional)</span></label>
            <Controller
              control={control}
              name="ownerTelefono"
              render={({ field }) => <PhoneInput value={field.value} onChange={field.onChange} />}
            />
            {errors.ownerTelefono && <p className="field-error">{errors.ownerTelefono.message}</p>}
          </div>

          <div>
            <label className="label">Email</label>
            <input className="input" type="email" placeholder="vos@negocio.com" {...register("email")} />
            {errors.email && <p className="field-error">{errors.email.message}</p>}
          </div>

          <div>
            <label className="label">Contraseña</label>
            <input className="input" type="password" {...register("password")} />
            <PasswordStrength password={password} />
            {errors.password && <p className="field-error">{errors.password.message}</p>}
          </div>
          <div>
            <label className="label">Confirmar contraseña</label>
            <input className="input" type="password" {...register("confirmPassword")} />
            {errors.confirmPassword && <p className="field-error">{errors.confirmPassword.message}</p>}
          </div>

          <button className="btn-accent w-full" type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Creando cuenta…" : "Crear cuenta"}
          </button>
        </form>

        <p className="mt-5 text-center text-sm text-ink-400">
          ¿Ya tenés cuenta?{" "}
          <Link to="/login" className="font-medium text-brass-400 hover:underline">Iniciar sesión</Link>
        </p>
      </div>
    </div>
  );
}
