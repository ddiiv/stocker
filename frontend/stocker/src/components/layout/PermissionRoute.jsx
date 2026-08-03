import { Navigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { canView, canEdit } from "../../utils/permissions";
import { ShieldAlert } from "lucide-react";

// Redirige al primer módulo permitido si no tiene acceso al pedido.
// Útil para que un empleado con sólo "ventas" no aterrice en un /dashboard vacío.
function firstAllowedPath(user) {
  if (!user) return "/login";
  const order = [
    ["dashboard",   "/dashboard"],
    ["ventas",      "/ventas"],
    ["stock",       "/stock"],
    ["facturacion", "/facturacion"],
    ["empleados",   "/empleados"],
  ];
  for (const [perm, path] of order) if (canView(user, perm)) return path;
  return null; // sin permisos → mostrar 403
}

export default function PermissionRoute({ permission, level = "ver", children }) {
  const { user } = useAuth();
  const ok = level === "editar" ? canEdit(user, permission) : canView(user, permission);
  if (ok) return children;

  const fallback = firstAllowedPath(user);
  if (fallback && fallback !== window.location.pathname) return <Navigate to={fallback} replace />;

  return (
    <div className="flex h-[70vh] items-center justify-center">
      <div className="max-w-sm text-center">
        <ShieldAlert size={40} className="mx-auto mb-3 text-ink-400" />
        <h2 className="font-display text-lg font-semibold text-ink-950">Sin acceso</h2>
        <p className="mt-1 text-sm text-ink-600">
          Tu cargo no tiene permiso para ver este módulo. Pedile al dueño del negocio que ajuste tus permisos.
        </p>
      </div>
    </div>
  );
}
