import { useState } from "react";
import { Link } from "react-router-dom";
import { KeyRound, Loader2, ArrowLeft } from "lucide-react";
import * as api from "../lib/api";
import { mensajeDe } from "../lib/http";
import { Aviso, Campo } from "../components/ui";

/*
 * Activación del segundo factor, una sola vez por cuenta.
 *
 * Se autoriza con el token que imprime scripts/crear-superuser.js y no con la
 * sesión, porque antes de activarlo no hay sesión posible: el login exige el
 * código, y el código no vale hasta que el secreto esté activado.
 *
 * Pide el código además del token a propósito. Si el secreto quedó mal cargado
 * en el teléfono, activar sin comprobarlo dejaría la cuenta sin forma de
 * entrar y habría que volver a correr el script.
 */
export default function ActivarTotpPage() {
  const [form, setForm] = useState({ email: "", token: "", codigo: "" });
  const [error, setError] = useState("");
  const [listo, setListo] = useState("");
  const [enviando, setEnviando] = useState(false);

  const set = (campo) => (e) => setForm({ ...form, [campo]: e.target.value });

  async function enviar(e) {
    e.preventDefault();
    setEnviando(true); setError(""); setListo("");
    try {
      const r = await api.activarTotp(form);
      setListo(r.message);
    } catch (err) {
      setError(mensajeDe(err, "No se pudo activar."));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <Link to="/login" className="mb-6 inline-flex items-center gap-1.5 text-sm text-dim hover:text-text">
          <ArrowLeft size={14} /> Volver
        </Link>

        <form onSubmit={enviar} className="card space-y-4 p-5">
          <div>
            <h1 className="text-lg font-semibold">Activar segundo factor</h1>
            <p className="mt-1 text-xs text-dim">
              Escaneá primero el QR que imprimió el script de alta con Google Authenticator.
            </p>
          </div>

          <Aviso tono="error">{error}</Aviso>
          <Aviso tono="ok">{listo}</Aviso>

          <Campo etiqueta="Email de la cuenta">
            <input className="input" type="email" value={form.email} onChange={set("email")} />
          </Campo>

          <Campo etiqueta="Token de alta" ayuda="Es el BACKOFFICE_SETUP_TOKEN del entorno.">
            <input className="input font-mono text-xs" value={form.token} onChange={set("token")} />
          </Campo>

          <Campo etiqueta="Código de la app">
            <input
              className="input font-mono text-lg tracking-[0.4em]"
              inputMode="numeric" maxLength={6} placeholder="······"
              value={form.codigo}
              onChange={(e) => setForm({ ...form, codigo: e.target.value.replace(/\D/g, "") })}
            />
          </Campo>

          {listo ? (
            <Link to="/login" className="btn-primary w-full">Ir a entrar</Link>
          ) : (
            <button className="btn-primary w-full" disabled={enviando}>
              {enviando ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />}
              Activar
            </button>
          )}

          <p className="text-[11px] text-faint">
            Después de activarlo, borrá <span className="font-mono">BACKOFFICE_SETUP_TOKEN</span> del
            entorno: mientras exista es una llave para reactivar el segundo factor.
          </p>
        </form>
      </div>
    </div>
  );
}
