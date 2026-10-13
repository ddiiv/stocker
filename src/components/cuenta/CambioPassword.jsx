import { useState } from "react";
import { KeyRound } from "lucide-react";
import { solicitarCambioPassword, confirmarCambioPassword } from "../../services/accountService";
import { Card } from "../ui/Layout";
import PasswordStrength from "../ui/PasswordStrength";

/*
 * Cambio de contraseña del dueño, en dos pasos: la actual y un código al mail.
 *
 * MOVIDO tal cual desde la pantalla de Mi cuenta a la pestaña Seguridad. El
 * flujo no se tocó: es el mismo estado, los mismos pasos y los mismos textos.
 * Lo único nuevo es `onAviso`, por donde sale el mensaje del servidor que
 * antes se escribía directo en el aviso de la página.
 */
export default function CambioPassword({ cuenta, onAviso }) {
  // Cambio de contraseña: paso 1 valida la actual, paso 2 código + nueva.
  const [passActual, setPassActual] = useState("");
  const [passNueva, setPassNueva] = useState("");
  const [pasoPass, setPasoPass] = useState(1);
  const [codigoPass, setCodigoPass] = useState("");
  const [errorPass, setErrorPass] = useState("");
  const [enviandoPass, setEnviandoPass] = useState(false);

  async function pedirCodigoPass(e) {
    e.preventDefault();
    setEnviandoPass(true); setErrorPass("");
    try {
      const r = await solicitarCambioPassword(passActual);
      onAviso(r.message);
      setPasoPass(2);
    } catch (err) {
      setErrorPass(err.response?.data?.message || "No se pudo enviar el código");
    } finally { setEnviandoPass(false); }
  }

  async function confirmarPass(e) {
    e.preventDefault();
    setEnviandoPass(true); setErrorPass("");
    try {
      const r = await confirmarCambioPassword({ code: codigoPass.trim(), passwordNueva: passNueva });
      onAviso(r.message);
      setPasoPass(1); setPassActual(""); setPassNueva(""); setCodigoPass("");
    } catch (err) {
      setErrorPass(err.response?.data?.message || "No se pudo cambiar la contraseña");
    } finally { setEnviandoPass(false); }
  }

  return (
    <Card>
      <p className="mb-1 flex items-center gap-2 font-display text-base font-semibold text-ink-950">
        <KeyRound size={17} /> Contraseña
      </p>
      <p className="mb-2 text-sm text-ink-600">
        Por seguridad no se muestra. Para cambiarla pedimos la actual y un código al mail.
      </p>
      {/*
        Se avisa ANTES de tocar nada, no después.
        Cerrar las sesiones es el sentido de cambiar la contraseña cuando
        sospechás que alguien entró, pero si el aviso llegara recién con
        el resultado, quien la cambia por rutina descubre que dejó a la
        cajera afuera en el peor momento sin haber podido preverlo.
      */}
      <p className="mb-3 rounded-md bg-paper-200 px-3 py-2 text-sm text-ink-700">
        Al cambiarla se cierran las sesiones abiertas en otros dispositivos.
        En éste vas a seguir adentro.
      </p>

      {errorPass && <p className="mb-2 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{errorPass}</p>}

      {pasoPass === 1 ? (
        <form onSubmit={pedirCodigoPass} className="space-y-3">
          <div>
            <label className="label" htmlFor="pass-actual">Contraseña actual</label>
            <input id="pass-actual" className="input" type="password" value={passActual}
              onChange={(e) => setPassActual(e.target.value)} autoComplete="current-password" />
          </div>
          <button className="btn-ghost border border-line" disabled={enviandoPass || !passActual}>
            {enviandoPass ? "Enviando…" : "Enviar código"}
          </button>
        </form>
      ) : (
        <form onSubmit={confirmarPass} className="space-y-3">
          <div>
            <label className="label" htmlFor="pass-codigo">Código recibido en {cuenta?.email}</label>
            <input id="pass-codigo" className="input font-mono tracking-widest" value={codigoPass} maxLength={6}
              onChange={(e) => setCodigoPass(e.target.value)} placeholder="000000" />
          </div>
          <div>
            <label className="label" htmlFor="pass-nueva">Contraseña nueva</label>
            <input id="pass-nueva" className="input" type="password" value={passNueva}
              onChange={(e) => setPassNueva(e.target.value)} autoComplete="new-password" />
            <PasswordStrength value={passNueva} />
          </div>
          <div className="flex gap-2">
            <button className="btn-accent" disabled={enviandoPass}>
              {enviandoPass ? "Guardando…" : "Cambiar contraseña"}
            </button>
            <button type="button" className="btn-ghost" onClick={() => { setPasoPass(1); setCodigoPass(""); setPassNueva(""); setErrorPass(""); }}>
              Cancelar
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}
