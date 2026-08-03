import { Navigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";

export default function ProtectedRoute({ children }) {
  const { session } = useAuth();

  if (session === undefined) {
    return (
      <div className="flex h-screen items-center justify-center bg-paper-100 text-ink-600">
        Cargando…
      </div>
    );
  }
  if (!session) return <Navigate to="/login" replace />;
  return children;
}
