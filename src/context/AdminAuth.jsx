import { createContext, useContext, useEffect, useState, useCallback } from "react";
import * as api from "../lib/api";

/*
 * Sesión del operador.
 *
 * Al montar se sonda `/backoffice/me`. Sin sesión responde 401 y el
 * interceptor de http.js deja pasar ese caso puntual sin redirigir, para que
 * la sonda no se convierta en un bucle de recargas.
 *
 * El admin se relee del servidor en cada arranque en vez de guardarse en
 * localStorage: si le bajan el rol o le desactivan la cuenta, tiene que
 * enterarse en el momento y no cuando venza el token.
 */

const Ctx = createContext(null);

export function AdminAuthProvider({ children }) {
  const [admin, setAdmin] = useState(null);
  const [cargando, setCargando] = useState(true);

  const refrescar = useCallback(async () => {
    try {
      const { admin } = await api.yo();
      setAdmin(admin);
      return admin;
    } catch {
      setAdmin(null);
      return null;
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => { refrescar(); }, [refrescar]);

  const entrar = useCallback(async (credenciales) => {
    const { admin } = await api.login(credenciales);
    setAdmin(admin);
    return admin;
  }, []);

  const salir = useCallback(async () => {
    await api.logout().catch(() => {});
    setAdmin(null);
    window.location.href = "/login";
  }, []);

  return (
    <Ctx.Provider value={{ admin, cargando, entrar, salir, refrescar }}>
      {children}
    </Ctx.Provider>
  );
}

export const useAdmin = () => useContext(Ctx);

/** Jerarquía de roles: soporte lee, owner cobra y cotiza, superuser todo. */
const NIVEL = { soporte: 1, owner: 2, superuser: 3 };
export const puede = (admin, minimo) => (NIVEL[admin?.rol] || 0) >= NIVEL[minimo];
