import { createContext, useContext, useEffect, useState } from "react";
import * as authService from "../services/authService";
import { useIdleLogout } from "../hooks/useIdleLogout";
import { limpiarPorCierreDeSesion } from "../utils/carritoPos";

const AuthContext = createContext(null);

// Normaliza la sesión que devuelve /auth/me → { type, ...datos, permisos, negocio }
//
// `permisos` sólo aplica a empleados: el dueño tiene acceso total por serlo, no
// por una lista de permisos (ver esAdministradorTotal en utils/permissions).
function normalize(me) {
  if (!me) return null;
  const data = me.data || {};
  return {
    type: me.type,
    ...data,
    permisos: me.type === "business" ? null : (data.cargo?.permisos || {}),
    // Datos del negocio para toda la app: el empleado también los necesita
    // (el encabezado mostraba "Mi negocio" porque sólo los tenía el dueño).
    negocio: me.negocio || null,
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
      // El carrito a medio armar es lo primero que queda a la vista de
      // cualquiera en el mostrador de un local.
      limpiarPorCierreDeSesion();
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
    /*
     * El carrito del POS se borra SIEMPRE al salir.
     *
     * En un local la misma terminal la usan varias personas, y el que entra
     * después no tiene por qué encontrarse el carrito a medio armar del
     * anterior. carritoPos igual comprueba de quién es al leerlo, pero eso
     * evita mostrarlo, no que el dato quede escrito en la máquina.
     */
    limpiarPorCierreDeSesion();
    setSession(null);
    setAvisoInactividad(null);
  }

  return (
    <AuthContext.Provider value={{
      session,                                // normalizada o null
      user: session,                          // alias para claridad en canView(user,...)
      business: session?.type === "business" ? session : null,
      employee: session?.type === "employee" ? session : null,
      // Nombre y CUIT del negocio, sin importar con qué rol se entró.
      negocio: session?.negocio || null,
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
