import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { ShieldAlert, X } from "lucide-react";
import { useAuth } from "./AuthContext";
import { canView, canEdit, nivelDe, PERM_MODULES } from "../utils/permissions";
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

// Sale del catálogo central: escrito a mano quedaba viejo cada vez que se
// sumaba un módulo, y el modal terminaba mostrando la clave cruda ("pagos").
const MODULE_LABEL = Object.fromEntries(PERM_MODULES.map((m) => [m.key, m.label]));

const NIVEL_LABEL = { ninguno: "sin acceso", ver: "sólo ver", editar: "ver y editar" };

export function PermissionGuardProvider({ children }) {
  const { user } = useAuth();
  const [denied, setDenied] = useState(null); // { permission, level, currentLevel }

  // Registrar handler para 403 del backend
  useEffect(() => {
    registerForbiddenHandler(({ permission, level }) => {
      setDenied({ permission, level, currentLevel: nivelDe(user, permission) });
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
      setDenied({ permission, level, currentLevel: nivelDe(user, permission) });
    },
    [check, user]
  );

  /*
   * Dispara el aviso sin ejecutar ninguna acción. Lo usa PermissionRoute
   * cuando alguien entra a una sección que no le corresponde: antes redirigía
   * en silencio y la persona no entendía por qué había vuelto al inicio.
   */
  const denegar = useCallback((permission, level = "ver") => {
    setDenied({ permission, level, currentLevel: nivelDe(user, permission) });
  }, [user]);

  return (
    <PermissionGuardContext.Provider value={{ guard, check, denegar }}>
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
                  Para <strong>{MODULE_LABEL[denied.permission] || denied.permission}</strong> necesitás{" "}
                  <strong>{NIVEL_LABEL[denied.level] || denied.level}</strong>, y tu cargo tiene{" "}
                  <strong>{NIVEL_LABEL[denied.currentLevel] || denied.currentLevel}</strong>.
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

export function useDenegar() {
  const ctx = useContext(PermissionGuardContext);
  if (!ctx) throw new Error("useDenegar debe usarse dentro de <PermissionGuardProvider>");
  return ctx.denegar;
}

export function usePermissionCheck() {
  const ctx = useContext(PermissionGuardContext);
  if (!ctx) throw new Error("usePermissionCheck debe usarse dentro de <PermissionGuardProvider>");
  return ctx.check;
}
