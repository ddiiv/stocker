import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { fetchAccount } from "../services/accountService";
import { PageHeader } from "../components/ui/Layout";
import CuentaTabs from "../components/cuenta/CuentaTabs";
import CambioPassword from "../components/cuenta/CambioPassword";
import DobleFactor from "../components/cuenta/DobleFactor";

/*
 * Seguridad de la cuenta: la contraseña y la verificación en dos pasos.
 *
 * Las dos tarjetas son las que estaban en Mi cuenta, movidas sin cambiar su
 * lógica (ver components/cuenta). Esta página sólo trae la cuenta —el estado
 * del doble factor sale de GET /api/account— y la vuelve a leer cuando el
 * doble factor cambia.
 *
 * "Cerrar todas las sesiones" no está acá sino en Sesiones: es lo que se
 * busca después de ver en la lista una sesión que no se reconoce.
 */
export default function SeguridadPage() {
  const [cuenta, setCuenta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");

  /*
   * Recargar NO vuelve a poner el esqueleto de carga, a propósito.
   *
   * El doble factor llama a esto justo después de activarse, con los códigos
   * de recuperación en pantalla. Esos códigos viven en el estado de su
   * tarjeta y se muestran UNA sola vez: si la recarga la desmontara para
   * dibujar el esqueleto, se perderían antes de que nadie los copie. En Mi
   * cuenta no pasaba porque el estado era de la página; al moverlo a su
   * componente, el que no se tiene que desmontar es él.
   */
  async function load() {
    try {
      setCuenta(await fetchAccount());
      setError("");
    } catch (e) {
      setError(e.response?.data?.message || "No se pudo cargar la cuenta");
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  return (
    <div>
      <PageHeader title="Seguridad" subtitle="Contraseña y verificación en dos pasos" />
      <CuentaTabs />

      {loading ? (
        <div className="card h-64 animate-pulse bg-paper-200/60" />
      ) : (
        <>
          {error && <p className="mb-4 rounded-md bg-brick-50 px-3 py-2 text-sm text-brick-500">{error}</p>}
          {aviso && (
            <p className="mb-4 flex items-start gap-2 rounded-md bg-teal-50 px-3 py-2 text-sm text-teal-700">
              <Check size={15} className="mt-0.5 shrink-0" /> {aviso}
            </p>
          )}

          {/* Sin la cuenta no se puede saber si el doble factor está activo:
              mostrar "Activar" a quien ya lo tiene sería invitarlo a pisarlo. */}
          {cuenta && (
            <div className="grid items-start gap-5 lg:grid-cols-2">
              <DobleFactor cuenta={cuenta} recargar={load} />
              <CambioPassword cuenta={cuenta} onAviso={setAviso} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
