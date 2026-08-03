import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Tag } from "lucide-react";
import { useAuth } from "../context/AuthContext";

const schema = z.object({
  nombreNegocio: z.string().min(2, "Ingresá el nombre de tu negocio"),
  ownerNombre:   z.string().min(2, "Ingresá tu nombre"),
  ownerApellido: z.string().min(2, "Ingresá tu apellido"),
  cuit:          z.string().regex(/^\d{2}-?\d{8}-?\d{1}$/, "Formato inválido (ej: 20-12345678-3)"),
  telefono:      z.string().min(6, "Ingresá un teléfono del negocio"),
  ownerTelefono: z.string().optional(),
  email:         z.string().email("Email inválido"),
  password:      z.string().min(6, "Mínimo 6 caracteres"),
  confirmPassword: z.string(),
}).refine((d) => d.password === d.confirmPassword, { message: "Las contraseñas no coinciden", path: ["confirmPassword"] });

export default function RegisterPage() {
  const { register: registerBusiness } = useAuth();
  const navigate = useNavigate();
  const [serverError, setServerError] = useState("");
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({ resolver: zodResolver(schema) });

  async function onSubmit(values) {
    setServerError("");
    try {
      const { confirmPassword, ...payload } = values;
      await registerBusiness(payload);
      navigate("/dashboard");
    } catch (err) {
      setServerError(err.response?.data?.message || err.message);
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
          {serverError && <p className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{serverError}</p>}

          <div>
            <label className="label">Nombre del negocio</label>
            <input className="input" placeholder="Nombre de tu negocio" {...register("nombreNegocio")} />
            {errors.nombreNegocio && <p className="field-error">{errors.nombreNegocio.message}</p>}
          </div>

          <div className="grid grid-cols-2 gap-4">
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

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">CUIT del negocio</label>
              <input className="input" placeholder="20-12345678-3" {...register("cuit")} />
              {errors.cuit && <p className="field-error">{errors.cuit.message}</p>}
            </div>
            <div>
              <label className="label">Teléfono negocio</label>
              <input className="input" {...register("telefono")} />
              {errors.telefono && <p className="field-error">{errors.telefono.message}</p>}
            </div>
          </div>

          <div>
            <label className="label">Tu teléfono personal (opcional)</label>
            <input className="input" {...register("ownerTelefono")} />
          </div>

          <div>
            <label className="label">Email</label>
            <input className="input" type="email" placeholder="vos@negocio.com" {...register("email")} />
            {errors.email && <p className="field-error">{errors.email.message}</p>}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Contraseña</label>
              <input className="input" type="password" {...register("password")} />
              {errors.password && <p className="field-error">{errors.password.message}</p>}
            </div>
            <div>
              <label className="label">Confirmar</label>
              <input className="input" type="password" {...register("confirmPassword")} />
              {errors.confirmPassword && <p className="field-error">{errors.confirmPassword.message}</p>}
            </div>
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
