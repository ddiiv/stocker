import { createContext, useContext, useEffect, useState } from "react";
import * as authService from "../services/authService";

const AuthContext = createContext(null);

// Normaliza la sesión que devuelve /auth/me → { type, ...datos, permisos }
// Para business, permisos siempre implícito (todo editar); para employee viene del cargo.
function normalize(me) {
  if (!me) return null;
  const data = me.data || {};
  return {
    type: me.type,
    ...data,
    permisos: me.type === "business"
      ? { stock:"editar", ventas:"editar", facturacion:"editar", empleados:"editar", dashboard:"editar", cotizaciones:"editar" }
      : (data.cargo?.permisos || {}),
  };
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined);

  useEffect(() => {
    authService.getMe().then((me) => setSession(normalize(me)));
  }, []);

  async function login(credentials) {
    const data = await authService.login(credentials);
    const me = await authService.getMe();
    setSession(normalize(me));
    return data;
  }

  async function employeeLogin(credentials) {
    const data = await authService.employeeLogin(credentials);
    const me = await authService.getMe();
    setSession(normalize(me));
    return data;
  }

  async function register(payload) {
    const data = await authService.register(payload);
    const me = await authService.getMe();
    setSession(normalize(me));
    return data;
  }

  function logout() {
    authService.logout();
    setSession(null);
  }

  return (
    <AuthContext.Provider value={{
      session,                                // normalizada o null
      user: session,                          // alias para claridad en canView(user,...)
      business: session?.type === "business" ? session : null,
      employee: session?.type === "employee" ? session : null,
      login, employeeLogin, register, logout,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth debe usarse dentro de <AuthProvider>");
  return ctx;
}
