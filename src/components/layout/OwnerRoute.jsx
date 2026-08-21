import { ShieldAlert } from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { esAdministradorTotal } from "../../utils/permissions";

/*
 * Secciones del titular de la cuenta: datos del negocio y suscripción.
 *
 * No son un módulo de permisos —ningún cargo puede habilitarlas—, así que no
 * pasan por PermissionRoute. Sin esta puerta, un empleado que llegara por la
 * URL veía la pantalla armarse y romperse con el 403 del backend en crudo.
 */
export default function OwnerRoute({ children }) {
  const { user } = useAuth();
  if (!user) return null; // la sesión todavía se está resolviendo
  if (esAdministradorTotal(user)) return children;

  return (
    <div className="flex h-[70vh] items-center justify-center">
      <div className="max-w-sm text-center">
        <ShieldAlert size={40} className="mx-auto mb-3 text-ink-400" />
        <h2 className="font-display text-lg font-semibold text-ink-950">Sección del dueño</h2>
        <p className="mt-1 text-sm text-ink-600">
          Los datos de la cuenta y la suscripción los maneja el titular del negocio.
          No es algo que se pueda habilitar desde tu cargo.
        </p>
      </div>
    </div>
  );
}
