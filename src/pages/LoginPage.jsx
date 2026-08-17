import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { ShieldCheck, Loader2 } from "lucide-react";
import { useAdmin } from "../context/AdminAuth";
import { mensajeDe } from "../lib/http";
import { Aviso, Campo } from "../components/ui";

/*
 * Acceso al backoffice.
 *
 * Los tres datos se piden juntos —mail, contraseña y código— y no en dos
 * pasos. Un segundo paso que sólo aparece con la contraseña correcta le
 * confirma a quien está probando que acertó la mitad, y le dice exactamente
 * dónde seguir. Así, cualquier combinación inválida se ve igual.
 */
export default function LoginPage() {
  const { entrar } = useAdmin();
  const navegar = useNavigate();

  const [form, setForm] = useState({ email: "", password: "", codigo: "" });
  const [error, setError] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [faltaTotp, setFaltaTotp] = useState(false);

  const set = (campo) => (e) => setForm({ ...form, [campo]: e.target.value });

  async function enviar(e) {
    e.preventDefault();
    setEnviando(true); setError(""); setFaltaTotp(false);
    try {
      await entrar(form);
      navegar("/", { replace: true });
    } catch (err) {
      if (err.response?.data?.motivo === "totp_pendiente") {
        setFaltaTotp(true);
        setError("Esta cuenta todavía no tiene activado el segundo factor.");
      } else {
        setError(mensajeDe(err, "No pudimos validar los datos."));
      }
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-[4px] bg-brass font-mono text-lg font-bold text-deep">
            B
          </div>
          <div>
            <p className="font-mono text-sm font-bold tracking-[0.16em]">BACKOFFICE</p>
            <p className="text-xs text-faint">Administración de Stocker</p>
          </div>
        </div>

        <form onSubmit={enviar} className="card space-y-4 p-5">
          <Aviso tono="error">{error}</Aviso>

          {faltaTotp && (
            <p className="text-xs text-dim">
              Activalo con el token de alta desde{" "}
              <Link to="/activar" className="text-brass underline">esta página</Link>.
            </p>
          )}

          <Campo etiqueta="Email">
            <input
              className="input" type="email" autoComplete="username" autoFocus
              value={form.email} onChange={set("email")}
            />
          </Campo>

          <Campo etiqueta="Contraseña">
            <input
              className="input" type="password" autoComplete="current-password"
              value={form.password} onChange={set("password")}
            />
          </Campo>

          <Campo
            etiqueta="Código de 6 dígitos"
            ayuda="El que muestra Google Authenticator en este momento."
          >
            <input
              className="input font-mono text-lg tracking-[0.4em]"
              inputMode="numeric" autoComplete="one-time-code"
              maxLength={6} placeholder="······"
              value={form.codigo}
              onChange={(e) => setForm({ ...form, codigo: e.target.value.replace(/\D/g, "") })}
            />
          </Campo>

          <button className="btn-primary w-full" disabled={enviando}>
            {enviando ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
            Entrar
          </button>
        </form>

        <p className="mt-4 text-center text-[11px] text-faint">
          Este panel ve datos de todas las cuentas. No lo abras en equipos compartidos.
        </p>
      </div>
    </div>
  );
}
