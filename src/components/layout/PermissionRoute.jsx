import { useEffect } from "react";
import { Navigate } from "react-router-dom";
import { ShieldAlert } from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { useDenegar } from "../../context/PermissionGuardContext";
import { canView, canEdit, PERM_MODULES } from "../../utils/permissions";

/*
 * Puerta de entrada a cada sección.
 *
 * Cuando falta el permiso siempre se avisa con el modal. Antes se redirigía en
 * silencio al primer módulo disponible: la persona hacía clic, aparecía en otra
 * pantalla y no tenía forma de saber por qué — parecía que la aplicación
 * fallaba, no que le faltaba un permiso.
 */

// A dónde mandar a alguien que no puede estar acá. Se elige la primera sección
// que sí puede ver, para no dejarlo en una pantalla vacía.
function primeraPermitida(user) {
  for (const m of PERM_MODULES) {
    if (!canView(user, m.key)) continue;
    const destino = {
      dashboard: "/dashboard", stock: "/stock", ventas: "/ventas",
      cotizaciones: "/ventas", clientes: "/clientes", facturacion: "/facturacion",
      pagos: "/pagos", caja: "/caja", empleados: "/empleados",
      integraciones: "/integraciones/mercadolibre",
    }[m.key];
    if (destino) return destino;
  }
  return null;
}

export default function PermissionRoute({ permission, level = "ver", children }) {
  const { user } = useAuth();
  const denegar = useDenegar();

  const ok = level === "editar" ? canEdit(user, permission) : canView(user, permission);

  // El aviso se dispara en un efecto: llamarlo durante el render actualizaría
  // el estado del provider mientras React está renderizando.
  useEffect(() => {
    if (!ok && user) denegar(permission, level);
  }, [ok, user, permission, level, denegar]);

  if (ok) return children;
  if (!user) return null; // la sesión todavía se está resolviendo

  const destino = primeraPermitida(user);
  // Con el modal ya visible, se redirige a una sección que sí puede usar.
  if (destino && destino !== window.location.pathname) {
    return <Navigate to={destino} replace />;
  }

  // Sin ninguna sección disponible no hay a dónde mandarlo.
  return (
    <div className="flex h-[70vh] items-center justify-center">
      <div className="max-w-sm text-center">
        <ShieldAlert size={40} className="mx-auto mb-3 text-ink-400" />
        <h2 className="font-display text-lg font-semibold text-ink-950">Sin acceso</h2>
        <p className="mt-1 text-sm text-ink-600">
          Tu cargo no tiene permiso para ninguna sección. Pedile al dueño del negocio
          que ajuste tus permisos.
        </p>
      </div>
    </div>
  );
}
