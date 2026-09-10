import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "../lib/zod";
import { Tag, AlertCircle, Clock } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { enviarCodigo2FA } from "../services/authService";

const schema = z.object({
  email: z.string().email("Ingresá un email válido"),
  password: z.string().min(1, "Ingresá tu contraseña"),
  // Opcional en el esquema: sólo hace falta si la cuenta tiene el segundo
  // paso activado, y eso no se sabe hasta que el servidor lo dice.
  code: z.string().optional(),
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
  // El cierre automático redirige con ?motivo=inactividad.
  const [searchParams] = useSearchParams();
  const motivoCierre = searchParams.get("motivo");
  const cerroPorInactividad = motivoCierre === "inactividad";
  /*
   * Por qué te sacamos, dicho en la pantalla a la que caés.
   *
   * Al que le cerraron la sesión desde otro lado —cambio de contraseña de la
   * cuenta, o su usuario desactivado— lo escupe acá en la mitad de lo que
   * estuviera haciendo. Sin una línea que lo explique parece que el sistema se
   * rompió, y lo primero que hace es reintentar la contraseña vieja.
   */
  const AVISOS_DE_CIERRE = {
    SESION_CERRADA: "Se cambió la contraseña, así que se cerraron las sesiones abiertas. Entrá con la nueva.",
    SESION_REVOCADA: "Tu usuario ya no tiene acceso. Pedile al dueño de la cuenta que lo revise.",
  };
  const avisoDeCierre = AVISOS_DE_CIERRE[motivoCierre] || null;
  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({ resolver: zodResolver(schema), defaultValues: { email: "", password: "", code: "" } });

  /*
   * El segundo paso aparece recién cuando el servidor lo pide.
   *
   * No se puede saber antes si la cuenta lo tiene activado: preguntarlo por
   * email sería decirle a cualquiera qué cuentas tienen 2FA y cuáles no, que
   * es justo la lista por la que empezaría alguien que está probando.
   */
  const [pide2fa, setPide2fa] = useState(false);
  const [canales2fa, setCanales2fa] = useState([]);
  const [avisoCodigo, setAvisoCodigo] = useState("");
  const [pidiendoCodigo, setPidiendoCodigo] = useState(false);

  /*
   * Pedir el código por mail o WhatsApp desde la pantalla de entrar.
   *
   * Necesita la contraseña —el servidor la vuelve a comprobar— así que se lee
   * del formulario en el momento. Guardarla en un estado aparte sería tener la
   * contraseña en dos lugares para no leerla dos veces.
   */
  async function pedirCodigoPor(canal) {
    setPidiendoCodigo(true); setServerError(""); setAvisoCodigo("");
    try {
      const r = await enviarCodigo2FA({
        email: getValues("email"), password: getValues("password"), canal,
      });
      setAvisoCodigo(r.message || "Te mandamos el código.");
    } catch (err) {
      setServerError(err.response?.data?.message || "No se pudo mandar el código");
    } finally { setPidiendoCodigo(false); }
  }

  async function onSubmit(values) {
    setServerError("");
    try {
      if (mode === "employee") await employeeLogin(values);
      else await login(values);
      navigate("/dashboard");
    } catch (err) {
      const status = err.response?.status;

      // La contraseña estaba bien; falta el código de la app.
      if (status === 401 && err.response?.data?.codigo === "TOTP_REQUERIDO") {
        setPide2fa(true);
        setCanales2fa(err.response?.data?.canales || []);
        setServerError(pide2fa ? (err.response?.data?.message || "El código no es correcto.") : "");
        return;
      }

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
    <div className="flex min-h-screen items-center justify-center bg-paper-100 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brass-500 text-[#1c1c1c]">
            <Tag size={20} strokeWidth={2.5} />
          </div>
          <h1 className="mt-4 font-display text-xl font-semibold text-ink-950">Stocker</h1>
          <p className="mt-1 text-sm text-ink-400">Iniciá sesión en tu cuenta</p>
          
        </div>

        <div className="mb-3 flex rounded-lg border border-line bg-paper-200 p-1">
          {TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => { setMode(t.value); setServerError(""); setPide2fa(false); }}
              className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                mode === t.value ? "bg-brass-500 text-[#1c1c1c]" : "text-ink-600 hover:text-ink-900"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="card space-y-4 p-6">
          {/* Sin esto, volver al login tras el cierre automático parece un error. */}
          {cerroPorInactividad && !serverError && (
            <div className="rounded-md bg-paper-200 px-3 py-2 text-sm text-ink-700">
              <p className="flex items-start gap-1">
                <Clock size={14} className="mt-0.5 shrink-0" />
                <span>Cerramos tu sesión por inactividad. Ingresá de nuevo para seguir.</span>
              </p>
            </div>
          )}
          {avisoDeCierre && !serverError && (
            <div className="rounded-md bg-paper-200 px-3 py-2 text-sm text-ink-700">
              <p className="flex items-start gap-1">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <span>{avisoDeCierre}</span>
              </p>
            </div>
          )}
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
          {pide2fa && mode === "business" && (
            <div>
              <label className="label">
                {canales2fa.includes("app") ? "Código de tu app de autenticación" : "Código de verificación"}
              </label>
              <input
                className="input font-mono tracking-widest"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                autoFocus
                {...register("code")}
              />
              {avisoCodigo && (
                <p className="mt-1 rounded-md bg-paper-200 px-2 py-1.5 text-xs text-ink-700">{avisoCodigo}</p>
              )}
              {/*
                Los botones salen de lo que el servidor dijo que la cuenta
                tiene prendido. Mostrarlos siempre ofrecería mandar un código
                por un canal que la cuenta no configuró.
              */}
              {(canales2fa.includes("email") || canales2fa.includes("whatsapp")) && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {canales2fa.includes("email") && (
                    <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={pidiendoCodigo}
                      onClick={() => pedirCodigoPor("email")}>
                      Mandámelo al mail
                    </button>
                  )}
                  {canales2fa.includes("whatsapp") && (
                    <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={pidiendoCodigo}
                      onClick={() => pedirCodigoPor("whatsapp")}>
                      Mandámelo por WhatsApp
                    </button>
                  )}
                </div>
              )}
              <p className="mt-1 text-xs text-ink-500">
                Si perdiste el teléfono, escribí uno de tus códigos de recuperación.
              </p>
            </div>
          )}
          <button className="btn-accent w-full" type="submit" disabled={isSubmitting}>
            {isSubmitting
              ? "Ingresando…"
              : pide2fa && mode === "business"
                ? "Verificar y entrar"
                : (mode === "employee" ? "Ingresar como empleado" : "Ingresar")}
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
