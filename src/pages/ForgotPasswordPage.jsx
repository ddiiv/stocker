import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Tag, Mail, KeyRound, CheckCircle2, AlertCircle } from "lucide-react";
import { forgotPassword, verifyResetCode, resetPassword } from "../services/authService";
import PasswordStrength from "../components/ui/PasswordStrength";
import { evaluatePassword } from "../utils/passwordPolicy";

// Pasos: request → code → new-password → done
export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState("request");

  // request
  const [email, setEmail] = useState("");
  const [cuit, setCuit]   = useState("");
  const [reqLoading, setReqLoading] = useState(false);
  const [reqError, setReqError] = useState("");

  // code
  const [code, setCode] = useState("");
  const [codeLoading, setCodeLoading] = useState(false);
  const [codeError, setCodeError] = useState("");
  const [attemptsLeft, setAttemptsLeft] = useState(null);
  const [locked, setLocked] = useState(false);

  // new password
  const [newPass, setNewPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pwdLoading, setPwdLoading] = useState(false);
  const [pwdError, setPwdError] = useState("");

  async function handleRequest(e) {
    e.preventDefault();
    setReqError("");
    if (!email || !cuit) return setReqError("Ingresá el email y el CUIT del dueño.");
    setReqLoading(true);
    try {
      await forgotPassword({ email, cuit });
      setStep("code");
    } catch (err) {
      setReqError(err.response?.data?.message || "No se pudo procesar la solicitud.");
    } finally { setReqLoading(false); }
  }

  async function handleCode(e) {
    e.preventDefault();
    setCodeError("");
    if (!code || code.length < 4) return setCodeError("Ingresá el código de 6 dígitos.");
    setCodeLoading(true);
    try {
      await verifyResetCode({ email, code });
      setStep("new-password");
    } catch (err) {
      const data = err.response?.data;
      setCodeError(data?.message || "Código incorrecto.");
      if (typeof data?.attemptsLeft === "number") {
        setAttemptsLeft(data.attemptsLeft);
        if (data.attemptsLeft <= 0) setLocked(true);
      }
    } finally { setCodeLoading(false); }
  }

  async function handleReset(e) {
    e.preventDefault();
    setPwdError("");
    if (newPass !== confirm) return setPwdError("Las contraseñas no coinciden.");
    if (!evaluatePassword(newPass).valid) return setPwdError("La contraseña no cumple los requisitos.");
    setPwdLoading(true);
    try {
      await resetPassword({ email, code, newPassword: newPass });
      setStep("done");
    } catch (err) {
      setPwdError(err.response?.data?.message || "No se pudo actualizar la contraseña.");
      if (/código/i.test(err.response?.data?.message || "")) setStep("code");
    } finally { setPwdLoading(false); }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-950 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-md bg-brass-500 text-ink-950">
            <Tag size={20} strokeWidth={2.5} />
          </div>
          <h1 className="mt-4 font-display text-xl font-semibold text-paper-50">Recuperar contraseña</h1>
          <p className="mt-1 text-sm text-ink-400">
            {step === "request"      && "Ingresá tu email y CUIT del dueño"}
            {step === "code"         && "Ingresá el código que te enviamos"}
            {step === "new-password" && "Elegí una nueva contraseña"}
            {step === "done"         && "¡Listo! Ya podés iniciar sesión"}
          </p>
        </div>

        {step === "request" && (
          <form onSubmit={handleRequest} className="card space-y-4 p-6">
            {reqError && <ErrorBox msg={reqError} />}
            <div>
              <label className="label">Email de la cuenta</label>
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tu@negocio.com" />
            </div>
            <div>
              <label className="label">CUIT del dueño</label>
              <input className="input font-mono" value={cuit} onChange={(e) => setCuit(e.target.value)} placeholder="20-12345678-6" />
            </div>
            <button className="btn-accent w-full" disabled={reqLoading}>
              <Mail size={15} /> {reqLoading ? "Enviando…" : "Enviar código por email"}
            </button>
            <p className="text-center text-xs text-ink-500">
              Sólo el dueño de la cuenta puede recuperar la contraseña. Los empleados deben pedírsela a él.
            </p>
          </form>
        )}

        {step === "code" && (
          <form onSubmit={handleCode} className="card space-y-4 p-6">
            {codeError && (
              <div className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">
                <p className="flex items-center gap-1"><AlertCircle size={14} /> {codeError}</p>
                {attemptsLeft !== null && !locked && (
                  <p className="mt-1 text-xs">Te quedan {attemptsLeft} intento{attemptsLeft === 1 ? "" : "s"}.</p>
                )}
                {locked && (
                  <p className="mt-1 text-xs">Superaste los intentos. Le enviamos un aviso al dueño y necesitás pedir un nuevo código.</p>
                )}
              </div>
            )}
            <p className="text-sm text-ink-700">Revisá tu casilla <strong>{email}</strong> — te llegó un código de 6 dígitos.</p>
            <div>
              <label className="label">Código</label>
              <input
                className="input font-mono text-center text-2xl tracking-[0.5em]"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="••••••"
                maxLength={6}
                autoFocus
                disabled={locked}
              />
            </div>
            {!locked ? (
              <button className="btn-accent w-full" disabled={codeLoading}>
                <KeyRound size={15} /> {codeLoading ? "Verificando…" : "Verificar código"}
              </button>
            ) : (
              <button type="button" className="btn-accent w-full" onClick={() => { setStep("request"); setCode(""); setLocked(false); setAttemptsLeft(null); setCodeError(""); }}>
                Pedir un nuevo código
              </button>
            )}
            <p className="text-center text-xs text-ink-500">
              ¿No te llegó? Revisá spam.{" "}
              <button type="button" className="text-brass-500 hover:underline" onClick={() => { setStep("request"); }}>
                Reintentar
              </button>
            </p>
          </form>
        )}

        {step === "new-password" && (
          <form onSubmit={handleReset} className="card space-y-4 p-6">
            {pwdError && <ErrorBox msg={pwdError} />}
            <div>
              <label className="label">Nueva contraseña</label>
              <input className="input" type="password" value={newPass} onChange={(e) => setNewPass(e.target.value)} autoFocus />
              <PasswordStrength password={newPass} />
            </div>
            <div>
              <label className="label">Repetir nueva contraseña</label>
              <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              {confirm && newPass !== confirm && <p className="field-error">Las contraseñas no coinciden.</p>}
            </div>
            <button className="btn-accent w-full" disabled={pwdLoading || !evaluatePassword(newPass).valid || newPass !== confirm}>
              {pwdLoading ? "Guardando…" : "Cambiar contraseña"}
            </button>
          </form>
        )}

        {step === "done" && (
          <div className="card space-y-4 p-6 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-teal-50 text-teal-500">
              <CheckCircle2 size={30} />
            </div>
            <p className="text-sm text-ink-700">Actualizamos tu contraseña. Ya podés iniciar sesión con la nueva.</p>
            <button className="btn-accent w-full" onClick={() => navigate("/login")}>Ir al login</button>
          </div>
        )}

        <p className="mt-5 text-center text-sm text-ink-400">
          <Link to="/login" className="font-medium text-brass-400 hover:underline">Volver al login</Link>
        </p>
      </div>
    </div>
  );
}

function ErrorBox({ msg }) {
  return (
    <div className="rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">
      <p className="flex items-center gap-1"><AlertCircle size={14} /> {msg}</p>
    </div>
  );
}
