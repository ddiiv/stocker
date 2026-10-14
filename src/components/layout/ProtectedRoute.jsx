import { Navigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";

export default function ProtectedRoute({ children }) {
  const { session, motivoCierre } = useAuth();

  if (session === undefined) {
    return (
      <div className="flex h-screen items-center justify-center bg-paper-100 text-ink-600">
        Cargando…
      </div>
    );
  }
  // Con el motivo si la sonda de sesión lo trajo (ver AuthContext): quien
  // recarga después de que le cerraron la sesión tiene que leer por qué.
  if (!session) return <Navigate to={`/login${motivoCierre || ""}`} replace />;
  return children;
}
