import { createContext, useContext, useEffect, useState } from "react";
import * as authService from "../services/authService";
import { useIdleLogout } from "../hooks/useIdleLogout";

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
  // Minutos de inactividad, los define el backend (/auth/me).
  const [inactividadMin, setInactividadMin] = useState(null);
  const [avisoInactividad, setAvisoInactividad] = useState(null);

  function aplicarSesion(me) {
    setSession(normalize(me));
    setInactividadMin(me?.sesion?.inactividadMin || null);
  }

  useEffect(() => {
    authService.getMe().then(aplicarSesion);
  }, []);

  // El backend ya rechaza la sesión vencida; esto además saca los datos de
  // pantalla, que en el mostrador de un local quedan a la vista de cualquiera.
  useIdleLogout({
    minutos: inactividadMin,
    activo: !!session,
    onAviso: (segundos) => setAvisoInactividad(segundos),
    onTimeout: async () => {
      setAvisoInactividad(null);
      await authService.logout();
      setSession(null);
      window.location.href = "/login?motivo=inactividad";
    },
  });

  // Cualquier interacción cancela el aviso: el hook ya reinició su cuenta.
  useEffect(() => {
    if (!avisoInactividad) return;
    const cancelar = () => setAvisoInactividad(null);
    const eventos = ["mousedown", "keydown", "touchstart"];
    eventos.forEach((e) => window.addEventListener(e, cancelar, { passive: true }));
    return () => eventos.forEach((e) => window.removeEventListener(e, cancelar));
  }, [avisoInactividad]);

  async function login(credentials) {
    const data = await authService.login(credentials);
    const me = await authService.getMe();
    aplicarSesion(me);
    return data;
  }

  async function employeeLogin(credentials) {
    const data = await authService.employeeLogin(credentials);
    const me = await authService.getMe();
    aplicarSesion(me);
    return data;
  }

  async function register(payload) {
    const data = await authService.register(payload);
    const me = await authService.getMe();
    aplicarSesion(me);
    return data;
  }

  async function logout() {
    // Esperamos al backend: es el único que puede borrar la cookie httpOnly.
    await authService.logout();
    setSession(null);
    setAvisoInactividad(null);
  }

  return (
    <AuthContext.Provider value={{
      session,                                // normalizada o null
      user: session,                          // alias para claridad en canView(user,...)
      business: session?.type === "business" ? session : null,
      employee: session?.type === "employee" ? session : null,
      login, employeeLogin, register, logout,
      avisoInactividad,               // segundos restantes, o null
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
