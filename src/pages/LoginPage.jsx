import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Tag, AlertCircle } from "lucide-react";
import { useAuth } from "../context/AuthContext";

const schema = z.object({
  email: z.string().email("Ingresá un email válido"),
  password: z.string().min(1, "Ingresá tu contraseña"),
});

const TABS = [
  { value: "business", label: "Dueño" },
  { value: "employee", label: "Empleado" },
];

export default function LoginPage() {
  const { login, employeeLogin } = useAuth();
  const navigate = useNavigate();
  const [serverError, setServerError] = useState("");
  const [mode, setMode] = useState("business");
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm({ resolver: zodResolver(schema), defaultValues: { email: "", password: "" } });

  async function onSubmit(values) {
    setServerError("");
    try {
      if (mode === "employee") await employeeLogin(values);
      else await login(values);
      navigate("/dashboard");
    } catch (err) {
      const status = err.response?.status;
      if (status === 401) {
        setServerError(mode === "employee"
          ? "Email o contraseña de empleado incorrectos. Verificá con el dueño."
          : "Email o contraseña incorrectos. Reintentá — si la olvidaste, podés recuperarla abajo.");
      } else {
        setServerError(err.response?.data?.message || err.message || "Error al iniciar sesión");
      }
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-950 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-md bg-brass-500 text-ink-950">
            <Tag size={20} strokeWidth={2.5} />
          </div>
          <h1 className="mt-4 font-display text-xl font-semibold text-paper-50">Stocker</h1>
          <p className="mt-1 text-sm text-ink-400">Iniciá sesión en tu cuenta</p>
          
        </div>

        <div className="mb-3 flex rounded-md border border-white/10 bg-ink-900 p-1">
          {TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => { setMode(t.value); setServerError(""); }}
              className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                mode === t.value ? "bg-brass-500 text-ink-950" : "text-paper-100/70 hover:text-paper-50"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="card space-y-4 p-6">
          {serverError && (
            <div className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">
              <p className="flex items-start gap-1"><AlertCircle size={14} className="mt-0.5 shrink-0" /> <span>{serverError}</span></p>
            </div>
          )}
          <div>
            <label className="label">Email</label>
            <input
              className="input"
              type="email"
              placeholder={mode === "employee" ? "empleado@negocio.com" : "tu@negocio.com"}
              {...register("email")}
            />
            {errors.email && <p className="field-error">{errors.email.message}</p>}
          </div>
          <div>
            <label className="label">Contraseña</label>
            <input className="input" type="password" placeholder="••••••••" {...register("password")} />
            {errors.password && <p className="field-error">{errors.password.message}</p>}
          </div>
          <button className="btn-accent w-full" type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Ingresando…" : (mode === "employee" ? "Ingresar como empleado" : "Ingresar")}
          </button>
          {mode === "employee" && (
            <p className="text-center text-xs text-ink-500">
              Usá el email y contraseña que te asignó el dueño del negocio.
            </p>
          )}
          {mode === "business" && (
            <p className="text-center text-xs text-ink-500">
              <Link to="/olvide-password" className="text-brass-500 hover:underline">
                Olvidé mi contraseña
              </Link>
            </p>
          )}
        </form>

        {mode === "business" && (
          <p className="mt-5 text-center text-sm text-ink-400">
            ¿Todavía no registraste tu negocio?{" "}
            <Link to="/registro" className="font-medium text-brass-400 hover:underline">
              Creá tu cuenta
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
