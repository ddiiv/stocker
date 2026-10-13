import { useState } from "react";
import { LogOut } from "lucide-react";
import { cerrarTodasLasSesiones } from "../../services/accountService";
import { Card } from "../ui/Layout";

/*
 * ── Cerrar todas las sesiones ──────────────────────────────
 * Distinto de cambiar la contraseña, que sólo cierra las sesiones que
 * ESA contraseña abrió. Acá el caso es el teléfono perdido con la
 * sesión abierta, la computadora que quedó prendida en el local, el
 * que se fue sabiendo una clave: no hace falta que todo el equipo se
 * invente contraseñas nuevas, con que vuelvan a entrar alcanza.
 *
 * MOVIDO desde Mi cuenta a la pestaña Sesiones, al pie de la lista: es el
 * botón que se busca después de ver una sesión que no se reconoce. El flujo
 * del dueño es el mismo. Lo nuevo es el empleado: la misma ruta le cierra
 * sólo SUS otras sesiones (no puede sacar a sus compañeros ni al dueño), así
 * que el texto se lo dice con esas palabras. `onListo` le avisa a la lista
 * que tiene que volver a leerse.
 */
export default function CerrarSesiones({ esDuenio, onListo }) {
  // Cerrar todas las sesiones: se confirma pidiendo la contraseña actual.
  const [abriendoCierre, setAbriendoCierre] = useState(false);
  const [passCierre, setPassCierre] = useState("");
  const [errorCierre, setErrorCierre] = useState("");
  const [avisoCierre, setAvisoCierre] = useState("");
  const [cerrando, setCerrando] = useState(false);

  async function cerrarSesiones(e) {
    e.preventDefault();
    setCerrando(true); setErrorCierre(""); setAvisoCierre("");
    try {
      const r = await cerrarTodasLasSesiones(passCierre);
      if (esDuenio) {
        const n = r?.empleadosAfectados ?? 0;
        setAvisoCierre(
          n > 0
            ? `Listo. Se cerraron las sesiones del negocio, incluidas las de ${n} ${n === 1 ? "empleado" : "empleados"}. En este dispositivo seguís adentro.`
            : "Listo. Se cerraron las sesiones abiertas. En este dispositivo seguís adentro.",
        );
      } else {
        setAvisoCierre(r?.message || "Listo. Se cerraron tus otras sesiones. En este dispositivo seguís adentro.");
      }
      setPassCierre("");
      setAbriendoCierre(false);
      onListo?.();
    } catch (err) {
      setErrorCierre(err.response?.data?.message || "No se pudieron cerrar las sesiones");
    } finally {
      setCerrando(false);
    }
  }

  return (
    <Card>
      <p className="mb-1 flex items-center gap-2 font-display text-base font-semibold text-ink-950">
        <LogOut size={17} /> {esDuenio ? "Cerrar todas las sesiones" : "Cerrar mis otras sesiones"}
      </p>
      <p className="mb-3 text-sm text-ink-600">
        {esDuenio
          ? <>Saca a todos de todas las computadoras y teléfonos —vos y tus empleados—
            sin cambiarle la contraseña a nadie. Cada uno vuelve a entrar con la que
            ya tenía. En este dispositivo vas a seguir adentro.</>
          : <>Cierra tu usuario en todas las computadoras y teléfonos menos en éste.
            Tu contraseña no cambia: para volver a entrar en otro lado, usás la misma.</>}
      </p>

      {avisoCierre && (
        <p className="mb-3 rounded-md bg-teal-50 px-3 py-2 text-sm text-teal-600">{avisoCierre}</p>
      )}
      {errorCierre && (
        <p className="mb-2 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{errorCierre}</p>
      )}

      {!abriendoCierre ? (
        <button type="button" className="btn-ghost border border-line"
          onClick={() => { setAbriendoCierre(true); setAvisoCierre(""); setErrorCierre(""); }}>
          Cerrar sesiones
        </button>
      ) : (
        <form onSubmit={cerrarSesiones} className="space-y-3">
          {/*
            Se avisa lo que duele ANTES de pedir la contraseña: si hay
            gente vendiendo, esto los deja con la venta a medio cargar.
          */}
          {esDuenio && (
            <p className="rounded-md bg-paper-200 px-3 py-2 text-sm text-ink-700">
              Si hay alguien vendiendo en este momento, va a tener que volver a entrar.
            </p>
          )}
          <div>
            <label className="label" htmlFor="pass-cierre">Confirmá con tu contraseña actual</label>
            <input id="pass-cierre" className="input" type="password" value={passCierre} aria-required="true"
              onChange={(e) => setPassCierre(e.target.value)} autoComplete="current-password" />
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn-accent" disabled={cerrando || !passCierre}>
              {cerrando ? "Cerrando…" : esDuenio ? "Cerrar todas las sesiones" : "Cerrar mis otras sesiones"}
            </button>
            <button type="button" className="btn-ghost"
              onClick={() => { setAbriendoCierre(false); setPassCierre(""); setErrorCierre(""); }}>
              Cancelar
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}
