import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { ShieldAlert, X } from "lucide-react";
import { useAuth } from "./AuthContext";
import { canView, canEdit } from "../utils/permissions";
import { registerForbiddenHandler } from "../lib/http";

/**
 * PermissionGuard — provee useGuard() para envolver acciones que requieren un
 * permiso. Si el usuario NO tiene el permiso, muestra un modal en vez de correr
 * la acción.
 *
 * Uso:
 *   const guard = useGuard();
 *   <button onClick={guard("stock", "editar", () => hacerAlgo())}>...</button>
 *
 * También expone `check(perm, level)` para chequear sin ejecutar (para
 * habilitar/deshabilitar botones).
 */

const PermissionGuardContext = createContext(null);

const MODULE_LABEL = {
  stock:        "Stock",
  ventas:       "Ventas",
  facturacion:  "Facturación",
  empleados:    "Empleados",
  dashboard:    "Dashboard",
  cotizaciones: "Cotizaciones",
};

export function PermissionGuardProvider({ children }) {
  const { user } = useAuth();
  const [denied, setDenied] = useState(null); // { permission, level, currentLevel }

  // Registrar handler para 403 del backend
  useEffect(() => {
    registerForbiddenHandler(({ permission, level }) => {
      const currentLevel = user?.permisos?.[permission] || "ninguno";
      setDenied({ permission, level, currentLevel });
    });
    return () => registerForbiddenHandler(null);
  }, [user]);

  const check = useCallback(
    (permission, level = "ver") => {
      if (!user) return false;
      return level === "editar" ? canEdit(user, permission) : canView(user, permission);
    },
    [user]
  );

  const guard = useCallback(
    (permission, level, action) => (...args) => {
      if (check(permission, level)) return action?.(...args);
      const currentLevel = user?.permisos?.[permission] || "ninguno";
      setDenied({ permission, level, currentLevel });
    },
    [check, user]
  );

  return (
    <PermissionGuardContext.Provider value={{ guard, check }}>
      {children}
      {denied && (
        <div className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-ink-950/60 p-4 py-10 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-lg border border-line bg-paper-50 shadow-xl">
            <div className="flex items-start gap-3 border-b border-line px-5 py-4">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brick-50 text-brick-500">
                <ShieldAlert size={20} />
              </div>
              <div className="flex-1">
                <h3 className="font-display text-base font-semibold text-ink-950">
                  No tenés permisos para esta acción
                </h3>
                <p className="mt-1 text-sm text-ink-600">
                  Necesitás <strong>{denied.level}</strong> en <strong>{MODULE_LABEL[denied.permission] || denied.permission}</strong>{" "}
                  y actualmente tenés <strong>{denied.currentLevel}</strong>.
                </p>
              </div>
              <button className="rounded-md p-1 text-ink-600 hover:bg-paper-200" onClick={() => setDenied(null)}>
                <X size={18} />
              </button>
            </div>
            <div className="px-5 py-4 text-sm text-ink-700">
              <p>Pedile al dueño del negocio que ajuste los permisos de tu cargo desde la sección <em>Empleados → Cargos</em>.</p>
            </div>
            <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
              <button className="btn-accent" onClick={() => setDenied(null)}>Entendido</button>
            </div>
          </div>
        </div>
      )}
    </PermissionGuardContext.Provider>
  );
}

export function useGuard() {
  const ctx = useContext(PermissionGuardContext);
  if (!ctx) throw new Error("useGuard debe usarse dentro de <PermissionGuardProvider>");
  return ctx.guard;
}

export function usePermissionCheck() {
  const ctx = useContext(PermissionGuardContext);
  if (!ctx) throw new Error("usePermissionCheck debe usarse dentro de <PermissionGuardProvider>");
  return ctx.check;
}
